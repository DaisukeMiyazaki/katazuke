import { describe, it, expect } from "vitest";
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  computeDegrees,
  scoreNote,
  rankNotes,
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

describe("computeDegrees", () => {
  it("counts out-links and back-links, ignoring self-links", () => {
    const deg = computeDegrees({
      "a.md": { "b.md": 1, "c.md": 2, "a.md": 1 },
      "b.md": { "c.md": 1 },
    });
    expect(deg.get("a.md")).toEqual({ inDeg: 0, outDeg: 3 });
    expect(deg.get("b.md")).toEqual({ inDeg: 1, outDeg: 1 });
    expect(deg.get("c.md")).toEqual({ inDeg: 2, outDeg: 0 });
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
