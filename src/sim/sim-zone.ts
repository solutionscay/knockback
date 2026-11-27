import { ordinaryWeapons } from "./spread-armory";
import { dropHeight, makeRoomForWeapon, suddenDeathSpot } from "./weapon-spots";
import { DT } from "./constants";
import { type Ruleset } from "./ruleset";
import type { Sim } from "./sim";
import { type Fighter } from "./sim-types";
import type { Surface } from "./nav";
import { clamp } from "./dmath";

/** Sudden-death drops (#95) fight from at least this far (m): they reach across a pit. */
const SUDDEN_DEATH_REACH = 8;

/** A zone edge stops only where a fighter can hold it (#156): on ground for this far (m) either side of it (the lowest
 * surface over every point there, not crumbling nor under a liquid, no step in it taller than EDGE_STEP_UP), with no
 * lip over a pit this close. An edge at a lip holds a fighter on the lip against the zone; an edge over a pit pushes
 * the fighters outside it into the pit. */
const EDGE_ROOM = 1.5;
/** How far (m) a stopping edge may move from its plain place to find such ground: out (a wider zone) or in. */
const EDGE_OUT = 6;
const EDGE_IN = 2;
const EDGE_STEP = 0.25;
const EDGE_STEP_UP = 1;
/** No pit this close (m) outside a stopping edge either: the zone would push the fighters out there across it. */
const EDGE_CLEAR_OUT = 4;

/** Can a zone edge stop at x (`out`: the side outside it, -1 left, 1 right)? */
export function holdableEdge(sim: Sim, x: number, out: -1 | 1): boolean {
  const nav = sim.nav;
  // a lip over a pit: not within EDGE_ROOM of the edge, nor within EDGE_CLEAR_OUT outside it
  const near = (lip: number) => (out > 0 ? lip > x - EDGE_ROOM && lip < x + EDGE_CLEAR_OUT : lip < x + EDGE_ROOM && lip > x - EDGE_CLEAR_OUT);
  for (const s of nav.surfaces) {
    if (s.dropLeft && near(s.x0) && nav.fallBelow(sim.grid, s.x0 - 0.3, s.y) === Infinity) return false;
    if (s.dropRight && near(s.x1) && nav.fallBelow(sim.grid, s.x1 + 0.3, s.y) === Infinity) return false;
  }
  let last: Surface | null = null;
  for (let xs = x - EDGE_ROOM; xs <= x + EDGE_ROOM + 1e-9; xs += EDGE_STEP) {
    let low: Surface | null = null;
    for (const s of nav.surfaces) if (s.x0 <= xs && s.x1 >= xs && (!low || s.y < low.y)) low = s;
    if (!low || low.fragile || (last && Math.abs(low.y - last.y) > EDGE_STEP_UP)) return false;
    last = low;
  }
  return true;
}

/** The edges [lo, hi] a zone stops at: each the nearest holdable place to its plain one, out (never past `outer`) before
 * in (never closer than 1 m to the level's zone centre) at the same distance; the plain place if none is in reach. */
export function holdableEdges(sim: Sim, lo: number, hi: number, outer: readonly [number, number]): [number, number] {
  const c = sim.level.zoneCenter;
  const pick = (x: number, out: -1 | 1): number => {
    for (let d = 0; d <= EDGE_OUT + 1e-9; d += EDGE_STEP) {
      const xo = x + out * d;
      if ((out < 0 ? xo >= outer[0] : xo <= outer[1]) && holdableEdge(sim, xo, out)) return xo;
      const xi = x - out * d;
      if (d > 0 && d <= EDGE_IN + 1e-9 && Math.abs(xi - c) >= 1 && holdableEdge(sim, xi, out)) return xi;
    }
    return x;
  };
  return [pick(lo, -1), pick(hi, 1)];
}

/** How far the regular shrink has gone `tick` into the round: 0 (holding) to 1 (at its end). */
function shrinkShare(tick: number, ruleset: Ruleset): number {
  return clamp((tick - ruleset.zone.boundary.holdTicks) / (ruleset.zone.boundary.shrinkEndTicks - ruleset.zone.boundary.holdTicks), 0, 1);
}

