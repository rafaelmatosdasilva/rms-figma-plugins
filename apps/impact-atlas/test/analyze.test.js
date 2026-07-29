import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  loadPlugin, makeVar, makeCollection, makePage, makeComponent,
} from '@rms/test-utils';

const ENTRY = fileURLToPath(new URL('../src/code.js', import.meta.url));
const paint = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }];

/**
 * A three-link alias chain, which gives one token of each kind:
 *   primitive  (no ancestors, has descendants)   → multiplier 0.5
 *   bridge     (has both)                        → multiplier 1.5
 *   terminal   (has ancestors, no descendants)   → multiplier 1.0
 * plus an orphan token nothing references.
 *
 * Chain direction: semantic → bridge → primitive.
 */
function chainScene() {
  const primitive = makeVar('v-primitive', 'primitives/Neutral 300');
  const bridge = makeVar('v-bridge', 'semantic/surface', { aliasOf: 'v-primitive' });
  const terminal = makeVar('v-terminal', 'button/background', { aliasOf: 'v-bridge' });
  const orphan = makeVar('v-orphan', 'unused/token');

  const button = makeComponent('buttonPrimary', {
    id: 'comp-button',
    fills: paint,
    boundVariables: { fills: [{ id: 'v-terminal' }] },
  });

  return {
    variables: [primitive, bridge, terminal, orphan],
    collections: [makeCollection('coll-1', 'Tokens')],
    pages: [makePage('Page 1', [button])],
  };
}

describe('impact-atlas — analyze', () => {
  it('returns the alias chain around the selected token', async () => {
    const { send, lastOf } = await loadPlugin(ENTRY, chainScene());
    await send({ type: 'init' });
    await send({ type: 'analyze', variableId: 'v-bridge' });

    const { chain } = lastOf('chain-result');
    expect(chain.self.name).toBe('semantic/surface');
    // Upward: what this token points at. Downward: what points at it.
    expect(chain.ancestors.map((a) => a.name)).toContain('primitives/Neutral 300');
    expect(chain.descendants.map((d) => d.name)).toContain('button/background');
  });

  it('classifies primitive, bridge and terminal tokens', async () => {
    const { send, lastOf } = await loadPlugin(ENTRY, chainScene());
    await send({ type: 'init' });

    await send({ type: 'analyze', variableId: 'v-primitive' });
    expect(lastOf('chain-result').impact.tokenType).toBe('primitive');

    await send({ type: 'analyze', variableId: 'v-bridge' });
    expect(lastOf('chain-result').impact.tokenType).toBe('bridge');

    await send({ type: 'analyze', variableId: 'v-terminal' });
    expect(lastOf('chain-result').impact.tokenType).toBe('terminal');
  });

  it('scores impact from what depends on the token, never from its own depth', async () => {
    // The regression this pins: a token that references a primitive but is
    // referenced by nothing must score 0 ("Unused"), not a depth-derived score.
    const { send, lastOf } = await loadPlugin(ENTRY, {
      variables: [
        makeVar('v-primitive', 'primitives/Neutral 300'),
        makeVar('v-lonely', 'lonely/token', { aliasOf: 'v-primitive' }),
      ],
      collections: [makeCollection('coll-1', 'Tokens')],
      pages: [makePage('Page 1')],
    });
    await send({ type: 'init' });
    await send({ type: 'analyze', variableId: 'v-lonely' });

    const { impact } = lastOf('chain-result');
    expect(impact.varDeps).toBe(0);
    expect(impact.compUsage).toBe(0);
    expect(impact.depth).toBeGreaterThan(0); // it does sit on a chain…
    expect(impact.score).toBe(0);            // …but nothing depends on it
  });

  it('scores a token bound by components above zero', async () => {
    const { send, lastOf } = await loadPlugin(ENTRY, chainScene());
    await send({ type: 'init' });
    await send({ type: 'analyze', variableId: 'v-terminal' });

    const { impact, components } = lastOf('chain-result');
    expect(impact.compUsage).toBe(1);
    expect(impact.score).toBeGreaterThan(0);
    expect(components.map((c) => c.nodeName)).toContain('buttonPrimary');
  });

  it('counts alias descendants toward the score of a primitive', async () => {
    const { send, lastOf } = await loadPlugin(ENTRY, chainScene());
    await send({ type: 'init' });
    await send({ type: 'analyze', variableId: 'v-primitive' });

    const { impact } = lastOf('chain-result');
    // Both the bridge and the terminal hang off the primitive.
    expect(impact.varDeps).toBeGreaterThanOrEqual(2);
    expect(impact.score).toBeGreaterThan(0);
  });

  it('reports a token nothing references at all as zero impact', async () => {
    const { send, lastOf } = await loadPlugin(ENTRY, chainScene());
    await send({ type: 'init' });
    await send({ type: 'analyze', variableId: 'v-orphan' });

    const { chain, impact } = lastOf('chain-result');
    expect(chain.ancestors).toHaveLength(0);
    expect(chain.descendants).toHaveLength(0);
    expect(impact.score).toBe(0);
  });

  it('surfaces the same components through the token that aliases them', async () => {
    // Selecting the primitive must still reveal the component bound to the far end
    // of the chain — impact travels down the aliases.
    const { send, lastOf } = await loadPlugin(ENTRY, chainScene());
    await send({ type: 'init' });
    await send({ type: 'analyze', variableId: 'v-primitive' });

    const { components } = lastOf('chain-result');
    expect(components.map((c) => c.nodeName)).toContain('buttonPrimary');
  });
});
