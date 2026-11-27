/**
 * Lightning sword (#72): a slash, or a bolt that electrifies the ground where it lands.
 *
 * Which one a pull of the trigger gives is the sim's call, from what is on the aim line: the slash when the first
 * fighter, prop or surface is closer than boltMinRange (or no bolt is left), the bolt otherwise. So the same aim
 * cuts what is in front and shoots what is further off, and a bolt never lands at the caster's own feet by aim.
 *
 * Live ground is updated every tick in a fixed order (strip id, then seat), with no randomness and no trig, so it is
 * the same in every JS engine. The values are the ruleset's `weapons.table.lightning`.
 */
import { CELL, type Grid } from "./grid";
import type { Sim } from "./sim";
import { shootChains } from "./sim-chains";
import { hitProp } from "./sim-objects";
import { chipTerrain } from "./sim-terrain";
import type { Fighter, ForceField, LiveGround } from "./sim-types";
import { absorbHit, fieldCut } from "./sim-field";

/** A bolt, or null when the slash is the right call: the first thing on the line is too close, or no bolt is left. */
export function boltLine(sim: Sim, f: Fighter, ox: number, oy: number, dx: number, dy: number) {
  const spec = sim.ruleset.weapons.table.lightning;
  if (f.ammo.lightning <= 0) return null;
  const ray = sim.raycast(ox, oy, dx, dy, spec.range, f.entity.collider);
  // #40: a force field's edge on the line is what the bolt meets first (too close: the slash)
  const cut = fieldCut(sim, ox, oy, dx, dy, ray ? ray.dist : spec.range);
  const first = cut ? cut.dist : ray ? ray.dist : Infinity;
  if (first < spec.boltMinRange) return null;
  return { hit: cut ? null : ray, field: cut };
}

/** Cast a bolt from (ox, oy) along (dx, dy); `hit` is the first thing on the line (boltLine). */
export function castBolt(sim: Sim, f: Fighter, ox: number, oy: number, dx: number, dy: number, hit: ReturnType<Sim["raycast"]>, field: { field: ForceField; dist: number } | null = null) {
  const spec = sim.ruleset.weapons.table.lightning;
  const dist = field ? field.dist : hit ? hit.dist : spec.range;
  const hx = ox + dx * dist, hy = oy + dy * dist;
  shootChains(sim, ox, oy, hx, hy, spec.boltPropDamage, f.id, "lightning");
  let kind: "fighter" | "prop" | "terrain" | "field" | "none" = "none";
  if (field) {
    // #40: stopped on a force field's edge: no live ground
    kind = "field";
    absorbHit(sim, field.field, spec.boltDamage, hx, hy, "lightning", f.id);
  }
  let target = -1;
  // where the floor goes live: under the fighter's feet, or under the point hit (a step back toward the caster, so a
  // wall's face finds the floor at its foot, not the cells inside it)
  let groundX = hx - dx * 0.1, groundY = hy - dy * 0.1;
  if (hit?.terrain) {
    kind = "terrain";
    chipTerrain(sim, hx, hy, dx, dy, spec.boltTerrainDamage);
  } else if (hit?.entity) {
    const e = hit.entity;
    if (e.kind === "fighter" && e.fighter) {
      kind = "fighter";
      target = e.fighter.id;
      const victim = e.fighter;
      groundX = sim.pos(victim).x;
      groundY = sim.feetY(victim) + 0.1;
      if (victim.alive) sim.damageFighter(victim, spec.boltDamage, f.id, dx * spec.boltKnockback, dy * spec.boltKnockback + spec.boltLift * spec.boltKnockback, "lightning", hx, hy);
    } else if (e.kind !== "item") {
      kind = "prop";
      hitProp(sim, e, spec.boltPropDamage, f.id, "lightning", hx, hy);
    }
  }
  const ground = hit ? electrify(sim, f.id, groundX, groundY) : null;
  sim.events.push({ type: "bolt", tick: sim.tick, fighter: f.id, x0: ox, y0: oy, x1: hx, y1: hy, hit: kind, target, ground: ground ? ground.id : -1 });
}

/** The top of the floor at column x, from y down to `drop` below it, or null when there is none. */
function floorBelow(grid: Grid, x: number, y: number, drop: number): number | null {
  const cx = grid.cx(x);
  for (let cy = grid.cy(y); cy >= grid.cy(y - drop); cy--) {
    if (grid.solid(cx, cy) && !grid.solid(cx, cy + 1)) return grid.wy(cy + 1);
  }
  return null;
}

