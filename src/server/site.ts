/**
 * Data for the site pages (#22): the lobby, /replays, /agent/:name and the share card. Read-only, built from
 * what the match server already stores (the record index, seats, the record files); nothing new is written.
 *
 *   GET /api/replays?limit=n&before=ms&tier=featured|warm-up  saved rounds, newest first, with their line-up, result and
 *                                   tier; `next` pages back. Bot-only rounds are never listed or served (#67).
 *   GET /api/replays/:id            one saved match
 *   GET /api/agents/:name           an agent's bot, owner, soul summary, record and recent matches
 *   GET /api/leaderboard            the Arena board (#65): rounds per agent and per owner (agent seats only), against
 *                                   agents and against house bots only, best crown streaks; the crown now
 *   GET /api/models/board           the leaderboard's Models view (#96, #106): per model (agents' self-reported models), rounds, wins, K/D,
 *                                   damage, favourite weapon and build, best streak, agents, recent form (house bots are not a
 *                                   model: no row); models that joined but have no round on this engine yet
 *   GET /share/:matchId.svg         the 1200x630 share card of a finished match
 *
 * Record files never change once written, so their summaries are cached by path.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildProblem, buildText, strategyBuild, type Build } from "../sim/build";
import type { Identity } from "../sim/identity";
import { matchIdentities, type MatchRecord } from "../sim/match";
import { parseSoul } from "../sim/soul";
import type { Weapon } from "../sim/sim-types";
import { esc, hex } from "../html";
import { portraitSvg, type Mood } from "../viewer/portrait";
import { arenaBoard } from "../stats/board";
import { modelBoard, type BoardRound, type ModelBoard, type ModelBoardRow } from "../stats/model-board";
import { modelOf, remoteLabel, type SeatEntry } from "../stats/models";
import { HttpError } from "./limits";
import type { MatchServer } from "./match-server";
import type { Operator } from "./profile";
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
const SEATS = [0, 1, 2, 3];

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
    const name = /^\/records\/([\w-][\w.-]*\.json)$/.exec(path)?.[1];
    if (!name) return Promise.resolve(null);
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
async function summaryOf(server: MatchServer, row: RecordRow | null): Promise<ReplaySummary | null> {
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

// ------------------------------------------------------------------ agents

export interface AgentMatch {
  match: string;
  seat: number;
  status: string;
  createdAt: string;
  fighter: string | null;
  /** 1st..4th by match winner, then round wins (null until over) */
  place: number | null;
  wins: number[] | null;
  theme: string;
  record: string | null;
  /** the other three: name and look */
  rivals: { name: string; identity: Identity | null }[];
  autopilot: boolean;
  /** the build the agent played in each round of the match, in words (#80); empty while it runs */
  builds: string[];
}

export interface AgentProfile {
  name: string;
  /** the owner the agent's name is bound to */
  owner: string;
  /** the bot from the agent's newest match (null before its first match starts) */
  identity: Identity | null;
  weapon: Weapon;
  label: string;
  summary: string;
  catchphrase: string;
  /** the agent's most recent line in a fight */
  signature: string;
  stats: { matches: number; won: number; lost: number; rounds: number; roundsWon: number; planChanges: number; autopilot: number };
  /** most frequent stance, target, first weapon and build over its plans */
  style: { stance: string | null; target: string | null; weapon: string | null; build: string | null };
  matches: AgentMatch[];
  now: { match: string; status: string } | null;
}

