/**
 * Side-view navigation built from the destructible grid: walkable surfaces
 * (tops of solid cells with headroom) and jump/drop/walk links between them.
 * Rebuilt as explosions carve the level.
 */
import { FIGHTER, GRAVITY } from "./constants";
import { CELL, F_BRIDGE, Mat, type Grid } from "./grid";

export interface Surface {
  id: number;
  x0: number;
  x1: number;
  y: number;
  /** Long fall (or void) just past each end: a ledge you can be knocked off. */
  dropLeft: boolean;
  dropRight: boolean;
  /** Made of crumbling cells or a bridge: avoid standing around. */
  fragile: boolean;
}

export interface Link {
  from: number;
  to: number;
  kind: "jump" | "drop" | "walk";
  takeoffX: number;
  landX: number;
  cost: number;
}

export interface NavPoint {
  surface: number;
  x: number;
  y: number;
}

const HEADROOM_CELLS = 4; // 2 m
const MAX_JUMP_UP = (FIGHTER.jumpSpeed * FIGHTER.jumpSpeed) / (2 * GRAVITY) - 0.55;
const MAX_GAP = 4.6;
const DROP_FALL = 3;

export class NavGraph {
  surfaces: Surface[] = [];
  links: Link[] = [];
  out: Link[][] = [];
  points: NavPoint[] = [];

  static fromGrid(grid: Grid, minRun = 2): NavGraph {
    const nav = new NavGraph();
    const { cols, rows } = grid;
    for (let cy = 0; cy < rows; cy++) {
      let run = -1;
      let fragile = false;
      for (let cx = 0; cx <= cols; cx++) {
        let ok = false;
        if (cx < cols && grid.solid(cx, cy)) {
          ok = true;
          for (let k = 1; k <= HEADROOM_CELLS; k++)
            if (grid.solid(cx, cy + k)) {
              ok = false;
              break;
            }
        }
        if (ok && run < 0) {
          run = cx;
          fragile = false;
        }
        if (ok) {
          const i = grid.idx(cx, cy);
          if (grid.mat[i] === Mat.Crumble || grid.flags[i]! & F_BRIDGE) fragile = true;
        }
        if (!ok && run >= 0) {
          if (cx - run >= minRun) {
            nav.surfaces.push({
              id: nav.surfaces.length,
              x0: grid.wx(run),
              x1: grid.wx(cx),
              y: grid.wy(cy + 1),
              dropLeft: false,
              dropRight: false,
              fragile,
            });
          }
          run = -1;
        }
      }
    }
    for (const s of nav.surfaces) {
      s.dropLeft = nav.fallBelow(grid, s.x0 - 0.3, s.y) > DROP_FALL;
      s.dropRight = nav.fallBelow(grid, s.x1 + 0.3, s.y) > DROP_FALL;
    }
    nav.buildLinks();
    nav.out = nav.surfaces.map(() => []);
    for (const l of nav.links) nav.out[l.from]!.push(l);
    for (const s of nav.surfaces) {
      const len = s.x1 - s.x0;
      const n = Math.max(1, Math.floor((len - 0.8) / 1.0));
      for (let i = 0; i <= n; i++) nav.points.push({ surface: s.id, x: s.x0 + 0.4 + ((len - 0.8) * i) / n, y: s.y });
    }
    return nav;
  }

  /** How far something at (x, y) falls before hitting a solid cell (Infinity = void). */
  fallBelow(grid: Grid, x: number, y: number): number {
    const cx = grid.cx(x);
    if (cx < 0 || cx >= grid.cols) return Infinity;
    for (let cy = grid.cy(y - 0.01); cy >= 0; cy--) if (grid.solid(cx, cy)) return y - grid.wy(cy + 1);
    return Infinity;
  }

  private addLink(l: Omit<Link, "cost">) {
    const dist = Math.abs(l.landX - l.takeoffX);
    this.links.push({ ...l, cost: dist + (l.kind === "walk" ? 0 : 2.5) });
  }

