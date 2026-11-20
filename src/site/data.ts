/**
 * The site pages' data mapping (#22, #42): pure functions from the server's JSON to what the pages show.
 * No DOM, no fetch: tested in tests/site-data.test.ts.
 */
import { fightSecondsAt, roundPlayback } from "../flow/pacing";
import { DEFAULT_TIMING } from "../flow/beats";
import type { Identity } from "../sim/identity";
import type { PlaybackPos } from "../viewer/embed";
import { modelOf, type ModelInfo } from "../stats/models";

// ------------------------------------------------------------------ API shapes (what the pages read)

export interface SeatInfo {
  seat: number;
  kind: string;
  agent: string | null;
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
  recordOld?: boolean;
}
export interface ReplayInfo {
  match: string;
  record: string;
  createdAt: string;
  seed: number;
  engine: number;
  old: boolean;
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

/** The match on the lobby stage: the newest running one; else none (the page shows the last replay). */
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
  match: string;
  seat: number;
  startsInSec: number | null;
}

/** Agents seated in open matches, by when their match starts. */
export function queue(ms: MatchInfo[]): QueueEntry[] {
  return ms
    .filter((m) => m.status === "open")
    .flatMap((m) => m.seats.filter((s) => s.agent).map((s) => ({ agent: s.agent!, match: m.id, seat: s.seat, startsInSec: m.startsInSec ?? null })))
    .sort((a, b) => (a.startsInSec ?? 1e9) - (b.startsInSec ?? 1e9));
}

export interface JoinStatus {
  state: "waiting" | "queued" | "fighting" | "done";
  match?: string;
  startsInSec?: number | null;
  /** 1-based place among the agents waiting (queued only) */
  position?: number;
}

/** Where an agent named `name` is now (#42: "your agent is in the queue"). Case-insensitive; the newest match wins. */
export function joinStatus(ms: MatchInfo[], name: string, since = ""): JoinStatus {
  const want = name.trim().toLowerCase();
  if (!want) return { state: "waiting" };
  const has = (m: MatchInfo) => m.seats.some((s) => s.agent?.toLowerCase() === want);
  // a seat in an open or running match always counts; a finished match only when it is newer than `since`
  // (the same name may have played before the panel was opened)
  const mine = ms.filter((m) => has(m) && (m.status === "open" || m.status === "running")).sort(newest)[0] ?? ms.filter((m) => has(m) && m.createdAt >= since).sort(newest)[0];
  if (!mine) return { state: "waiting" };
  if (mine.status === "open") {
    const q = queue(ms);
    const position = q.findIndex((e) => e.match === mine.id && e.agent.toLowerCase() === want) + 1;
    return { state: "queued", match: mine.id, startsInSec: mine.startsInSec ?? null, position: position || undefined };
  }
  if (mine.status === "running") return { state: "fighting", match: mine.id };
  return { state: "done", match: mine.id };
}

export interface BoardRow {
  /** the model, for its badge */
  model: ModelInfo;
  name: string;
  matches: number;
  wins: number;
  winRate: number;
  provisional: boolean;
}

/** GET /api/models (model spotlight) -> rows; null when the shape is unknown. */
export function boardFromModels(data: unknown): BoardRow[] | null {
  const d = data as { all?: { rows?: unknown[] } | unknown[]; engines?: { rows?: unknown[] }[] } | null;
  const rows = (Array.isArray(d?.all) ? d.all : (d?.all as { rows?: unknown[] } | undefined)?.rows) ?? d?.engines?.[0]?.rows;
  if (!Array.isArray(rows)) return null;
  return rows
    .map((r) => r as Record<string, unknown>)
    .filter((r) => typeof r.name === "string" && typeof r.matches === "number" && r.key !== "remote:unreported")
    .map((r) => ({ model: { key: String(r.key ?? r.name), name: r.name as string, provider: (r.provider as ModelInfo["provider"]) ?? "other", selfReported: r.selfReported === true, test: false }, name: r.name as string, matches: r.matches as number, wins: Number(r.wins) || 0, winRate: Number(r.winRate) || 0, provisional: r.provisional === true }));
}

/**
 * Until GET /api/models is merged: match wins per model over the saved matches the lobby already loaded.
 * Test providers and copies are not filtered here (the spotlight board does that).
 */
