import RAPIER from "@dimforge/rapier2d-deterministic-compat";
import { G, groups } from "./constants";
import { availableItem, CLASSIC, type Ruleset } from "./ruleset";
import { ordinaryWeapons, stockSpreadArmory } from "./spread-armory";
import type { Sim } from "./sim";
import { hasAmmo, isPickupWeapon, type Entity, type Fighter, type ItemType, type PowerUp, type Weapon } from "./sim-types";
import { cutOff, dropHeight, liveWeapons, looseWeapons, makeRoomForWeapon, weaponSpot } from "./weapon-spots";
import { clamp } from "./dmath";
import type { Rng } from "./rng";

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

/**
 * Share of a full load left in a weapon (#95): 1 = as it comes, 0 = empty. Fists (and nothing) count as empty. The
 * lightning sword counts its bolts. `ammo`: a count to rate instead of the carried one (a loose item's).
 */
export function ammoShare(ruleset: Ruleset, f: Fighter | null, w: Weapon, ammo?: number): number {
  if (!isPickupWeapon(w) || !hasAmmo(w)) return 0;
  const full = ruleset.weapons.table[w].ammo;
  const left = ammo ?? (f ? f.ammo[w] : full);
  return full > 0 ? Math.max(0, Math.min(1, left / full)) : 1;
}

/** The weapon a fighter carries (its one slot, #95), or "fist" for none. */
export function carried(f: Fighter): Weapon {
  return f.weapons[1];
}

/** Low on ammo (#95): what it carries is at or under the low share (house bots re-arm). */
export function lowOnAmmo(ruleset: Ruleset, f: Fighter): boolean {
  const w = carried(f);
  return w !== "fist" && ammoShare(ruleset, f, w) <= ruleset.tactics.pickup.lowAmmoShare;
}

/**
 * Is a weapon pickup worth taking for this fighter right now? One slot (#95): taking it drops the carried one.
 * Bare-handed, anything; low on ammo, anything with more left; otherwise a weapon it ranks higher. `ammo`: the
 * item's count (none = a full one).
 */
export function wantsWeapon(f: Fighter, w: Weapon, ruleset: Ruleset = CLASSIC, ammo?: number): boolean {
  if (w === "fist") return false;
  const held = carried(f);
  if (held === "fist") return true;
  const fresh = ammoShare(ruleset, null, w, ammo);
  const left = ammoShare(ruleset, f, held);
  if (left <= ruleset.tactics.pickup.lowAmmoShare) return fresh > left;
  if (held === w) return false;
  const rank = (x: Weapon) => {
    const i = f.prefs.indexOf(x);
    return i < 0 ? 99 : i;
  };
  return rank(w) < rank(held) && fresh > ruleset.tactics.pickup.lowAmmoShare;
}

