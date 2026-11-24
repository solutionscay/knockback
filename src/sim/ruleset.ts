import { SUPPLY } from "./constants";
import { CLOSE_ARMORY, RULESET_DEFAULTS } from "./ruleset-defaults";
import { ALL_THEMES, CLOSE_SPAWNS } from "./level-config";
import { Mat, MAT_MAX } from "./grid";
import { isPickupWeapon, WEAPON_LIST, type ItemType, type Weapon } from "./sim-types";

type Wide<T> = T extends number ? number : T extends boolean ? boolean
  : T extends readonly unknown[] ? { readonly [K in keyof T]: Wide<T[K]> }
  : T extends object ? { readonly [K in keyof T]: Wide<T[K]> } : T;

/** Validated immutable data. The Classic template is also the canonical key order. */
export type Ruleset = Wide<typeof RULESET_DEFAULTS>;
export const RULESET_MAX_ROUNDS = 9;
export class RulesetError extends Error {
  constructor(path: string, problem: string) {
    super(`${path}: ${problem}`);
    this.name = "RulesetError";
  }
}

const lists: Readonly<Record<string, readonly (string | number)[]>> = {
  "weapons.enabled": RULESET_DEFAULTS.weapons.enabled,
  "pickups.armory.spread.powerWeapons": WEAPON_LIST,
  "tactics.stances.longGuns": WEAPON_LIST,
  "pickups.enabled": RULESET_DEFAULTS.pickups.enabled,
  "arena.enabledThemes": ALL_THEMES,
  "fire.materials": [Mat.Dirt, Mat.Rock, Mat.Wood, Mat.Steel, Mat.Concrete, Mat.Crumble, Mat.Brick, Mat.Sand, Mat.Mud, Mat.Ice],
  "fire.props": RULESET_DEFAULTS.fire.props,
};
const signed = new Set(["hpBonus", "ringOutY", "bottom", "minHeight", "groundMin", "desperateBelow", "confidentAt"]);
const realArrays = new Set(["edgeInset", "mainPitWidth", "extraPitWidth", "groundHeight", "rooftopHeight", "groundRun", "platformLength", "platformHeights", "weightLength", "heights", "hitPoints", "density", "width"]);
const ranges = new Set(["softDepth", "topRows", "pools", "width", "depth", "halfWidth", "edgeInset", "mainPitWidth", "extraPitWidth", "groundHeight", "rooftopHeight", "groundRun", "overhangCells", "platformLength", "coverStacks", "coverColumns", "coverRows", "weightLength", "widthCells", "extraPits", "towers", "platforms"]);
const zeroAllowed = new Set(["nearSpawn", "middle", "high", "maxLooseWeapons", "groundCoverStacks", "minimumCover", "minimumProps", "minimumPlatforms", "skyDrops", "skyDropTicks", "betweenCaches", "startWeapons", "powerStart", "holdTicks", "firstTick"]);
const strictlyPositive = new Set(["ammo", "pellets", "cooldown", "boltCooldown", "pulseTicks", "interval", "chargeTicks", "aimTicks", "viewStep", "step", "propEvery", "dropEvery", "shockEvery", "everyTicks", "peekEvery", "pressFlip", "flankPeriod", "barrelPairDivisor", "attempts", "maxRounds", "winsToTake", "fightTicks", "finishTicks"]);
const fractions = /(?:chance|^crumble$|retention|^(?:regular|cracked)Hp)$/i;
const integral = /(?:ticks|cells|attempts|^hits$|^minOnTicks$|^minOffTicks$|^fuse(?:Min|Max)?$|^chainFuse$|^burnMin$|^burnMax$|^rows$|^maxLife$)/i;

/**
 * Settings renamed since rulesets were first stored (match records pin theirs, presets keep theirs): an old body still
 * loads. By object path: old key -> new key. The new key wins when both are given; the old one is then dropped.
 *   #95 (#99): the flamethrower's `fuel` (pulses in a full tank) is its `ammo`, like every weapon's
 */
const LEGACY_KEYS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "weapons.table.flamethrower": { fuel: "ammo" },
};

function legacy(path: string, src: Record<string, unknown>): Record<string, unknown> {
  const renames = LEGACY_KEYS[path];
  if (!renames || !Object.keys(renames).some((k) => Object.hasOwn(src, k))) return src;
  const out = { ...src };
  for (const [old, now] of Object.entries(renames)) {
    if (!Object.hasOwn(out, old)) continue;
    if (!Object.hasOwn(out, now)) out[now] = out[old];
    delete out[old];
  }
  return out;
}

