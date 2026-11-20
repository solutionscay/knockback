import { length2D } from "./dmath";
import { CLASSIC, type Ruleset } from "./ruleset";
import { traceRail } from "./rail-terrain";
import type { Fighter, Input, Sim, Weapon } from "./sim";

export function sightTarget(sim: Sim, me: Fighter, aimTarget: Fighter, mp: ReturnType<Sim["pos"]>) {
  const atp = sim.pos(aimTarget);
  const atv = sim.vel(aimTarget);
  const dx0 = atp.x - mp.x;
  const dy0 = atp.y - mp.y;
  const dist = length2D(dx0, dy0);
  const tactical = sim.ruleset.tactics.weapons;
  const height = tactical.enabled ? tactical.aimHeight : 0.25;
  const rayDistance = tactical.enabled ? length2D(dx0, dy0 - height) : dist;
  const sight = rayDistance > 0.1 ? sim.raycast(mp.x, mp.y + height, dx0 / rayDistance, (dy0 - height) / rayDistance, rayDistance + 0.5, me.entity.collider) : null;
  const los = !!sight && sight.entity === aimTarget.entity;
  return { atp, atv, dx0, dy0, dist, los, sight };
}

export function railCanReach(sim: Sim, p: ReturnType<Sim["pos"]>, target: ReturnType<typeof sightTarget>) {
  const y = p.y + (sim.ruleset.tactics.weapons.enabled ? sim.ruleset.tactics.weapons.aimHeight : 0.25);
  const dx = target.atp.x - p.x, dy = target.atp.y - y;
  const distance = length2D(dx, dy);
  if (distance < 0.1 || distance > sim.ruleset.weapons.table.railgun.range) return false;
  if (target.los) return true;
  if (target.sight && !target.sight.terrain && target.sight.entity?.kind !== "fighter") return false;
  return traceRail(sim.grid, p.x, y, dx / distance, dy / distance, distance, undefined, sim.ruleset.weapons.table.railgun.terrainPenetration) >= distance;
}

