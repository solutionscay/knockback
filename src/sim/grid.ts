/**
 * The destructible level: a grid of 0.5 m cells. Pure data (no physics), so the
 * generator, validation, navigation and tests can use it headless.
 */
export const CELL = 0.5;

export const enum Mat {
  Empty = 0,
  Dirt = 1,
  Rock = 2,
  Wood = 3,
  Steel = 4,
  Concrete = 5,
  Crumble = 6,
  Bedrock = 7,
  Brick = 8,
}

/** Hit points per material. Bedrock never breaks. */
export const MAT_HP: readonly number[] = [0, 36, 70, 20, 85, 40, 24, Infinity, 32];
/** Density of loose pieces per material. */
export const MAT_DENSITY: readonly number[] = [0, 1.6, 2.4, 0.7, 3.2, 2.2, 0.8, 3, 1.9];

export const F_ANCHOR = 1; // holds up whatever is connected to it (hanging platforms)
export const F_BRIDGE = 2;
export const F_CHARRED = 4; // burned out (#33): blackened, never catches fire again

/** Materials that burn (#33): planks and rotten planks. */
export function flammable(m: number): boolean {
  return m === Mat.Wood || m === Mat.Crumble;
}

export class Grid {
  readonly mat: Uint8Array;
  readonly hp: Float64Array;
  readonly flags: Uint8Array;

  constructor(
    readonly cols: number,
    readonly rows: number,
    readonly x0: number,
    readonly y0: number,
    readonly hitPoints: readonly number[] = MAT_HP,
    readonly density: readonly number[] = MAT_DENSITY,
  ) {
    this.mat = new Uint8Array(cols * rows);
    this.hp = new Float64Array(cols * rows);
    this.flags = new Uint8Array(cols * rows);
  }

  get width() {
    return this.cols * CELL;
  }

  idx(cx: number, cy: number) {
    return cy * this.cols + cx;
  }

  inside(cx: number, cy: number) {
    return cx >= 0 && cy >= 0 && cx < this.cols && cy < this.rows;
  }

  solid(cx: number, cy: number): boolean {
    return this.inside(cx, cy) && this.mat[cy * this.cols + cx]! !== Mat.Empty;
  }

  matAt(cx: number, cy: number): number {
    return this.inside(cx, cy) ? this.mat[cy * this.cols + cx]! : Mat.Empty;
  }

  set(cx: number, cy: number, m: number, flags = 0) {
    if (!this.inside(cx, cy)) return;
    const i = cy * this.cols + cx;
    this.mat[i] = m;
    this.hp[i] = m === Mat.Bedrock ? Infinity : this.hitPoints[m]!;
    this.flags[i] = m === Mat.Empty ? 0 : flags;
  }

  clear(cx: number, cy: number) {
    this.set(cx, cy, Mat.Empty);
  }

  /** Cell containing world point (may be outside the grid). */
  cx(x: number) {
    return Math.floor((x - this.x0) / CELL);
  }
  cy(y: number) {
    return Math.floor((y - this.y0) / CELL);
  }

  /** World x of a cell's left edge / y of its bottom edge. */
  wx(cx: number) {
    return this.x0 + cx * CELL;
  }
  wy(cy: number) {
    return this.y0 + cy * CELL;
  }

  solidAt(x: number, y: number) {
    return this.solid(this.cx(x), this.cy(y));
  }

  fillRect(cx0: number, cy0: number, cx1: number, cy1: number, m: number, flags = 0) {
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) this.set(cx, cy, m, flags);
  }

  /** Is the rectangle (cells) completely empty? */
  emptyRect(cx0: number, cy0: number, cx1: number, cy1: number) {
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) if (this.solid(cx, cy)) return false;
    return true;
  }

  countSolid(): number {
    let n = 0;
    for (let i = 0; i < this.mat.length; i++) if (this.mat[i] !== Mat.Empty) n++;
    return n;
  }

  countMat(m: number): number {
    let n = 0;
    for (let i = 0; i < this.mat.length; i++) if (this.mat[i] === m) n++;
    return n;
  }

  clone(): Grid {
    const g = new Grid(this.cols, this.rows, this.x0, this.y0, this.hitPoints, this.density);
    g.mat.set(this.mat);
    g.hp.set(this.hp);
    g.flags.set(this.flags);
    return g;
  }
}

/**
 * Greedy rectangles over a set of cells: merge horizontal runs, then stack
 * identical runs vertically. Keeps collider counts small.
 */
export function greedyRects(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  filled: (cx: number, cy: number) => boolean,
): { cx: number; cy: number; w: number; h: number }[] {
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const used = new Uint8Array(w * h);
  const out: { cx: number; cy: number; w: number; h: number }[] = [];
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      const i = (cy - y0) * w + (cx - x0);
      if (used[i] || !filled(cx, cy)) continue;
      let rw = 1;
      while (cx + rw <= x1 && !used[i + rw] && filled(cx + rw, cy)) rw++;
      let rh = 1;
      outer: while (cy + rh <= y1) {
        for (let k = 0; k < rw; k++) {
          const j = (cy + rh - y0) * w + (cx + k - x0);
          if (used[j] || !filled(cx + k, cy + rh)) break outer;
        }
        rh++;
      }
      for (let a = 0; a < rh; a++) for (let k = 0; k < rw; k++) used[(cy + a - y0) * w + (cx + k - x0)] = 1;
      out.push({ cx, cy, w: rw, h: rh });
    }
  }
  return out;
}