function canonical(base: unknown, value: unknown, path = ""): unknown {
  const fail = (problem: string): never => { throw new RulesetError(path || "ruleset", problem); };
  if (value === undefined) value = base;
  if (Array.isArray(base)) {
    if (!Array.isArray(value)) return fail("expected an array");
    const order = lists[path];
    if (order) {
      if (value.some(v => !order.includes(v))) return fail(`allowed values are ${order.join(", ")}`);
      if (new Set(value).size !== value.length) return fail("values must be unique");
      if (value.length === 0 && (path === "weapons.enabled" || path === "arena.enabledThemes")) return fail("select at least one");
      return Object.freeze(order.filter(v => value.includes(v)));
    }
    // #94 added materials: a ruleset saved before them (a match record) gets their default hit points and density
    const list: unknown[] = (path === "arena.terrain.hitPoints" || path === "arena.terrain.density") && value.length < base.length ? [...value, ...base.slice(value.length)] : value;
    if (list.length !== base.length) return fail(`expected ${base.length} entries`);
    const row = base.map((v, i) => canonical(v, list[i], `${path}.${i}`));
    const field = path.split(".").at(-1)!;
    if ((ranges.has(field) || path.includes(".themes.") && path.includes(".props.")) && typeof row[0] === "number" && typeof row[1] === "number" && row[0] > row[1]) return fail("minimum must be at most maximum");
    return Object.freeze(row);
  }
  if (typeof base === "object" && base !== null) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return fail("expected an object");
    const src = legacy(path, value as Record<string, unknown>);
    const template = base as Record<string, unknown>;
    for (const key of Object.keys(src)) if (!Object.hasOwn(template, key)) throw new RulesetError(path ? `${path}.${key}` : key, "unknown setting");
    return Object.freeze(Object.fromEntries(Object.keys(template).map(key => [key, canonical(template[key], Object.hasOwn(src, key) ? src[key] : undefined, path ? `${path}.${key}` : key)])));
  }
  if (typeof base === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return fail("expected a finite number");
    const parts = path.split(".");
    const leaf = parts.at(-1)!;
    const member = /^\d+$/.test(leaf) ? parts.at(-2)! : leaf;
    const material = /\.themes\.[^.]+\.(body|surface|tower|platform|bridge|speckle\.on|speckle\.mat)(?:\.|$)/.test(path);
    if (material && (!Number.isInteger(value) || value < Mat.Dirt || value > MAT_MAX || value === Mat.Bedrock)) return fail(`expected a destructible material ID (1–6 or 8–${MAT_MAX})`);
    if (/\.themes\.[^.]+\.stage\.frame$/.test(path) && (!Number.isInteger(value) || value < 0 || value > MAT_MAX || value === Mat.Bedrock)) return fail("expected 0 (none) or a destructible material ID");
    if (/\.themes\.[^.]+\.parapet$/.test(path) && (!Number.isInteger(value) || value < 0 || value > MAT_MAX || value === Mat.Bedrock)) return fail("expected 0 (none) or a destructible material ID");
    const whole = strictlyPositive.has(leaf) || zeroAllowed.has(leaf) || integral.test(leaf) || path.includes(".themes.") && path.includes(".props.") || /^\d+$/.test(leaf) && ranges.has(member) && !realArrays.has(member);
    if (whole && !Number.isInteger(value)) return fail("expected a whole number");
    const low = signed.has(member) || ["groundHeight", "rooftopHeight", "groundStep"].includes(member) ? -1_000 : strictlyPositive.has(leaf) ? 1 : 0;
    let high = 36_000;
    if (fractions.test(leaf) || path === "fire.spread") high = 1;
    if (/Attempts$/.test(leaf)) high = 500;
    if (path === "arena.spawns.spread.jitter" || path === "arena.spawns.spread.innerOutset" || path === "arena.spawns.spread.outerOutset") high = 0.49;
    if (leaf === "skyDrops" || leaf === "betweenCaches" || leaf === "startWeapons" || leaf === "powerStart") high = 8;
    if (path === "pickups.supply.avoidDistance") high = 40;
    if (path === "arena.layout.attempts") high = 100;
    if (path.includes(".themes.") && path.includes(".props.") || ["towers", "platforms", "extraPits", "coverStacks", "coverColumns", "coverRows"].includes(member)) high = 64;
    if (path === "arena.navigation.headroomCells") high = 16;
    if (path === "fire.propReach" || path === "fire.touch" || path === "combat.fighter.radius" || path === "combat.fighter.halfHeight" || path.startsWith("arena.propHalf.")) high = 8;
    if (path.startsWith("pickups.armory.") && ["nearSpawn", "middle", "high"].includes(leaf)) high = 16;
    if (value < low || value > high) return fail(`expected a value from ${low} to ${high}`);
    return value === 0 ? 0 : value;
  }
  if (typeof value !== typeof base) return fail(`expected ${typeof base}`);
  return value;
}

