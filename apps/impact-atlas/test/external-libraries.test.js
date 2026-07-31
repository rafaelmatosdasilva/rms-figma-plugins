import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  loadPlugin, makeVar, makeCollection, makePage, makeComponent, makeInstance,
} from '@rms/test-utils';

const ENTRY = fileURLToPath(new URL('../src/code.js', import.meta.url));

const paint = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }];

/**
 * A file that USES an external library without having it added: instances of a
 * library component sit on the canvas and bind that library's tokens, but no local
 * variable aliases them and teamLibrary reports nothing.
 *
 * This is the case that used to hide external tokens entirely — discovery was gated
 * on the library API, which reports nothing for a library that isn't formally added.
 */
function usesUnlinkedLibrary() {
  const libVar = makeVar('lib-v1', 'library/button/background', { remote: true, collectionId: 'lib-coll' });
  const libMaster = makeComponent('libraryButton', {
    id: 'lib-comp',
    key: 'lib-key',
    remote: true,
    fills: paint,
    boundVariables: { fills: [{ id: 'lib-v1' }] },
  });
  const instance = makeInstance(libMaster, { id: 'inst-1' });

  return {
    variables: [makeVar('v-local', 'local/spacing', { resolvedType: 'FLOAT' })],
    collections: [makeCollection('coll-1', 'Local')],
    // Resolvable by id (as Figma does for referenced remote vars) but not local,
    // and deliberately NOT reported by teamLibrary — no `libraryCollections` key.
    remoteVars: [libVar],
    remoteColls: [makeCollection('lib-coll', 'Library', { remote: true })],
    pages: [makePage('Page 1', [instance])],
  };
}

describe('impact-atlas — external libraries', () => {
  it('discovers library tokens even when no library is linked to the file', async () => {
    const { send, lastOf } = await loadPlugin(ENTRY, usesUnlinkedLibrary());

    await send({ type: 'init' });
    await send({ type: 'usage-scan', depth: 3 });

    const ready = lastOf('usage-scan-ready');
    expect(ready).toBeDefined();

    // The library token reached the UI despite teamLibrary reporting nothing.
    const names = (ready.remoteVars || []).map((v) => v.name);
    expect(names).toContain('library/button/background');
  });

  it('lists the library component and marks it as remote', async () => {
    const { send, lastOf } = await loadPlugin(ENTRY, usesUnlinkedLibrary());

    await send({ type: 'init' });
    await send({ type: 'usage-scan', depth: 3 });

    const ready = lastOf('usage-scan-ready');
    const lib = (ready.newLibraryComponents || []).find((c) => c.nodeName === 'libraryButton');
    expect(lib).toBeDefined();
    expect(lib.isRemote).toBe(true);
    // A library master lives in another file — no page to focus on.
    expect(lib.pageId).toBeNull();
    // Its bound token resolves rather than being silently dropped.
    expect(lib.boundVars.map((b) => b.name)).toContain('library/button/background');
  });

  it('keeps a local master local even when it only binds remote tokens', async () => {
    // Regression: remoteness was inferred from "absent from the local index", so a
    // local master skipped by the local pass (it binds no local vars) was mislabelled
    // as a library component.
    const libVar = makeVar('lib-v1', 'library/color', { remote: true, collectionId: 'lib-coll' });
    const localMaster = makeComponent('localOnlyRemoteTokens', {
      id: 'local-comp',
      key: 'local-key',
      remote: false,
      fills: paint,
      boundVariables: { fills: [{ id: 'lib-v1' }] },
    });
    const instance = makeInstance(localMaster, { id: 'inst-1' });

    const { send, lastOf } = await loadPlugin(ENTRY, {
      variables: [],
      collections: [makeCollection('coll-1', 'Local')],
      remoteVars: [libVar],
      remoteColls: [makeCollection('lib-coll', 'Library', { remote: true })],
      pages: [makePage('Page 1', [localMaster, instance])],
    });

    await send({ type: 'init' });
    await send({ type: 'usage-scan', depth: 3 });

    const ready = lastOf('usage-scan-ready');
    const asLibrary = (ready.newLibraryComponents || [])
      .find((c) => c.nodeName === 'localOnlyRemoteTokens');
    expect(asLibrary).toBeUndefined();
  });

  it('does not surface a deleted local component as an external-library one', async () => {
    // A component deleted from the file while its instances remain: the orphaned
    // instances still resolve it via getMainComponentAsync(), but it sits on no page.
    // The scan then gave it pageId=null, and the browser renders any null-pageId row as
    // a "From an external library" badge — so a deleted LOCAL component was shown as
    // external. It must not appear as a library-badged component at all.
    const token = makeVar('v1', 'button/background', { collectionId: 'coll-1' });
    const deletedMaster = makeComponent('deletedLocalMaster', {
      id: 'comp-del',
      key: 'del-key',
      remote: false,            // local — it was deleted, it is not from a library
      fills: paint,
      boundVariables: { fills: [{ id: 'v1' }] },
    });
    // Only the orphaned instance is on the page; the master lives nowhere.
    const orphanInstance = makeInstance(deletedMaster, { id: 'inst-1' });

    const { figma, send } = await loadPlugin(ENTRY, {
      variables: [token],
      collections: [makeCollection('coll-1', 'Tokens')],
      pages: [makePage('Page 1', [orphanInstance])],
    });

    await send({ type: 'init' });
    await send({ type: 'usage-scan', depth: 3 });

    // browserComponents is the affected-components list the browser renders; a null
    // pageId there becomes the library badge. The deleted master must not be in it.
    const cached = await figma.clientStorage.getAsync(`scan-${figma.fileKey || 'local'}`);
    const rows = (cached && cached.browserComponents) || [];
    const ghost = rows.find((c) => c.nodeName === 'deletedLocalMaster');
    expect(ghost).toBeUndefined();
  });
});
