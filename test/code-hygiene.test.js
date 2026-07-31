import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guards the shape of the code, not its behaviour.
 *
 * Written after a run of fixes left real mess behind: a helper defined and never
 * called, the same scoring function written four times, and a 77-line block
 * inlined into an already-long handler. Each was harmless to the user and
 * invisible to every other test.
 *
 * Dead code and duplication are zero-tolerance — they have no reason to exist.
 * Function length is a RATCHET: known offenders are listed with their current
 * size, so pre-existing debt doesn't fail the suite, but nothing may be added and
 * nothing may grow. Shrinking one below its entry is fine; update the number, or
 * delete the entry once it's under the threshold.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SOURCES = [
  'apps/impact-atlas/src/code.js',
  'apps/impact-atlas/ui.src.html',
  'apps/tokens-to-ink/src/code.js',
  'apps/tokens-to-ink/ui.src.html',
  'apps/font-scaling-lab/src/code.js',
  'apps/font-scaling-lab/ui.src.html',
  'packages/ui/src/ui-shared.js',
].filter((f) => existsSync(join(ROOT, f)));

/**
 * Functions knowingly left unused, with the reason. Same ratchet idea as the
 * length baseline: visible, but not blocking. Remove an entry once it's deleted
 * or wired up — the last test here fails if an entry stops being true.
 */
const UNUSED_ALLOWLIST = {
  // Shared package: a public helper the plugins don't call, kept as part of the
  // package's surface. Everything else must be deleted rather than allowlisted.
  createSegmentedControl: 'packages/ui — exported for consumers; no caller in this repo',
};

/** Longest tolerated function, and the functions already above it. */
const MAX_FUNCTION_LINES = 120;
const LENGTH_BASELINE = {
  handleUsageScan: 478,       // impact-atlas: multi-phase scan, staged progress (+5 for the deleted-component guard, 2026-07-31)
  convertPdfToCmyk: 430,      // tokens-to-ink: PDF colour conversion
  handleInit: 178,            // impact-atlas
  handlePlaceComponents: 138, // impact-atlas
  buildComponentIndex: 135,   // impact-atlas (+5 for the deleted-component remote guard, 2026-07-31)
};

function read(file) {
  return readFileSync(join(ROOT, file), 'utf8');
}

/**
 * Top-level `function name(...)` declarations with their line span.
 *
 * Braces inside strings, comments and regex literals must not be counted — one
 * miscounted function leaves the scanner "inside" it forever and silently hides
 * every declaration after it. That bug hid five unused functions.
 */
function stripNonCode(line) {
  return line
    .replace(/\\./g, '')          // escapes first, so \" doesn't end a string
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .replace(/`[^`]*`/g, '``')
    .replace(/\/\/.*$/, '');
}

function declarationsIn(file) {
  const lines = read(file).split('\n');
  const found = [];
  let cur = null;
  let depth = 0;
  lines.forEach((line, i) => {
    const code = stripNonCode(line);
    const m = code.match(/^(?:\s{0,2})(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/);
    // A new top-level declaration while one is still "open" means the previous
    // one never balanced. Close it rather than swallowing everything that follows.
    if (m) { cur = { name: m[1], start: i, file }; depth = 0; }
    if (!cur) return;
    depth += (code.match(/\{/g) || []).length - (code.match(/\}/g) || []).length;
    if (depth <= 0 && i > cur.start) {
      found.push({ ...cur, lines: i - cur.start + 1 });
      cur = null;
    }
  });
  return found;
}

describe('code hygiene', () => {
  const declarations = SOURCES.flatMap(declarationsIn);
  const corpus = SOURCES.map(read).join('\n');

  it('declares no function that is never used', () => {
    const dead = declarations.filter(({ name }) => {
      if (UNUSED_ALLOWLIST[name]) return false;
      // Every mention anywhere: a call, a reference, an HTML handler attribute.
      const mentions = corpus.match(new RegExp(`\\b${name}\\b`, 'g')) || [];
      return mentions.length <= 1; // only its own declaration
    });

    expect(
      dead.map((d) => `${d.file}: ${d.name}()`),
      'unused function(s) — delete them, or wire them up',
    ).toEqual([]);
  });

  it('does not define the same logic twice', () => {
    const bodies = new Map();
    for (const file of SOURCES) {
      const text = read(file);
      for (const m of text.matchAll(/function\s+([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{([\s\S]{60,600}?)\n\s{0,2}\}/g)) {
        const body = m[2].replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim();
        if (body.length < 60) continue;
        if (!bodies.has(body)) bodies.set(body, []);
        bodies.get(body).push(`${file}: ${m[1]}()`);
      }
    }
    const clones = [...bodies.values()].filter((where) => where.length > 1);

    expect(
      clones.map((where) => where.join('  ==  ')),
      'identical function bodies — extract one shared helper',
    ).toEqual([]);
  });

  it('adds no new over-long function, and grows none of the known ones', () => {
    const tooLong = declarations.filter((d) => d.lines > MAX_FUNCTION_LINES);
    const offences = [];

    for (const d of tooLong) {
      const allowed = LENGTH_BASELINE[d.name];
      if (allowed === undefined) {
        offences.push(`${d.file}: ${d.name}() is ${d.lines} lines (limit ${MAX_FUNCTION_LINES}) — split it`);
      } else if (d.lines > allowed) {
        offences.push(`${d.file}: ${d.name}() grew ${allowed} → ${d.lines} lines — split it, don't raise the baseline`);
      }
    }

    expect(offences, 'function length ratchet').toEqual([]);
  });

  it('keeps the unused allowlist honest', () => {
    // An allowlisted function that is now used (or gone) must be removed from the
    // list, or it hides a real finding later.
    const declared = new Set(declarations.map((d) => d.name));
    const stale = Object.keys(UNUSED_ALLOWLIST).filter((name) => {
      if (!declared.has(name)) return true;                       // deleted
      const mentions = corpus.match(new RegExp(`\\b${name}\\b`, 'g')) || [];
      return mentions.length > 1;                                 // now used
    });

    expect(stale, 'allowlist entries no longer true — remove them').toEqual([]);
  });

  it('keeps the length baseline honest', () => {
    // A baseline entry that no longer applies must go, or it silently permits
    // regrowth later.
    const byName = new Map(declarations.map((d) => [d.name, d.lines]));
    const stale = Object.keys(LENGTH_BASELINE).filter((name) => {
      const actual = byName.get(name);
      return actual === undefined || actual <= MAX_FUNCTION_LINES;
    });

    expect(
      stale,
      'baseline entries that are no longer needed — remove them (the function shrank or went away)',
    ).toEqual([]);
  });
});
