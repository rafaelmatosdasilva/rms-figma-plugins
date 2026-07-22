/**
 * Builds a ready-to-sideload zip per plugin, into dist/.
 *
 * Without this, sideloading means downloading the whole monorepo and hunting for
 * the right manifest. Each zip holds only what Figma loads — manifest.json,
 * code.js, ui.html — so the flow is download, unzip, Import from manifest.
 *
 * The zips are attached to GitHub Releases; dist/ itself is not committed.
 *
 * Usage: node scripts/package-plugin.mjs [plugin]   (all plugins if omitted)
 */
import { readFileSync, existsSync, readdirSync, mkdirSync, rmSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const appsDir = join(root, 'apps');
const distDir = join(root, 'dist');

const only = process.argv[2];
const plugins = readdirSync(appsDir)
  .filter((n) => existsSync(join(appsDir, n, 'manifest.json')))
  .filter((n) => !only || n === only);

if (!plugins.length) {
  process.stderr.write(`No such plugin "${only}".\n`);
  process.exit(1);
}

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

for (const plugin of plugins) {
  const dir = join(appsDir, plugin);
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;

  // Stage under the plugin name so the zip expands to a single tidy folder
  // rather than scattering three files into wherever it was unzipped.
  const stage = join(distDir, plugin);
  mkdirSync(stage, { recursive: true });
  for (const f of ['manifest.json', m.main, m.ui]) {
    const src = join(dir, f);
    if (!existsSync(src)) {
      process.stderr.write(`${plugin}: missing ${f} — run pnpm build first.\n`);
      process.exit(1);
    }
    copyFileSync(src, join(stage, f));
  }

  const zipName = `${plugin}-v${version}.zip`;
  const r = spawnSync('zip', ['-qr', zipName, plugin], { cwd: distDir, stdio: 'inherit' });
  if (r.status !== 0) {
    process.stderr.write(`${plugin}: zip failed.\n`);
    process.exit(1);
  }
  rmSync(stage, { recursive: true, force: true });
  process.stdout.write(`  dist/${zipName}\n`);
}

process.stdout.write(`\nAttach to a release:  gh release upload <tag> dist/<plugin>-v<n>.zip\n`);
