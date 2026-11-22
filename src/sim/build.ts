/**
 * Fighter builds (#79, epic #83): a fighter's body as three attribute levels, chosen per round in its strategy.
 *
 *   health  -2..+2  max HP
 *   weight  -2..+2  knockback taken, body density
 *   power   -2..+2  damage and knockback dealt
 *
 * A legal build has levels that add up to 0: each point up is paid by a point down. Speed and jump are not part of a
 * build (#82, #83): every fighter moves with the ruleset's `combat.fighter` values. Neutral (all 0) is the old game:
 * its values are exactly the ruleset's `combat.fighter` values. What a level does lives in the ruleset `builds` section.
 */
import type { Rng } from "./rng";
import type { Ruleset } from "./ruleset";

export interface Build {
  health: number;
  weight: number;
  power: number;
}

export const BUILD_ATTRIBUTES = ["health", "weight", "power"] as const;
export type BuildAttribute = (typeof BUILD_ATTRIBUTES)[number];

/** The lowest and highest level of every attribute. */
export const BUILD_MIN = -2;
export const BUILD_MAX = 2;

export const NEUTRAL_BUILD: Readonly<Build> = Object.freeze({ health: 0, weight: 0, power: 0 });

/** Why a build is not legal, in one sentence that says how to fix it; null for a legal build. */
export function buildProblem(build: unknown): string | null {
  if (!build || typeof build !== "object" || Array.isArray(build)) return "a build is an object with health, weight and power";
  const b = build as Record<string, unknown>;
  for (const key of Object.keys(b)) if (!(BUILD_ATTRIBUTES as readonly string[]).includes(key)) return `unknown attribute "${key}": a build has only health, weight and power`;
  let sum = 0;
  for (const a of BUILD_ATTRIBUTES) {
    const v = b[a];
    if (!Number.isInteger(v)) return `${a} must be a whole number from ${BUILD_MIN} to ${BUILD_MAX}`;
    if ((v as number) < BUILD_MIN || (v as number) > BUILD_MAX) return `${a} must be from ${BUILD_MIN} to ${BUILD_MAX}, not ${v}`;
    sum += v as number;
  }
  if (sum !== 0) return `the levels add up to ${sum > 0 ? "+" : ""}${sum}; they must add up to 0 (each point up is paid by a point down)`;
  return null;
}

/** The build a strategy plays: its own, or neutral when it has none (#79: no build means neutral). */
export function strategyBuild(build: Build | undefined): Build {
  if (build === undefined) return { ...NEUTRAL_BUILD };
  const problem = buildProblem(build);
  if (problem) throw new Error(`illegal build: ${problem}`);
  return { health: build.health, weight: build.weight, power: build.power };
}

/** A fighter's own body values for the round, from its build and the ruleset. */
export interface FighterStats {
  maxHp: number;
  /** knockback taken, as a multiplier (weight) */
  knockback: number;
  /** collider density (weight) */
  density: number;
  /** damage and knockback dealt, as a multiplier (power) */
  power: number;
}

/** Index into a -2..+2 table. */
const at = (level: number) => level - BUILD_MIN;

export function fighterStats(ruleset: Ruleset, build: Build): FighterStats {
  const B = ruleset.builds;
  return {
    maxHp: ruleset.combat.fighter.maxHp + B.health.hpBonus[at(build.health)]!,
    knockback: B.weight.knockback[at(build.weight)]!,
    density: ruleset.combat.density * B.weight.density[at(build.weight)]!,
    power: B.power.mul[at(build.power)]!,
  };
}

/** Every legal build, in a fixed order (attribute order, lowest level first): 19 builds. */
export const LEGAL_BUILDS: readonly Readonly<Build>[] = (() => {
  const out: Build[] = [];
  for (let health = BUILD_MIN; health <= BUILD_MAX; health++)
    for (let weight = BUILD_MIN; weight <= BUILD_MAX; weight++) {
      const power = 0 - (health + weight); // not -(…): that gives -0 for neutral
      if (power >= BUILD_MIN && power <= BUILD_MAX) out.push(Object.freeze({ health, weight, power }));
    }
  return Object.freeze(out);
})();

