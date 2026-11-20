/**
 * Draws the destructible grid in 16x16-cell chunks; only chunks whose cells
 * changed (material or crack stage) are redrawn.
 */
import { Container, Graphics } from "pixi.js";
import { CELL, F_ANCHOR, F_BRIDGE, Mat, MAT_HP, type Grid } from "../sim/grid";
import type { PieceCell } from "../sim/terrain";
import { shade, type Palette } from "./palette";

const CH = 16;

function crackStage(hp: number, mat: number): number {
  const max = MAT_HP[mat] ?? 1;
  if (!isFinite(max)) return 0;
  const k = hp / max;
  return k < 0.34 ? 2 : k < 0.67 ? 1 : 0;
}

/** Cheap per-cell hash for texture variation. */
function h(cx: number, cy: number): number {
  let x = (cx * 374761393 + cy * 668265263) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** One cell at world (x, y) = bottom-left, in a y-down Graphics. */
export function drawCell(g: Graphics, pal: Palette, x: number, y: number, mat: number, stage: number, exposedTop: boolean, exposedBottom: boolean, deep: boolean, flags: number, cx: number, cy: number) {
  const s = CELL;
  const top = -(y + s);
  let col = pal.mat[mat] ?? 0x888888;
  if (deep) col = shade(col, 0.72);
  else col = shade(col, 0.94 + h(cx, cy) * 0.12);
  g.rect(x, top, s, s).fill(col);
  switch (mat) {
    case Mat.Bedrock:
      g.moveTo(x, top + s).lineTo(x + s, top).stroke({ width: 0.04, color: 0x2e2a3d });
      break;
    case Mat.Brick: {
      const off = cy % 2 ? s / 2 : 0;
      g.rect(x, top + s / 2 - 0.015, s, 0.03).fill({ color: 0x000000, alpha: 0.25 });
      g.rect(x + off - 0.015, top, 0.03, s / 2).fill({ color: 0x000000, alpha: 0.25 });
      break;
    }
    case Mat.Wood:
      g.rect(x, top + s * 0.48, s, 0.03).fill({ color: 0x000000, alpha: 0.3 });
      g.circle(x + 0.08, top + 0.12, 0.025).fill(0x2a1a0e);
      g.circle(x + s - 0.08, top + 0.12, 0.025).fill(0x2a1a0e);
      break;
    case Mat.Steel:
      g.moveTo(x, top).lineTo(x + s, top + s).moveTo(x + s, top).lineTo(x, top + s).stroke({ width: 0.035, color: shade(col, 0.6) });
      g.circle(x + 0.07, top + 0.07, 0.025).fill(shade(col, 1.4));
      break;
    case Mat.Crumble:
      g.circle(x + 0.12 + h(cx, cy) * 0.2, top + 0.2, 0.03).fill({ color: 0x000000, alpha: 0.3 });
      g.circle(x + 0.3, top + 0.35 - h(cy, cx) * 0.1, 0.025).fill({ color: 0x000000, alpha: 0.3 });
      break;
    case Mat.Dirt:
      if (h(cx, cy) > 0.6) g.circle(x + h(cy, cx) * s, top + h(cx + 1, cy) * s, 0.03).fill({ color: 0x000000, alpha: 0.2 });
      break;
    case Mat.Rock:
      g.circle(x + s / 2, top + s / 2, 0.16).fill({ color: 0xffffff, alpha: 0.08 });
      break;
    case Mat.Concrete:
      if ((cx + cy) % 3 === 0) g.rect(x, top, 0.025, s).fill({ color: 0x000000, alpha: 0.12 });
      break;
  }
  if (exposedTop) g.rect(x, top, s, 0.09).fill(pal.top[mat] ?? shade(col, 1.35));
  if (exposedBottom && !deep) g.rect(x, top + s - 0.05, s, 0.05).fill({ color: 0x000000, alpha: 0.3 });
  if (flags & F_BRIDGE) g.rect(x, top + s - 0.06, s, 0.06).fill({ color: 0x000000, alpha: 0.35 });
  if (stage >= 1) g.moveTo(x + 0.1, top + 0.08).lineTo(x + 0.24, top + 0.26).lineTo(x + 0.18, top + 0.42).stroke({ width: 0.035, color: 0x0b0a10, alpha: 0.85 });
  if (stage >= 2) g.moveTo(x + 0.42, top + 0.1).lineTo(x + 0.28, top + 0.3).lineTo(x + 0.4, top + 0.46).stroke({ width: 0.035, color: 0x0b0a10, alpha: 0.85 });
}

export class TerrainView {
  readonly container = new Container();
  private readonly chunks: Graphics[] = [];
  private readonly sig: Uint8Array;
  private readonly cols: number;
  private readonly rows: number;

  constructor(
    private readonly grid: Grid,
    private readonly pal: Palette,
  ) {
    this.cols = Math.ceil(grid.cols / CH);
    this.rows = Math.ceil(grid.rows / CH);
    this.sig = new Uint8Array(grid.cols * grid.rows).fill(255);
    for (let k = 0; k < this.cols * this.rows; k++) {
      const g = new Graphics();
      this.container.addChild(g);
      this.chunks.push(g);
    }
  }

  /** Redraw chunks whose cells changed since last frame. */
  update() {
    const g = this.grid;
    const dirty = new Set<number>();
    for (let cy = 0; cy < g.rows; cy++) {
      for (let cx = 0; cx < g.cols; cx++) {
        const i = cy * g.cols + cx;
        const m = g.mat[i]!;
        const s = m === Mat.Empty ? 0 : m * 4 + crackStage(g.hp[i]!, m) + 1;
        if (s !== this.sig[i]) {
          this.sig[i] = s;
          const k = Math.floor(cy / CH) * this.cols + Math.floor(cx / CH);
          dirty.add(k);
          // neighbors' edge highlights change too
          if (cy % CH === 0 && cy > 0) dirty.add(k - this.cols);
          if (cy % CH === CH - 1 && cy < g.rows - 1) dirty.add(k + this.cols);
        }
      }
    }
    for (const k of dirty) this.drawChunk(k);
  }

  private drawChunk(k: number) {
    const g = this.grid;
    const gr = this.chunks[k]!;
    gr.clear();
    const kx = k % this.cols;
    const ky = Math.floor(k / this.cols);
    for (let cy = ky * CH; cy < Math.min(g.rows, ky * CH + CH); cy++) {
      for (let cx = kx * CH; cx < Math.min(g.cols, kx * CH + CH); cx++) {
        const i = cy * g.cols + cx;
        const m = g.mat[i]!;
        if (m === Mat.Empty) continue;
        let above = 0;
        for (let a = 1; a <= 4 && g.solid(cx, cy + a); a++) above++;
        drawCell(gr, this.pal, g.wx(cx), g.wy(cy), m, crackStage(g.hp[i]!, m), !g.solid(cx, cy + 1), !g.solid(cx, cy - 1), above >= 4, g.flags[i]!, cx, cy);
        if (g.flags[i]! & F_ANCHOR) {
          // anchor bolt; the chain above it is drawn by ChainView (chains.ts) up to the top of the view
          const x = g.wx(cx) + CELL / 2;
          const y = -(g.wy(cy) + CELL);
          gr.circle(x, y + CELL / 2, 0.09).fill(0x2a2a30).stroke({ width: 0.03, color: 0xb0b0b8 });
        }
      }
    }
  }
}

/** Draw a loose piece's cells in its local frame. */
export function drawPiece(gr: Graphics, pal: Palette, cells: PieceCell[]) {
  gr.clear();
  const at = new Set(cells.map((c) => c.ly * 4096 + c.lx));
  for (const c of cells) {
    const x = c.lx * CELL;
    const y = c.ly * CELL;
    drawCell(gr, pal, x, y, c.mat, crackStage(c.hp, c.mat), !at.has((c.ly + 1) * 4096 + c.lx), !at.has((c.ly - 1) * 4096 + c.lx), false, 0, c.lx, c.ly);
  }
}

export function pieceSig(cells: PieceCell[]): string {
  let s = "";
  for (const c of cells) s += `${c.lx},${c.ly},${crackStage(c.hp, c.mat)};`;
  return s;
}
