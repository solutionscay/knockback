/**
 * The site pages' data mapping (#22, #42): pure functions from the server's JSON to what the pages show.
 * No DOM, no fetch: tested in tests/site-data.test.ts.
 */
import { fightSecondsAt, roundPlayback } from "../flow/pacing";
import { DEFAULT_TIMING } from "../flow/beats";
import type { Identity } from "../sim/identity";
import type { PlaybackPos } from "../viewer/embed";
import { NAME_RE } from "../names";
import { modelOf } from "../stats/models";

// ------------------------------------------------------------------ API shapes (what the pages read)

export interface SeatInfo {
  seat: number;
  kind: string;
  agent: string | null;
  /** the agent's owner and its soul's first sentence (agent seats) */
  owner?: string;
  soulLine?: string;
  fighter: string | null;
  label: string | null;
  autopilot?: string;
  finishedOnAutopilot?: boolean;
}
/** One Arena round (#64): a one-round match. */
export interface MatchInfo {
  id: string;
  arenaRound: number;
  status: "open" | "running" | "over" | "failed";
  seed: number;
  createdAt: string;
  seats: SeatInfo[];
  round: number;
  wins: number[] | null;
  winner: string | null;
  record: string | null;
}
export interface ReplayInfo {
  match: string;
  record: string;
  /** featured (2+ agents) or warm-up (1 agent, house bots in the other seats) (#67) */
  tier: "featured" | "warm-up";
  createdAt: string;
  seed: number;
  theme: string;
  names: string[];
  labels: string[];
  identities: Identity[];
  weapons: string[];
  winner: number;
  wins: number[];
  rounds: { winner: number; lines: string[]; plans: { stance: string; target: string; weapons: string[] }[]; planChanges: number[] }[];
  control: { seat: number; mode: "autopilot" | "agent"; round: number }[];
}
export interface ReportRound {
  round: number;
  plans: { fighter: string; line: string; strategy: { stance?: string; target?: string; weapons?: string[] } }[];
  result: { winner: string; reason: string; seconds: number; ticks?: number; knockouts: { victim: string; by: string | null; weapon: string; cause: string; tick?: number | null }[] } | null;
}

// ------------------------------------------------------------------ formatting

