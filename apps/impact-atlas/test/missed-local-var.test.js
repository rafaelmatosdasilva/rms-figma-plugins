import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  loadPlugin, makeVar, makeCollection, makePage, makeComponent, makeInstance, makeNode,
} from '@rms/test-utils';

const ENTRY = fileURLToPath(new URL('../src/code.js', import.meta.url));

/**
 * `figma.variables.getLocalVariablesAsync()` sometimes omits a variable that is
 * genuinely local — a known Figma quirk. `getVariableByIdAsync` still returns it,
 * with the authoritative `remote: false`.
 *
 * Reproduces the report: a local token like `advanced/buttonPrimary/border/top`,
 * missed by the local enumeration but aliased by another local var, must NOT be
 * shown as an external-library token. Library identity is `remote`/`key`, never
 * "absent from the local set".
 */
function missedLocalScene() {
  // The missed-but-local primitive. In the mock, `remoteVars` are resolvable by id
  // yet never returned by getLocalVariablesAsync — with remote:false that is exactly
  // "a local var the enumeration dropped".
  const missed = makeVar('v-missed', 'advanced/buttonPrimary/border/top', {
    resolvedType: 'FLOAT', value: 4, remote: false, collectionId: 'coll-1',
  });
  // A local var that IS enumerated and aliases the missed one.
  const aliaser = makeVar('v-aliaser', 'component/buttonPrimary/border/top', {
    resolvedType: 'FLOAT', aliasOf: 'v-missed', collectionId: 'coll-1',
  });

  // One component so an Extended scan has something to walk.
  const comp = makeComponent('buttonPrimary', {
    id: 'comp-1',
    boundVariables: { topBorderWeight: [{ id: 'v-aliaser' }] },
  });
  const page = makePage('Page 1');
  page.appendChild(comp);
  page.appendChild(makeInstance(comp, { id: 'inst-1' }));

  return {
    variables: [aliaser],
    remoteVars: [missed],
    collections: [makeCollection('coll-1', 'Advanced')],
    libraryCollections: [],
    pages: [page],
  };
}

const named = (list, name) => (list || []).filter((v) => v.name === name);

describe('impact-atlas — a local var the enumeration missed', () => {
  it('does not present it as an external-library token after a scan', async () => {
    const { send, lastOf } = await loadPlugin(ENTRY, missedLocalScene());
    await send({ type: 'init' });
    await send({ type: 'usage-scan', depth: 2 });

    const ready = lastOf('usage-scan-ready');
    // The bug: it was fetched as an alias target and pushed onto remoteVars.
    expect(named(ready.remoteVars, 'advanced/buttonPrimary/border/top')).toEqual([]);
  });

  it('lists it as a local token instead', async () => {
    const { send, lastOf } = await loadPlugin(ENTRY, missedLocalScene());
    await send({ type: 'init' });
    await send({ type: 'usage-scan', depth: 2 });

    const ready = lastOf('usage-scan-ready');
    expect(named(ready.variables, 'advanced/buttonPrimary/border/top')).toHaveLength(1);
  });

  it('clears the false external-alias mark on the token that aliases it', async () => {
    const { send, lastOf } = await loadPlugin(ENTRY, missedLocalScene());
    await send({ type: 'init' });
    await send({ type: 'usage-scan', depth: 2 });

    const ready = lastOf('usage-scan-ready');
    const [aliaser] = named(ready.variables, 'component/buttonPrimary/border/top');
    expect(aliaser).toBeTruthy();
    // Its only alias target turned out to be local, so it has no external alias.
    expect(aliaser.hasExternalAlias).toBe(false);
  });

  it('still flags a genuinely remote token as external', async () => {
    // Guard against over-correcting: a real library token (remote:true, not in the
    // local set) must keep its external badge. Only remote:false vars are recovered.
    const libToken = makeVar('lib-blue', 'library/blue', {
      resolvedType: 'COLOR', remote: true, collectionId: 'lib-coll',
    });
    const aliaser = makeVar('v-accent', 'semantic/accent', {
      resolvedType: 'COLOR', aliasOf: 'lib-blue', collectionId: 'coll-1',
    });
    const { send, lastOf } = await loadPlugin(ENTRY, {
      variables: [aliaser],
      remoteVars: [libToken],
      collections: [makeCollection('coll-1', 'Local')],
      remoteColls: [makeCollection('lib-coll', 'Library')],
      libraryCollections: [],
      pages: [makePage('Page 1')],
    });
    await send({ type: 'init' });
    await send({ type: 'usage-scan', depth: 2 });

    const ready = lastOf('usage-scan-ready');
    expect(named(ready.remoteVars, 'library/blue')).toHaveLength(1);
    expect(named(ready.variables, 'library/blue')).toEqual([]);
  });
});
