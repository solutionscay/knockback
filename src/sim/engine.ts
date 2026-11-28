/**
 * The engine stamp (#88, #146): which engine a match was played on. A sim change that moves the golden hashes leaves
 * older records unreplayable; the server keeps them (training data) but never shows or re-simulates them.
 *
 * The stamp is worked out, not bumped by hand: one reference round on EVERY theme in the registry (ALL_THEMES, so a
 * new theme is covered the day it is added), each forced to its theme (house bots in every seat, the example souls,
 * Classic, one full round: its pools, coolant, slime, mud banks and low gravity all play). The stamp folds every
 * round's final hash into one: a change to the sim, the house bots or one theme's rules that moves any of those
 * rounds moves the stamp. (Before this, one round on one map, which happened to be the junkyard, made the stamp; water
 * and space changes left it alone.) A change that still leaves every reference round alone is caught where it
 * matters: a record that no longer reaches its stored hash is marked older at that point (recordEngine, and the
 * server's replay of a stored round).
 *
 * Needs initPhysics() first. Worked out once per process (about 3 s on an M-series Mac, CPU).
 */
import { exampleSouls } from "./souls";
import type { FightRecord } from "./fight";
import { Match, type MatchRecord } from "./match";
import { CLASSIC, type Ruleset } from "./ruleset";
import { ALL_THEMES, type Theme } from "./themes";

/** The stamp of a match whose engine was not the current one when it was checked (a record from before stamps). */
export const OLDER_ENGINE = "older";

const REFERENCE_SEED = 88;
let stamp: string | null = null;

/** One reference round on a theme: `base` with only that theme enabled, one round, played to the end. */
export function referenceRound(theme: Theme, base: Ruleset = CLASSIC): FightRecord {
  const ruleset: Ruleset = { ...base, arena: { ...base.arena, enabledThemes: [theme] }, round: { ...base.round, maxRounds: 1, winsToTake: 1 } };
  const m = new Match(REFERENCE_SEED, { souls: exampleSouls(), ruleset });
  m.playToEnd();
  const r = m.record.rounds[0]!;
  if (r.fight.level.theme !== theme) throw new Error(`engine stamp: the ${theme} reference round played on ${r.fight.level.theme}`);
  return r.fight;
}

/** A theme's reference round's final hash. */
export function referenceHash(theme: Theme, base: Ruleset = CLASSIC): string {
  return referenceRound(theme, base).finalHash;
}

let rounds: Record<Theme, FightRecord> | null = null;

/** This engine's reference rounds on Classic, one per theme in the registry (in registry order; played once per process). */
export function referenceRounds(): Readonly<Record<Theme, FightRecord>> {
  return (rounds ??= Object.fromEntries(ALL_THEMES.map((t) => [t, referenceRound(t)])) as Record<Theme, FightRecord>);
}

/** The stamp for a set of reference hashes: `e-` and an FNV-1a fold of every `theme:hash` (any one moving moves it). */
export function stampOf(hashes: Readonly<Record<string, string>>): string {
  let h = 0x811c9dc5;
  for (const [t, v] of Object.entries(hashes)) for (const ch of `${t}:${v};`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return `e-${h.toString(16).padStart(8, "0")}`;
}

/** The current engine's stamp (worked out once per process). */
export function engineStamp(): string {
  return (stamp ??= stampOf(Object.fromEntries(Object.entries(referenceRounds()).map(([t, f]) => [t, f.finalHash]))));
}

/** A record as saved, with the engine stamp new records carry (absent on records from before stamps). */
export type StampedRecord = MatchRecord & { engine?: string };

/**
 * Was this record made on the current engine? Another engine's stamp answers at once (older). A record with this
 * engine's stamp, or with none (from before stamps), is replayed: current only if every round reaches its recorded
 * hash (a sim change the reference round missed is caught here). For offline scripts (training, stats, the #88 detector).
 */
export function recordEngine(rec: StampedRecord): "current" | "older" {
  if (typeof rec.engine === "string" && rec.engine !== engineStamp()) return "older";
  try {
    if (!rec.rounds?.length) return "older";
    const m = new Match(rec.seed, { recorded: rec });
    while (!m.over && m.round < rec.rounds.length) m.playRound();
    return m.diverged < 0 && m.round === rec.rounds.length ? "current" : "older";
  } catch {
    return "older";
  }
}