/** 75 -> "1:15" */
export function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "18 Nov" */
export function ago(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const m = Math.round((now - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  if (h < 48) return "yesterday";
  return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export const ordinal = (n: number) => `${n}${n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th"}`;
export const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** The model behind a seat label: the model spotlight's modelOf (src/stats/models.ts). */

// ------------------------------------------------------------------ the Arena (#64)

/** The crown (#65): its holder (an agent, or the house bot in a seat), the streak, the seat it plays next. */
export interface CrownInfo {
  agent: string | null;
  owner: string | null;
  /** a house bot holder's seat */
  houseSeat: number | null;
  streak: number;
  /** rounds of the streak with 2 or more agents */
  ranked: number;
  /** the seat the holder plays in the next round; null: it does not play it */
  seat: number | null;
}

/** The last round played (#65): each seat's place, knockouts and damage; a replay link when it is public. */
export interface LastRoundInfo {
  number: number;
  tier: string;
  replay: string | null;
  /** identity: the fighter's identity in that round (unchecked: cleanIdentity before drawing it) */
  seats: { seat: number; fighter: string; identity: unknown; agent: string | null; owner: string | null; place: number; kos: number; damage: number }[];
}

/** GET /api/queue: the Arena as the pages show it. */
export interface ArenaInfo {
  crown: CrownInfo | null;
  lastRound: LastRoundInfo | null;
  /** the round on now (or the last one, between rounds) and who plays it */
  round: { number: number; match: string; status: string; playing: { seat: number; agent: string | null; owner: string | null }[] } | null;
  /** the round the seats below play next */
  nextRound: number;
  /** the 4 seats: an agent's (from a round) or a house bot's */
  /** look: an agent's identity wish (unchecked: cleanIdentity before drawing it) */
  seats: { seat: number; holder: "agent" | "house"; agent: string | null; owner: string; soulLine: string; look: unknown; fromRound: number }[];
  queue: { position: number; agent: string; owner: string; soulLine: string; look: unknown; waitingSec: number }[];
  deadlineSec: number;
}

/** The Arena as checked data (pure). */
export function arenaInfo(raw: unknown): ArenaInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.seats) || !Array.isArray(o.queue)) return null;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  const r = o.round && typeof o.round === "object" ? (o.round as Record<string, unknown>) : null;
  const name = (v: unknown) => (typeof v === "string" ? v.slice(0, 24) : null);
  const c = o.crown && typeof o.crown === "object" ? (o.crown as Record<string, any>) : null;
  const h = c?.holder && typeof c.holder === "object" ? (c.holder as Record<string, unknown>) : null;
  const lr = o.lastRound && typeof o.lastRound === "object" ? (o.lastRound as Record<string, unknown>) : null;
  return {
    crown: c && h ? { agent: h.kind === "agent" ? name(h.agent) : null, owner: h.kind === "agent" ? name(h.owner) : null, houseSeat: h.kind === "house" ? num(h.seat, 0) : null, streak: num(c.streak, 0), ranked: num(c.ranked, 0), seat: typeof c.seat === "number" ? c.seat : null } : null,
    lastRound: lr
      ? {
          number: num(lr.number, 0),
          tier: str(lr.tier, 16),
          replay: typeof lr.replay === "string" && /^\/replay\/m_[0-9a-f]{8}$/.test(lr.replay) ? lr.replay : null,
          seats: (Array.isArray(lr.seats) ? lr.seats : []).slice(0, 4).map((x0, i) => {
            const x = (x0 ?? {}) as Record<string, unknown>;
            return { seat: num(x.seat, i), fighter: str(x.fighter, 24), identity: x.identity ?? null, agent: name(x.agent), owner: name(x.owner), place: num(x.place, 4), kos: num(x.kos, 0), damage: num(x.damage, 0) };
          }),
        }
      : null,
    round: r
      ? {
          number: num(r.number, 0),
          match: str(r.match, 32),
          status: str(r.status, 16),
          playing: (Array.isArray(r.playing) ? r.playing : []).slice(0, 4).map((p, i) => {
            const x = (p ?? {}) as Record<string, unknown>;
            return { seat: num(x.seat, i), agent: typeof x.agent === "string" ? x.agent.slice(0, 24) : null, owner: typeof x.owner === "string" ? x.owner.slice(0, 24) : null };
          }),
        }
      : null,
    nextRound: num(o.nextRound, 1),
    seats: o.seats.slice(0, 4).map((x0, i) => {
      const x = (x0 ?? {}) as Record<string, unknown>;
      const agent = x.holder === "agent" && typeof x.agent === "string" ? x.agent.slice(0, 24) : null;
      return { seat: num(x.seat, i), holder: agent ? "agent" : "house", agent, owner: str(x.owner, 24), soulLine: str(x.soulLine, 120), look: x.look ?? null, fromRound: num(x.fromRound, 0) };
    }),
    queue: o.queue.slice(0, 50).map((w, i) => {
      const x = (w ?? {}) as Record<string, unknown>;
      return { position: num(x.position, i + 1), agent: str(x.agent, 24) || "?", owner: str(x.owner, 24), soulLine: str(x.soulLine, 120), look: x.look ?? null, waitingSec: num(x.waitingSec, 0) };
    }),
    deadlineSec: num(o.deadlineSec, 75),
  };
}

/** GET /api/leaderboard (#65): agents and owners by rounds, agent seats only. */
export interface BoardRow {
  vsAgents: { rounds: number; wins: number };
  vsHouse: { rounds: number; wins: number };
  bestStreak: number;
}
export interface LeaderboardInfo {
  agents: (BoardRow & { name: string; owner: string; label: string; operator?: unknown })[];
  owners: (BoardRow & { owner: string; agents: number; bestBy: string | null; operator?: unknown })[];
  note: string;
}

