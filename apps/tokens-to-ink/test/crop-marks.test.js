import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { CompressionStream, DecompressionStream } from 'node:stream/web';
import { loadUI } from '@rms/test-utils';

const UI = fileURLToPath(new URL('../ui.html', import.meta.url));
// A real Figma export whose single page MediaBox is [ 0 0 64 64 ].
const FIX = fileURLToPath(new URL('./fixtures/figma-image.pdf', import.meta.url));

let ui;
afterEach(() => { if (ui) { ui.close(); ui = null; } });

function bootUI() {
  const u = loadUI(UI);
  u.window.CompressionStream = CompressionStream;
  u.window.DecompressionStream = DecompressionStream;
  return u;
}
const latin1 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return s; };
const pdfBytes = () => new Uint8Array(readFileSync(FIX));
const mediaBox = (s) => s.match(/\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/);

describe('tokens-to-ink — crop marks', () => {
  it('adds crop marks, TrimBox/BleedBox, and grows the MediaBox outward', async () => {
    ui = bootUI();
    const out = latin1(await ui.window.convertPdfToCmyk(pdfBytes(), {}, { cropMarks: true, bleedPt: 8.5 }));
    const mb = mediaBox(out);
    expect(mb).toBeTruthy();
    expect(parseFloat(mb[1])).toBeLessThan(0);       // origin pushed negative (bleed + marks)
    expect(parseFloat(mb[2])).toBeLessThan(0);
    expect(parseFloat(mb[3])).toBeGreaterThan(64);   // extends past the trim on the far side
    expect(parseFloat(mb[4])).toBeGreaterThan(64);
    // Trim = the original frame box; bleed declared too.
    expect(out).toMatch(/\/TrimBox\s*\[\s*0\s+0\s+64\s+64\s*\]/);
    expect(out).toMatch(/\/BleedBox/);
    // Marks are stroked in registration colour (all four plates), as clean DeviceCMYK.
    expect(out).toMatch(/1 1 1 1 K/);
    expect(out).toMatch(/\bS Q/);
  });

  it('places marks at the frame trim box, not the (larger) page box', async () => {
    ui = bootUI();
    // Simulate a frame (trim) sitting inside content that overflows the page box.
    const trimBox = { x0: 10, y0: 10, x1: 54, y1: 54 };
    const out = latin1(await ui.window.convertPdfToCmyk(pdfBytes(), {}, { cropMarks: true, bleedPt: 8.5, trimBox }));
    // TrimBox follows the frame, not the [0 0 64 64] page box.
    expect(out).toMatch(/\/TrimBox\s*\[\s*10\s+10\s+54\s+54\s*\]/);
    expect(out).toMatch(/\/BleedBox\s*\[\s*1\.5\s+1\.5\s+62\.5\s+62\.5\s*\]/);
    // A crop line starts one bleed (8.5pt) left of the trim corner (x=1.5), at y=10 —
    // i.e. at the frame edge, not the page edge.
    expect(out).toMatch(/1\.5 10 m/);
    // Content is clipped to the bleed box — the frame (44×44 at 10,10) grown by one bleed
    // on every side: origin (1.5,1.5), 44 + 2·8.5 = 61 wide/tall. Overflow past it is dropped.
    expect(out).toMatch(/1\.5 1\.5 61 61 re\s+W\s+n/);
  });

  it('with no bleed, clips to the frame bounding box (not the overflowing artwork)', async () => {
    ui = bootUI();
    const trimBox = { x0: 10, y0: 10, x1: 54, y1: 54 };
    const out = latin1(await ui.window.convertPdfToCmyk(pdfBytes(), {}, { cropMarks: true, bleedPt: 0, trimBox }));
    // Clip = the frame trim box exactly (44×44 at 10,10): no bleed → no extra artwork.
    expect(out).toMatch(/10 10 44 44 re\s+W\s+n/);
  });

  it('bleeds the artwork past the trim by exactly the bleed amount', async () => {
    ui = bootUI();
    const trimBox = { x0: 10, y0: 10, x1: 54, y1: 54 };
    const out = latin1(await ui.window.convertPdfToCmyk(pdfBytes(), {}, { cropMarks: false, bleedPt: 6, trimBox }));
    // Clip grows the frame box by 6pt on each side: origin (4,4), 44 + 12 = 56 wide/tall.
    expect(out).toMatch(/4 4 56 56 re\s+W\s+n/);
  });

  it('applies bleed independently of crop marks (BleedBox + page growth, no mark lines)', async () => {
    ui = bootUI();
    const out = latin1(await ui.window.convertPdfToCmyk(pdfBytes(), {}, { cropMarks: false, bleedPt: 8.5 }));
    expect(out).toMatch(/\/BleedBox/);               // bleed area is declared…
    expect(out).toMatch(/\/TrimBox/);
    expect(parseFloat(mediaBox(out)[1])).toBeLessThan(0); // …the page grew by the bleed…
    expect(out).not.toMatch(/1 1 1 1 K/);            // …but NO crop-mark lines were drawn.
  });

  it('adds registration targets (circle + crosshair) centred on each side, in registration colour', async () => {
    ui = bootUI();
    // No bleed, no crop marks — registration only. Fixture trim is [0 0 64 64].
    const out = latin1(await ui.window.convertPdfToCmyk(pdfBytes(), {}, { regMarks: true, bleedPt: 0 }));
    // The page grows to make room for the targets (REG_OFF 11 + crosshair 9 = 20 each side).
    const mb = mediaBox(out);
    expect(parseFloat(mb[1])).toBeLessThan(0);
    expect(parseFloat(mb[3])).toBeGreaterThan(64);
    // Registration colour (all four plates).
    expect(out).toMatch(/1 1 1 1 K/);
    // Top target centred at (32, 77): the circle path starts at (36,77), draws a bézier arc…
    expect(out).toMatch(/36 77 m/);
    expect(out).toMatch(/36 79\.209 34\.209 81 32 81 c/);
    // …with a long crosshair through the centre (InDesign style: reaches well past the circle).
    expect(out).toMatch(/19 77 m 45 77 l/);
  });

  it('draws crop marks (lines) and registration marks (curves) together', async () => {
    ui = bootUI();
    const out = latin1(await ui.window.convertPdfToCmyk(pdfBytes(), {}, { cropMarks: true, regMarks: true, bleedPt: 0 }));
    expect(out).toMatch(/36 79\.209 34\.209 81 32 81 c/);   // registration circle curve
    expect(out).toMatch(/0 0 m 0 -18 l/);                   // a crop corner line below the BL corner
    expect(out).toMatch(/1 1 1 1 K/);
  });

  it('prints page information (file name + timestamp) with a Helvetica font in the slug', async () => {
    ui = bootUI();
    const out = latin1(await ui.window.convertPdfToCmyk(pdfBytes(), {}, {
      pageInfo: true, bleedPt: 0,
      pageInfoLeft: 'My Catalog  ·  Sapphire Mini', pageInfoRight: '09/08/2026 10:01',
    }));
    // A standard Helvetica font is declared and registered in the page resources as /HB.
    expect(out).toMatch(/\/BaseFont\s*\/Helvetica/);
    expect(out).toMatch(/\/Font\s*<<\s*\/HB\s+\d+\s+0\s+R/);
    // The text is drawn (BT … Tj … ET) at 11pt in registration colour.
    expect(out).toMatch(/BT[\s\S]*\/HB 11 Tf/);
    expect(out).toMatch(/\(My Catalog  ·  Sapphire Mini\)\s*Tj/);
    expect(out).toMatch(/\(09\/08\/2026 10:01\)\s*Tj/);
    // The page grew DOWNWARD (bottom edge only) to make the slug band.
    expect(parseFloat(mediaBox(out)[2])).toBeLessThan(0);   // y0 pushed below 0
    expect(parseFloat(mediaBox(out)[4])).toBe(64);          // top (y1) unchanged
  });

  it('prints file information within the bottom mark band — no page growth when marks are present', async () => {
    ui = bootUI();
    const marks = { cropMarks: true, regMarks: true, bleedPt: 0 };
    const without = latin1(await ui.window.convertPdfToCmyk(pdfBytes(), {}, marks));
    const withInfo = latin1(await ui.window.convertPdfToCmyk(pdfBytes(), {}, {
      ...marks, pageInfo: true, pageInfoLeft: 'Doc', pageInfoRight: '10:00',
    }));
    const box = (s) => mediaBox(s).slice(1, 5).map(Number);   // [x0, y0, x1, y1]
    // The file info fits between the corner crop marks and the centred registration target, so
    // the MediaBox is identical with and without it — the marks' margin already holds the text.
    expect(box(withInfo)).toEqual(box(without));
    expect(withInfo).toMatch(/\/HB 11 Tf/);                   // 11pt text
  });

  it('escapes parentheses in page-info text so the PDF string stays valid', async () => {
    ui = bootUI();
    const out = latin1(await ui.window.convertPdfToCmyk(pdfBytes(), {}, {
      pageInfo: true, bleedPt: 0, pageInfoLeft: 'File (v2)', pageInfoRight: '',
    }));
    expect(out).toMatch(/\(File \\\(v2\\\)\)\s*Tj/);
  });

  it('draws colour bars (CMYK swatches + a grayscale wedge) in the top slug, growing only the top', async () => {
    ui = bootUI();
    // A trim wide enough to hold both strips (2×99 + 60). Sits inside a larger page box.
    const trimBox = { x0: 0, y0: 0, x1: 300, y1: 200 };
    const out = latin1(await ui.window.convertPdfToCmyk(pdfBytes(), {}, { colorBars: true, bleedPt: 0, trimBox }));
    // Solid process colours as flat DeviceCMYK fills: cyan (1 0 0 0), magenta, yellow, and K.
    expect(out).toMatch(/1 0 0 0 k/);          // cyan swatch
    expect(out).toMatch(/0 1 0 0 k/);          // magenta swatch
    expect(out).toMatch(/0 0 1 0 k/);          // yellow swatch
    expect(out).toMatch(/0 0 0 1 k/);          // solid black swatch
    expect(out).toMatch(/0 0 0 0\.5 k/);       // a 50% grey tint from the wedge
    expect(out).toMatch(/\bre f\b/);           // swatches are filled rectangles
    // The colour bars live in the TOP slug — the top grows, the trim is unchanged.
    const mb = mediaBox(out);
    expect(parseFloat(mb[4])).toBeGreaterThan(200);   // y1 (top) extended for the bars
    expect(parseFloat(mb[2])).toBe(0);                // y0 (bottom) untouched (no bottom marks)
  });

  it('skips colour bars on a frame too narrow to hold them', async () => {
    ui = bootUI();
    // The fixture trim is only 64pt wide — far below 2×99+60, so the bars are omitted.
    const out = latin1(await ui.window.convertPdfToCmyk(pdfBytes(), {}, { colorBars: true, bleedPt: 0 }));
    expect(out).not.toMatch(/1 0 0 0 k/);
  });

  it('leaves the page untouched when both crop marks and bleed are off', async () => {
    ui = bootUI();
    const out = latin1(await ui.window.convertPdfToCmyk(pdfBytes(), {}, { cropMarks: false }));
    const mb = mediaBox(out);
    expect(mb).toBeTruthy();
    expect(parseFloat(mb[1])).toBe(0);               // MediaBox unchanged
    expect(parseFloat(mb[3])).toBe(64);
    expect(out).not.toMatch(/\/TrimBox/);
    expect(out).not.toMatch(/1 1 1 1 K/);
  });

  it('defaults to no marks when no options are passed (back-compat)', async () => {
    ui = bootUI();
    const out = latin1(await ui.window.convertPdfToCmyk(pdfBytes(), {}));
    expect(out).not.toMatch(/\/TrimBox/);
  });
});
