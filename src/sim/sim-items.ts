import RAPIER from "@dimforge/rapier2d-deterministic-compat";
import { G, groups } from "./constants";
import { availableItem, CLASSIC, type Ruleset } from "./ruleset";
import { ordinaryWeapons, stockSpreadArmory } from "./spread-armory";
import type { Sim } from "./sim";
import { hasAmmo, isPickupWeapon, type Entity, type Fighter, type ItemType, type PowerUp, type Weapon } from "./sim-types";
import { clamp } from "./dmath";
import type { Rng } from "./rng";
import type { TimedPower } from "./entrance";

/** Starting weapons near each spawn, in the middle and up high, plus a central jetpack. */
export function stockArmory(sim: Sim, spawns: { x: number; y: number }[]) {
  if (sim.ruleset.pickups.armory.spread.enabled) return stockSpreadArmory(sim, spawns);
  const nav = sim.nav;
  const c = sim.zone.center;
  const placed: { x: number; y: number }[] = [];
  // Nearest free spot on a solid surface that meets the armory spacing.
  const near = (x: number, y: number, maxDy: number) => {
    let best: { x: number; y: number } | null = null;
    let bd = Infinity;
    for (const s of nav.surfaces) {
      if (s.x1 - s.x0 < 1 || s.fragile || Math.abs(s.y - y) > maxDy) continue;
      for (let k = 0; k <= 8; k++) {
        const px = clamp(x + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.75, s.x0 + 0.4, s.x1 - 0.4);
        if (placed.some((p) => Math.abs(p.x - px) < sim.ruleset.pickups.armory.minGap && Math.abs(p.y - s.y) < 1)) continue;
        const d = Math.abs(px - x) + Math.abs(s.y - y) * 1.5;
        if (d < bd) {
          bd = d;
          best = { x: px, y: s.y };
        }
        break;
      }
    }
    if (best) placed.push(best);
    return best;
  };
  const bag = sim.rng.shuffle(sim.ruleset.weapons.enabled.slice());
  let k = 0;
  const next = () => bag[k++ % bag.length]!;
  for (const sp of spawns) {
    for (let n = 0; n < sim.ruleset.pickups.armory.nearSpawn; n++) {
      const q = near(sp.x + (sp.x < c ? 1 : -1) * sim.ruleset.pickups.armory.spawnOffset, sp.y, 2.5);
      if (q) sim.spawnItem(next(), q.x, q.y + 0.4);
    }
  }
  const pack = sim.ruleset.pickups.enabled.includes("jetpack") ? near(c + sim.ruleset.pickups.armory.jetpackOffset, 0, 4) : null;
  if (pack) sim.spawnItem("jetpack", pack.x, pack.y + 0.4);
  for (let n = 0; n < sim.ruleset.pickups.armory.middle; n++) {
    const q = near(c + (n % 2 ? 2.5 : -2.5) * (1 + (n >> 1)), 0, 30);
    if (q) sim.spawnItem(next(), q.x, q.y + 0.4);
  }
  const high = nav.surfaces.filter((s) => s.y > 3.5 && s.x1 - s.x0 >= 2 && Math.abs((s.x0 + s.x1) / 2 - c) < 14);
  for (let n = 0; n < sim.ruleset.pickups.armory.high && high.length; n++) {
    const s = high.splice(sim.rng.int(0, high.length - 1), 1)[0]!;
    sim.spawnItem(sim.rng.pick(sim.ruleset.weapons.enabled), (s.x0 + s.x1) / 2 + 0.8, s.y + 0.4);
  }
}
/** Which weapon pickups a fighter wants, best first (from its strategy). */
export function setPrefs(sim: Sim, id: number, prefs: readonly Weapon[]) {
  const f = sim.fighters[id]!;
  const ok = prefs.filter((w, i) => sim.ruleset.weapons.enabled.includes(w) && prefs.indexOf(w) === i);
  // anything not listed still beats fists, after the listed ones
  f.prefs = [...ok, ...sim.ruleset.weapons.enabled.filter((w) => !ok.includes(w))];
}

