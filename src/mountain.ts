// Pure, testable pile model for the clutter mountain (たまりの山).
//
// Each stale orphan note is one grain in a pile of column stacks. The initial
// fill is a triangle: the oldest (most neglected) notes sink to the dense core
// at the bottom center; fresher ones sit on the lighter outer slopes.
//
// Judging a note removes its grain, and gravity does the rest LOCALLY: grains
// above it drop down the same column, then a small sandpile rule topples any
// column that now towers 2+ over a neighbor. Nothing else moves — the mound
// visibly settles instead of reshuffling wholesale.
//
// No randomness: the same vault state and the same judgments always yield the
// same pile, so the picture is a faithful readout, not decoration.

import type { ClutterNote } from "./lib";

export interface Grain {
  path: string;
  ageDays: number;
  // Staleness in [0,1] (1 = oldest at build time); drives how dark it draws.
  ageNorm: number;
  // Surfaced to judge right now (drawn in the crimson accent).
  isCandidate: boolean;
}

export interface Pile {
  // columns[c] is a bottom-up stack of grains at column c.
  columns: Grain[][];
  baseWidth: number;
  // Tallest column at build time; the renderer keeps its pixel pitch fixed to
  // this so the mound genuinely gets lower as grains leave.
  initialRows: number;
  // Angle of repose, in rows per column step. 1 = the classic 45° triangle;
  // higher values build a steeper, taller mound (for portrait panes) and let
  // columns tower that much over a neighbor before toppling.
  steepness: number;
}

// Grains a steep triangle of base width W can hold: every 2-column narrowing
// lasts `steepness` rows, so each odd width W, W-2, ... 1 contributes
// width * steepness grains.
function pileCapacity(baseWidth: number, steepness: number): number {
  let total = 0;
  for (let width = baseWidth; width >= 1; width -= 2) {
    total += width * steepness;
  }
  return total;
}

// Column indices (absolute, within the base row) for a row of `width` grains
// starting at `offset`, ordered center-out so a partially filled top row stays
// symmetric and density concentrates toward the middle.
function centerOutColumns(width: number, offset: number): number[] {
  const mid = (width - 1) / 2;
  return [...Array(width).keys()]
    .sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b)
    .map((k) => offset + k);
}

// Stride-sample `want` paths across an age-sorted list: index 0 (the oldest)
// is always included, the rest scatter across the age range so the red dots
// pepper the mound instead of fusing into a blob at the core.
function strideSample(byAge: Grain[] | ClutterNote[], want: number): string[] {
  const n = byAge.length;
  const k = Math.max(0, Math.min(want, n));
  const picked: string[] = [];
  for (let i = 0; i < k; i++) picked.push(byAge[Math.floor((i * n) / k)].path);
  return picked;
}

export function buildPile(
  notes: ClutterNote[],
  candidateCount: number,
  steepness = 1,
): Pile {
  const n = notes.length;
  const k = Math.max(1, Math.floor(steepness));
  if (n === 0)
    return { columns: [], baseWidth: 0, initialRows: 0, steepness: k };

  // Oldest first → they fill the bottom, forming the dense core.
  const byAge = [...notes].sort(
    (a, b) => b.ageDays - a.ageDays || a.path.localeCompare(b.path),
  );
  const candidates = new Set(strideSample(byAge, candidateCount));
  const maxAge = byAge[0].ageDays || 1;

  // Widen the base until the steep triangle holds every grain; the top rows
  // may be partial.
  let baseWidth = 1;
  while (pileCapacity(baseWidth, k) < n) baseWidth += 2;

  const columns: Grain[][] = Array.from({ length: baseWidth }, () => []);
  let idx = 0;
  let rowsUsed = 0;
  for (let r = 0; idx < n; r++) {
    const inset = Math.floor(r / k); // narrow by one column per side every k rows
    const width = baseWidth - 2 * inset;
    if (width < 1) break;
    rowsUsed = r + 1;
    for (const col of centerOutColumns(width, inset)) {
      if (idx >= n) break;
      const note = byAge[idx++];
      columns[col].push({
        path: note.path,
        ageDays: note.ageDays,
        ageNorm: Math.min(1, note.ageDays / maxAge),
        isCandidate: candidates.has(note.path),
      });
    }
  }
  return { columns, baseWidth, initialRows: rowsUsed, steepness: k };
}

// Sandpile relaxation: while any column towers more than the angle of repose
// (steepness + 1 grains) over a neighbor, its top grain topples onto the lower
// side (ties fall left). Off-grid space is treated as infinitely tall so the
// base never spreads wider. Mutates in place.
export function relaxPile(pile: Pile): void {
  const cols = pile.columns;
  const W = cols.length;
  const over = pile.steepness + 1;
  const h = (c: number) => (c < 0 || c >= W ? Infinity : cols[c].length);
  let moved = true;
  let guard = 0;
  const maxIters = W * W + 100; // generous; each topple strictly lowers energy
  while (moved && guard++ < maxIters) {
    moved = false;
    for (let c = 0; c < W; c++) {
      const target = h(c - 1) <= h(c + 1) ? c - 1 : c + 1;
      if (h(target) + over <= cols[c].length) {
        cols[target].push(cols[c].pop() as Grain);
        moved = true;
      }
    }
  }
}

// Remove one judged grain. Grains above it fall down the column (the splice),
// then the slope re-settles. Returns false if the path isn't in the pile.
export function removeFromPile(pile: Pile, path: string): boolean {
  for (const stack of pile.columns) {
    const i = stack.findIndex((g) => g.path === path);
    if (i >= 0) {
      stack.splice(i, 1);
      relaxPile(pile);
      return true;
    }
  }
  return false;
}

// Keep `want` red candidates on screen: after judging one, re-run the stride
// sample over the remaining grains and flag what's missing. Already-red grains
// keep their flag so the picture never flickers.
export function refillCandidates(pile: Pile, want: number): void {
  const all = pile.columns.flat();
  let need =
    Math.min(want, all.length) - all.filter((g) => g.isCandidate).length;
  if (need <= 0) return;
  const byAge = [...all].sort(
    (a, b) => b.ageDays - a.ageDays || a.path.localeCompare(b.path),
  );
  const flagged = new Set(strideSample(byAge, want));
  for (const g of byAge) {
    if (need <= 0) break;
    if (flagged.has(g.path) && !g.isCandidate) {
      g.isCandidate = true;
      need--;
    }
  }
  // The stride can land on already-red grains; backfill with the oldest.
  for (const g of byAge) {
    if (need <= 0) break;
    if (!g.isCandidate) {
      g.isCandidate = true;
      need--;
    }
  }
}
