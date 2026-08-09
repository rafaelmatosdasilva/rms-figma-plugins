import { describe, it, expect } from 'vitest';
import { pxToCm, pxToMm, matchPaperSize, effectiveImageDpi, collectImageFills } from '@rms/core';

describe('@rms/core — px → physical', () => {
  it('maps 595 px to A4 width (≈21 cm) at export scale', () => {
    expect(pxToCm(595)).toBeCloseTo(20.99, 2);
    expect(pxToMm(595)).toBeCloseTo(209.9, 1);
  });
  it('maps 842 px to A4 height (≈29.7 cm)', () => {
    expect(pxToCm(842)).toBeCloseTo(29.70, 2);
  });
});

describe('@rms/core — matchPaperSize', () => {
  it('names A4 from a 595×842 px frame (portrait)', () => {
    expect(matchPaperSize(pxToCm(595), pxToCm(842))).toEqual({ name: 'A4', orientation: 'portrait' });
  });
  it('names A4 landscape from an 842×595 px frame', () => {
    expect(matchPaperSize(pxToCm(842), pxToCm(595))).toEqual({ name: 'A4', orientation: 'landscape' });
  });
  it('names A5 from a 420×595 px frame', () => {
    expect(matchPaperSize(pxToCm(420), pxToCm(595)).name).toBe('A5');
  });
  it('falls back to custom for a non-standard size', () => {
    const r = matchPaperSize(pxToCm(500), pxToCm(500));
    expect(r.name).toBe('custom');
  });
  it('absorbs small rounding within tolerance', () => {
    // 209 mm × 298 mm is ~1 mm off A4 — still A4.
    expect(matchPaperSize(20.9, 29.8).name).toBe('A4');
  });
});

describe('@rms/core — effectiveImageDpi', () => {
  it('FILL: 1000px image in a 1000pt box → 72 dpi', () => {
    expect(effectiveImageDpi({ scaleMode: 'FILL' }, 1000, 1000, 1000, 1000)).toEqual({ dpiX: 72, dpiY: 72 });
  });
  it('FILL: an under-resolved image reports below target (cover = limiting axis)', () => {
    // 500px source across a ~4.17in (300pt) box → 500 / 4.17 ≈ 120 dpi.
    const { dpiX } = effectiveImageDpi({ scaleMode: 'FILL' }, 500, 500, 300, 300);
    expect(dpiX).toBeCloseTo(120, 0);
    expect(dpiX).toBeLessThan(300);
  });
  it('FILL cover uses the larger scale factor (lower dpi) on a non-square box', () => {
    // box 400×800 pt, source 400×400 px. cover scale = max(400/400, 800/400)=2 → 36 dpi.
    expect(effectiveImageDpi({ scaleMode: 'FILL' }, 400, 400, 400, 800).dpiX).toBeCloseTo(36, 3);
  });
  it('FIT contain uses the smaller scale factor', () => {
    // box 400×800, source 400×400. fit scale = min(1,2)=1 → 72 dpi.
    expect(effectiveImageDpi({ scaleMode: 'FIT' }, 400, 400, 400, 800).dpiX).toBeCloseTo(72, 3);
  });
  it('CROP: axes can differ (the source of a non-uniform PPI reading)', () => {
    // Show 50% of the width but 100% of the height of a 1000×1000 image in a 500×500pt box.
    const t = [[0.5, 0, 0], [0, 1, 0]];
    const r = effectiveImageDpi({ scaleMode: 'CROP', imageTransform: t }, 1000, 1000, 500, 500);
    expect(r.dpiX).toBeCloseTo(72, 0);   // 500 visible px / (500/72) in
    expect(r.dpiY).toBeCloseTo(144, 0);  // 1000 visible px / (500/72) in
  });
  it('TILE: derived from scalingFactor, null when absent', () => {
    expect(effectiveImageDpi({ scaleMode: 'TILE', scalingFactor: 0.5 }, 100, 100, 100, 100)).toEqual({ dpiX: 144, dpiY: 144 });
    expect(effectiveImageDpi({ scaleMode: 'TILE' }, 100, 100, 100, 100)).toBeNull();
  });
  it('returns null on degenerate input', () => {
    expect(effectiveImageDpi({ scaleMode: 'FILL' }, 0, 100, 100, 100)).toBeNull();
  });
});

describe('@rms/core — collectImageFills', () => {
  const imgFill = (hash, extra = {}) => ({ type: 'IMAGE', imageHash: hash, scaleMode: 'FILL', ...extra });

  it('collects visible IMAGE fills (node box + paint props) and skips everything else', async () => {
    const tree = {
      id: 'root', name: 'Root', width: 100, height: 100,
      children: [
        { id: 'a', name: 'Photo', width: 50, height: 40, fills: [imgFill('h1', { imageTransform: [[1, 0, 0], [0, 1, 0]] })] },
        { id: 'b', name: 'Text', width: 10, height: 10, fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }] },
        { id: 'c', name: 'HiddenNode', visible: false, width: 20, height: 20, fills: [imgFill('h2')] },
        { id: 'd', name: 'HiddenFill', width: 20, height: 20, fills: [imgFill('h3', { visible: false })] },
      ],
    };
    const out = [];
    await collectImageFills(tree, out, () => false);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ nodeId: 'a', name: 'Photo', imageHash: 'h1', boxW: 50, boxH: 40, scaleMode: 'FILL' });
    expect(out[0].imageTransform).toEqual([[1, 0, 0], [0, 1, 0]]);
  });

  it('recurses into nested children', async () => {
    const tree = { id: 'r', name: 'r', width: 1, height: 1, children: [
      { id: 'g', name: 'g', width: 1, height: 1, children: [
        { id: 'deep', name: 'Deep', width: 30, height: 30, fills: [imgFill('hz')] },
      ] },
    ] };
    const out = [];
    await collectImageFills(tree, out, () => false);
    expect(out.map((e) => e.nodeId)).toEqual(['deep']);
  });

  it('honours cancellation before visiting children', async () => {
    const tree = { id: 'r', name: 'r', width: 1, height: 1, children: [
      { id: 'a', name: 'a', width: 10, height: 10, fills: [imgFill('h1')] },
    ] };
    const out = [];
    await collectImageFills(tree, out, () => true);
    expect(out).toHaveLength(0);
  });
});
