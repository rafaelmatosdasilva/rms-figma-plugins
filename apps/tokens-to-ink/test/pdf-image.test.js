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

describe('tokens-to-ink — photos stay in their original colour space (never CMYK)', () => {
  it('leaves an 8-bit DeviceGray image untouched — never converts it to CMYK', async () => {
    ui = bootUI();
    // Photos are deliberately kept in RGB/Gray: a textbook RGB→CMYK warms reds to orange and
    // was inconsistent. With no downsampling, the image must be left byte-for-byte in its space.
    const out = latin1(await ui.window.convertPdfToCmyk(await buildGrayPdf(), {}));
    const img = imageDicts(out).find((d) => /\/Width\s+4\b/.test(d));
    expect(img).toBeTruthy();
    expect(img).toMatch(/\/ColorSpace\s*\/DeviceGray/);   // stays grey — NOT CMYK
    expect(img).not.toMatch(/DeviceCMYK/);
  });
});

describe('tokens-to-ink — "Convert images to CMYK" toggle (opt-in)', () => {
  it('converts an image to DeviceCMYK when imagesCmyk is on', async () => {
    ui = bootUI();
    const out = latin1(await ui.window.convertPdfToCmyk(await buildGrayPdf(), {}, { imagesCmyk: true }));
    const img = imageDicts(out).find((d) => /\/Width\s+4\b/.test(d));
    expect(img).toBeTruthy();
    expect(img).toMatch(/\/ColorSpace\s*\/DeviceCMYK/);   // opt-in → converted
    expect(img).toMatch(/\/Filter\s*\/FlateDecode/);
  });

  it('reports images that could not be converted (kept as RGB) only in CMYK mode', async () => {
    ui = bootUI();
    ui.window.decodeImageToRgba = async () => { throw new Error('no canvas'); }; // force decode failure
    const out = latin1(await ui.window.convertPdfToCmyk(pdfBytes(), {}, { imagesCmyk: true }));
    // The photo (DCTDecode) couldn't decode, so it stays RGB and is counted for the warning.
    expect(ui.window._lastPdfImagesUnconverted).toBeGreaterThan(0);
    const main = imageDicts(out).find((d) => /\/ColorSpace\s+8\s+0\s+R/.test(d));
    expect(main).toBeTruthy();                            // left in its ICCBased RGB space
    expect(main).not.toMatch(/DeviceCMYK/);
  });

  it('leaves images in RGB and reports none when imagesCmyk is off (default)', async () => {
    ui = bootUI();
    ui.window.decodeImageToRgba = async () => { throw new Error('no canvas'); };
    await ui.window.convertPdfToCmyk(pdfBytes(), {});     // default: RGB
    expect(ui.window._lastPdfImagesUnconverted).toBe(0);
  });
});

describe('tokens-to-ink — downsample resampling (area-average)', () => {
  it('resizeRgbaBox averages a 2×2 checkerboard to mid-grey (not one nearest corner)', () => {
    ui = bootUI();
    // Opaque black/white checkerboard: BL/TR black, BR/TL white → 1×1 average = 128s.
    const src = new Uint8Array([
      255,255,255,255, /**/ 0,0,0,255,
      0,0,0,255,       /**/ 255,255,255,255,
    ]);
    const out = ui.window.resizeRgbaBox(src, 2, 2, 1, 1);
    expect([...out]).toEqual([128, 128, 128, 255]);   // averaged — nearest would give 0 or 255
  });

  it('resizeGrayBox averages a single-channel buffer', () => {
    ui = bootUI();
    const out = ui.window.resizeGrayBox(new Uint8Array([0, 255, 255, 0]), 2, 2, 1, 1);
    expect([...out]).toEqual([128]);
  });

  it('resizeRgbaBox preserves dimensions and downscales cleanly to a smaller grid', () => {
    ui = bootUI();
    const src = new Uint8Array(4 * 4 * 4).fill(200);   // flat colour
    const out = ui.window.resizeRgbaBox(src, 4, 4, 2, 2);
    expect(out.length).toBe(2 * 2 * 4);
    expect([...out]).toEqual(new Array(16).fill(200));  // flat stays flat
  });
});

// A tiny valid PDF with one solid vector fill (0.2 0.4 0.6 rg → #336699) and an indirect,
// empty-ish /Resources object (5 0 obj) so spot injection has somewhere to write /ColorSpace.
function buildVectorPdf() {
  const content = enc('0.2 0.4 0.6 rg 0 0 10 10 re f\n');
  return concatU8([
    enc('%PDF-1.7\n'),
    enc('1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n'),
    enc('2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n'),
    enc('3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 64 64] /Resources 5 0 R /Contents 4 0 R >>endobj\n'),
    enc(`4 0 obj<< /Length ${content.length} >>stream\n`), content, enc('\nendstream endobj\n'),
    enc('5 0 obj<< /ProcSet [ /PDF ] >>endobj\n'),
    enc('trailer<< /Root 1 0 R /Size 6 >>\nstartxref\n0\n%%EOF'),
  ]);
}

