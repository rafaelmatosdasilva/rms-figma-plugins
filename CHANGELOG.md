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

Landed since publishing, and going out with the next Community release:
- Place affected components on canvas. From a token, one action drops live
  instances of every component it affects into a named, transparent Section on a
  plugin-owned "Impact Atlas Previews" page, so nothing lands on top of your work
  and no colour is added to your document. The Section is titled with the token and
  timestamp; repeat placements sit side by side. Because they're instances, editing
  the token updates them in place.
- Library components are included too: when a token affects a component from an
  external library, its live instance appears on the board alongside the rest.
  Library components are marked with a small library icon (no canvas focus, since
  their master lives in another file).
- Renaming a variable in a library file no longer makes it show up twice. Library
  variables live in another file, so the plugin had no way of knowing when one was
  renamed, deleted or republished there — its cached copy still looked current. It
  now re-checks each cached library variable against the live library, takes the new
  name, and drops any that were deleted. If the library can't be reached it keeps
  what it had rather than clearing your results.
- Failures are reported as a toast in the corner instead of a red bar wedged into
  the panel. The old bar stayed on screen after the problem had passed.
- The search field's border was too dim in dark mode — it was using the divider
  line colour rather than the input colour. The two are identical in light mode,
  which is why it only ever looked wrong in dark.
- The action bar now uses its own design-system colours and gains a bottom rule,
  matching the design system. It had been borrowing the colour of Figma's own
  plugin titlebar, which has since diverged.

### v4 — 17 July 2026
Published to Figma Community.

---

## Tokens to Ink

### Unreleased
- The plugin scans as soon as it opens. With nothing selected it lists every
  colour variable the file can use (local and library), so you can pair print
  values without picking artwork first. There's no export button in that state,
  since there's nothing to export.
- Scanning after that stays manual, and the scan button now names its target
  next to its icon: "Scan selection" when something is selected, "Scan file"
  otherwise.
- The output column now grows with the window, so long Pantone and vinyl names
  stay readable instead of being cut off.
- Failures are reported as a toast in the corner instead of a red bar wedged into
  the panel, and an error toast stays up longer than a confirmation.
- Dark mode colours updated against the design system — the greys shifted slightly
  across the whole ramp, so panels, borders and text all move together.

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

Landed since publishing, and going out with the next Community release:
- Failures are reported as a toast in the corner instead of a red bar wedged into
  the panel. The old bar stayed on screen after the problem had passed.
- Dark mode colours updated against the design system — the greys shifted slightly
  across the whole ramp, so panels, borders and text all move together.
- The scale field's border was too dim in dark mode and slightly too thin, and its
  focus ring used a text colour instead of the design system's focus colour.

### v5.2 — 22 July 2026
Repo only — not republished to the Community.
- Section dividers are 2px taller, matching a spacing change in the design system.

### v5.1 — 22 July 2026
Repo only — not republished to the Community.
- Picks up the shared design-system fixes (node and empty-state colours).

### v5 — 4 June 2026
Published to Figma Community.