/** A legal build drawn uniformly from every legal build (batches, #82). */
export function randomBuild(rng: Rng): Build {
  return { ...rng.pick(LEGAL_BUILDS) };
}

/**
 * Whether the ruleset's builds do anything (#80): some level is not the base. A preset that sets every entry to its
 * level-0 value turns builds off, and then agents are not offered a build.
 */
export function buildsOn(ruleset: Ruleset): boolean {
  const B = ruleset.builds;
  return B.health.hpBonus.some((v) => v !== 0) || [...B.weight.knockback, ...B.weight.density, ...B.power.mul].some((v) => v !== 1);
}

/** A build in plain words, for briefings and pages: "health +2, weight 0, power -2", or "neutral". */
export function buildText(b: Build): string {
  if (BUILD_ATTRIBUTES.every((a) => b[a] === 0)) return "neutral";
  return BUILD_ATTRIBUTES.map((a) => `${a} ${b[a] > 0 ? "+" : ""}${b[a]}`).join(", ");
}

/**
 * Shape names (#81): one name per set of attributes a build raises. A legal build that is not neutral raises one or
 * two attributes (the levels add up to 0), so these seven names cover all 19 legal builds. Agents (BUILD_EXAMPLES)
 * and viewers (cards, HUD chips, montage) use the same names.
 */
export const BUILD_SHAPES: readonly { name: string; up: readonly BuildAttribute[] }[] = [
  { name: "BALANCED", up: [] },
  { name: "TANK", up: ["health"] },
  { name: "ANCHOR", up: ["weight"] },
  { name: "GLASS CANNON", up: ["power"] },
  { name: "FORTRESS", up: ["health", "weight"] },
  { name: "SCRAPPER", up: ["health", "power"] },
  { name: "WRECKER", up: ["weight", "power"] },
];

/** The attributes a build raises, in attribute order. */
export const buildUp = (b: Build): BuildAttribute[] => BUILD_ATTRIBUTES.filter((a) => b[a] > 0);

/** A legal build's shape name: "TANK", "BALANCED", ... */
export function buildShape(b: Build): string {
  const up = buildUp(b);
  const shape = BUILD_SHAPES.find((s) => s.up.length === up.length && s.up.every((a, i) => a === up[i]));
  if (!shape) throw new Error(`no shape for build ${JSON.stringify(b)}: not a legal build`);
  return shape.name;
}

/** Short labels for chips. */
export const BUILD_SHORT: Readonly<Record<BuildAttribute, string>> = { health: "HP", weight: "WGT", power: "PWR" };

/** A build's levels for a chip: "HP +2 · WGT 0 · PWR −2" (a true minus sign), or "BALANCED" for neutral. */
export function buildLevels(b: Build): string {
  if (buildUp(b).length === 0) return "BALANCED";
  return BUILD_ATTRIBUTES.map((a) => `${BUILD_SHORT[a]} ${signed(b[a])}`).join(" · ");
}

/** The chip as plain text (READMEs, shot lists): "TANK · HP +2 · WGT 0 · PWR −2", or "BALANCED". */
export function buildChipText(b: Build): string {
  return buildUp(b).length === 0 ? buildShape(b) : `${buildShape(b)} · ${buildLevels(b)}`;
}

/** A level with its sign: "+2", "0", "−2" (U+2212). */
export const signed = (n: number): string => (n > 0 ? `+${n}` : n < 0 ? `\u2212${-n}` : "0");

/** Three example builds the agents are shown (#80): one per way to spend the points, named by their shape. */
export const BUILD_EXAMPLES: readonly { name: string; build: Readonly<Build>; why: string }[] = (
  [
    [{ health: 2, weight: 0, power: -2 }, "lasts longest, hits soft"],
    [{ health: -2, weight: 0, power: 2 }, "hits hardest, goes down fast"],
    [{ health: -1, weight: 2, power: -1 }, "hard to knock off the level: for pits and ring-outs"],
  ] as const
).map(([build, why]) => ({ name: buildShape(build).toLowerCase(), build, why }));
