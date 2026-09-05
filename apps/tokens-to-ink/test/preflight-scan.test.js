import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadPlugin, makePage, makeNode } from '@rms/test-utils';

const ENTRY = fileURLToPath(new URL('../src/code.js', import.meta.url));

const imageFill = (hash, extra = {}) => ({ type: 'IMAGE', imageHash: hash, scaleMode: 'FILL', ...extra });

/**
 * An A4 frame (595×842 px) holding two image rectangles:
 *  - Photo: 800×540 px source placed across 595×400 pt → ~97 dpi (below 300).
 *  - Sharp: 2000×2000 px source in a 100×100 pt box → ~1440 dpi (well above 300).
 */
function scene() {
  const photo = makeNode('RECTANGLE', { id: 'photo', name: 'Photo', width: 595, height: 400, fills: [imageFill('img-low')] });
  const sharp = makeNode('RECTANGLE', { id: 'sharp', name: 'Sharp', width: 100, height: 100, fills: [imageFill('img-high')] });
  const frame = makeNode('FRAME', { id: 'flyer', name: 'Flyer', width: 595, height: 842 });
  frame.appendChild(photo);
  frame.appendChild(sharp);

  const page = makePage('Page 1');
  page.appendChild(frame);
  page.selection = [frame];

  return {
    pages: [page],
    images: { 'img-low': { width: 800, height: 540 }, 'img-high': { width: 2000, height: 2000 } },
  };
}

