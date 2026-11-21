import { length2D } from "./dmath";
import type { Sim } from "./sim";
import type { Fighter, Input, Weapon } from "./sim-types";

type Point = { x: number; y: number };

import { WALL_PURSUIT } from "./controller-tuning";


export class WallPursuit {
  private tracking: { target: number; best: number; since: number; lastSeen: number } | null = null;

  observe(sim: Sim, me: Fighter, target: Fighter, p: Point) {
    const t = sim.pos(target);
    const dx = t.x - p.x;
    const dy = t.y - p.y;
    const dist = length2D(dx, dy);
    const hit = dist > 0.1 ? sim.raycast(p.x, p.y, dx / dist, dy / dist, dist, me.entity.collider) : null;
    const wall = hit && (hit.terrain || hit.entity?.kind === "block" || hit.entity?.kind === "chunk");
    const prev = this.tracking;
    if (!wall) {
      if (prev && sim.tick - prev.lastSeen > 18) this.tracking = null;
      return null;
    }
    if (!prev || prev.target !== target.id || dist < prev.best - 0.75) {
      this.tracking = { target: target.id, best: dist, since: sim.tick, lastSeen: sim.tick };
    } else prev.lastSeen = sim.tick;
    return {
      ticks: sim.tick - this.tracking!.since,
      x: p.x + dx / dist * hit.dist,
      y: p.y + dy / dist * hit.dist,
    };
  }
}

/** Aim at the face of the obstruction, within the selected tool's range. */
export function attackWall(sim: Sim, me: Fighter, p: Point, wall: Point, input: Input): boolean {
  const dx = wall.x - p.x;
  const dy = wall.y - (p.y + 0.25);
  const distance = length2D(dx, dy);
  if (distance < 0.05 || me.stun > 0) return false;
  const has = (w: Weapon) => me.weapons.includes(w);
  let weapon: Weapon;
  if (distance < 1.7 && me.grounded && has("hammer") && me.cooldown.hammer < 15) weapon = "hammer";
  else if (distance < 1.6 && has("bat")) weapon = "bat";
  else if (distance < sim.ruleset.weapons.table.shotgun.range - 0.3 && has("shotgun")) weapon = "shotgun";
  else if (distance < 1.45) weapon = "fist";
  else if (distance >= sim.ruleset.weapons.table.rocket.minRange + 0.5 && distance <= 10 && has("rocket")) weapon = "rocket";
  else if (distance >= 2.2 && distance < 5 && has("grenade")) weapon = "grenade";
  else return false;

  input.weapon = weapon;
  input.aimX = dx / distance;
  input.aimY = dy / distance;
  input.fire = (sim.weapon(me) === weapon || weapon === "fist") && me.swap === 0 && me.cooldown[weapon] === 0;
  if (weapon === "bat" || weapon === "fist" || weapon === "hammer") {
    // Keep contact with the wall instead of repeatedly jumping away from the impact point.
    input.jump = false;
    input.move = Math.abs(dx) < 0.35 ? 0 : Math.sign(dx) * 0.6;
  }
  return true;
}
