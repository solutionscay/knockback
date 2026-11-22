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
      const power = -(health + weight);
      if (power >= BUILD_MIN && power <= BUILD_MAX) out.push(Object.freeze({ health, weight, power }));
    }
  return Object.freeze(out);
})();

/** A legal build drawn uniformly from every legal build (batches, #82). */
export function randomBuild(rng: Rng): Build {
  return { ...rng.pick(LEGAL_BUILDS) };
}