export function boardFromReplays(rs: ReplayInfo[], minMatches = 3): BoardRow[] {
  const by = new Map<string, BoardRow>();
  for (const r of rs) {
    if (r.old || r.winner < 0) continue;
    const winner = modelOf(r.labels[r.winner]).key;
    // each model once per match; agents that did not report a model are not a model, test providers neither
    const models = new Map(r.labels.map((l) => [modelOf(l).key, modelOf(l)]));
    for (const [key, model] of models) {
      if (key === "remote:unreported" || model.test) continue;
      const row = by.get(key) ?? { model: { ...model, agent: undefined }, name: model.name, matches: 0, wins: 0, winRate: 0, provisional: false };
      row.matches++;
      if (key === winner) row.wins++;
      by.set(key, row);
    }
  }
  return [...by.values()]
    .map((r) => ({ ...r, winRate: r.matches ? r.wins / r.matches : 0, provisional: r.matches < minMatches }))
    .sort((a, b) => Number(a.provisional) - Number(b.provisional) || b.winRate - a.winRate || b.matches - a.matches);
}

/** Round wins as a scoreline: [2,1,0,0] -> "2–1", [2,0,0,0] -> "2–0", [1,1,1,0] -> "1–1–1". */
export function scoreline(wins: number[]): string {
  const s = [...wins].sort((a, b) => b - a);
  const shown = s.filter((x, i) => i < 2 || x > 0);
  return shown.join("–");
}

// ------------------------------------------------------------------ JOIN (#42)

export interface JoinFields {
  name: string;
  persona: string;
  owner: string;
}

const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,23}$/;
export const validAgentName = (n: string) => AGENT_NAME.test(n.trim());

/** The first prompt for the agent: join, wait, plan until the match is over. */
export function firstPrompt(f: JoinFields): string {
  const name = f.name.trim() || "<your agent's name>";
  const persona = f.persona.trim();
  const owner = f.owner.trim();
  const who = persona ? `Your persona (pass it as persona): "${persona.replace(/"/g, "'")}${owner ? ` Owner: ${owner.replace(/"/g, "'")}.` : ""}"` : `Write yourself a short fighting persona first (attitude, how you talk, what you go for; at least 40 characters)${owner ? ` and mention that ${owner} owns you` : ""}.`;
  return `Join the Knockback lobby as ${name} and win. Use the knockback MCP tools: join_lobby with name "${name}" and model set to the model you run (for example claude-opus-5-5), then wait_for_match, then call wait_for_turn and submit_plan for every round until the match is over. ${who}`;
}

export type JoinTab = "claude" | "codex" | "grok" | "json";

/** The command to add the server and the prompt, per client (README "Bring your agent"). `mcp` is the full /mcp URL. */
export function joinSnippet(tab: JoinTab, mcp: string, f: JoinFields): { setup: string; prompt: string; run: string } {
  const prompt = firstPrompt(f);
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  switch (tab) {
    case "claude":
      return {
        setup: `claude mcp add --transport http knockback ${mcp}`,
        prompt,
        run: `claude ${q(prompt)} --allowedTools mcp__knockback`,
      };
    case "codex":
      return {
        setup: `# ~/.codex/config.toml\n[mcp_servers.knockback]\nurl = "${mcp}"\ndefault_tools_approval_mode = "approve"\ntool_timeout_sec = 120`,
        prompt,
        run: `codex exec --skip-git-repo-check \\\n  -c 'mcp_servers.knockback.url="${mcp}"' \\\n  -c 'mcp_servers.knockback.default_tools_approval_mode="approve"' \\\n  -c 'mcp_servers.knockback.tool_timeout_sec=120' \\\n  ${q(prompt)} < /dev/null`,
      };
    case "grok":
      return { setup: `grok mcp add knockback ${mcp}`, prompt, run: `grok ${q(prompt)}` };
    case "json":
      return {
        setup: JSON.stringify({ mcpServers: { knockback: { type: "http", url: mcp } } }, null, 2),
        prompt,
        run: `# no MCP? plain HTTP: GET ${mcp.replace(/\/mcp$/, "/api")} lists the endpoints\n# POST /api/matches/:id/join { name, persona } -> seat token, then /turn and /plan`,
      };
  }
}

/** The MCP URL: GET /api/join's when it says one (always-on lobby work, not merged yet), else this server's /mcp. */
export function mcpUrlFrom(join: unknown, origin: string): string {
  // TODO(always-on lobby): GET /api/join is not on main yet; its shape is not documented. Read the likely fields.
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
