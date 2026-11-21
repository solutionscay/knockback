/**
 * Tactical map (#38): cover spots, high ground and sightlines, computed by the engine from the level grid and its
 * nav graph. The Sim rebuilds it with the nav graph whenever terrain breaks, so it always matches the level as it is
 * now. Static parts read the grid only (props move, so they are left to the runtime checks below, which ray-cast
 * through the physics world and see crates, steel and fighters too). Pure arithmetic: deterministic.
 */
import { CELL, type Grid } from "./grid";
import type { NavGraph, NavPoint } from "./nav";
import type { Ruleset } from "./ruleset";
import type { Sim } from "./sim";
import type { Fighter, Weapon } from "./sim-types";

type MapTuning = Ruleset["tactics"]["stances"]["map"];

/** A place to stand with solid terrain right beside it, toward `side`, tall enough to hide a body. */
export interface CoverSpot {
  surface: number;
  x: number;
  /** feet height */
  y: number;
  /** -1: the wall is on the left (it shields from the left); 1: on the right */
  side: 1 | -1;
  /** how tall the wall is above the feet (m), up to 3 */
  height: number;
}

/** A nav point well above its surroundings. */
export interface HighSpot {
  surface: number;
  x: number;
  y: number;
  /** meters above the median floor around it */
  rise: number;
}

/** Height of a fighter's aim point and body center above its feet (meters). */
export function bodyHeights(ruleset: Ruleset): { center: number; aim: number } {
  const f = ruleset.combat.fighter;
  const center = f.halfHeight + f.radius;
  return { center, aim: center + (ruleset.tactics.weapons.enabled ? ruleset.tactics.weapons.aimHeight : 0.25) };
}

/** True when no solid grid cell lies on the segment (x0, y0) -> (x1, y1). Cell walk, like the rail trace. */
export function gridClear(grid: Grid, x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-6) return !grid.solidAt(x0, y0);
  const ux = dx / len, uy = dy / len;
  let cx = grid.cx(x0), cy = grid.cy(y0);
  const ex = grid.cx(x1), ey = grid.cy(y1);
  const sx = Math.sign(ux), sy = Math.sign(uy);
  const stepX = sx === 0 ? Infinity : CELL / Math.abs(ux);
  const stepY = sy === 0 ? Infinity : CELL / Math.abs(uy);
  let nextX = sx === 0 ? Infinity : (grid.wx(cx + (sx > 0 ? 1 : 0)) - x0) / ux;
  let nextY = sy === 0 ? Infinity : (grid.wy(cy + (sy > 0 ? 1 : 0)) - y0) / uy;
  for (let guard = 0; guard < 4096; guard++) {
    if (grid.solid(cx, cy)) return false;
    if (cx === ex && cy === ey) return true;
    const t = Math.min(nextX, nextY);
    if (t > len) return true;
    if (nextX === t) {
      cx += sx;
      nextX += stepX;
    }
    if (nextY === t) {
      cy += sy;
      nextY += stepY;
    }
  }
  return true;
}

export class TacticalMap {
  readonly cover: CoverSpot[] = [];
  readonly high: HighSpot[] = [];
  /** per nav point: meters above the median floor around it */
  readonly rise: number[];
  private readonly views = new Map<number, number>();

  constructor(readonly grid: Grid, readonly nav: NavGraph, private readonly tuning: MapTuning, private readonly heights: { center: number; aim: number }) {
    const pts = nav.points;
    this.rise = pts.map((p) => {
      const around = pts.filter((q) => Math.abs(q.x - p.x) <= tuning.localSpan).map((q) => q.y).sort((a, b) => a - b);
      return p.y - (around[Math.floor(around.length / 2)] ?? p.y);
    });
    pts.forEach((p, i) => {
      if (this.rise[i]! >= tuning.highRise) this.high.push({ surface: p.surface, x: p.x, y: p.y, rise: this.rise[i]! });
      for (const side of [-1, 1] as const) {
        const h = this.wallBeside(p, side);
        if (h >= tuning.coverMinHeight) this.cover.push({ surface: p.surface, x: p.x, y: p.y, side, height: h });
      }
    });
  }

