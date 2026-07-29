import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadPlugin, makePage, makeNode, makeText } from '@rms/test-utils';

const ENTRY = fileURLToPath(new URL('../src/code.js', import.meta.url));

function sceneWithSelectedFrame() {
  const text = makeText('Some label', { fontSize: 14, width: 100, height: 20 });
  const frame = makeNode('FRAME', { name: 'Card', width: 320, height: 200, children: [text] });
  const page = makePage('Page 1', [frame]);
  page.selection = [frame];
  return { page, frame };
}

// Boot-level cover: this backend sweeps orphaned clones and registers a
// selectionchange listener at import, then answers 'ready' with a scan of the
// selection. A break in any of that means a blank plugin on open.
describe('font-scaling-lab — boot', () => {
  it('loads and installs a message handler', async () => {
    const { page } = sceneWithSelectedFrame();
    const { figma } = await loadPlugin(ENTRY, { pages: [page] });
    expect(typeof figma.ui.onmessage).toBe('function');
  });

  it('answers "ready" with the current selection', async () => {
    const { page } = sceneWithSelectedFrame();
    const { figma, send, lastOf } = await loadPlugin(ENTRY, { pages: [page] });
    figma.currentPage = page;

    await send({ type: 'ready' });

    const selection = lastOf('selection');
    expect(selection).toBeDefined();
    // A frame holding text is a valid target — no error state.
    expect(selection.data.error).toBeUndefined();
  });

  it('reports an empty selection rather than failing', async () => {
    const page = makePage('Page 1');
    page.selection = [];
    const { figma, send, lastOf } = await loadPlugin(ENTRY, { pages: [page] });
    figma.currentPage = page;

    await send({ type: 'ready' });

    expect(lastOf('selection').data.error).toBe('no-selection');
  });

  it('restores stored panel widths on ready', async () => {
    const { page } = sceneWithSelectedFrame();
    const { figma, send, postedOf } = await loadPlugin(ENTRY, {
      pages: [page],
      clientStorage: { panelWidth: 300, detailsWidth: 420 },
    });
    figma.currentPage = page;

    await send({ type: 'ready' });
    await new Promise((r) => setTimeout(r, 0)); // widths are posted from a .then()

    expect(postedOf('panel-width')[0]).toMatchObject({ width: 300 });
    expect(postedOf('details-width')[0]).toMatchObject({ width: 420 });
  });

  it('ignores unknown messages instead of throwing', async () => {
    const { page } = sceneWithSelectedFrame();
    const { send } = await loadPlugin(ENTRY, { pages: [page] });
    await expect(send({ type: 'not-a-real-message' })).resolves.not.toThrow();
  });
});