export function validateRuleset(input: unknown): Ruleset {
  const r = canonical(RULESET_DEFAULTS, input) as Ruleset;
  const require = (ok: boolean, path: string, problem: string) => { if (!ok) throw new RulesetError(path, problem); };
  require(r.round.maxRounds <= RULESET_MAX_ROUNDS && r.round.winsToTake <= r.round.maxRounds, "round", `use at most ${RULESET_MAX_ROUNDS} rounds and a win target no larger than maxRounds`);
  require(r.round.finishTicks <= r.round.fightTicks, "round.finishTicks", "must fit inside the fight");
  require(r.zone.boundary.shrinkEndTicks > r.zone.boundary.holdTicks, "zone.boundary.shrinkEndTicks", "must be after holdTicks");
  require(r.zone.suddenDeath.endHalf > 0 && r.zone.suddenDeath.endHalf <= r.zone.boundary.endHalf, "zone.suddenDeath.endHalf", "must be positive and at most the regular end width");
  require(r.zone.boundary.edgeInset + r.zone.boundary.endHalf < r.arena.layout.halfWidth[0], "zone.boundary", "end width and edge inset must fit inside the smallest arena");
  require(r.fire.burnMin <= r.fire.burnMax, "fire.burnMin", "must be at most burnMax");
  require(r.weapons.table.mine.armTicks < r.weapons.table.mine.fuse, "weapons.table.mine.armTicks", "must be shorter than the fuse");
  require(r.weapons.table.railgun.minRange < r.weapons.table.railgun.range, "weapons.table.railgun.minRange", "must be below range");
  require(r.weapons.table.sniper.minRange < r.weapons.table.sniper.range, "weapons.table.sniper.minRange", "must be below range");
  require(r.weapons.table.crossbow.pinReach <= 4, "weapons.table.crossbow.pinReach", "expected 0 to 4 meters");
  const lightning = r.weapons.table.lightning;
  require(lightning.boltMinRange < lightning.range, "weapons.table.lightning.boltMinRange", "must be below range");
  require(lightning.groundWidth <= 12 && lightning.groundDrop <= 8, "weapons.table.lightning", "groundWidth expected 0 to 12 meters, groundDrop 0 to 8");
  require(r.tactics.weapons.reach.lightning.slash <= lightning.reach + lightning.radius + 0.5, "tactics.weapons.reach.lightning.slash", "must be within the slash's reach and radius (plus 0.5 m)");
  require(r.weapons.accuracy.coverMul <= 1, "weapons.accuracy.coverMul", "expected 0 to 1");
  require(r.tactics.stances.map.viewStep >= 1 && Number.isInteger(r.tactics.stances.map.viewStep), "tactics.stances.map.viewStep", "expected a whole number of at least 1");
  require(r.tactics.stances.cover.peekFor < r.tactics.stances.cover.peekEvery, "tactics.stances.cover.peekFor", "must be shorter than peekEvery");
  require(r.weapons.table.rocket.minRange > 0 && r.weapons.table.rocket.speed > 0, "weapons.table.rocket", "speed and minimum range must be positive");
  require(r.weapons.table.flamethrower.spreadScale <= 3, "weapons.table.flamethrower.spreadScale", "expected 0 to 3");
  require(r.weapons.table.shotgun.pellets >= 2 && r.weapons.table.shotgun.pellets <= 64, "weapons.table.shotgun.pellets", "expected 2 to 64 pellets");
  require(r.combat.gravity > 0 && r.combat.fighter.maxHp > 0 && r.combat.density > 0 && r.combat.fighter.radius > 0 && r.combat.fighter.jumpSpeed > 0, "combat", "gravity, density, radius, jumpSpeed and maxHp must be positive");
  require(r.arena.layout.halfWidth[0] >= 20 && r.arena.layout.halfWidth[1] <= 80, "arena.layout.halfWidth", "expected 20–80 meters");
  require(r.arena.layout.rows >= 32 && r.arena.layout.rows <= 160 && r.arena.layout.bottom < 0 && r.arena.layout.top < r.arena.layout.bottom + r.arena.layout.rows / 2, "arena.layout", "grid must contain the floor and maximum arena height");
  require(r.arena.layout.groundRun[0] >= 0.5 && r.arena.layout.platformLength[0] >= 1, "arena.layout", "ground runs and platforms must cover at least one cell");
  require(r.arena.walls.approach % 0.5 === 0 && r.arena.walls.heights.every(h => h > 0 && h % 0.5 === 0), "arena.walls", "approach and positive heights must align to the half-meter grid");
  require(r.arena.spawns.centerWindow > 0 && r.arena.spawns.maxSpread >= r.arena.spawns.minXGap, "arena.spawns", "spawn window and spread must permit separation");
  const spread = r.arena.spawns.spread;
  if (spread.enabled) {
    require(spread.minDistance > 0 && spread.minDistance * 2 <= r.arena.layout.halfWidth[0], "arena.spawns.spread.minDistance", "expected a positive distance at most half the smallest arena half-width");
    require(spread.zoneMargin > 0 && spread.zoneMargin + r.zone.boundary.edgeInset < r.arena.layout.halfWidth[0] / 2, "arena.spawns.spread.zoneMargin", "the safe start must reach both outer quarters");
    require(spread.heightDifference > 0 && spread.ledgeHeight > 0, "arena.spawns.spread", "heightDifference and ledgeHeight must be positive");
    require(r.arena.spawns.maxSpread > r.arena.layout.halfWidth[1], "arena.spawns.maxSpread", "must reach across both outer quarters");
  }
  require(r.arena.walls.regularHp >= r.arena.walls.crackedHp, "arena.walls.regularHp", "must be at least crackedHp");
  require(Object.values(r.arena.propHalf).every(extent => extent.every(n => n > 0)), "arena.propHalf", "prop sizes must be positive");
  require(r.pickups.item.size > 0, "pickups.item.size", "must be positive");
  require(!r.pickups.enabled.includes("jetpack") || r.pickups.power.jetpack.thrust > r.combat.gravity, "pickups.power.jetpack.thrust", "an enabled jetpack must overcome gravity");
  require(r.pickups.enabled.length === 0 || r.pickups.enabled.some(p => r.pickups.weights[p] > 0), "pickups.weights", "an enabled power-up needs positive weight");
  for (const [weapon, reach] of Object.entries(r.tactics.weapons.reach)) {
    require(reach.max > 0 && reach.min <= reach.max, `tactics.weapons.reach.${weapon}`, "expected a positive maximum and minimum at most maximum");
    const physics = r.weapons.table[weapon as Weapon];
    if ("range" in physics) require(reach.max <= physics.range, `tactics.weapons.reach.${weapon}.max`, "must not exceed the weapon's physical range");
  }
  const B = r.builds, P = r.pickups.power;
  require(B.health.hpBonus[2] === 0 && B.weight.knockback[2] === 1 && B.weight.density[2] === 1 && B.power.mul[2] === 1, "builds", "level 0 must be the base: hpBonus 0, every multiplier 1");
  require(r.combat.fighter.maxHp + Math.min(...B.health.hpBonus) > 0, "builds.health.hpBonus", "every level must leave a positive max HP");
  require([...B.weight.knockback, ...B.weight.density, ...B.power.mul].every((m) => m > 0), "builds", "multipliers must be positive");
  // a level up is never less of its attribute (#82): more HP, mass and power, less knockback taken
  const rising = (t: readonly number[]) => t.every((v, i) => i === 0 || v >= t[i - 1]!);
  require(rising(B.health.hpBonus) && rising(B.weight.density) && rising(B.power.mul) && rising(B.weight.knockback.map((k) => -k)), "builds", "each level up must give at least as much of its attribute (knockback taken: at most as much)");
  // the caps limit a build stacked with a power-up; none may bind a neutral build (neutral is the old game)
  require(B.caps.knockbackTaken > 0 && B.caps.knockbackTaken <= P.heavy.kbMul && B.caps.density >= P.heavy.densityMul, "builds.caps", "knockbackTaken must be positive and at most the Heavy power-up's kbMul, density at least its densityMul");
  require(B.caps.damage >= P.damage.mul && B.caps.knockbackDealt >= P.damage.kbMul, "builds.caps", "damage and knockbackDealt must be at least the Damage power-up's mul and kbMul");
  require(r.tactics.weapons.lobCheckStep >= 0.05, "tactics.weapons.lobCheckStep", "expected at least 0.05 seconds");
  // #94: themes as data
  for (const [name, t] of Object.entries(r.arena.themes)) {
    const at = `arena.themes.${name}`;
    require(t.ground.heights === "ground" || t.ground.heights === "roof", `${at}.ground.heights`, "expected ground or roof");
    require(t.ground.runs === "random" || t.ground.runs === "whole", `${at}.ground.runs`, "expected random or whole");
    require(t.physics.gravity >= 0.25 && t.physics.gravity <= 2 && t.physics.friction >= 0.1 && t.physics.friction <= 2, `${at}.physics`, "gravity expected 0.25 to 2, friction 0.1 to 2");
    require(t.speckle.chance <= 1, `${at}.speckle.chance`, "expected 0 to 1");
    require(t.stage.oneWay <= 1 && t.stage.catwalkHeight >= 1 && t.stage.catwalkHeight <= 6, `${at}.stage`, "oneWay expected 0 to 1, catwalkHeight 1 to 6 m");
    require(t.stage.topRows[0] >= 1 && t.stage.topRows[1] <= 4, `${at}.stage.topRows`, "expected 1 to 4 rows");
    const H = t.hazards;
    require(H.pools[1] === 0 || H.water + H.oil + H.lava + H.acid > 0, `${at}.hazards`, "pools need a liquid with positive weight");
    require(H.width[0] >= 1 && H.width[1] <= 8 && H.depth[0] >= 1 && H.depth[1] <= 6 && H.pools[1] <= 6, `${at}.hazards`, "width expected 1 to 8 meters, depth 1 to 6 cells, at most 6 pools");
  }
  const L = r.liquids;
  require(L.flowTicks >= 1 && L.water.speedMul > 0 && L.water.speedMul <= 1 && L.mud.speedMul > 0 && L.mud.speedMul <= 1, "liquids", "flowTicks at least 1, speed multipliers 0 to 1");
  require(L.water.sinkSpeed > 0 && L.water.strokeSpeed > 0 && L.oil.burnTicks >= 1, "liquids", "sinkSpeed, strokeSpeed and burnTicks must be positive");
  return r;
}

