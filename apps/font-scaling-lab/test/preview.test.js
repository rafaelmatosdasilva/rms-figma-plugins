import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadPlugin, makePage, makeNode, makeText, waitFor } from '@rms/test-utils';

const ENTRY = fileURLToPath(new URL('../src/code.js', import.meta.url));

/**
 * A selected frame with two text nodes. Preview clones the frame off-screen,
 * scales the clone's text, exports it, then deletes the clone — the real document
 * must come back untouched.
 */
function previewScene() {
  const heading = makeText('Heading', {
    fontSize: 24, fontName: { family: 'Inter', style: 'Bold' }, width: 200, height: 32,
  });
  const label = makeText('Some label', {
    fontSize: 14, fontName: { family: 'Inter', style: 'Regular' }, width: 100, height: 20,
  });
  const frame = makeNode('FRAME', {
    name: 'Card', width: 320, height: 200, children: [heading, label],
  });
  const page = makePage('Page 1', [frame]);
  page.selection = [frame];
  return { page, frame, heading, label };
}

describe('font-scaling-lab — preview', () => {
  it('exports the frame unscaled at 1×', async () => {
    const { page, frame } = previewScene();
    const { figma, send, lastOf } = await loadPlugin(ENTRY, { pages: [page] });
    figma.currentPage = page;

    await send({ type: 'preview', scale: 1, dpr: 2 });

    const result = lastOf('preview-result');
    expect(result).toBeDefined();
    expect(result.scale).toBe(1);
    expect(result.name).toBe('Card');
    expect(result.frameId).toBe(frame.id);
    expect(result.frameW).toBe(320);
    expect(result.frameH).toBe(200);
    // Bytes travel as a plain array so they survive postMessage.
    expect(Array.isArray(result.scaled)).toBe(true);
    // Nothing is scaled, so there is nothing to report.
    expect(result.issues).toEqual([]);
  });

  it('scales text on a throwaway clone and leaves the original untouched', async () => {
    const { page, frame, heading, label } = previewScene();
    const { figma, send, lastOf } = await loadPlugin(ENTRY, { pages: [page] });
    figma.currentPage = page;

    await send({ type: 'preview', scale: 2, dpr: 2 });

    expect(lastOf('preview-result')).toBeDefined();
    expect(lastOf('preview-result').scale).toBe(2);

    // The document is exactly as it was: same children, same font sizes.
    expect(frame.children).toHaveLength(2);
    expect(heading.fontSize).toBe(24);
    expect(label.fontSize).toBe(14);
    expect(heading.parent).toBe(frame);
  });

  it('deletes the scout clone when it is done', async () => {
    const { page } = previewScene();
    const { figma, send } = await loadPlugin(ENTRY, { pages: [page] });
    figma.currentPage = page;

    await send({ type: 'preview', scale: 1.5, dpr: 2 });

    // No leftover marked clone anywhere on the page.
    const leftovers = page.findAll((n) => n.getPluginData('_scoutClone') === '1');
    expect(leftovers).toEqual([]);
  });

  it('loads the fonts it needs before scaling text', async () => {
    const { page } = previewScene();
    const loaded = [];
    const { figma, send } = await loadPlugin(ENTRY, { pages: [page] });
    figma.currentPage = page;
    figma.loadFontAsync = async (font) => { loaded.push(font); };

    await send({ type: 'preview', scale: 2, dpr: 2 });

    expect(loaded).toEqual(expect.arrayContaining([
      { family: 'Inter', style: 'Bold' },
      { family: 'Inter', style: 'Regular' },
    ]));
  });

  it('exports as PNG honouring the requested pixel ratio', async () => {
    const { page } = previewScene();
    const { figma, send } = await loadPlugin(ENTRY, { pages: [page] });
    figma.currentPage = page;

    let settings = null;
    const frame = page.children[0];
    frame.exportAsync = async (s) => { settings = s; return new Uint8Array([1, 2, 3]); };

    await send({ type: 'preview', scale: 1, dpr: 3 });

    expect(settings).toMatchObject({
      format: 'PNG',
      constraint: { type: 'SCALE', value: 3 },
      useAbsoluteBounds: true,
      contentsOnly: true,
    });
  });

  it('ignores a preview when nothing usable is selected', async () => {
    const page = makePage('Page 1');
    page.selection = [];
    const { figma, send, postedOf } = await loadPlugin(ENTRY, { pages: [page] });
    figma.currentPage = page;

    await send({ type: 'preview', scale: 2, dpr: 2 });

    expect(postedOf('preview-result')).toEqual([]);
  });

  it('reports an export failure as an error instead of hanging', async () => {
    const { page } = previewScene();
    const { figma, send, lastOf } = await loadPlugin(ENTRY, { pages: [page] });
    figma.currentPage = page;
    page.children[0].exportAsync = async () => { throw new Error('export blew up'); };

    await send({ type: 'preview', scale: 1, dpr: 2 });

    expect(lastOf('error').message).toContain('export blew up');
    expect(lastOf('preview-result')).toBeUndefined();
  });
});