/** The first plain paragraph of a soul.md, at most ~280 characters (pure: tested). */
export function soulSummary(soul: string): { summary: string; catchphrase: string } {
  const p = parseSoul(soul, 0, "agent");
  const body = p.soul.body || soul;
  const para =
    body
      .split(/\n\s*\n/)
      .map((x) => x.trim())
      .find((x) => x && !x.startsWith("#") && !x.startsWith("---") && !/^[a-z]+:/i.test(x) && !x.startsWith("- ")) ?? "";
  let s = para.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
  if (s.length > 280) {
    const cut = s.slice(0, 280);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    s = end > 80 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, "")}…`;
  }
  return { summary: s, catchphrase: p.soul.catchphrase ?? "" };
}

const mode = (xs: string[]): string | null => {
  const n = new Map<string, number>();
  for (const x of xs) if (x) n.set(x, (n.get(x) ?? 0) + 1);
  let best: string | null = null;
  for (const [k, v] of n) if (best === null || v > n.get(best)!) best = k;
  return best;
};

/** Place 1-4 of `seat`: the match winner first, then by round wins, ties share the better place (pure). */
export function placeOf(seat: number, winner: number, wins: number[]): number {
  if (seat === winner) return 1;
  const mine = wins[seat] ?? 0;
  return 2 + SEATS.filter((i) => i !== seat && i !== winner && (wins[i] ?? 0) > mine).length;
}

/** Build an agent's profile from its seats (newest first) and the summaries of those matches (pure: tested). */
export function buildProfile(
  name: string,
  seats: { match: string; seat: number; status: string; createdAt: number; soul: string; owner: string; leftRound: number | null; live?: { fighter: string | null; identities: Identity[] | null; names: string[] | null } }[],
  replays: Map<string, ReplaySummary>,
): AgentProfile {
  const matches: AgentMatch[] = [];
  const stances: string[] = [];
  const targets: string[] = [];
  const weapons: string[] = [];
  const builds: string[] = [];
  const stats = { matches: 0, won: 0, lost: 0, rounds: 0, roundsWon: 0, planChanges: 0, autopilot: 0 };
  let identity: Identity | null = null;
  let weapon: Weapon = "fist";
  let label = `remote/${name}`;
  let signature = "";
  let now: AgentProfile["now"] = null;
  for (const s of seats) {
    const rp = replays.get(s.match);
    if ((s.status === "open" || s.status === "running") && !now) now = { match: s.match, status: s.status };
    if (rp) {
      const i = s.seat;
      if (!identity) {
        identity = rp.identities[i] ?? null;
        weapon = rp.weapons[i] ?? "fist";
        label = rp.labels[i] ?? label;
      }
      stats.matches++;
      if (rp.winner === i) stats.won++;
      else stats.lost++;
      for (const rd of rp.rounds) {
        stats.rounds++;
        if (rd.winner === i) stats.roundsWon++;
        stats.planChanges += rd.planChanges[i] ?? 0;
        const pl = rd.plans[i];
        if (pl) {
          stances.push(pl.stance);
          targets.push(pl.target);
          if (pl.weapons[0]) weapons.push(pl.weapons[0]);
          if (pl.build) builds.push(buildText(pl.build));
        }
      }
      // the newest line: seats come newest first, rounds oldest first
      const last = [...rp.rounds].reverse().find((rd) => rd.lines[i]);
      if (last && !signature) signature = last.lines[i]!;
      const ap = rp.control.some((e) => e.seat === i && e.mode === "autopilot");
      if (ap) stats.autopilot++;
      matches.push({
        match: s.match,
        seat: i,
        status: "over",
        createdAt: rp.createdAt,
        fighter: rp.names[i] ?? null,
        place: rp.winner >= 0 ? placeOf(i, rp.winner, rp.wins) : null,
        wins: rp.wins,
        theme: rp.theme,
        record: rp.record,
        rivals: SEATS.filter((j) => j !== i).map((j) => ({ name: rp.names[j] ?? "?", identity: rp.identities[j] ?? null })),
        autopilot: ap,
        builds: rp.rounds.map((rd) => (rd.plans[i]?.build ? buildText(rd.plans[i]!.build!) : "")).filter(Boolean),
      });
    } else {
      if (!identity && s.live?.identities) identity = s.live.identities[s.seat] ?? null;
      matches.push({
        match: s.match,
        seat: s.seat,
        status: s.status,
        createdAt: new Date(s.createdAt).toISOString(),
        fighter: s.live?.fighter ?? null,
        place: null,
        wins: null,
        theme: "",
        record: null,
        rivals: s.live?.identities ? SEATS.filter((j) => j !== s.seat).map((j) => ({ name: s.live!.names?.[j] ?? "?", identity: s.live!.identities![j] ?? null })) : [],
        autopilot: s.leftRound !== null,
        builds: [],
      });
    }
  }
  const soul = seats[0]?.soul ?? "";
  const { summary, catchphrase } = soul ? soulSummary(soul) : { summary: "", catchphrase: "" };
  return { name, owner: seats[0]?.owner ?? "", identity, weapon, label, summary, catchphrase, signature: signature || catchphrase, stats, style: { stance: mode(stances), target: mode(targets), weapon: mode(weapons), build: mode(builds) }, matches, now };
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,23}$/;
/** how many recent stored matches an agent lookup scans */
const SCAN = 300;

/** An agent's profile, from the seats in storage (newest SCAN matches) and the matches in memory. */
export async function agentProfile(server: MatchServer, name: string): Promise<AgentProfile & { operator: Operator | null }> {
  if (!NAME_RE.test(name)) throw new HttpError(400, "agent names are 1-24 characters: letters, digits, space, _ . -");
  const want = name.toLowerCase();
  const rows = (await server.store.listMatches()).slice(0, SCAN);
  const seats: Parameters<typeof buildProfile>[1] = [];
  let shown = name;
  for (const row of rows) {
    const mem = server.matches.get(row.id);
    // rounds of an older engine (#88) are training data: not on an agent's page
    if (!mem && row.engine !== server.store.engine) continue;
    for (const s of await server.store.listSeats(row.id)) {
      if (s.name.toLowerCase() !== want) continue;
      shown = s.name;
      const r = mem?.runner;
      seats.push({
        match: row.id,
        seat: s.seat,
        status: mem?.status ?? row.status,
        createdAt: row.createdAt,
        soul: s.soul,
        owner: s.owner,
        leftRound: s.leftRound,
        ...(r ? { live: { fighter: r.names[s.seat] ?? null, identities: r.match.identities, names: r.names } } : {}),
      });
    }
    if (seats.length >= 40) break;
  }
  if (!seats.length) throw new HttpError(404, `no agent ${name} in the last ${SCAN} matches`);
  const replays = new Map<string, ReplaySummary>();
  await Promise.all(
    seats.map(async (s) => {
      if (s.status !== "over") return;
      const sum = await replayOf(server, s.match);
      if (sum) replays.set(s.match, sum);
    }),
  );
  const operator = (await operatorsOf(server)).byAgent.get(want) ?? null;
  return { ...buildProfile(shown, seats, replays), operator };
}

// ------------------------------------------------------------------ operators (#113)

/**
 * The operators on the site: owners that set a nickname, by owner handle and by agent name (lower case). Only the
 * public fields (id, nickname, URL) leave here; read paths for the site pages only, never a prompt's.
 */
export async function operatorsOf(server: MatchServer) {
  const byOwner = new Map<string, Operator>();
  const byAgent = new Map<string, Operator>();
  for (const o of await server.store.operators()) {
    const op = { id: o.id, nickname: o.nickname, url: o.url };
    byOwner.set(o.handle.toLowerCase(), op);
    for (const a of o.agents) byAgent.set(a.toLowerCase(), op);
  }
  return { byOwner, byAgent };
}

// ------------------------------------------------------------------ leaderboard (#65)

/** The Arena leaderboard: agents and owners by rounds (agent seats only), best streaks, and the crown now. */
export async function leaderboardOf(server: MatchServer) {
  const [rounds, latest, streaks, ops] = await Promise.all([server.store.agentRounds(), server.store.latestSeats(), server.store.listStreaks(), operatorsOf(server)]);
  const labels = new Map(latest.map((s) => [s.name.toLowerCase(), remoteLabel(s.name, s.model)]));
  const board = arenaBoard(rounds, labels, streaks);
  return {
    // the operator (#113) next to each agent and owner that has one
    agents: board.agents.map((a) => ({ ...a, operator: ops.byOwner.get(a.owner.toLowerCase()) ?? null })),
    owners: board.owners.map((o) => ({ ...o, operator: ops.byOwner.get(o.owner.toLowerCase()) ?? null })),
    crown: server.arena.crownView(),
    note: "Rounds, agent seats only: against agents = rounds with 2 or more agents (the ranking); against house bots = an agent alone with house bots. Best streak: crown defences in rounds with 2 or more agents.",
  };
}

// ------------------------------------------------------------------ models (#96)

/** how many of the newest public rounds the models board reads */
const BOARD_ROUNDS = 400;

/** One record as a board round: the summary's line-up and plans, the index's fight stats (pure: tested). */
export function boardRound(sum: ReplaySummary, stats: string, tier: BoardRound["tier"] = sum.tier): BoardRound {
  let es: SeatEntry[] = [];
  try {
    const v = JSON.parse(stats);
    if (Array.isArray(v)) es = v as SeatEntry[];
  } catch {
    /* no fight stats: zeros */
  }
  const first = sum.rounds[0];
  return {
    match: sum.match,
    createdAt: sum.createdAt,
    tier,
    winner: sum.winner,
    seats: SEATS.map((i) => {
      const f = es.find((e) => e.seat === i)?.fight;
      const pl = first?.plans[i];
      return {
        label: sum.labels[i] ?? "house",
        fighter: sum.names[i] ?? "",
        identity: sum.identities[i] ?? null,
        weapon: pl?.weapons[0] ?? "",
        build: pl?.build ? buildText(pl.build) : "",
        kos: f?.kos ?? 0,
        damage: f?.damage ?? 0,
        // one round per Arena record: a seat that was not on the field to the end was knocked out
        died: f ? f.alive < f.roundSeconds : false,
      };
    }),
  };
}

const boards = new WeakMap<MatchServer, { at: number; board: ModelBoard }>();

/** The models board, rebuilt at most every 20 s (rounds take longer than that at broadcast pace); `fresh` rebuilds now. */
export async function modelsBoardOf(server: MatchServer, fresh = false): Promise<Omit<ModelBoard, "rows"> & { rows: (ModelBoardRow & { operators: Operator[] })[]; note: string }> {
  let c = boards.get(server);
  if (fresh || !c || Date.now() - c.at >= 20_000) {
    const read = async (rows: RecordRow[]) =>
      (
        await Promise.all(
          rows.map(async (row) => {
            if (row.engine !== server.store.engine) return null;
            if (row.tier === "bot-only") return null;
            const sum = summarizeReplay(await cacheOf(server).raw(row.path), row.matchId, row.path, row.createdAt, row.tier);
            return sum ? boardRound(sum, row.stats) : null;
          }),
        )
      ).filter((x): x is BoardRound => x !== null);
    const [pub, streaks, latest] = await Promise.all([server.store.listRecords(BOARD_ROUNDS).then((r) => read(r)), server.store.listStreaks(), server.store.latestSeats()]);
    const live = [...server.arena.seats.filter((e) => e !== null), ...server.arena.queue];
    const joined = [
      ...live.map((e) => ({ name: e.name, model: e.model, look: e.look, live: true })),
      ...latest.map((s) => ({ name: s.name, model: s.model, look: s.look, live: false })),
    ];
    c = { at: Date.now(), board: modelBoard(pub, streaks, joined) };
    boards.set(server, c);
  }
  // the operators (#113) who run each model's agents: read each time (a profile edit shows at once; one small query)
  const ops = (await operatorsOf(server)).byAgent;
  const opsOf = (names: string[]) => [...new Map(names.flatMap((n) => (ops.has(n.toLowerCase()) ? [[ops.get(n.toLowerCase())!.id, ops.get(n.toLowerCase())!] as const] : []))).values()];
  return {
    ...c.board,
    rows: c.board.rows.map((r) => ({ ...r, operators: opsOf(r.agents.map((a) => a.name)) })),
    note: "Rounds on this engine only. Models are what each agent said it runs when it joined (self-reported, nobody checks). A round is a whole fight: last fighter standing wins, so chance is 25% with 4 fighters. K/D: knockouts dealt per knockout taken. Best streak: the longest crown streak of the model's agents.",
  };
}

// ------------------------------------------------------------------ share card

/** place a portrait SVG at x,y with size w,h inside another SVG */
const placeSvg = (svg: string, x: number, y: number, w: number, h: number) => svg.replace("<svg ", `<svg x="${x}" y="${y}" width="${w}" height="${h}" `);

/** Model name of a seat label for the card: the model spotlight's name, "AGENT" when a remote agent did not say (pure). */
export function labelText(label: string): string {
  const m = modelOf(label);
  return m.key === "remote:unreported" ? "AGENT" : m.name;
}

/** The 1200x630 share card of a finished match, as SVG (pure: tested). */
export function shareCardSvg(r: ReplaySummary): string {
  const W = 1200;
  const H = 630;
  const w = r.winner >= 0 ? r.winner : 0;
  const win = r.identities[w]!;
  const col = hex(win.color);
  const name = (r.names[w] ?? "?").toUpperCase();
  const big = name.length > 8 ? 108 : 140;
  const theme = (r.theme || "arena").toUpperCase();
  const sorted = [...r.wins].sort((a, b) => b - a);
  const score = sorted.filter((x, i) => i < 2 || x > 0).join("–");
  const models = [...new Set(r.labels.map(labelText))].slice(0, 4).join(" vs ");
  const stack = (x: number, y: number, size: number, text: string, fill: string, depth: number) =>
    [...Array(depth)].map((_, k) => `<text x="${x + (depth - k)}" y="${y + (depth - k) * 1.4}" font-size="${size}" fill="#05070c">${esc(text)}</text>`).join("") + `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}">${esc(text)}</text>`;
  const losers = [0, 1, 2, 3].filter((i) => i !== w);
  const loserSvgs = losers
    .map((i, k) => {
      const id = r.identities[i]!;
      return placeSvg(portraitSvg(id, "ko" as Mood), 640 + k * 92, 384, 96, 104) + `<text x="${688 + k * 92}" y="${508}" font-size="15" fill="${hex(id.color)}" text-anchor="middle">${esc(r.names[i] ?? "")}</text>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'Arial Black', Arial, sans-serif" font-weight="900">
<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1d2233"/><stop offset="1" stop-color="#0f1424"/></linearGradient>
<radialGradient id="glow" cx="0.5" cy="0.55" r="0.5"><stop offset="0" stop-color="${col}" stop-opacity="0.35"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></radialGradient></defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<rect x="0" y="520" width="${W}" height="110" fill="#5a4630"/><rect x="0" y="520" width="${W}" height="10" fill="#6fae3e"/>
${[...Array(12)].map((_, k) => `<rect x="${k * 100 + 30}" y="${548 + (k % 3) * 18}" width="26" height="14" fill="#4a3a28"/>`).join("")}
${stack(60, 185, big, name, col, 6)}
${stack(60, 185 + big * 0.95, big, "WINS", col, 6)}
<text x="64" y="${185 + big * 0.95 + 58}" font-size="26" fill="#f4f6fb" letter-spacing="5">${esc(`${score} · ${theme} · AI VS AI`)}</text>
<text x="64" y="${185 + big * 0.95 + 96}" font-size="20" fill="#c7ccd8" font-family="Arial, sans-serif" font-weight="700">${esc(models)}</text>
<circle cx="1000" cy="330" r="230" fill="url(#glow)"/>
${placeSvg(portraitSvg(win, "win"), 830, 120, 340, 380)}
${loserSvgs}
<text x="60" y="598" font-size="34" fill="#ffd23f">KNOCKBACK</text>
<text x="318" y="596" font-size="20" fill="#f4f6fb" font-family="Arial, sans-serif" font-weight="700">AI agents plan. Physics decides.</text>
</svg>`;
}

// ------------------------------------------------------------------ routes

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-cache" } });

/** The site's read-only endpoints; null for any other path. Errors are thrown as HttpError (the caller answers them). */
export async function siteRoute(server: MatchServer, req: Request, path: string, url: URL): Promise<Response | null> {
  if (path === "/api/replays") {
    if (req.method !== "GET") throw new HttpError(405, "use GET for /api/replays", undefined, { allow: "GET" });
    const n = Number(url.searchParams.get("limit") ?? "30");
    const b = Number(url.searchParams.get("before"));
    const t = url.searchParams.get("tier");
    if (t !== null && t !== "featured" && t !== "warm-up") throw new HttpError(400, "tier: featured or warm-up");
    return json({ ...(await pageReplays(server, Number.isFinite(n) ? n : 30, url.searchParams.has("before") && Number.isFinite(b) ? b : undefined, t ?? undefined)) });
  }
  const rp = /^\/api\/replays\/(m_[0-9a-f]{8})$/.exec(path);
  if (rp) {
    if (req.method !== "GET") throw new HttpError(405, "use GET for /api/replays/:id", undefined, { allow: "GET" });
    const sum = await replayOf(server, rp[1]!);
    if (!sum) throw new HttpError(404, `no saved match ${rp[1]}`);
    return json({ replay: sum });
  }
  const ag = /^\/api\/agents\/([^/]{1,80})$/.exec(path);
  if (ag) {
    if (req.method !== "GET") throw new HttpError(405, "use GET for /api/agents/:name", undefined, { allow: "GET" });
    let name: string;
    try {
      name = decodeURIComponent(ag[1]!);
    } catch {
      throw new HttpError(400, "bad agent name");
    }
    return json(await agentProfile(server, name));
  }
  if (path === "/api/models/board") {
    if (req.method !== "GET") throw new HttpError(405, "use GET for /api/models/board", undefined, { allow: "GET" });
    return json(await modelsBoardOf(server));
  }
  if (path === "/api/leaderboard") {
    if (req.method !== "GET") throw new HttpError(405, "use GET for /api/leaderboard", undefined, { allow: "GET" });
    return json(await leaderboardOf(server));
  }
  const sh = /^\/share\/(m_[0-9a-f]{8})\.svg$/.exec(path);
  if (sh) {
    const sum = await replayOf(server, sh[1]!);
    if (!sum) throw new HttpError(404, `no finished match ${sh[1]}`);
    return new Response(shareCardSvg(sum), { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=3600" } });
  }
  return null;
}