/** Highest continuous floor within one step of the previous sample (as the hammer's wave walks the ground). */
function floorNear(grid: Grid, x: number, y: number, step: number): number | null {
  const cx = grid.cx(x);
  for (let cy = grid.cy(y + step) - 1; cy >= grid.cy(y - step) - 1; cy--) {
    const top = grid.wy(cy + 1);
    if (top >= y - step && grid.solid(cx, cy) && !grid.solid(cx, cy + 1)) return top;
  }
  return null;
}

/** Make the floor at (x, y) live: a strip groundWidth wide that follows the ground; null when there is no floor. */
export function electrify(sim: Sim, owner: number, x: number, y: number): LiveGround | null {
  const spec = sim.ruleset.weapons.table.lightning;
  const grid = sim.grid;
  const top = floorBelow(grid, x, y, spec.groundDrop);
  if (top === null || spec.groundTicks <= 0 || spec.groundWidth <= 0) return null;
  const half = spec.groundWidth / 2;
  const sides = [-1, 1].map(dir => {
    const out: { x: number; y: number }[] = [];
    let prev = top;
    for (let d = CELL / 2; d <= half; d += CELL / 2) {
      const at = floorNear(grid, x + dir * d, prev, spec.groundStep);
      if (at === null) break;
      out.push({ x: x + dir * d, y: at });
      prev = at;
    }
    return out;
  });
  const points = [...sides[0]!.reverse(), { x, y: top }, ...sides[1]!];
  const strip: LiveGround = { id: sim.entityStore.allocateId(), owner, born: sim.tick, ticks: spec.groundTicks, points };
  sim.liveGround.push(strip);
  return strip;
}

/** The point of a strip under a fighter's feet, or null when the fighter is not standing on it. */
export function stripUnder(sim: Sim, strip: LiveGround, x: number, feet: number): { x: number; y: number } | null {
  const reach = sim.ruleset.weapons.table.lightning.feetReach;
  const edge = sim.ruleset.combat.fighter.radius * 0.5 + CELL / 4;
  let best: { x: number; y: number } | null = null;
  for (const p of strip.points) {
    if (Math.abs(p.x - x) > edge || Math.abs(feet - p.y) > reach) continue;
    if (!best || Math.abs(p.x - x) < Math.abs(best.x - x)) best = p;
  }
  return best;
}

/** Is a fighter's body on live ground right now (any strip)? For the controller: it steps off and around. */
export function onLiveGround(sim: Sim, x: number, feet: number): LiveGround | null {
  for (const strip of sim.liveGround) if (stripUnder(sim, strip, x, feet)) return strip;
  return null;
}

/** Each tick: count the strips down, drop floor that broke away, shock who stands on live ground. */
export function updateLiveGround(sim: Sim) {
  for (const f of sim.fighters) if (f.shockCd > 0) f.shockCd--;
  if (!sim.liveGround.length) return;
  const spec = sim.ruleset.weapons.table.lightning;
  const grid = sim.grid;
  const shocked = new Set<number>();
  for (const strip of sim.liveGround) {
    // the floor under a point broke away: that point is no longer live
    strip.points = strip.points.filter(p => grid.solid(grid.cx(p.x), grid.cy(p.y - CELL / 2)));
    if ((sim.tick - strip.born) % spec.pulseTicks !== 0) continue;
    for (const f of sim.fighters) {
      if (!f.alive || f.removed || !f.grounded || shocked.has(f.id)) continue;
      const p = sim.pos(f);
      if (!stripUnder(sim, strip, p.x, sim.feetY(f))) continue;
      shocked.add(f.id);
      const stun = f.shockCd === 0;
      if (stun) {
        f.stun = Math.max(f.stun, spec.stunTicks);
        f.shockCd = spec.stunGap;
        f.railCharge = 0;
        f.scope = 0;
      }
      sim.events.push({ type: "shock", tick: sim.tick, fighter: f.id, by: strip.owner, x: p.x, y: p.y, stun });
      sim.damageFighter(f, spec.pulseDamage, strip.owner, 0, 0, "lightning", p.x, sim.feetY(f));
    }
  }
  for (const strip of sim.liveGround) strip.ticks--;
  sim.liveGround = sim.liveGround.filter(s => s.ticks > 0 && s.points.length > 0);
}
