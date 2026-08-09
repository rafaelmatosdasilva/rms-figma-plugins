// ─── Print / physical-size helpers ───────────────────────────────────────────
// Pure maths shared by the export pre-flight (no figma.* calls). All physical
// figures assume the EXPORT scale Figma commits to: 1 px = 1 pt = 1/72 inch — the
// same basis Illustrator reads back, so numbers here match its readouts.

/** Figma px → centimetres (72 px = 2.54 cm). */
export function pxToCm(px) { return (px * 2.54) / 72; }
/** Figma px → millimetres. */
export function pxToMm(px) { return (px * 25.4) / 72; }

// Standard sheet sizes in millimetres, portrait (w ≤ h). Matched in either
// orientation. Keep this list to the sizes people actually export to for print.
const PAPER_SIZES = [
  { name: "A0", w: 841, h: 1189 }, { name: "A1", w: 594, h: 841 },
  { name: "A2", w: 420, h: 594 },  { name: "A3", w: 297, h: 420 },
  { name: "A4", w: 210, h: 297 },  { name: "A5", w: 148, h: 210 },
  { name: "A6", w: 105, h: 148 },  { name: "A7", w: 74,  h: 105 },
  { name: "A8", w: 52,  h: 74 },
  { name: "B4", w: 250, h: 353 },  { name: "B5", w: 176, h: 250 },
  { name: "Letter", w: 216, h: 279 }, { name: "Legal", w: 216, h: 356 },
  { name: "Tabloid", w: 279, h: 432 },
  { name: "DL", w: 99, h: 210 },
  { name: "Business card", w: 55, h: 85 },
];

/**
 * Name the standard sheet a size corresponds to, in either orientation, within a
 * small tolerance (max of 1.5 mm or 1%, to absorb px→cm rounding). Returns
 * { name, orientation } — name is "custom" when nothing matches.
 */
export function matchPaperSize(wCm, hCm) {
  const wmm = wCm * 10, hmm = hCm * 10;
  const near = (a, b) => Math.abs(a - b) <= Math.max(1.5, b * 0.01);
  for (const p of PAPER_SIZES) {
    if (near(wmm, p.w) && near(hmm, p.h)) return { name: p.name, orientation: "portrait" };
    if (near(wmm, p.h) && near(hmm, p.w)) return { name: p.name, orientation: "landscape" };
  }
  return { name: "custom", orientation: wmm >= hmm ? "landscape" : "portrait" };
}

/**
 * Effective print resolution of an image paint at its placed size, in DPI, at export
 * scale. `paint` supplies scaleMode / imageTransform / scalingFactor; srcW/srcH are the
 * source bitmap's pixels; boxWpt/boxHpt are the node's box in points. Returns
 * { dpiX, dpiY }, or null when it can't be determined (e.g. a TILE with no factor).
 *
 * FILL/FIT scale the image uniformly, so both axes share one DPI (FILL = cover / larger
 * factor, FIT = contain / smaller factor). CROP shows a sub-rectangle via imageTransform,
 * so each axis can differ — this is where the non-uniform "267×290" readings come from.
 */
export function effectiveImageDpi(paint, srcW, srcH, boxWpt, boxHpt) {
  if (!srcW || !srcH || !boxWpt || !boxHpt) return null;
  const mode = paint && paint.scaleMode;

  if (mode === "CROP") {
    const t = paint.imageTransform;
    let fx = 1, fy = 1;                          // fraction of the source shown per axis
    if (t && t[0] && t[1]) {
      fx = Math.hypot(t[0][0], t[1][0]) || 1;
      fy = Math.hypot(t[0][1], t[1][1]) || 1;
    }
    return { dpiX: (srcW * fx) / (boxWpt / 72), dpiY: (srcH * fy) / (boxHpt / 72) };
  }

  if (mode === "TILE") {
    const sf = paint.scalingFactor;
    if (!sf || sf <= 0) return null;             // can't tell density → caller skips it
    const dpi = 72 / sf;
    return { dpiX: dpi, dpiY: dpi };
  }

  // FILL (default) covers the box; FIT contains it. Both keep aspect → uniform DPI.
  const sx = boxWpt / srcW, sy = boxHpt / srcH;  // points per source px, per axis
  const ptPerPx = mode === "FIT" ? Math.min(sx, sy) : Math.max(sx, sy);
  const dpi = 72 / ptPerPx;
  return { dpiX: dpi, dpiY: dpi };
}
