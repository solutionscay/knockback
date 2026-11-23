/**
 * Physics side of the destructible grid.
 *
 * - Static cells live on one fixed body as merged rectangles, rebuilt per
 *   16x16-cell chunk when a cell in that chunk changes.
 * - After damage, a flood fill from bedrock and anchor cells finds cells that
 *   lost their support; each disconnected group becomes a loose "piece": a
 *   dynamic body made of the same cells, which falls, crushes, and can be
 *   broken further (and split) by later hits.
 */
import RAPIER from "@dimforge/rapier2d-deterministic-compat";
import { G, groups } from "./constants";
import { dcos, dsin } from "./dmath";
import { CELL, F_ANCHOR, Grid, greedyRects, Mat, MAT_DENSITY } from "./grid";
import { moveSolidOnGrid } from "./liquid-flow";

export const CHUNK = 16;

export interface PieceCell {
  lx: number;
  ly: number;
  mat: number;
  hp: number;
  /** chain id (#34) when a chain holds the piece by this cell */
  chain?: number;
  /** chain id of a broken chain whose stub stays on this cell (drawn by the viewer; not game state) */
  stub?: number;
  /** fire (#33): fire-steps left burning, who lit it; charred cells don't catch again */
  burn?: number;
  burnBy?: number;
  charred?: boolean;
}

export class Terrain {
  readonly body: RAPIER.RigidBody;
  private readonly chunkCols: number;
  private readonly chunkRows: number;
  private readonly colliders: RAPIER.Collider[][];
  private readonly dirty = new Set<number>();
  supportDirty = false;
  /** Bumps whenever static cells change (navigation rebuilds on it). */
  version = 0;
  /** Static terrain collider handles (raycast hits on these are "terrain"). */
  readonly handles = new Set<number>();

  constructor(
    private readonly world: RAPIER.World,
    readonly grid: Grid,
  ) {
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.chunkCols = Math.ceil(grid.cols / CHUNK);
    this.chunkRows = Math.ceil(grid.rows / CHUNK);
    this.colliders = Array.from({ length: this.chunkCols * this.chunkRows }, () => []);
    for (let k = 0; k < this.colliders.length; k++) this.buildChunk(k);
  }

  private buildChunk(k: number) {
    for (const c of this.colliders[k]!) {
      this.handles.delete(c.handle);
      this.world.removeCollider(c, false);
    }
    const g = this.grid;
    const kx = k % this.chunkCols;
    const ky = Math.floor(k / this.chunkCols);
    const x0 = kx * CHUNK;
    const y0 = ky * CHUNK;
    const x1 = Math.min(g.cols, x0 + CHUNK) - 1;
    const y1 = Math.min(g.rows, y0 + CHUNK) - 1;
    const list: RAPIER.Collider[] = [];
    for (const r of greedyRects(x0, y0, x1, y1, (cx, cy) => g.solid(cx, cy))) {
      const c = this.world.createCollider(
        RAPIER.ColliderDesc.cuboid((r.w * CELL) / 2, (r.h * CELL) / 2)
          .setTranslation(g.wx(r.cx) + (r.w * CELL) / 2, g.wy(r.cy) + (r.h * CELL) / 2)
          .setFriction(0.9)
          .setCollisionGroups(groups(G.TERRAIN, 0xffff)),
        this.body,
      );
      list.push(c);
      this.handles.add(c.handle);
    }
    this.colliders[k] = list;
  }

  colliderCount(): number {
    let n = 0;
    for (const l of this.colliders) n += l.length;
    return n;
  }

  private touch(cx: number, cy: number) {
    this.dirty.add(Math.floor(cy / CHUNK) * this.chunkCols + Math.floor(cx / CHUNK));
    this.version++;
  }

  /** Remove a static cell (no-op for bedrock). Returns true if removed. */
  removeCell(cx: number, cy: number): boolean {
    const g = this.grid;
    if (!g.solid(cx, cy) || g.matAt(cx, cy) === Mat.Bedrock) return false;
    g.clear(cx, cy);
    this.touch(cx, cy);
    this.supportDirty = true;
    return true;
  }

