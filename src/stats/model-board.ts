/**
 * The leaderboard's Models view (#96, #106): per model, what its agents did in the Arena's rounds on this engine. Pure (no DOM, no
 * Bun): the server hands it one entry per round; the page shows it.
 *
 * - Model rows: the models agents said they run (remote seats, self-reported), from public rounds only (warm-ups and
 *   featured rounds; #67). Per model: rounds, wins, win rate, K/D, damage per round, favourite weapon and build, the
 *   best crown streak of its agents, the agents that use it, and the recent form (newest first).
 * - House bots are not a model: their seats are never counted (#106).
 * - Connected: models agents joined with that have no round on this engine yet (the empty state lists them).
 *
 * Every Arena record is one round, so "rounds" here are records.
 */
import { modelOf, type ModelProvider } from "./models";

/** One seat of one round, as the server read it from the record. */
export interface BoardSeat {
  /** the seat label: "remote/<agent>@<model>" or "house" */
  label: string;
  /** the fighter's name in the round */
  fighter: string;
  /** the fighter's look (an Identity; checked again by the page) */
  identity: unknown;
  /** first weapon of the seat's plan, "" when none */
  weapon: string;
  /** the seat's build in words, "" when none */
  build: string;
  kos: number;
  damage: number;
  /** knocked out in the round */
  died: boolean;
}

/** One round (one Arena record). */
export interface BoardRound {
  match: string;
  createdAt: string;
  tier: "featured" | "warm-up" | "bot-only";
  winner: number;
  seats: BoardSeat[];
}

export interface BoardAgent {
  name: string;
  identity: unknown;
  rounds: number;
}

export interface FormEntry {
  /** the match id (its replay) */
  match: string;
  won: boolean;
}

export interface ModelBoardRow {
  key: string;
  name: string;
  provider: ModelProvider;
  selfReported: boolean;
  rounds: number;
  wins: number;
  /** 0..1 */
  winRate: number;
  kos: number;
  deaths: number;
  /** knockouts per knockout taken; with no deaths, the knockouts */
  kd: number;
  damagePerRound: number;
  weapon: string | null;
  build: string | null;
  bestStreak: number;
  /** the agents that played it, most rounds first */
  agents: BoardAgent[];
  /** newest first, at most FORM */
  form: FormEntry[];
  lastAt: string;
}

export interface ConnectedModel {
  key: string;
  name: string;
  provider: ModelProvider;
  selfReported: boolean;
  agents: { name: string; look: unknown; live: boolean }[];
}

export interface ModelBoard {
  /** public rounds on this engine with at least one agent */
  rounds: number;
  rows: ModelBoardRow[];
  connected: ConnectedModel[];
}

/** Recent rounds per row in the form strip. */
export const FORM = 12;

const mode = (xs: string[]): string | null => {
  const n = new Map<string, number>();
  let best: string | null = null;
  for (const x of xs) {
    if (!x) continue;
    n.set(x, (n.get(x) ?? 0) + 1);
    if (best === null || n.get(x)! > n.get(best)!) best = x;
  }
  return best;
};

interface Acc {
  key: string;
  name: string;
  provider: ModelProvider;
  selfReported: boolean;
  rounds: number;
  wins: number;
  kos: number;
  deaths: number;
  damage: number;
  weapons: string[];
  builds: string[];
  agents: Map<string, BoardAgent>;
  form: FormEntry[];
  lastAt: string;
}

function rowOf(a: Acc, streaks: Map<string, number>): ModelBoardRow {
  const agents = [...a.agents.values()].sort((x, y) => y.rounds - x.rounds || x.name.localeCompare(y.name));
  return {
    key: a.key,
    name: a.name,
    provider: a.provider,
    selfReported: a.selfReported,
    rounds: a.rounds,
    wins: a.wins,
    winRate: a.rounds ? a.wins / a.rounds : 0,
    kos: a.kos,
    deaths: a.deaths,
    kd: a.deaths ? a.kos / a.deaths : a.kos,
    damagePerRound: a.rounds ? Math.round(a.damage / a.rounds) : 0,
    weapon: mode(a.weapons),
    build: mode(a.builds),
    bestStreak: Math.max(0, ...agents.map((g) => streaks.get(g.name.toLowerCase()) ?? 0)),
    agents,
    form: a.form,
    lastAt: a.lastAt,
  };
}

/** Add one round's model seats (never house bots) to the accumulators. */
function add(by: Map<string, Acc>, r: BoardRound) {
  r.seats.forEach((s, i) => {
    const m = modelOf(s.label);
    if (m.test || m.key === "house") return;
    let a = by.get(m.key);
    if (!a) {
      a = { key: m.key, name: m.name, provider: m.provider, selfReported: m.selfReported, rounds: 0, wins: 0, kos: 0, deaths: 0, damage: 0, weapons: [], builds: [], agents: new Map(), form: [], lastAt: r.createdAt };
      by.set(m.key, a);
    }
    const won = r.winner === i;
    a.rounds++;
    if (won) a.wins++;
    a.kos += s.kos;
    if (s.died) a.deaths++;
    a.damage += s.damage;
    a.weapons.push(s.weapon);
    a.builds.push(s.build);
    if (r.createdAt > a.lastAt) a.lastAt = r.createdAt;
    if (a.form.length < FORM) a.form.push({ match: r.match, won });
    if (m.agent) {
      const k = m.agent.toLowerCase();
      const g = a.agents.get(k) ?? { name: m.agent, identity: s.identity, rounds: 0 };
      g.rounds++;
      a.agents.set(k, g);
    }
  });
}

/**
 * The board from public rounds newest first, the agents'
 * best crown streaks, and the agents that joined (their newest model and look; `live` while in the Arena).
 */
export function modelBoard(publicRounds: readonly BoardRound[], streaks: readonly { name: string; best: number }[], joined: readonly { name: string; model: string; look: unknown; live: boolean }[]): ModelBoard {
  const best = new Map<string, number>();
  for (const s of streaks) best.set(s.name.toLowerCase(), Math.max(best.get(s.name.toLowerCase()) ?? 0, s.best));
  const withAgents = publicRounds.filter((r) => r.tier !== "bot-only" && r.seats.some((s) => modelOf(s.label).agent));
  const models = new Map<string, Acc>();
  for (const r of withAgents) add(models, r);
  const rows = [...models.values()].map((a) => rowOf(a, best)).sort((a, b) => b.rounds - a.rounds || b.winRate - a.winRate || a.name.localeCompare(b.name));
  // connected: every model an agent joined with that has no round here yet, its agents grouped under it
  const played = new Set(rows.map((r) => r.key));
  const conn = new Map<string, ConnectedModel>();
  for (const j of joined) {
    const m = modelOf(`remote/${j.name}@${j.model}`);
    if (m.test || played.has(m.key)) continue;
    const c = conn.get(m.key) ?? { key: m.key, name: m.name, provider: m.provider, selfReported: m.selfReported, agents: [] };
    const old = c.agents.find((a) => a.name.toLowerCase() === j.name.toLowerCase());
    if (old) old.live ||= j.live;
    else c.agents.push({ name: j.name, look: j.look, live: j.live });
    conn.set(m.key, c);
  }
  const connected = [...conn.values()].sort((a, b) => Number(b.agents.some((x) => x.live)) - Number(a.agents.some((x) => x.live)) || b.agents.length - a.agents.length || a.name.localeCompare(b.name));
  return { rounds: withAgents.length, rows, connected };
}
