// sync-preview.mjs — mirror every plugin's built ui.html into ONE folder so the
// in-app browser preview can open all of them.
//
// Why this exists: the preview pane only serves files inside the session's project
// folder. When that folder is a single app (apps/impact-atlas) rather than the repo
// root, sibling plugins load as static snapshots with no JavaScript, so they cannot
// be driven or measured. Copies — not symlinks: the pane resolves a symlink to its
// real path, which is outside the folder again, and refuses it just the same.
//
// Runs after `pnpm build`, so the mirrors can never be staler than the build.
// Delete-safe: the copies are gitignored build output, never edited by hand.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = process.env.PREVIEW_HOST || 'impact-atlas';
const PLUGINS = ['impact-atlas', 'tokens-to-ink', 'font-scaling-lab'];

let copied = 0;
for (const plugin of PLUGINS) {
  if (plugin === HOST) continue;                       // the host serves its own ui.html
  const src = join(ROOT, 'apps', plugin, 'ui.html');
  if (!existsSync(src)) { console.warn(`  ⚠ ${plugin}: no built ui.html — run pnpm build`); continue; }
  writeFileSync(join(ROOT, 'apps', HOST, `preview-${plugin}.html`), readFileSync(src));
  copied++;
}
console.log(`  ✓ preview mirrors → apps/${HOST}/preview-*.html (${copied} plugin${copied === 1 ? '' : 's'})`);
