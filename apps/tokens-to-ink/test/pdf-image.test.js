import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { CompressionStream, DecompressionStream } from 'node:stream/web';
import { loadUI } from '@rms/test-utils';

/** Boot the UI and give it the Web-Streams the browser has but jsdom lacks. */
function bootUI() {
  const u = loadUI(UI);
  u.window.CompressionStream = CompressionStream;
  u.window.DecompressionStream = DecompressionStream;
  return u;
}

const UI = fileURLToPath(new URL('../ui.html', import.meta.url));
// A real single-image frame exported to PDF by Figma: the image is a DCTDecode
// (JPEG) XObject whose /ColorSpace is an INDIRECT ref to [ /ICCBased n 0 R ], with
// a separate DeviceGray /SMask for alpha. This is what broke image rendering:
// the ICC-strip pass rewrote that colour-space object to /DeviceGray.
const FIX = fileURLToPath(new URL('./fixtures/figma-image.pdf', import.meta.url));

let ui;
afterEach(() => { if (ui) { ui.close(); ui = null; } });

const latin1 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return s; };
const pdfBytes = () => new Uint8Array(readFileSync(FIX));

/** Body text of `n 0 obj … endobj`. */
function objBody(s, n) {
  const m = s.match(new RegExp('\\b' + n + ' 0 obj([\\s\\S]*?)endobj'));
  return m ? m[1].trim() : null;
}
/** The image XObject dict(s) in the PDF. */
function imageDicts(s) {
  const out = [];
  const re = /(\d+)\s+0\s+obj([\s\S]*?)stream/g; let m;
  while ((m = re.exec(s)) !== null) if (/\/Subtype\s*\/Image/.test(m[2])) out.push(m[2]);
  return out;
}

describe('tokens-to-ink — CMYK PDF keeps images', () => {
  it('does not clobber an image ICCBased colour space to /DeviceGray', async () => {
    ui = bootUI();
    // No canvas in jsdom → the decoder throws → the image is preserved intact,
    // which is exactly the path that must not corrupt the colour space.
    const out = await ui.window.convertPdfToCmyk(pdfBytes(), {});
    const s = latin1(out);
    // The colour-space object (obj 8 = [ /ICCBased 6 0 R ]) must survive.
    expect(objBody(s, 8)).toMatch(/\/ICCBased\s+6\s+0\s+R/);
    expect(objBody(s, 8)).not.toBe('/DeviceGray');
    // The image XObject is still present and still points at a real colour space.
    const imgs = imageDicts(s);
    expect(imgs.some(d => /\/ColorSpace\s+8\s+0\s+R/.test(d))).toBe(true);
  });

  it('re-encodes a decodable RGB image as a FlateDecode DeviceCMYK image, keeping its SMask', async () => {
    ui = bootUI();
    // Stand in for the browser canvas: hand back opaque mid-grey pixels.
    ui.window.decodeImageToRgba = async (_bytes, w, h) => new Uint8Array(w * h * 4).fill(180);
    const out = await ui.window.convertPdfToCmyk(pdfBytes(), {});
    const s = latin1(out);
    const imgs = imageDicts(s);
    // The main (RGB→CMYK) image is now DeviceCMYK + FlateDecode…
    const cmyk = imgs.find(d => /\/ColorSpace\s*\/DeviceCMYK/.test(d));
    expect(cmyk).toBeTruthy();
    expect(cmyk).toMatch(/\/Filter\s*\/FlateDecode/);
    expect(cmyk).not.toMatch(/DCTDecode/);
    // …and its transparency SMask reference is preserved.
    expect(cmyk).toMatch(/\/SMask\s+\d+\s+0\s+R/);
  });

  it('warns when an image cannot be converted to CMYK (kept as RGB)', async () => {
    ui = bootUI();
    ui.window.downloadFile = () => {};                 // don't touch the filesystem in jsdom
    ui.window.decodeImageToRgba = async () => { throw new Error('no canvas'); }; // force the RGB fallback
    ui.receive({ type: 'export-batch-start', total: 1, format: 'pdf' });
    await ui.receive({
      type: 'export-data', format: 'pdf', pdfBytes: pdfBytes(),
      colorLookup: {}, frameName: 'Artwork', index: 0, total: 1,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(ui.$('#toast-container').textContent).toMatch(/couldn.t be converted to CMYK/i);
  });

  it('does not warn when the image converts cleanly', async () => {
    ui = bootUI();
    ui.window.downloadFile = () => {};
    ui.window.decodeImageToRgba = async (_b, w, h) => new Uint8Array(w * h * 4).fill(180);
    ui.receive({ type: 'export-batch-start', total: 1, format: 'pdf' });
    await ui.receive({
      type: 'export-data', format: 'pdf', pdfBytes: pdfBytes(),
      colorLookup: {}, frameName: 'Artwork', index: 0, total: 1,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(ui.$('#toast-container').textContent).not.toMatch(/couldn.t be converted/i);
  });

  it('leaves the DeviceGray SMask image stream intact (never colour-converted)', async () => {
    ui = bootUI();
    const before = latin1(pdfBytes());
    const out = await ui.window.convertPdfToCmyk(pdfBytes(), {});
    const s = latin1(out);
    // The SMask is a DeviceGray image (obj 4). It must stay DeviceGray and keep its
    // FlateDecode filter — it carries alpha, not colour, and must not be touched.
    const smask = objBody(s, 4);
    expect(smask).toMatch(/\/ColorSpace\s*\/DeviceGray/);
    expect(smask).toMatch(/\/Filter\s*\[\s*\/FlateDecode\s*\]/);
    expect(before).toMatch(/\/SMask\s+4\s+0\s+R/); // sanity: the fixture really has one
  });
});
