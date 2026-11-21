/**
 * Which model is best (model spotlight): who played each seat, and pure stats over match records.
 *
 * - modelOf(label): the model behind a seat label ("claude/haiku", "codex/gpt-6-luna", "house",
 *   "remote/Zapbit@claude-opus-5-5" for a remote agent that reported its model at join).
 * - fightStatsOf(facts): per round and seat, what the fight did (knockouts, ring-outs, damage, survival).
 *   Every record carries it as `fightStats`.
 * - seatEntries(record): one entry per seat of a current-engine record, with its model and stats.
 * - leaderboard(entries): per model, ranked by match win rate, with a 95% interval.
 * - headToHead(entries): for each pair of models that met, how often A finished ahead of B.
 *
 * No DOM, no Bun, no sim imports beyond types and the engine version: runs in the viewer, the server and scripts.
 */
import { ENGINE_VERSION, isCurrentEngine } from "../sim/engine-version";
import type { RoundFacts } from "../sim/morale";

export type ModelProvider = "anthropic" | "openai" | "xai" | "google" | "meta" | "mistral" | "deepseek" | "qwen" | "house" | "test" | "other";

export interface ModelInfo {
  /** stable id for grouping: "claude-haiku", "gpt-6-luna", "house", "self:claude-opus-5-5" */
  key: string;
  /** shown big: "CLAUDE HAIKU", "GPT-6 LUNA (CODEX)", "GROK 4.6", "HOUSE BOT" */
  name: string;
  provider: ModelProvider;
  /** a remote agent said so at join; nobody checked */
  selfReported: boolean;
  /** stub/slow/junk/broken providers from the tests */
  test: boolean;
  /** remote agent name, when the seat is a remote agent */
  agent?: string;
}

/** Badge colour of the provider mark (only the mark: the bot keeps its own identity colour). */
export const PROVIDER_COLOR: Record<ModelProvider, string> = {
  anthropic: "#e0896a",
  openai: "#5fd0a8",
  xai: "#c9ced9",
  google: "#7aa7ff",
  meta: "#6fa8ff",
  mistral: "#ffa04d",
  deepseek: "#6c8cff",
  qwen: "#b58cff",
  house: "#ffd23f",
  test: "#8d95ab",
  other: "#b0b6c6",
};

/** A small neutral glyph per provider (no logos). */
export const PROVIDER_MARK: Record<ModelProvider, string> = {
  anthropic: "✳",
  openai: "◎",
  xai: "✕",
  google: "◆",
  meta: "∞",
  mistral: "▲",
  deepseek: "◗",
  qwen: "◇",
  house: "⌂",
  test: "·",
  other: "●",
};

/** A self-reported model name: at most 40 characters, letters, digits, space and . _ : + ( ) / - (no @). */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:+()\/-]{0,39}$/;

const TEST_PROVIDERS = new Set(["stub", "slow", "junk", "broken", "tail"]);

function providerOf(s: string): ModelProvider {
  const x = s.toLowerCase();
  if (/claude|haiku|sonnet|opus|fable|anthropic/.test(x)) return "anthropic";
  if (/gpt|codex|openai|\bo[1-9]\b|chatgpt/.test(x)) return "openai";
  if (/grok|xai/.test(x)) return "xai";
  if (/gemini|gemma|google/.test(x)) return "google";
  if (/llama|meta/.test(x)) return "meta";
  if (/mistral|mixtral|codestral/.test(x)) return "mistral";
  if (/deepseek/.test(x)) return "deepseek";
  if (/qwen/.test(x)) return "qwen";
  return "other";
}

