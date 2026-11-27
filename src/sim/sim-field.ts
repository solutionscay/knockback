/**
 * Force fields (#40): a rare deployable bubble. The holder deploys it where it stands; it stays there, a circle of
 * `pickups.forceField.radius` around the middle of the holder's body, for `ticks` or until it has taken `absorb` damage.
 *
 * What it stops: anything that would cross its edge, from either side. Shots (rifle, sniper, crossbow, shotgun pellets,
 * the railgun, lightning bolts, the grappling hook, flame) end on the edge; rockets burst on it; grenades and thrown
 * mines bounce off it; a blast (and the hammer's ground wave) does not reach a fighter on the other side of the edge.
 * Each stop counts the full damage of the thing it stopped (a blast once, whoever was behind it). What it does not stop:
 * fighters (they walk through, so it never traps anyone or blocks a way), punches and swings, fire, live ground and
 * falls. So a fighter inside is safe from range, can't shoot out, and a rival can still walk in and fight up close.
 *
 * Only ray-circle sums and one square root (exact in IEEE 754): the same in every JS engine. Fields are kept in the
 * order they went up (at most one at a time in the Classic rules).
 */
import { DT } from "./constants";
import { length2D } from "./dmath";
import type { Sim } from "./sim";
import { FORCE_FIELD, type Fighter, type ForceField } from "./sim-types";

/** Is (x, y) inside the field (strictly within its edge)? */
export function insideField(f: ForceField, x: number, y: number): boolean {
  const dx = x - f.x, dy = y - f.y;
  return dx * dx + dy * dy < f.r * f.r;
}

/**
 * The first field edge along the ray from (ox, oy) in the unit direction (dx, dy), within maxDist: its distance, or
 * null when the ray crosses no edge that far. From inside a field, its edge is where the ray leaves it.
 */
export function fieldCut(sim: Sim, ox: number, oy: number, dx: number, dy: number, maxDist: number): { field: ForceField; dist: number } | null {
  let best: { field: ForceField; dist: number } | null = null;
  for (const f of sim.fields) {
    const mx = ox - f.x, my = oy - f.y;
    const b = mx * dx + my * dy;
    const c = mx * mx + my * my - f.r * f.r;
    const disc = b * b - c;
    if (disc < 0) continue;
    const s = Math.sqrt(disc);
    const t = c < 0 ? -b + s : -b - s;
    if (t < 0 || t > maxDist) continue;
    if (!best || t < best.dist) best = { field: f, dist: t };
  }
  return best;
}

/** A field whose edge lies between the two points (the straight segment from a to b crosses it), or null. */
export function fieldBetween(sim: Sim, ax: number, ay: number, bx: number, by: number): ForceField | null {
  if (!sim.fields.length) return null;
  const len = length2D(bx - ax, by - ay);
  if (len < 1e-9) return null;
  return fieldCut(sim, ax, ay, (bx - ax) / len, (by - ay) / len, len)?.field ?? null;
}

/** A field with (ax, ay) on one side of its edge and (bx, by) on the other (a blast's reach), or null. */
export function fieldApart(sim: Sim, ax: number, ay: number, bx: number, by: number): ForceField | null {
  for (const f of sim.fields) if (insideField(f, ax, ay) !== insideField(f, bx, by)) return f;
  return null;
}

/** The field this fighter stands in (the first, in the order they went up), or null. */
export function fieldAround(sim: Sim, fighter: Fighter): ForceField | null {
  if (!sim.fields.length) return null;
  const t = fighter.entity.body.translation();
  for (const f of sim.fields) if (insideField(f, t.x, t.y)) return f;
  return null;
}

/** The field took `damage` stopping something at (x, y): counted, evented, and it breaks when it has no more to give. */
export function absorbHit(sim: Sim, f: ForceField, damage: number, x: number, y: number, cause: string, source: number) {
  if (f.hp <= 0) return;
  const d = Math.max(0, damage);
  f.hp -= d;
  f.absorbed += d;
  sim.events.push({ type: "fieldHit", tick: sim.tick, field: f.id, x, y, damage: d, cause, source });
}

/** A thrown thing bounced off the edge: its damage counts the first time only (it may bounce again before it bursts). */
function stopThrown(sim: Sim, f: ForceField, id: number, damage: number, x: number, y: number, cause: string, source: number) {
  if (f.stopped.includes(id)) return;
  f.stopped.push(id);
  absorbHit(sim, f, damage, x, y, cause, source);
}

