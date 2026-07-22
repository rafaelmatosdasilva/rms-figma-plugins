# Changelog

Each plugin is versioned independently.

- **Whole numbers** (`v4`, `v5`) match the version published to the Figma
  Community. Figma assigns these.
- **Decimals** (`v4.1`) are repo-only releases: shared design-system fixes that
  reached this plugin but had nothing worth republishing to the Community. The
  next Community publish resets it to a whole number — `4.2` → `5`.

So `v4.1` means "Community v4, plus repo-side fixes since". If you install from
the Community you're on the whole number; if you sideload from here you may be
slightly ahead.

Numbers don't line up between plugins — each only moves when that plugin changes.

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

### Unreleased
- Section dividers are 2px taller, matching a spacing change in the design system.

### v4.1 — 22 July 2026
Repo only — not republished to the Community.
- Picks up the shared design-system fixes (node and empty-state colours).

### v4 — 17 July 2026
Published to Figma Community.

---

## Font Scaling Lab

### Unreleased
- Section dividers are 2px taller, matching a spacing change in the design system.

### v5.1 — 22 July 2026
Repo only — not republished to the Community.
- Picks up the shared design-system fixes (node and empty-state colours).

### v5 — 4 June 2026
Published to Figma Community.
