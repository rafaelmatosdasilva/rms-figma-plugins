import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadPlugin, makePage, makeNode } from '@rms/test-utils';

const ENTRY = fileURLToPath(new URL('../src/code.js', import.meta.url));

// Boot-level cover: the backend runs real work at import (loadAllPagesAsync, event
// registration) and answers the UI's first messages. If a refactor breaks any of
// that, the plugin is dead on open — this catches it without opening Figma.
describe('tokens-to-ink — boot', () => {
  it('loads and installs a message handler', async () => {
    const { figma } = await loadPlugin(ENTRY, { pages: [makePage('Page 1')] });
    expect(typeof figma.ui.onmessage).toBe('function');
  });

  it('reports the selection count once the document is ready', async () => {
    const frame = makeNode('FRAME', { name: 'Artwork' });
    const page = makePage('Page 1', [frame]);
    page.selection = [frame];
    const { figma, postedOf } = await loadPlugin(ENTRY, { pages: [page] });
    figma.currentPage = page;

    // The top-level async IIFE awaits loadAllPagesAsync before posting.
    await new Promise((r) => setTimeout(r, 0));

    const counts = postedOf('selection-count');
    expect(counts.length).toBeGreaterThan(0);
  });

  it('restores a stored window height when the UI asks for it', async () => {
    const { send, lastOf } = await loadPlugin(ENTRY, {
      pages: [makePage('Page 1')],
      clientStorage: { windowSize: { w: 600, h: 720 } },
    });

    await send({ type: 'get-saved-height' });

    expect(lastOf('restore-height')).toMatchObject({ height: 720 });
  });

  it('ignores unknown messages instead of throwing', async () => {
    const { send } = await loadPlugin(ENTRY, { pages: [makePage('Page 1')] });
    await expect(send({ type: 'not-a-real-message' })).resolves.not.toThrow();
  });
});
