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

    // The cached hex keeps the colour swatch alive with no raw RGB to resolve.
    expect(comp.boundVars.find((b) => b.id === 'lib-v1').hex).toBe('#3B82F6');
  });
});