/** An operator profile as the site shows it (#113): a nickname and a URL. */
export interface OperatorInfo {
  id: string;
  nickname: string;
  url: string | null;
}

/** An operator from the API, or null. Checked again here: the URL is kept only when it is plain http(s) (pure). */
export function operatorOf(v: unknown): OperatorInfo | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || !/^op_[0-9a-f]{16}$/.test(o.id) || typeof o.nickname !== "string" || !o.nickname) return null;
  let url: string | null = null;
  if (typeof o.url === "string") {
    try {
      const u = new URL(o.url);
      if (u.protocol === "http:" || u.protocol === "https:") url = u.href;
    } catch {
      url = null;
    }
  }
  return { id: o.id, nickname: o.nickname.slice(0, 32), url };
}

/** Who sits in each seat for the next round: an agent (and the round it enters) or a house bot (pure). */
export function nextLineup(a: ArenaInfo): { seat: number; agent: string | null; owner: string; soulLine: string; look: unknown; enters: number | null }[] {
  return a.seats.map((s) => ({ seat: s.seat, agent: s.agent, owner: s.owner, soulLine: s.soulLine, look: s.look, enters: s.agent && s.fromRound >= a.nextRound ? s.fromRound : null }));
}

export interface JoinStatus {
  /** waiting: no agent of this owner in the Arena yet; queued; seated (enters a round soon); fighting (plays the round on now) */
  state: "waiting" | "queued" | "seated" | "fighting";
  agent?: string;
  soulLine?: string;
  match?: string;
  /** the round the agent enters (seated) */
  entersRound?: number;
  /** 1-based place in the queue (queued) */
  position?: number;
}

/** Where the owner's agent is in the Arena (#42: "your agent is in"). Case-insensitive. Pure. */
export function joinStatus(a: ArenaInfo | null, owner: string): JoinStatus {
  const want = owner.trim().toLowerCase();
  if (!want || !a) return { state: "waiting" };
  const mine = (o: string | null | undefined) => (o ?? "").toLowerCase() === want;
  const seat = a.seats.find((s) => s.agent && mine(s.owner));
  if (seat) {
    const live = a.round && (a.round.status === "running" || a.round.status === "open") && a.round.playing.some((p) => p.agent === seat.agent);
    return live ? { state: "fighting", agent: seat.agent!, soulLine: seat.soulLine, match: a.round!.match } : { state: "seated", agent: seat.agent!, soulLine: seat.soulLine, entersRound: Math.max(seat.fromRound, a.nextRound) };
  }
  const w = a.queue.find((x) => mine(x.owner));
  return w ? { state: "queued", agent: w.agent, soulLine: w.soulLine, position: w.position } : { state: "waiting" };
}

/** Round wins as a scoreline: [2,1,0,0] -> "2–1", [2,0,0,0] -> "2–0", [1,1,1,0] -> "1–1–1". */
/**
 * The gallery's rule (lobby results, /replays): a match shows when every seat was an agent that joined over MCP or
 * HTTP ("remote/...") or a house bot. Matches where the server ran a model itself (built-in claude/codex/grok seats,
 * the model previews) or a test provider (stub, slow, junk...) are training data, not fights: left out. Pure: tested.
 */