/** Is a weapon pickup worth taking for this fighter right now? */
export function wantsWeapon(f: Fighter, w: Weapon): boolean {
  if (f.weapons.includes(w)) return false;
  if (f.weapons.includes("fist")) return true;
  const other = f.weapons[1 - f.slot]!;
  const rank = (x: Weapon) => {
    const i = f.prefs.indexOf(x);
    return i < 0 ? 99 : i;
  };
  return rank(w) < rank(other);
}

export function spawnItem(sim: Sim, type: ItemType, x: number, y: number, vx = 0, vy = 0): Entity {
  const body = sim.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y).setLinvel(vx, vy).setAngularDamping(1));
  const collider = sim.world.createCollider(
    RAPIER.ColliderDesc.cuboid(sim.ruleset.pickups.item.size / 2, sim.ruleset.pickups.item.size / 2)
      .setDensity(0.5)
      .setFriction(0.9)
      .setCollisionGroups(groups(G.ITEM, G.TERRAIN | G.PROP)),
    body,
  );
  const e: Entity = { id: sim.entityStore.allocateId(), kind: "item", body, collider, hw: sim.ruleset.pickups.item.size / 2, hh: sim.ruleset.pickups.item.size / 2, hp: 1, maxHp: 1, dead: false, born: sim.tick, itemType: type };
  sim.entityStore.register(e);
  sim.events.push({ type: "itemSpawn", tick: sim.tick, entity: e.id, item: type, x, y });
  return e;
}

export function randomPower(rng: Rng, ruleset: Ruleset = CLASSIC): PowerUp | null {
  const choices = ruleset.pickups.enabled;
  const weights = ruleset.pickups.weights;
  if (!choices.length) return null;
  const total = choices.reduce((a, p) => a + weights[p], 0);
  let r = rng.next() * total;
  for (const p of choices) {
    r -= weights[p];
    if (r < 0) return p;
  }
  return choices[0]!;
}

export function randomDrop(sim: Sim, weaponChance: number): ItemType {
  const weapons = ordinaryWeapons(sim);
  return sim.rng.chance(weaponChance) ? sim.rng.pick(weapons) : randomPower(sim.rng, sim.ruleset) ?? sim.rng.pick(weapons);
}

function looseWeapons(sim: Sim): number {
  let n = 0;
  for (const e of sim.entities.values()) if (e.kind === "item" && !e.dead && isPickupWeapon(e.itemType)) n++;
  return n;
}
function dropX(sim: Sim, rng: Rng = sim.rng): number {
  const z = sim.zone;
  const lo = Math.max(sim.level.minX + 3, z.center - z.half + 1.5);
  const hi = Math.min(sim.level.maxX - 3, z.center + z.half - 1.5);
  const avoid = sim.ruleset.pickups.supply.avoidDistance;
  if (avoid > 0) {
    const obstacles = [
      ...sim.alive().map(f => sim.pos(f).x),
      ...sim.items().map(e => e.body.translation().x),
    ];
    const points = [...new Set(sim.nav.points.filter(p => p.x >= lo && p.x <= hi).map(p => p.x))];
    if (points.length) {
      const nearest = (x: number) => obstacles.reduce((d, other) => Math.min(d, Math.abs(x - other)), Infinity);
      const clear = points.filter(x => nearest(x) >= avoid);
      if (clear.length) return rng.pick(clear);
      // The closing zone may leave no clear landing. Prefer the least crowded column.
      return points.reduce((best, x) => nearest(x) > nearest(best) ? x : best);
    }
  }
  // land on something: pick among nav surfaces inside the zone
  const surf = sim.nav.surfaces.filter((s) => s.x1 > lo + 0.5 && s.x0 < hi - 0.5 && s.x1 - s.x0 > 1.5);
  if (surf.length === 0) return rng.range(lo, hi);
  const s = rng.pick(surf);
  return rng.range(Math.max(lo, s.x0 + 0.5), Math.min(hi, s.x1 - 0.5));
}

