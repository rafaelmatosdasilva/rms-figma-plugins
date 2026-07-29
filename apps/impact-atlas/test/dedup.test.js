import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  loadPlugin, makeVar, makeCollection, makePage, makeComponent, makeInstance,
} from '@rms/test-utils';

const ENTRY = fileURLToPath(new URL('../src/code.js', import.meta.url));
const paint = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }];

/**
 * A design-system SOURCE file that also consumes its own published library: the local
 * master and a remote twin of the same published component (same `key`) both exist,
 * and instances point at the remote twin.
 *
 * Regression: this surfaced as two "buttonPrimary" entries, one wrongly flagged as a
 * library component with no page (so no canvas focus).
 */
function selfConsumingLibrary() {
  const token = makeVar('v1', 'button/background/color');

  const localMaster = makeComponent('buttonPrimary', {
    id: 'local-master',
    key: 'published-button',
    remote: false,
    fills: paint,
    boundVariables: { fills: [{ id: 'v1' }] },
  });

  const remoteTwin = makeComponent('buttonPrimary', {
    id: 'remote-twin',
    key: 'published-button', // same published key — it IS the same component
    remote: true,
    fills: paint,
    boundVariables: { fills: [{ id: 'v1' }] },
  });

  const instance = makeInstance(remoteTwin, { id: 'inst-1' });

  return {
    variables: [token],
    collections: [makeCollection('coll-1', 'Tokens')],
    pages: [makePage('Page 1', [localMaster, instance])],
  };
}

describe('impact-atlas — local/remote component dedup', () => {
  it('collapses a remote twin onto its local master (one entry, not two)', async () => {
    const { send, lastOf } = await loadPlugin(ENTRY, selfConsumingLibrary());

    await send({ type: 'init' });
    await send({ type: 'usage-scan', depth: 3 });

    const ready = lastOf('usage-scan-ready');
    expect(ready).toBeDefined();

    // The remote twin must not be reported as a separate library component.
    const twins = (ready.newLibraryComponents || [])
      .filter((c) => c.nodeName === 'buttonPrimary');
    expect(twins).toEqual([]);

    // And the token still counts exactly one affected component.
    expect(ready.updatedComponentCounts.v1).toBe(1);
  });

  it('keeps the surviving entry local, so it can be focused on canvas', async () => {
    const { send, lastOf } = await loadPlugin(ENTRY, selfConsumingLibrary());

    await send({ type: 'init' });
    await send({ type: 'usage-scan', depth: 3 });
    await send({ type: 'analyze', variableId: 'v1' });

    const chain = lastOf('chain-result');
    const comps = chain.components.filter((c) => c.nodeName === 'buttonPrimary');
    expect(comps).toHaveLength(1);
    expect(comps[0].nodeId).toBe('local-master');
    expect(comps[0].pageName).toBe('Page 1');
  });
});