  /** #94: place a static cell (lava cooled to rock). */
  placeCell(cx: number, cy: number, mat: number) {
    if (!this.grid.inside(cx, cy)) return;
    this.grid.set(cx, cy, mat);
    this.touch(cx, cy);
    this.supportDirty = true;
  }

  /** #94: a static cell moved from grid index `from` to `to` (sand falling; a liquid in `to` takes `from`'s place). */
  moveCell(from: number, to: number) {
    moveSolidOnGrid(this.grid, from, to);
    const c = this.grid.cols;
    this.touch(from % c, Math.floor(from / c));
    this.touch(to % c, Math.floor(to / c));
    this.supportDirty = true;
  }

  /** Damage one static cell. Returns true if it broke. */
  damageCell(cx: number, cy: number, dmg: number): boolean {
    const g = this.grid;
    if (!g.solid(cx, cy)) return false;
    const i = g.idx(cx, cy);
    if (g.mat[i] === Mat.Bedrock) return false;
    g.hp[i]! -= dmg;
    if (g.hp[i]! > 0) return false;
    return this.removeCell(cx, cy);
  }

  /**
   * Explosion carving: damage falls off linearly to the edge of radius r.
   * Returns centers of destroyed cells (for effects and stats).
   */
  carve(x: number, y: number, r: number, dmg: number): { x: number; y: number; mat: number }[] {
    const g = this.grid;
    const out: { x: number; y: number; mat: number }[] = [];
    const c0 = Math.max(0, g.cx(x - r));
    const c1 = Math.min(g.cols - 1, g.cx(x + r));
    const r0 = Math.max(0, g.cy(y - r));
    const r1 = Math.min(g.rows - 1, g.cy(y + r));
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        if (!g.solid(cx, cy)) continue;
        const px = g.wx(cx) + CELL / 2;
        const py = g.wy(cy) + CELL / 2;
        const d = Math.sqrt((px - x) * (px - x) + (py - y) * (py - y));
        if (d > r) continue;
        const m = g.matAt(cx, cy);
        if (this.damageCell(cx, cy, dmg * (1 - d / r))) out.push({ x: px, y: py, mat: m });
      }
    }
    return out;
  }

  /** Rebuild colliders of changed chunks. */
  flushColliders() {
    for (const k of [...this.dirty].sort((a, b) => a - b)) this.buildChunk(k);
    this.dirty.clear();
  }

  /**
   * Find solid cells that lost their support, remove them from the grid, and
   * return them grouped into connected (4-neighbor) components, each of which
   * becomes a loose piece. Held up: cells connected to bedrock, and groups
   * hanging from two or more anchor cells (chains, #34). A group with one
   * anchor comes loose too: the caller hangs it from that chain, so it swings.
   */
  detachUnsupported(): { cx: number; cy: number; mat: number; hp: number; anchor: boolean }[][] {
    if (!this.supportDirty) return [];
    this.supportDirty = false;
    const g = this.grid;
    const n = g.cols * g.rows;
    const seen = new Uint8Array(n);
    const stack: number[] = [];
    const neighbors = (i: number, visit: (k: number) => void) => {
      const cx = i % g.cols;
      const cy = (i - cx) / g.cols;
      if (cx > 0) visit(i - 1);
      if (cx < g.cols - 1) visit(i + 1);
      if (cy > 0) visit(i - g.cols);
      if (cy < g.rows - 1) visit(i + g.cols);
    };
    for (let i = 0; i < n; i++) {
      if (g.mat[i] === Mat.Bedrock) {
        seen[i] = 1;
        stack.push(i);
      }
    }
    const push = (k: number) => {
      if (!seen[k] && g.mat[k] !== Mat.Empty) {
        seen[k] = 1;
        stack.push(k);
      }
    };
    while (stack.length) neighbors(stack.pop()!, push);
    const groupsOut: { cx: number; cy: number; mat: number; hp: number; anchor: boolean }[][] = [];
    for (let i = 0; i < n; i++) {
      if (seen[i] || g.mat[i] === Mat.Empty) continue;
      // flood this component off the ground
      const comp: { cx: number; cy: number; mat: number; hp: number; anchor: boolean }[] = [];
      let anchors = 0;
      seen[i] = 1;
      stack.push(i);
      while (stack.length) {
        const j = stack.pop()!;
        const cx = j % g.cols;
        const cy = (j - cx) / g.cols;
        const anchor = (g.flags[j]! & F_ANCHOR) !== 0;
        if (anchor) anchors++;
        comp.push({ cx, cy, mat: g.mat[j]!, hp: g.hp[j]!, anchor });
        neighbors(j, push);
      }
      if (anchors >= 2) continue; // still hangs from two chains: stays static
      comp.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
      for (const c of comp) {
        g.clear(c.cx, c.cy);
        this.touch(c.cx, c.cy);
      }
      groupsOut.push(comp);
    }
    return groupsOut;
  }
}