describe('font-scaling-lab — preview cancellation', () => {
  it('never delivers a result the user already cancelled', async () => {
    const { page } = previewScene();
    const { figma, send, postedOf } = await loadPlugin(ENTRY, { pages: [page] });
    figma.currentPage = page;

    // Suspend the export so the cancel lands while the preview is in flight.
    let release;
    const gate = new Promise((r) => { release = r; });
    page.children[0].exportAsync = async () => {
      await gate;
      return new Uint8Array([1, 2, 3]);
    };

    const inFlight = send({ type: 'preview', scale: 1, dpr: 2 });
    await send({ type: 'preview-cancel' });
    release();
    await inFlight;

    expect(postedOf('preview-result')).toEqual([]);
  });

  it('delivers only the newest result when previews overlap', async () => {
    const { page } = previewScene();
    const { figma, send, postedOf } = await loadPlugin(ENTRY, { pages: [page] });
    figma.currentPage = page;

    let release;
    const gate = new Promise((r) => { release = r; });
    let first = true;
    page.children[0].exportAsync = async () => {
      if (first) { first = false; await gate; }
      return new Uint8Array([1, 2, 3]);
    };

    const stale = send({ type: 'preview', scale: 1, dpr: 2 });
    await send({ type: 'preview', scale: 1, dpr: 2 }); // supersedes the first
    release();
    await stale;

    // The superseded run is dropped, not posted twice.
    expect(postedOf('preview-result')).toHaveLength(1);
  });

  it('cleans up the clone when a scaled preview is cancelled', async () => {
    const { page } = previewScene();
    const { figma, send } = await loadPlugin(ENTRY, { pages: [page] });
    figma.currentPage = page;

    let release;
    const gate = new Promise((r) => { release = r; });
    figma.loadFontAsync = async () => { await gate; };

    const inFlight = send({ type: 'preview', scale: 2, dpr: 2 });
    await send({ type: 'preview-cancel' });
    release();
    await inFlight;

    const leftovers = page.findAll((n) => n.getPluginData('_scoutClone') === '1');
    expect(leftovers).toEqual([]);
  });
});

describe('font-scaling-lab — orphan clone sweep', () => {
  it('removes a clone left behind by a previous crash', async () => {
    const orphan = makeNode('FRAME', { name: 'leftover' });
    orphan.setPluginData('_scoutClone', '1');
    const keep = makeNode('FRAME', { name: 'real content' });
    const page = makePage('Page 1', [orphan, keep]);
    page.selection = [];

    await loadPlugin(ENTRY, { pages: [page] });

    // The sweep runs at import — the orphan is gone, real content stays.
    expect(page.children.map((c) => c.name)).toEqual(['real content']);
  });
});