  /** Height of the solid wall within coverReach of a point on one side (0 = none), measured up from the feet. */
  private wallBeside(p: NavPoint, side: 1 | -1): number {
    const g = this.grid;
    let best = 0;
    for (let d = CELL; d <= this.tuning.coverReach + 1e-9; d += CELL) {
      const cx = g.cx(p.x + side * d);
      // the wall must start at the floor (a gap underneath is no cover) and be solid at body height
      if (!g.solid(cx, g.cy(p.y + CELL / 2))) continue;
      let top = 0;
      for (let h = CELL / 2; h <= 3; h += CELL) {
        if (!g.solid(cx, g.cy(p.y + h))) break;
        top = h + CELL / 2;
      }
      if (top > best) best = top;
    }
    return best;
  }

  /** Clear line from a standing fighter's aim point at (x, feet y) to another's body center (grid only). */
  sees(x0: number, feet0: number, x1: number, feet1: number): boolean {
    return gridClear(this.grid, x0, feet0 + this.heights.aim, x1, feet1 + this.heights.center);
  }

  /**
   * Share (0-1) of the other nav points within viewRange that a fighter standing at nav point `i` can see. Lazy and
   * cached per map; sampled every viewStep points so it stays cheap.
   */
  view(i: number): number {
    const cached = this.views.get(i);
    if (cached !== undefined) return cached;
    const p = this.nav.points[i]!;
    let seen = 0, all = 0;
    const pts = this.nav.points;
    for (let k = 0; k < pts.length; k += this.tuning.viewStep) {
      const q = pts[k]!;
      if (k === i || Math.abs(q.x - p.x) > this.tuning.viewRange) continue;
      all++;
      if (this.sees(p.x, p.y, q.x, q.y)) seen++;
    }
    const v = all ? seen / all : 0;
    this.views.set(i, v);
    return v;
  }

