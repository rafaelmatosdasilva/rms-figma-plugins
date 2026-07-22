# Design System Figma Plugins

[![build](https://github.com/rafaelmatosdasilva/rms-ds-figma-plugins/actions/workflows/build.yml/badge.svg)](https://github.com/rafaelmatosdasilva/rms-ds-figma-plugins/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Figma plugins for design-system work.

Each one is published on the Figma Community — install from there if you just want
to use it. This repo holds the source, and lets you sideload the plugins directly
(useful if your org gates Community plugins behind an approval process).

They run entirely inside your Figma file. No network access, nothing sent anywhere.

---

## Impact Atlas

**Trace token impact across your design system**

[Open in Figma Community →](https://www.figma.com/community/plugin/1643205375147564994/impact-atlas)

When you change a token, it's often unclear what depends on it, what's affected,
and how far those changes spread. Impact Atlas reveals the structure and
relationships behind your design system, showing how tokens and components
connect and how changes propagate through your files.

- Scans your file's variables and components, plus the variable collections in any
  connected libraries, so you can search and trace impact paths.
- Calculates impact tiers (High / Medium / Low) based on how deep and wide each
  token's alias chain runs, weighted by how many components use it.
- Shows dependency chains from tokens through aliases to components, with an
  optional deeper scan that adds canvas usage counts.
- Copy a plain-text summary of any token or component's tier, aliases, and bound
  components for audits or documentation.

![Impact Atlas](docs/impact-atlas.png)

![Impact Atlas preview](docs/impact-atlas-preview.png)

---

## Tokens to Ink

**Extend color tokens into print-ready output**

[Open in Figma Community →](https://www.figma.com/community/plugin/1627749854119339734/tokens-to-ink)

Design system colors often stay consistent in Figma but break in print. Different
tools, color profiles, and production workflows shift how colors appear between
digital and physical output. Tokens to Ink extends your Figma color variables into
print-ready values, using the same variables you already use.

- Reads your color variables and suggests CMYK equivalents — accept or override them.
- Add CMYK, Pantone, RAL, and vinyl values to your tokens, stored as metadata.
- Reuse stored print values wherever those variables are applied in designs.
- Export selected artwork using mapped values for production-ready output.

![Tokens to Ink](docs/tokens-to-ink.png)

![Tokens to Ink preview](docs/tokens-to-ink-preview.png)

---

## Font Scaling Lab

**Stress test layouts under text scaling**

[Open in Figma Community →](https://www.figma.com/community/plugin/1632816540279283797/font-scaling-lab)

Typography systems often work well under ideal conditions but break in real use.
Text resizing, assistive technologies, and changing content cause overflow, broken
layouts, and lost hierarchy. Font Scaling Lab simulates these conditions so you can
test how your typography behaves beyond fixed assumptions.

- No setup required — runs safely on existing layouts without modifying any values.
- Simulates realistic text scaling to mimic zoom and accessibility settings.
- Detects truncation, clipping, and constraint failures caused by fixed dimensions.
- Suggests targeted fixes for each detected issue.

![Font Scaling Lab](docs/font-scaling-lab.png)

![Font Scaling Lab preview](docs/font-scaling-lab-preview.png)

---

## Install

1. Go to [Releases](../../releases) and download the zip for the plugin you want,
   e.g. `impact-atlas-v5.zip`. Unzip it.
2. In the Figma **desktop** app: **Plugins → Development → Import plugin from
   manifest…**
3. Pick the `manifest.json` inside the unzipped folder.

That's it. Nothing to install, nothing to build.

Run it any time from **Plugins → Development**.

Prefer the whole repo? Clone it, or use the green **Code** button → **Download
ZIP**, and point step 3 at `apps/<plugin>/manifest.json`.

## Get updates

Download the new zip from [Releases](../../releases) and replace the folder, or
`git pull` if you cloned. Reopen the plugin and you're on the new version.
Re-import the manifest only if the folder moved.

To hear about new versions, click **Watch → Custom → Releases** at the top of this
repo. [CHANGELOG.md](CHANGELOG.md) lists what changed.

Versions are per plugin, so they won't match each other — each matches that
plugin's version on the Figma Community. Each plugin logs its version on startup,
under **Plugins → Development → Open console**.

> Installed from the Community instead? That updates itself. Sideloading is only
> for when your organisation gates Community plugins.

## Building from source

Only needed if you change the code. Requires Node 24 and pnpm:

```sh
pnpm install
pnpm build
```

## Contact

Feedback and ideas are welcome:

- Email — [hello@rafaelmatosdasilva.com](mailto:hello@rafaelmatosdasilva.com)
- LinkedIn — [rafaelmatosdasilva](https://www.linkedin.com/in/rafaelmatosdasilva/)

## License

MIT — see [LICENSE](LICENSE).
