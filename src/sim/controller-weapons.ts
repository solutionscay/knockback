import { ballisticAim, railCanReach, type sightTarget } from "./controller-aim";
import { length2D } from "./dmath";
import { Mat } from "./grid";
import type { Ruleset } from "./ruleset";
import { type Sim } from "./sim";
import { isPrecision, usesAmmo, type Fighter, type Input, type Weapon } from "./sim-types";

type Point = { x: number; y: number };
type Sight = ReturnType<typeof sightTarget>;
type RayHit = ReturnType<Sim["raycast"]>;
type Shot = { aim: Point; lob?: boolean; wall?: boolean };
export type WeaponChoice = { weapon: Weapon; shot?: Shot };
const MELEE: readonly Weapon[] = ["fist", "bat", "hammer"];
/** A weapon that fights from range (#69): its stand-off is this far or more (rocket, railgun, rifle, sniper, crossbow). */
export const RANGED_STANDOFF = 10;
const FIGHTER_ORDER: readonly Weapon[] = ["hammer", "bat", "flamethrower", "shotgun", "railgun", "sniper", "rocket", "crossbow", "rifle", "grenade", "mine", "grapple", "fist"];
const BREACH_ORDER: readonly Weapon[] = ["shotgun", "rocket", "grenade", "bat", "fist", "hammer", "mine"];

export function inWeaponBand(weapon: Weapon, distance: number, ruleset: Ruleset, dy = 0) {
  const spec = ruleset.tactics.weapons.reach[weapon];
  return distance >= spec.min && distance <= spec.max && (!spec.maxDy || Math.abs(dy) <= spec.maxDy);
}

function usable(sim: Sim, f: Fighter, weapon: Weapon) {
  return weapon === "fist" || (sim.ruleset.weapons.enabled.includes(weapon) && f.weapons.includes(weapon) &&
    (!usesAmmo(weapon) || f.ammo[weapon] > 0) && (weapon !== "flamethrower" || f.fuel > 0));
}

const distanceSafe = (sim: Sim, w: Weapon, distance: number) =>
  w !== "rocket" && w !== "grenade" && w !== "mine" || distance >= sim.ruleset.weapons.table[w].radius;

function aimVector(x: number, y: number): Point {
  const len = length2D(x, y) || 1;
  return { x: x / len, y: y / len };
}

function breakable(sim: Sim, origin: Point, dir: Point, hit: NonNullable<RayHit>) {
  if (!hit.terrain) return !!hit.entity && !["fighter", "item", "steel", "pad", "grenade", "weight"].includes(hit.entity.kind);
  const offset = hit.dist + sim.ruleset.tactics.weapons.wallSampleDepth;
  const g = sim.grid;
  const material = g.matAt(g.cx(origin.x + dir.x * offset), g.cy(origin.y + dir.y * offset));
  return material !== Mat.Empty && material !== Mat.Bedrock;
}

function arcTo(sim: Sim, shooter: Fighter, weapon: "grenade" | "rocket" | "mine", origin: Point, target: Sight, high: boolean) {
  const spec = sim.ruleset.weapons.table[weapon];
  const gravity = "gravity" in spec ? spec.gravity : sim.ruleset.combat.gravity;
  const time = target.dist / spec.speed;
  const x = target.atp.x - origin.x + target.atv.x * time * 0.6;
  const y = target.atp.y - origin.y + Math.max(-2, target.atv.y * time * 0.3);
  const aim = ballisticAim(x, y, spec.speed, gravity, high);
  if (!high) return aim;

  // Check the high arc up to the target column. A solid ceiling or tall wall requires a new route.
  const step = sim.ruleset.tactics.weapons.lobCheckStep;
  const vx = aim.x * spec.speed, vy = aim.y * spec.speed;
  const end = (target.atp.x - origin.x) / vx;
  if (end <= 0 || !Number.isFinite(end) || end > 4) return null;
  let p = origin;
  for (let time = step; time <= end + step; time += step) {
    const t = Math.min(end, time);
    const next = { x: origin.x + vx * t, y: origin.y + vy * t - gravity * t * t / 2 };
    const dx = next.x - p.x, dy = next.y - p.y;
    const length = length2D(dx, dy);
    if (length > 0) {
      const hit = sim.raycast(p.x, p.y, dx / length, dy / length, length, shooter.entity.collider);
      if (hit?.terrain || (hit?.entity && hit.entity.kind !== "fighter")) return null;
    }
    p = next;
  }
  return aim;
}

