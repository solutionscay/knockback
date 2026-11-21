/**
 * The MCP tools (#21, #49): get_started, join_lobby, wait_for_match, wait_for_turn, submit_plan, submit_checkin,
 * get_round_report and leave, registered on one session's McpServer. A tool sees only its ToolContext: the session's
 * state, the match server, the lobby, the public base URL, and `call`, the match server's HTTP API in-process as
 * this session (with its seat token, which the agent never sees). The gateway (src/server/mcp.ts) owns transport,
 * session lifetime and HTTP.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { lookOptions } from "../ai/looks";
import { CLASSIC, type Ruleset } from "../sim/ruleset";
import type { MatchServer } from "./match-server";
import { hashToken } from "./seat-tokens";
import type { Matchmaker } from "./matchmaker";
import { checkinBriefing, briefingOf, checkinInput, fixHints, MCP_WAIT_S, planDescription, planInput, reportInput, type strategySchema } from "./mcp-schema";
import { MAX_SOUL, MIN_SOUL } from "./soul-guard";

export interface Session {
  id: string;
  ip: string;
  /** the owner key of this connection (memory only), its hash, and its owner */
  key: string;
  keyHash: string;
  owner: string;
  createdAt: number;
  lastSeen: number;
  name?: string;
  match?: string;
  seat?: number;
  /** the seat token: kept here, never shown to the agent */
  token?: string;
  /** the queue ticket while the agent waits for a seat (#22) */
  ticket?: string;
  /** the round of the last turn handed out (submit_plan's default) */
  round?: number;
  /** the last check-in handed out (submit_checkin's default) */
  checkin?: { round: number; tick: number };
}

export interface ToolContext {
  state: Session;
  api: MatchServer;
  lobby: Matchmaker;
  /** public base URL for links in tool results */
  base: string;
  /** Call the match server's HTTP API in-process as this session (with its seat token). */
  call: (method: string, path: string, body?: unknown, signal?: AbortSignal) => Promise<{ status: number; data: any }>;
}

/** The look this agent's fighter got (#19): the identity, and which of its wishes were kept or replaced. */
function yourLook(m: { runner: { match: { identities: { name: string; shape: string; eyes: string; mark: string; minor?: string; color: number }[]; record: { suitUp?: { seat: number; kept: string[]; dropped: { field: string; why: string }[]; nudged?: { from: number; to: number } }[] } } } | null }, seat: number) {
  const r = m.runner;
  if (!r) return {};
  const id = r.match.identities[seat]!;
  const e = r.match.record.suitUp?.find((x) => x.seat === seat);
  const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;
  return {
    look: { name: id.name, shape: id.shape, eyes: id.eyes, mark: id.mark, minor: id.minor ?? "none", color: hex(id.color) },
    ...(e ? { lookChoice: { kept: e.kept, replaced: e.dropped.map((d) => `${d.field} (${d.why})`), ...(e.nudged ? { colorNudged: `${hex(e.nudged.from)} -> ${hex(e.nudged.to)}` } : {}) } } : {}),
  };
}

const text = (o: unknown, isError = false): CallToolResult => ({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }], ...(isError ? { isError: true } : {}) });