describe('tokens-to-ink — downsample keeps base image and its soft-mask in sync', () => {
  it('does not shrink the SMask when the base fails to decode (image would otherwise vanish)', async () => {
    ui = bootUI();
    // Base is a DCTDecode image whose decode fails (stub) — e.g. a CMYK JPEG. Its SMask is a
    // decodable DeviceGray/Flate. The old order resized the mask first, then the base decode
    // failed, leaving a 10px mask against a 40px base → the image clipped/vanished.
    ui.window.decodeImageToRgba = async () => null;
    const W = 40, H = 40;
    const gray = new Uint8Array(W * H); for (let i = 0; i < gray.length; i++) gray[i] = (i * 7) & 0xff;
    const smZlib = await deflateRaw(gray);
    const jpegBase = enc('\xff\xd8\xffnot-a-real-jpeg\xff\xd9');
    const content = enc('10 0 0 10 0 0 cm /X1 Do\n');   // placed at 10×10 pt → shrink target < 40px
    const pdf = concatU8([
      enc('%PDF-1.7\n'),
      enc('1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n'),
      enc('2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n'),
      enc('3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /X1 4 0 R >> >> /Contents 5 0 R >>endobj\n'),
      enc(`4 0 obj<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /SMask 6 0 R /Length ${jpegBase.length} >>stream\n`), jpegBase, enc('\nendstream endobj\n'),
      enc(`5 0 obj<< /Length ${content.length} >>stream\n`), content, enc('\nendstream endobj\n'),
      enc(`6 0 obj<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${smZlib.length} >>stream\n`), smZlib, enc('\nendstream endobj\n'),
      enc('trailer<< /Root 1 0 R /Size 7 >>\nstartxref\n0\n%%EOF'),
    ]);
    const out = latin1(await ui.window.convertPdfToCmyk(pdf, {}, { downsample: true, downsampleDpi: 72 }));
    const smask = objBody(out, 6);
    expect(smask).toMatch(/\/Width\s+40\b/);    // mask untouched — still matches the full-size base
    expect(smask).toMatch(/\/Height\s+40\b/);
    const base = objBody(out, 4);
    expect(base).toMatch(/\/Width\s+40\b/);     // base kept full-size too (decode failed → left intact)
    expect(base).toMatch(/\/DCTDecode/);        // not re-encoded
    expect(base).not.toMatch(/DeviceCMYK/);     // never CMYK
  });
});

describe('tokens-to-ink — downsample ignores a degenerate placement measurement', () => {
  it('keeps an image at full resolution when its measured on-page size is near-zero', async () => {
    ui = bootUI();
    ui.window.decodeImageToRgba = async (bytes, w, h) => new Uint8Array(w * h * 4).fill(200);
    const W = 400, H = 400;
    const jpeg = enc('\xff\xd8\xffX\xff\xd9');
    // Unit matrix → the content walker measures the image at ~1pt (the Form-XObject / name
    // collision failure mode). Old behaviour: downsample to ~1px → the image vanishes.
    const content = enc('1 0 0 1 0 0 cm /X1 Do\n');
    const pdf = concatU8([
      enc('%PDF-1.7\n'),
      enc('1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n'),
      enc('2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n'),
      enc('3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 600] /Resources << /XObject << /X1 4 0 R >> >> /Contents 5 0 R >>endobj\n'),
      enc(`4 0 obj<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>stream\n`), jpeg, enc('\nendstream endobj\n'),
      enc(`5 0 obj<< /Length ${content.length} >>stream\n`), content, enc('\nendstream endobj\n'),
      enc('trailer<< /Root 1 0 R /Size 6 >>\nstartxref\n0\n%%EOF'),
    ]);
    const out = latin1(await ui.window.convertPdfToCmyk(pdf, {}, { downsample: true, downsampleDpi: 72 }));
    const img = objBody(out, 4);
    expect(img).toMatch(/\/Width\s+400\b/);              // NOT shrunk to a few px
    expect(img).toMatch(/\/ColorSpace\s*\/DeviceRGB/);   // left in RGB (never CMYK)
    expect(img).not.toMatch(/DeviceCMYK/);
  });
});