export class SimZone {
  /** where the regular shrink stops, and where sudden death's stops (set when it starts) */
  private end: [number, number] = [-Infinity, Infinity];
  private sdEnd: [number, number] = [-Infinity, Infinity];
  /** sudden death's own edges, closing on sdEnd */
  private sd: [number, number] = [-Infinity, Infinity];

  /** At the round's start (the level's nav built): where the regular shrink stops. */
  init(sim: Sim) {
    const z = sim.zone;
    const c = sim.level.zoneCenter, h = sim.ruleset.zone.boundary.endHalf;
    this.end = holdableEdges(sim, c - h, c + h, [c - z.startHalf, c + z.startHalf]);
  }

  /** The regular zone `tick` into the round: from the start edges to the stopping ones. */
  private regular(sim: Sim, tick: number): [number, number] {
    const k = shrinkShare(tick, sim.ruleset);
    const c = sim.level.zoneCenter, h0 = sim.zone.startHalf;
    return [c - h0 + (this.end[0] - (c - h0)) * k, c + h0 + (this.end[1] - (c + h0)) * k];
  }

  /** Set the zone for this tick: the regular shrink, inside sudden death's when that runs. */
  update(sim: Sim, tick: number) {
    const [lo, hi] = this.regular(sim, tick);
    setZone(sim, Math.max(lo, this.sd[0]), Math.min(hi, this.sd[1]));
    this.checkStalemate(sim, tick);
  }

  /** Quiet too long with 2+ alive: sudden death (sticky for the round). */
  private checkStalemate(sim: Sim, tick: number) {
    const z = sim.zone;
    const alive = sim.alive();
    const sdr = sim.ruleset.zone.suddenDeath;
    const quiet = tick - sim.lastClashTick;
    if (sim.lastClashTick >= 0 && sim.suddenDeath < 0 && alive.length >= 2 && quiet >= sdr.quietTicks) {
      sim.suddenDeath = tick;
      this.sd = [z.lo, z.hi];
      // where it stops, from the ground as it is now (the round's digging and blasts included)
      const c = sim.level.zoneCenter;
      this.sdEnd = holdableEdges(sim, c - sdr.endHalf, c + sdr.endHalf, [z.lo, z.hi]);
      sim.events.push({ type: "suddenDeath", tick, quietTicks: quiet });
    }
    if (sim.suddenDeath < 0) return;
    const step = sdr.shrinkPerSec * DT;
    this.sd = [Math.min(Math.max(this.sd[0], this.sdEnd[0]), this.sd[0] + step), Math.max(Math.min(this.sd[1], this.sdEnd[1]), this.sd[1] - step)];
    setZone(sim, Math.max(z.lo, this.sd[0]), Math.min(z.hi, this.sd[1]));
    // a weapon that fights from range for the survivors (#95): between them, from under any roof over them (sudden
    // death is for breaking stalemates: no spreading in a zone this narrow); at the cap on loose weapons the oldest
    // one goes to make room
    if (alive.length >= 2 && (tick - sim.suddenDeath) % sdr.dropEvery === 0) {
      const pool = ordinaryWeapons(sim);
      const ranged = pool.filter((w) => sim.ruleset.tactics.weapons.reach[w].max >= SUDDEN_DEATH_REACH);
      let sx = 0;
      let low = Infinity;
      for (const f of alive) {
        sx += sim.pos(f).x;
        low = Math.min(low, sim.feetY(f));
      }
      const mid = clamp(sx / alive.length, z.lo + 0.5, z.hi - 0.5);
      makeRoomForWeapon(sim);
      // on ground the survivors reach, nearest their midpoint, the drops taking turns either side of it (#159); else
      // the midpoint, from over the lowest of them
      const spot = suddenDeathSpot(sim, mid, ((tick - sim.suddenDeath) / sdr.dropEvery) % 2 === 0 ? -1 : 1);
      const x = spot ? spot.x : mid;
      const y = dropHeight(sim, spot ?? { x, y: low }, 15);
      const e = sim.spawnItem(sim.rng.pick(ranged.length ? ranged : pool), x, y);
      sim.events.push({ type: "itemSpawn", tick, entity: e.id, item: e.itemType!, x, y });
    }
  }