export function spawnItem(sim: Sim, type: ItemType, x: number, y: number, vx = 0, vy = 0): Entity {
  const body = sim.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y).setLinvel(vx, vy).setAngularDamping(1));
  const collider = sim.world.createCollider(
    RAPIER.ColliderDesc.cuboid(sim.ruleset.pickups.item.size / 2, sim.ruleset.pickups.item.size / 2)
      .setDensity(0.5)
      .setFriction(0.9)
      .setCollisionGroups(groups(G.ITEM, G.TERRAIN | G.ONEWAY | G.PROP)),
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

/**
 * Room for another weapon on the floor (#95): fewer than supply.maxLooseWeapons are still in play (weapon-spots), and
 * fewer than a narrowing zone holds at the spots' item gap (one more per itemGap of zone width).
 */
export function roomForWeapon(sim: Sim): boolean {
  const max = sim.ruleset.pickups.supply.maxLooseWeapons;
  const fits = 1 + Math.floor((2 * sim.zone.half) / sim.ruleset.pickups.spots.itemGap);
  // out-of-play weapons count too, at twice the cap: they never pile up where nobody can get them
  return liveWeapons(sim) < Math.min(max, fits) && looseWeapons(sim).length < 2 * max;
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
 * A weapon falls in at a spread-out spot (#95, weapon-spots.ts): from the sky, or from just under whatever is above
 * the spot. Without a spot it falls from the sky at a clear column (the old way).
 */
function dropWeapon(sim: Sim, rng: Rng, weapon: Weapon): Entity {
  const top = sim.ruleset.pickups.supply.itemHeight;
  const p = weaponSpot(sim, rng);
  return p ? sim.spawnItem(weapon, p.x, dropHeight(sim, p, top)) : sim.spawnItem(weapon, dropX(sim, rng), top);
}

/**
 * Start weapons that fall from the sky early in the round (#16), at spread-out spots. They draw from their own stream
 * of the round seed, so the rest of the round's chances stay as they were.
 */
export function skyDrop(sim: Sim, rng: Rng) {
  const weapons = ordinaryWeapons(sim);
  for (let n = 0; n < sim.ruleset.pickups.armory.spread.skyDrops && roomForWeapon(sim); n++) dropWeapon(sim, rng, rng.pick(weapons));
}

export function supplyDrop(sim: Sim, n: number) {
  const supply = sim.ruleset.pickups.supply;
  // no weapon in play and someone bare-handed: this drop is a weapon (#95: fewer weapons, never none)
  const starved = liveWeapons(sim) === 0 && sim.alive().some((f) => f.weapons[1] === "fist");
  // a bare-handed fighter that can get to none of the weapons in play (#109): when its own ground has a spot, this drop
  // is a weapon there, past the cap (the oldest loose weapon makes way at twice the cap). One fighter's ground per
  // drop, taking turns: two cut off on separate islands share no spot
  const stranded = supply.cutOffDrops ? cutOff(sim) : [];
  const spot = stranded.length ? weaponSpot(sim, sim.rng, null, [], [stranded[n % stranded.length]!]) : null;
  const wc = spot ? 1 : !roomForWeapon(sim) ? 0 : starved ? 1 : supply.weaponChance;
  const item = randomDrop(sim, wc);
  if (isPickupWeapon(item) && spot) {
    makeRoomForWeapon(sim);
    sim.spawnItem(item, spot.x, dropHeight(sim, spot, supply.itemHeight));
  } else if (isPickupWeapon(item)) dropWeapon(sim, sim.rng, item);
  else sim.spawnItem(item, dropX(sim), supply.itemHeight);
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
    f.entity.collider.setDensity(f.stats.density);
    end("heavy");
  }
  if (f.padCd > 0) f.padCd--;
  if (f.crushCd > 0) f.crushCd--;
}
/** Body density under the Heavy power-up (#79): the build's density times densityMul, within builds.caps.density. */
export function heavyDensity(ruleset: Ruleset, f: Fighter): number {
  return Math.min(f.stats.density * ruleset.pickups.power.heavy.densityMul, ruleset.combat.density * ruleset.builds.caps.density);
}
/** Put the carried weapon on the floor with its ammo (#95): fists in hand. Returns the item, or null with none. */
export function dropCarried(sim: Sim, f: Fighter, x: number, y: number, vx: number, vy: number, reason: "swap" | "drop" | "ko"): Entity | null {
  const w = carried(f);
  if (w === "fist") return null;
  const e = sim.spawnItem(w, x, y, vx, vy);
  e.owner = f.id;
  if (hasAmmo(w)) {
    e.ammo = f.ammo[w];
    f.ammo[w] = 0;
  }
  f.weapons = ["fist", "fist"];
  f.slot = 0;
  f.railCharge = 0;
  f.scope = 0;
  sim.events.push({ type: "drop", tick: sim.tick, fighter: f.id, weapon: w, entity: e.id, ammo: e.ammo ?? 0, reason });
  return e;
}

/** An empty weapon is thrown away (#95): gone, fists in hand. */
export function throwAway(sim: Sim, f: Fighter, w: Weapon) {
  if (carried(f) !== w) return;
  f.weapons = ["fist", "fist"];
  f.slot = 0;
  f.railCharge = 0;
  f.scope = 0;
  if (hasAmmo(w)) f.ammo[w] = 0;
  sim.events.push({ type: "empty", tick: sim.tick, fighter: f.id, weapon: w });
  sim.events.push({ type: "swap", tick: sim.tick, fighter: f.id, weapon: "fist" });
}

/** A knocked-out fighter's weapon falls where it went out. */
export function dropWeapons(sim: Sim, f: Fighter, x: number, y: number) {
  dropCarried(sim, f, x - 0.3, y + 0.6, -2.2, 4, "ko");
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
      if (!sim.wantsWeapon(f, it, e.ammo)) continue;
      sim.recentPickups.push({ x: t.x, y: t.y, tick: sim.tick });
    }
    applyItem(sim, f, it, e.ammo);
    sim.events.push({ type: "pickup", tick: sim.tick, fighter: f.id, item: e.itemType!, x: t.x, y: t.y });
    sim.entityStore.remove(e);
    return;
  }
}

export function applyItem(sim: Sim, f: Fighter, it: ItemType, ammo?: number) {
  if (!availableItem(sim.ruleset, it)) return;
  f.pickups.push(it);
  const on = (p: PowerUp) => sim.events.push({ type: "power", tick: sim.tick, fighter: f.id, power: p, on: true });
  switch (it) {
    case "health":
      f.hp = Math.min(f.maxHp, f.hp + sim.ruleset.pickups.item.healAmount);
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
      f.entity.collider.setDensity(heavyDensity(sim.ruleset, f));
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
      // a weapon (#95): one slot, so the carried one drops behind with its ammo
      if (it === "fist") return;
      const p = sim.pos(f);
      dropCarried(sim, f, p.x - f.facing * 0.4, p.y + 0.4, -f.facing * 2.5, 3.5, "swap");
      f.weapons = ["fist", it];
      if (hasAmmo(it)) f.ammo[it] = ammo ?? sim.ruleset.weapons.table[it].ammo;
      f.railCharge = 0;
      f.scope = 0;
      f.slot = 1;
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