describe('tokens-to-ink — document date', () => {
  it('stamps /CreationDate + /ModDate so viewers do not show a 1979 default', async () => {
    ui = bootUI();
    const out = latin1(await ui.window.convertPdfToCmyk(buildVectorPdf(), {}, { now: new Date(2026, 7, 25, 14, 30, 0) }));
    expect(out).toMatch(/\/Info\s+\d+\s+0\s+R/);                 // trailer references an /Info dict
    expect(out).toMatch(/\/CreationDate\s*\(D:20260825143000/);  // real export date, not empty
    expect(out).toMatch(/\/ModDate\s*\(D:20260825143000/);
  });

  it('also stamps the XMP date for PDF/X — macOS/Preview read XMP in preference to /Info', async () => {
    ui = bootUI();
    const out = latin1(await ui.window.convertPdfToCmyk(buildVectorPdf(), {}, { pdfx: true, now: new Date(2026, 7, 25, 14, 30, 0) }));
    expect(out).toMatch(/<xmp:CreateDate>2026-08-25T14:30:00/);
    expect(out).toMatch(/<xmp:ModifyDate>2026-08-25T14:30:00/);
  });
});

describe('tokens-to-ink — PDF/X-4 press-ready', () => {
  it('embeds an ICC output intent, XMP identifier, per-page TrimBox and /ID when pdfx is on', async () => {
    ui = bootUI();
    const out = latin1(await ui.window.convertPdfToCmyk(buildVectorPdf(), {}, { pdfx: true }));
    expect(out.startsWith('%PDF-1.6')).toBe(true);                       // X-4 needs 1.6
    expect(out).toMatch(/\/OutputIntents \[ << \/Type \/OutputIntent \/S \/GTS_PDFX/);
    expect(out).toMatch(/\/DestOutputProfile \d+ 0 R/);
    expect(out).toMatch(/\/N 4 \/Filter \/FlateDecode/);                 // the CMYK ICC profile stream
    expect(out).toMatch(/\/Type \/Metadata \/Subtype \/XML/);
    expect(out).toMatch(/PDF\/X-4/);                                     // XMP identifier
    expect(out).toMatch(/\/TrimBox \[0 0 64 64\]/);                      // every page gets a TrimBox
    expect(out).toMatch(/\/ID \[ <[0-9a-f]{32}> <[0-9a-f]{32}> \]/);
  });

  it('stays a plain PDF 1.4 with no output intent when pdfx is off', async () => {
    ui = bootUI();
    const out = latin1(await ui.window.convertPdfToCmyk(buildVectorPdf(), {}, { pdfx: false }));
    expect(out.startsWith('%PDF-1.4')).toBe(true);
    expect(out).not.toMatch(/\/OutputIntents/);
    expect(out).not.toMatch(/\/GTS_PDFX/);
    expect(out).not.toMatch(/\/ID \[/);
  });
});

describe('tokens-to-ink — Pantone spot colours', () => {
  const LOOKUP = { '#336699': { c: 80, m: 40, y: 0, k: 5, pantone: '485 C' } };

  it('emits a Separation spot for a Pantone-tagged fill when preserveSpot is on', async () => {
    ui = bootUI();
    const out = latin1(await ui.window.convertPdfToCmyk(buildVectorPdf(), LOOKUP, { preserveSpot: true }));
    // Separation colour space with the PDF-name-encoded ink and a Type-2 tint transform to CMYK.
    expect(out).toMatch(/\/Separation\s*\/PANTONE#20485#20C\s*\/DeviceCMYK/);
    expect(out).toMatch(/\/FunctionType 2[\s\S]*\/C1 \[ 0\.8 0\.4 0 0\.05 \]/);
    // The fill selects the spot at full tint, and the spot is registered in the page Resources.
    expect(out).toMatch(/\/Spot1 cs 1 scn/);
    expect(out).toMatch(/\/ColorSpace\s*<<\s*\/Spot1 \d+ 0 R/);
    expect(out).not.toMatch(/0\.8 0\.4 0 0\.05 k/);   // not flattened to process CMYK
  });

  it('flattens the same fill to process CMYK when preserveSpot is off', async () => {
    ui = bootUI();
    const out = latin1(await ui.window.convertPdfToCmyk(buildVectorPdf(), LOOKUP, { preserveSpot: false }));
    expect(out).not.toMatch(/\/Separation/);
    expect(out).toMatch(/0\.8 0\.4 0 0\.05 k/);        // the fill is process CMYK
  });

  it('leaves a non-Pantone fill as process CMYK even with preserveSpot on', async () => {
    ui = bootUI();
    const out = latin1(await ui.window.convertPdfToCmyk(buildVectorPdf(), { '#336699': { c: 80, m: 40, y: 0, k: 5 } }, { preserveSpot: true }));
    expect(out).not.toMatch(/\/Separation/);
    expect(out).toMatch(/0\.8 0\.4 0 0\.05 k/);
  });
});

describe('tokens-to-ink — TIFF compression', () => {
  const readTiffTags = (u8) => {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const ifd = dv.getUint32(4, true), n = dv.getUint16(ifd, true), tags = {};
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12, tag = dv.getUint16(e, true), type = dv.getUint16(e + 2, true), cnt = dv.getUint32(e + 4, true);
      tags[tag] = (type === 3 && cnt === 1) ? dv.getUint16(e + 8, true) : dv.getUint32(e + 8, true);
    }
    return tags;
  };
  const inflate = async (u8) => {
    const ds = new DecompressionStream('deflate');
    const w = ds.writable.getWriter(); w.write(u8); w.close();
    return new Uint8Array(await new Response(ds.readable).arrayBuffer());
  };
  const pixels = () => { const px = new Uint8Array(2 * 2 * 5); for (let i = 0; i < px.length; i++) px[i] = (i * 7) & 255; return px; };

  it('uncompressed: Compression tag = 1 and the strip is the raw pixels', async () => {
    ui = bootUI();
    const px = pixels();
    const tiff = await ui.window.buildCmykaTiff(px, 2, 2, 300, false);
    const tags = readTiffTags(tiff);
    expect(tags[259]).toBe(1);          // Compression: none
    expect(tags[279]).toBe(px.length);  // StripByteCounts = raw size
    expect([...tiff.slice(tags[273], tags[273] + tags[279])]).toEqual([...px]);
  });

  it('ZIP: Compression tag = 8 and the strip inflates back to the pixels (lossless)', async () => {
    ui = bootUI();
    const px = pixels();
    const tiff = await ui.window.buildCmykaTiff(px, 2, 2, 300, true);
    const tags = readTiffTags(tiff);
    expect(tags[259]).toBe(8);          // Adobe Deflate (zlib)
    const strip = tiff.slice(tags[273], tags[273] + tags[279]);
    expect([...(await inflate(strip))]).toEqual([...px]);   // round-trips exactly
  });
});

describe('tokens-to-ink — CMYK pixel conversion (fast-path parity)', () => {
  it('writeCmyk is byte-identical to the reference rgbPixelToCmyk, with and without a lookup', () => {
    ui = bootUI();
    const { rgbPixelToCmyk, buildCmykLut, writeCmyk } = ui.window;
    expect(typeof writeCmyk).toBe('function');
    const lookups = [
      null,
      { '#FF0000': { c: 0, m: 96, y: 90, k: 0 }, '#123456': { c: 80, m: 50, y: 20, k: 10 }, '#000000': { c: 0, m: 0, y: 0, k: 100 } },
    ];
    const out = new Uint8Array(4);
    for (const cl of lookups) {
      const lut = buildCmykLut(cl);
      const mism = [];
      const check = (r, g, b) => {
        const ref = rgbPixelToCmyk(r, g, b, cl);
        writeCmyk(out, 0, r, g, b, lut);
        if (out[0] !== ref[0] || out[1] !== ref[1] || out[2] !== ref[2] || out[3] !== ref[3]) {
          if (mism.length < 3) mism.push({ rgb: [r, g, b], ref, got: [...out] });
        }
      };
      for (let r = 0; r <= 255; r += 17) for (let g = 0; g <= 255; g += 17) for (let b = 0; b <= 255; b += 17) check(r, g, b);
      [[255, 0, 0], [0x12, 0x34, 0x56], [0, 0, 0], [255, 255, 255]].forEach(([r, g, b]) => check(r, g, b));
      expect(mism).toEqual([]);   // 4099 colours per lookup — zero divergence
    }
  });

  it('convertImageToCmyka maps known pixels to CMYK+alpha (TIFF path)', async () => {
    ui = bootUI();
    // Stub the canvas decode (jsdom has none): 2×2 = red, black, white, fully transparent.
    ui.window.loadPngToCanvas = async () => new Uint8Array([
      255, 0, 0, 255, /**/ 0, 0, 0, 255, /**/ 255, 255, 255, 255, /**/ 0, 0, 0, 0,
    ]);
    const out = await ui.window.convertImageToCmyka(new Uint8Array([1]), 2, 2, null);
    expect([...out.slice(0, 5)]).toEqual([0, 255, 255, 0, 255]);   // red   → C0 M255 Y255 K0, opaque
    expect([...out.slice(5, 10)]).toEqual([0, 0, 0, 255, 255]);    // black → K255, opaque
    expect([...out.slice(10, 15)]).toEqual([0, 0, 0, 0, 255]);     // white → all 0, opaque
    expect([...out.slice(15, 20)]).toEqual([0, 0, 0, 0, 0]);       // transparent → all 0
  });

  it('convertImageToCmyka honours an exact colour-lookup match', async () => {
    ui = bootUI();
    ui.window.loadPngToCanvas = async () => new Uint8Array([255, 0, 0, 255]);   // 1×1 red, opaque
    const out = await ui.window.convertImageToCmyka(new Uint8Array([1]), 1, 1, { '#FF0000': { c: 10, m: 20, y: 30, k: 40 } });
    // 10/20/30/40 % → ×2.55 → 26/51/77/102, alpha kept.
    expect([...out.slice(0, 5)]).toEqual([26, 51, 77, 102, 255]);
  });
});

describe('tokens-to-ink — PDF keeps photos in RGB', () => {
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

  it('leaves a decodable RGB photo in its RGB space — no downsample means byte-for-byte intact', async () => {
    ui = bootUI();
    // Stand in for the browser canvas (unused here since we do not touch the image without a
    // downsample, but set it so nothing throws): opaque mid-grey pixels.
    ui.window.decodeImageToRgba = async (_bytes, w, h) => new Uint8Array(w * h * 4).fill(180);
    const out = await ui.window.convertPdfToCmyk(pdfBytes(), {});
    const s = latin1(out);
    // The photo keeps its ICCBased RGB colour space (indirect ref 8 0 R), its original JPEG
    // filter, and its SMask — it is never converted to CMYK.
    const main = imageDicts(s).find(d => /\/ColorSpace\s+8\s+0\s+R/.test(d));
    expect(main).toBeTruthy();
    expect(main).toMatch(/\/DCTDecode/);
    expect(main).not.toMatch(/DeviceCMYK/);
    expect(main).toMatch(/\/SMask\s+\d+\s+0\s+R/);
  });

  it('never shows a CMYK-conversion warning — photos are kept in RGB by design', async () => {
    ui = bootUI();
    ui.window.downloadFile = () => {};                 // don't touch the filesystem in jsdom
    ui.window.decodeImageToRgba = async () => { throw new Error('no canvas'); };
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

  // The fixture's photo (obj 9) is 24×24 px placed over the full 64pt frame
  // (content stream: `64 0 0 64 … cm /X1 Do`) → ~27 DPI on the page. It is the image that
  // references a soft-mask; the mask image itself does not, so this picks the photo.
  const mainImageDims = (s) => {
    const d = imageDicts(s).find((x) => /\/SMask\s+\d+\s+0\s+R/.test(x));
    if (!d) return null;
    const w = d.match(/\/Width\s+(\d+)/), h = d.match(/\/Height\s+(\d+)/);
    return { w: w && +w[1], h: h && +h[1] };
  };

  it('downsamples an over-DPI photo but keeps it in RGB (never CMYK)', async () => {
    ui = bootUI();
    ui.window.decodeImageToRgba = async (_b, w, h) => new Uint8Array(w * h * 4).fill(180);
    // 64pt frame at 12 DPI → 64/72*12 ≈ 10.7 → 11 px, below the source's 24 px.
    const out = await ui.window.convertPdfToCmyk(pdfBytes(), {}, { downsample: true, downsampleDpi: 12 });
    const s = latin1(out);
    const dims = mainImageDims(s);
    expect(dims).toEqual({ w: 11, h: 11 });
    // Re-encoded to FlateDecode, but STILL its ICCBased RGB space (ref 8 0 R) — not CMYK.
    const main = imageDicts(s).find((x) => /\/SMask\s+\d+\s+0\s+R/.test(x));
    expect(main).toMatch(/\/ColorSpace\s+8\s+0\s+R/);
    expect(main).not.toMatch(/DeviceCMYK/);
    expect(main).toMatch(/\/Filter\s*\/FlateDecode/);
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
    expect(mainImageDims(latin1(out))).toEqual({ w: 24, h: 24 });
  });

  it('leaves image dimensions untouched when downsampling is off', async () => {
    ui = bootUI();
    ui.window.decodeImageToRgba = async (_b, w, h) => new Uint8Array(w * h * 4).fill(180);
    const out = await ui.window.convertPdfToCmyk(pdfBytes(), {}, { downsample: false, downsampleDpi: 12 });
    expect(mainImageDims(latin1(out))).toEqual({ w: 24, h: 24 });
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