describe('tokens-to-ink — preflight scan (code.js)', () => {
  it('reports only the images below the target dpi', async () => {
    const { send, lastOf } = await loadPlugin(ENTRY, scene());
    await send({ type: 'preflight-request', dpi: 300, scanImages: true });

    const imgs = lastOf('preflight-images');
    expect(imgs.target).toBe(300);
    expect(imgs.images).toHaveLength(1);
    expect(imgs.images[0]).toMatchObject({ id: 'photo', name: 'Photo' });
    expect(imgs.images[0].meta).toMatch(/800×540 px · \d+ dpi/);
    expect(imgs.images.some((i) => i.id === 'sharp')).toBe(false);
  });

  it('flags nothing when the target is low enough that both images clear it', async () => {
    const { send, lastOf } = await loadPlugin(ENTRY, scene());
    await send({ type: 'preflight-request', dpi: 72, scanImages: true });
    expect(lastOf('preflight-images').images).toEqual([]);
  });

  it('flags only a CMYK JPEG — RGB JPEG, PNG and GIF are re-encoded to RGB by Figma', async () => {
    // Minimal format headers the sniffer reads: a JPEG SOF marker carrying the component count,
    // a PNG signature, and a GIF signature (which Figma rasterises to RGB, so NOT flagged).
    const jpegSOF = (comps) => Uint8Array.from([0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x10, comps]);
    const png = Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    const mk = (id, hash) => makeNode('RECTANGLE', { id, name: id, width: 100, height: 100, fills: [imageFill(hash)] });
    const frame = makeNode('FRAME', { id: 'f', name: 'Art', width: 400, height: 400 });
    ['cmyk', 'rgb', 'png', 'gif'].forEach((k) => frame.appendChild(mk(k, `h-${k}`)));
    const page = makePage('Page 1');
    page.appendChild(frame);
    page.selection = [frame];

    const images = {
      'h-cmyk': { width: 100, height: 100, bytes: jpegSOF(4) },   // 4 components = CMYK → flagged
      'h-rgb': { width: 100, height: 100, bytes: jpegSOF(3) },    // 3 components = RGB → fine
      'h-png': { width: 100, height: 100, bytes: png },          // PNG → Figma re-encodes to RGB → fine
      'h-gif': { width: 100, height: 100, bytes: gif },          // GIF → rasterised to RGB → fine
    };
    const { send, lastOf } = await loadPlugin(ENTRY, { pages: [page], images });
    // scanCmyk gates the byte-reading CMYK sniff — the "stays RGB" list only runs when the user
    // opted into CMYK conversion; scanImages stays off (this test is about format, not DPI).
    await send({ type: 'preflight-request', dpi: 300, scanImages: false, scanCmyk: true });

    const msg = lastOf('preflight-images');
    const byId = Object.fromEntries((msg.unconvertible || []).map((u) => [u.id, u.meta]));
    expect(Object.keys(byId)).toEqual(['cmyk']);
    expect(byId.cmyk).toBe('CMYK JPEG');
  });

  it('skips the (costly) CMYK byte-scan when scanCmyk is off — no bytes read, no list', async () => {
    // Perf gate: reading every image's bytes (getBytesAsync) must not run when the "stays RGB" list
    // is not shown. With scanCmyk off, a CMYK JPEG is NOT flagged (and no bytes are read).
    const jpegSOF = (comps) => Uint8Array.from([0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x10, comps]);
    const rect = makeNode('RECTANGLE', { id: 'cmyk', name: 'cmyk', width: 100, height: 100, fills: [imageFill('h-cmyk')] });
    const frame = makeNode('FRAME', { id: 'f', name: 'Art', width: 400, height: 400 });
    frame.appendChild(rect);
    const page = makePage('Page 1'); page.appendChild(frame); page.selection = [frame];
    const images = { 'h-cmyk': { width: 100, height: 100, bytes: jpegSOF(4) } };
    const { send, lastOf } = await loadPlugin(ENTRY, { pages: [page], images });
    await send({ type: 'preflight-request', dpi: 300, scanImages: false /* scanCmyk omitted → off */ });
    // The CMYK JPEG is NOT flagged because the sniff is gated off — the list stays empty.
    expect((lastOf('preflight-images').unconvertible || [])).toHaveLength(0);
  });

  it('answers hasImages immediately (a preflight-selection message) before the slower scans', async () => {
    const { send, postedOf } = await loadPlugin(ENTRY, scene());
    await send({ type: 'preflight-request', dpi: 300, scanImages: true });
    const sel = postedOf('preflight-selection');
    expect(sel.length).toBeGreaterThan(0);
    expect(sel.pop()).toMatchObject({ hasImages: true });
  });

  it('reports hasImages but skips the (costly) size scan when scanImages is false', async () => {
    // The UI still needs to know whether the selection has images (to reveal the Image-quality
    // tab) even when downsampling is off — so hasImages is always reported, but the per-image
    // resolution scan is skipped and the low-res list comes back empty.
    const { send, figma, lastOf } = await loadPlugin(ENTRY, scene());
    let sizeCalls = 0;
    const realGet = figma.getImageByHash;
    figma.getImageByHash = (h) => {
      const img = realGet(h);
      if (!img) return null;
      const realSize = img.getSizeAsync;
      img.getSizeAsync = async () => { sizeCalls += 1; return realSize.call(img); };
      return img;
    };
    await send({ type: 'preflight-request', dpi: 300, scanImages: false });
    const msg = lastOf('preflight-images');
    expect(msg.hasImages).toBe(true);   // the scene has images…
    expect(msg.images).toEqual([]);     // …but none were sized/flagged
    expect(sizeCalls).toBe(0);          // the expensive decode was skipped
  });

  it('raising the target flags more images (both, at 2000 dpi)', async () => {
    const { send, lastOf } = await loadPlugin(ENTRY, scene());
    await send({ type: 'preflight-request', dpi: 2000, scanImages: true });
    expect(lastOf('preflight-images').images.map((i) => i.id).sort()).toEqual(['photo', 'sharp']);
  });

  it('accounts for ancestor scale — a low-res image inside a scaled group is flagged', async () => {
    const nested = makeNode('RECTANGLE', {
      id: 'nested', name: 'Nested photo', width: 100, height: 100,
      absoluteTransform: [[2, 0, 0], [0, 2, 0]],
      fills: [imageFill('img-nested')],
    });
    const frame = makeNode('FRAME', { id: 'root', name: 'Poster', width: 595, height: 842 });
    frame.appendChild(nested);
    const page = makePage('Page 1');
    page.appendChild(frame);
    page.selection = [frame];

    const { send, lastOf } = await loadPlugin(ENTRY, {
      pages: [page], images: { 'img-nested': { width: 500, height: 500 } },
    });
    await send({ type: 'preflight-request', dpi: 300, scanImages: true });
    expect(lastOf('preflight-images').images.map((i) => i.id)).toContain('nested');
  });

  it('decodes images in a bounded pool — never all at once (memory-crash guard)', async () => {
    // A selection with many distinct images. getSizeAsync forces Figma to load each bitmap;
    // firing them all at once spiked file memory enough to crash Figma. Sizes must resolve
    // through a small pool, so peak in-flight decodes stays capped no matter the image count.
    const N = 40;
    const frame = makeNode('FRAME', { id: 'wall', name: 'Photo wall', width: 2000, height: 2000 });
    const images = {};
    for (let i = 0; i < N; i++) {
      images[`img-${i}`] = { width: 800, height: 800 };   // low-res in an A4 box → all flagged below 300 dpi
      frame.appendChild(makeNode('RECTANGLE', {
        id: `r${i}`, name: `Photo ${i}`, width: 595, height: 842, fills: [imageFill(`img-${i}`)],
      }));
    }
    const page = makePage('Page 1');
    page.appendChild(frame);
    page.selection = [frame];

    const { send, figma, lastOf } = await loadPlugin(ENTRY, { pages: [page], images });

    let inFlight = 0, peak = 0;
    const realGet = figma.getImageByHash;
    figma.getImageByHash = (h) => {
      const img = realGet(h);
      if (!img) return null;
      const realSize = img.getSizeAsync;
      img.getSizeAsync = async () => {
        inFlight += 1; peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));   // hold the "decode" open so overlap is visible
        inFlight -= 1;
        return realSize.call(img);
      };
      return img;
    };

    await send({ type: 'preflight-request', dpi: 300, scanImages: true });

    expect(lastOf('preflight-images').images).toHaveLength(N);   // all decoded, none dropped
    expect(peak).toBeGreaterThan(1);    // still concurrent (not serialised)
    expect(peak).toBeLessThanOrEqual(4);   // …but capped at the pool size
  });

  it('reuses the walked image-fill list across repeat preflights on the same selection (no re-walk on a tab switch)', async () => {
    // Colors<->Export switches fire a fresh preflight-request each time. The tree walk that finds
    // image fills is pure structure (no bitmap loads) but scales with node count — on a big image
    // frame it was the per-switch lag. It must run once per selection, then be reused.
    const { send, figma, lastOf } = await loadPlugin(ENTRY, scene());
    const frame = figma.currentPage.selection[0];
    const photo = frame.children.find((c) => c.id === 'photo');
    let fillReads = 0;
    const realFills = photo.fills;
    Object.defineProperty(photo, 'fills', { configurable: true, get() { fillReads += 1; return realFills; } });

    await send({ type: 'preflight-request', dpi: 300, scanImages: true });
    const afterFirst = fillReads;
    expect(afterFirst).toBeGreaterThan(0);   // the first switch walks the tree

    // A second preflight on the SAME selection (another tab switch) must NOT re-walk.
    await send({ type: 'preflight-request', dpi: 150, scanImages: true });
    expect(fillReads).toBe(afterFirst);
    expect(lastOf('preflight-images')).toBeTruthy();
  });

  it('reuses the cached bitmap size on a re-scan (no second getSizeAsync)', async () => {
    const { send, figma, lastOf } = await loadPlugin(ENTRY, scene());
    let sizeCalls = 0;
    const realGet = figma.getImageByHash;
    figma.getImageByHash = (h) => {
      const img = realGet(h);
      if (!img) return null;
      const realSize = img.getSizeAsync;
      img.getSizeAsync = async () => { sizeCalls += 1; return realSize.call(img); };
      return img;
    };
    await send({ type: 'preflight-request', dpi: 300, scanImages: true });
    const first = sizeCalls;
    expect(first).toBeGreaterThan(0);
    // Re-scan at a different dpi — sizes are cached, so no new getSizeAsync calls.
    await send({ type: 'preflight-request', dpi: 150, scanImages: true });
    expect(sizeCalls).toBe(first);
    expect(lastOf('preflight-images')).toBeTruthy();
  });
});