export function isGalleryMatch(labels: string[]): boolean {
  return labels.every((l) => {
    const k = modelOf(l);
    return k.provider === "house" || (!k.test && /^remote\//i.test(l.trim()));
  });
}
export const galleryReplays = (rs: ReplayInfo[]) => rs.filter((r) => isGalleryMatch(r.labels));

/** Featured rounds (2+ agents) first, then warm-ups; newest first within each (pure, #67). */
export const featuredFirst = (rs: ReplayInfo[]) => [...rs.filter((r) => r.tier === "featured"), ...rs.filter((r) => r.tier !== "featured")];

export function scoreline(wins: number[]): string {
  const s = [...wins].sort((a, b) => b - a);
  const shown = s.filter((x, i) => i < 2 || x > 0);
  return shown.join("–");
}

// ------------------------------------------------------------------ JOIN (#42)

/** Owner handles (and agent names) follow the same rules. */
export const validHandle = (n: string) => NAME_RE.test(n.trim());

export type JoinTab = "claude" | "codex" | "grok" | "json";

/** The environment variable the Codex config reads the owner key from. */
export const CODEX_KEY_ENV = "KNOCKBACK_KEY";

/** What to tell the agent once the MCP config is in. */
export const PLAY = "play Knockback";

/**
 * The MCP config per client, with the owner's key, always as an Authorization header: on the command line (Claude
 * Code, Grok), in the JSON, and for Codex from an environment variable (its config reads a bearer token only from one).
 * `mcp` is the full /mcp URL.
 */
export function joinSnippet(tab: JoinTab, mcp: string, key: string): string {
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  switch (tab) {
    case "claude":
      return `claude mcp add --transport http knockback ${q(mcp)} --header ${q(`Authorization: Bearer ${key}`)}`;
    case "codex":
      return `# 1. your shell profile (~/.zshrc, ~/.bashrc), then open a new terminal\nexport ${CODEX_KEY_ENV}=${q(key)}\n# 2. ~/.codex/config.toml\n[mcp_servers.knockback]\nurl = ${JSON.stringify(mcp)}\nbearer_token_env_var = "${CODEX_KEY_ENV}"\ntool_timeout_sec = 120`;
    case "grok":
      return `grok mcp add --transport http knockback ${q(mcp)} --header ${q(`Authorization: Bearer ${key}`)}`;
    case "json":
      return JSON.stringify({ mcpServers: { knockback: { type: "http", url: mcp, headers: { Authorization: `Bearer ${key}` } } } }, null, 2);
  }
}

/** The MCP URL: GET /api/join's `mcp` (the server's public URL, #22), else this server's /mcp. */
export function mcpUrlFrom(join: unknown, origin: string): string {
  const j = (join && typeof join === "object" ? join : {}) as Record<string, unknown>;
  for (const k of ["mcp", "mcpUrl", "url"]) {
    const v = j[k];
    if (typeof v === "string" && /^https?:\/\/[^\s"'<>]+$/.test(v)) return v.endsWith("/mcp") ? v : `${v.replace(/\/$/, "")}/mcp`;
  }
  const pub = j.publicUrl;
  if (typeof pub === "string" && /^https?:\/\/[^\s"'<>]+$/.test(pub)) return `${pub.replace(/\/$/, "")}/mcp`;
  return `${origin}/mcp`;
}

// ------------------------------------------------------------------ fight feed (/watch)

export type FeedEntry =
  | { kind: "line"; seat: number; round: number; text: string; plan: string; when: PlaybackPos; key: string }
  | { kind: "plan"; seat: number; round: number; text: string; tick: number; when: PlaybackPos; key: string }
  | { kind: "checkin"; round: number; tick: number; when: PlaybackPos; key: string }
  | { kind: "control"; seat: number; mode: "autopilot" | "back"; text: string; when: PlaybackPos; key: string }
  | { kind: "round"; round: number; winner: number; kos: { victim: number; by: number; cause: string }[]; when: PlaybackPos; key: string }
  | { kind: "done"; winner: number; wins: number[]; record: string | null; when: PlaybackPos; key: string };

export const planText = (s: { stance?: string; target?: string; weapons?: string[] } | undefined) => [s?.stance, s?.target, s?.weapons?.[0]].filter(Boolean).join(" · ");

/**
 * One live stream message -> feed entries, each with the playback position at which viewers reach it, so the
 * feed never runs ahead of the fight (the server streams a round's result as soon as it is simulated).
 */
export function feedEntries(msg: unknown): FeedEntry[] {
  if (!msg || typeof msg !== "object") return [];
  const m = msg as Record<string, any>;
  const n = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  switch (m.type) {
    case "decisions": {
      const round = n(m.round, 1);
      return (Array.isArray(m.decisions) ? m.decisions : []).slice(0, 4).map((d: any, seat: number) => ({
        kind: "line" as const,
        seat,
        round,
        text: String(d?.line ?? "").slice(0, 240),
        plan: planText(d?.strategy),
        when: { round, phase: "plan" as const, tick: 0 },
        key: `d${round}.${seat}`,
      }));
    }
    case "planUpdate": {
      const u = m.update ?? {};
      const round = n(m.round, 1);
      const tick = n(u.tick);
      const seat = n(u.fighter, -1);
      if (seat < 0 || seat > 3) return [];
      const text = String(u.line ?? "").slice(0, 240);
      const plan = planText(u.strategy);
      return [{ kind: "plan", seat, round, text: text || (plan ? `new plan: ${plan}` : "changes plan"), tick, when: { round, phase: "fight", tick }, key: `p${round}.${tick}.${seat}` }];
    }
    case "checkin": {
      const round = n(m.round, 1);
      const tick = n(m.tick);
      return [{ kind: "checkin", round, tick, when: { round, phase: "fight", tick }, key: `c${round}.${tick}` }];
    }
    case "control": {
      const seat = n(m.seat, -1);
      if (seat < 0 || seat > 3) return [];
      const round = n(m.round, 1);
      // runner phases: plan | fight | checkin (mid-fight) | roundEnd
      const phase = m.phase === "fight" || m.phase === "checkin" ? "fight" : m.phase === "roundEnd" ? "end" : "plan";
      const tick = phase === "fight" ? n(m.tick) : 0;
      return [{ kind: "control", seat, mode: m.mode === "agent" ? "back" : "autopilot", text: String(m.line ?? "").slice(0, 240), when: { round, phase, tick }, key: `a${round}.${tick}.${seat}.${m.mode}` }];
    }
    case "round": {
      const round = n(m.round, 1);
      const kos = (Array.isArray(m.kos) ? m.kos : []).map((k: any) => ({ victim: n(k?.victim, -1), by: n(k?.by, -1), cause: String(k?.cause ?? "") }));
      return [{ kind: "round", round, winner: n(m.winner, -1), kos, when: { round, phase: "end", tick: 0 }, key: `r${round}` }];
    }
    case "done":
      return [{ kind: "done", winner: n(m.winner, -1), wins: Array.isArray(m.wins) ? m.wins.map((x: unknown) => n(x)) : [], record: typeof m.record === "string" ? m.record : null, when: { round: 9, phase: "end", tick: 0, done: true }, key: "done" }];
  }
  return [];
}

const PH = { plan: 0, fight: 1, end: 2 } as const;
/** Has playback reached `when`? (the bridge's rule, kept here so the page needs no viewer import at runtime) */
export function reachedPos(at: PlaybackPos | null, when: PlaybackPos): boolean {
  if (!at) return false;
  if (when.done) return !!at.done;
  if (at.done) return true;
  if (at.round !== when.round) return at.round > when.round;
  if (at.phase !== when.phase) return PH[at.phase] > PH[when.phase];
  return at.phase !== "fight" || at.tick >= when.tick;
}

// ------------------------------------------------------------------ replay timeline (/replay)

export interface Segment {
  round: number;
  start: number;
  preFight: number;
  fight: number;
  roundEnd: number;
  end: number;
  ticks: number;
  /** knockout ticks in order (for slow motion offsets) */
  koTicks: number[];
}
export interface Pin {
  t: number;
  kind: "ko" | "ringout" | "win";
  seat: number;
  round: number;
  tick: number;
  label: string;
}
export interface Chapter {
  t: number;
  label: string;
  seat: number;
  to: PlaybackPos;
}
export interface Timeline {
  segments: Segment[];
  pins: Pin[];
  chapters: Chapter[];
  total: number;
}

/** The replay's timeline from the match report and its names: round segments, event pins, chapters (pure). */
export function timeline(rounds: ReportRound[], names: string[]): Timeline {
  const seat = (n: string | null | undefined) => (n ? names.indexOf(n) : -1);
  const segments: Segment[] = [];
  const pins: Pin[] = [];
  const chapters: Chapter[] = [];
  let t = 0;
  for (const r of rounds) {
    if (!r.result) break;
    const ticks = r.result.ticks ?? Math.round(r.result.seconds * 60);
    const kos = r.result.knockouts;
    const p = roundPlayback({ round: r.round, lines: r.plans.map((x) => x.line ?? ""), fightTicks: ticks, kos: kos.length, endsWithKo: r.result.reason === "last-standing", timing: DEFAULT_TIMING });
    const seg: Segment = { round: r.round, start: t, preFight: p.preFight, fight: p.fight, roundEnd: p.roundEnd, end: t + p.total, ticks, koTicks: kos.map((k) => k.tick ?? -1).filter((x) => x >= 0) };
    segments.push(seg);
    chapters.push({ t, label: r.round === 1 ? "Trash talk" : `Round ${r.round}`, seat: -1, to: { round: r.round, phase: "plan", tick: 0 } });
    kos.forEach((k, i) => {
      if (k.tick === null || k.tick === undefined) return;
      const v = seat(k.victim);
      const at = t + p.preFight + fightSecondsAt(k.tick, i);
      const kind = k.cause === "ringout" ? "ringout" : "ko";
      pins.push({ t: at, kind, seat: v, round: r.round, tick: k.tick, label: kind === "ringout" ? "RING OUT" : "K.O." });
      chapters.push({ t: Math.max(t + p.preFight, at - 3), label: `${k.victim} ${kind === "ringout" ? "ring out" : "K.O."}`, seat: v, to: { round: r.round, phase: "fight", tick: Math.max(0, k.tick - 180) } });
    });
    t += p.total;
  }
  const last = segments.at(-1);
  const lastRound = rounds[segments.length - 1];
  if (last && lastRound?.result) {
    const w = seat(lastRound.result.winner);
    pins.push({ t: last.start + last.preFight + last.fight, kind: "win", seat: w, round: last.round, tick: last.ticks, label: "WIN" });
  }
  return { segments, pins, chapters, total: t + (segments.length ? DEFAULT_TIMING.celebrate : 0) };
}

/** Seconds into the replay of a playback position (fight ticks map exactly; before the fight: the round's start). */
export function timeOfPos(tl: Timeline, pos: PlaybackPos | null): number {
  if (!pos) return 0;
  if (pos.done) return tl.total;
  const s = tl.segments.find((x) => x.round === pos.round);
  if (!s) return 0;
  if (pos.phase === "plan") return s.start;
  if (pos.phase === "end") return s.start + s.preFight + s.fight;
  const kosBefore = s.koTicks.filter((k) => k < pos.tick).length;
  return s.start + s.preFight + Math.min(s.fight, fightSecondsAt(pos.tick, kosBefore));
}

/** The playback position to seek to for a point on the scrubber. */
export function posAtTime(tl: Timeline, t: number): PlaybackPos {
  const s = tl.segments.find((x) => t < x.end) ?? tl.segments.at(-1);
  if (!s) return { round: 1, phase: "plan", tick: 0 };
  const e = t - s.start;
  if (e < s.preFight) return { round: s.round, phase: "plan", tick: 0 };
  if (e < s.preFight + s.fight) return { round: s.round, phase: "fight", tick: Math.min(s.ticks, Math.max(0, Math.floor(((e - s.preFight) / s.fight) * s.ticks))) };
  return { round: s.round, phase: "end", tick: s.ticks };
}
