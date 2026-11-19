/**
 * Side-view navigation: walkable surfaces (top edges of terrain) and
 * jump/drop/walk links between them. Fighters path over this graph.
 */
import { FIGHTER, GRAVITY } from "./constants";
import type { MapDef } from "./map";

export interface Surface {
  id: number;
  x0: number;
  x1: number;
  y: number;
}

export interface Link {
  from: number;
  to: number;
  kind: "jump" | "drop" | "walk";
  takeoffX: number;
  landX: number;
  cost: number;
  /** Walk links over the bridge need the bridge to be intact. */
  needsBridge?: boolean;
}

export interface NavPoint {
  surface: number;
  x: number;
  y: number;
}

const MAX_JUMP_UP = (FIGHTER.jumpSpeed * FIGHTER.jumpSpeed) / (2 * GRAVITY) - 0.55; // feet clearance
const MAX_GAP = 4.6;

export class NavGraph {
  surfaces: Surface[] = [];
  links: Link[] = [];
  points: NavPoint[] = [];

  constructor(map: MapDef) {
    this.buildSurfaces(map);
    this.buildLinks(map);
    for (const s of this.surfaces) {
      const n = Math.max(1, Math.floor((s.x1 - s.x0 - 0.8) / 1.0));
      for (let i = 0; i <= n; i++) {
        this.points.push({ surface: s.id, x: s.x0 + 0.4 + ((s.x1 - s.x0 - 0.8) * i) / n, y: s.y });
      }
    }
  }

  private buildSurfaces(map: MapDef) {
    for (const r of map.terrain) {
      // subtract intervals of rects covering this top edge
      let parts: [number, number][] = [[r.x0, r.x1]];
      for (const o of map.terrain) {
        if (o === r) continue;
        if (o.bottom < r.top + 0.01 && o.top > r.top + 0.01) {
          const next: [number, number][] = [];
          for (const [a, b] of parts) {
            if (o.x1 <= a || o.x0 >= b) {
              next.push([a, b]);
              continue;
            }
            if (o.x0 > a) next.push([a, o.x0]);
            if (o.x1 < b) next.push([o.x1, b]);
          }
          parts = next;
        }
      }
      for (const [a, b] of parts) {
        if (b - a > 0.8) this.surfaces.push({ id: this.surfaces.length, x0: a, x1: b, y: r.top });
      }
    }
  }

  private addLink(l: Omit<Link, "cost">, extra = 0) {
    const dist = Math.abs(l.landX - l.takeoffX);
    this.links.push({ ...l, cost: dist + (l.kind === "walk" ? 0 : 2.5) + extra });
  }

  private buildLinks(map: MapDef) {
    const S = this.surfaces;
    for (const a of S) {
      for (const b of S) {
        if (a === b) continue;
        const dy = b.y - a.y;
        const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        if (overlap > 0) {
          if (dy > 0.5 && dy <= MAX_JUMP_UP) {
            // jump up onto b from beside its edges
            const tl = b.x0 - 0.9;
            if (tl >= a.x0 + 0.3) this.addLink({ from: a.id, to: b.id, kind: "jump", takeoffX: tl, landX: b.x0 + 0.9 });
            const tr = b.x1 + 0.9;
            if (tr <= a.x1 - 0.3) this.addLink({ from: a.id, to: b.id, kind: "jump", takeoffX: tr, landX: b.x1 - 0.9 });
          } else if (dy < -0.5) {
            // drop off a's edges onto b
            if (a.x0 - 1.0 >= b.x0 + 0.3)
              this.addLink({ from: a.id, to: b.id, kind: "drop", takeoffX: a.x0 + 0.2, landX: a.x0 - 1.2 });
            if (a.x1 + 1.0 <= b.x1 - 0.3)
              this.addLink({ from: a.id, to: b.id, kind: "drop", takeoffX: a.x1 - 0.2, landX: a.x1 + 1.2 });
          }
        } else {
          const bRight = b.x0 >= a.x1;
          const gap = bRight ? b.x0 - a.x1 : a.x0 - b.x1;
          if (gap > MAX_GAP) continue;
          if (dy > MAX_JUMP_UP) continue;
          if (dy < -0.3 || dy > 0.3 || gap > 0.05) {
            const take = bRight ? a.x1 - 0.35 : a.x0 + 0.35;
            const land = bRight ? b.x0 + 1.0 : b.x1 - 1.0;
            this.addLink({ from: a.id, to: b.id, kind: dy < -0.5 && gap < 1.5 ? "drop" : "jump", takeoffX: take, landX: land });
          } else {
            this.addLink({ from: a.id, to: b.id, kind: "walk", takeoffX: bRight ? a.x1 : a.x0, landX: bRight ? b.x0 : b.x1 });
          }
        }
      }
    }
    if (map.bridge) {
      const br = map.bridge;
      const left = S.find((s) => Math.abs(s.x1 - br.x0) < 0.05 && Math.abs(s.y - br.y) < 0.05);
      const right = S.find((s) => Math.abs(s.x0 - br.x1) < 0.05 && Math.abs(s.y - br.y) < 0.05);
      if (left && right) {
        this.addLink({ from: left.id, to: right.id, kind: "walk", takeoffX: br.x0, landX: br.x1 + 0.5, needsBridge: true });
        this.addLink({ from: right.id, to: left.id, kind: "walk", takeoffX: br.x1, landX: br.x0 - 0.5, needsBridge: true });
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

  /**
   * Dijkstra from (surface, x). Returns cost per surface and, for each surface,
   * the first link to take from the start surface.
   */
  plan(start: number, x: number, bridgeIntact: boolean): { cost: number[]; firstLink: (Link | null)[]; arriveX: number[] } {
    const n = this.surfaces.length;
    const cost = new Array<number>(n).fill(Infinity);
    const firstLink = new Array<Link | null>(n).fill(null);
    const arriveX = new Array<number>(n).fill(0);
    const done = new Array<boolean>(n).fill(false);
    cost[start] = 0;
    arriveX[start] = x;
    for (let iter = 0; iter < n; iter++) {
      let u = -1;
      for (let i = 0; i < n; i++) if (!done[i] && cost[i]! < Infinity && (u < 0 || cost[i]! < cost[u]!)) u = i;
      if (u < 0) break;
      done[u] = true;
      for (const l of this.links) {
        if (l.from !== u) continue;
        if (l.needsBridge && !bridgeIntact) continue;
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
