/**
 * Cuts a release for ONE plugin, keeping the repo version identical to the
 * version Figma assigns on Community.
 *
 * Figma owns the version number (it increments per plugin on publish and there
 * is no API to read it back), so you pass the number shown in Figma's publish
 * dialog. Everything downstream is derived from it.
 *
 *   node scripts/release.mjs <plugin> <version>
 *   node scripts/release.mjs impact-atlas 5
 *
 * With no arguments it reports which plugins have unpublished changes.
 *
 * Deliberately stops before pushing: nothing reaches the public repo without
 * an explicit review.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const appsDir = join(root, 'apps');

const sh = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts });

const plugins = readdirSync(appsDir).filter((n) =>
  existsSync(join(appsDir, n, 'manifest.json')) && existsSync(join(appsDir, n, 'package.json')),
);

const pkgPathFor = (p) => join(appsDir, p, 'package.json');
const readPkg = (p) => JSON.parse(readFileSync(pkgPathFor(p), 'utf8'));

/** Files whose changes affect a given plugin: its own dir + the shared packages. */
const scopeFor = (p) => [`apps/${p}`, 'packages'];

function status() {
  process.stdout.write('\nPlugin status (repo vs last released tag)\n\n');
  for (const p of plugins) {
    const v = readPkg(p).version;
    const tag = `${p}-v${v}`;
    const hasTag = sh('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]).status === 0;
    if (!hasTag) {
      process.stdout.write(`  ${p.padEnd(18)} v${String(v).padEnd(4)} no tag yet — release to create ${tag}\n`);
      continue;
    }
    const changed = sh('git', ['diff', '--name-only', `${tag}..HEAD`, '--', ...scopeFor(p)])
      .stdout.trim().split('\n').filter(Boolean);
    process.stdout.write(
      changed.length
        ? `  ${p.padEnd(18)} v${String(v).padEnd(4)} ${changed.length} file(s) changed since ${tag} — unpublished\n`
        : `  ${p.padEnd(18)} v${String(v).padEnd(4)} up to date with ${tag}\n`,
    );
  }
  process.stdout.write('\nRelease:  node scripts/release.mjs <plugin> <version>\n\n');
}

const [, , plugin, version] = process.argv;

if (!plugin) { status(); process.exit(0); }

if (!plugins.includes(plugin)) {
  process.stderr.write(`Unknown plugin "${plugin}". Known: ${plugins.join(', ')}\n`);
  process.exit(1);
}
if (!/^\d+(\.\d+)?$/.test(version || '')) {
  process.stderr.write(
    'Version must be either:\n' +
    '  5     the integer Figma shows when publishing to Community\n' +
    '  4.1   a repo-only release — shared DS fixes with nothing worth republishing\n',
  );
  process.exit(1);
}
const isCommunityRelease = !version.includes('.');

const pkg = readPkg(plugin);
const prev = pkg.version;
const tag = `${plugin}-v${version}`;

if (sh('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]).status === 0) {
  process.stderr.write(`Tag ${tag} already exists.\n`);
  process.exit(1);
}
if (sh('git', ['status', '--porcelain']).stdout.trim()) {
  process.stderr.write('Working tree is dirty — commit or stash first so the release is a clean point.\n');
  process.exit(1);
}

// 1. bump
pkg.version = version;
writeFileSync(pkgPathFor(plugin), JSON.stringify(pkg, null, 2) + '\n');
process.stdout.write(`${plugin}: v${prev} → v${version}\n`);

// 2. rebuild (all plugins — a shared DS change affects every bundle)
if (sh('pnpm', ['build'], { stdio: 'inherit' }).status !== 0) {
  process.stderr.write('Build failed — aborting release.\n');
  process.exit(1);
}

// 3. commit + tag
sh('git', ['add', '-A']);
sh('git', ['commit', '-m', `${plugin} v${version}`], { stdio: 'inherit' });
sh('git', ['tag', '-a', tag, '-m', `${plugin} v${version}`], { stdio: 'inherit' });

process.stdout.write(
  `\nTagged ${tag}. Not pushed.\n` +
  `  Review, then:  git push origin main --follow-tags\n` +
  (isCommunityRelease
    ? `  Then publish v${version} in Figma and cut the GitHub Release from ${tag}.\n\n`
    : `  Repo-only release — do NOT publish to Community. Cut the GitHub Release from ${tag}.\n` +
      `  (Community stays on v${String(version).split('.')[0]}; the next publish there resets this to a whole number.)\n\n`),
);
