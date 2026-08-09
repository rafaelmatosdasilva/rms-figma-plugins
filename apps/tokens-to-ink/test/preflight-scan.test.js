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

  it('does nothing when scanImages is false', async () => {
    const { send, postedOf } = await loadPlugin(ENTRY, scene());
    await send({ type: 'preflight-request', dpi: 300, scanImages: false });
    expect(postedOf('preflight-images')).toHaveLength(0);
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
