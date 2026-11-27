/**
 * Precision weapons (#38): rifle, sniper and crossbow. Hitscan: the round stops at the first fighter, prop or terrain
 * cell. The accuracy model turns the shot by a seeded perpendicular offset: standing still or in cover = accurate;
 * walking, jumping or jetpacking = spread. No trig: the offset is applied as (dx - dy*n, dy + dx*n), normalized.
 */
import { length2D } from "./dmath";
import type { Sim } from "./sim";
import { shootChains } from "./sim-chains";
import { hitProp } from "./sim-objects";
import { chipTerrain } from "./sim-terrain";
import type { Fighter, PrecisionWeapon } from "./sim-types";
import { inCover } from "./tactical";
import { absorbHit, fieldCut } from "./sim-field";

/** The spread (perpendicular offset per meter) a fighter's shot gets right now (ruleset `weapons.accuracy`). */
export function spreadFor(sim: Sim, f: Fighter, weapon: PrecisionWeapon): number {
  const acc = sim.ruleset.weapons.accuracy;
  const a = acc[weapon];
  let s = a.still;
  if (f.jetting) s += a.jet;
  else if (!f.grounded) s += a.air;
  else {
    const speed = Math.abs(sim.vel(f).x);
    if (speed > acc.stillSpeed) s += a.move * Math.min(1.5, speed / sim.ruleset.combat.fighter.walkSpeed);
  }
  if (inCover(sim, f)) s *= acc.coverMul;
  return s;
}

export function firePrecision(sim: Sim, f: Fighter, weapon: PrecisionWeapon, ox: number, oy: number, dx: number, dy: number) {
  const table = sim.ruleset.weapons.table;
  const spec = table[weapon];
  const spread = spreadFor(sim, f, weapon);
  const n = spread * sim.rng.gauss();
  let rx = dx - dy * n;
  let ry = dy + dx * n;
  const l = length2D(rx, ry) || 1;
  rx /= l;
  ry /= l;
  const ray = sim.raycast(ox, oy, rx, ry, spec.range, f.entity.collider);
  // a force field's edge on the way stops the round (#40)
  const cut = fieldCut(sim, ox, oy, rx, ry, ray ? ray.dist : spec.range);
  const hit = cut ? null : ray;
  const dist = cut ? cut.dist : hit ? hit.dist : spec.range;
  const hx = ox + rx * dist, hy = oy + ry * dist;
  shootChains(sim, ox, oy, hx, hy, spec.propDamage, f.id, weapon);
  let kind: "fighter" | "prop" | "terrain" | "field" | "none" = "none";
  let target = -1;
  if (cut) {
    kind = "field";
    absorbHit(sim, cut.field, spec.damage, hx, hy, weapon, f.id);
  } else if (hit?.terrain) {
    kind = "terrain";
    chipTerrain(sim, hx, hy, rx, ry, spec.terrainDamage);
  } else if (hit?.entity) {
    const e = hit.entity;
    if (e.kind === "fighter" && e.fighter) {
      kind = "fighter";
      target = e.fighter.id;
      const victim = e.fighter;
      if (victim.alive) {
        if (weapon === "crossbow" && pinnable(sim, victim, rx, ry)) {
          // the bolt pins them to the wall behind: no shove, held for pinTicks
          sim.damageFighter(victim, spec.damage, f.id, 0, 0, weapon, hx, hy);
          if (victim.alive) {
            victim.pinned = table.crossbow.pinTicks;
            victim.railCharge = 0;
            victim.scope = 0;
            const p = sim.pos(victim);
            sim.events.push({ type: "pin", tick: sim.tick, fighter: victim.id, by: f.id, x: p.x, y: p.y });
          }
        } else {
          sim.damageFighter(victim, spec.damage, f.id, rx * spec.knockback, ry * spec.knockback + spec.lift * spec.knockback, weapon, hx, hy);
        }
      }
    } else if (e.kind !== "item") {
      kind = "prop";
      hitProp(sim, e, spec.propDamage, f.id, weapon, hx, hy);
      if (!e.dead) e.body.applyImpulseAtPoint({ x: rx * spec.knockback * 0.2, y: ry * spec.knockback * 0.2 }, { x: hx, y: hy }, true);
    }
  }
  sim.events.push({ type: "shot", tick: sim.tick, fighter: f.id, weapon, x0: ox, y0: oy, x1: hx, y1: hy, hit: kind, target, spread });
}

/** A wall or a heavy prop within pinReach behind the fighter, along the bolt. */
function pinnable(sim: Sim, victim: Fighter, rx: number, ry: number): boolean {
  const p = sim.pos(victim);
  const reach = sim.ruleset.weapons.table.crossbow.pinReach + sim.ruleset.combat.fighter.radius;
  const behind = sim.raycast(p.x, p.y, rx, ry, reach, victim.entity.collider);
  return !!behind && (behind.terrain || (!!behind.entity && behind.entity.kind !== "fighter" && behind.entity.kind !== "item" && behind.entity.kind !== "grenade"));
}
