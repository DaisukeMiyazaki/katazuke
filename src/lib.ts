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

export interface Degree {
  inDeg: number;
  outDeg: number;
}

// Count distinct out-links per note and distinct in-links (backlinks) per note.
export function computeDegrees(links: LinkGraph): Map<string, Degree> {
  const deg = new Map<string, Degree>();
  const ensure = (path: string): Degree => {
    let d = deg.get(path);
    if (!d) {
      d = { inDeg: 0, outDeg: 0 };
      deg.set(path, d);
    }
    return d;
  };
  for (const source of Object.keys(links)) {
    const targets = links[source];
    const distinct = Object.keys(targets);
    ensure(source).outDeg += distinct.length;
    for (const target of distinct) {
      if (target === source) continue; // ignore self-links
      ensure(target).inDeg += 1;
    }
  }
  return deg;
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
  return { path: note.path, degree, ageDays, score };
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