/** The same reach rules select fighter shots, obstruction shots and a weapon to keep in hand. */
export function chooseCombatWeapon(sim: Sim, me: Fighter, position: Point, target: Sight, preferred?: Weapon, ledge = false, digDirection?: number): WeaponChoice {
  const ruleset = sim.ruleset;
  const config = ruleset.tactics.weapons;
  const { dist, dy0, dx0, los } = target;
  const origin = { x: position.x, y: position.y + config.aimHeight };
  const direct = aimVector(dx0, dy0 - config.aimHeight);
  const carried = me.weapons.filter(w => w !== "fist" && usable(sim, me, w));
  const ranged = carried.some(w => !MELEE.includes(w));
  // a weapon that fights from range is kept in hand up close while the zone leaves room to back off to its range
  // (#69): no fists then
  const room = 2 * sim.zoneHalfAhead(0);
  const longReach = carried.some(w => config.reach[w].standOff >= RANGED_STANDOFF && room >= config.reach[w].standOff);
  const canHold = (w: Weapon) => (w === "fist" ? !longReach : carried.includes(w)) && (!ranged || !MELEE.includes(w) || inWeaponBand(w, dist, ruleset, dy0));
  const ready = (w: Weapon) => me.cooldown[w] <= (w === sim.weapon(me) ? 0 : ruleset.combat.swapTicks) + config.readyMarginTicks;
  const normal = FIGHTER_ORDER.filter(canHold);
  const preference = [preferred, ...(ledge ? ["grapple" as const] : [])].filter((w): w is Weapon => w !== undefined && normal.includes(w));
  const attack = [...new Set([...preference, ...normal])];
  const hasBand = (w: Weapon) => inWeaponBand(w, dist, ruleset, dy0) && distanceSafe(sim, w, dist) && (w !== "hammer" || me.grounded);
  const ray = target.sight;
  const obstruction = !los && ray && ray.entity?.kind !== "fighter" ? ray : null;
  const fighterShot = (w: Weapon): Shot | undefined => {
    if (!hasBand(w)) return;
    if (w === "railgun") return railCanReach(sim, position, target) ? { aim: direct } : undefined;
    // precision weapons (#38) are hitscan: they need a clear line
    if (isPrecision(w)) return los ? { aim: direct } : undefined;
    if (!los && w !== "grenade" && w !== "rocket" && (!MELEE.includes(w) || obstruction)) return;
    if (w === "rocket" || w === "grenade" || w === "mine") {
      const aim = arcTo(sim, me, w, origin, target, !los);
      if (!aim) return;
      const near = sim.raycast(origin.x, origin.y, aim.x, aim.y, ruleset.weapons.table[w].radius, me.entity.collider);
      if (near && near.entity?.kind !== "item") return;
      return { aim, lob: !los };
    }
    return { aim: direct };
  };
  if (me.railCharge > 0 && carried.includes("railgun")) return { weapon: "railgun", shot: fighterShot("railgun") };
  // aiming the sniper: keep it while the line stays clear (losing the line lets go and cancels the aim)
  if (me.scope > 0 && carried.includes("sniper")) return { weapon: "sniper", shot: fighterShot("sniper") };

  // A destructible face is a separate target. Use unlimited tools ahead of charged or limited ammo.
  const wallShot = (hit: NonNullable<RayHit>, aim: Point): WeaponChoice | undefined => {
    if (!breakable(sim, origin, aim, hit)) return;
    for (const w of BREACH_ORDER) {
      if (!canHold(w) || !ready(w) || !inWeaponBand(w, hit.dist, ruleset, aim.y * hit.dist) || !distanceSafe(sim, w, hit.dist) || (w === "hammer" && !me.grounded)) continue;
      if (w === "grenade" || w === "mine") {
        const speed = ruleset.weapons.table[w].speed;
        const gravity = w === "mine" ? ruleset.weapons.table.mine.gravity : ruleset.combat.gravity;
        const arc = ballisticAim(aim.x * hit.dist, aim.y * hit.dist, speed, gravity);
        return { weapon: w, shot: { aim: arc, wall: true } };
      }
      return { weapon: w, shot: { aim, wall: true } };
    }
  };
  if (obstruction) {
    const wall = wallShot(obstruction, direct);
    if (wall) return wall;
  }
  for (const w of attack) {
    if (!ready(w)) continue;
    const shot = fighterShot(w);
    if (shot) return { weapon: w, shot };
  }
  if (digDirection) {
    const dir = { x: digDirection, y: 0 };
    const hit = sim.raycast(origin.x, origin.y, dir.x, 0, config.reach.bat.max, me.entity.collider);
    const wall = hit && wallShot(hit, dir);
    if (wall) return wall;
  }
  // A cooling weapon can be held while the timer expires. When all targets are out of range,
  // carry the longest reach. Preference only matters between weapons that can make the shot.
  const cooling = attack.find(w => fighterShot(w));
  if (cooling) return { weapon: cooling };
  return { weapon: normal.reduce((best, w) =>
    config.reach[w].max > config.reach[best].max ? w : best, "fist" as Weapon) };
}

