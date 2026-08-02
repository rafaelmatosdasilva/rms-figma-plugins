import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadPlugin, makeVar, makeCollection, makePage } from '@rms/test-utils';

const ENTRY = fileURLToPath(new URL('../src/code.js', import.meta.url));

// A local token that aliases a library (external) variable.
function scene() {
  return {
    variables: [makeVar('v-local', 'semantic/accent', { aliasOf: 'ext-1', collectionId: 'coll-1' })],
    remoteVars: [makeVar('ext-1', 'library/blue', { remote: true, collectionId: 'lib-coll' })],
    collections: [makeCollection('coll-1', 'Local')],
    remoteColls: [makeCollection('lib-coll', 'Library')],
    pages: [makePage('Page 1')],
  };
}

const ancestorNames = (chainResult) => (chainResult.chain.ancestors || []).map((a) => a.name);

describe('impact-atlas — external variable fetch', () => {
  it('recovers an external ancestor after a transient fetch failure', async () => {
    const { figma, send, lastOf } = await loadPlugin(ENTRY, scene());
    await send({ type: 'init' });

    // Make the library variable briefly unreachable.
    let failExt = true;
    const realGet = figma.variables.getVariableByIdAsync.bind(figma.variables);
    figma.variables.getVariableByIdAsync = async (id) => {
      if (id === 'ext-1' && failExt) throw new Error('transient library error');
      return realGet(id);
    };

    await send({ type: 'analyze', variableId: 'v-local' });
    // The transient throw means the external ancestor can't be named yet.
    expect(ancestorNames(lastOf('chain-result'))).not.toContain('library/blue');

    // The library recovers. A fresh analyze must pick it up, because a THROW is not
    // cached as "does not exist" (only a genuine null is).
    failExt = false;
    await send({ type: 'analyze', variableId: 'v-local' });
    expect(ancestorNames(lastOf('chain-result'))).toContain('library/blue');
  });

  it('does keep remembering a variable that genuinely no longer exists', async () => {
    // A real null (deleted/unpublished) is still cached, so the chain doesn't re-fetch
    // it forever. Here ext-1 always resolves to null.
    const { figma, send, lastOf } = await loadPlugin(ENTRY, scene());
    await send({ type: 'init' });

    let calls = 0;
    const realGet = figma.variables.getVariableByIdAsync.bind(figma.variables);
    figma.variables.getVariableByIdAsync = async (id) => {
      if (id === 'ext-1') { calls++; return null; }
      return realGet(id);
    };

    await send({ type: 'analyze', variableId: 'v-local' });
    const firstCalls = calls;
    await send({ type: 'analyze', variableId: 'v-local' });

    // The null was cached, so the second analyze does not hit the API again for ext-1.
    expect(calls).toBe(firstCalls);
    expect(ancestorNames(lastOf('chain-result'))).not.toContain('library/blue');
  });
});