/**
 * Start weapons that fall from the sky early in the round (#16), at clear points away from fighters and items.
 * They draw from their own stream of the round seed, so the rest of the round's chances stay as they were.
 */
export function skyDrop(sim: Sim, rng: Rng) {
  const weapons = ordinaryWeapons(sim);
  for (let n = 0; n < sim.ruleset.pickups.armory.spread.skyDrops; n++) sim.spawnItem(rng.pick(weapons), dropX(sim, rng), sim.ruleset.pickups.supply.itemHeight);
}

export function supplyDrop(sim: Sim, n: number) {
  const supply = sim.ruleset.pickups.supply;
  const wc = looseWeapons(sim) >= supply.maxLooseWeapons ? 0 : supply.weaponChance;
  sim.spawnItem(randomDrop(sim, wc), dropX(sim), supply.itemHeight);
  if (n % supply.propEvery === 0) {
    const x = dropX(sim);
    const tnt = sim.rng.chance(supply.tntChance);
    const a = sim.addProp(tnt ? "tnt" : "barrel", x, supply.propHeight);
    sim.events.push({ type: "propDrop", tick: sim.tick, entity: a.id, kind: a.kind, x, y: supply.propHeight });
    if (!tnt) {
      const b = sim.addProp("barrel", x + (sim.rng.chance(0.5) ? supply.barrelOffset : -supply.barrelOffset), supply.extraBarrelHeight);
      sim.events.push({ type: "propDrop", tick: sim.tick, entity: b.id, kind: b.kind, x, y: supply.extraBarrelHeight });
    }
    sim.stats.propsDropped += tnt ? 1 : 2;
  }
}
export function tickPowers(sim: Sim, f: Fighter) {
  const p = f.power;
  const end = (k: PowerUp) => sim.events.push({ type: "power", tick: sim.tick, fighter: f.id, power: k, on: false });
  if (p.shield > 0 && --p.shield === 0) end("shield");
  if (p.speed > 0 && --p.speed === 0) end("speed");
  if (p.damage > 0 && --p.damage === 0) end("damage");
  if (p.jump > 0 && --p.jump === 0) end("jump");
  if (p.heavy > 0 && --p.heavy === 0) {
    f.entity.collider.setDensity(sim.ruleset.combat.density);
    end("heavy");
  }
  if (f.padCd > 0) f.padCd--;
  if (f.crushCd > 0) f.crushCd--;
}
export function dropWeapons(sim: Sim, f: Fighter, x: number, y: number) {
  let side = -1;
  for (const w of f.weapons) {
    if (w === "fist") continue;
    const e = sim.spawnItem(w, x + side * 0.3, y + 0.6, side * 2.2, 4);
    e.owner = f.id;
    if (hasAmmo(w)) {
      e.ammo = f.ammo[w];
      f.ammo[w] = 0;
    }
    side = -side;
  }
  f.weapons = ["fist", "fist"];
}
export function checkPickups(sim: Sim, f: Fighter, x: number, y: number) {
  for (const e of sim.entities.values()) {
    if (e.kind !== "item" || e.dead) continue;
    const t = e.body.translation();
    // reach covers the whole body: from just below the feet to just above the head
    const dx = Math.abs(t.x - x);
    const dy = t.y - y;
    const half = sim.ruleset.combat.fighter.halfHeight + sim.ruleset.combat.fighter.radius;
    if (dx > sim.ruleset.pickups.item.pickupRange * 0.85 || dy < -half - sim.ruleset.pickups.item.reachBelow || dy > half + 0.3) continue;
    const it = e.itemType!;
    if (!availableItem(sim.ruleset, it)) continue;
    if (it === "jetpack" && f.power.jetpack > sim.ruleset.pickups.power.jetpack.fuelTicks / 2) continue;
    if (isPickupWeapon(it)) {
      // the one who just dropped it can't grab it straight back
      if (e.owner === f.id && sim.tick - e.born < sim.ruleset.pickups.armory.pickupGraceTicks) continue;
      if (!sim.wantsWeapon(f, it)) continue;
    }
    applyItem(sim, f, it, e.ammo);
    sim.events.push({ type: "pickup", tick: sim.tick, fighter: f.id, item: e.itemType!, x: t.x, y: t.y });
    sim.entityStore.remove(e);
    return;
  }
}