/** "claude-opus-5-5" -> "CLAUDE OPUS 5.5", "gpt-6-luna" -> "GPT-6 LUNA", "grok-4.6" -> "GROK 4.6". */
export function prettyModel(m: string): string {
  let s = m.trim().replace(/^(anthropic|openai|xai|google)\//i, "");
  s = s.replace(/(\d)-(\d)(?=$|[^\d])/g, "$1.$2"); // version digits: 5-5 -> 5.5
  s = s.replace(/[-_]+/g, " ").replace(/\s+/g, " ").toUpperCase();
  return s.replace(/^GPT (\d)/, "GPT-$1");
}

const keyOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** The model behind a seat label (as stored in records, the live stream and decision meta). */
export function modelOf(label: string | null | undefined): ModelInfo {
  const raw = (label ?? "").trim();
  if (!raw || raw === "house" || raw === "house bot") return { key: "house", name: "HOUSE BOT", provider: "house", selfReported: false, test: false };
  const full = raw;
  const slash = full.indexOf("/");
  const head = (slash < 0 ? full : full.slice(0, slash)).toLowerCase();
  const rest = slash < 0 ? "" : full.slice(slash + 1);
  if (head === "remote") {
    const at = rest.indexOf("@");
    const agent = (at < 0 ? rest : rest.slice(0, at)).trim() || "agent";
    const model = at < 0 ? "" : rest.slice(at + 1).trim();
    if (!model) return { key: "remote:unreported", name: "MODEL NOT REPORTED", provider: "other", selfReported: false, test: false, agent };
    const k = keyOf(model);
    return { key: `self:${k}`, name: prettyModel(model), provider: providerOf(model), selfReported: true, test: false, agent };
  }
  if (TEST_PROVIDERS.has(head)) return { key: `test:${head}`, name: `${head.toUpperCase()} (TEST)`, provider: "test", selfReported: false, test: true };
  if (head === "claude") {
    const m = rest || "claude";
    const name = /^claude/i.test(m) ? prettyModel(m) : `CLAUDE ${prettyModel(m)}`;
    return { key: keyOf(/^claude/i.test(m) ? m : `claude-${m}`), name, provider: "anthropic", selfReported: false, test: false };
  }
  if (head === "codex") {
    const m = rest || "codex";
    return { key: keyOf(m), name: `${prettyModel(m)} (CODEX)`, provider: "openai", selfReported: false, test: false };
  }
  if (head === "grok") {
    const m = rest || "grok";
    return { key: keyOf(m), name: prettyModel(/^grok/i.test(m) ? m : `grok-${m}`), provider: "xai", selfReported: false, test: false };
  }
  // any other provider entry: "<provider>/<model>", or a bare name
  const m = rest || head;
  return { key: keyOf(m), name: prettyModel(m), provider: providerOf(full), selfReported: false, test: false };
}

/** The label a remote seat carries: "remote/<agent>" or "remote/<agent>@<model>" (model as the agent reported it). */
export function remoteLabel(agent: string, model?: string | null): string {
  return `remote/${agent}${model ? `@${model}` : ""}`;
}

// ------------------------------------------------------------------ fight stats

/** What one seat's fight did in one round (from round facts; not part of any hash). */
export interface SeatFight {
  /** knockouts dealt (hp and ring-out) */
  kos: number;
  /** of those, ring-outs */
  ringouts: number;
  damage: number;
  taken: number;
  /** seconds on the field: until knocked out, or the whole round */
  alive: number;
}

/** Saved in every record as `fightStats`: per round, the round's length and each seat's fight. */
export interface FightStats {
  v: 1;
  rounds: { seconds: number; seats: SeatFight[] }[];
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/** Fight stats from round facts (the sim's own events: no simulation here). */
export function fightStatsOf(facts: readonly RoundFacts[]): FightStats {
  return {
    v: 1,
    rounds: facts.map((f) => ({
      seconds: r1(f.seconds),
      seats: f.fighters.map((x) => {
        const ko = f.stats.kos.find((k) => k.victim === x.id);
        const alive = !x.survived && ko?.tick !== undefined ? Math.min(f.seconds, ko.tick / 60) : f.seconds;
        return { kos: x.kosDealt.length, ringouts: x.kosDealt.filter((k) => k.cause === "ringout").length, damage: r1(x.damageDealt), taken: r1(x.damageTaken), alive: r1(alive) };
      }),
    })),
  };
}

// ------------------------------------------------------------------ entries

/** One seat in one match: who played it and what happened. */
export interface SeatEntry {
  /** dedupe key of the match ("<seed>:<totalMs>") */
  match: string;
  seat: number;
  model: ModelInfo;
  wonMatch: boolean;
  rounds: number;
  roundWins: number;
  /** plans asked of an AI (meta outcome other than "house") and how many fell back to the house bot */
  plans: number;
  fallbacks: number;
  /** the house bot drove this fighter at some point (remote agent dropped, #22) */
  autopilot: boolean;
  fight: { kos: number; ringouts: number; damage: number; taken: number; alive: number; roundSeconds: number };
}

interface RecordLike {
  seed?: unknown;
  engine?: unknown;
  totalMs?: unknown;
  labels?: unknown;
  winner?: unknown;
  wins?: unknown;
  rounds?: unknown;
  control?: unknown;
  fightStats?: unknown;
}

const isSeat = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 4;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function cleanFightStats(v: unknown, nRounds: number): FightStats | null {
  if (!v || typeof v !== "object" || (v as FightStats).v !== 1 || !Array.isArray((v as FightStats).rounds)) return null;
  const rounds = (v as FightStats).rounds;
  if (rounds.length !== nRounds) return null;
  return {
    v: 1,
    rounds: rounds.map((r) => ({
      seconds: num(r?.seconds),
      seats: [0, 1, 2, 3].map((i) => {
        const s = (Array.isArray(r?.seats) ? r.seats[i] : null) ?? ({} as SeatFight);
        return { kos: num(s.kos), ringouts: num(s.ringouts), damage: num(s.damage), taken: num(s.taken), alive: num(s.alive) };
      }),
    })),
  };
}

/** The dedupe key of a record: copies of the same match share seed and total time. */
export function matchKey(rec: RecordLike): string {
  const rounds = Array.isArray(rec.rounds) ? rec.rounds : [];
  const hashes = rounds.map((r) => String((r as { fight?: { finalHash?: unknown } })?.fight?.finalHash ?? "")).join(",");
  return `${num(rec.seed) >>> 0}:${typeof rec.totalMs === "number" ? Math.round(rec.totalMs) : `h${hashes}`}`;
}

/** One entry per seat of a match record. Returns [] unless it is a finished match of the current engine with its fightStats. */
export function seatEntries(raw: unknown): SeatEntry[] {
  if (!isCurrentEngine(raw)) return [];
  const rec = raw as RecordLike;
  const rounds = Array.isArray(rec.rounds) ? (rec.rounds as { winner?: unknown; meta?: unknown }[]) : [];
  if (!rounds.length || !isSeat(rec.winner)) return [];
  const labels = Array.isArray(rec.labels) ? rec.labels : [];
  const fs = cleanFightStats(rec.fightStats, rounds.length);
  if (!fs) return [];
  const control = Array.isArray(rec.control) ? (rec.control as { seat?: unknown; mode?: unknown }[]) : [];
  const key = matchKey(rec);
  return [0, 1, 2, 3].map((seat) => {
    const firstMeta = rounds.map((r) => (Array.isArray(r.meta) ? (r.meta[seat] as { provider?: unknown } | undefined) : undefined)).find(Boolean);
    const label = typeof labels[seat] === "string" ? (labels[seat] as string) : typeof firstMeta?.provider === "string" ? firstMeta.provider : "house";
    let plans = 0;
    let fallbacks = 0;
    for (const r of rounds) {
      const m = Array.isArray(r.meta) ? (r.meta[seat] as { outcome?: unknown } | undefined) : undefined;
      if (!m || m.outcome === "house") continue;
      plans++;
      if (typeof m.outcome === "string" && m.outcome.startsWith("fallback")) fallbacks++;
    }
    const f = fs.rounds.reduce(
      (a, r) => {
        const s = r.seats[seat]!;
        return { kos: a.kos + s.kos, ringouts: a.ringouts + s.ringouts, damage: a.damage + s.damage, taken: a.taken + s.taken, alive: a.alive + s.alive, roundSeconds: a.roundSeconds + r.seconds };
      },
      { kos: 0, ringouts: 0, damage: 0, taken: 0, alive: 0, roundSeconds: 0 },
    );
    return {
      match: key,
      seat,
      model: modelOf(label),
      wonMatch: rec.winner === seat,
      rounds: rounds.length,
      roundWins: rounds.filter((r) => r.winner === seat).length,
      plans,
      fallbacks,
      autopilot: control.some((c) => c.seat === seat && c.mode === "autopilot"),
      fight: f,
    };
  });
}

/** True when a record had at least one real AI seat (no test providers, not all house bots). */
export function isRealAi(entries: readonly SeatEntry[]): boolean {
  return entries.length > 0 && !entries.some((e) => e.model.test) && entries.some((e) => e.model.key !== "house" && e.model.key !== "remote:unreported");
}

/** Keep the first entry set of each match key; returns the kept sets and how many copies were dropped. */
export function dedupe(sets: readonly SeatEntry[][]): { kept: SeatEntry[][]; dropped: number } {
  const seen = new Set<string>();
  const kept: SeatEntry[][] = [];
  for (const s of sets) {
    const k = s[0]?.match;
    if (!k || seen.has(k)) continue;
    seen.add(k);
    kept.push(s);
  }
  return { kept, dropped: sets.length - kept.length };
}

// ------------------------------------------------------------------ leaderboard

export interface ModelRow {
  key: string;
  name: string;
  provider: ModelProvider;
  selfReported: boolean;
  /** seats played (a model in two seats of one match counts twice) */
  matches: number;
  wins: number;
  /** match win rate 0..1, and its 95% Wilson interval */
  winRate: number;
  low: number;
  high: number;
  /** half-width of the interval, for "±" */
  plusMinus: number;
  rounds: number;
  roundWins: number;
  roundWinRate: number;
  kosPerMatch: number;
  ringoutsPerMatch: number;
  damagePerMatch: number;
  takenPerMatch: number;
  /** share of round time spent alive 0..1 */
  survival: number;
  plans: number;
  fallbacks: number;
  fallbackRate: number | null;
  autopilotRate: number;
  /** fewer matches than the minimum: shown, ranked after the rest */
  provisional: boolean;
}

/** 95% Wilson score interval for k successes in n trials. */
export function wilson(k: number, n: number, z = 1.96): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { low: Math.max(0, c - h), high: Math.min(1, c + h) };
}

/** Minimum matches before a model is ranked with the others (below: "provisional"). */
export const MIN_MATCHES = 10;

/** Chance of winning a 4-fighter match by luck. */
export const CHANCE = 0.25;

function rowOf(group: SeatEntry[], minMatches: number): ModelRow {
  const m = group[0]!.model;
  const n = group.length;
  const wins = group.filter((e) => e.wonMatch).length;
  const { low, high } = wilson(wins, n);
  const rounds = group.reduce((a, e) => a + e.rounds, 0);
  const roundWins = group.reduce((a, e) => a + e.roundWins, 0);
  const sum = (f: (e: SeatEntry) => number) => group.reduce((a, e) => a + f(e), 0);
  const plans = group.reduce((a, e) => a + e.plans, 0);
  const fallbacks = group.reduce((a, e) => a + e.fallbacks, 0);
  const secs = sum((e) => e.fight.roundSeconds);
  return {
    key: m.key,
    name: m.name,
    provider: m.provider,
    selfReported: m.selfReported,
    matches: n,
    wins,
    winRate: wins / n,
    low,
    high,
    plusMinus: (high - low) / 2,
    rounds,
    roundWins,
    roundWinRate: rounds ? roundWins / rounds : 0,
    kosPerMatch: sum((e) => e.fight.kos) / n,
    ringoutsPerMatch: sum((e) => e.fight.ringouts) / n,
    damagePerMatch: sum((e) => e.fight.damage) / n,
    takenPerMatch: sum((e) => e.fight.taken) / n,
    survival: secs > 0 ? sum((e) => e.fight.alive) / secs : 0,
    plans,
    fallbacks,
    fallbackRate: plans ? fallbacks / plans : null,
    autopilotRate: group.filter((e) => e.autopilot).length / n,
    provisional: n < minMatches,
  };
}

/** Rank: enough matches first, then by win rate, then by more matches, then by round win rate. */
export function rankRows(rows: ModelRow[]): ModelRow[] {
  return rows.sort((a, b) => Number(a.provisional) - Number(b.provisional) || b.winRate - a.winRate || b.matches - a.matches || b.roundWinRate - a.roundWinRate || a.name.localeCompare(b.name));
}

export interface Leaderboard {
  matches: number;
  /** ranked rows */
  rows: ModelRow[];
  minMatches: number;
  chance: number;
}

/** Group seat entries by model and rank them. */
export function leaderboard(sets: readonly SeatEntry[][], opts: { minMatches?: number } = {}): Leaderboard {
  const min = opts.minMatches ?? MIN_MATCHES;
  const by = new Map<string, SeatEntry[]>();
  for (const e of sets.flat()) by.set(e.model.key, [...(by.get(e.model.key) ?? []), e]);
  return {
    matches: sets.length,
    rows: rankRows([...by.values()].map((g) => rowOf(g, min))),
    minMatches: min,
    chance: CHANCE,
  };
}

/** Finishing order inside one match: match winner first, then by round wins (ties share a place). */
function placeOf(set: SeatEntry[], e: SeatEntry): number {
  if (e.wonMatch) return 0;
  return 1 + set.filter((o) => !o.wonMatch && o.roundWins > e.roundWins).length;
}

export interface HeadToHead {
  /** model keys, in leaderboard order */
  keys: string[];
  names: Record<string, string>;
  /** cell[a][b] = { ahead: matches where a finished ahead of b, met: matches with both } */
  cell: Record<string, Record<string, { ahead: number; met: number }>>;
}

/** For each pair of models that met in a match (different seats), how often A finished ahead of B. */
export function headToHead(sets: readonly SeatEntry[][], order?: string[]): HeadToHead {
  const cell: HeadToHead["cell"] = {};
  const names: Record<string, string> = {};
  for (const set of sets) {
    for (const a of set) {
      names[a.model.key] = a.model.name;
      for (const b of set) {
        if (a === b || a.model.key === b.model.key) continue;
        const c = ((cell[a.model.key] ??= {})[b.model.key] ??= { ahead: 0, met: 0 });
        c.met++;
        if (placeOf(set, a) < placeOf(set, b)) c.ahead++;
      }
    }
  }
  const keys = order?.filter((k) => names[k]) ?? Object.keys(names).sort();
  return { keys, names, cell };
}

// ------------------------------------------------------------------ text table (CLI)

const pct = (x: number) => `${Math.round(x * 100)}%`.padStart(4);
const f1 = (x: number) => x.toFixed(1);

/** The leaderboard as a plain-text table. */
export function leaderboardText(lb: Leaderboard, h2h?: HeadToHead): string {
  const out: string[] = [];
  const table = (title: string, rows: ModelRow[], matches: number) => {
    out.push(`${title}: ${matches} match${matches === 1 ? "" : "es"} (chance = ${Math.round(lb.chance * 100)}% in a 4-fighter match; ± is the 95% interval)`);
    out.push(`  #  ${"model".padEnd(28)} ${"matches".padStart(7)} ${"win rate".padStart(14)} ${"rounds".padStart(9)}  ${"KO/m".padStart(5)} ${"RO/m".padStart(5)} ${"dmg/m".padStart(6)} ${"alive".padStart(5)}  ${"fallback".padStart(8)} ${"autopilot".padStart(9)}`);
    let rank = 0;
    let marked = false;
    for (const r of rows) {
      if (r.provisional && !marked) {
        marked = true;
        out.push(`     -- fewer than ${lb.minMatches} matches: provisional --`);
      }
      const name = `${r.name}${r.selfReported ? " (self-reported)" : ""}`.slice(0, 28);
      const wr = `${pct(r.winRate)} ±${Math.round(r.plusMinus * 100)}`.padStart(9);
      out.push(
        `  ${r.provisional ? " ·" : String(++rank).padStart(2)} ${name.padEnd(28)} ${String(r.matches).padStart(7)} ${`${r.wins}W ${wr}`.padStart(14)} ${`${r.roundWins}/${r.rounds}`.padStart(9)}  ${f1(r.kosPerMatch).padStart(5)} ${f1(r.ringoutsPerMatch).padStart(5)} ${String(Math.round(r.damagePerMatch)).padStart(6)} ${pct(r.survival).padStart(5)}  ${(r.fallbackRate === null ? "-" : `${r.fallbacks}/${r.plans}`).padStart(8)} ${pct(r.autopilotRate).padStart(9)}`,
      );
    }
    if (h2h) {
      const h = h2h;
      const keys = rows.map((r) => r.key).filter((k) => h.keys.includes(k));
      if (keys.length > 1) {
        out.push("  head to head: row finished ahead of column (matches where both played)");
        const short = (k: string) => (h.names[k] ?? k).slice(0, 12);
        out.push(`  ${"".padEnd(14)}${keys.map((k) => short(k).padStart(13)).join("")}`);
        for (const a of keys) out.push(`  ${short(a).padEnd(14)}${keys.map((b) => (a === b ? "-" : h.cell[a]?.[b] ? `${h.cell[a]![b]!.ahead}/${h.cell[a]![b]!.met}` : "").padStart(13)).join("")}`);
      }
    }
    out.push("");
  };
  table(`ENGINE v${ENGINE_VERSION}`, lb.rows, lb.matches);
  return out.join("\n");
}
