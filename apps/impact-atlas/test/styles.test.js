import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadPlugin, makeVar, makeCollection, makePage } from '@rms/test-utils';

const ENTRY = fileURLToPath(new URL('../src/code.js', import.meta.url));

/**
 * Styles are the other consumer of a token, alongside components: changing the
 * token changes every style bound to it, so analysis has to surface them.
 */
function styleScene({ textStyles = [], paintStyles = [], effectStyles = [] } = {}) {
  return {
    variables: [makeVar('v1', 'brand/primary'), makeVar('v2', 'unused/token')],
    collections: [makeCollection('coll-1', 'Tokens')],
    pages: [makePage('Page 1')],
    textStyles, paintStyles, effectStyles,
  };
}

describe('impact-atlas — styles that use a token', () => {
  it('lists a text style bound to the token', async () => {
    const { send, lastOf } = await loadPlugin(ENTRY, styleScene({
      textStyles: [{ id: 'S:text', name: 'Heading/H1', boundVariables: { fontSize: { id: 'v1' } } }],
    }));
    await send({ type: 'init' });
    await send({ type: 'analyze', variableId: 'v1' });

    expect(lastOf('chain-result').styles).toEqual([
      { id: 'S:text', name: 'Heading/H1', type: 'TEXT' },
    ]);
  });

  it('lists a paint style whose colour comes from the token', async () => {
    const { send, lastOf } = await loadPlugin(ENTRY, styleScene({
      paintStyles: [{
        id: 'S:paint', name: 'Brand/Primary',
        paints: [{ type: 'SOLID', boundVariables: { color: { id: 'v1' } } }],
      }],
    }));
    await send({ type: 'init' });
    await send({ type: 'analyze', variableId: 'v1' });

    expect(lastOf('chain-result').styles).toEqual([
      { id: 'S:paint', name: 'Brand/Primary', type: 'PAINT' },
    ]);
  });

  it('lists an effect style bound to the token', async () => {
    const { send, lastOf } = await loadPlugin(ENTRY, styleScene({
      effectStyles: [{
        id: 'S:effect', name: 'Shadow/Card',
        effects: [{ type: 'DROP_SHADOW', boundVariables: { color: { id: 'v1' } } }],
      }],
    }));
    await send({ type: 'init' });
    await send({ type: 'analyze', variableId: 'v1' });

    expect(lastOf('chain-result').styles).toEqual([
      { id: 'S:effect', name: 'Shadow/Card', type: 'EFFECT' },
    ]);
  });

  it('leaves out styles bound to a different token', async () => {
    const { send, lastOf } = await loadPlugin(ENTRY, styleScene({
      textStyles: [{ id: 'S:text', name: 'Heading/H1', boundVariables: { fontSize: { id: 'v1' } } }],
    }));
    await send({ type: 'init' });
    await send({ type: 'analyze', variableId: 'v2' });

    expect(lastOf('chain-result').styles).toEqual([]);
  });

  it('reports every style that uses the token, across kinds', async () => {
    const { send, lastOf } = await loadPlugin(ENTRY, styleScene({
      textStyles: [{ id: 'S:t', name: 'Body', boundVariables: { fontSize: { id: 'v1' } } }],
      paintStyles: [{ id: 'S:p', name: 'Brand', paints: [{ type: 'SOLID', boundVariables: { color: { id: 'v1' } } }] }],
      effectStyles: [{ id: 'S:e', name: 'Shadow', effects: [{ boundVariables: { color: { id: 'v1' } } }] }],
    }));
    await send({ type: 'init' });
    await send({ type: 'analyze', variableId: 'v1' });

    expect(lastOf('chain-result').styles.map((s) => s.type).sort()).toEqual(['EFFECT', 'PAINT', 'TEXT']);
  });
});