export const CLASSIC = validateRuleset({});
/** Close Quarters: tight spawns and drops, no launch cap, full stacking, no ceilings, no tactical reach. Its supply keeps
 * the #95 pace (a drop every 8 s, 3 weapons in play) when Classic's goes up (#109). */
export const CLOSE_QUARTERS = validateRuleset({
  combat: { launch: { maxUpSpeed: 36_000, stackRetention: 1, ceilingAbove: 0, ceilingDrag: 0 } },
  arena: { spawns: CLOSE_SPAWNS },
  zone: { suddenDeath: { graceTicks: 0 } },
  tactics: { weapons: { enabled: false } },
  pickups: { armory: CLOSE_ARMORY, supply: { avoidDistance: 0, firstTick: SUPPLY.firstTick, interval: 480, weaponChance: 0.5, maxLooseWeapons: 3 }, power: { jetpack: { ceiling: 36_000 } } },
});

const prepared = new WeakSet<object>([CLASSIC, CLOSE_QUARTERS]);
export function resolveRuleset(input?: unknown): Ruleset {
  if (input === undefined) return CLASSIC;
  if (typeof input === "object" && input !== null && prepared.has(input)) return input as Ruleset;
  const result = validateRuleset(input);
  prepared.add(result);
  return result;
}

export function enabledItems(ruleset: Ruleset): ItemType[] {
  return [...ruleset.weapons.enabled, ...ruleset.pickups.enabled];
}

