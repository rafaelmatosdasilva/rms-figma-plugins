import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadPlugin, makeVar, makeCollection, makePage, makeNode } from '@rms/test-utils';

const ENTRY = fileURLToPath(new URL('../src/code.js', import.meta.url));

const boundSolid = (varId) => ({
  type: 'SOLID',
  color: { r: 0, g: 0, b: 0 },
  boundVariables: { color: { type: 'VARIABLE_ALIAS', id: varId } },
});

/** Two exportable frames selected, each carrying a variable-backed fill. */
function exportScene() {
  const brand = makeVar('v-brand', 'brand/primary', { value: { r: 1, g: 0, b: 0 } });
  brand.description = '[cmyk:0,100,100,0]';

  const one = makeNode('FRAME', { id: 'f1', name: 'Poster A', width: 100, height: 200, fills: [boundSolid('v-brand')] });
  const two = makeNode('FRAME', { id: 'f2', name: 'Poster B', width: 300, height: 400, fills: [boundSolid('v-brand')] });

  const page = makePage('Page 1');
  page.appendChild(one);
  page.appendChild(two);
  page.selection = [one, two];

  return {
    scene: { variables: [brand], collections: [makeCollection('coll-1', 'Tokens')], pages: [page] },
    page, one, two,
  };
}

describe('tokens-to-ink — export', () => {
  it('reports how many frames it will export', async () => {
    const { scene, page } = exportScene();
    const { figma, send, lastOf } = await loadPlugin(ENTRY, scene);
    figma.currentPage = page;

    await send({ type: 'export-request', format: 'pdf' });

    expect(lastOf('export-ready')).toMatchObject({ count: 2, format: 'pdf' });
  });

  it('refuses to export when nothing exportable is selected', async () => {
    const { scene, page } = exportScene();
    page.selection = [];
    const { figma, send, lastOf } = await loadPlugin(ENTRY, scene);
    figma.currentPage = page;

    await send({ type: 'export-request', format: 'pdf' });

    expect(lastOf('export-ready')).toBeUndefined();
    expect(lastOf('error').message).toContain('select at least one');
  });

  it('walks the frames one at a time, driven by the UI acknowledging each', async () => {
    const { scene, page } = exportScene();
    const { figma, send, lastOf, postedOf } = await loadPlugin(ENTRY, scene);
    figma.currentPage = page;

    await send({ type: 'export-request', format: 'pdf' });
    await send({ type: 'export-frames' });

    // The batch announces itself, then exports only the first frame.
    expect(lastOf('export-batch-start')).toMatchObject({ total: 2, format: 'pdf' });
    expect(postedOf('export-data')).toHaveLength(1);
    expect(lastOf('export-data')).toMatchObject({ frameName: 'Poster A', index: 0, total: 2 });

    // The next frame only goes out once the UI says it is ready for it.
    await send({ type: 'export-frame-ack', nextIndex: 1 });
    expect(postedOf('export-data')).toHaveLength(2);
    expect(lastOf('export-data')).toMatchObject({ frameName: 'Poster B', index: 1, total: 2 });
  });

  it('stops exporting when the user cancels', async () => {
    const { scene, page } = exportScene();
    const { figma, send, postedOf } = await loadPlugin(ENTRY, scene);
    figma.currentPage = page;

    await send({ type: 'export-request', format: 'pdf' });
    await send({ type: 'export-frames' });
    await send({ type: 'cancel-export' });
    await send({ type: 'export-frame-ack', nextIndex: 1 });

    // Only the frame that was already out; the acked one never runs.
    expect(postedOf('export-data')).toHaveLength(1);
  });

  it('carries the print values along with each exported frame', async () => {
    const { scene, page } = exportScene();
    const { figma, send, lastOf } = await loadPlugin(ENTRY, scene);
    figma.currentPage = page;

    await send({ type: 'export-request', format: 'pdf' });
    await send({ type: 'export-frames' });

    // The whole point of the export: mapped print values travel with the artwork.
    expect(lastOf('export-data').colorLookup).toBeTruthy();
    // Bytes travel as a Uint8Array (postMessage handles typed arrays), not an Array.from copy.
    expect(lastOf('export-data').pdfBytes).toBeInstanceOf(Uint8Array);
  });

  it('scales raster exports to 300 dpi', async () => {
    const { scene, page, one } = exportScene();
    const { figma, send, lastOf } = await loadPlugin(ENTRY, scene);
    figma.currentPage = page;

    let settings = null;
    one.exportAsync = async (s) => { settings = s; return new Uint8Array([1, 2, 3]); };

    await send({ type: 'export-request', format: 'tiff' });
    await send({ type: 'export-frames' });

    const dpiScale = 300 / 72;
    expect(settings).toMatchObject({ format: 'PNG', constraint: { type: 'SCALE', value: dpiScale } });
    // Pixel dimensions are reported at the scaled size, not the canvas size.
    expect(lastOf('export-data')).toMatchObject({
      width: Math.round(100 * dpiScale),
      height: Math.round(200 * dpiScale),
    });
  });

  it('reports a frame that fails without abandoning the batch', async () => {
    const { scene, page, one } = exportScene();
    const { figma, send, lastOf } = await loadPlugin(ENTRY, scene);
    figma.currentPage = page;
    one.exportAsync = async () => { throw new Error('frame too big'); };

    await send({ type: 'export-request', format: 'pdf' });
    await send({ type: 'export-frames' });

    expect(lastOf('export-item-error')).toMatchObject({ frameName: 'Poster A', index: 0, total: 2 });
    expect(lastOf('export-item-error').message).toContain('frame too big');

    // The batch is still alive — the next frame exports fine.
    await send({ type: 'export-frame-ack', nextIndex: 1 });
    expect(lastOf('export-data')).toMatchObject({ frameName: 'Poster B' });
  });

  it('keeps a manual CMYK tag when a later colour resolves to the same hex', async () => {
    // Two variables land on the same red. The first carries a manual [cmyk] tag
    // deliberately different from red's computed CMYK; the second is untagged. The
    // manual value must survive rather than being overwritten by the computed one.
    const brand = makeVar('v-brand', 'brand/primary', { value: { r: 1, g: 0, b: 0 } });
    brand.description = '[cmyk:5,95,90,2]';
    const plain = makeVar('v-plain', 'accent/red', { value: { r: 1, g: 0, b: 0 } });

    const one = makeNode('FRAME', { id: 'f1', name: 'Poster A', width: 100, height: 200, fills: [boundSolid('v-brand')] });
    const two = makeNode('FRAME', { id: 'f2', name: 'Poster B', width: 100, height: 200, fills: [boundSolid('v-plain')] });
    const page = makePage('Page 1');
    page.appendChild(one); page.appendChild(two);
    page.selection = [one, two];

    const scene = { variables: [brand, plain], collections: [makeCollection('coll-1', 'Tokens')], pages: [page] };
    const { figma, send, lastOf } = await loadPlugin(ENTRY, scene);
    figma.currentPage = page;

    await send({ type: 'export-request', format: 'pdf' });
    await send({ type: 'export-frames' });

    // Manual CMYK wins; entries also carry a pantone field (null here — no Pantone tag).
    expect(lastOf('export-data').colorLookup['#FF0000']).toMatchObject({ c: 5, m: 95, y: 90, k: 2 });
  });

  it('ignores an acknowledgement when no export is running', async () => {
    const { scene, page } = exportScene();
    const { figma, send, postedOf } = await loadPlugin(ENTRY, scene);
    figma.currentPage = page;

    await send({ type: 'export-frame-ack', nextIndex: 0 });

    expect(postedOf('export-data')).toEqual([]);
  });
});
