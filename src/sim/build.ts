/**
 * Fighter builds (#79, epic #83): a fighter's body as five attribute levels, chosen per round in its strategy.
 *
 *   health  -2..+2  max HP
 *   speed    0..+2  walk speed and ground acceleration
 *   jump     0..+2  jump speed (height grows with its square)
 *   weight  -2..+2  knockback taken, body density
 *   power   -2..+2  damage and knockback dealt
 *
 * A legal build has levels that add up to 0: each point up is paid by a point down. Speed and jump never go below
 * the base, so every generated level stays reachable for every build. Neutral (all 0) is the old game: its values are
 * exactly the ruleset's `combat.fighter` values. What a level does lives in the ruleset `builds` section.
 */
import type { Rng } from "./rng";
import type { Ruleset } from "./ruleset";

export interface Build {
  health: number;
  speed: number;
  jump: number;
  weight: number;
  power: number;
}

export const BUILD_ATTRIBUTES = ["health", "speed", "jump", "weight", "power"] as const;
export type BuildAttribute = (typeof BUILD_ATTRIBUTES)[number];

/** The lowest and highest level of each attribute. */
export const BUILD_LEVELS: Readonly<Record<BuildAttribute, readonly [number, number]>> = {
  health: [-2, 2],
  speed: [0, 2],
  jump: [0, 2],
  weight: [-2, 2],
  power: [-2, 2],
};

export const NEUTRAL_BUILD: Readonly<Build> = Object.freeze({ health: 0, speed: 0, jump: 0, weight: 0, power: 0 });

/** Why a build is not legal, in one sentence that says how to fix it; null for a legal build. */
export function buildProblem(build: unknown): string | null {
  if (!build || typeof build !== "object" || Array.isArray(build)) return "a build is an object with health, speed, jump, weight and power";
  const b = build as Record<string, unknown>;
  for (const key of Object.keys(b)) if (!(BUILD_ATTRIBUTES as readonly string[]).includes(key)) return `unknown attribute "${key}": use health, speed, jump, weight and power`;
  let sum = 0;
  for (const a of BUILD_ATTRIBUTES) {
    const v = b[a];
    const [lo, hi] = BUILD_LEVELS[a];
    if (!Number.isInteger(v)) return `${a} must be a whole number from ${lo} to ${hi}`;
    if ((v as number) < lo || (v as number) > hi) return `${a} must be from ${lo} to ${hi}, not ${v}`;
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
  return { health: build.health, speed: build.speed, jump: build.jump, weight: build.weight, power: build.power };
}

export function isNeutral(build: Build): boolean {
  return BUILD_ATTRIBUTES.every((a) => build[a] === 0);
}

/** What moves a fighter around the level (#79): the values its navigation graph and jump arcs are made with. */
export interface Mobility {
  walkSpeed: number;
  jumpSpeed: number;
  airAccel: number;
}

/** A fighter's own body values for the round, from its build and the ruleset. */
export interface FighterStats {
  maxHp: number;
  walkSpeed: number;
  groundAccel: number;
  airAccel: number;
  jumpSpeed: number;
  /** knockback taken, as a multiplier (weight) */
  knockback: number;
  /** collider density (weight) */
  density: number;
  /** damage and knockback dealt, as a multiplier (power) */
  power: number;
}

/** Index into a -2..+2 table. */
const at = (level: number) => level + 2;

export function fighterStats(ruleset: Ruleset, build: Build): FighterStats {
  const F = ruleset.combat.fighter;
  const B = ruleset.builds;
  const speed = B.speed.mul[build.speed]!;
  return {
    maxHp: F.maxHp + B.health.hpBonus[at(build.health)]!,
    walkSpeed: F.walkSpeed * speed,
    groundAccel: F.groundAccel * speed,
    airAccel: F.airAccel,
    jumpSpeed: F.jumpSpeed * B.jump.mul[build.jump]!,
    knockback: B.weight.knockback[at(build.weight)]!,
    density: ruleset.combat.density * B.weight.density[at(build.weight)]!,
    power: B.power.mul[at(build.power)]!,
  };
}

/** The mobility profile of a build: (speed, jump). Fighters with the same profile share a navigation graph. */
export function mobilityKey(build: Pick<Build, "speed" | "jump">): string {
  return `${build.speed},${build.jump}`;
}

/** Every legal build, in a fixed order (attribute order, lowest level first). */
export const LEGAL_BUILDS: readonly Readonly<Build>[] = (() => {
  const out: Build[] = [];
  const range = (a: BuildAttribute) => {
    const [lo, hi] = BUILD_LEVELS[a];
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  };
  for (const health of range("health"))
    for (const speed of range("speed"))
      for (const jump of range("jump"))
        for (const weight of range("weight")) {
          const power = -(health + speed + jump + weight);
          if (power >= BUILD_LEVELS.power[0] && power <= BUILD_LEVELS.power[1]) out.push(Object.freeze({ health, speed, jump, weight, power }));
        }
  return Object.freeze(out);
})();

/** A legal build drawn uniformly from every legal build (batches, #82). */
export function randomBuild(rng: Rng): Build {
  return { ...rng.pick(LEGAL_BUILDS) };
}
