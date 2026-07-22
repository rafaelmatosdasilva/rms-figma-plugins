# Changelog

Each plugin is versioned independently and matches the version published to the
Figma Community, which Figma assigns. Numbers don't line up between plugins —
each only moves when that plugin is published.

Shared design-system work sometimes lands here between Community releases. It's
listed under the current version rather than given one of its own.

(Some earlier entries use decimals like `v5.1` for repo-only releases. That
scheme was retired on 22 July 2026.)

---

## Impact Atlas

### v5 — 22 July 2026
Published to Figma Community.
- Scan-depth radio rings are slightly heavier, matching the connector line.
- Scan-depth radio dots now line up with their labels.
- A chain with only alias tokens and no components keeps its column width, so
  nodes no longer stretch to fill the panel.
- Section dividers are 2px taller, matching a spacing change in the design system.
- The "Scanned …" bar and its rescan button now show after a local scan too.
  They previously only appeared once a canvas scan had run, so opening the
  plugin in a fresh file left you with no visible way to re-run it.
- Empty state uses the design system's object icons, and its icon colour now
  matches the DS in light mode (was too dark).
- Nodes that recede when another is selected use the real disabled tokens
  instead of being faded with opacity, so their colours match the design.
- Action buttons inside a node (focus / go to) keep their own colour rather
  than being dimmed along with the node.
- Disabled label and icon colours corrected against the DS.

### v4 — 17 July 2026
Published to Figma Community.

---

## Tokens to Ink

### v4 — 17 July 2026
Published to Figma Community. Later shared design-system work landed here without
a new Community release, since none of it changed how the plugin works:
- Node and empty-state colours corrected against the design system.
- Section dividers are 2px taller, matching a spacing change in the design system.

---

## Font Scaling Lab

### v6 — 22 July 2026
Published to Figma Community.
- Added tooltips for objects outside the visible area.
- Fixed minor UI issues and improved overall polish.

### v5.2 — 22 July 2026
Repo only — not republished to the Community.
- Section dividers are 2px taller, matching a spacing change in the design system.

### v5.1 — 22 July 2026
Repo only — not republished to the Community.
- Picks up the shared design-system fixes (node and empty-state colours).

### v5 — 4 June 2026
Published to Figma Community.
