// ─── Color conversion utilities ─────────────────────────────────────────────
// Pure functions — no Figma API, no side-effects.

/**
 * Converts normalised RGB (0–1) to an uppercase hex string e.g. "#FF0000".
 */
export function rgbToHex(r, g, b) {
  const toHex = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

/**
 * Converts normalised RGB (0–1) to CMYK percentages (0–100).
 */
export function rgbToCmyk(r, g, b) {
  if (r === 0 && g === 0 && b === 0) return { c: 0, m: 0, y: 0, k: 100 };
  const k = 1 - Math.max(r, g, b);
  const c = (1 - r - k) / (1 - k);
  const m = (1 - g - k) / (1 - k);
  const y = (1 - b - k) / (1 - k);
  return {
    c: Math.round(c * 100),
    m: Math.round(m * 100),
    y: Math.round(y * 100),
    k: Math.round(k * 100),
  };
}

/**
 * Parses a CMYK string like "0, 100, 100, 0" or "C:0 M:100 Y:100 K:0"
 * into { c, m, y, k }, or null if unparseable.
 */
export function parseCmykString(str) {
  if (!str || typeof str !== "string") return null;
  const parts = str.replace(/[CMYK:]/gi, "").trim().split(/[\s,]+/).map(Number);
  if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
    // Tags live in the variable description and can be hand-edited, so a channel may
    // be out of range (negative or >100). Clamp to 0-100 so the export never ships
    // invalid ink values. In-range values are untouched.
    const clamp = (n) => Math.max(0, Math.min(100, n));
    return { c: clamp(parts[0]), m: clamp(parts[1]), y: clamp(parts[2]), k: clamp(parts[3]) };
  }
  return null;
}