/**
 * A start power (#66 entry boost): the fighter has this power-up from the first tick, for `ticks` ticks. Set as a
 * pickup sets it (the shield's hit count starts at 0, heavy makes the body heavier), but it is no pickup (no stats).
 */
export function startPower(sim: Sim, f: Fighter, power: TimedPower, ticks: number) {
  f.power[power] = ticks;
  if (power === "shield") f.power.shieldHits = 0;
  if (power === "heavy") f.entity.collider.setDensity(sim.ruleset.combat.density * sim.ruleset.pickups.power.heavy.densityMul);
  sim.events.push({ type: "power", tick: sim.tick, fighter: f.id, power, on: true });
}

export function applyItem(sim: Sim, f: Fighter, it: ItemType, ammo?: number) {
  if (!availableItem(sim.ruleset, it)) return;
  f.pickups.push(it);
  const on = (p: PowerUp) => sim.events.push({ type: "power", tick: sim.tick, fighter: f.id, power: p, on: true });
  switch (it) {
    case "health":
      f.hp = Math.min(sim.ruleset.combat.fighter.maxHp, f.hp + sim.ruleset.pickups.item.healAmount);
      return;
    case "shield":
      f.power.shield = sim.ruleset.pickups.power.shield.ticks;
      f.power.shieldHits = 0;
      return on("shield");
    case "speed":
      f.power.speed = sim.ruleset.pickups.power.speed.ticks;
      return on("speed");
    case "heavy":
      f.power.heavy = sim.ruleset.pickups.power.heavy.ticks;
      f.entity.collider.setDensity(sim.ruleset.combat.density * sim.ruleset.pickups.power.heavy.densityMul);
      return on("heavy");
    case "damage":
      f.power.damage = sim.ruleset.pickups.power.damage.ticks;
      return on("damage");
    case "jump":
      f.power.jump = sim.ruleset.pickups.power.jump.ticks;
      return on("jump");
    case "jetpack":
      f.power.jetpack = sim.ruleset.pickups.power.jetpack.fuelTicks;
      return on("jetpack");
    default: {
      // a weapon: fill an empty (fists) slot, else replace the one not in hand and drop it
      if (f.weapons.includes(it)) return;
      const free = f.weapons[1 - f.slot] === "fist" ? 1 - f.slot : f.weapons[f.slot] === "fist" ? f.slot : -1;
      const other = (free >= 0 ? free : 1 - f.slot) as 0 | 1;
      const old = f.weapons[other]!;
      if (old !== "fist") {
        const p = sim.pos(f);
        const d = sim.spawnItem(old, p.x - f.facing * 0.4, p.y + 0.4, -f.facing * 2.5, 3.5);
        d.owner = f.id;
        if (hasAmmo(old)) {
          d.ammo = f.ammo[old];
          f.ammo[old] = 0;
        }
      }
      f.weapons[other] = it;
      if (hasAmmo(it)) f.ammo[it] = ammo ?? sim.ruleset.weapons.table[it].ammo;
      f.railCharge = 0;
      f.scope = 0;
      if (it === "flamethrower") f.fuel = sim.ruleset.weapons.table.flamethrower.fuel; // a full tank
      f.slot = other;
      f.swap = sim.ruleset.combat.swapTicks;
      f.cooldown[it] = 0;
      sim.events.push({ type: "swap", tick: sim.tick, fighter: f.id, weapon: it });
    }
  }
}

export function items(sim: Sim): Entity[] {
  const out: Entity[] = [];
  for (const e of sim.entities.values()) if (e.kind === "item" && !e.dead) out.push(e);
  return out;
}
