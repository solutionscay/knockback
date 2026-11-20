import RAPIER from "@dimforge/rapier2d-deterministic-compat";
import { ARMORY, FIGHTER, FIGHTER_DENSITY, G, ITEM, POWER, SUPPLY, SWAP_TICKS, WEAPONS, groups } from "./constants";
import type { Sim } from "./sim";
import { isPickupWeapon, WEAPON_LIST, type Entity, type Fighter, type ItemType, type PowerUp, type Weapon } from "./sim-types";
import { clamp } from "./dmath";
import type { Rng } from "./rng";

const POWER_WEIGHTS: [PowerUp, number][] = [
  ["health", 3],
  ["shield", 2.5],
  ["speed", 2],
  ["heavy", 1.5],
  ["damage", 2],
  ["jump", 2],
  ["jetpack", 2],
];

/** Starting weapons near each spawn, in the middle and up high, plus a central jetpack. */
export function stockArmory(sim: Sim, spawns: { x: number; y: number }[]) {
  const nav = sim.nav;
  const c = sim.zone.center;
  const placed: { x: number; y: number }[] = [];
  // nearest free spot on a solid surface (weapons never stack: ARMORY.minGap apart)
  const near = (x: number, y: number, maxDy: number) => {
    let best: { x: number; y: number } | null = null;
    let bd = Infinity;
    for (const s of nav.surfaces) {
      if (s.x1 - s.x0 < 1 || s.fragile || Math.abs(s.y - y) > maxDy) continue;
      for (let k = 0; k <= 8; k++) {
        const px = clamp(x + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.75, s.x0 + 0.4, s.x1 - 0.4);
        if (placed.some((p) => Math.abs(p.x - px) < ARMORY.minGap && Math.abs(p.y - s.y) < 1)) continue;
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
  const bag = sim.rng.shuffle(WEAPON_LIST.slice());
  let k = 0;
  const next = () => bag[k++ % bag.length]!;
  for (const sp of spawns) {
    for (let n = 0; n < ARMORY.nearSpawn; n++) {
      const q = near(sp.x + (sp.x < c ? 1 : -1) * ARMORY.spawnOffset, sp.y, 2.5);
      if (q) sim.spawnItem(next(), q.x, q.y + 0.4);
    }
  }
  const pack = near(c + ARMORY.jetpackOffset, 0, 4);
  if (pack) sim.spawnItem("jetpack", pack.x, pack.y + 0.4);
  for (let n = 0; n < ARMORY.middle; n++) {
    const q = near(c + (n % 2 ? 2.5 : -2.5) * (1 + (n >> 1)), 0, 30);
    if (q) sim.spawnItem(next(), q.x, q.y + 0.4);
  }
  const high = nav.surfaces.filter((s) => s.y > 3.5 && s.x1 - s.x0 >= 2 && Math.abs((s.x0 + s.x1) / 2 - c) < 14);
  for (let n = 0; n < ARMORY.high && high.length; n++) {
    const s = high.splice(sim.rng.int(0, high.length - 1), 1)[0]!;
    sim.spawnItem(sim.rng.pick(WEAPON_LIST), (s.x0 + s.x1) / 2 + 0.8, s.y + 0.4);
  }
}
/** Which weapon pickups a fighter wants, best first (from its strategy). */
export function setPrefs(sim: Sim, id: number, prefs: readonly Weapon[]) {
  const f = sim.fighters[id]!;
  const ok = prefs.filter((w, i) => WEAPON_LIST.includes(w) && prefs.indexOf(w) === i);
  // anything not listed still beats fists, after the listed ones
  f.prefs = [...ok, ...WEAPON_LIST.filter((w) => !ok.includes(w))];
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
    RAPIER.ColliderDesc.cuboid(ITEM.size / 2, ITEM.size / 2)
      .setDensity(0.5)
      .setFriction(0.9)
      .setCollisionGroups(groups(G.ITEM, G.TERRAIN | G.PROP)),
    body,
  );
  const e: Entity = { id: sim.entityStore.allocateId(), kind: "item", body, collider, hw: ITEM.size / 2, hh: ITEM.size / 2, hp: 1, maxHp: 1, dead: false, born: sim.tick, itemType: type };
  sim.entityStore.register(e);
  sim.events.push({ type: "itemSpawn", tick: sim.tick, entity: e.id, item: type, x, y });
  return e;
}

export function randomPower(rng: Rng): PowerUp {
  const total = POWER_WEIGHTS.reduce((a, w) => a + w[1], 0);
  let r = rng.next() * total;
  for (const [p, w] of POWER_WEIGHTS) {
    r -= w;
    if (r < 0) return p;
  }
  return "health";
}

export function randomDrop(sim: Sim, weaponChance: number): ItemType {
  return sim.rng.chance(weaponChance) ? sim.rng.pick(WEAPON_LIST) : randomPower(sim.rng);
}

function looseWeapons(sim: Sim): number {
  let n = 0;
  for (const e of sim.entities.values()) if (e.kind === "item" && !e.dead && isPickupWeapon(e.itemType)) n++;
  return n;
}
function dropX(sim: Sim): number {
  const z = sim.zone;
  const lo = Math.max(sim.level.minX + 3, z.center - z.half + 1.5);
  const hi = Math.min(sim.level.maxX - 3, z.center + z.half - 1.5);
  // land on something: pick among nav surfaces inside the zone
  const surf = sim.nav.surfaces.filter((s) => s.x1 > lo + 0.5 && s.x0 < hi - 0.5 && s.x1 - s.x0 > 1.5);
  if (surf.length === 0) return sim.rng.range(lo, hi);
  const s = sim.rng.pick(surf);
  return sim.rng.range(Math.max(lo, s.x0 + 0.5), Math.min(hi, s.x1 - 0.5));
}

export function supplyDrop(sim: Sim, n: number) {
  const wc = looseWeapons(sim) >= SUPPLY.maxLooseWeapons ? 0 : SUPPLY.weaponChance;
  sim.spawnItem(randomDrop(sim, wc), dropX(sim), 16);
  if (n % 2 === 0) {
    const x = dropX(sim);
    const tnt = sim.rng.chance(0.3);
    const a = sim.addProp(tnt ? "tnt" : "barrel", x, 15);
    sim.events.push({ type: "propDrop", tick: sim.tick, entity: a.id, kind: a.kind, x, y: 15 });
    if (!tnt) {
      const b = sim.addProp("barrel", x + (sim.rng.chance(0.5) ? 0.75 : -0.75), 16.4);
      sim.events.push({ type: "propDrop", tick: sim.tick, entity: b.id, kind: b.kind, x, y: 16.4 });
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
    f.entity.collider.setDensity(FIGHTER_DENSITY);
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
    const half = FIGHTER.halfHeight + FIGHTER.radius;
    if (dx > ITEM.pickupRange * 0.85 || dy < -half - ITEM.reachBelow || dy > half + 0.3) continue;
    const it = e.itemType!;
    if (it === "jetpack" && f.power.jetpack > POWER.jetpack.fuelTicks / 2) continue;
    if (isPickupWeapon(it)) {
      // the one who just dropped it can't grab it straight back
      if (e.owner === f.id && sim.tick - e.born < ARMORY.pickupGraceTicks) continue;
      if (!sim.wantsWeapon(f, it)) continue;
    }
    sim.applyItem(f, it);
    sim.events.push({ type: "pickup", tick: sim.tick, fighter: f.id, item: e.itemType!, x: t.x, y: t.y });
    sim.entityStore.remove(e);
    return;
  }
}

export function applyItem(sim: Sim, f: Fighter, it: ItemType) {
  f.pickups.push(it);
  const on = (p: PowerUp) => sim.events.push({ type: "power", tick: sim.tick, fighter: f.id, power: p, on: true });
  switch (it) {
    case "health":
      f.hp = Math.min(FIGHTER.maxHp, f.hp + ITEM.healAmount);
      return;
    case "shield":
      f.power.shield = POWER.shield.ticks;
      f.power.shieldHits = 0;
      return on("shield");
    case "speed":
      f.power.speed = POWER.speed.ticks;
      return on("speed");
    case "heavy":
      f.power.heavy = POWER.heavy.ticks;
      f.entity.collider.setDensity(FIGHTER_DENSITY * POWER.heavy.densityMul);
      return on("heavy");
    case "damage":
      f.power.damage = POWER.damage.ticks;
      return on("damage");
    case "jump":
      f.power.jump = POWER.jump.ticks;
      return on("jump");
    case "jetpack":
      f.power.jetpack = POWER.jetpack.fuelTicks;
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
      }
      f.weapons[other] = it;
      if (it === "flamethrower") f.fuel = WEAPONS.flamethrower.fuel; // a full tank
      f.slot = other;
      f.swap = SWAP_TICKS;
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
