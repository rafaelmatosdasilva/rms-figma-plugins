import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadPlugin, makePage, makeNode, makeText } from '@rms/test-utils';

const ENTRY = fileURLToPath(new URL('../src/code.js', import.meta.url));

/** Build a page with one selected frame; children are appended so counts are honest. */
function withFrame(children = [], { type = 'FRAME', ...props } = {}) {
  const frame = makeNode(type, { name: 'Card', width: 320, height: 200, ...props });
  for (const c of children) frame.appendChild(c);
  const page = makePage('Page 1');
  page.appendChild(frame);
  page.selection = [frame];
  return { page, frame };
}

async function scan(scene, page) {
  const { figma, send, lastOf } = await loadPlugin(ENTRY, scene);
  figma.currentPage = page;
  await send({ type: 'ready' });
  return { figma, data: lastOf('selection').data, send, lastOf };
}

describe('font-scaling-lab — selection guards', () => {
  it('asks for a selection when there is none', async () => {
    const page = makePage('Page 1');
    page.selection = [];
    const { data } = await scan({ pages: [page] }, page);
    expect(data).toEqual({ error: 'no-selection' });
  });

  it('refuses more than one selected node', async () => {
    const a = makeNode('FRAME', { name: 'A' });
    const b = makeNode('FRAME', { name: 'B' });
    const page = makePage('Page 1');
    page.appendChild(a); page.appendChild(b);
    page.selection = [a, b];

    const { data } = await scan({ pages: [page] }, page);
    expect(data).toEqual({ error: 'multi-selection' });
  });

  it('refuses a node it cannot scale, like a bare text layer', async () => {
    const text = makeText('Hello', { fontSize: 14 });
    const page = makePage('Page 1');
    page.appendChild(text);
    page.selection = [text];

    const { data } = await scan({ pages: [page] }, page);
    expect(data).toEqual({ error: 'invalid-type' });
  });

  it('accepts a frame with no text at all', async () => {
    const { page } = withFrame();
    const { data } = await scan({ pages: [page] }, page);

    expect(data.error).toBeUndefined();
    expect(data.total).toBe(0);
    expect(data.nodes).toEqual([]);
    expect(data.counts).toEqual({ variable: 0, style: 0, override: 0 });
  });
});

describe('font-scaling-lab — selection report', () => {
  it('describes the selected frame', async () => {
    const { page, frame } = withFrame([makeText('Label', { fontSize: 14 })], { width: 320.4, height: 200.6 });
    const { data } = await scan({ pages: [page] }, page);

    expect(data.nodeId).toBe(frame.id);
    expect(data.name).toBe('Card');
    expect(data.type).toBe('FRAME');
    // Dimensions are reported rounded.
    expect(data.width).toBe(320);
    expect(data.height).toBe(201);
  });

  it('finds text nested at any depth', async () => {
    const deep = makeText('Deep label', { fontSize: 12 });
    const inner = makeNode('FRAME', { name: 'Inner' });
    inner.appendChild(deep);
    const { page } = withFrame([inner]);

    const { data } = await scan({ pages: [page] }, page);
    expect(data.total).toBe(1);
    expect(data.nodes[0].name).toBe(deep.name);
  });

  it('shortens long text for the list preview', async () => {
    const long = 'x'.repeat(50);
    const { page } = withFrame([makeText(long, { fontSize: 14 })]);

    const { data } = await scan({ pages: [page] }, page);
    expect(data.nodes[0].preview).toHaveLength(30);
  });

  it('copes with a text layer that has no characters', async () => {
    const { page } = withFrame([makeNode('TEXT', { name: 'Empty', fontSize: 14 })]);
    const { data } = await scan({ pages: [page] }, page);

    expect(data.total).toBe(1);
    expect(data.nodes[0].preview).toBe('');
  });
});

