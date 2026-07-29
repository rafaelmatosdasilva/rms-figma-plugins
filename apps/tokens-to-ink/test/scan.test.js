import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  loadPlugin, makeVar, makeCollection, makePage, makeNode, waitFor,
} from '@rms/test-utils';

const ENTRY = fileURLToPath(new URL('../src/code.js', import.meta.url));

const solid = (r, g, b) => ({ type: 'SOLID', color: { r, g, b } });
/** A fill bound to a variable, in the shape getPaintVariableId understands. */
const boundSolid = (varId) => ({
  type: 'SOLID',
  color: { r: 0, g: 0, b: 0 },
  boundVariables: { color: { type: 'VARIABLE_ALIAS', id: varId } },
});

/**
 * One selected frame containing a variable-backed fill and a raw hex fill.
 * `request-scan` is fire-and-forget, so tests poll with waitFor.
 */
function scene({ description = '' } = {}) {
  const brand = makeVar('v-brand', 'brand/primary', { value: { r: 1, g: 0, b: 0 } });
  brand.description = description;

  const bound = makeNode('RECTANGLE', { name: 'Bound', fills: [boundSolid('v-brand')] });
  const raw = makeNode('RECTANGLE', { name: 'Raw', fills: [solid(0, 0, 1)] });
  const frame = makeNode('FRAME', { name: 'Artwork', fills: [], children: [bound, raw] });

  const page = makePage('Page 1', [frame]);
  page.selection = [frame];

  return {
    scene: {
      variables: [brand],
      collections: [makeCollection('coll-1', 'Tokens')],
      pages: [page],
    },
    page,
  };
}

describe('tokens-to-ink — colour scan', () => {
  it('reports both variable-backed and raw colours from the selection', async () => {
    const { scene: s, page } = scene();
    const { figma, send, lastOf } = await loadPlugin(ENTRY, s);
    figma.currentPage = page;

    await send({ type: 'request-scan' });
    const results = await waitFor(() => lastOf('scan-results'), { label: 'scan-results' });

    const names = results.data.map((d) => d.name);
    expect(names).toContain('brand/primary'); // the variable
    expect(results.data.some((d) => d.source === 'raw')).toBe(true);

    // Variables sort before raw colours.
    expect(results.data[0].source).toBe('variable');
    expect(results.summary.totalColors).toBe(results.data.length);
    expect(results.sourceNodes.map((n) => n.name)).toEqual(['Artwork']);
  });

  it('lists every colour variable in the file when nothing is selected', async () => {
    // With no artwork to scan the plugin is still useful as a reference list —
    // and the empty sourceNodes is what tells the UI to hide the export button.
    const { scene: s, page } = scene();
    page.selection = [];
    const { figma, send, lastOf } = await loadPlugin(ENTRY, s);
    figma.currentPage = page;

    await send({ type: 'request-scan' });
    const results = await waitFor(() => lastOf('scan-results'), { label: 'scan-results' });

    expect(results.data.map((d) => d.name)).toEqual(['brand/primary']);
    expect(results.data.every((d) => d.source === 'variable')).toBe(true);
    expect(results.sourceNodes).toEqual([]);
  });

  it('scans on its own as soon as it opens, without waiting to be asked', async () => {
    const { scene: s, page } = scene();
    const { figma, lastOf } = await loadPlugin(ENTRY, s);
    figma.currentPage = page;

    const results = await waitFor(() => lastOf('scan-results'), { label: 'launch scan' });
    expect(results.data.length).toBeGreaterThan(0);
  });

  it('surfaces a scan failure as an error message rather than throwing', async () => {
    const { scene: s, page } = scene();
    const { figma, send, lastOf } = await loadPlugin(ENTRY, s);
    figma.currentPage = page;
    figma.variables.getLocalVariablesAsync = async () => { throw new Error('boom'); };

    await send({ type: 'request-scan' });
    const err = await waitFor(() => lastOf('error'), { label: 'error' });

    expect(err.message).toContain('boom');
  });

  it('reads an existing CMYK tag off the variable description', async () => {
    const { scene: s, page } = scene({ description: '[cmyk:0,100,100,0]' });
    const { figma, send, lastOf } = await loadPlugin(ENTRY, s);
    figma.currentPage = page;

    await send({ type: 'request-scan' });
    const results = await waitFor(() => lastOf('scan-results'), { label: 'scan-results' });

    const brand = results.data.find((d) => d.name === 'brand/primary');
    // The tag is parsed into channels, not passed through as the raw string.
    expect(brand.cmyk).toEqual({ c: 0, m: 100, y: 100, k: 0 });
    expect(results.summary.withCmykPairs).toBeGreaterThan(0);
  });
});

describe('tokens-to-ink — output value tags', () => {
  // Each output value is stored as a tag in the variable's description, so the
  // values travel with the file. These pin the write/erase round-trip.
  const cases = [
    { kind: 'cmyk', update: 'update-cmyk-variable', del: 'delete-cmyk-variable', field: 'cmykValue', value: '0,100,100,0' },
    { kind: 'pantone', update: 'update-pantone-variable', del: 'delete-pantone-variable', field: 'pantoneValue', value: '485 C' },
    { kind: 'ral', update: 'update-ral-variable', del: 'delete-ral-variable', field: 'ralValue', value: '3020' },
    { kind: 'vinyl', update: 'update-vinyl-variable', del: 'delete-vinyl-variable', field: 'vinylValue', value: 'Oracal 751' },
  ];

  for (const c of cases) {
    it(`writes and removes a ${c.kind} value on the variable`, async () => {
      const { scene: s, page } = scene();
      const { figma, send } = await loadPlugin(ENTRY, s);
      figma.currentPage = page;
      const variable = s.variables[0];

      await send({ type: c.update, colorVarId: 'v-brand', [c.field]: c.value });
      expect(variable.description).toContain(`[${c.kind}:${c.value}]`);

      await send({ type: c.del, colorVarId: 'v-brand' });
      expect(variable.description).not.toContain(`[${c.kind}:`);
    });
  }

  it('keeps other tags intact when one is removed', async () => {
    const { scene: s, page } = scene();
    const { figma, send } = await loadPlugin(ENTRY, s);
    figma.currentPage = page;
    const variable = s.variables[0];

    await send({ type: 'update-cmyk-variable', colorVarId: 'v-brand', cmykValue: '0,0,0,100' });
    await send({ type: 'update-pantone-variable', colorVarId: 'v-brand', pantoneValue: '485 C' });
    await send({ type: 'delete-cmyk-variable', colorVarId: 'v-brand' });

    expect(variable.description).not.toContain('[cmyk:');
    expect(variable.description).toContain('[pantone:485 C]');
  });

  it('reports a failure to write a tag instead of throwing', async () => {
    const { scene: s, page } = scene();
    const { figma, send, lastOf } = await loadPlugin(ENTRY, s);
    figma.currentPage = page;
    figma.variables.getVariableByIdAsync = async () => { throw new Error('nope'); };

    await send({ type: 'update-cmyk-variable', colorVarId: 'v-brand', cmykValue: '1,2,3,4' });

    expect(lastOf('error').message).toContain('nope');
  });
});

describe('tokens-to-ink — selection tracking', () => {
  it('reports the selection count when the selection changes', async () => {
    const { scene: s, page } = scene();
    const { figma, postedOf } = await loadPlugin(ENTRY, s);
    figma.currentPage = page;

    const before = postedOf('selection-count').length;
    figma.emit('selectionchange');

    expect(postedOf('selection-count').length).toBe(before + 1);
    expect(postedOf('selection-count').at(-1).count).toBe(1);
  });
});
