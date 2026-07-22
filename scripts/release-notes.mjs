/**
 * Builds a Release body from CHANGELOG.md for a given tag.
 *
 * Hand-writing the notes each time is how they drift from the changelog — the
 * two disagreed once already. Deriving one from the other removes that.
 *
 * Usage: node scripts/release-notes.mjs <plugin>-v<version>
 * Prints the body to stdout; exits non-zero if there's no matching entry.
 */
import { readFileSync, readdirSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tag = process.argv[2];

if (!tag) {
  process.stderr.write('Usage: release-notes.mjs <plugin>-v<version>\n');
  process.exit(1);
}

const m = /^(.+)-v(\d+)$/.exec(tag);
if (!m) {
  process.stderr.write(`Tag "${tag}" is not <plugin>-v<version>.\n`);
  process.exit(1);
}
const [, plugin, version] = m;

const appDir = join(root, 'apps', plugin);
if (!existsSync(join(appDir, 'manifest.json'))) {
  process.stderr.write(`Unknown plugin "${plugin}".\n`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(join(appDir, 'manifest.json'), 'utf8'));
const displayName = manifest.name;

// Pull the "## <Display Name>" section, then the "### v<version>" entry inside it.
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const sections = changelog.split(/^## /m).find((s) => s.startsWith(displayName));
if (!sections) {
  process.stderr.write(`No "## ${displayName}" section in CHANGELOG.md.\n`);
  process.exit(1);
}
const entry = sections
  .split(/^### /m)
  .find((s) => new RegExp(`^v${version}\\b`).test(s));
if (!entry) {
  process.stderr.write(`No "### v${version}" entry under ${displayName}.\n`);
  process.exit(1);
}

// Changelog bullets wrap across lines; a continuation is indented. Rejoin them,
// or the notes come out truncated mid-sentence.
const bullets = [];
for (const line of entry.split('\n')) {
  if (line.startsWith('- ')) bullets.push(line);
  else if (bullets.length && /^\s+\S/.test(line)) bullets[bullets.length - 1] += ' ' + line.trim();
  else if (!line.trim()) continue;
}
const communityUrl = `https://www.figma.com/community/plugin/${manifest.id}`;

const out = [
  `Now live on the [Figma Community](${communityUrl}).`,
  '',
  ...bullets,
  '',
  `Download \`${plugin}-v${version}.zip\` below, unzip, then **Plugins → Development → Import plugin from manifest…** in the Figma desktop app.`,
];

// A checksum someone can actually check: `shasum -a 256 <file>`. Sideloading
// means running code from a zip, and the zip is worth being able to verify.
const zip = join(root, 'dist', `${plugin}-v${version}.zip`);
if (existsSync(zip)) {
  const sha = createHash('sha256').update(readFileSync(zip)).digest('hex');
  out.push('', '<details><summary>Verify the download</summary>', '', '```', `shasum -a 256 ${plugin}-v${version}.zip`, `${sha}`, '```', '</details>');
}

// The 3-bullet cap is a judgement call about what a reader cares about, which a
// script can't make. Flag it instead so the draft gets trimmed before publishing.
if (bullets.length > 3) {
  out.unshift(`<!-- ${bullets.length} bullets — trim to 3 before publishing: lead with the biggest change, fold the rest into "Fixed minor UI issues and improved overall polish." -->`, '');
}

process.stdout.write(out.join('\n') + '\n');
