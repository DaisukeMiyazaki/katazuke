import { ItemView, WorkspaceLeaf } from "obsidian";
import type { ClutterNote } from "./lib";
import type { Strings } from "./lib";
import {
  Grain,
  Pile,
  buildPile,
  refillCandidates,
  removeFromPile,
} from "./mountain";

export const MOUNTAIN_VIEW_TYPE = "katazuke-mountain";

// Palettes tuned to the warm greige / dusty-crimson mock: quiet, slightly
// melancholic, with the accent reserved for the notes asking to be judged.
// In both themes the OLDER a grain, the more it contrasts with the paper —
// dark sediment on light paper, pale bone on dark paper.
interface Palette {
  bg: string;
  fresh: number[];
  stale: number[];
  candidate: string;
  empty: string;
}

const PALETTES: Record<"light" | "dark", Palette> = {
  light: {
    bg: "#EDE9E1",
    fresh: [204, 198, 186],
    stale: [96, 89, 78],
    candidate: "#B0475C",
    empty: "#B7B0A4",
  },
  dark: {
    bg: "#211F1C",
    fresh: [82, 77, 70],
    stale: [186, 178, 164],
    candidate: "#C75A6E",
    empty: "#6B655C",
  },
};

// Resolved by the plugin from settings + the live Obsidian theme/accent.
export interface PaletteChoice {
  theme: "light" | "dark";
  accent: string | null;
}

const SETTLE_MS = 550;

// One grain's live pixel state, tweened between pile snapshots.
interface GrainState {
  grain: Grain;
  x: number;
  y: number;
  r: number;
  a: number; // alpha
}

interface Target {
  grain: Grain;
  x: number;
  y: number;
  r: number;
}

