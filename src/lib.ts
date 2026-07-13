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
