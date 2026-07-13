import { describe, it, expect } from "vitest";
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  isMediaPath,
  outDegree,
  computeBacklinkCounts,
  scoreNote,
  rankNotes,
  pickLang,
  NoteInput,
} from "./lib";

const NOW = 1_700_000_000_000;
const daysAgo = (n: number) => NOW - n * 1000 * 60 * 60 * 24;

describe("mergeSettings", () => {
  it("fills defaults for missing keys", () => {
    expect(mergeSettings({ batchSize: 3 })).toEqual({
      ...DEFAULT_SETTINGS,
      batchSize: 3,
    });
  });
  it("tolerates null", () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
  });
});

describe("isMediaPath", () => {
  it("flags media attachments, not notes", () => {
    expect(isMediaPath("assets/photo.PNG")).toBe(true);
    expect(isMediaPath("clip.mov")).toBe(true);
    expect(isMediaPath("scan.pdf")).toBe(true);
    expect(isMediaPath("notes/idea.md")).toBe(false);
    expect(isMediaPath("noext")).toBe(false);
  });
});

describe("outDegree", () => {
  it("counts distinct non-media targets, ignoring self-links", () => {
    const n = outDegree("a.md", {
      "b.md": 1,
      "c.md": 2,
      "a.md": 1, // self-link ignored
      "img.png": 1, // media excluded
      "clip.mov": 1, // media excluded
    });
    expect(n).toBe(2);
  });
});

describe("pickLang", () => {
  it("defaults to English, uses Japanese only for ja locales", () => {
    expect(pickLang(null)).toBe("en");
    expect(pickLang("")).toBe("en");
    expect(pickLang("en")).toBe("en");
    expect(pickLang("fr")).toBe("en");
    expect(pickLang("ja")).toBe("ja");
    expect(pickLang("ja-JP")).toBe("ja");
  });
});

describe("computeBacklinkCounts", () => {
  it("sums inbound mentions per target, excluding media and self-links", () => {
    const inbound = computeBacklinkCounts({
      "a.md": { "c.md": 2, "img.png": 1 }, // a mentions c twice; image excluded
      "b.md": { "c.md": 1, "b.md": 3 }, // b mentions c once; self-link ignored
      "clip.mov": { "c.md": 9 }, // media source excluded entirely
    });
    expect(inbound.get("c.md")).toBe(3);
    expect(inbound.has("img.png")).toBe(false);
    expect(inbound.has("b.md")).toBe(false);
  });
});

describe("scoreNote", () => {
  it("doubles the score after one half-life", () => {
    const note: NoteInput = {
      path: "x.md",
      inDeg: 4,
      outDeg: 6,
      mtimeMs: daysAgo(90),
      hasHubTag: false,
    };
    const s = scoreNote(note, DEFAULT_SETTINGS, NOW);
    expect(s.degree).toBe(10);
    expect(s.score).toBeCloseTo(20, 5);
  });
});

describe("rankNotes", () => {
  const notes: NoteInput[] = [
    { path: "fresh-hub.md", inDeg: 20, outDeg: 0, mtimeMs: daysAgo(0), hasHubTag: true },
    { path: "old-dense.md", inDeg: 8, outDeg: 8, mtimeMs: daysAgo(180), hasHubTag: false },
    { path: "fresh-dense.md", inDeg: 8, outDeg: 8, mtimeMs: daysAgo(0), hasHubTag: false },
    { path: "sparse.md", inDeg: 1, outDeg: 1, mtimeMs: daysAgo(365), hasHubTag: false },
  ];

  it("excludes hubs and low-degree notes", () => {
    const paths = rankNotes(notes, DEFAULT_SETTINGS, NOW).map((n) => n.path);
    expect(paths).not.toContain("fresh-hub.md");
    expect(paths).not.toContain("sparse.md");
  });

  it("ranks stale-and-dense above fresh-and-dense", () => {
    const ranked = rankNotes(notes, DEFAULT_SETTINGS, NOW);
    expect(ranked[0].path).toBe("old-dense.md");
    expect(ranked[1].path).toBe("fresh-dense.md");
  });
});
