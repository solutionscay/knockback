/**
 * Side-view navigation built from the destructible grid: walkable surfaces
 * (tops of solid cells with headroom) and jump/drop/walk links between them.
 * Rebuilt as explosions carve the level.
 *
 * Jump links and arcs are worked out with the ruleset's own fighter values (`combat.fighter`): every fighter has the
 * same mobility (builds do not change it, #83), so one graph serves every fighter, level generation and validation.
 */
import { CLASSIC, type Ruleset } from "./ruleset";
import { CELL, F_BRIDGE, Liquid, Mat, type Grid } from "./grid";

export interface Surface {
  id: number;
  x0: number;
  x1: number;
  y: number;
  /** Long fall (or void) just past each end: a ledge you can be knocked off. */
  dropLeft: boolean;
  dropRight: boolean;
  /** Made of crumbling cells or a bridge, or under a liquid: avoid standing around. */
  fragile: boolean;
  /** #94: the liquid over it (a pool's floor; a surface never mixes liquids), or Liquid.None */
  liquid: Liquid;
  /** #100: a jump-through platform's top (all its cells jump-through): jumped up through, dropped down through */
  oneWay: boolean;
}

/** #94: extra path cost of landing on a surface under each liquid: lava and acid are avoided, water and oil slow. */
export const LIQUID_COST: readonly number[] = [0, 10, 2, 60, 60];
/** Hurts to stand in (lava, acid). */
export const hazardous = (l: number) => l === Liquid.Lava || l === Liquid.Acid;

export interface Link {
  from: number;
  to: number;
  kind: "jump" | "drop" | "walk";
  takeoffX: number;
  landX: number;
  cost: number;
  /** #100: straight up through a jump-through platform (a jump), or down through the one stood on (a drop: hold down) */
  through?: boolean;
}

export interface NavPoint {
  surface: number;
  x: number;
  y: number;
}

/** A jump across a gap (no overlap between the two surfaces): taken with a run-up through the takeoff point (#69). */
export function runUp(nav: NavGraph, l: Link): boolean {
  if (l.kind !== "jump") return false;
  const a = nav.surfaces[l.from]!, b = nav.surfaces[l.to]!;
  return Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) <= 0;
}

/**
 * The body the planner flies (#69): a box a little inside the capsule, from 0.3 m above the feet (the capsule's round
 * bottom slides over corners) to `top` above them, `r` to each side.
 */
function bodyBox(ruleset: Ruleset) {
  const F = ruleset.combat.fighter;
  return { r: F.radius - 0.08, top: 2 * (F.halfHeight + F.radius) - 0.1 };
}

export class NavGraph {
  surfaces: Surface[] = [];
  links: Link[] = [];
  out: Link[][] = [];
  points: NavPoint[] = [];
  /** whether a fighter can fly each link (arcClear), worked out the first time a fighter's plan needs it */
  private readonly flyable = new Map<Link, boolean>();

  private constructor(readonly ruleset: Ruleset) {}

  static fromGrid(grid: Grid, minRun = 2, ruleset: Ruleset = CLASSIC): NavGraph {
    const { headroomCells, dropFall } = ruleset.arena.navigation;
    const nav = new NavGraph(ruleset);
    const { cols, rows } = grid;
    for (let cy = 0; cy < rows; cy++) {
      let run = -1;
      let fragile = false;
      let liquid = Liquid.None;
      let oneWay = false;
      const close = (cx: number) => {
        if (run >= 0 && cx - run >= minRun) {
          nav.surfaces.push({
            id: nav.surfaces.length,
            x0: grid.wx(run),
            x1: grid.wx(cx),
            y: grid.wy(cy + 1),
            dropLeft: false,
            dropRight: false,
            fragile: fragile || liquid !== Liquid.None,
            liquid,
            oneWay,
          });
        }
        run = -1;
      };
      for (let cx = 0; cx <= cols; cx++) {
        let ok = false;
        if (cx < cols && grid.solid(cx, cy)) {
          ok = true;
          for (let k = 1; k <= headroomCells; k++)
            if (grid.solid(cx, cy + k)) {
              ok = false;
              break;
            }
        }
        // a surface is all dry or all under one liquid: a change of liquid starts a new one
        const wet = ok ? grid.liqAt(cx, cy + 1) : Liquid.None;
        // ...and all jump-through or none (#100)
        const ow = ok && grid.oneway(cx, cy);
        if (ok && run >= 0 && (wet !== liquid || ow !== oneWay)) close(cx);
        if (ok && run < 0) {
          run = cx;
          fragile = false;
          liquid = wet;
          oneWay = ow;
        }
        if (ok) {
          const i = grid.idx(cx, cy);
          if (grid.mat[i] === Mat.Crumble || grid.flags[i]! & F_BRIDGE) fragile = true;
        }
        if (!ok && run >= 0) close(cx);
      }
    }
    for (const s of nav.surfaces) {
      s.dropLeft = nav.fallBelow(grid, s.x0 - 0.3, s.y) > dropFall;
      s.dropRight = nav.fallBelow(grid, s.x1 + 0.3, s.y) > dropFall;
    }
    nav.linkUp();
    for (const s of nav.surfaces) {
      const len = s.x1 - s.x0;
      const n = Math.max(1, Math.floor((len - 0.8) / 1.0));
      for (let i = 0; i <= n; i++) nav.points.push({ surface: s.id, x: s.x0 + 0.4 + ((len - 0.8) * i) / n, y: s.y });
    }
    return nav;
  }

