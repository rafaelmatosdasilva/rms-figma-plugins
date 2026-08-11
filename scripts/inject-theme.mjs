/**
 * Injects packages/ui/src/theme.css into an HTML template at the <!--@THEME--> marker
 * and packages/ui/src/ui-shared.js at <!--@UI-->.
 * Usage: node scripts/inject-theme.mjs <src-html> <out-html>
 * Paths are relative to the monorepo root.
 *
 * Injected payloads are MINIFIED via esbuild (css + js) — the sources stay readable,
 * only the built ui.html shrinks (comments and parity annotations don't ship to users).
 * Minification cannot change computed styles or behavior; Gate [16] (rendered parity)
 * verifies the built output either way. Falls back to raw injection if esbuild is missing.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [,, srcRel, outRel] = process.argv;

if (!srcRel || !outRel) {
  process.stderr.write('Usage: inject-theme.mjs <src.html> <out.html>\n');
  process.exit(1);
}

const esbuildBin = join(root, 'node_modules', '.bin', 'esbuild');

function minify(source, loader) {
  if (!existsSync(esbuildBin)) return source;
  const r = spawnSync(esbuildBin, [`--loader=${loader}`, '--minify', '--target=es2019'], {
    input: source, encoding: 'utf8',
  });
  if (r.status !== 0) {
    process.stderr.write(`Warning: esbuild ${loader} minify failed — injecting raw\n${(r.stderr || '').slice(0, 300)}\n`);
    return source;
  }
  return r.stdout;
}

const theme    = minify(readFileSync(join(root, 'packages/ui/src/theme.css'),    'utf8'), 'css');
const uiShared = minify(readFileSync(join(root, 'packages/ui/src/ui-shared.js'), 'utf8'), 'js');
const src      = readFileSync(join(root, srcRel), 'utf8');

if (!src.includes('<!--@THEME-->')) {
  process.stderr.write(`Warning: <!--@THEME--> not found in ${srcRel}\n`);
}
if (!src.includes('<!--@UI-->')) {
  process.stderr.write(`Warning: <!--@UI--> not found in ${srcRel}\n`);
}

let out = src.replace('<!--@THEME-->', `<style>\n${theme}\n</style>`);
out     = out.replace('<!--@UI-->',    `<script>\n${uiShared}\n</script>`);

// Optional: bundle a CMYK ICC profile (base64, pre-deflated) for PDF/X output intents. Injected
// only when the template opts in with <!--@ICC--> and the plugin ships the asset — a no-op for
// plugins without either, so this stays generic.
if (src.includes('<!--@ICC-->')) {
  const iccPath = join(root, dirname(srcRel), 'src', 'icc-fogra39.b64');
  const icc = existsSync(iccPath) ? readFileSync(iccPath, 'utf8').trim() : '';
  out = out.replace('<!--@ICC-->', icc ? `<script>window.__ICC_FOGRA39=${JSON.stringify(icc)}</script>` : '');
}

writeFileSync(join(root, outRel), out);
process.stdout.write(`  \u2713 theme + ui-shared (minified) \u2192 ${outRel}\n`);
