import { describe, it, expect } from 'vitest';
import { attachWindowResize } from '@rms/core';

function fakeFigma(saved) {
  const store = { windowSize: saved };
  const resized = [];
  const figma = {
    clientStorage: { getAsync: async (k) => store[k], setAsync: async (k, v) => { store[k] = v; } },
    ui: { resize: (w, h) => resized.push({ w, h }) },
  };
  return { figma, store, resized };
}
const flush = () => new Promise((r) => setTimeout(r, 0));   // let the startup getAsync().then run

describe('attachWindowResize — autoHeight (UI drives height)', () => {
  it('restores width only and never re-applies a saved height', async () => {
    const f = fakeFigma({ w: 800, h: 1900 });
    const handle = attachWindowResize(f.figma, { defaultW: 600, defaultH: 220, minW: 320, minH: 200, autoHeight: true });
    await flush();
    expect(f.resized.pop()).toEqual({ w: 800, h: 220 });   // saved width kept; saved 1900 ignored

    await handle({ type: 'ui-resize', width: 800, height: 260 });   // UI content-fit drives height
    expect(f.resized.pop()).toEqual({ w: 800, h: 260 });

    await handle({ type: 'save-size', width: 820, height: 999 });   // persists width ONLY
    expect(f.store.windowSize).toEqual({ w: 820 });
  });

  it('default (no autoHeight) still restores and persists both dimensions', async () => {
    const f = fakeFigma({ w: 800, h: 700 });
    const handle = attachWindowResize(f.figma, { defaultW: 600, defaultH: 500, minW: 320, minH: 200 });
    await flush();
    expect(f.resized.pop()).toEqual({ w: 800, h: 700 });

    await handle({ type: 'save-size', width: 820, height: 640 });
    expect(f.store.windowSize).toEqual({ w: 820, h: 640 });
  });
});
