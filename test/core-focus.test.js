import { describe, it, expect } from 'vitest';
import { focusNode, getPageForNode } from '@rms/core';

// Minimal figma-shaped stub: just what focusNode touches.
function makeFigma(nodesById, currentPage) {
  const zoomed = [];
  const loaded = [];
  const figma = {
    currentPage,
    zoomed,
    loaded,
    async getNodeByIdAsync(id) { return nodesById[id] || null; },
    async setCurrentPageAsync(p) { figma.currentPage = p; },
    viewport: { scrollAndZoomIntoView: (n) => zoomed.push(...n) },
  };
  return figma;
}

const page = (id, extra = {}) => ({ id, type: 'PAGE', selection: [], loadAsync: async function () { this._loaded = true; }, ...extra });
const node = (id, parent) => ({ id, type: 'FRAME', parent });

describe('@rms/core — getPageForNode', () => {
  it('walks up to the PAGE ancestor', () => {
    const p = page('p1');
    const mid = node('mid', p);
    const leaf = node('leaf', mid);
    expect(getPageForNode(leaf)).toBe(p);
  });
  it('returns null when there is no page', () => {
    expect(getPageForNode(node('x', null))).toBeNull();
  });
});

describe('@rms/core — focusNode', () => {
  it('selects the node and zooms to it', async () => {
    const p = page('p1');
    const n = node('n1', p);
    const figma = makeFigma({ n1: n }, p);

    const r = await focusNode(figma, 'n1');

    expect(r).toEqual({ ok: true });
    expect(figma.currentPage.selection).toEqual([n]);
    expect(figma.zoomed).toEqual([n]);
  });

  it('loads the page first when a pageId is given (dynamic-page)', async () => {
    const p = page('p1');
    const n = node('n1', p);
    const figma = makeFigma({ p1: p, n1: n }, p);

    await focusNode(figma, 'n1', 'p1');

    expect(p._loaded).toBe(true);
  });

  it('switches to the page the node lives on', async () => {
    const p1 = page('p1');
    const p2 = page('p2');
    const n = node('n2', p2);
    const figma = makeFigma({ n2: n }, p1);

    await focusNode(figma, 'n2');

    expect(figma.currentPage).toBe(p2);
    expect(p2.selection).toEqual([n]);
  });

  it('reports notFound (never throws) when the node cannot be resolved', async () => {
    const p = page('p1');
    const figma = makeFigma({}, p);

    const r = await focusNode(figma, 'gone');

    expect(r).toEqual({ ok: false, notFound: true });
    expect(figma.zoomed).toEqual([]);
  });

  it('reports the error when a lookup throws', async () => {
    const p = page('p1');
    const figma = makeFigma({}, p);
    figma.getNodeByIdAsync = async () => { throw new Error('boom'); };

    const r = await focusNode(figma, 'n1');

    expect(r.ok).toBe(false);
    expect(r.error.message).toBe('boom');
  });
});