  private buildLinks() {
    const S = this.surfaces;
    for (const a of S) {
      for (const b of S) {
        if (a === b) continue;
        const dy = b.y - a.y;
        if (dy > MAX_JUMP_UP) continue;
        const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        if (overlap > 0) {
          if (dy > 0.4) {
            const tl = b.x0 - 0.9;
            if (tl >= a.x0 + 0.3) this.addLink({ from: a.id, to: b.id, kind: "jump", takeoffX: tl, landX: b.x0 + 0.9 });
            const tr = b.x1 + 0.9;
            if (tr <= a.x1 - 0.3) this.addLink({ from: a.id, to: b.id, kind: "jump", takeoffX: tr, landX: b.x1 - 0.9 });
          } else if (dy < -0.4) {
            if (a.x0 - 1.0 >= b.x0 + 0.3) this.addLink({ from: a.id, to: b.id, kind: "drop", takeoffX: a.x0 + 0.2, landX: a.x0 - 1.2 });
            if (a.x1 + 1.0 <= b.x1 - 0.3) this.addLink({ from: a.id, to: b.id, kind: "drop", takeoffX: a.x1 - 0.2, landX: a.x1 + 1.2 });
          }
        } else {
          const bRight = b.x0 >= a.x1 - 1e-6;
          const gap = bRight ? b.x0 - a.x1 : a.x0 - b.x1;
          if (gap > MAX_GAP) continue;
          if (Math.abs(dy) < 0.05 && gap < 0.05) {
            this.addLink({ from: a.id, to: b.id, kind: "walk", takeoffX: bRight ? a.x1 : a.x0, landX: bRight ? b.x0 + 0.3 : b.x1 - 0.3 });
          } else {
            const take = bRight ? a.x1 - 0.35 : a.x0 + 0.35;
            const land = bRight ? b.x0 + Math.min(1.0, (b.x1 - b.x0) / 2) : b.x1 - Math.min(1.0, (b.x1 - b.x0) / 2);
            this.addLink({ from: a.id, to: b.id, kind: dy < -0.4 && gap < 1.5 ? "drop" : "jump", takeoffX: take, landX: land });
          }
        }
      }
    }
  }

  /** Surface whose top is at/below (x, feetY) and closest to it. */
  surfaceAt(x: number, feetY: number, tol = 0.45): Surface | null {
    let best: Surface | null = null;
    let bestDy = Infinity;
    for (const s of this.surfaces) {
      if (x < s.x0 - tol || x > s.x1 + tol) continue;
      const dy = feetY - s.y;
      if (dy < -0.35) continue;
      if (dy < bestDy) {
        bestDy = dy;
        best = s;
      }
    }
    return best;
  }

  /** Dijkstra from (surface, x) over adjacency lists. */
  plan(start: number, x: number): { cost: number[]; firstLink: (Link | null)[]; arriveX: number[] } {
    const n = this.surfaces.length;
    const cost = new Array<number>(n).fill(Infinity);
    const firstLink = new Array<Link | null>(n).fill(null);
    const arriveX = new Array<number>(n).fill(0);
    if (start < 0 || start >= n) return { cost, firstLink, arriveX };
    const done = new Uint8Array(n);
    cost[start] = 0;
    arriveX[start] = x;
    for (let iter = 0; iter < n; iter++) {
      let u = -1;
      for (let i = 0; i < n; i++) if (!done[i] && cost[i]! < Infinity && (u < 0 || cost[i]! < cost[u]!)) u = i;
      if (u < 0) break;
      done[u] = 1;
      for (const l of this.out[u]!) {
        const c = cost[u]! + Math.abs(arriveX[u]! - l.takeoffX) + l.cost;
        if (c < cost[l.to]!) {
          cost[l.to] = c;
          arriveX[l.to] = l.landX;
          firstLink[l.to] = u === start ? l : firstLink[u]!;
        }
      }
    }
    return { cost, firstLink, arriveX };
  }
}

export { CELL };