export function aimAndFire(
  sim: Sim,
  me: Fighter,
  mp: ReturnType<Sim["pos"]>,
  input: Input,
  weapon: Weapon,
  target: ReturnType<typeof sightTarget>,
  blocked: boolean,
  aimNoise: number,
): Input {
  const { atp, atv, dx0, dy0, dist, los } = target;
  input.weapon = weapon;

  let ax = dx0;
  let ay = dy0;
  if (weapon === "rocket" || weapon === "grenade" || weapon === "mine") {
    const speed = sim.ruleset.weapons.table[weapon].speed;
    const g = weapon === "grenade" ? sim.ruleset.combat.gravity : sim.ruleset.weapons.table[weapon].gravity;
    const t = dist / speed;
    const lx = atp.x + atv.x * t * 0.6 - mp.x;
    const ly = atp.y + Math.max(-2, atv.y * t * 0.3) - (mp.y + 0.25);
    // over a wall: the high arc
    const sol = ballisticAim(lx, ly - (weapon === "mine" ? 0.18 : 0), speed, g, blocked && weapon !== "grenade");
    ax = sol.x;
    ay = sol.y;
  } else {
    ay -= 0.25;
  }
  const al = length2D(ax, ay) || 1;
  input.aimX = ax / al;
  input.aimY = ay / al;

  let canFire = (sim.weapon(me) === weapon || weapon === "fist") && me.swap === 0 && me.cooldown[weapon] === 0 && me.stun === 0;
  switch (weapon) {
    case "mine":
      canFire &&= dist > 2.4 && dist <= sim.ruleset.weapons.table.mine.range;
      break;
    case "railgun":
      canFire &&= (dist >= sim.ruleset.weapons.table.railgun.minRange || me.railCharge > 0) && railCanReach(sim, mp, target);
      break;
    case "hammer":
      canFire &&= me.grounded && Math.abs(dx0) < sim.ruleset.weapons.table.hammer.range && Math.abs(dy0) < 1.4;
      if (canFire) {
        input.jump = false;
        input.thrust = false;
      }
      break;
    case "shotgun":
      canFire &&= dist <= sim.ruleset.weapons.table.shotgun.range - 0.6;
      break;
    case "rocket":
      canFire &&= dist <= 34 && dist >= sim.ruleset.weapons.table.rocket.minRange;
      break;
    case "grenade":
      canFire &&= dist <= 14 && dist > 2.5;
      break;
    case "bat":
      canFire &&= (dist <= 1.95 && Math.abs(dy0) < 1.6) || (blocked && dist < 3);
      break;
    case "fist":
      canFire &&= dist <= 1.45 && Math.abs(dy0) < 1.3;
      break;
    case "grapple":
      canFire &&= los && dist >= 3.5 && dist <= sim.ruleset.weapons.table.grapple.range - 0.5;
      break;
    case "flamethrower":
      canFire &&= dist <= sim.ruleset.weapons.table.flamethrower.range - 0.3;
      break;
  }
  if (canFire && weapon !== "bat" && weapon !== "fist" && weapon !== "grapple" && weapon !== "railgun" && weapon !== "hammer" && !(blocked && weapon === "shotgun")) {
    const hit = sim.raycast(mp.x, mp.y + 0.25, input.aimX, input.aimY, weapon === "shotgun" ? Math.min(dist, 6) : 2.2, me.entity.collider);
    if (hit && hit.terrain) canFire = false;
  }
  if (canFire) {
    const n = weapon === "railgun" && me.railCharge + 1 < sim.ruleset.weapons.table.railgun.chargeTicks ? 0 :
      aimNoise * sim.rng.gauss() * (weapon === "rocket" || weapon === "grenade" ? 1 : weapon === "railgun" ? 0.25 : 0.5);
    const nx = input.aimX - input.aimY * n;
    const ny = input.aimY + input.aimX * n;
    const l = length2D(nx, ny);
    input.aimX = nx / l;
    input.aimY = ny / l;
    input.fire = true;
  }
  return input;
}

/** Can this weapon reach a target at this distance (rough ranges, for use rules)? */
export function inReach(w: Weapon, dist: number, los: boolean, ruleset: Ruleset = CLASSIC): boolean {
  switch (w) {
    case "mine":
      return dist > 2.4 && dist <= ruleset.weapons.table.mine.range;
    case "railgun":
      return los && dist >= ruleset.weapons.table.railgun.minRange && dist <= ruleset.weapons.table.railgun.range;
    case "hammer":
      return dist <= ruleset.weapons.table.hammer.range;
    case "bat":
      return dist < 2.4;
    case "shotgun":
      return dist < ruleset.weapons.table.shotgun.range - 0.6;
    case "rocket":
      return dist >= ruleset.weapons.table.rocket.minRange && dist <= 34;
    case "grenade":
      return dist > 2.5 && dist < 14;
    case "grapple":
      return los && dist >= 3.5 && dist <= ruleset.weapons.table.grapple.range - 0.5;
    case "flamethrower":
      return los && dist <= ruleset.weapons.table.flamethrower.range - 0.3;
    default:
      return dist < 1.5;
  }
}

/**
 * Launch direction for a projectile with speed v under gravity g to hit (dx, dy).
 * Low arc; 45 degrees when out of range. Uses only sqrt.
 */
export function ballisticAim(dx: number, dy: number, v: number, g: number, high = false): { x: number; y: number } {
  const adx = Math.abs(dx);
  if (adx < 0.3) return { x: dx, y: dy };
  const v2 = v * v;
  const disc = v2 * v2 - g * (g * adx * adx + 2 * dy * v2);
  let tan: number;
  if (disc < 0) tan = 1;
  else tan = (v2 + (high ? 1 : -1) * Math.sqrt(disc)) / (g * adx);
  const sx = dx < 0 ? -1 : 1;
  const l = Math.sqrt(1 + tan * tan);
  return { x: sx / l, y: tan / l };
}
