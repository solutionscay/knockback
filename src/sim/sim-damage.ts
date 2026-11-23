import { G, groups } from "./constants";
import { type Ruleset } from "./ruleset";
import type { Sim } from "./sim";
import { type Fighter } from "./sim-types";
import { clamp, length2D } from "./dmath";
import { dropWeapons } from "./sim-items";

/** Knockback grows with the missing HP, as a share of the fighter's own max HP (#79). */
export function kbMult(f: Pick<Fighter, "hp" | "maxHp">, ruleset: Ruleset): number {
  const hp = Math.max(0, f.hp);
  return 1 + (clamp(f.maxHp - hp, 0, f.maxHp) / f.maxHp) * ruleset.combat.fighter.kbGrowth;
}

export function damageFighter(sim: Sim, f: Fighter, dmg: number, source: number, kbx: number, kby: number, cause: string, hx: number, hy: number) {
  if (!f.alive) return;
  const openingGrace = sim.ruleset.zone.suddenDeath.graceTicks > 0;
  if (!openingGrace && source >= 0 && source !== f.id && dmg > 0) sim.lastClashTick = sim.tick;
  const src = source >= 0 && source !== f.id ? sim.fighters[source]! : null;
  if (src) {
    // #79: the attacker's power, with the Damage power-up within builds.caps
    let dm = src.stats.power, km = src.stats.power;
    if (src.power.damage > 0) {
      dm = Math.min(dm * sim.ruleset.pickups.power.damage.mul, sim.ruleset.builds.caps.damage);
      km = Math.min(km * sim.ruleset.pickups.power.damage.kbMul, sim.ruleset.builds.caps.knockbackDealt);
    }
    dmg *= dm;
    kbx *= km;
    kby *= km;
  }
  let shielded = false;
  if (f.power.shield > 0 && cause !== "impact") {
    shielded = true;
    dmg *= sim.ruleset.pickups.power.shield.damageMul;
    kbx *= sim.ruleset.pickups.power.shield.kbMul;
    kby *= sim.ruleset.pickups.power.shield.kbMul;
    if (f.shieldTick !== sim.tick) {
      f.shieldTick = sim.tick;
      if (++f.power.shieldHits >= sim.ruleset.pickups.power.shield.hits) {
        f.power.shield = 0;
        const p = sim.pos(f);
        sim.events.push({ type: "shieldPop", tick: sim.tick, fighter: f.id, x: p.x, y: p.y });
      }
    }
  }
  // #79: the fighter's weight, with the Heavy power-up, never below builds.caps.knockbackTaken
  let taken = f.stats.knockback;
  if (f.power.heavy > 0) taken *= sim.ruleset.pickups.power.heavy.kbMul;
  taken = Math.max(taken, sim.ruleset.builds.caps.knockbackTaken);
  kbx *= taken;
  kby *= taken;
  if (openingGrace && src && dmg > 0) sim.lastClashTick = sim.tick;
  f.hp -= dmg;
  f.damageTaken += dmg;
  if (src) {
    src.damageDealt += dmg;
    f.lastHitBy = src.id;
    // slamming into a wall after a hit is credited to the weapon that launched you
    if (cause !== "impact") {
      f.lastHitTick = sim.tick;
      f.lastHitCause = cause;
    }
  } else if (source < 0 && cause !== "impact") {
    f.lastHitCause = cause;
  }
  let kb = 0;
  if (kbx !== 0 || kby !== 0) {
    f.pinned = 0; // a knock frees a fighter pinned by a bolt (#38)
    const m = kbMult(f, sim.ruleset);
    const body = f.entity.body;
    const v = body.linvel();
    const stack = f.kbTick === sim.tick;
    const launch = sim.ruleset.combat.launch;
    // #41: each extra kick in the same tick keeps less of its upward push (pellets, chain blasts)
    f.kbStack = stack ? f.kbStack + 1 : 0;
    let up = kby * m;
    // repeated multiply, not **: Math.pow may differ between JS engines in the last bit
    if (stack && up > 0 && launch.stackRetention < 1) for (let i = 0; i < f.kbStack; i++) up *= launch.stackRetention;
    const nvx = (stack ? v.x : v.x * 0.3) + kbx * m;
    let nvy = (stack ? v.y : Math.max(v.y * 0.3, 0)) + up;
    // #41: a launch never rises faster than maxUpSpeed (it can't slow a fighter already rising faster)
    if (nvy > launch.maxUpSpeed) nvy = Math.max(launch.maxUpSpeed, v.y);
    f.kbTick = sim.tick;
    body.setLinvel({ x: nvx, y: nvy }, true);
    kb = length2D(kbx, kby) * m;
    f.stun = Math.max(f.stun, Math.round(clamp(kb * 1.7, 6, 55)));
    f.grounded = false;
  }
  if (cause !== "impact") sim.events.push({ type: "hit", tick: sim.tick, target: f.id, source, damage: dmg, kb, x: hx, y: hy, cause, shielded });
  if (f.hp <= 0) {
    f.hp = 0;
    const p = sim.pos(f);
    knockOut(sim, f, "hp", p.x, p.y);
  }
}

export function knockOut(sim: Sim, f: Fighter, cause: "ringout" | "hp", x: number, y: number) {
  if (!f.alive) return;
  f.alive = false;
  f.koTick = sim.tick;
  f.koCause = cause;
  const by = sim.tick - f.lastHitTick < 300 ? f.lastHitBy : -1;
  f.koBy = by;
  if (by >= 0 && by !== f.id) sim.fighters[by]!.kos++;
  const weapon = by >= 0 ? f.lastHitCause || "unknown" : cause === "ringout" ? "fall" : f.lastHitCause || "crush";
  sim.events.push({ type: "ko", tick: sim.tick, fighter: f.id, cause, by, weapon, x, y });
  // a knocked-out fighter drops its weapons: up for grabs
  if (cause === "hp") dropWeapons(sim, f, x, y);
  f.entity.collider.setCollisionGroups(groups(G.PROP, G.TERRAIN | G.ONEWAY));
  f.entity.body.lockRotations(false, true);
  f.entity.body.setAngvel(f.facing * -6, true);
  if (cause === "ringout") removeFighterBody(sim, f);
}

export function removeFighterBody(sim: Sim, f: Fighter) {
  if (f.removed) return;
  f.removed = true;
  sim.entityStore.remove(f.entity);
}
