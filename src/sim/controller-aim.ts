import { WEAPONS } from "./constants";
import type { Fighter, Input, Sim, Weapon } from "./sim";

export function sightTarget(sim: Sim, me: Fighter, aimTarget: Fighter, mp: ReturnType<Sim["pos"]>) {
  const atp = sim.pos(aimTarget);
  const atv = sim.vel(aimTarget);
  const dx0 = atp.x - mp.x;
  const dy0 = atp.y - mp.y;
  const dist = Math.sqrt(dx0 * dx0 + dy0 * dy0);
  const sight = dist > 0.1 ? sim.raycast(mp.x, mp.y + 0.25, dx0 / dist, (dy0 - 0.25) / dist, dist + 0.5, me.entity.collider) : null;
  const los = !!sight && sight.entity === aimTarget.entity;
  return { atp, atv, dx0, dy0, dist, los };
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
  if (weapon === "rocket" || weapon === "grenade") {
    const speed = weapon === "rocket" ? WEAPONS.rocket.speed : WEAPONS.grenade.speed;
    const g = weapon === "rocket" ? WEAPONS.rocket.gravity : 20;
    const t = dist / speed;
    const lx = atp.x + atv.x * t * 0.6 - mp.x;
    const ly = atp.y + Math.max(-2, atv.y * t * 0.3) - (mp.y + 0.25);
    // over a wall: the high arc
    const sol = ballisticAim(lx, ly, speed, g, blocked && weapon === "rocket");
    ax = sol.x;
    ay = sol.y;
  } else {
    ay -= 0.25;
  }
  const al = Math.sqrt(ax * ax + ay * ay) || 1;
  input.aimX = ax / al;
  input.aimY = ay / al;

  let canFire = (sim.weapon(me) === weapon || weapon === "fist") && me.swap === 0 && me.cooldown[weapon] === 0 && me.stun === 0;
  switch (weapon) {
    case "shotgun":
      canFire &&= dist <= WEAPONS.shotgun.range - 0.6;
      break;
    case "rocket":
      canFire &&= dist <= 34 && dist >= WEAPONS.rocket.minRange;
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
      canFire &&= los && dist >= 3.5 && dist <= WEAPONS.grapple.range - 0.5;
      break;
  }
  if (canFire && weapon !== "bat" && weapon !== "fist" && weapon !== "grapple" && !(blocked && weapon === "shotgun")) {
    const hit = sim.raycast(mp.x, mp.y + 0.25, input.aimX, input.aimY, weapon === "shotgun" ? Math.min(dist, 6) : 2.2, me.entity.collider);
    if (hit && hit.terrain) canFire = false;
  }
  if (canFire) {
    const n = aimNoise * sim.rng.gauss() * (weapon === "rocket" || weapon === "grenade" ? 1 : 0.5);
    const nx = input.aimX - input.aimY * n;
    const ny = input.aimY + input.aimX * n;
    const l = Math.sqrt(nx * nx + ny * ny);
    input.aimX = nx / l;
    input.aimY = ny / l;
    input.fire = true;
  }
  return input;
}

/** Can this weapon reach a target at this distance (rough ranges, for use rules)? */
export function inReach(w: Weapon, dist: number, los: boolean): boolean {
  switch (w) {
    case "bat":
      return dist < 2.4;
    case "shotgun":
      return dist < WEAPONS.shotgun.range - 0.6;
    case "rocket":
      return dist >= WEAPONS.rocket.minRange && dist <= 34;
    case "grenade":
      return dist > 2.5 && dist < 14;
    case "grapple":
      return los && dist >= 3.5 && dist <= WEAPONS.grapple.range - 0.5;
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
