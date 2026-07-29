import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  loadPlugin, makeVar, makeCollection, makePage, makeNode, waitFor, tick,
} from '@rms/test-utils';

const ENTRY = fileURLToPath(new URL('../src/code.js', import.meta.url));

const solid = (r, g, b) => ({ type: 'SOLID', color: { r, g, b } });

function scene() {
  const rect = makeNode('RECTANGLE', { id: 'rect-1', name: 'Swatch', fills: [solid(0, 0, 1)] });
  const frame = makeNode('FRAME', { id: 'frame-1', name: 'Artwork', fills: [] });
  frame.appendChild(rect);
  const page = makePage('Page 1');
  page.appendChild(frame);
  page.selection = [frame];

  return {
    scene: {
      variables: [makeVar('v-brand', 'brand/primary', { value: { r: 1, g: 0, b: 0 } })],
      collections: [makeCollection('coll-1', 'Tokens')],
      pages: [page],
    },
    page, frame, rect,
  };
}

/** The rescan is debounced by 400 ms; give it room without leaning on fake timers. */
const DEBOUNCE_GRACE = 700;

/**
 * The plugin scans on its own as soon as it opens, so a hand-driven scan has to
 * wait for a *new* result rather than the first one that happens to be there.
 */
async function scanOnce({ send, lastOf, postedOf }) {
  await waitFor(() => lastOf('scan-results'), { label: 'launch scan' });
  const before = postedOf('scan-results').length;
  await send({ type: 'request-scan' });
  await waitFor(() => postedOf('scan-results').length > before, { label: 'requested scan' });
  return lastOf('scan-results');
}

describe('tokens-to-ink — rescanning after the document changes', () => {
  it('picks up a colour added after the first scan', async () => {
    const { scene: s, page, frame, rect } = scene();
    const { figma, send, lastOf, postedOf } = await loadPlugin(ENTRY, s);
    figma.currentPage = page;

    const first = await scanOnce({ send, lastOf, postedOf });
    expect(first.data.map((d) => d.hex)).not.toContain('#00FF00');

    // The designer recolours a layer; the plugin should notice on its own.
    rect.fills = [solid(0, 1, 0)];
    const before = postedOf('scan-results').length;
    figma.emit('documentchange');

    await waitFor(() => postedOf('scan-results').length > before, {
      timeout: DEBOUNCE_GRACE, label: 'auto rescan',
    });
    expect(lastOf('scan-results').data.map((d) => d.hex)).toContain('#00FF00');
  });

  it('rescans the artwork it scanned before, not whatever is selected now', async () => {
    const { scene: s, page, frame } = scene();
    const { figma, send, lastOf, postedOf } = await loadPlugin(ENTRY, s);
    figma.currentPage = page;

    await scanOnce({ send, lastOf, postedOf });

    // Selection moves away — the rescan must still be about the original artwork.
    page.selection = [];
    const before = postedOf('scan-results').length;
    figma.emit('documentchange');

    await waitFor(() => postedOf('scan-results').length > before, {
      timeout: DEBOUNCE_GRACE, label: 'auto rescan',
    });
    expect(lastOf('scan-results').sourceNodes.map((n) => n.id)).toEqual([frame.id]);
  });

  it('keeps the whole-file colour list fresh when nothing is selected', async () => {
    const { scene: s, page } = scene();
    page.selection = [];
    const { figma, send, lastOf, postedOf } = await loadPlugin(ENTRY, s);
    figma.currentPage = page;

    await scanOnce({ send, lastOf, postedOf });

    // A colour edited elsewhere in the file must still reach the list.
    const before = postedOf('scan-results').length;
    figma.emit('documentchange');

    await waitFor(() => postedOf('scan-results').length > before, {
      timeout: DEBOUNCE_GRACE, label: 'auto rescan',
    });
    expect(lastOf('scan-results').sourceNodes).toEqual([]);
  });

  it('collapses a burst of edits into a single rescan', async () => {
    const { scene: s, page } = scene();
    const { figma, send, lastOf, postedOf } = await loadPlugin(ENTRY, s);
    figma.currentPage = page;

    await scanOnce({ send, lastOf, postedOf });
    const before = postedOf('scan-results').length;

    // Typing/dragging fires many change events; the user should get one rescan.
    for (let i = 0; i < 5; i++) { figma.emit('documentchange'); await tick(); }

    await waitFor(() => postedOf('scan-results').length > before, {
      timeout: DEBOUNCE_GRACE, label: 'auto rescan',
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(postedOf('scan-results').length).toBe(before + 1);
  });

  it('drops artwork that was deleted since the last scan', async () => {
    const { scene: s, page, frame } = scene();
    const { figma, send, lastOf, postedOf } = await loadPlugin(ENTRY, s);
    figma.currentPage = page;

    await scanOnce({ send, lastOf, postedOf });

    frame.remove();
    const before = postedOf('scan-results').length;
    figma.emit('documentchange');
    await new Promise((r) => setTimeout(r, DEBOUNCE_GRACE));

    // Nothing left to rescan, so nothing is reported rather than a stale result.
    expect(postedOf('scan-results').length).toBe(before);
  });
});
