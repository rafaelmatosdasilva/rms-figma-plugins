import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadPlugin, makePage, makeNode, makeText } from '@rms/test-utils';

const ENTRY = fileURLToPath(new URL('../src/code.js', import.meta.url));

describe('font-scaling-lab — selection state', () => {
  async function withSelection(nodes) {
    const page = makePage('Page 1');
    for (const n of nodes) page.appendChild(n);
    page.selection = nodes;
    const harness = await loadPlugin(ENTRY, { pages: [page] });
    harness.figma.currentPage = page;
    return { ...harness, page };
  }

  it('reports a single frame as ready to scale', async () => {
    const frame = makeNode('FRAME', { name: 'Card' });
    const { figma, lastOf } = await withSelection([frame]);

    figma.emit('selectionchange');

    expect(lastOf('sel-state')).toMatchObject({ valid: true, nodeId: frame.id, hasLocked: false });
  });

  it('reports an empty selection as not scalable', async () => {
    const { figma, lastOf } = await withSelection([]);
    figma.emit('selectionchange');
    expect(lastOf('sel-state')).toMatchObject({ valid: false, nodeId: null });
  });

  it('reports two selected nodes as not scalable', async () => {
    const { figma, lastOf } = await withSelection([
      makeNode('FRAME', { name: 'A' }), makeNode('FRAME', { name: 'B' }),
    ]);
    figma.emit('selectionchange');
    expect(lastOf('sel-state')).toMatchObject({ valid: false, nodeId: null });
  });

  it('reports a bare text layer as not scalable', async () => {
    const { figma, lastOf } = await withSelection([makeText('Hello', { fontSize: 14 })]);
    figma.emit('selectionchange');
    expect(lastOf('sel-state')).toMatchObject({ valid: false, nodeId: null });
  });

  it('remembers the last previewed frame after the selection is dropped', async () => {
    const frame = makeNode('FRAME', { name: 'Card', width: 320, height: 200 });
    frame.appendChild(makeText('Label', { fontSize: 14 }));
    const { figma, send, lastOf, page } = await withSelection([frame]);

    // A preview locks the node, so the panel can still act on it later.
    await send({ type: 'preview', scale: 1, dpr: 2 });

    page.selection = [];
    figma.emit('selectionchange');

    expect(lastOf('sel-state')).toMatchObject({ valid: false, hasLocked: true });
  });
});

describe('font-scaling-lab — focus node', () => {
  it('selects the node and brings it into view', async () => {
    const target = makeNode('FRAME', { id: 'target', name: 'Target' });
    const page = makePage('Page 1');
    page.appendChild(target);
    const { figma, send } = await loadPlugin(ENTRY, { pages: [page] });
    figma.currentPage = page;

    let zoomed = null;
    figma.viewport.scrollAndZoomIntoView = (nodes) => { zoomed = nodes; };

    await send({ type: 'focus-node', nodeId: 'target' });

    expect(figma.currentPage.selection).toEqual([target]);
    expect(zoomed).toEqual([target]);
  });

  it('switches page when the node lives elsewhere', async () => {
    const here = makeNode('FRAME', { id: 'here', name: 'Here' });
    const there = makeNode('FRAME', { id: 'there', name: 'There' });
    const p1 = makePage('Page 1'); p1.appendChild(here);
    const p2 = makePage('Page 2'); p2.appendChild(there);

    const { figma, send } = await loadPlugin(ENTRY, { pages: [p1, p2] });
    figma.currentPage = p1;

    await send({ type: 'focus-node', nodeId: 'there' });

    expect(figma.currentPage.name).toBe('Page 2');
    expect(figma.currentPage.selection).toEqual([there]);
  });

  it('stays quiet when the node no longer exists', async () => {
    const page = makePage('Page 1');
    const { figma, send, posted } = await loadPlugin(ENTRY, { pages: [page] });
    figma.currentPage = page;
    const before = posted.length;

    await send({ type: 'focus-node', nodeId: 'gone' });

    expect(posted.length).toBe(before);
  });

  it('reports a lookup failure as an error', async () => {
    const page = makePage('Page 1');
    const { figma, send, lastOf } = await loadPlugin(ENTRY, { pages: [page] });
    figma.currentPage = page;
    figma.getNodeByIdAsync = async () => { throw new Error('lookup died'); };

    await send({ type: 'focus-node', nodeId: 'whatever' });

    expect(lastOf('error').message).toContain('lookup died');
  });
});

describe('font-scaling-lab — orphan sweep', () => {
  // Under documentAccess:"dynamic-page" only the current page can be walked, so the
  // sweep runs on the current page at startup and again whenever the page changes.
  it('clears clones on the current page at startup, however deep', async () => {
    const nested = makeNode('FRAME', { name: 'nested orphan' });
    nested.setPluginData('_scoutClone', '1');
    const holder = makeNode('FRAME', { name: 'holder' });
    holder.appendChild(nested);

    // Same key, different value — this one is not a clone and must survive.
    const decoy = makeNode('FRAME', { name: 'decoy' });
    decoy.setPluginData('_scoutClone', '0');

    const p1 = makePage('Page 1'); p1.appendChild(holder); p1.appendChild(decoy);

    await loadPlugin(ENTRY, { pages: [p1] });

    expect(nested.removed).toBe(true);
    expect(holder.children).toEqual([]);
    expect(p1.children).toContain(decoy);
    expect(decoy.removed).toBeFalsy();
  });

  it('sweeps another page only once it becomes current', async () => {
    const onPage2 = makeNode('FRAME', { name: 'page2 orphan' });
    onPage2.setPluginData('_scoutClone', '1');
    const p1 = makePage('Page 1');
    const p2 = makePage('Page 2'); p2.appendChild(onPage2);

    const { figma } = await loadPlugin(ENTRY, { pages: [p1, p2] });

    // Not the current page at startup, so it's left alone (can't walk an unloaded page).
    expect(onPage2.removed).toBeFalsy();

    // Visiting it triggers the sweep.
    figma.currentPage = p2;
    figma.emit('currentpagechange');
    expect(onPage2.removed).toBe(true);
  });
});
