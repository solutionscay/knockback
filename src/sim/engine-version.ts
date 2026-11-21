import { RULESET_MAX_ROUNDS } from "./ruleset";

/**
 * Engine version: which physics and controller behavior made a match record.
 *
 * Rule: bump ENGINE_VERSION in the same commit as any change that changes sim hashes (physics, level generation,
 * controllers, combat). Every new record stamps the version that made it (`engine`); replay and the viewer check it
 * before simulating anything. A record from another engine version can't replay on this physics, so it is shown as a
 * summary (line-up, result, lines: none of it needs the simulation) instead of a replay that diverges.
 *
 * Records without the field count as version 0 (everything before this rule). The per-round hash check stays the
 * real safety net: a record stamped with this version that still diverges is refused as before.
 *
 * The field is not part of any hash: it lives in the record, not in the sim state.
 */
export const ENGINE_VERSION = 6;

/** The engine version a record says made it; 0 when the field is missing or not a whole number. */
export function recordEngine(rec: unknown): number {
  const v = rec && typeof rec === "object" ? (rec as { engine?: unknown }).engine : undefined;
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;
}

/** True when a record was made by another engine version than this one. */
export function isOtherEngine(rec: unknown): boolean {
  return recordEngine(rec) !== ENGINE_VERSION;
}

/** A record made by another engine version: refused before any simulation. */
export class OtherEngineError extends Error {
  constructor(readonly engine: number) {
    super(`this record was made with engine v${engine}; this is engine v${ENGINE_VERSION}, so it can't replay here (${engine === 0 ? "replay it from the commit that made it, from before engine versions" : `replay it from a commit with ENGINE_VERSION = ${engine}`})`);
  }
}

/** Throw OtherEngineError when the record is from another engine version. */
export function checkRecordEngine(rec: unknown): void {
  if (isOtherEngine(rec)) throw new OtherEngineError(recordEngine(rec));
}

/** What a record tells without any simulation: who played, who won, what they said. Plain text, not escaped. */
export interface RecordSummary {
  seed: number;
  engine: number;
  /** fighter names by seat */
  names: string[];
  /** provider label by seat (e.g. "claude/haiku"), when the record has them */
  labels: (string | null)[];
  /** fighter color by seat (0xRRGGBB), when the record has them */
  colors: (number | null)[];
  /** seat that won the match, -1 when unknown */
  winner: number;
  /** round wins by seat */
  wins: number[];
  /** each round's lines by seat and the round's winning seat */
  rounds: { lines: string[]; winner: number }[];
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const color = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffffff ? v : null);
const seat = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 4 ? v : -1);

/** Summarize any record-like JSON, of any version; null when it isn't a match record at all. */
export function summarizeRecord(raw: unknown): RecordSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Number.isFinite(r.seed) || !Array.isArray(r.rounds)) return null;
  const identities = Array.isArray(r.identities) ? r.identities : [];
  const souls = Array.isArray(r.souls) ? r.souls : [];
  const labels = Array.isArray(r.labels) ? r.labels : [];
  const rounds = (r.rounds as unknown[]).slice(0, RULESET_MAX_ROUNDS).map((rd) => {
    const x = (rd && typeof rd === "object" ? rd : {}) as Record<string, unknown>;
    const lines = Array.isArray(x.lines) ? x.lines : [];
    return { lines: [0, 1, 2, 3].map((i) => str(lines[i], 200)), winner: seat(x.winner) };
  });
  const meta = (rounds.length && Array.isArray((r.rounds as Record<string, unknown>[])[0]?.meta) ? (r.rounds as Record<string, unknown>[])[0]!.meta : []) as { provider?: unknown }[];
  const wins = Array.isArray(r.wins) ? r.wins : [];
  return {
    seed: Number(r.seed) >>> 0,
    engine: recordEngine(raw),
    names: [0, 1, 2, 3].map((i) => str((identities[i] as { name?: unknown })?.name, 24) || str((souls[i] as { name?: unknown })?.name, 24) || `Seat ${i + 1}`),
    labels: [0, 1, 2, 3].map((i) => str(labels[i], 80) || str(meta[i]?.provider, 80) || null),
    colors: [0, 1, 2, 3].map((i) => color((identities[i] as { color?: unknown })?.color) ?? color((souls[i] as { color?: unknown })?.color)),
    winner: seat(r.winner),
    wins: [0, 1, 2, 3].map((i) => (typeof wins[i] === "number" ? Math.max(0, Math.min(RULESET_MAX_ROUNDS, Math.floor(wins[i] as number))) : 0)),
    rounds,
  };
}
