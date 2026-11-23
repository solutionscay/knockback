/**
 * The engine stamp (#88): which engine a match was played on. A sim change that moves the golden hashes leaves older
 * records unreplayable; the server keeps them (training data) but never shows or re-simulates them.
 *
 * The stamp is worked out, not bumped by hand: the final hash of a reference round (house bots in every seat, the
 * example souls, Classic, one round). Any change to the sim or the house bots that moves that round moves the stamp.
 * A change that happens to leave the reference round alone is still caught where it matters: a record that no longer
 * reaches its stored hash is marked older at that point (recordEngine, and the server's replay of a stored round).
 *
 * Needs initPhysics() first. Worked out once per process (about a third of a second).
 */
import { exampleSouls } from "./souls";
import { Match, type MatchRecord } from "./match";
import { CLASSIC } from "./ruleset";

/** The stamp of a match whose engine was not the current one when it was checked (a record from before stamps). */
export const OLDER_ENGINE = "older";

const REFERENCE_SEED = 88;
let stamp: string | null = null;

/** The current engine's stamp: `e-` and the reference round's final hash. */
export function engineStamp(): string {
  if (stamp) return stamp;
  const m = new Match(REFERENCE_SEED, { souls: exampleSouls(), ruleset: { ...CLASSIC, round: { ...CLASSIC.round, maxRounds: 1, winsToTake: 1 } } });
  m.playToEnd();
  stamp = `e-${m.record.rounds.map((r) => r.fight.finalHash).join("")}`;
  return stamp;
}

/** A record as saved, with the engine stamp new records carry (absent on records from before stamps). */
export type StampedRecord = MatchRecord & { engine?: string };

/**
 * Was this record made on the current engine? Another engine's stamp answers at once (older). A record with this
 * engine's stamp, or with none (from before stamps), is replayed: current only if every round reaches its recorded
 * hash (a sim change the reference round missed is caught here). For scripts (training, stats, the #88 detector) and
 * the server's one-time check of old rows; the server never shows an older one.
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
