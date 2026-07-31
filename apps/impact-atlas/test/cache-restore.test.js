import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadPlugin, makeVar, makeCollection, makePage } from '@rms/test-utils';

const ENTRY = fileURLToPath(new URL('../src/code.js', import.meta.url));

/**
 * Reopening the plugin restores the last scan from clientStorage instead of
 * re-scanning. Two regressions lived here:
 *   1. the cache kept only local components, so token→library-component links
 *      vanished on reopen until you scanned again;
 *   2. remote variables weren't seeded back into the backend, so the bound tokens
 *      of external components were filtered out and rendered empty.
 */
function cachedScanScene() {
  const cached = {
    version: 2,
    // Init only trusts a cache whose signature matches the open file, so one
    // file can never be served another's cache (figma.fileKey is unavailable to
    // dev plugins, so the storage key alone can't distinguish files). This is the
    // signature fileSigFrom() derives from this scene — pages:vars:colls:hash of
    // the variable + collection names. If that derivation changes, this literal
    // must change with it and this test will say so.
    _fileSig: '1:1:1:17b44zw',
    ts: Date.now(),
    depth: 3,
    instanceCounts: { 'lib-v1': 4 },
    directCounts: {},
    updatedComponentCounts: { 'lib-v1': 1 },
    updatedImpactScores: { 'lib-v1': 120 },
    remoteVars: [{
      id: 'lib-v1',
      libraryKey: 'lib-key-1',
      name: 'library/button/background',
      resolvedType: 'COLOR',
      variableCollectionId: 'lib-coll',
      hex: '#3B82F6',
      dependentCount: 1,
      isRemote: true,
    }],
    remoteColls: [{ id: 'lib-coll', key: 'lck', name: 'Library', modes: [{ modeId: 'm', name: 'Mode' }], isRemote: true }],
    browserComponents: [{
      nodeId: 'lib-comp',
      nodeName: 'libraryButton',
      nodeType: 'COMPONENT',
      pageName: 'Library',
      pageId: null,
      isRemote: true,
      boundCount: 1,
      boundVars: [{ id: 'lib-v1', name: 'library/button/background', resolvedType: 'COLOR' }],
    }],
  };

  return {
    variables: [makeVar('v-local', 'local/spacing', { resolvedType: 'FLOAT' })],
    collections: [makeCollection('coll-1', 'Local')],
    pages: [makePage('Page 1')],
    // The library variable still exists, so init can verify the cached entry by id
    // and refresh its name. Tests below cover the renamed and deleted cases.
    remoteVars: [makeVar('lib-v1', 'library/button/background', { resolvedType: 'COLOR', remote: true })],
    remoteColls: [makeCollection('lib-coll', 'Library')],
    // figma.fileKey is blocked for dev plugins, so the cache key falls back to 'local'.
    clientStorage: { 'scan-local': cached, 'scan-depth': 3 },
  };
}

