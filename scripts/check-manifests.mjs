/**
 * Validates every plugin manifest before it can reach anyone.
 *
 * `pnpm build` proves the code compiles; it does not prove Figma will load the
 * plugin. A malformed manifest, or a `main`/`ui` pointing at a file that isn't
 * committed, fails silently in CI and then loudly in someone's Figma.
 *
 * Also asserts networkAccess stays "none" — that promise is in the README and
 * the Community listings, so a change to it must be deliberate, not incidental.
 *
 * Usage: node scripts/check-manifests.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const appsDir = join(root, 'apps');

// Optional plugin arg: a release validates only the plugin it ships, since a
// tag's other plugins may carry versions from a retired scheme.
const only = process.argv[2];
const plugins = readdirSync(appsDir)
  .filter((n) => existsSync(join(appsDir, n, 'manifest.json')))
  .filter((n) => !only || n === only);

if (only && !plugins.length) {
  process.stderr.write(`Unknown plugin "${only}".\n`);
  process.exit(1);
}

const problems = [];
const fail = (plugin, msg) => problems.push(`${plugin}: ${msg}`);

for (const plugin of plugins) {
  const dir = join(appsDir, plugin);
  const manifestPath = join(dir, 'manifest.json');

  let m;
  try {
    m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    fail(plugin, `manifest.json is not valid JSON — ${err.message}`);
    continue;
  }

  for (const key of ['name', 'id', 'api', 'main', 'ui', 'editorType']) {
    if (!m[key]) fail(plugin, `manifest.json is missing "${key}"`);
  }

  // The two files Figma actually loads. Both are build output and both are
  // committed, so a missing one means someone shipped without building.
  for (const key of ['main', 'ui']) {
    if (m[key] && !existsSync(join(dir, m[key]))) {
      fail(plugin, `"${key}" points at ${m[key]}, which does not exist`);
    }
  }

  const domains = m.networkAccess?.allowedDomains;
  if (!Array.isArray(domains) || domains.length !== 1 || domains[0] !== 'none') {
    fail(plugin, 'networkAccess.allowedDomains must be ["none"] — the plugins are offline by design');
  }

  // package.json version is the single source of truth for the release flow.
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) {
    fail(plugin, 'package.json is missing');
  } else {
    const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
    if (!/^\d+$/.test(String(version))) {
      fail(plugin, `package.json version "${version}" must be an integer matching the Figma Community version`);
    }
  }
}

if (problems.length) {
  process.stderr.write(`\n${problems.length} manifest problem(s):\n`);
  for (const p of problems) process.stderr.write(`  ✗ ${p}\n`);
  process.stderr.write('\n');
  process.exit(1);
}

process.stdout.write(`✓ ${plugins.length} manifests valid (${plugins.join(', ')})\n`);
