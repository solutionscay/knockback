/**
 * Draws the destructible grid in 16x16-cell chunks of plush terrain sprites (#92, level-art.ts); only chunks whose
 * cells changed (material, crack stage, burn, or a neighbour carved away) are redrawn.
 *
 * A cell is its material's felt tile (two variants, picked by a per-cell hash), darker deep inside the ground. On top
 * of it: the theme's top edge where nothing is above, dark piping on any other exposed side (so a carved hole shows
 * its sewn edge), a tear overlay per crack stage, scorched felt when it burned out, and the bolt of a chain anchor.
 */
import { Container, Sprite } from "pixi.js";
import { CELL, F_ANCHOR, F_BRIDGE, F_CHARRED, F_ONEWAY, MAT_HP, Mat, type Grid } from "../sim/grid";
import { MAT_NAMES, type Theme } from "../sim/themes";
import type { PieceCell } from "../sim/terrain";
import { levelFrame, levelReady } from "./level-art";

const CH = 16;
const MAT_NAME: readonly string[] = MAT_NAMES;

export function crackStage(hp: number, mat: number): number {
  const max = MAT_HP[mat] ?? 1;
  if (!isFinite(max)) return 0;
  const k = hp / max;
  return k < 0.34 ? 2 : k < 0.67 ? 1 : 0;
}

