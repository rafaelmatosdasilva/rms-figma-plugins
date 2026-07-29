import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  loadPlugin, makeVar, makeCollection, makePage, makeComponent, makeInstance, makeNode, makeGate,
} from '@rms/test-utils';

const ENTRY = fileURLToPath(new URL('../src/code.js', import.meta.url));
const paint = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }];

/**
 * A local master with one instance on the canvas, plus a loose rectangle that binds
 * the same token directly (not through an instance). Depth 3 is the only level that
 * counts either of those.
 */
function scanScene() {
  const token = makeVar('v1', 'button/background');
  const master = makeComponent('buttonPrimary', {
    id: 'comp-1', fills: paint, boundVariables: { fills: [{ id: 'v1' }] },
  });
  const instance = makeInstance(master, { id: 'inst-1' });
  const loose = makeNode('RECTANGLE', {
    id: 'rect-1', name: 'Loose swatch', fills: paint, boundVariables: { fills: [{ id: 'v1' }] },
  });

  const page = makePage('Page 1');
  page.appendChild(master);
  page.appendChild(instance);
  page.appendChild(loose);

  return {
    variables: [token],
    collections: [makeCollection('coll-1', 'Tokens')],
    pages: [page],
  };
}

describe('impact-atlas — usage scan depth', () => {
  it('counts canvas instances at full depth', async () => {
    const { send, lastOf } = await loadPlugin(ENTRY, scanScene());
    await send({ type: 'init' });
    await send({ type: 'usage-scan', depth: 3 });

    const ready = lastOf('usage-scan-ready');
    expect(ready.depth).toBe(3);
    expect(ready.instanceCounts.v1).toBe(1);
  });

  it('counts layers that bind a token outside any instance at full depth', async () => {
    const { send, lastOf } = await loadPlugin(ENTRY, scanScene());
    await send({ type: 'init' });
    await send({ type: 'usage-scan', depth: 3 });

    // The loose rectangle is a direct binding, not an instance usage.
    expect(lastOf('usage-scan-ready').directCounts.v1).toBeGreaterThan(0);
  });

  it('leaves canvas counts alone at extended depth', async () => {
    // Extended discovers library tokens but must not walk the canvas for usage.
    const { send, lastOf } = await loadPlugin(ENTRY, scanScene());
    await send({ type: 'init' });
    await send({ type: 'usage-scan', depth: 2 });

    const ready = lastOf('usage-scan-ready');
    expect(ready.depth).toBe(2);
    expect(ready.instanceCounts).toEqual({});
    expect(ready.directCounts).toEqual({});
  });
});

describe('impact-atlas — scan cancellation', () => {
  it('stops without delivering results when cancelled mid-run', async () => {
    const scene = scanScene();
    const { figma, send, postedOf } = await loadPlugin(ENTRY, scene);
    await send({ type: 'init' });

    // Suspend the scan inside the instance walk so the cancel lands mid-flight.
    const gate = makeGate();
    const instance = scene.pages[0].children[1];
    const original = instance.getMainComponentAsync.bind(instance);
    instance.getMainComponentAsync = async () => { await gate.promise; return original(); };

    const inFlight = send({ type: 'usage-scan', depth: 3 });
    await send({ type: 'usage-scan-cancel' });
    gate.open();
    await inFlight;

    expect(postedOf('usage-scan-cancelled').length).toBeGreaterThan(0);
    expect(postedOf('usage-scan-ready')).toEqual([]);
  });
});

describe('impact-atlas — scan cache', () => {
  it('writes the scan to storage so the next open can reuse it', async () => {
    const { figma, send } = await loadPlugin(ENTRY, scanScene());
    await send({ type: 'init' });
    await send({ type: 'usage-scan', depth: 3 });

    const key = `scan-${figma.fileKey || 'local'}`;
    const cached = await figma.clientStorage.getAsync(key);
    expect(cached).toBeTruthy();
    expect(cached.depth).toBe(3);
    expect(cached.browserComponents.length).toBeGreaterThan(0);
    // Zero counts are stripped before storing, to stay under the storage limit.
    for (const value of Object.values(cached.instanceCounts)) expect(value).not.toBe(0);
  });

  it('remembers the depth that was scanned', async () => {
    const { figma, send } = await loadPlugin(ENTRY, scanScene());
    await send({ type: 'init' });
    await send({ type: 'usage-scan', depth: 3 });

    expect(await figma.clientStorage.getAsync('scan-depth')).toBe(3);
  });
});

describe('impact-atlas — router', () => {
  it('ignores an unknown message instead of throwing', async () => {
    const { send, posted } = await loadPlugin(ENTRY, scanScene());
    await send({ type: 'init' });
    const before = posted.length;

    await expect(send({ type: 'no-such-message' })).resolves.not.toThrow();
    expect(posted.length).toBe(before);
  });

  it('persists the window size the UI reports', async () => {
    const { figma, send } = await loadPlugin(ENTRY, scanScene());
    await send({ type: 'save-size', width: 900, height: 600 });

    expect(await figma.clientStorage.getAsync('windowSize')).toEqual({ w: 900, h: 600 });
  });
});