  /** The zone `ticks` from now (sudden death included), as [lo, hi]: where to stand. */
  ahead(sim: Sim, ticks: number): [number, number] {
    const [lo, hi] = this.regular(sim, sim.tick + ticks);
    if (sim.suddenDeath < 0) return [lo, hi];
    const step = sim.ruleset.zone.suddenDeath.shrinkPerSec * (ticks / 60);
    const sdLo = Math.min(Math.max(this.sd[0], this.sdEnd[0]), this.sd[0] + step);
    const sdHi = Math.max(Math.min(this.sd[1], this.sdEnd[1]), this.sd[1] - step);
    return [Math.max(lo, sdLo), Math.min(hi, sdHi)];
  }
}

function setZone(sim: Sim, lo: number, hi: number) {
  const z = sim.zone;
  z.lo = lo;
  z.hi = hi;
  z.center = (lo + hi) / 2;
  z.half = (hi - lo) / 2;
}

export function zonePush(sim: Sim, f: Fighter) {
  const z = sim.zone;
  const p = f.entity.body.translation();
  const out = !sim.zoneEnabled ? 0 : p.x < z.lo ? z.lo - p.x : p.x > z.hi ? -(p.x - z.hi) : 0;
  f.outsideZone = out !== 0;
  if (out === 0) {
    f.outsideTicks = 0;
    return;
  }
  const dir = out > 0 ? 1 : -1;
  const depth = Math.abs(out);
  // stuck outside (behind a wall, in a hole): the zone flings you back in, over obstacles
  const sd = sim.suddenDeath >= 0;
  const after = sd ? sim.ruleset.zone.suddenDeath.shockAfter : sim.ruleset.zone.boundary.shockAfter;
  const every = sd ? sim.ruleset.zone.suddenDeath.shockEvery : sim.ruleset.zone.boundary.shockEvery;
  if (++f.outsideTicks >= after && (f.outsideTicks - after) % every === 0) {
    const p2 = sim.pos(f);
    sim.damageFighter(f, sd ? sim.ruleset.zone.suddenDeath.shockDamage : sim.ruleset.zone.boundary.shockDamage, -1, 0, 0, "zone", p2.x, p2.y);
    if (!f.alive) return;
    f.entity.body.setLinvel({ x: dir * sim.ruleset.zone.boundary.shockX, y: sim.ruleset.zone.boundary.shockY }, true);
    f.stun = Math.max(f.stun, sim.ruleset.zone.boundary.shockStun);
    f.grounded = false;
    sim.events.push({ type: "zap", tick: sim.tick, fighter: f.id, x: p2.x, y: p2.y, dir });
    return;
  }
  const v = f.entity.body.linvel();
  let nvx: number;
  if (f.grounded && f.stun === 0) {
    const min = Math.min(sim.ruleset.zone.boundary.maxSpeed, sim.ruleset.zone.boundary.pushSpeed + sim.ruleset.zone.boundary.pushSpeedPerMeter * depth);
    nvx = dir > 0 ? Math.max(v.x, min) : Math.min(v.x, -min);
  } else {
    const a = sim.ruleset.zone.boundary.pushAccel + sim.ruleset.zone.boundary.pushPerMeter * depth;
    const w = v.x + dir * a * DT;
    nvx = dir > 0 ? Math.max(v.x, Math.min(w, sim.ruleset.zone.boundary.maxSpeed)) : Math.min(v.x, Math.max(w, -sim.ruleset.zone.boundary.maxSpeed));
  }
  f.entity.body.setLinvel({ x: nvx, y: v.y }, true);
}