describe('font-scaling-lab — where each font size comes from', () => {
  it('reads a size bound to a variable', async () => {
    const text = makeText('Body', {
      boundVariables: { fontSize: { type: 'VARIABLE_ALIAS', id: 'v-fs' } },
      fontSize: 99, // must be ignored in favour of the variable
    });
    const { page } = withFrame([text]);

    const { data } = await scan({
      pages: [page],
      variables: [{
        id: 'v-fs', name: 'font/size/body', variableCollectionId: 'coll-1',
        resolvedType: 'FLOAT', valuesByMode: { m1: 16 },
      }],
      collections: [{ id: 'coll-1', name: 'Type', defaultModeId: 'm1', modes: [{ modeId: 'm1', name: 'Mode 1' }] }],
    }, page);

    expect(data.nodes[0]).toMatchObject({ source: 'variable', value: 16, tokenName: 'font/size/body' });
    expect(data.counts.variable).toBe(1);
  });

  it('follows a variable that aliases another', async () => {
    const text = makeText('Body', { boundVariables: { fontSize: { type: 'VARIABLE_ALIAS', id: 'v-a' } } });
    const { page } = withFrame([text]);

    const { data } = await scan({
      pages: [page],
      variables: [
        { id: 'v-a', name: 'semantic/body', variableCollectionId: 'coll-1', resolvedType: 'FLOAT', valuesByMode: { m1: { type: 'VARIABLE_ALIAS', id: 'v-b' } } },
        { id: 'v-b', name: 'primitives/size-24', variableCollectionId: 'coll-1', resolvedType: 'FLOAT', valuesByMode: { m1: 24 } },
      ],
      collections: [{ id: 'coll-1', name: 'Type', defaultModeId: 'm1', modes: [{ modeId: 'm1', name: 'Mode 1' }] }],
    }, page);

    expect(data.nodes[0]).toMatchObject({ source: 'variable', value: 24 });
  });

  it('reads a size that comes from a text style', async () => {
    const text = makeText('H1', { textStyleId: 'S:abc', fontSize: 32 });
    const { page } = withFrame([text]);

    const { data } = await scan({
      pages: [page],
      stylesById: { 'S:abc': { id: 'S:abc', name: 'Heading/H1' } },
    }, page);

    expect(data.nodes[0]).toMatchObject({ source: 'style', value: 32, tokenName: 'Heading/H1' });
    expect(data.counts.style).toBe(1);
  });

  it('treats a hand-set size as an override', async () => {
    const { page } = withFrame([makeText('Caption', { fontSize: 12 })]);
    const { data } = await scan({ pages: [page] }, page);

    expect(data.nodes[0]).toMatchObject({ source: 'override', value: 12 });
    expect(data.nodes[0].tokenName).toBeUndefined();
    expect(data.counts.override).toBe(1);
  });

  it('falls back to the raw size when the bound variable is gone', async () => {
    const text = makeText('Body', {
      boundVariables: { fontSize: { type: 'VARIABLE_ALIAS', id: 'v-missing' } },
      fontSize: 18,
    });
    const { page } = withFrame([text]);

    const { data } = await scan({ pages: [page] }, page);
    expect(data.nodes[0]).toMatchObject({ source: 'override', value: 18 });
  });

  it('reports no size for text with mixed sizes', async () => {
    const text = makeText('Mixed', { fontSize: 14 });
    const { page } = withFrame([text]);

    const { figma, send, lastOf } = await loadPlugin(ENTRY, { pages: [page] });
    figma.currentPage = page;
    text.fontSize = figma.mixed; // only obtainable after load — the sentinel is per-mock
    await send({ type: 'ready' });

    expect(lastOf('selection').data.nodes[0]).toMatchObject({ source: 'override', value: null });
  });

  it('counts each source separately across many text layers', async () => {
    const { page } = withFrame([
      makeText('A', { boundVariables: { fontSize: { type: 'VARIABLE_ALIAS', id: 'v-fs' } } }),
      makeText('B', { textStyleId: 'S:abc', fontSize: 32 }),
      makeText('C', { fontSize: 12 }),
      makeText('D', { fontSize: 11 }),
    ]);

    const { data } = await scan({
      pages: [page],
      variables: [{ id: 'v-fs', name: 'font/size/body', variableCollectionId: 'coll-1', resolvedType: 'FLOAT', valuesByMode: { m1: 16 } }],
      collections: [{ id: 'coll-1', name: 'Type', defaultModeId: 'm1', modes: [{ modeId: 'm1', name: 'Mode 1' }] }],
      stylesById: { 'S:abc': { id: 'S:abc', name: 'Heading/H1' } },
    }, page);

    expect(data.total).toBe(4);
    expect(data.counts).toEqual({ variable: 1, style: 1, override: 2 });
  });
});