/** Cheap per-cell hash for variation. */
function h(cx: number, cy: number): number {
  let x = (cx * 374761393 + cy * 668265263) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** Sprites reused from one redraw to the next. */
export class Pool {
  private i = 0;
  constructor(readonly c: Container) {}
  begin() {
    this.i = 0;
  }
  /** A sprite showing `name` with its top-left at (x, y) (y down, meters), or null if the frame isn't loaded. */
  put(theme: Theme, name: string, x: number, y: number, tint = 0xffffff, alpha = 1): Sprite | null {
    const f = levelFrame(theme, name);
    if (!f) return null;
    let s = this.c.children[this.i] as Sprite | undefined;
    if (!s) s = this.c.addChild(new Sprite());
    this.i++;
    s.visible = true;
    s.texture = f.tex;
    s.position.set(x - f.ax, y - f.ay);
    s.scale.set(f.w / f.tex.frame.width, f.h / f.tex.frame.height);
    s.tint = tint;
    s.alpha = alpha;
    return s;
  }
  end() {
    const k = this.c.children;
    for (let j = this.i; j < k.length; j++) k[j]!.visible = false;
  }
}

interface Exposed { top: boolean; bottom: boolean; left: boolean; right: boolean }

/**
 * #134: the shape of a hanging rock cell (a stalactite's, a step in a cave ceiling's underside), drawn round from the
 * theme's st-<shape>-<crack stage> frames instead of a square cell: both sides open and rock above it, a tip (nothing
 * under it) or a tapered mid segment (rock under it, not standing on the ground: a pillar keeps its square cells); one
 * side and the bottom open, a shoulder flaring in from that side. Null: a square cell.
 */
function hangShape(ex: Exposed, above: boolean, grounded: () => boolean): string | null {
  if (ex.left && ex.right) return !above ? null : ex.bottom ? "tip" : grounded() ? null : "mid";
  if (ex.bottom && ex.left) return "l";
  if (ex.bottom && ex.right) return "r";
  return null;
}

/** One cell with its bottom-left at world (x, y), drawn y-down. */
function drawCell(p: Pool, theme: Theme, x: number, y: number, mat: number, stage: number, ex: Exposed, deep: boolean, flags: number, cx: number, cy: number, shape: string | null = null) {
  const top = -(y + CELL);
  const m = MAT_NAME[mat];
  if (!m) return;
  const r = h(cx, cy);
  const k = deep ? 0.72 : 0.92 + r * 0.08;
  const c = Math.round(255 * k);
  // #134: a round hanging-rock frame carries its own soft edges and its own tears: no square cell, piping or overlay
  if (shape && mat === Mat.Rock && p.put(theme, `st-${shape}-${stage}`, x, top, (c << 16) | (c << 8) | c)) {
    if (ex.top) p.put(theme, `t-${m}`, x, top);
    return;
  }
  // #100: a jump-through cell reads lighter and a little see-through, with no piping under it (nothing to bump into)
  const through = (flags & F_ONEWAY) !== 0;
  p.put(theme, `c-${m}-${r < 0.5 ? 0 : 1}`, x, top, through ? 0xffffff : (c << 16) | (c << 8) | c, through ? 0.78 : 1);
  if (flags & F_CHARRED) p.put(theme, `char-${h(cy, cx) < 0.5 ? 0 : 1}`, x, top, 0xffffff, 0.88);
  if (stage) p.put(theme, `k-${stage}-${h(cx + 7, cy) < 0.5 ? 0 : 1}`, x, top);
  if (ex.left) p.put(theme, "e-l", x, top);
  if (ex.right) {
    const f = levelFrame(theme, "e-r");
    if (f) p.put(theme, "e-r", x + CELL - f.w, top);
  }
  if (((ex.bottom && !deep) || flags & F_BRIDGE) && !through) {
    const f = levelFrame(theme, "e-b");
    if (f) p.put(theme, "e-b", x, top + CELL - f.h);
  }
  if (ex.top) p.put(theme, `t-${m}`, x, top);
}

export class TerrainView {
  readonly container = new Container();
  private readonly chunks: Pool[] = [];
  private readonly sig: Uint8Array;
  private readonly cols: number;
  private readonly rows: number;
  private ready = false;

  constructor(
    private readonly grid: Grid,
    private readonly theme: Theme,
  ) {
    this.cols = Math.ceil(grid.cols / CH);
    this.rows = Math.ceil(grid.rows / CH);
    this.sig = new Uint8Array(grid.cols * grid.rows).fill(255);
    for (let k = 0; k < this.cols * this.rows; k++) {
      const c = new Container();
      this.container.addChild(c);
      this.chunks.push(new Pool(c));
    }
  }

  /** Redraw chunks whose cells changed since last frame (everything, once the theme's art arrives). */
  update() {
    if (!this.ready) {
      if (!levelReady(this.theme)) return;
      this.ready = true;
      this.sig.fill(255);
    }
    const g = this.grid;
    const dirty = new Set<number>();
    for (let cy = 0; cy < g.rows; cy++) {
      for (let cx = 0; cx < g.cols; cx++) {
        const i = cy * g.cols + cx;
        const m = g.mat[i]!;
        const s = m === 0 ? 0 : m * 4 + crackStage(g.hp[i]!, m) + 1 + (g.flags[i]! & F_CHARRED ? 64 : 0) + (g.flags[i]! & F_ONEWAY ? 128 : 0);
        if (s !== this.sig[i]) {
          this.sig[i] = s;
          const k = Math.floor(cy / CH) * this.cols + Math.floor(cx / CH);
          dirty.add(k);
          // neighbours' exposed edges change too
          if (cy % CH === 0 && cy > 0) dirty.add(k - this.cols);
          if (cy % CH === CH - 1 && cy < g.rows - 1) dirty.add(k + this.cols);
          if (cx % CH === 0 && cx > 0) dirty.add(k - 1);
          if (cx % CH === CH - 1 && cx < g.cols - 1) dirty.add(k + 1);
        }
      }
    }
    for (const k of dirty) this.drawChunk(k);
  }

  private drawChunk(k: number) {
    const g = this.grid;
    const p = this.chunks[k]!;
    p.begin();
    const kx = k % this.cols;
    const ky = Math.floor(k / this.cols);
    for (let cy = ky * CH; cy < Math.min(g.rows, ky * CH + CH); cy++) {
      for (let cx = kx * CH; cx < Math.min(g.cols, kx * CH + CH); cx++) {
        const i = cy * g.cols + cx;
        const m = g.mat[i]!;
        if (m === 0) continue;
        let above = 0;
        for (let a = 1; a <= 4 && g.solid(cx, cy + a); a++) above++;
        const ex = { top: !g.solid(cx, cy + 1), bottom: !g.solid(cx, cy - 1), left: !g.solid(cx - 1, cy), right: !g.solid(cx + 1, cy) };
        // (row 0 has nothing under it only because the grid ends there)
        const shape = m === Mat.Rock && cy > 0 ? hangShape(ex, !ex.top, () => {
          let d = cy;
          while (d >= 0 && g.solid(cx, d)) d--;
          return d < 0;
        }) : null;
        drawCell(p, this.theme, g.wx(cx), g.wy(cy), m, crackStage(g.hp[i]!, m), ex, above >= 4, g.flags[i]!, cx, cy, shape);
        if (g.flags[i]! & F_ANCHOR) {
          // the anchor bolt; the chain above it is drawn by ChainView (chains.ts) up to the top of the view
          p.put(this.theme, "anchor", g.wx(cx) + CELL / 2, -(g.wy(cy) + CELL / 2));
        }
      }
    }
    p.end();
  }
}

/** Draw a loose piece's cells in its local frame (a container of sprites, reused). */
export function drawPiece(c: Container, theme: Theme, cells: PieceCell[]) {
  const p = new Pool(c);
  p.begin();
  const at = new Set(cells.map((q) => q.ly * 4096 + q.lx));
  for (const q of cells) {
    const ex = { top: !at.has((q.ly + 1) * 4096 + q.lx), bottom: !at.has((q.ly - 1) * 4096 + q.lx), left: !at.has(q.ly * 4096 + q.lx - 1), right: !at.has(q.ly * 4096 + q.lx + 1) };
    // a falling stalactite keeps its round cells (nothing in a loose piece stands on the ground)
    const shape = q.mat === Mat.Rock ? hangShape(ex, !ex.top, () => false) : null;
    drawCell(p, theme, q.lx * CELL, q.ly * CELL, q.mat, crackStage(q.hp, q.mat), ex, false, q.charred ? F_CHARRED : 0, q.lx, q.ly, shape);
  }
  p.end();
}

export function pieceSig(theme: Theme, cells: PieceCell[]): string {
  let s = levelReady(theme) ? "" : "-";
  for (const c of cells) s += `${c.lx},${c.ly},${crackStage(c.hp, c.mat)}${c.charred ? "c" : ""};`;
  return s;
}
