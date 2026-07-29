/**
 * Static analysis of the plugin ↔ UI message contract, and of the UI's internal
 * references (icons, element ids).
 *
 * These checks are deliberately mechanical: they read the source rather than run
 * it, so they catch whole classes of breakage that behaviour tests miss — a
 * renamed icon leaving a dangling <use href>, a `getElementById` for an element
 * that was deleted, or a message one side sends that the other never handles.
 */

/**
 * Messages intercepted by @rms/core's attachWindowResize before a plugin's own
 * router sees them. The router legitimately has no case for these.
 */
export const CORE_HANDLED = ['ui-resize', 'save-size'];

/**
 * The JS inside a UI's <script> blocks, with everything else blanked out.
 *
 * Scanning the raw HTML would be wrong: apostrophes in ordinary prose ("don't")
 * read as string delimiters to a JS scanner and blank out everything after them,
 * which silently hides real code from every check below.
 */
export function scriptSource(html) {
  const out = html.split('').fill(' ');
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    const start = m.index + m[0].indexOf('>') + 1;
    for (let i = 0; i < m[1].length; i++) out[start + i] = m[1][i];
  }
  return out.join('');
}

/**
 * Strip string literals, template literals, regexes and comments, replacing each
 * with equivalent-length blanks so offsets stay put. Everything below scans the
 * blanked source, so a brace inside a string can't throw the matching off.
 */
export function blankNonCode(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') { out[i] = ' '; i++; }
      continue;
    }
    if (c === '/' && next === '*') {
      out[i] = out[i + 1] = ' '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] !== '\n') out[i] = ' '; i++; }
      if (i < n) { out[i] = out[i + 1] = ' '; i += 2; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      // Only template literals may span lines. Stopping ' and " at the newline
      // keeps one stray apostrophe from blanking the rest of the file.
      const multiline = quote === '`';
      out[i] = ' '; i++;
      while (i < n && src[i] !== quote) {
        if (!multiline && src[i] === '\n') break;
        if (src[i] === '\\') { out[i] = ' '; i++; }
        if (i < n) { if (src[i] !== '\n') out[i] = ' '; i++; }
      }
      if (i < n && src[i] === quote) { out[i] = ' '; i++; }
      continue;
    }
    i++;
  }
  return out.join('');
}

/** Body of the first function whose declaration matches `startRe`, by brace matching. */
export function functionBodyAt(src, startRe) {
  const blank = blankNonCode(src);
  const m = startRe.exec(blank);
  if (!m) return null;

  // Find the brace that opens the BODY, not one inside a destructured parameter
  // (`({ data }) => {`): the first `{` sitting outside any parentheses.
  let open = -1, parens = 0;
  for (let i = m.index + m[0].length - 1; i < blank.length; i++) {
    const ch = blank[i];
    if (ch === '(') parens++;
    else if (ch === ')') parens--;
    else if (ch === '{' && parens <= 0) { open = i; break; }
  }
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < blank.length; i++) {
    if (blank[i] === '{') depth++;
    else if (blank[i] === '}') {
      depth--;
      if (depth === 0) return { start: open, end: i, text: src.slice(open, i + 1) };
    }
  }
  return null;
}

const uniq = (a) => [...new Set(a)].sort();

/** Message types a `switch (msg.type)`-style router handles, incl. `x === 'y'` forms. */
export function handledTypes(bodyText) {
  if (!bodyText) return [];
  const blank = blankNonCode(bodyText);
  // Re-read the literals from the original at the offsets the blanked scan found.
  const types = [];
  for (const re of [/case\s+(['"])([^'"]+)\1\s*:/g, /\.type\s*===\s*(['"])([^'"]+)\1/g]) {
    for (const m of bodyText.matchAll(re)) {
      // Confirm the match sits in real code, not inside a string/comment.
      if (blank[m.index] !== ' ') types.push(m[2]);
    }
  }
  return uniq(types);
}

/** Message types the backend sends to the UI. */
export function backendPostedTypes(src) {
  const blank = blankNonCode(src);
  const types = [];
  for (const m of src.matchAll(/postMessage\(\s*\{\s*type:\s*(['"])([^'"]+)\1/g)) {
    if (blank[m.index] !== ' ') types.push(m[2]);
  }
  return uniq(types);
}

/** Message types the UI sends to the backend. */
export function uiPostedTypes(src) {
  const blank = blankNonCode(src);
  const types = [];
  for (const m of src.matchAll(/pluginMessage:\s*\{\s*type:\s*(['"])([^'"]+)\1/g)) {
    if (blank[m.index] !== ' ') types.push(m[2]);
  }
  return uniq(types);
}

/** Icon symbols referenced via <use href="#..."> and the symbols actually defined. */
export function iconRefsAndDefs(html) {
  const refs = uniq([...html.matchAll(/<use\s+href="#([^"]+)"/g)].map((m) => m[1]));
  const defs = uniq([...html.matchAll(/<symbol\s+id="([^"]+)"/g)].map((m) => m[1]));
  return { refs, defs };
}

/** Element ids asked for in JS, and the ids present in the markup. */
export function elementIdsUsedAndDefined(html) {
  const blank = blankNonCode(html);
  const used = [];
  for (const m of html.matchAll(/getElementById\(\s*(['"])([^'"]+)\1\s*\)/g)) {
    if (blank[m.index] !== ' ') used.push(m[2]);
  }
  const defined = uniq([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  return { used: uniq(used), defined };
}