  private linkUp() {
    this.buildLinks();
    this.out = this.surfaces.map(() => []);
    for (const l of this.links) this.out[l.from]!.push(l);
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
    this.links.push({ ...l, cost: dist + (l.kind === "walk" ? 0 : 2.5) + LIQUID_COST[this.surfaces[l.to]!.liquid]! });
  }

  private buildLinks() {
    const { jumpMargin, maxGap } = this.ruleset.arena.navigation;
    const { gravity } = this.ruleset.combat;
    const { jumpSpeed } = this.ruleset.combat.fighter;
    const maxJumpUp = (jumpSpeed * jumpSpeed) / (2 * gravity) - jumpMargin;
    const S = this.surfaces;
    for (const a of S) {
      for (const b of S) {
        if (a === b) continue;
        const dy = b.y - a.y;
        if (dy > maxJumpUp) continue;
        const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        if (overlap > 0) {
          // #100: straight up through a jump-through platform, and down through the one stood on
          const mid = (Math.max(a.x0, b.x0) + Math.min(a.x1, b.x1)) / 2;
          if (dy > 0.4 && b.oneWay && overlap >= 0.8) this.addLink({ from: a.id, to: b.id, kind: "jump", takeoffX: mid, landX: mid, through: true });
          if (dy < -0.4 && a.oneWay && overlap >= 0.8) this.addLink({ from: a.id, to: b.id, kind: "drop", takeoffX: mid, landX: mid, through: true });
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
          if (gap > maxGap) continue;
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

  /** The plan fighters follow (#69): only the jumps and drops a fighter can make (`canFly`). */
  fighterPlan(grid: Grid, start: number, x: number) {
    return this.plan(start, x, (l) => this.canFly(grid, l));
  }

  /** Can a fighter fly link `l` (arcClear), cached per link: the plan asks for the same links many times. */
  canFly(grid: Grid, l: Link): boolean {
    let ok = this.flyable.get(l);
    if (ok === undefined) {
      ok = this.arcClear(grid, l);
      this.flyable.set(l, ok);
    }
    return ok;
  }

  /**
   * Where a body in the air on link `l` steers (#69, #84): the one flight rule of the planner (arcClear) and the
   * controller. `goal` is where it wants to land (the link's landing unless the controller has had to pick another).
   * - Onto a platform overhead: straight up beside its edge until the feet clear its top, then over.
   * - Under a ceiling: when a platform overhangs the landing (room to stand under it there, its top above the
   *   takeoff), the body passes under it, never over it. While the body is too tall to pass under the platform's
   *   near edge and can rise onto it (its feet, or the top of their rise, within 0.3 m of the platform's top: the
   *   body box arcClear moves), it holds beside that edge, or steers back out from over the platform; once the feet
   *   come down far enough, it goes under. A higher jump so lands where a lower one does, instead of rising past the
   *   edge onto the platform.
   */
  flightAim(grid: Grid, l: Link, x: number, feet: number, vx: number, vy: number, goal = l.landX): number {
    const from = this.surfaces[l.from]!, to = this.surfaces[l.to]!;
    if (l.kind === "jump" && !runUp(this, l) && feet < to.y + 0.15 && vy > 0) return l.takeoffX;
    const dir = Math.sign(goal - x);
    if (!dir) return goal;
    const { fighter: F, gravity } = this.ruleset.combat;
    const { r, top: head } = bodyBox(this.ruleset);
    const floor = grid.cy(to.y + 0.05);
    // the overhang of column cx: its underside and top, or null (open sky, or a wall at the landing's height)
    const overhang = (cx: number) => {
      if (grid.blocks(cx, floor)) return null;
      let cy = floor + 1;
      while (cy < grid.rows && !grid.blocks(cx, cy)) cy++;
      if (cy >= grid.rows) return null;
      const under = grid.wy(cy);
      while (grid.blocks(cx, cy + 1)) cy++;
      const top = grid.wy(cy + 1);
      return under - to.y >= 2 * (F.halfHeight + F.radius) && top > from.y + 0.05 ? { under, top } : null;
    };
    // from the landing back toward the body: the near edge of the platform over the landing (columns whose overhang
    // overlaps the landing's in height)
    const front = grid.cx(x + dir * r);
    let cx = grid.cx(goal + dir * r);
    const land = overhang(cx);
    if (!land) return goal;
    let o = land;
    for (cx -= dir; (cx - front) * dir >= 0; cx -= dir) {
      const next = overhang(cx);
      if (!next || next.under >= land.top || next.top <= land.under) break;
      o = next;
    }
    const near = cx + dir;
    const rise = vy > 0 ? feet + (vy * vy) / (2 * gravity) : feet;
    if (rise < o.top - 0.3) return goal;
    // already under it: on to the landing; above it: back out; short of it: wait until the body fits under, braking
    // in time to stop beside the edge
    if (near === front ? feet < o.under : feet + head < o.under) return goal;
    const closing = Math.max(0, vx * dir);
    return (dir > 0 ? grid.wx(near) : grid.wx(near + 1)) - dir * (r + 0.02 + (closing * closing) / (2 * F.airAccel));
  }

  /**
   * Can a fighter make this jump or drop (#69)? Flies the controller's own arc (a run-up across a gap, a standing jump
   * up beside a platform overhead, or walking off for a drop; then `flightAim` with the controller's air control;
   * gravity) and moves the body through the grid: a ceiling stops the rise where the head meets it, a wall stops the
   * run (the body slides along both), and a landing out of reach makes the arc fail. Walks always pass. Flown at the
   * ruleset's fighter walk speed, jump speed and air control.
   */
  arcClear(grid: Grid, l: Link): boolean {
    if (l.kind === "walk") return true;
    const from = this.surfaces[l.from]!, to = this.surfaces[l.to]!;
    const { gravity, fighter: M } = this.ruleset.combat;
    const dt = 1 / 30;
    const dir = Math.sign(l.landX - l.takeoffX) || 1;
    const { r, top } = bodyBox(this.ruleset);
    // jump-through cells never stop a body moving (#100); landing on one that is not the goal fails the arc (below)
    const blocked = (x: number, feet: number) => {
      for (let y = feet + 0.3; y <= feet + top + 0.01; y += (top - 0.3) / 3) for (const bx of [x - r, x, x + r]) if (grid.blocksAt(bx, y)) return true;
      return false;
    };
    const caught = (x: number, feet: number, nf: number) => {
      for (let cy = grid.cy(feet - 0.01); grid.wy(cy + 1) > nf && cy >= 0; cy--) {
        const top = grid.wy(cy + 1);
        if (Math.abs(top - to.y) < 0.05 || (l.through && Math.abs(top - from.y) < 0.05)) continue;
        if (grid.oneway(grid.cx(x), cy)) return true;
      }
      return false;
    };
    let x = l.takeoffX, feet = from.y;
    const run = runUp(this, l);
    // a gap jump is run at, a drop is walked off at speed (a drop through a platform: straight down), a jump up beside
    // a platform (or up through it) starts from standing
    let vx = run || (l.kind === "drop" && !l.through) ? dir * M.walkSpeed : 0, vy = l.kind === "jump" ? M.jumpSpeed : 0;
    for (let i = 0; i < 90; i++) {
      const d = this.flightAim(grid, l, x, feet, vx, vy) - x;
      const want = Math.abs(d) < 0.15 ? 0 : Math.max(-1, Math.min(1, d / 0.7)) * M.walkSpeed;
      vx += Math.max(-M.airAccel * dt, Math.min(M.airAccel * dt, want - vx));
      vy -= gravity * dt;
      const nx = x + vx * dt;
      let nf = feet + vy * dt;
      // still over the surface it left: standing on it
      if (!l.through && vy <= 0 && feet >= from.y - 0.01 && nf < from.y && nx >= from.x0 && nx <= from.x1) {
        nf = from.y;
        vy = 0;
      }
      if (vy <= 0 && nf <= to.y + 0.05 && nx >= to.x0 - 0.1 && nx <= to.x1 + 0.1) return true;
      if (vy <= 0 && caught(nx, feet, nf)) return false;
      if (vy < 0 && nf < to.y - 0.4) return false;
      if (!blocked(nx, nf)) {
        x = nx;
        feet = nf;
      } else if (!blocked(x, nf)) {
        // against a wall: the body slides along it
        feet = nf;
        vx = 0;
      } else if (vy > 0 && !blocked(nx, feet)) {
        // head against a ceiling: the rise stops where the head meets it (not a whole step short), the run goes on
        let lo = feet, hi = nf;
        for (let k = 0; k < 5; k++) {
          const mid = (lo + hi) / 2;
          if (blocked(nx, mid)) hi = mid;
          else lo = mid;
        }
        x = nx;
        feet = lo;
        vy = 0;
      } else return false;
    }
    return false;
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

  /** Dijkstra from (surface, x) over adjacency lists; `usable` leaves links out (a fighter's blocked jumps). */
  plan(start: number, x: number, usable?: (l: Link) => boolean): { cost: number[]; firstLink: (Link | null)[]; arriveX: number[] } {
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
        if (usable && !usable(l)) continue;
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

