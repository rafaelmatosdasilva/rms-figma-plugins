/**
 * Shared file watcher for RMS plugins.
 *
 * Usage:
 *   node scripts/watch.mjs apps/font-scaling-lab
 *   node scripts/watch.mjs apps/tokens-to-ink
 *
 * Watches:
 *   <appDir>/src/code.js          → esbuild --watch (native)
 *   <appDir>/ui.src.html          → re-runs inject-theme
 *   packages/ui/src/theme.css     → re-runs inject-theme
 *   packages/ui/src/ui-shared.js  → re-runs inject-theme
 */

import { watchFile }              from 'fs';
import { execFileSync, spawn }    from 'child_process';
import { join, dirname }          from 'path';
import { fileURLToPath }          from 'url';

const root   = dirname(dirname(fileURLToPath(import.meta.url)));
const [,, appDir, ...extraEsbuildFlags] = process.argv;

if (!appDir) {
  process.stderr.write('Usage: node scripts/watch.mjs <app-dir>\n');
  process.exit(1);
}

const injectScript = join(root, 'scripts', 'inject-theme.mjs');
const codeEntry    = join(root, appDir, 'src', 'code.js');
const codeOut      = join(root, appDir, 'code.js');

const uiWatchFiles = [
  join(root, appDir,          'ui.src.html'),
  join(root, 'packages', 'ui', 'src', 'theme.css'),
  join(root, 'packages', 'ui', 'src', 'ui-shared.js'),
];

function injectTheme() {
  try {
    execFileSync(process.execPath, [
      injectScript,
      `${appDir}/ui.src.html`,
      `${appDir}/ui.html`,
    ], { cwd: root, stdio: 'inherit' });
  } catch (_) {}
}

// ── Initial build ─────────────────────────────────────────────────────────────
injectTheme();

// ── Watch HTML / CSS / shared JS → re-inject on change ───────────────────────
// fs.watchFile uses polling so it reliably catches atomic saves (VSCode etc.)
let debounce = null;
for (const file of uiWatchFiles) {
  watchFile(file, { interval: 200, persistent: true }, () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      process.stdout.write(`  ↺ ${file.slice(root.length + 1)}\n`);
      injectTheme();
    }, 60);
  });
}

// ── esbuild watches code.js and its imports natively ─────────────────────────
const esbuild = spawn(
  join(root, 'node_modules', '.bin', 'esbuild'),
  [
    codeEntry,
    '--bundle',
    '--platform=browser',
    '--format=iife',
    `--outfile=${codeOut}`,
    '--watch=forever',
    ...extraEsbuildFlags,
  ],
  { cwd: root, stdio: 'inherit' },
);

esbuild.on('close', code => process.exit(code ?? 0));
process.on('SIGINT',  () => { esbuild.kill('SIGINT');  process.exit(0); });
process.on('SIGTERM', () => { esbuild.kill('SIGTERM'); process.exit(0); });
