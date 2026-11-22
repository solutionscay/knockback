import { NEUTRAL_BUILD, randomBuild } from "../src/sim/build";
import { Rng } from "../src/sim/rng";
import type { Brain } from "../src/sim/voice";

/** House bots without plan rules (#6 A/B). */
export function houseRulesEnabled(args: string[]): boolean {
  return !args.includes("--house-rules=off") && args[args.indexOf("--house-rules") + 1] !== "off";
}

export function comparisonBatchOptions(argv: string[]) {
  const pos = argv.slice(2).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--house-rules");
  return { count: Number(pos[0] ?? 200), first: Number(pos[1] ?? 1), houseRules: houseRulesEnabled(argv) };
}

/** A partial ruleset (JSON overrides) laid over a full one: objects merge key by key, anything else replaces. */
export function mergeOverrides(base: unknown, over: unknown): unknown {
  if (typeof base !== "object" || base === null || Array.isArray(base) || typeof over !== "object" || over === null || Array.isArray(over)) return over === undefined ? base : over;
  const b = base as Record<string, unknown>;
  const o = over as Record<string, unknown>;
  return Object.fromEntries([...new Set([...Object.keys(b), ...Object.keys(o)])].map((k) => [k, mergeOverrides(b[k], o[k])]));
}

/** Bucket by index in the sorted sample, clamped to the last value. */
export function sampleQuantile(values: number[], fraction: number): number {
  const sorted = values.slice().sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
}

/** How the fighters of a batch get their builds (#79, #80, #82). */
export type BuildsOption = { kind: "neutral" } | { kind: "souls" } | { kind: "random"; seed: number };

/**
 * `--builds neutral | souls | random:SEED`. neutral (the default): every fighter is neutral, the old game and the
 * reference for round length and the #69 scorecard. souls: each house bot plays its soul's build, as in the Arena.
 * random:SEED: every seat plays a random legal build each round, drawn from a stream seeded by SEED and the match
 * seed (the same SEED gives the same builds).
 */
export function buildsOption(argv: string[]): BuildsOption {
  const i = argv.indexOf("--builds");
  if (i < 0) return { kind: "neutral" };
  const v = argv[i + 1] ?? "";
  if (v === "neutral" || v === "souls") return { kind: v };
  const m = /^random:(\d+)$/.exec(v);
  if (!m) throw new Error("--builds takes neutral, souls or random:SEED, SEED a whole number");
  return { kind: "random", seed: Number(m[1]) };
}

/** The brains with each round's build set by `opt` (random draws in seat order, so they replay). */
export function withBuilds(brains: readonly Brain[], opt: BuildsOption, matchSeed: number): Brain[] {
  if (opt.kind === "souls") return brains.slice();
  const rng = opt.kind === "random" ? new Rng((Math.imul(opt.seed, 0x9e3779b1) ^ matchSeed) >>> 0) : null;
  return brains.map((brain) => (ctx) => {
    const d = brain(ctx);
    return { ...d, strategy: { ...d.strategy, build: rng ? randomBuild(rng) : { ...NEUTRAL_BUILD } } };
  });
}

/** The builds of a batch in words, for report headers. */
export const buildsLabel = (opt: BuildsOption) => (opt.kind === "random" ? `random builds (seed ${opt.seed})` : opt.kind === "souls" ? "the souls' builds" : "neutral builds");
