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

// Build a tiny valid PDF holding one 8-bit DeviceGray FlateDecode image (the real-world case
// that used to be "left as RGB"). Returns raw bytes; the stream is real zlib so the converter
// inflates it exactly as it would a Figma export.
const enc = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 0xff));
const concatU8 = (chunks) => { const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0)); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } return out; };
async function deflateRaw(u8) {
  const cs = new CompressionStream('deflate');
  const w = cs.writable.getWriter(); w.write(u8); w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}
async function buildGrayPdf(w = 4, h = 4) {
  const gray = new Uint8Array(w * h); for (let i = 0; i < gray.length; i++) gray[i] = (i * 17) & 0xff;
  const zlib = await deflateRaw(gray);
  const content = enc('64 0 0 64 0 0 cm /X1 Do\n');
  return concatU8([
    enc('%PDF-1.7\n'),
    enc('1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n'),
    enc('2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n'),
    enc('3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 64 64] /Resources << /XObject << /X1 4 0 R >> >> /Contents 5 0 R >>endobj\n'),
    enc(`4 0 obj<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${zlib.length} >>stream\n`),
    zlib,
    enc('\nendstream endobj\n'),
    enc(`5 0 obj<< /Length ${content.length} >>stream\n`), content, enc('\nendstream endobj\n'),
    enc('trailer<< /Root 1 0 R /Size 6 >>\nstartxref\n0\n%%EOF'),
  ]);
}

describe('tokens-to-ink — grayscale images convert to CMYK', () => {
  it('re-encodes an 8-bit DeviceGray FlateDecode image as DeviceCMYK (was left as RGB)', async () => {
    ui = bootUI();
    const out = latin1(await ui.window.convertPdfToCmyk(await buildGrayPdf(), {}));
    const img = imageDicts(out).find((d) => /\/Width\s+4\b/.test(d));
    expect(img).toBeTruthy();
    expect(img).toMatch(/\/ColorSpace\s*\/DeviceCMYK/);   // gray → CMYK, not left as gray/RGB
    expect(img).toMatch(/\/Filter\s*\/FlateDecode/);
    // Nothing was left un-converted.
    expect(ui.window._lastPdfImageFailures || []).toHaveLength(0);
  });
});

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

  it('confirms a clean export with a success toast — after the save dialog closes, not before', async () => {
    ui = bootUI();
    ui.window.downloadFile = () => {};                 // download path (no FSA in jsdom)
    ui.window.decodeImageToRgba = async (_b, w, h) => new Uint8Array(w * h * 4).fill(180);
    ui.receive({ type: 'export-batch-start', total: 1, format: 'pdf' });
    await ui.receive({
      type: 'export-data', format: 'pdf', pdfBytes: pdfBytes(),
      colorLookup: {}, frameName: 'Art', index: 0, total: 1,
    });
    await new Promise((r) => setTimeout(r, 50));
    // The save dialog is open (window blurred) → nothing saved yet, so NO confirmation.
    ui.window.dispatchEvent(new ui.window.Event('blur'));
    expect(ui.$('#toast-container').textContent).not.toMatch(/exported/i);
    // The dialog closes → the window regains focus → after a short beat the toast appears
    // (delayed so its slide-in animation plays on a fresh paint, not behind the dialog).
    ui.window.dispatchEvent(new ui.window.Event('focus'));
    expect(ui.$('#toast-container').textContent).not.toMatch(/artwork exported/i);   // not immediate
    await new Promise((r) => setTimeout(r, 500));
    expect(ui.$('#toast-container').textContent).toMatch(/artwork exported successfully/i);
    // It uses the DS success toast, which animates in and auto-dismisses (animates out).
    expect(ui.$('#toast-container .toast')).toBeTruthy();
  });

  // The fixture's image (obj 9) is 24×24 px placed over the full 64pt frame
  // (content stream: `64 0 0 64 … cm /X1 Do`) → ~27 DPI on the page.
  const cmykImageDims = (s) => {
    const d = imageDicts(s).find((x) => /\/ColorSpace\s*\/DeviceCMYK/.test(x));
    if (!d) return null;
    const w = d.match(/\/Width\s+(\d+)/), h = d.match(/\/Height\s+(\d+)/);
    return { w: w && +w[1], h: h && +h[1] };
  };

  it('downsamples an image whose on-page DPI exceeds the target', async () => {
    ui = bootUI();
    ui.window.decodeImageToRgba = async (_b, w, h) => new Uint8Array(w * h * 4).fill(180);
    // 64pt frame at 12 DPI → 64/72*12 ≈ 10.7 → 11 px, below the source's 24 px.
    const out = await ui.window.convertPdfToCmyk(pdfBytes(), {}, { downsample: true, downsampleDpi: 12 });
    const s = latin1(out);
    const dims = cmykImageDims(s);
    expect(dims).toBeTruthy();
    expect(dims.w).toBe(11);
    expect(dims.h).toBe(11);
    // The soft-mask image (obj 4) must be resized in lockstep — a base/mask size
    // mismatch makes Illustrator mis-scale the mask and drop or shift the image.
    const smask = objBody(s, 4);
    expect(smask).toMatch(/\/Width\s+11\b/);
    expect(smask).toMatch(/\/Height\s+11\b/);
    expect(smask).toMatch(/\/ColorSpace\s*\/DeviceGray/);  // still a grey mask
  });

  it('never upsamples: a target DPI above the source resolution leaves it unchanged', async () => {
    ui = bootUI();
    ui.window.decodeImageToRgba = async (_b, w, h) => new Uint8Array(w * h * 4).fill(180);
    // 64pt frame at 300 DPI → ~267 px target, far above the source's 24 px.
    const out = await ui.window.convertPdfToCmyk(pdfBytes(), {}, { downsample: true, downsampleDpi: 300 });
    expect(cmykImageDims(latin1(out))).toEqual({ w: 24, h: 24 });
  });

  it('leaves image dimensions untouched when downsampling is off', async () => {
    ui = bootUI();
    ui.window.decodeImageToRgba = async (_b, w, h) => new Uint8Array(w * h * 4).fill(180);
    const out = await ui.window.convertPdfToCmyk(pdfBytes(), {}, { downsample: false, downsampleDpi: 12 });
    expect(cmykImageDims(latin1(out))).toEqual({ w: 24, h: 24 });
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
