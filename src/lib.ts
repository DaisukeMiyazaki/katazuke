// Pure, testable core for Katazuke.
//
// Idea: a note that grew many links while being left untouched is a candidate
// for "confronting the past self" — split it, or consciously keep it.
// We rank by degree (link count) weighted by how stale the note is.
// Intentional hubs (tagged) are excluded so only unplanned sprawl surfaces.

export interface KatazukeSettings {
  // Notes carrying this tag are treated as intentional hubs and excluded.
  hubTag: string;
  // Age (in days) at which staleness doubles a note's urgency.
  freshnessHalfLifeDays: number;
  // How many notes the batch ("数件") mode shows.
  batchSize: number;
  // Notes below this degree are never surfaced.
  minDegree: number;
}

export const DEFAULT_SETTINGS: KatazukeSettings = {
  hubTag: "hub",
  freshnessHalfLifeDays: 90,
  batchSize: 7,
  minDegree: 5,
};

export function mergeSettings(
  loaded: Partial<KatazukeSettings> | null | undefined,
): KatazukeSettings {
  return { ...DEFAULT_SETTINGS, ...(loaded ?? {}) };
}

// Obsidian's app.metadataCache.resolvedLinks shape:
// { [sourcePath]: { [targetPath]: linkCount } }
export type LinkGraph = Record<string, Record<string, number>>;

// Binary attachments that shouldn't count as note-to-note connections.
export const MEDIA_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "avif", "ico",
  "mp4", "mov", "mkv", "webm", "ogv", "avi", "m4v",
  "mp3", "wav", "flac", "ogg", "m4a", "aac",
  "pdf",
]);

export function isMediaPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return MEDIA_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

// Distinct out-links from one source's resolvedLinks entry, excluding media
// targets and self-links.
export function outDegree(source: string, targets: Record<string, number>): number {
  let n = 0;
  for (const target of Object.keys(targets)) {
    if (target === source) continue;
    if (isMediaPath(target)) continue;
    n += 1;
  }
  return n;
}

// Reverse index of inbound mentions per target, in one O(total-links) pass over
// resolvedLinks. The count values are Obsidian's per-target mention counts, so
// summing them matches the backlink pane's "linked mentions" total. Media
// sources and targets are excluded. Computing this once avoids the
// O(notes^2) cost of calling getBacklinksForFile per note (which froze the UI).
export function computeBacklinkCounts(links: LinkGraph): Map<string, number> {
  const inbound = new Map<string, number>();
  for (const source of Object.keys(links)) {
    if (isMediaPath(source)) continue;
    const targets = links[source];
    for (const target of Object.keys(targets)) {
      if (target === source) continue;
      if (isMediaPath(target)) continue;
      inbound.set(target, (inbound.get(target) ?? 0) + targets[target]);
    }
  }
  return inbound;
}

export interface NoteInput {
  path: string;
  inDeg: number;
  outDeg: number;
  mtimeMs: number;
  hasHubTag: boolean;
}

export interface ScoredNote {
  path: string;
  inDeg: number;
  outDeg: number;
  degree: number;
  ageDays: number;
  score: number;
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

// score = degree * (1 + ageDays / halfLife)
// A note untouched for one half-life counts double. Older + denser ranks first.
export function scoreNote(
  note: NoteInput,
  settings: KatazukeSettings,
  nowMs: number,
): ScoredNote {
  const degree = note.inDeg + note.outDeg;
  const ageDays = Math.max(0, (nowMs - note.mtimeMs) / MS_PER_DAY);
  const half = settings.freshnessHalfLifeDays > 0
    ? settings.freshnessHalfLifeDays
    : 1;
  const score = degree * (1 + ageDays / half);
  return {
    path: note.path,
    inDeg: note.inDeg,
    outDeg: note.outDeg,
    degree,
    ageDays,
    score,
  };
}

// Rank candidates: drop hubs and low-degree notes, sort by score descending.
// Ties break on path so ordering is stable across runs.
export function rankNotes(
  notes: NoteInput[],
  settings: KatazukeSettings,
  nowMs: number,
): ScoredNote[] {
  return notes
    .filter((n) => !n.hasHubTag && n.inDeg + n.outDeg >= settings.minDegree)
    .map((n) => scoreNote(n, settings, nowMs))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

// --- Localization ---------------------------------------------------------
// UI defaults to English (for the community plugin listing). When Obsidian's
// language is Japanese, Japanese strings are shown instead.

export type Lang = "en" | "ja";

// Obsidian stores its UI language in localStorage under "language" (e.g. "ja").
export function pickLang(raw: string | null | undefined): Lang {
  return raw && raw.toLowerCase().startsWith("ja") ? "ja" : "en";
}

export interface Strings {
  confrontOne: string;
  confrontSeveral: string;
  heading: string;
  noResults: string;
  scoreLabel: string;
  backlinksLabel: string;
  outgoingLabel: string;
  daysSuffix: string;
  hubTagName: string;
  hubTagDesc: string;
  halfLifeName: string;
  halfLifeDesc: string;
  batchSizeName: string;
  minDegreeName: string;
  minDegreeDesc: string;
}

export const STRINGS: Record<Lang, Strings> = {
  en: {
    confrontOne: "Confront one note",
    confrontSeveral: "Confront several notes",
    heading:
      "Notes to tidy (Cmd/Ctrl+click opens a new tab and keeps this open)",
    noResults: "No notes to confront were found.",
    scoreLabel: "Score",
    backlinksLabel: "Backlinks",
    outgoingLabel: "Outgoing",
    daysSuffix: "d",
    hubTagName: "Hub exclusion tag",
    hubTagDesc:
      "Notes with this tag are treated as intentional hubs and excluded.",
    halfLifeName: "Freshness half-life (days)",
    halfLifeDesc: "After this many days untouched, a note's score doubles.",
    batchSizeName: "Batch size",
    minDegreeName: "Minimum degree",
    minDegreeDesc: "Notes below this link count are never surfaced.",
  },
  ja: {
    confrontOne: "一件と向き合う",
    confrontSeveral: "数件と向き合う",
    heading: "片付けの候補（Cmd/Ctrl+クリックで新しいタブを開き、このまま留まる）",
    noResults: "向き合う対象が見つかりませんでした",
    scoreLabel: "採点",
    backlinksLabel: "被リンク",
    outgoingLabel: "発リンク",
    daysSuffix: "日",
    hubTagName: "ハブ除外タグ",
    hubTagDesc: "意図的な目次ノートに付けるタグ。候補から除外する。",
    halfLifeName: "鮮度の半減期（日）",
    halfLifeDesc: "この日数だけ放置されると採点が2倍になる。",
    batchSizeName: "数件モードの件数",
    minDegreeName: "最小次数",
    minDegreeDesc: "この次数未満のノートは候補にしない。",
  },
};
