# Katazuke

An Obsidian plugin for confronting the over-connected notes your past self left
behind. *Katazuke* (片付け) means "tidying up."

日本語版は [README.ja.md](README.ja.md) にあります。

## Why

A note that has accumulated too many links can be an unhealthy sign — it has
quietly become a catch-all instead of a focused idea. But that sprawl is hard to
spot in the graph view.

Katazuke measures it directly. The signal is degree (link count): the more links
a note has, and the longer it has been left untouched, the more it is worth
revisiting. Intentional hubs (maps of content) are excluded by tag, so only the
notes that grew dense *without you deciding they should* rise to the top.

This is closer to a ritual than a linter — you occasionally sit with one note,
confront what your past self was doing there, and decide to split it or
consciously keep it.

## Scoring

```
score = degree * (1 + ageDays / freshnessHalfLifeDays)
```

- `degree` is backlinks + outgoing links. Backlinks are counted the same way as
  Obsidian's backlink pane (total linked mentions). Links to media attachments
  (images, audio, video, PDF) and self-links are excluded.
- A note left untouched for one half-life counts double. Older and denser notes
  rank first.

## Two modes

Both are available from the command palette:

- Confront one (`一件と向き合う`) — shows only the single highest-scoring note. A
  light, everyday pass for spare moments.
- Confront several (`数件と向き合う`) — shows the top N notes for a focused
  tidying session.

Click a result to open it in place (the modal closes). Cmd/Ctrl+click opens it
in a new tab and keeps the modal open, so you can keep triaging — the same
gesture as a browser.

## The clutter mountain

A second lens for the opposite failure: notes connected to *nothing* that have
sat untouched. `Open the clutter mountain` (or the ribbon mountain icon) opens
a small pane in the right sidebar.

- Orphan notes untouched past a threshold (default 90 days) stack up as grains
  of a sand mound; the older a grain, the darker it sinks toward the core.
- One pile holds `Pile size` notes (default 10) — one sitting's worth, drawn
  from the dustiest corner of the vault, so a session actually finishes.
- Click a grain to judge it: the note opens beside the mountain without
  stealing focus, the grain puffs away, grains above it fall, and steep slopes
  topple. Accent-colored grains are "start here" suggestions.
- Topple the whole pile and a click raises the next one.
- Every judgment appends one line to a log file in your vault, and Settings
  shows your tidying history — total plus a 30-day bar chart. The vault file is
  the source of truth, so the trail continues across synced devices.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Hub exclusion tag | `hub` | Notes with this tag are treated as intentional hubs and excluded. |
| Freshness half-life (days) | `90` | After this many days untouched, a note's score doubles. |
| Batch size | `7` | How many notes "Confront several" shows. |
| Minimum degree | `5` | Notes below this link count are never surfaced. |
| Pile size | `10` | How many notes one mountain pile holds. |
| Clutter age (days) | `90` | Orphan notes untouched this long form the mountain. |
| Mountain colors | Match Obsidian | Follow the theme, or force light/dark paper. |
| Use accent color | off | Draw suggested grains in your Obsidian accent color. |
| Excluded folders | — | Notes under these folders never enter the mountain or the candidates. |
| Log file | `katazuke-log.md` | Tidying history — one appended line per judged note. |

Requires Obsidian 1.8.7 or newer.

## Installation

### Community plugins

Available in the
[Obsidian community plugin directory](https://community.obsidian.md/plugins/katazuke).
In Obsidian, go to Settings → Community plugins → Browse, search for "Katazuke",
install, and enable.

### BRAT (beta)

To track pre-release builds, install
[BRAT](https://github.com/TfTHacker/obsidian42-brat) and add this repository
(`DaisukeMiyazaki/katazuke`) as a beta plugin.

### Manual

Download `main.js`, `manifest.json`, and `styles.css` from the
[latest release](https://github.com/DaisukeMiyazaki/katazuke/releases) into your
vault's `.obsidian/plugins/katazuke/` folder, then enable the plugin in
Settings → Community plugins.

## What it accesses

Katazuke works entirely offline.

- Reads the paths of every note in the vault, the resolved link graph, each
  note's last-modified time, and note tags — all needed for scoring and for the
  mountain.
- Makes no network requests. Nothing leaves your vault.
- Does not read or write the clipboard, and never modifies your existing notes.
- Writes exactly two things: its own settings (through Obsidian's plugin data
  API), and — only when you judge a note in the clutter mountain — one appended
  line to the tidying log file in your vault (default `katazuke-log.md`,
  configurable).

## Development

```
npm install
npm test        # vitest — pure scoring/graph logic
npm run typecheck
npm run lint    # eslint-plugin-obsidianmd — mirrors the directory's review
npm run build   # bundles main.js
```

The scoring and link-graph logic lives in `src/lib.ts` as pure functions and is
covered by unit tests; `src/main.ts` holds the Obsidian integration (commands,
modal, settings).

## Roadmap

- In batch mode, group notes by shared link target so you can face a whole past
  "theme" at once, not isolated notes.
- Record the split / keep decision in place, for a more lint-like workflow.

## Support

Katazuke is free and open source (MIT) for everyone, personal and commercial
use alike. If it earns its place in your commercial workflow, please consider
sponsoring its upkeep — it is entirely voluntary, but it keeps the plugin
maintained.

- [GitHub Sponsors](https://github.com/sponsors/DaisukeMiyazaki)

## License

MIT — see [LICENSE](LICENSE).