export function availableItem(ruleset: Ruleset, item: ItemType): boolean {
  if (item === "fist") return false;
  return isPickupWeapon(item) ? ruleset.weapons.enabled.includes(item) : ruleset.pickups.enabled.includes(item);
}

export function allowedWeapon(ruleset: Ruleset, weapon: unknown): weapon is Exclude<Weapon, "fist"> {
  return isPickupWeapon(weapon) && ruleset.weapons.enabled.includes(weapon);
}

/**
 * The ruleset a round on `theme` plays (#94): the theme's physics applied (gravity scales `combat.gravity`, friction
 * scales the fighters' ground acceleration). With both at 1 (every current theme) it is the ruleset itself.
 */
export function themedRuleset(r: Ruleset, theme: string): Ruleset {
  const t = (r.arena.themes as Record<string, Ruleset["arena"]["themes"]["warehouse"] | undefined>)[theme];
  if (!t || (t.physics.gravity === 1 && t.physics.friction === 1)) return r;
  return Object.freeze({
    ...r,
    combat: Object.freeze({
      ...r.combat,
      gravity: r.combat.gravity * t.physics.gravity,
      fighter: Object.freeze({ ...r.combat.fighter, groundAccel: r.combat.fighter.groundAccel * t.physics.friction }),
    }),
  });
}