/**
 * How precision shots are taken (#38: still = accurate):
 *   steady   at the stance's spot: stand still to shoot
 *   move     rush and flank: shoot on the move (wider spread)
 *   transit  a defensive stance on its way to its spot: rifle and crossbow fire on the move, the sniper waits
 */
export type ShotMode = "steady" | "move" | "transit";

export function playCombatChoice(sim: Sim, me: Fighter, input: Input, choice: WeaponChoice, aimNoise: number, allowWallAdvance: boolean, mode: ShotMode = "move") {
  const { weapon, shot } = choice;
  input.weapon = weapon;
  if (!shot) return input;
  input.aimX = shot.aim.x;
  input.aimY = shot.aim.y;
  if (weapon === "sniper" && mode === "transit" && me.scope === 0) return input;
  if (isPrecision(weapon) && me.grounded && (mode === "steady" || me.scope > 0) && sim.weapon(me) === weapon) {
    input.move = 0;
    input.jump = false;
    input.thrust = false;
  }
  if (weapon === "hammer") {
    input.jump = false;
    input.thrust = false;
  }
  if (allowWallAdvance && shot.wall && MELEE.includes(weapon)) {
    input.jump = false;
    input.move = Math.sign(shot.aim.x) * sim.ruleset.tactics.weapons.wallAdvance;
  }
  if ((weapon !== "fist" && sim.weapon(me) !== weapon) || me.swap !== 0 || me.cooldown[weapon] !== 0 || me.stun !== 0) return input;
  // precision weapons get no controller noise: the sim's accuracy model spreads their shots
  if (!shot.wall && !shot.lob && !isPrecision(weapon) && !(weapon === "railgun" && me.railCharge + 1 < sim.ruleset.weapons.table.railgun.chargeTicks)) {
    const n = aimNoise * sim.rng.gauss() * (weapon === "railgun" ? 0.25 : weapon === "rocket" || weapon === "grenade" ? 1 : 0.5);
    const aim = aimVector(input.aimX - input.aimY * n, input.aimY + input.aimX * n);
    input.aimX = aim.x;
    input.aimY = aim.y;
  }
  input.fire = true;
  return input;
}
