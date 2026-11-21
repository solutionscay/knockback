/**
 * The site pages' data mapping (#22, #42): pure functions from the server's JSON to what the pages show.
 * No DOM, no fetch: tested in tests/site-data.test.ts.
 */
import { fightSecondsAt, roundPlayback } from "../flow/pacing";
import { DEFAULT_TIMING } from "../flow/beats";
import type { Identity } from "../sim/identity";
import type { PlaybackPos } from "../viewer/embed";
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
export interface MatchInfo {
  id: string;
  status: "open" | "running" | "over" | "failed";
  seed: number;
  createdAt: string;
  startsInSec?: number;
  seats: SeatInfo[];
  round: number;
  wins: number[] | null;
  winner: string | null;
  record: string | null;
}
export interface ReplayInfo {
  match: string;
  record: string;
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
export { modelOf };

// ------------------------------------------------------------------ lobby

const newest = (a: { createdAt: string }, b: { createdAt: string }) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);

/** The match on the lobby stage: the newest running one; else none (the page shows the waiting state, #22). */
export function liveMatch(ms: MatchInfo[]): MatchInfo | null {
  return ms.filter((m) => m.status === "running").sort(newest)[0] ?? null;
}

/** The next match to start: the open match that starts first (the oldest). */
export function upNext(ms: MatchInfo[]): MatchInfo | null {
  return (
    ms
      .filter((m) => m.status === "open")
      .sort((a, b) => (a.startsInSec ?? 1e9) - (b.startsInSec ?? 1e9) || -newest(a, b))[0] ?? null
  );
}

export interface QueueEntry {
  agent: string;
  owner?: string;
  soulLine?: string;
  /** the open match it sits in; null while it waits in the matchmaker's queue */
  match: string | null;
  seat: number | null;
  startsInSec: number | null;
}

/** GET /api/queue (#22): the matchmaker's queue. */
export interface QueueInfo {
  waiting: { position: number; agent: string; owner: string; soulLine: string; waitingSec: number }[];
  /** agents still needed for a full match of outside agents */
  needed: number;
  /** seconds until the oldest agent's match starts with house bots; null with nobody waiting */
  fillsInSec: number | null;
  /** a match is running: the queue waits for it */
  blocked: boolean;
  /** null: agents only (no house-bot fill) */
  fillAfterSec: number | null;
}

/** The queue as checked data (pure: tested). */
export function queueInfo(raw: unknown): QueueInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.waiting)) return null;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  return {
    waiting: o.waiting.slice(0, 50).map((w, i) => {
      const x = (w ?? {}) as Record<string, unknown>;
      return { position: num(x.position, i + 1), agent: String(x.agent ?? "?").slice(0, 24), owner: String(x.owner ?? "").slice(0, 24), soulLine: String(x.soulLine ?? "").slice(0, 120), waitingSec: num(x.waitingSec, 0) };
    }),
    needed: num(o.needed, 4),
    fillsInSec: typeof o.fillsInSec === "number" ? o.fillsInSec : null,
    blocked: o.blocked === true,
    fillAfterSec: typeof o.fillAfterSec === "number" ? o.fillAfterSec : null,
  };
}

/** Who is waiting: the matchmaker's queue (the oldest four start first), then agents seated in open matches. */
export function queue(ms: MatchInfo[], q: QueueInfo | null = null): QueueEntry[] {
  const queued = (q?.waiting ?? []).map((w) => ({ agent: w.agent, owner: w.owner, soulLine: w.soulLine, match: null, seat: null, startsInSec: w.position <= 4 && !q!.blocked ? q!.fillsInSec : null }));
  const seated = ms
    .filter((m) => m.status === "open")
    .flatMap((m) => m.seats.filter((s) => s.agent).map((s) => ({ agent: s.agent!, owner: s.owner, soulLine: s.soulLine, match: m.id, seat: s.seat, startsInSec: m.startsInSec ?? null })))
    .sort((a, b) => (a.startsInSec ?? 1e9) - (b.startsInSec ?? 1e9));
  return [...queued, ...seated];
}

export interface JoinStatus {
  state: "waiting" | "queued" | "fighting" | "done";
  /** the owner's agent and its soul line, once it shows up */
  agent?: string;
  soulLine?: string;
  match?: string;
  startsInSec?: number | null;
  /** 1-based place among the agents waiting (queued only) */
  position?: number;
}

/** Where the owner's agent is now (#42: "your agent is in the queue"). Case-insensitive; the newest match wins. */
export function joinStatus(ms: MatchInfo[], owner: string, since = "", q: QueueInfo | null = null): JoinStatus {
  const want = owner.trim().toLowerCase();
  if (!want) return { state: "waiting" };
  const mineQ = (o: string | undefined) => (o ?? "").toLowerCase() === want;
  // in the matchmaker's queue (#22): no match yet
  const w = q?.waiting.find((x) => mineQ(x.owner));
  if (w) return { state: "queued", agent: w.agent, soulLine: w.soulLine, startsInSec: w.position <= 4 && !q!.blocked ? q!.fillsInSec : null, position: w.position };
  const seatOf = (m: MatchInfo) => m.seats.find((s) => s.agent && mineQ(s.owner));
  // a seat in an open or running match always counts; a finished match only when it is newer than `since`
  const mine = ms.filter((m) => seatOf(m) && (m.status === "open" || m.status === "running")).sort(newest)[0] ?? ms.filter((m) => seatOf(m) && m.createdAt >= since).sort(newest)[0];
  if (!mine) return { state: "waiting" };
  const seat = seatOf(mine)!;
  const who = { agent: seat.agent!, soulLine: seat.soulLine };
  if (mine.status === "open") return { state: "queued", ...who, match: mine.id, startsInSec: mine.startsInSec ?? null };
  if (mine.status === "running") return { state: "fighting", ...who, match: mine.id };
  return { state: "done", ...who, match: mine.id };
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

export function scoreline(wins: number[]): string {
  const s = [...wins].sort((a, b) => b - a);
  const shown = s.filter((x, i) => i < 2 || x > 0);
  return shown.join("–");
}

// ------------------------------------------------------------------ JOIN (#42)

const HANDLE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,23}$/;
/** Owner handles (and agent names) follow the same rules. */
export const validHandle = (n: string) => HANDLE.test(n.trim());

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

/** Entries viewers have reached, newest first. */
export function visibleFeed(entries: FeedEntry[], at: PlaybackPos | null): FeedEntry[] {
  // one entry per key: a check-in comes once per seat asked, the same moment for all
  const seen = new Set<string>();
  return entries.filter((e) => reachedPos(at, e.when) && !seen.has(e.key) && seen.add(e.key)).reverse();
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
