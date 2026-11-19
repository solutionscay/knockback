/**
 * House bots: pick one order per fighter per round. Four personalities.
 * They only choose { target, weapon, stance }; the controller does the rest.
 * Later, LLM agents will replace this function.
 */
import type { Rng } from "./rng";
import type { Fighter, Order, Sim, Stance, Weapon } from "./sim";

function enemies(sim: Sim, me: Fighter): Fighter[] {
  return sim.fighters.filter((f) => f.alive && f.id !== me.id);
}

function dist(sim: Sim, a: Fighter, b: Fighter): number {
  const p = sim.pos(a);
  const q = sim.pos(b);
  const dx = p.x - q.x;
  const dy = p.y - q.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function minBy<T>(arr: T[], key: (t: T) => number): T {
  let best = arr[0] as T;
  let bk = key(best);
  for (const t of arr) {
    const k = key(t);
    if (k < bk) {
      bk = k;
      best = t;
    }
  }
  return best;
}

export function decideOrder(sim: Sim, me: Fighter, rng: Rng): Order {
  const foes = enemies(sim, me);
  if (foes.length === 0) return { target: me.id, weapon: "rocket", stance: "distance" };
  const nearest = minBy(foes, (f) => dist(sim, me, f));
  const weakest = minBy(foes, (f) => f.hp);
  const strongest = minBy(foes, (f) => -f.hp - f.damageDealt * 0.3);
  const hasItems = sim.items().length > 0;
  const nd = dist(sim, me, nearest);
  let target: Fighter;
  let weapon: Weapon;
  let stance: Stance;

  switch (me.personality) {
    case "aggressive": {
      target = rng.chance(0.8) ? nearest : rng.pick(foes);
      const d = dist(sim, me, target);
      weapon = d > 13 && rng.chance(0.6) ? "rocket" : "shotgun";
      if (me.grenades > 0 && rng.chance(0.4)) weapon = "grenade";
      stance = me.hp < 25 && rng.chance(0.3) ? (hasItems ? "item" : "cover") : "rush";
      break;
    }
    case "sniper": {
      target = rng.chance(0.65) ? strongest : rng.pick(foes);
      weapon = me.grenades > 0 && rng.chance(0.25) ? "grenade" : "rocket";
      stance = nd < 6 ? (rng.chance(0.5) ? "cover" : "distance") : "distance";
      if (me.hp < 40 && hasItems && rng.chance(0.4)) stance = "item";
      break;
    }
    case "coward": {
      target = rng.chance(0.6) ? nearest : weakest;
      weapon = me.grenades > 0 && rng.chance(0.5) ? "grenade" : "rocket";
      stance = me.hp < 60 && hasItems ? "item" : rng.chance(0.75) ? "cover" : "distance";
      if (foes.length === 1 && me.hp > foes[0]!.hp + 20) stance = "rush";
      break;
    }
    case "opportunist": {
      target = weakest;
      const d = dist(sim, me, target);
      if (target.hp < 45) {
        stance = "rush";
        weapon = d < 9 ? "shotgun" : "rocket";
      } else if (hasItems && me.grenades === 0 && rng.chance(0.6)) {
        stance = "item";
        weapon = "rocket";
      } else {
        stance = rng.chance(0.6) ? "distance" : "cover";
        weapon = "rocket";
      }
      if (me.grenades > 0 && rng.chance(0.5)) weapon = "grenade";
      break;
    }
  }
  return { target: target.id, weapon, stance };
}