// Falling grains accelerate (gravity); the judged grain's dust puff decelerates.
function easeInQuad(t: number): number {
  return t * t;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

// Interpolate fresh → stale by staleness so the mound's old core stands out
// ("奥ほど手強い" reads straight off the picture).
function grainColor(pal: Palette, ageNorm: number): string {
  const c = pal.fresh.map((f, i) =>
    Math.round(f + (pal.stale[i] - f) * ageNorm),
  );
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

// Deterministic per-note jitter in [-0.5, 0.5]² (FNV-1a hash). The same note
// always sits in the same spot, but the pile stops looking like graph paper.
function jitter(path: string): [number, number] {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return [((h >>> 16) & 255) / 255 - 0.5, (h & 255) / 255 - 0.5];
}

export class MountainView extends ItemView {
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  // The pile is ONE sitting's worth (pileSize grains), not the whole backlog —
  // a mound you can actually finish. It is built once and then only loses
  // grains; positions are sticky so a judgment reads as LOCAL collapse, not a
  // wholesale reshuffle. Clearing it reveals how many notes still wait, and a
  // click raises the next pile.
  private pile: Pile | null = null;
  private states = new Map<string, GrainState>();
  private raf: number | null = null;
  private layoutRetries = 0;
  // Notes waiting beyond the current pile (shown in the cleared message).
  private waiting = 0;

  constructor(
    leaf: WorkspaceLeaf,
    private strings: Strings,
    // Pulled fresh each refresh so the mound reflects the live vault (and any
    // notes judged this session, which the plugin filters out).
    private getClutter: () => ClutterNote[],
    private candidateCount: () => number,
    private pileSize: () => number,
    private getPalette: () => PaletteChoice,
    private onJudge: (path: string) => void,
  ) {
    super(leaf);
  }

  // Repaint with current colors (theme/accent changed, no layout change).
  repaint(): void {
    this.drawFrame();
  }

  private palette(): Palette {
    const choice = this.getPalette();
    const base = PALETTES[choice.theme];
    return choice.accent ? { ...base, candidate: choice.accent } : base;
  }

  getViewType(): string {
    return MOUNTAIN_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.strings.mountainTitle;
  }

  getIcon(): string {
    return "mountain";
  }

  async onOpen(): Promise<void> {
    const host = this.contentEl;
    host.empty();
    host.addClass("katazuke-mountain-host");
    this.canvas = host.createEl("canvas", { cls: "katazuke-mountain-canvas" });
    this.ctx = this.canvas.getContext("2d") as CanvasRenderingContext2D;
    this.canvas.addEventListener("click", (e) => this.handleClick(e));
    this.refresh();
  }

  async onClose(): Promise<void> {
    if (this.raf !== null) window.cancelAnimationFrame(this.raf);
    this.contentEl.empty();
  }

  // On resize, keep the pile if the pane kept roughly its shape; if its aspect
  // changed enough to want a different angle of repose, rebuild the mound to
  // fill the new shape. Either way snap — animating through a resize is jelly.
  onResize(): void {
    if (
      !this.pile ||
      this.effectiveSteepness(this.grainsLeft()) !== this.pile.steepness
    ) {
      this.pile = null;
      this.states.clear();
      this.refresh();
      return;
    }
    this.snapTo(this.targets());
  }

  // Rows per column step that make the mound's silhouette match the pane:
  // a squat wide pane wants the classic 45° triangle, a tall sidebar pane a
  // steep peak. Derived from n ≈ steepness * (baseWidth/2)^2 and the pane's
  // width/height ratio. Small piles are clamped toward squat — ten boulders
  // should heap, not stack into a tower.
  private effectiveSteepness(n: number): number {
    const w = this.canvas.clientWidth || 640;
    const h = this.canvas.clientHeight || 420;
    const aspect = (w * 0.96) / (h * 0.88);
    const desired = Math.max(1, Math.min(8, Math.round(2 / (0.85 * aspect))));
    return Math.min(desired, Math.max(1, Math.round(n / 8)));
  }

  private grainsLeft(): number {
    return this.pile
      ? this.pile.columns.reduce((sum, col) => sum + col.length, 0)
      : 0;
  }

  // Raise a new pile: the `pileSize` most neglected notes, oldest first — the
  // dustiest corner of the vault, sized to be finished in one sitting.
  private raisePile(): void {
    const full = this.getClutter();
    const session = [...full]
      .sort((a, b) => b.ageDays - a.ageDays || a.path.localeCompare(b.path))
      .slice(0, Math.max(1, this.pileSize()));
    this.waiting = full.length - session.length;
    this.pile = buildPile(
      session,
      this.redCount(session.length),
      this.effectiveSteepness(session.length),
    );
    if (this.states.size === 0) this.snapTo(this.targets());
    else this.animateTo(this.targets());
  }

  // Sync the pile with the vault: judged (or externally deleted) notes collapse
  // out of the mound in place. When the pile empties, the cleared message
  // shows what still waits; the NEXT pile only rises on an explicit click —
  // finishing must feel like finishing.
  refresh(): void {
    // The pane may not be laid out yet right after onOpen; wait for real
    // dimensions so the mound is built for the shape it will live in. Bounded
    // retries — a hidden pane gets its layout on onResize when revealed.
    if (!this.canvas.clientWidth || !this.canvas.clientHeight) {
      if (this.layoutRetries++ < 30) {
        window.requestAnimationFrame(() => this.refresh());
      }
      return;
    }
    this.layoutRetries = 0;

    if (!this.pile) {
      this.raisePile();
      return;
    }

    const fresh = new Set(this.getClutter().map((n) => n.path));
    let removed = false;
    for (const g of this.pile.columns.flat()) {
      if (!fresh.has(g.path))
        removed = removeFromPile(this.pile, g.path) || removed;
    }
    this.waiting = fresh.size - this.grainsLeft();
    if (!removed) return;
    refillCandidates(this.pile, this.redCount(this.grainsLeft()));
    this.animateTo(this.targets());
  }

  // Red "start here" pointers: the batch setting, but never more than a third
  // of the pile — a mound that's mostly red is a to-do list, not a suggestion.
  private redCount(grains: number): number {
    return Math.min(this.candidateCount(), Math.max(1, Math.ceil(grains / 3)));
  }

  // Pixel geometry. The mound FILLS the pane — this view lives in a small
  // sidebar, so quiet emptiness is a bug, not breathing room. The pitch is
  // sized to the pile's ORIGINAL height and kept there, so as grains leave,
  // the mound genuinely gets lower on screen.
  //
  // Grains render as a heap, not graph paper: alternate rows stagger by half a
  // pitch (like stacked rice bales), radii slightly overlap the pitch so the
  // mass fuses into one silhouette, and each grain keeps a small deterministic
  // jitter so nothing lines up too perfectly.
  private targets(): Map<string, Target> {
    const out = new Map<string, Target>();
    const pile = this.pile;
    if (!pile || pile.baseWidth === 0) return out;
    const w = this.canvas.clientWidth || 640;
    const h = this.canvas.clientHeight || 420;
    const W = pile.baseWidth;
    const rows = Math.max(1, pile.initialRows);
    const pitch = Math.min(
      (w * 0.96) / (W + 0.5),
      (h * 0.88) / (rows * 0.8),
      64,
    );
    const dy = pitch * 0.8;
    const floor = h - pitch;
    for (let c = 0; c < W; c++) {
      const stack = pile.columns[c];
      for (let i = 0; i < stack.length; i++) {
        const g = stack[i];
        const [jx, jy] = jitter(g.path);
        const stagger = i % 2 === 1 ? 0.5 : 0;
        out.set(g.path, {
          grain: g,
          x:
            w / 2 +
            (c - (W - 1) / 2 + stagger - 0.25) * pitch +
            jx * pitch * 0.14,
          y: floor - i * dy + jy * pitch * 0.14,
          r: Math.max(3, pitch * 0.52),
        });
      }
    }
    return out;
  }

  private snapTo(targets: Map<string, Target>): void {
    if (this.raf !== null) window.cancelAnimationFrame(this.raf);
    this.raf = null;
    this.states = new Map(
      [...targets].map(([path, t]) => [
        path,
        { grain: t.grain, x: t.x, y: t.y, r: t.r, a: 1 },
      ]),
    );
    this.drawFrame();
  }

  // Tween every grain from where it is to where it belongs. Grains that left
  // the pile (judged) puff away — drift up, swell, fade — while the ones above
  // the hole drop and the slope topples into place. Interrupting mid-flight
  // starts from the current interpolated state, so rapid judging stays smooth.
  private animateTo(targets: Map<string, Target>): void {
    if (this.raf !== null) window.cancelAnimationFrame(this.raf);

    interface Tween {
      grain: Grain;
      sx: number; sy: number; sr: number; sa: number;
      tx: number; ty: number; tr: number; ta: number;
      remove: boolean;
    }
    const tweens: Tween[] = [];
    for (const [path, t] of targets) {
      const cur = this.states.get(path);
      tweens.push({
        grain: t.grain,
        sx: cur?.x ?? t.x,
        sy: cur?.y ?? t.y,
        sr: cur?.r ?? 0,
        sa: cur?.a ?? 0,
        tx: t.x, ty: t.y, tr: t.r, ta: 1,
        remove: false,
      });
    }
    for (const [path, cur] of this.states) {
      if (targets.has(path)) continue;
      tweens.push({
        grain: cur.grain,
        sx: cur.x, sy: cur.y, sr: cur.r, sa: cur.a,
        tx: cur.x + (Math.random() - 0.5) * cur.r * 8,
        ty: cur.y - cur.r * 10,
        tr: cur.r * 2.2,
        ta: 0,
        remove: true,
      });
    }

    const t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / SETTLE_MS);
      const next = new Map<string, GrainState>();
      for (const tw of tweens) {
        if (k >= 1 && tw.remove) continue;
        // Dust floats out; everything still in the pile falls with gravity.
        const e = tw.remove ? easeOutCubic(k) : easeInQuad(k);
        next.set(tw.grain.path, {
          grain: tw.grain,
          x: tw.sx + (tw.tx - tw.sx) * e,
          y: tw.sy + (tw.ty - tw.sy) * e,
          r: tw.sr + (tw.tr - tw.sr) * e,
          a: tw.sa + (tw.ta - tw.sa) * e,
        });
      }
      this.states = next;
      this.drawFrame();
      this.raf = k < 1 ? window.requestAnimationFrame(step) : null;
    };
    this.raf = window.requestAnimationFrame(step);
  }

  // Paint the current grain states: bulk greige first, red candidates on top.
  private drawFrame(): void {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 640;
    const h = canvas.clientHeight || 420;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const pal = this.palette();
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, w, h);

    if (this.states.size === 0) {
      const msg =
        this.waiting > 0
          ? this.strings.mountainCleared.replace("{n}", String(this.waiting))
          : this.strings.mountainEmpty;
      ctx.fillStyle = pal.empty;
      ctx.font = "14px var(--font-interface, sans-serif)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(msg, w / 2, h / 2);
      return;
    }

    // Back-to-front (top of the mound first), dust puffs last so they float
    // over everything. A hairline paper-colored ring keeps overlapping grains
    // readable as separate stones.
    const ordered = [...this.states.values()].sort(
      (p, q) => (p.a < 1 ? 1 : 0) - (q.a < 1 ? 1 : 0) || p.y - q.y,
    );
    for (const s of ordered) {
      ctx.globalAlpha = s.a;
      ctx.fillStyle = s.grain.isCandidate
        ? pal.candidate
        : grainColor(pal, s.grain.ageNorm);
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = Math.max(1, s.r * 0.12);
      ctx.strokeStyle = pal.bg;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private handleClick(e: MouseEvent): void {
    // On a cleared mound, a click raises the next pile.
    if (this.grainsLeft() === 0) {
      if (this.waiting > 0) this.raisePile();
      return;
    }
    const hit = this.hitTest(e.offsetX, e.offsetY);
    // Any grain in a finishable pile is judgeable — the red ones are only the
    // suggested "start here" pointers, not the only doors.
    if (hit) this.onJudge(hit);
  }

  // Nearest grain within a forgiving radius of the cursor.
  private hitTest(x: number, y: number): string | null {
    let best: string | null = null;
    let bestD = Infinity;
    for (const s of this.states.values()) {
      const dx = s.x - x;
      const dy = s.y - y;
      const d = dx * dx + dy * dy;
      const tol = (s.r * 1.4) * (s.r * 1.4);
      if (d <= tol && d < bestD) {
        bestD = d;
        best = s.grain.path;
      }
    }
    return best;
  }
}