describe('impact-atlas — cache restore on reopen', () => {
  it('restores the cached scan without re-scanning', async () => {
    const { send, lastOf } = await loadPlugin(ENTRY, cachedScanScene());

    await send({ type: 'init' });

    const data = lastOf('init-data');
    expect(data.cachedScan).toBeDefined();
    expect(data.lastScanDepth).toBe(3);
    expect(data.hasExternalLibraries).toBe(true);
  });

  it('brings back library components discovered by that scan', async () => {
    const { send, lastOf } = await loadPlugin(ENTRY, cachedScanScene());

    await send({ type: 'init' });

    const lib = lastOf('init-data').browserComponents
      .find((c) => c.nodeName === 'libraryButton');
    expect(lib).toBeDefined();
    expect(lib.isRemote).toBe(true);
  });

  it('resolves the bound tokens of an external component after reopen', async () => {
    // The heart of the bug: components came back but their tokens were dropped,
    // because the remote variables were never seeded back into the backend.
    const { send, lastOf } = await loadPlugin(ENTRY, cachedScanScene());

    await send({ type: 'init' });
    await send({ type: 'analyze-remote', variableId: 'lib-v1' });

    const chain = lastOf('chain-result');
    expect(chain).toBeDefined();

    const comp = chain.components.find((c) => c.nodeName === 'libraryButton');
    expect(comp).toBeDefined();
    expect(comp.boundVars.map((b) => b.name)).toContain('library/button/background');

    // The swatch resolves from the LIVE library variable, not the cached hex, so
    // recolouring a token in the library shows up on reopen too. (It falls back to
    // the cached hex only when the variable can't be read.)
    expect(comp.boundVars.find((b) => b.id === 'lib-v1').hex).toBe('#3366CC');
  });

  it('refuses a cache written against a different file', async () => {
    // figma.fileKey is unavailable to dev plugins and root.name/id don't identify the
    // file, so every file shares one storage key. Without the signature check, opening
    // file B listed file A's components. A mismatch must re-scan, not serve.
    const scene = cachedScanScene();
    scene.clientStorage['scan-local'] = Object.assign(
      {}, scene.clientStorage['scan-local'], { _fileSig: 'someone-elses-file' },
    );
    const { send, lastOf } = await loadPlugin(ENTRY, scene);

    await send({ type: 'init' });

    expect(lastOf('init-data').cachedScan).toBeFalsy();
  });

  it('ignores a cache from an older plugin version', async () => {
    // The version gates indexing-rule changes; a stale payload must not be replayed.
    const scene = cachedScanScene();
    scene.clientStorage['scan-local'] = Object.assign(
      {}, scene.clientStorage['scan-local'], { version: 1 },
    );
    const { send, lastOf } = await loadPlugin(ENTRY, scene);

    await send({ type: 'init' });

    expect(lastOf('init-data').cachedScan).toBeFalsy();
  });

  it('ignores the cache when the user asks for a rescan', async () => {
    // A library lives in another file, so renaming a variable there leaves this
    // file's signature untouched and the cache still looks valid. An explicit
    // rescan must therefore re-read rather than replay, or the old name persists.
    const { send, lastOf } = await loadPlugin(ENTRY, cachedScanScene());

    await send({ type: 'init', force: true });

    expect(lastOf('init-data').cachedScan).toBeFalsy();
  });

  it('shows a renamed library variable under its new name, once', async () => {
    // The reported bug: renaming in the library left this file's signature
    // untouched, so the cache was served and the token appeared twice — old name
    // and new. Init verifies each cached entry by id and takes the live name.
    const scene = cachedScanScene();
    scene.remoteVars = [makeVar('lib-v1', 'library/button/bg-renamed', { resolvedType: 'COLOR', remote: true })];
    const { send, lastOf } = await loadPlugin(ENTRY, scene);

    await send({ type: 'init' });

    const names = (lastOf('init-data').remoteVars || []).map((v) => v.name);
    expect(names).toContain('library/button/bg-renamed');
    expect(names).not.toContain('library/button/background');
    expect(names.filter((n) => n.startsWith('library/button/')).length).toBe(1);
  });

  it('collapses one library variable that appears under two ids', async () => {
    // Observed in a real file: subscribed to an older publish of the library, the id
    // bound on canvas resolved to the OLD name while the library reported the new
    // one — the same variable listed twice (then three times). Only the KEY is
    // stable across a rename, so entries must collapse on it.
    const scene = cachedScanScene();
    const stale = makeVar('lib-v1', 'Font-fmaily', { resolvedType: 'STRING', remote: true });
    const live  = makeVar('lib-v1-new', 'Font-family', { resolvedType: 'STRING', remote: true });
    stale.key = 'samekey123';   // one variable, two per-file ids
    live.key  = 'samekey123';
    scene.remoteVars = [stale, live];
    // Both ids must reach the merge, which is what happens in a real file: the id
    // bound on canvas was cached, and accepting the library update minted a new one.
    scene.clientStorage['scan-local'].remoteVars = [
      { id: 'lib-v1',     libraryKey: 'samekey123', name: 'Font-fmaily', resolvedType: 'STRING', isRemote: true, aliasCount: 3 },
      { id: 'lib-v1-new', libraryKey: 'samekey123', name: 'Font-family', resolvedType: 'STRING', isRemote: true, aliasCount: 0 },
    ];
    const { send, lastOf } = await loadPlugin(ENTRY, scene);

    await send({ type: 'init' });

    const fonts = (lastOf('init-data').remoteVars || []).filter((v) => /^Font-f/.test(v.name));
    expect(fonts.length).toBe(1);
  });

  it('drops a library variable that no longer exists', async () => {
    // Deleted or unpublished in the library: the id stops resolving, so the cached
    // entry must not be served back.
    const scene = cachedScanScene();
    scene.remoteVars = [];
    const { send, lastOf } = await loadPlugin(ENTRY, scene);

    await send({ type: 'init' });

    const names = (lastOf('init-data').remoteVars || []).map((v) => v.name);
    expect(names).not.toContain('library/button/background');
  });
});
