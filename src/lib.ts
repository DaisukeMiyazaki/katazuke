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
  // Mountain lens: a note untouched for at least this many days counts as
  // "clutter" (たまり) — the digital equivalent of dust settling on it.
  clutterStaleDays: number;
  // How many grains one pile holds. A pile is ONE sitting's worth — small
  // enough to finish, so every session ends with the mound gone, not with a
  // dent in an endless mountain.
  pileSize: number;
  // Mountain colors: follow Obsidian's theme, or force light/dark paper.
  mountainTheme: MountainTheme;
  // Draw the suggested (red) grains in the user's Obsidian accent color.
  useAccentColor: boolean;
  // Notes under these folder paths never enter the mountain or the ranked
  // candidates — templates, archives, other people's imports.
  excludedFolders: string[];
  // Vault path of the tidying log — the source of truth for history. One line
  // is appended per judged note, so it syncs and merges well across devices.
  logPath: string;
}

export type MountainTheme = "auto" | "light" | "dark";

export const DEFAULT_SETTINGS: KatazukeSettings = {
  hubTag: "hub",
  freshnessHalfLifeDays: 90,
  batchSize: 7,
  minDegree: 5,
  clutterStaleDays: 90,
  pileSize: 10,
  mountainTheme: "auto",
  useAccentColor: false,
  excludedFolders: [],
  logPath: "katazuke-log.md",
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

// True when `path` sits inside any of `folders` (or IS one of them). Matches
// whole path segments only — excluding "diary" must not catch "diary-old/x.md".
export function isUnderFolder(path: string, folders: string[]): boolean {
  return folders.some((f) => {
    if (!f) return false;
    const prefix = f.endsWith("/") ? f : f + "/";
    return path === f || path.startsWith(prefix);
  });
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

// --- Mountain lens (たまり) -------------------------------------------------
// A different way to look at the vault. Instead of over-connected sprawl, this
// surfaces the opposite failure: notes that connect to nothing and were left
// untouched — orphaned drafts gathering dust. Physical clutter presses on you
// because it costs space; digital notes cost nothing, so "last touched" is the
// only honest signal of neglect. Each qualifying note becomes one dot in the
// mountain view; judging it (keep / shelve / drop) removes the dot and the
// mound settles lower.

export interface ClutterNote {
  path: string;
  ageDays: number;
}

// Orphans (zero inbound + outbound links) that have been untouched for at least
// `staleDays`. Ordering is left to the caller; the layout re-sorts by age.
export function selectClutter(
  notes: NoteInput[],
  nowMs: number,
  staleDays: number,
): ClutterNote[] {
  const out: ClutterNote[] = [];
  for (const n of notes) {
    if (n.inDeg + n.outDeg !== 0) continue; // orphans only
    const ageDays = Math.max(0, (nowMs - n.mtimeMs) / MS_PER_DAY);
    if (ageDays < staleDays) continue;
    out.push({ path: n.path, ageDays });
  }
  return out;
}

// --- Tidying log -----------------------------------------------------------
// The log is a plain markdown file in the vault: one `YYYY-MM-DD path` line
// per judged note. Append-only lines survive sync merges, and the vault file
// is the single source of truth every device reads its history from.

export interface TidyHistory {
  total: number;
  byDay: Record<string, number>;
}

export function localIso(d: Date): string {
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function formatLogLine(day: string, path: string): string {
  return `${day} ${path}\n`;
}

// Count judged notes per day. Anything that doesn't look like a log line
// (headers, blanks, stray edits) is ignored rather than fatal.
export function parseLog(content: string): TidyHistory {
  const byDay: Record<string, number> = {};
  let total = 0;
  for (const line of content.split(/\r?\n/)) {
    const m = /^(\d{4}-\d{2}-\d{2})\s+\S/.exec(line);
    if (!m) continue;
    byDay[m[1]] = (byDay[m[1]] ?? 0) + 1;
    total++;
  }
  return { total, byDay };
}

// The trailing `n` days ending at `todayIso`, zero-filled — chart-ready.
export function lastNDays(
  byDay: Record<string, number>,
  n: number,
  todayIso: string,
): { day: string; count: number }[] {
  const out: { day: string; count: number }[] = [];
  const base = new Date(`${todayIso}T00:00:00`);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base);
    d.setDate(d.getDate() - i);
    const iso = localIso(d);
    out.push({ day: iso, count: byDay[iso] ?? 0 });
  }
  return out;
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
  openMountain: string;
  mountainTitle: string;
  mountainEmpty: string;
  mountainCleared: string;
  staleDaysName: string;
  staleDaysDesc: string;
  pileSizeName: string;
  pileSizeDesc: string;
  themeName: string;
  themeAuto: string;
  themeLight: string;
  themeDark: string;
  accentName: string;
  accentDesc: string;
  excludeName: string;
  excludeDesc: string;
  excludeSelect: string;
  excludeRemove: string;
  logPathName: string;
  logPathDesc: string;
  logHeader: string;
  historyName: string;
  historyTotal: string;
  historyEmpty: string;
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
    openMountain: "Open the clutter mountain",
    mountainTitle: "Katazuke — clutter mountain",
    mountainEmpty: "All tidy. Nothing left to confront.",
    mountainCleared: "Pile cleared — {n} still wait. Click for the next pile.",
    staleDaysName: "Clutter age (days)",
    staleDaysDesc:
      "Orphan notes untouched for at least this many days form the mountain.",
    pileSizeName: "Pile size",
    pileSizeDesc:
      "How many notes one pile holds. Keep it small enough to finish in one sitting.",
    themeName: "Mountain colors",
    themeAuto: "Match Obsidian",
    themeLight: "Light",
    themeDark: "Dark",
    accentName: "Use accent color",
    accentDesc:
      "Draw the suggested notes in your Obsidian accent color instead of crimson.",
    excludeName: "Excluded folders",
    excludeDesc:
      "Notes under these folders never enter the mountain or the candidates.",
    excludeSelect: "Choose a folder to add…",
    excludeRemove: "Remove",
    logPathName: "Log file",
    logPathDesc:
      "One line is appended here per tidied note. It lives in your vault, so it syncs across devices as the single source of truth.",
    logHeader: "# katazuke log — one line per tidied note",
    historyName: "Tidying history",
    historyTotal: "{n} notes tidied so far",
    historyEmpty: "No history yet — topple a pile and the trail appears here.",
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
    openMountain: "たまりの山を開く",
    mountainTitle: "片づけ — たまりの山",
    mountainEmpty: "片付いた。向き合う対象はもうない。",
    mountainCleared: "一山片付いた。残り {n} 粒。クリックで次の山。",
    staleDaysName: "たまりとみなす放置日数",
    staleDaysDesc: "孤立していて、この日数以上触っていないノートが山になる。",
    pileSizeName: "一山の粒数",
    pileSizeDesc: "一度の片づけで向き合う量。一回で崩し切れる大きさに保つ。",
    themeName: "山の配色",
    themeAuto: "Obsidianに合わせる",
    themeLight: "ライト",
    themeDark: "ダーク",
    accentName: "アクセントカラーを使う",
    accentDesc: "判定候補の粒を、紅色でなくObsidianのアクセントカラーで描く。",
    excludeName: "対象外フォルダー",
    excludeDesc: "このフォルダー配下のノートは山にも候補にも含めない。",
    excludeSelect: "フォルダーを選んで追加…",
    excludeRemove: "除外を解除",
    logPathName: "記録ファイル",
    logPathDesc:
      "片付けた1件ごとに1行追記する。保存庫内のファイルなので端末間で同期され、これが軌跡の原本になる。",
    logHeader: "# katazuke 片付けの記録 — 1行が片付けた1件",
    historyName: "片付けの軌跡",
    historyTotal: "これまでに {n} 粒片付けた",
    historyEmpty: "まだ記録がない。山を崩すとここに軌跡が描かれる。",
  },
};