// ------------------------------------------------------------------ pieces

/** Colliders for a loose piece from its cells (local coords, merged rectangles). */
export function buildPieceColliders(world: RAPIER.World, body: RAPIER.RigidBody, cells: PieceCell[], density = MAT_DENSITY): RAPIER.Collider[] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const at = new Map<number, PieceCell>();
  for (const c of cells) {
    minX = Math.min(minX, c.lx);
    minY = Math.min(minY, c.ly);
    maxX = Math.max(maxX, c.lx);
    maxY = Math.max(maxY, c.ly);
    at.set(c.ly * 4096 + c.lx, c);
  }
  const out: RAPIER.Collider[] = [];
  for (const r of greedyRects(minX, minY, maxX, maxY, (x, y) => at.has(y * 4096 + x))) {
    const m = at.get(r.cy * 4096 + r.cx)!.mat;
    out.push(
      world.createCollider(
        RAPIER.ColliderDesc.cuboid((r.w * CELL) / 2 - 0.005, (r.h * CELL) / 2 - 0.005)
          .setTranslation(r.cx * CELL + (r.w * CELL) / 2, r.cy * CELL + (r.h * CELL) / 2)
          .setDensity(density[m] ?? 1.5)
          .setFriction(0.8)
          .setRestitution(0.05)
          .setCollisionGroups(groups(G.PROP, G.TERRAIN | G.FIGHTER | G.PROP | G.ITEM | G.GRENADE)),
        body,
      ),
    );
  }
  return out;
}

/** World center of a piece cell, given the body's translation and rotation. */
export function pieceCellWorld(t: { x: number; y: number }, angle: number, c: PieceCell): { x: number; y: number } {
  const lx = (c.lx + 0.5) * CELL;
  const ly = (c.ly + 0.5) * CELL;
  const co = dcos(angle);
  const si = dsin(angle);
  return { x: t.x + lx * co - ly * si, y: t.y + lx * si + ly * co };
}

/** Split cells into 4-connected components (largest first). */
export function components(cells: PieceCell[]): PieceCell[][] {
  const key = (x: number, y: number) => y * 4096 + x;
  const at = new Map<number, PieceCell>();
  for (const c of cells) at.set(key(c.lx, c.ly), c);
  const seen = new Set<number>();
  const out: PieceCell[][] = [];
  for (const c of cells) {
    const k0 = key(c.lx, c.ly);
    if (seen.has(k0)) continue;
    const comp: PieceCell[] = [];
    const stack = [c];
    seen.add(k0);
    while (stack.length) {
      const d = stack.pop()!;
      comp.push(d);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const k = key(d.lx + dx, d.ly + dy);
        const nb = at.get(k);
        if (nb && !seen.has(k)) {
          seen.add(k);
          stack.push(nb);
        }
      }
    }
    comp.sort((a, b) => a.ly - b.ly || a.lx - b.lx);
    out.push(comp);
  }
  return out.sort((a, b) => b.length - a.length);
}
