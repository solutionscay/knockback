import { publicRecordFile } from "./record-path";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildProblem, strategyBuild, type Build } from "../sim/build";
import type { Identity } from "../sim/identity";
import { matchIdentities, type MatchRecord } from "../sim/match";
import type { Weapon } from "../sim/sim-types";
import type { MatchServer } from "./match-server";
import type { RecordRow, RoundTier } from "./store";

/** The tiers the public sees (#67): a bot-only round is never shown after it is over. */
export type PublicTier = Exclude<RoundTier, "bot-only">;

/** A saved match as the site pages show it (plain values; names and lines are not escaped). */
export interface ReplaySummary {
  match: string;
  record: string;
  /** featured (2+ agents) or warm-up (1 agent and house bots) (#67) */
  tier: PublicTier;
  createdAt: string;
  seed: number;
  theme: string;
  names: string[];
  /** provider label per seat ("claude/haiku", "remote/Brixel", "house") */
  labels: string[];
  identities: Identity[];
  /** a weapon each fighter went for (for portraits) */
  weapons: Weapon[];
  winner: number;
  wins: number[];
  rounds: RoundSummary[];
  /** autopilot changes (#22), in order */
  control: { seat: number; mode: "autopilot" | "agent"; round: number }[];
}

export interface RoundSummary {
  winner: number;
  lines: string[];
  /** each seat's plan; build null when the record has none it can trust (#80) */
  plans: { stance: string; target: string; weapons: string[]; build: Build | null }[];
  /** mid-round plan changes per seat */
  planChanges: number[];
}

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");
const int = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : d);
export const SEATS = [0, 1, 2, 3];

/** Summarize a record's JSON (pure). null unless it is a match record. */
export function summarizeReplay(raw: unknown, match: string, record: string, createdAt: number, tier: PublicTier): ReplaySummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Number.isFinite(r.seed) || !Array.isArray(r.rounds)) return null;
  const seed = Number(r.seed) >>> 0;
  let identities: Identity[];
  try {
    identities = matchIdentities(seed, { recorded: r as unknown as MatchRecord });
  } catch {
    return null;
  }
  const labels = Array.isArray(r.labels) ? r.labels : [];
  const rawRounds = (r.rounds as unknown[]).slice(0, 3).map((x) => (x && typeof x === "object" ? x : {}) as Record<string, unknown>);
  const rounds: RoundSummary[] = rawRounds.map((x) => {
    const strategies = Array.isArray(x.strategies) ? x.strategies : [];
    const lines = Array.isArray(x.lines) ? x.lines : [];
    const updates = Array.isArray(x.planUpdates) ? x.planUpdates : [];
    return {
      winner: int(x.winner, 0, 3, -1),
      lines: SEATS.map((i) => str(lines[i])),
      plans: SEATS.map((i) => {
        const s = (strategies[i] ?? {}) as Record<string, unknown>;
        return { stance: str(s.stance, 20), target: str(s.target, 20), weapons: Array.isArray(s.weapons) ? s.weapons.slice(0, 4).map((w) => str(w, 20)) : [], build: s.build !== undefined && buildProblem(s.build) === null ? strategyBuild(s.build as Build) : null };
      }),
      planChanges: SEATS.map((i) => updates.filter((u) => (u as { fighter?: unknown })?.fighter === i).length),
    };
  });
  const firstMeta = Array.isArray(rawRounds[0]?.meta) ? (rawRounds[0]!.meta as { provider?: unknown }[]) : [];
  const wins = Array.isArray(r.wins) ? r.wins : [];
  const theme = str(((rawRounds[0]?.fight as Record<string, unknown> | undefined)?.level as Record<string, unknown> | undefined)?.theme, 20);
  const control = (Array.isArray(r.control) ? r.control : [])
    .map((e) => (e && typeof e === "object" ? (e as Record<string, unknown>) : {}))
    .filter((e) => (e.mode === "autopilot" || e.mode === "agent") && int(e.seat, 0, 3, -1) >= 0)
    .map((e) => ({ seat: e.seat as number, mode: e.mode as "autopilot" | "agent", round: int(e.round, 0, 9, 0) }));
  return {
    match,
    record,
    tier,
    createdAt: new Date(createdAt).toISOString(),
    seed,
    theme,
    names: identities.map((id) => id.name),
    labels: SEATS.map((i) => str(labels[i], 60) || str(firstMeta[i]?.provider, 60) || "house"),
    identities,
    weapons: SEATS.map((i) => {
      for (const rd of [...rounds].reverse()) if (rd.plans[i]?.weapons[0]) return rd.plans[i]!.weapons[0] as Weapon;
      return "fist" as Weapon;
    }),
    winner: int(r.winner, 0, 3, -1),
    wins: SEATS.map((i) => int(wins[i], 0, 9, 0)),
    rounds,
    control,
  };
}

/** Summaries of record files by path; they never change once written. */
export class RecordCache {
  private cache = new Map<string, Promise<unknown | null>>();
  constructor(
    readonly outDir: string,
    readonly max = 500,
  ) {}

  /** the record JSON at /records/<file>.json, or null */
  raw(path: string): Promise<unknown | null> {
    const name = publicRecordFile(path);
    if (!name || !/^[\w-][\w.-]*\.json$/.test(name)) return Promise.resolve(null);
    let p = this.cache.get(name);
    if (!p) {
      p = readFile(join(this.outDir, name), "utf8").then(
        (s) => JSON.parse(s) as unknown,
        () => null,
      );
      this.cache.set(name, p);
      if (this.cache.size > this.max) this.cache.delete(this.cache.keys().next().value!);
    }
    return p;
  }
}

const caches = new WeakMap<MatchServer, RecordCache>();
const cacheOf = (s: MatchServer) => {
  let c = caches.get(s);
  if (!c) caches.set(s, (c = new RecordCache(s.opts.outDir)));
  return c;
};

/**
 * A record row's summary; null for a bot-only round (never public, #67), a round of an older engine (#88: training
 * data, never shown) or a record that cannot be read.
 */
export async function summaryOf(server: MatchServer, row: RecordRow | null): Promise<ReplaySummary | null> {
  if (!row || row.tier === "bot-only" || row.engine !== server.store.engine) return null;
  return summarizeReplay(await cacheOf(server).raw(row.path), row.matchId, row.path, row.createdAt, row.tier);
}

/** A page of saved rounds (never bot-only) and the cursor for the next (older) page, null at the end. */
export async function pageReplays(server: MatchServer, limit = 30, before?: number, tier?: PublicTier): Promise<{ replays: ReplaySummary[]; next: number | null }> {
  const n = Math.max(1, Math.min(100, limit));
  const rows = await server.store.listRecords(n, before, tier);
  const out = await Promise.all(rows.map((row) => summaryOf(server, row)));
  return { replays: out.filter((x): x is ReplaySummary => x !== null), next: rows.length === n ? rows.at(-1)!.createdAt : null };
}

/** One saved round by id (null for a bot-only one). */
export async function replayOf(server: MatchServer, match: string): Promise<ReplaySummary | null> {
  return summaryOf(server, await server.store.getRecord(match));
}
