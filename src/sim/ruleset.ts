import { SUPPLY } from "./constants";
import { CLOSE_ARMORY, RULESET_DEFAULTS } from "./ruleset-defaults";
import { CLOSE_SPAWNS } from "./level-config";
import { Mat } from "./grid";
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
  "pickups.enabled": RULESET_DEFAULTS.pickups.enabled,
  "arena.enabledThemes": RULESET_DEFAULTS.arena.enabledThemes,
  "fire.materials": [Mat.Dirt, Mat.Rock, Mat.Wood, Mat.Steel, Mat.Concrete, Mat.Crumble, Mat.Brick],
  "fire.props": RULESET_DEFAULTS.fire.props,
};
const signed = new Set(["ringOutY", "bottom", "minHeight", "groundMin", "desperateBelow", "confidentAt"]);
const realArrays = new Set(["edgeInset", "mainPitWidth", "extraPitWidth", "groundHeight", "rooftopHeight", "groundRun", "platformLength", "platformHeights", "weightLength", "heights", "hitPoints", "density"]);
const ranges = new Set(["halfWidth", "edgeInset", "mainPitWidth", "extraPitWidth", "groundHeight", "rooftopHeight", "groundRun", "overhangCells", "platformLength", "coverStacks", "coverColumns", "coverRows", "weightLength", "widthCells", "extraPits", "towers", "platforms"]);
const zeroAllowed = new Set(["nearSpawn", "middle", "high", "maxLooseWeapons", "groundCoverStacks", "minimumCover", "minimumProps", "minimumPlatforms", "zoneCaches", "holdTicks", "firstTick"]);
const strictlyPositive = new Set(["ammo", "pellets", "cooldown", "interval", "chargeTicks", "step", "propEvery", "dropEvery", "shockEvery", "everyTicks", "peekEvery", "pressFlip", "flankPeriod", "barrelPairDivisor", "attempts", "maxRounds", "winsToTake", "fightTicks", "finishTicks"]);
const fractions = /(?:chance|^crumble$|retention|^(?:regular|cracked)Hp)$/i;
const integral = /(?:ticks|cells|attempts|^hits$|^minOnTicks$|^minOffTicks$|^fuse(?:Min|Max)?$|^chainFuse$|^burnMin$|^burnMax$|^rows$|^maxLife$)/i;

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
    if (value.length !== base.length) return fail(`expected ${base.length} entries`);
    const row = base.map((v, i) => canonical(v, value[i], `${path}.${i}`));
    const field = path.split(".").at(-1)!;
    if ((ranges.has(field) || path.includes(".themes.") && path.includes(".props.")) && typeof row[0] === "number" && typeof row[1] === "number" && row[0] > row[1]) return fail("minimum must be at most maximum");
    return Object.freeze(row);
  }
  if (typeof base === "object" && base !== null) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return fail("expected an object");
    const src = value as Record<string, unknown>;
    const template = base as Record<string, unknown>;
    for (const key of Object.keys(src)) if (!Object.hasOwn(template, key)) throw new RulesetError(path ? `${path}.${key}` : key, "unknown setting");
    return Object.freeze(Object.fromEntries(Object.keys(template).map(key => [key, canonical(template[key], Object.hasOwn(src, key) ? src[key] : undefined, path ? `${path}.${key}` : key)])));
  }
  if (typeof base === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return fail("expected a finite number");
    const parts = path.split(".");
    const leaf = parts.at(-1)!;
    const member = /^\d+$/.test(leaf) ? parts.at(-2)! : leaf;
    const material = /\.themes\.[^.]+\.(body|surface|tower|platform|bridge)(?:\.|$)/.test(path);
    if (material && (!Number.isInteger(value) || value < Mat.Dirt || value > Mat.Brick || value === Mat.Bedrock)) return fail("expected a destructible material ID (1–6 or 8)");
    const whole = strictlyPositive.has(leaf) || zeroAllowed.has(leaf) || integral.test(leaf) || path.includes(".themes.") && path.includes(".props.") || /^\d+$/.test(leaf) && ranges.has(member) && !realArrays.has(member);
    if (whole && !Number.isInteger(value)) return fail("expected a whole number");
    const low = signed.has(member) || ["groundHeight", "rooftopHeight", "groundStep"].includes(member) ? -1_000 : strictlyPositive.has(leaf) ? 1 : 0;
    let high = 36_000;
    if (fractions.test(leaf) || path === "fire.spread") high = 1;
    if (/Attempts$/.test(leaf)) high = 500;
    if (path === "arena.spawns.spread.jitter" || path === "arena.spawns.spread.innerOutset" || path === "arena.spawns.spread.outerOutset") high = 0.49;
    if (leaf === "zoneCaches") high = 4;
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
  require(r.schemaVersion === 1, "schemaVersion", "expected version 1");
  require(r.round.maxRounds <= RULESET_MAX_ROUNDS && r.round.winsToTake <= r.round.maxRounds, "round", `use at most ${RULESET_MAX_ROUNDS} rounds and a win target no larger than maxRounds`);
  require(r.round.finishTicks <= r.round.fightTicks, "round.finishTicks", "must fit inside the fight");
  require(r.zone.boundary.shrinkEndTicks > r.zone.boundary.holdTicks, "zone.boundary.shrinkEndTicks", "must be after holdTicks");
  require(r.zone.suddenDeath.endHalf > 0 && r.zone.suddenDeath.endHalf <= r.zone.boundary.endHalf, "zone.suddenDeath.endHalf", "must be positive and at most the regular end width");
  require(r.zone.boundary.edgeInset + r.zone.boundary.endHalf < r.arena.layout.halfWidth[0], "zone.boundary", "end width and edge inset must fit inside the smallest arena");
  require(r.fire.burnMin <= r.fire.burnMax, "fire.burnMin", "must be at most burnMax");
  require(r.weapons.table.mine.armTicks < r.weapons.table.mine.fuse, "weapons.table.mine.armTicks", "must be shorter than the fuse");
  require(r.weapons.table.railgun.minRange < r.weapons.table.railgun.range, "weapons.table.railgun.minRange", "must be below range");
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
  require(r.tactics.weapons.lobCheckStep >= 0.05, "tactics.weapons.lobCheckStep", "expected at least 0.05 seconds");
  return r;
}

export const CLASSIC = validateRuleset({});
/** Close Quarters: tight spawns and drops, no launch cap, full stacking, no ceilings, no tactical reach. */
export const CLOSE_QUARTERS = validateRuleset({
  combat: { launch: { maxUpSpeed: 36_000, stackRetention: 1, ceilingAbove: 0, ceilingDrag: 0 } },
  arena: { spawns: CLOSE_SPAWNS },
  zone: { suddenDeath: { graceTicks: 0 } },
  tactics: { weapons: { enabled: false } },
  pickups: { armory: CLOSE_ARMORY, supply: { avoidDistance: 0, firstTick: SUPPLY.firstTick }, power: { jetpack: { ceiling: 36_000 } } },
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
