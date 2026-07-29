import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  loadPlugin, makeVar, makeCollection, makePage, makeNode, waitFor,
} from '@rms/test-utils';

const ENTRY = fileURLToPath(new URL('../src/code.js', import.meta.url));

const solid = (r, g, b) => ({ type: 'SOLID', color: { r, g, b } });
const boundSolid = (varId) => ({
  type: 'SOLID',
  color: { r: 0, g: 0, b: 0 },
  boundVariables: { color: { type: 'VARIABLE_ALIAS', id: varId } },
});

describe('tokens-to-ink — jumping to artwork', () => {
  function twoPages() {
    const here = makeNode('RECTANGLE', { id: 'here', name: 'Here' });
    const alsoHere = makeNode('RECTANGLE', { id: 'also', name: 'Also here' });
    const elsewhere = makeNode('RECTANGLE', { id: 'far', name: 'Elsewhere' });
    const p1 = makePage('Page 1'); p1.appendChild(here); p1.appendChild(alsoHere);
    const p2 = makePage('Page 2'); p2.appendChild(elsewhere);
    return { p1, p2, here, alsoHere, elsewhere };
  }

  it('selects a single node and brings it into view', async () => {
    const { p1, p2, here } = twoPages();
    const { figma, send } = await loadPlugin(ENTRY, { pages: [p1, p2] });
    figma.currentPage = p1;
    let zoomed = null;
    figma.viewport.scrollAndZoomIntoView = (n) => { zoomed = n; };

    await send({ type: 'focus-node', nodeId: 'here' });

    expect(figma.currentPage.selection).toEqual([here]);
    expect(zoomed).toEqual([here]);
  });

  it('switches page when the node lives elsewhere', async () => {
    const { p1, p2, elsewhere } = twoPages();
    const { figma, send } = await loadPlugin(ENTRY, { pages: [p1, p2] });
    figma.currentPage = p1;

    await send({ type: 'focus-node', nodeId: 'far' });

    expect(figma.currentPage.name).toBe('Page 2');
    expect(figma.currentPage.selection).toEqual([elsewhere]);
  });

  it('selects every node behind one colour at once', async () => {
    const { p1, p2, here, alsoHere } = twoPages();
    const { figma, send } = await loadPlugin(ENTRY, { pages: [p1, p2] });
    figma.currentPage = p1;

    await send({ type: 'focus-nodes', nodeIds: ['here', 'also'] });

    expect(figma.currentPage.selection).toEqual([here, alsoHere]);
  });

  it('skips ids that no longer resolve', async () => {
    const { p1, p2, here } = twoPages();
    const { figma, send } = await loadPlugin(ENTRY, { pages: [p1, p2] });
    figma.currentPage = p1;

    await send({ type: 'focus-nodes', nodeIds: ['here', 'deleted'] });

    expect(figma.currentPage.selection).toEqual([here]);
  });

  it('leaves the selection alone when none of the ids resolve', async () => {
    const { p1, p2 } = twoPages();
    const { figma, send } = await loadPlugin(ENTRY, { pages: [p1, p2] });
    figma.currentPage = p1;

    await send({ type: 'focus-nodes', nodeIds: ['nope'] });

    expect(figma.currentPage.selection).toEqual([]);
  });

  it('reports a lookup failure as an error', async () => {
    const { p1, p2 } = twoPages();
    const { figma, send, lastOf } = await loadPlugin(ENTRY, { pages: [p1, p2] });
    figma.currentPage = p1;
    figma.getNodeByIdAsync = async () => { throw new Error('lookup died'); };

    await send({ type: 'focus-node', nodeId: 'here' });

    expect(lastOf('error').message).toContain('lookup died');
  });

  it('opens a reference link in the browser', async () => {
    const { p1, p2 } = twoPages();
    const { figma, send } = await loadPlugin(ENTRY, { pages: [p1, p2] });
    let opened = null;
    figma.openExternal = (url) => { opened = url; };

    await send({ type: 'open-external-url', url: 'https://example.com/pantone' });

    expect(opened).toBe('https://example.com/pantone');
  });
});

describe('tokens-to-ink — what the scan collects', () => {
  async function scanOf(children) {
    const brand = makeVar('v-brand', 'brand/primary', { value: { r: 1, g: 0, b: 0 } });
    const frame = makeNode('FRAME', { name: 'Artwork', fills: [] });
    for (const c of children) frame.appendChild(c);
    const page = makePage('Page 1');
    page.appendChild(frame);
    page.selection = [frame];

    const { figma, send, lastOf } = await loadPlugin(ENTRY, {
      variables: [brand], collections: [makeCollection('coll-1', 'Tokens')], pages: [page],
    });
    figma.currentPage = page;
    await send({ type: 'request-scan' });
    return waitFor(() => lastOf('scan-results'), { label: 'scan-results' });
  }

  it('collects the same colour once, however many layers use it', async () => {
    const results = await scanOf([
      makeNode('RECTANGLE', { name: 'A', fills: [solid(0, 0, 1)] }),
      makeNode('RECTANGLE', { name: 'B', fills: [solid(0, 0, 1)] }),
    ]);

    const blues = results.data.filter((d) => d.source === 'raw');
    expect(blues).toHaveLength(1);
  });

  it('ignores hidden layers', async () => {
    const results = await scanOf([
      makeNode('RECTANGLE', { name: 'Visible', fills: [solid(0, 0, 1)] }),
      makeNode('RECTANGLE', { name: 'Hidden', visible: false, fills: [solid(0, 1, 0)] }),
    ]);

    const hexes = results.data.map((d) => d.hex);
    expect(hexes).toContain('#0000FF');
    expect(hexes).not.toContain('#00FF00');
  });

  it('collects colours from strokes, not just fills', async () => {
    const results = await scanOf([
      makeNode('RECTANGLE', { name: 'Outlined', fills: [], strokes: [solid(1, 0, 0)] }),
    ]);

    expect(results.data.map((d) => d.hex)).toContain('#FF0000');
  });

  it('keeps a variable-backed colour separate from the same colour used raw', async () => {
    const results = await scanOf([
      makeNode('RECTANGLE', { name: 'Token', fills: [boundSolid('v-brand')] }),
      makeNode('RECTANGLE', { name: 'Hardcoded', fills: [solid(1, 0, 0)] }),
    ]);

    // Same red, but one is a token and the other is not — the whole point of the scan.
    expect(results.data.filter((d) => d.source === 'variable')).toHaveLength(1);
    expect(results.data.filter((d) => d.source === 'raw')).toHaveLength(1);
  });
});
