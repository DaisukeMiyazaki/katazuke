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

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Hub exclusion tag | `hub` | Notes with this tag are treated as intentional hubs and excluded. |
| Freshness half-life (days) | `90` | After this many days untouched, a note's score doubles. |
| Batch size | `7` | How many notes "Confront several" shows. |
| Minimum degree | `5` | Notes below this link count are never surfaced. |

## Installation

### Community plugins

Not yet in the community plugin directory (submission in progress).

### BRAT (beta)

Install [BRAT](https://github.com/TfTHacker/obsidian42-brat), then add this
repository (`DaisukeMiyazaki/katazuke`) as a beta plugin.

### Manual

Download `main.js`, `manifest.json`, and `styles.css` from the
[latest release](https://github.com/DaisukeMiyazaki/katazuke/releases) into your
vault's `.obsidian/plugins/katazuke/` folder, then enable the plugin in
Settings → Community plugins.

## Development

```
npm install
npm test        # vitest — pure scoring/graph logic
npm run typecheck
npm run build   # bundles main.js
```

The scoring and link-graph logic lives in `src/lib.ts` as pure functions and is
covered by unit tests; `src/main.ts` holds the Obsidian integration (commands,
modal, settings).

## Roadmap

- In batch mode, group notes by shared link target so you can face a whole past
  "theme" at once, not isolated notes.
- Record the split / keep decision in place, for a more lint-like workflow.

## License

MIT — see [LICENSE](LICENSE).