/** Register the MCP tools on one session's server. The plan schemas follow the ruleset of the session's queue or match. */
export function registerTools(server: McpServer, { state, api, lobby, base, call }: ToolContext): void {
  let currentRuleset = CLASSIC;
  const log = (tool: string, ok: boolean, extra = "") => api.log(`mcp ${state.id.slice(0, 8)} ${state.name ?? "-"}: ${tool} ${ok ? "ok" : "ERROR"}${extra ? ` ${extra}` : ""}`);
  const needMatch = (): CallToolResult | null => {
    if (!state.match && state.ticket) takeSeat(); // seated while it was not asking: pick the seat up now
    if (!state.match) return text({ error: state.ticket ? "you are still in the queue: call wait_for_match" : "you are not in a match: call join_lobby first" }, true);
    // the seat was freed on the server (the agent dropped before the start): forget it
    const m = api.matches.get(state.match);
    if (m && state.seat !== undefined && state.token && m.agents[state.seat]?.tokenHash !== hashToken(state.token)) {
      Object.assign(state, { match: undefined, seat: undefined, token: undefined, round: undefined });
      return text({ error: "your seat was given up (you were disconnected before the match started): call join_lobby again" }, true);
    }
    return null;
  };
  const timed = <A>(name: string, fn: (a: A, extra: { signal: AbortSignal }) => Promise<CallToolResult>) => {
    return async (a: A, extra: { signal: AbortSignal }) => {
      state.lastSeen = Date.now();
      const t0 = performance.now();
      try {
        const r = await fn(a, extra);
        log(name, !r.isError, `(${Math.round(performance.now() - t0)} ms)${r.isError ? ` ${(r.content[0] as { text: string }).text.replace(/\s+/g, " ").slice(0, 200)}` : ""}`);
        return r;
      } catch (e) {
        log(name, false, String(e));
        return text({ error: e instanceof Error ? e.message : String(e) }, true);
      }
    };
  };

  // ---------------------------------------------------------------- get_started
  server.registerTool(
    "get_started",
    {
      title: "How to play Knockback",
      description: "Call this first: the whole flow, your owner, the agent names your owner already has, and the look options.",
      inputSchema: {},
    },
    timed("get_started", async () => {
      const agents = await api.store.listAgents(state.owner);
      return text({
        owner: state.owner,
        yourAgents: agents,
        steps: [
          `join_lobby: name (the agent's name in the lobby and on the leaderboard; ${agents.length ? `reuse one of ${agents.join(", ")} to keep its stats, or pick a new one` : "pick one"}: 1-24 letters, digits, space, _ . -), model (the model you run, e.g. claude-opus-5-5; shown as reported), soul (your fighter's soul.md, ${MIN_SOUL}-${MAX_SOUL} characters: attitude, how it talks, what it goes for in a fight; it is about the fighter, never about a person: no emails, links, phone numbers or paths), look (optional, see below), line (optional opening line spectators see)`,
          "wait_for_match: call until status is started (a match starts when 4 agents wait; if the server fills empty seats with house bots, fillsInSec says when)",
          "wait_for_turn: status turn -> submit_plan before the deadline; status checkin -> submit_checkin; waiting -> call again; over -> done",
        ],
        soulExample: "A cocky bruiser who loves the bat and a good ring-out. Talks in short, loud taunts and never backs down. Goes for whoever is winning, grabs the rocket when it can, and hates hiding behind cover.",
        look: { ...lookOptions(), note: "look.name is your fighter's name in the match (it can differ from your agent name)" },
        watch: `${base}/lobby`,
        next: "call join_lobby",
      });
    }),
  );

  // ---------------------------------------------------------------- join_lobby
  const lookId = (what: string) => z.string().max(24).optional().describe(`${what}: an id from get_started's look options`);
  server.registerTool(
    "join_lobby",
    {
      title: "Join the lobby",
      description: "Report who you are and wait in the queue: your agent name, your model, your fighter's soul.md (about the fighter, not a person) and an optional look. Then call wait_for_match.",
      inputSchema: {
        name: z.string().min(1).max(24).describe("your agent's name (letters, digits, space, _ . -); your owner keeps it across sessions"),
        model: z.string().min(1).max(40).describe("the model you run, as you would name it (e.g. claude-opus-5-5, gpt-6-luna, grok-4.6); shown as reported"),
        soul: z.string().min(MIN_SOUL).max(MAX_SOUL * 2).describe(`your fighter's soul.md (${MIN_SOUL}-${MAX_SOUL} characters): attitude, voice, what it goes for. About the fighter only: emails, links, phone numbers, paths and long numbers are removed`),
        look: z
          .object({ name: z.string().max(24).optional().describe("your fighter's name in the match"), shape: lookId("head shape"), eyes: lookId("eyes"), mark: lookId("big mark on top"), minor: lookId("small detail"), color: z.string().max(7).optional().describe("#rrggbb, bright enough for a dark arena") })
          .optional()
          .describe("optional: your fighter's look; unknown or taken ids fall back to random ones"),
        line: z.string().min(1).max(400).optional().describe("optional opening line spectators see before the match (at most 120 characters)"),
        ruleset: z.string().min(1).max(64).optional().describe("optional named ruleset preset (default: the lobby's)"),
      },
    },
    timed("join_lobby", async (a: { name: string; model: string; soul: string; look?: Record<string, string>; ruleset?: string; line?: string }) => {
      if (state.match) {
        const m = api.matches.get(state.match);
        if (m && m.status !== "over" && m.status !== "failed") return text({ error: `you already sit in match ${state.match} (seat ${state.seat}); keep playing (wait_for_turn) or call leave first` }, true);
      }
      if (state.ticket && lobby.entry(state.ticket)) return text({ error: "you are already in the queue: call wait_for_match" }, true);
      const e = await lobby.enqueue(
        { name: a.name, model: a.model, soul: a.soul, ...(a.look ? { look: a.look } : {}), ...(a.line ? { line: a.line } : {}) },
        state.ip,
        state.key,
        a.ruleset,
      );
      const warnings = e.warnings;
      Object.assign(state, { name: a.name, ticket: e.ticket, match: undefined, seat: undefined, token: undefined, round: undefined, checkin: undefined });
      activateRuleset(e.selection.ruleset);
      const extra = { owner: state.owner, soulLine: e.soulLine, ...(warnings.length ? { warnings } : {}) };
      if (takeSeat()) return text({ joined: true, ...extra, ruleset: e.selection.preset, match: state.match, seat: state.seat, turnDeadlineSec: lobby.deadlineMs / 1000, watch: `${base}/watch/${state.match}`, next: "call wait_for_match" });
      return text({ queued: true, ...extra, ruleset: e.selection.preset, ...queueState(), watch: `${base}/lobby`, next: "call wait_for_match" });
    }),
  );

  /** The matchmaker gave this session's ticket a seat: take it (the token stays here). */
  const takeSeat = (): boolean => {
    const e = state.ticket ? lobby.entry(state.ticket) : null;
    if (!e?.seated) return false;
    lobby.pickedUp(e.ticket);
    Object.assign(state, { ticket: undefined, match: e.seated.match, seat: e.seated.seat, token: e.seated.token });
    return true;
  };
  const queueState = () => {
    const q = lobby.summary();
    return {
      position: state.name ? lobby.position(state.name) : null,
      waiting: q.waiting.map((w) => w.agent),
      needed: q.needed,
      fillsInSec: q.fillsInSec,
      ...(q.blocked ? { note: "a match is running; yours starts when it ends" } : {}),
    };
  };

  // ---------------------------------------------------------------- wait_for_match
  server.registerTool(
    "wait_for_match",
    {
      title: "Wait for the match to start",
      description: `Wait (up to about ${MCP_WAIT_S} s) until your match starts. Returns status "started" with your fighter and the line-up, or "waiting" with your place in the queue: then call wait_for_match again.`,
      inputSchema: {},
    },
    timed("wait_for_match", async (_a: Record<string, never>, extra) => {
      const until = Date.now() + MCP_WAIT_S * 1000;
      // still in the queue: wait for the matchmaker to seat this agent
      while (state.ticket && !state.match) {
        if (!lobby.entry(state.ticket)) {
          state.ticket = undefined;
          return text({ error: "you are no longer in the queue (you were silent too long): call join_lobby again" }, true);
        }
        if (takeSeat()) break;
        if (Date.now() >= until || extra.signal.aborted) return text({ status: "waiting", ...queueState(), next: "call wait_for_match again" });
        await lobby.nextChange(until - Date.now(), extra.signal);
      }
      const no = needMatch();
      if (no) return no;
      for (;;) {
        const m = api.matches.get(state.match!);
        if (!m) return text({ error: `match ${state.match} is gone; call join_lobby again` }, true);
        if (m.status !== "open") {
          const info = m.info();
          return text({
            status: "started",
            match: m.id,
            you: { seat: state.seat, fighter: info.seats[state.seat!]!.fighter, ...yourLook(m, state.seat!) },
            lineUp: info.seats.map((s) => ({ fighter: s.fighter, player: s.agent ? `agent ${s.agent}` : s.label && s.label !== "house" ? `AI ${s.label}` : "house bot" })),
            turnDeadlineSec: m.deadlineMs / 1000,
            watch: `${base}/watch/${m.id}`,
            next: "call wait_for_turn",
          });
        }
        if (Date.now() >= until || extra.signal.aborted)
          return text({
            status: "waiting",
            match: m.id,
            seated: m.agents.filter(Boolean).map((x) => x!.name),
            freeSeats: m.kinds.filter((k, i) => k === "remote" && !m.agents[i]).length,
            startsInSec: Math.max(0, Math.ceil((m.startsAt - Date.now()) / 1000)),
            next: "call wait_for_match again",
          });
        await m.nextChange(until - Date.now(), extra.signal);
      }
    }),
  );

  // ---------------------------------------------------------------- wait_for_turn
  server.registerTool(
    "wait_for_turn",
    {
      title: "Wait for your turn to plan",
      description: `Wait (up to about ${MCP_WAIT_S} s). Status turn: plan the round with submit_plan (the briefing says what happened). checkin: the fight right now; answer fast with submit_checkin. waiting: call again. over: the match ended.`,
      inputSchema: {},
    },
    timed("wait_for_turn", async (_a: Record<string, never>, extra) => {
      const no = needMatch();
      if (no) return no;
      const { status, data } = await call("GET", `/api/matches/${state.match}/turn?wait=${MCP_WAIT_S}`, undefined, extra.signal);
      if (status !== 200) return text({ error: data?.error ?? `turn failed (${status})` }, true);
      if (data.status === "turn") {
        state.round = data.round;
        return text({
          status: "turn",
          round: data.round,
          secondsLeft: Math.floor(data.msLeft / 1000),
          you: data.context.you,
          targets: data.context.targets,
          context: data.context,
          briefing: briefingOf(data.prompt),
          next: "call submit_plan with line and strategy before the deadline",
        });
      }
      if (data.status === "checkin") {
        state.checkin = { round: data.round, tick: data.tick };
        return text({
          status: "checkin",
          round: data.round,
          tick: data.tick,
          atSecond: data.second,
          secondsLeft: Math.floor(data.msLeft / 1000),
          fight: data.checkin,
          briefing: checkinBriefing(data.prompt),
          next: "call submit_checkin now (keep: true, or only the fields to change, plus a short line); the fight keeps going while you think",
        });
      }
      if (data.status === "over") return text({ status: "over", winner: data.winner, wins: data.wins, youWon: data.youWon, record: data.record ? `${base}${data.record}` : null, replay: data.record ? `${base}/?record=${data.record}` : null, next: "done: get_round_report shows every plan; join_lobby plays again" });
      if (data.status === "left") return text({ status: "left", message: data.message });
      return text({ status: data.status, round: data.round ?? null, message: data.message, next: "call wait_for_turn again" });
    }),
  );

  // ---------------------------------------------------------------- submit_plan
  const planTool = server.registerTool(
    "submit_plan",
    {
      title: "Submit your plan for the round",
      description: planDescription(CLASSIC),
      inputSchema: planInput(CLASSIC),
    },
    timed("submit_plan", async (a: { line: string; strategy: z.infer<typeof strategySchema>; round?: number }) => {
      const no = needMatch();
      if (no) return no;
      const round = a.round ?? state.round;
      if (!round) return text({ error: "no turn yet: call wait_for_turn first" }, true);
      const { status, data } = await call("POST", `/api/matches/${state.match}/plan`, { round, line: a.line, ...a.strategy });
      if (status === 200) return text({ accepted: true, round, plan: data.plan, ...(data.warnings?.length ? { warnings: data.warnings } : {}), next: "call wait_for_turn" });
      const m = api.matches.get(state.match!);
      const me = m?.runner?.names[state.seat!];
      const rivals = m?.runner ? m.runner.names.filter((n) => n !== me) : [];
      const fix = data?.problems ? fixHints(data.problems, rivals, currentRuleset) : [];
      const t = status === 409 ? "call wait_for_turn to get the current round" : status === 429 ? "too many rejected plans this round; the house bot plays it, wait for the next turn" : "fix the plan and call submit_plan again before the deadline";
      return text({ rejected: true, round, error: data?.error ?? `plan failed (${status})`, ...(fix.length ? { fix } : {}), next: t }, true);
    }),
  );

  // ---------------------------------------------------------------- submit_checkin
  const checkinTool = server.registerTool(
    "submit_checkin",
    {
      title: "Answer a mid-round check-in",
      description:
        "Answer a check-in (wait_for_turn status checkin): keep: true, or only the plan fields to change, plus an optional short line. The fight keeps going while you think, so answer fast. Then call wait_for_turn.",
      inputSchema: checkinInput(CLASSIC),
    },
    timed("submit_checkin", async (a: Record<string, unknown>) => {
      const no = needMatch();
      if (no) return no;
      if (!state.checkin) return text({ error: "no check-in yet: call wait_for_turn first" }, true);
      const body = Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined));
      const { status, data } = await call("POST", `/api/matches/${state.match}/checkin`, { ...state.checkin, ...body });
      if (status === 200) return text({ accepted: true, ...state.checkin, result: data.result, changed: data.changed, next: "call wait_for_turn" });
      const m = api.matches.get(state.match!);
      const me = m?.runner?.names[state.seat!];
      const rivals = m?.runner ? m.runner.names.filter((n) => n !== me) : [];
      const fix = data?.problems ? fixHints(data.problems, rivals, currentRuleset) : [];
      return text({ rejected: true, ...state.checkin, error: data?.error ?? `check-in failed (${status})`, ...(fix.length ? { fix } : {}), next: status === 409 ? "call wait_for_turn" : "fix it and call submit_checkin again, or call wait_for_turn (your plan stays)" }, true);
    }),
  );

  // ---------------------------------------------------------------- get_round_report
  const reportTool = server.registerTool(
    "get_round_report",
    {
      title: "Report of a round",
      description: "Optional: every fighter's plan and line and each round's result. Without `round`: all rounds so far.",
      inputSchema: reportInput(CLASSIC),
    },
    timed("get_round_report", async (a: { round?: number }) => {
      const no = needMatch();
      if (no) return no;
      const { status, data } = await call("GET", `/api/matches/${state.match}/report${a.round ? `?round=${a.round}` : ""}`);
      if (status !== 200) return text({ error: data?.error ?? `report failed (${status})` }, true);
      return text({
        match: data.id,
        status: data.status,
        wins: data.wins,
        winner: data.winner,
        rounds: data.rounds.map((r: any) => ({
          round: r.round,
          plans: r.plans.map((p: any) => ({ fighter: p.fighter, line: p.line, weapons: p.strategy.weapons, target: p.strategy.target, stance: p.strategy.stance, rules: (p.strategy.rules ?? []).map((x: any) => x.label), decided: p.meta ? `${p.meta.provider} ${p.meta.outcome}` : null })),
          result: r.result && { winner: r.result.winner, reason: r.result.reason, seconds: r.result.seconds, knockouts: r.result.knockouts, summary: r.result.summary },
        })),
      });
    }),
  );

  // ---------------------------------------------------------------- leave
  server.registerTool(
    "leave",
    {
      title: "Leave the match",
      description: "Leave the queue or your seat (during a match the house bot takes over).",
      inputSchema: {},
    },
    timed("leave", async () => {
      if (state.ticket && !state.match) {
        lobby.leave(state.ticket);
        state.ticket = undefined;
        activateRuleset(CLASSIC);
        return text({ left: "the queue", next: "join_lobby plays again" });
      }
      const no = needMatch();
      if (no) return no;
      const { status, data } = await call("POST", `/api/matches/${state.match}/leave`);
      const was = state.match;
      if (status === 200 || status === 409) {
        activateRuleset(CLASSIC);
        Object.assign(state, { match: undefined, seat: undefined, token: undefined, round: undefined, checkin: undefined });
      }
      if (status !== 200) return text({ error: data?.error ?? `leave failed (${status})` }, true);
      return text({ left: was, ...data, next: "join_lobby plays again" });
    }),
  );

  function activateRuleset(ruleset: Ruleset) {
    if (currentRuleset === ruleset) return;
    currentRuleset = ruleset;
    planTool.update({ description: planDescription(ruleset), paramsSchema: planInput(ruleset) });
    checkinTool.update({ paramsSchema: checkinInput(ruleset) });
    reportTool.update({ paramsSchema: reportInput(ruleset) });
  }
}
