import { randomBuild } from "../src/sim/build";
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

/**
 * `--builds random:SEED` (#79, #82): every seat plays a random legal build each round, drawn from a stream seeded by
 * SEED and the match seed (the same SEED gives the same builds). null without the option: every fighter is neutral.
 */
export function buildsSeed(argv: string[]): number | null {
  const i = argv.indexOf("--builds");
  if (i < 0) return null;
  const m = /^random:(\d+)$/.exec(argv[i + 1] ?? "");
  if (!m) throw new Error("--builds takes random:SEED, SEED a whole number");
  return Number(m[1]);
}

/** The brains with a random legal build added to each round's strategy (seat order, so the draws replay). */
export function withRandomBuilds(brains: readonly Brain[], buildSeed: number, matchSeed: number): Brain[] {
  const rng = new Rng((Math.imul(buildSeed, 0x9e3779b1) ^ matchSeed) >>> 0);
  return brains.map((brain) => (ctx) => {
    const d = brain(ctx);
    return { ...d, strategy: { ...d.strategy, build: randomBuild(rng) } };
  });
}