  /** Index of the nav point closest to (x, feet y), or -1. */
  pointAt(x: number, y: number, maxD = 1.5): number {
    let best = -1, bd = maxD;
    this.nav.points.forEach((p, i) => {
      const d = Math.abs(p.x - x) + Math.abs(p.y - y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }
}

// ------------------------------------------------------------------ runtime checks (physics world: props count)

/** A test for "nothing stands where a fighter would stand here" (a spot taken by a crate is not a spot). */
export function spotFree(sim: Sim): (c: { x: number; y: number }) => boolean {
  const r = sim.ruleset.combat.fighter.radius;
  const blockers: { x: number; hw: number; y0: number; y1: number }[] = [];
  for (const e of sim.entities.values()) {
    if (e.dead || e.kind === "fighter" || e.kind === "item" || e.kind === "grenade" || e.kind === "weight") continue;
    const t = e.body.translation();
    blockers.push({ x: t.x, hw: e.hw, y0: t.y - e.hh, y1: t.y + e.hh });
  }
  return (c) => !blockers.some((b) => Math.abs(b.x - c.x) < b.hw + r - 0.05 && b.y1 > c.y + 0.1 && b.y0 < c.y + 1.6);
}

/** Props solid enough to hide behind (never anything that explodes). */
const COVER_PROPS = new Set(["block", "crate", "steel"]);

/**
 * Cover spots now: the tactical map's (terrain walls) plus a spot on each side of every block, crate and steel box
 * standing on a surface (props move and break, so these are found fresh). Deterministic: entity order.
 */
export function coverSpots(sim: Sim): CoverSpot[] {
  const out = sim.tactical.cover.slice();
  const r = sim.ruleset.combat.fighter.radius;
  const free = spotFree(sim);
  for (const e of sim.entities.values()) {
    if (e.dead || !COVER_PROPS.has(e.kind)) continue;
    const t = e.body.translation();
    if (Math.abs(e.body.linvel().y) > 0.5) continue;
    const s = sim.nav.surfaceAt(t.x, t.y - e.hh + 0.05, 0.3);
    if (!s || t.y - e.hh - s.y > 0.3) continue;
    const height = e.hh * 2;
    if (height < 0.75) continue;
    for (const side of [-1, 1] as const) {
      // stand on the side away from the prop: the prop is toward `side` from the spot
      const x = t.x - side * (e.hw + r + 0.15);
      if (x < s.x0 + 0.2 || x > s.x1 - 0.2) continue;
      out.push({ surface: s.id, x, y: s.y, side, height });
    }
  }
  return out.filter(free);
}

/** Is the line from `from`'s aim point to `to`'s body center clear (terrain and props block it, fighters don't)? */
export function lineClear(sim: Sim, from: Fighter, to: Fighter): boolean {
  const a = sim.pos(from), b = sim.pos(to);
  const aim = bodyHeights(sim.ruleset).aim - bodyHeights(sim.ruleset).center;
  const dx = b.x - a.x, dy = b.y - (a.y + aim);
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.1) return true;
  const hit = sim.raycast(a.x, a.y + aim, dx / len, dy / len, len, from.entity.collider);
  return !hit || hit.entity === to.entity || hit.dist >= len - 0.05 || hit.entity?.kind === "fighter" || hit.entity?.kind === "item";
}

/**
 * Would standing at (x, feet y) be in cover from `threat`? The line from its aim point to a body center there must be
 * blocked by terrain or a prop within `stances.cover.reach` of the spot (the same test as inCover, before moving).
 */
export function shelters(sim: Sim, threat: Fighter, x: number, feet: number): boolean {
  const a = sim.pos(threat);
  const h = bodyHeights(sim.ruleset);
  const ay = a.y + h.aim - h.center;
  const dx = x - a.x, dy = feet + h.center - ay;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.5) return false;
  const hit = sim.raycast(a.x, ay, dx / len, dy / len, len, threat.entity.collider);
  if (!hit || hit.entity?.kind === "fighter" || hit.entity?.kind === "item") return false;
  return len - hit.dist <= sim.ruleset.tactics.stances.cover.reach;
}

/** The nearest living rival of f (Manhattan distance, ties to the lower seat), or null. */
export function nearestRival(sim: Sim, f: Fighter): Fighter | null {
  const p = sim.pos(f);
  let best: Fighter | null = null, bd = Infinity;
  for (const o of sim.fighters) {
    if (!o.alive || o.removed || o.id === f.id) continue;
    const q = sim.pos(o);
    const d = Math.abs(q.x - p.x) + Math.abs(q.y - p.y);
    if (d < bd) {
      bd = d;
      best = o;
    }
  }
  return best;
}

/**
 * In cover (#38): terrain or a prop within `stances.cover.reach` of f blocks the line from its nearest living rival
 * (that rival's aim point to f's body center). Rules (`in_cover`), the accuracy model and the stats all use this.
 */
export function inCover(sim: Sim, f: Fighter): boolean {
  if (!f.alive || f.removed) return false;
  const threat = nearestRival(sim, f);
  if (!threat) return false;
  const a = sim.pos(threat), b = sim.pos(f);
  const aim = bodyHeights(sim.ruleset).aim - bodyHeights(sim.ruleset).center;
  const dx = b.x - a.x, dy = b.y - (a.y + aim);
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.5) return false;
  const hit = sim.raycast(a.x, a.y + aim, dx / len, dy / len, len, threat.entity.collider);
  if (!hit || hit.entity?.kind === "fighter" || hit.entity?.kind === "item") return false;
  return len - hit.dist <= sim.ruleset.tactics.stances.cover.reach;
}

/** In the open from `viewer`'s point of view (#38): a clear line within `stances.openRange`. */
export function inOpen(sim: Sim, viewer: Fighter, f: Fighter): boolean {
  if (!f.alive || f.removed || f.id === viewer.id) return false;
  const a = sim.pos(viewer), b = sim.pos(f);
  if (Math.abs(b.x - a.x) + Math.abs(b.y - a.y) > sim.ruleset.tactics.stances.openRange) return false;
  return lineClear(sim, viewer, f);
}

/** Carries a long gun (the ruleset's `stances.longGuns`, with ammo left). */
export function hasLongGun(sim: Sim, f: Fighter): boolean {
  return f.weapons.some((w) => isLongGun(sim.ruleset, w));
}

export function isLongGun(ruleset: Ruleset, w: Weapon): boolean {
  return (ruleset.tactics.stances.longGuns as readonly Weapon[]).includes(w);
}

/** On high ground: standing on a nav point the tactical map marks as high. */
export function onHighGround(sim: Sim, f: Fighter): boolean {
  if (!f.alive || f.removed || !f.grounded) return false;
  const p = sim.pos(f);
  const i = sim.tactical.pointAt(p.x, sim.feetY(f), 1.2);
  return i >= 0 && sim.tactical.rise[i]! >= sim.ruleset.tactics.stances.map.highRise;
}