/** Is a force field in play: loose on the floor, carried, or up? (At most one at a time, #40.) */
export function fieldInPlay(sim: Sim): boolean {
  if (sim.fields.length) return true;
  if (sim.fighters.some((f) => f.alive && f.forceField > 0)) return true;
  for (const e of sim.entities.values()) if (e.kind === "item" && !e.dead && e.itemType === FORCE_FIELD) return true;
  return false;
}

/** Deploy the fighter's force field where it stands. */
export function deployField(sim: Sim, fighter: Fighter) {
  if (fighter.forceField <= 0) return;
  const spec = sim.ruleset.pickups.forceField;
  fighter.forceField--;
  const p = fighter.entity.body.translation();
  const f: ForceField = { id: sim.entityStore.allocateId(), owner: fighter.id, x: p.x, y: p.y, r: spec.radius, born: sim.tick, ticks: spec.ticks, hp: spec.absorb, absorbed: 0, stopped: [] };
  sim.fields.push(f);
  sim.events.push({ type: "fieldUp", tick: sim.tick, field: f.id, fighter: fighter.id, x: f.x, y: f.y, r: f.r });
}

/** Reflect (vx, vy) off the edge at (x, y) of field f, keeping `keep` of the speed. */
function bounceOff(f: ForceField, x: number, y: number, vx: number, vy: number, keep: number): { vx: number; vy: number } {
  const l = length2D(x - f.x, y - f.y) || 1;
  const nx = (x - f.x) / l, ny = (y - f.y) / l;
  const dot = vx * nx + vy * ny;
  return { vx: (vx - 2 * dot * nx) * keep, vy: (vy - 2 * dot * ny) * keep };
}

/**
 * A mine in flight that would cross an edge this tick bounces back off it (sim-mines.ts calls this before it moves the
 * mine). True when it bounced.
 */
export function bounceMine(sim: Sim, mine: { id: number; owner: number; x: number; y: number; vx: number; vy: number }): boolean {
  const { x, y, vx, vy } = mine;
  const len = length2D(vx * DT, vy * DT);
  if (len < 1e-9 || !sim.fields.length) return false;
  const cut = fieldCut(sim, x, y, (vx * DT) / len, (vy * DT) / len, len);
  if (!cut) return false;
  const hx = x + ((vx * DT) / len) * cut.dist, hy = y + ((vy * DT) / len) * cut.dist;
  const v = bounceOff(cut.field, hx, hy, vx, vy, sim.ruleset.pickups.forceField.bounce);
  mine.vx = v.vx;
  mine.vy = v.vy;
  stopThrown(sim, cut.field, mine.id, sim.ruleset.weapons.table.mine.damage, hx, hy, "mine", mine.owner);
  return true;
}

/**
 * Every tick, before the physics step: grenades about to cross an edge bounce off it; then fields tick down, and the
 * ones out of time or out of damage to take go down.
 */
export function updateFields(sim: Sim) {
  if (!sim.fields.length) return;
  const keep = sim.ruleset.pickups.forceField.bounce;
  for (const e of sim.entities.values()) {
    if (e.kind !== "grenade" || e.dead) continue;
    const t = e.body.translation(), v = e.body.linvel();
    const len = length2D(v.x * DT, v.y * DT);
    if (len < 1e-9) continue;
    // a grenade's radius ahead too, so it bounces off the edge, not through it
    const cut = fieldCut(sim, t.x, t.y, (v.x * DT) / len, (v.y * DT) / len, len + e.hw);
    if (!cut) continue;
    const hx = t.x + ((v.x * DT) / len) * cut.dist, hy = t.y + ((v.y * DT) / len) * cut.dist;
    const nv = bounceOff(cut.field, hx, hy, v.x, v.y, keep);
    e.body.setLinvel({ x: nv.vx, y: nv.vy }, true);
    stopThrown(sim, cut.field, e.id, sim.ruleset.weapons.table.grenade.damage, hx, hy, "grenade", e.owner ?? -1);
  }
  const left: ForceField[] = [];
  for (const f of sim.fields) {
    f.ticks--;
    if (f.hp <= 0 || f.ticks <= 0) {
      sim.events.push({ type: "fieldDown", tick: sim.tick, field: f.id, x: f.x, y: f.y, reason: f.hp <= 0 ? "broken" : "time", absorbed: f.absorbed });
      continue;
    }
    left.push(f);
  }
  sim.fields = left;
}
