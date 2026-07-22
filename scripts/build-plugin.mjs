/**
 * Builds one plugin: injects the shared theme/UI into ui.html, then bundles
 * src/code.js with esbuild.
 *
 * Also stamps a build identity (name + version) as a console.log banner in the
 * bundled code. Deliberately NOT shown in the UI — the plugin windows are small
 * and the version is only ever needed to answer "which build am I on?", which a
 * one-line log in the plugin console covers without costing any pixels.
 *
 * The version is read from the plugin's own package.json, which is the single
 * source of truth and is bumped by scripts/release.mjs to match the version
 * Figma assigns when publishing to Community.
 *
 * Usage: node scripts/build-plugin.mjs apps/<plugin>
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const appRel = process.argv[2];

if (!appRel) {
  process.stderr.write('Usage: build-plugin.mjs <apps/plugin-dir>\n');
  process.exit(1);
}

const appDir = join(root, appRel);
const pkgPath = join(appDir, 'package.json');
const manifestPath = join(appDir, 'manifest.json');

for (const p of [pkgPath, manifestPath]) {
  if (!existsSync(p)) {
    process.stderr.write(`Missing ${p}\n`);
    process.exit(1);
  }
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const displayName = manifest.name || pkg.name;
const version = pkg.version;

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// 1. shared theme + ui-shared → ui.html
run('node', [join(root, 'scripts', 'inject-theme.mjs'), `${appRel}/ui.src.html`, `${appRel}/ui.html`], root);

// 2. bundle the plugin sandbox code, stamped with the build identity
const banner = `console.log(${JSON.stringify(`${displayName} v${version}`)});`;
run(join(root, 'node_modules', '.bin', 'esbuild'), [
  'src/code.js',
  '--bundle',
  '--platform=browser',
  '--format=iife',
  '--target=es2019',
  '--minify',
  `--banner:js=${banner}`,
  '--outfile=code.js',
], appDir);
