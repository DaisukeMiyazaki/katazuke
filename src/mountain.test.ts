import { describe, it, expect } from "vitest";
import {
  Pile,
  buildPile,
  refillCandidates,
  relaxPile,
  removeFromPile,
} from "./mountain";
import { formatLogLine, isUnderFolder, lastNDays, parseLog } from "./lib";
import type { ClutterNote } from "./lib";

function notes(ages: number[]): ClutterNote[] {
  return ages.map((a, i) => ({ path: `n${i}.md`, ageDays: a }));
}

function grainCount(pile: Pile): number {
  return pile.columns.reduce((sum, col) => sum + col.length, 0);
}

function heights(pile: Pile): number[] {
  return pile.columns.map((col) => col.length);
}

// No column may tower 2+ grains over an on-grid neighbor after settling.
function isSettled(pile: Pile): boolean {
  const h = heights(pile);
  for (let c = 0; c < h.length; c++) {
    if (c > 0 && h[c] - h[c - 1] >= 2) return false;
    if (c < h.length - 1 && h[c] - h[c + 1] >= 2) return false;
  }
  return true;
}

describe("buildPile", () => {
  it("returns an empty pile for an empty vault", () => {
    expect(buildPile([], 3)).toEqual({
      columns: [],
      baseWidth: 0,
      initialRows: 0,
      steepness: 1,
    });
  });

  it("holds one grain per note", () => {
    expect(grainCount(buildPile(notes([10, 20, 30, 40, 50]), 2))).toBe(5);
  });

  it("sinks the oldest note to the bottom center", () => {
    const pile = buildPile(notes([1, 2, 500, 3]), 1);
    const center = (pile.baseWidth - 1) / 2;
    const bottomCenter = pile.columns[center][0];
    expect(bottomCenter.path).toBe("n2.md"); // ageDays 500
    expect(bottomCenter.ageNorm).toBe(1); // darkest
  });

  it("spreads candidates across the age range, oldest always included", () => {
    const pile = buildPile(notes([10, 90, 30, 70, 50]), 2);
    const flagged = pile.columns
      .flat()
      .filter((g) => g.isCandidate)
      .map((g) => g.path)
      .sort();
    // Stride sampling over ages [90, 70, 50, 30, 10] → indices 0 and 2.
    expect(flagged).toEqual(["n1.md", "n4.md"]); // ages 90 and 50
  });

  it("is deterministic for the same input", () => {
    const input = notes([12, 44, 7, 99, 33, 5]);
    expect(buildPile(input, 3)).toEqual(buildPile(input, 3));
  });

  it("builds a taller, narrower mound at higher steepness", () => {
    const input = notes(Array.from({ length: 36 }, (_, i) => 36 - i));
    const flat = buildPile(input, 0, 1);
    const steep = buildPile(input, 0, 4);
    expect(steep.initialRows).toBeGreaterThan(flat.initialRows);
    expect(steep.baseWidth).toBeLessThan(flat.baseWidth);
  });

  it("keeps a steep mound stable under its own angle of repose", () => {
    const input = notes(Array.from({ length: 25 }, (_, i) => 25 - i));
    const pile = buildPile(input, 0, 3);
    const before = pile.columns.map((col) => col.map((g) => g.path));
    relaxPile(pile); // freshly built pile must already be settled
    expect(pile.columns.map((col) => col.map((g) => g.path))).toEqual(before);
  });
});

describe("removeFromPile", () => {
  it("drops exactly the judged grain and keeps the pile settled", () => {
    const pile = buildPile(notes([9, 8, 7, 6, 5, 4, 3, 2, 1]), 3);
    const before = grainCount(pile);
    expect(removeFromPile(pile, "n0.md")).toBe(true); // the oldest, core-bottom
    expect(grainCount(pile)).toBe(before - 1);
    expect(pile.columns.flat().some((g) => g.path === "n0.md")).toBe(false);
    expect(isSettled(pile)).toBe(true);
  });

  it("returns false for a path not in the pile", () => {
    const pile = buildPile(notes([9, 8]), 1);
    expect(removeFromPile(pile, "ghost.md")).toBe(false);
    expect(grainCount(pile)).toBe(2);
  });
});

describe("relaxPile", () => {
  it("topples a spike until no step is 2+ high", () => {
    const pile = buildPile(notes([9, 8, 7, 6]), 1);
    // Fake a spike: stack everything onto the center column.
    const all = pile.columns.flat();
    pile.columns = pile.columns.map(() => []);
    pile.columns[(pile.baseWidth - 1) / 2] = all;
    relaxPile(pile);
    expect(isSettled(pile)).toBe(true);
    expect(grainCount(pile)).toBe(4); // topples move, never destroy
  });
});

describe("refillCandidates", () => {
  it("keeps the red count topped up after a candidate is judged", () => {
    const pile = buildPile(notes([90, 80, 70, 60, 50, 40, 30, 20, 10]), 3);
    const firstReds = pile.columns.flat().filter((g) => g.isCandidate);
    removeFromPile(pile, firstReds[0].path);
    refillCandidates(pile, 3);
    expect(pile.columns.flat().filter((g) => g.isCandidate).length).toBe(3);
  });

  it("never exceeds the remaining grain count", () => {
    const pile = buildPile(notes([30, 20, 10]), 7);
    refillCandidates(pile, 7);
    expect(pile.columns.flat().filter((g) => g.isCandidate).length).toBe(3);
  });
});

describe("isUnderFolder", () => {
  it("matches notes inside an excluded folder, at any depth", () => {
    expect(isUnderFolder("diary/2020/a.md", ["diary"])).toBe(true);
    expect(isUnderFolder("diary/a.md", ["diary/"])).toBe(true);
  });

  it("matches whole path segments only", () => {
    expect(isUnderFolder("diary-old/a.md", ["diary"])).toBe(false);
    expect(isUnderFolder("a.md", ["diary"])).toBe(false);
  });

  it("ignores empty entries and empty lists", () => {
    expect(isUnderFolder("diary/a.md", [""])).toBe(false);
    expect(isUnderFolder("diary/a.md", [])).toBe(false);
  });
});

describe("tidying log", () => {
  it("round-trips its own lines and skips headers/blanks", () => {
    const content =
      "# katazuke log — one line per tidied note\n\n" +
      formatLogLine("2026-07-15", "old/a.md") +
      formatLogLine("2026-07-16", "old/b.md") +
      formatLogLine("2026-07-16", "old/c d.md");
    expect(parseLog(content)).toEqual({
      total: 3,
      byDay: { "2026-07-15": 1, "2026-07-16": 2 },
    });
  });

  it("tolerates lines humans edited into the file", () => {
    expect(parseLog("meeting notes\n2026-13-99 not-a-date? fine\n").total).toBe(
      1, // the regex only checks shape, not calendar validity — good enough
    );
    expect(parseLog("2026-07-16\n").total).toBe(0); // date but no path
  });

  it("zero-fills the trailing window in order", () => {
    const days = lastNDays({ "2026-07-14": 2 }, 3, "2026-07-16");
    expect(days).toEqual([
      { day: "2026-07-14", count: 2 },
      { day: "2026-07-15", count: 0 },
      { day: "2026-07-16", count: 0 },
    ]);
  });
});
