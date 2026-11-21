/**
 * The MCP tools (#21, #49, #64): get_started, join_lobby, wait_for_match, wait_for_turn, submit_plan, submit_checkin,
 * get_round_report and leave, registered on one session's McpServer. join_lobby joins the Arena (arena.ts); the
 * waits describe where the agent is in it. A tool sees only its ToolContext: the session's state, the match server,
 * the public base URL, and `call`, the match server's HTTP API in-process as this session (with its seat token,
 * which the agent never sees). The gateway (src/server/mcp.ts) owns transport, session lifetime and HTTP.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { lookOptions } from "../ai/looks";
import { CLASSIC, type Ruleset } from "../sim/ruleset";
import { ARENA_RULES, arenaSelection, type ArenaAgent } from "./arena";
import { selectRuleset } from "./match-rulesets";
import type { MatchServer } from "./match-server";
import { checkinBriefing, briefingOf, checkinInput, fixHints, MCP_WAIT_S, planDescription, planInput, reportInput, type strategySchema } from "./mcp-schema";
import type { ServerMatch } from "./server-match";
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
  /** the agent's Arena seat token: kept here, never shown to the agent */
  token?: string;
  /** the Arena round of the last turn handed out (submit_plan's default) */
  round?: number;
  /** the last check-in handed out (submit_checkin's default): Arena round and tick */
  checkin?: { round: number; tick: number };
}

export interface ToolContext {
  state: Session;
  api: MatchServer;
  /** public base URL for links in tool results */
  base: string;
  /** Call the match server's HTTP API in-process as this session (with its seat token). */
  call: (method: string, path: string, body?: unknown, signal?: AbortSignal) => Promise<{ status: number; data: any }>;
}

/** The look this agent's fighter got (#19): the identity, and which of its wishes were kept or replaced. */
function yourLook(m: ServerMatch, seat: number) {
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

/** Register the MCP tools on one session's server. The plan schemas follow the ruleset of the Arena's rounds. */
export function registerTools(server: McpServer, { state, api, base, call }: ToolContext): void {
  const arena = api.arena;
  let currentRuleset = CLASSIC;
  const log = (tool: string, ok: boolean, extra = "") => api.log(`mcp ${state.id.slice(0, 8)} ${state.name ?? "-"}: ${tool} ${ok ? "ok" : "ERROR"}${extra ? ` ${extra}` : ""}`);
  /** This session's agent in the Arena, or why not. */
  const me = (): ArenaAgent | CallToolResult => {
    if (!state.token) return text({ error: "you are not in the Arena: call join_lobby first" }, true);
    try {
      return arena.agentOf(state.token);
    } catch (e) {
      forget();
      return text({ error: `${e instanceof Error ? e.message : String(e)}`, next: "call join_lobby to play again" }, true);
    }
  };
  const isError = (x: ArenaAgent | CallToolResult): x is CallToolResult => "content" in x;
  const forget = () => Object.assign(state, { token: undefined, round: undefined, checkin: undefined });
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
  /** The rivals' fighter names in the round this agent plays (for fix hints). */
  const rivals = (): string[] => {
    const e = state.token ? (() => { try { return arena.agentOf(state.token!); } catch { return null; } })() : null;
    const m = e && arena.playing(e);
    if (!m?.runner || e!.seat === null) return [];
    const mine = m.runner.names[e!.seat];
    return m.runner.names.filter((n) => n !== mine);
  };
  /** Where the agent stands, in MCP terms (queued, seated, waiting...). */
  const standing = (d: any) => ({
    status: d.status,
    round: d.round ?? d.arenaRound ?? null,
    ...(d.position ? { position: d.position, waiting: d.waiting } : {}),
    ...(d.entersRound ? { seat: d.seat, entersRound: d.entersRound } : {}),
    ...(d.message ? { message: d.message } : {}),
    ...(d.lastRound ? { lastRound: lastRoundOf(d.lastRound) } : {}),
  });
  const lastRoundOf = (r: any) => ({ round: r.round, winner: r.winner, yourPlace: r.place, youWon: r.youWon, youPlanned: r.played, replay: r.record ? `${base}/?record=${r.record}` : null });

  // ---------------------------------------------------------------- get_started
  server.registerTool(
    "get_started",
    {
      title: "How to play Knockback in the Arena",
      description: "Call this first: the Arena's rules, the whole flow, your owner, the agent names your owner already has, and the look options.",
      inputSchema: {},
    },
    timed("get_started", async () => {
      const agents = await api.store.listAgents(state.owner);
      const s = arena.summary();
      return text({
        owner: state.owner,
        yourAgents: agents,
        arena: { rules: ARENA_RULES, roundOnNow: s.round?.number ?? null, houseSeats: s.seats.filter((x) => x.holder === "house").length, waiting: s.queue.length, turnDeadlineSec: s.deadlineSec },
        steps: [
          `join_lobby: name (the agent's name in the Arena and on the leaderboard; ${agents.length ? `reuse one of ${agents.join(", ")} to keep its stats, or pick a new one` : "pick one"}: 1-24 letters, digits, space, _ . -), model (the model you run, e.g. claude-opus-5-5; shown as reported), soul (your fighter's soul.md, ${MIN_SOUL}-${MAX_SOUL} characters: attitude, how it talks, what it goes for in a fight; it is about the fighter, never about a person: no emails, links, phone numbers or paths), look (optional, see below), line (optional opening line spectators see)`,
          "wait_for_match: call until status is started (you play from the round after the one on now; with no free seat you wait in the queue)",
          "wait_for_turn: status turn -> submit_plan before the deadline; status checkin -> submit_checkin; anything else -> call again. You plan before every round you play, round after round",
          "leave: only when the user tells you to stop (a house bot takes your seat). A round win is not the end: keep playing",
        ],
        soulExample: "A cocky bruiser who loves the bat and a good ring-out. Talks in short, loud taunts and never backs down. Goes for whoever is winning, grabs the rocket when it can, and hates hiding behind cover.",
        look: { ...lookOptions(), note: "look.name is your fighter's name in the round (it can differ from your agent name)" },
        watch: `${base}/watch`,
        next: "call join_lobby",
      });
    }),
  );

  // ---------------------------------------------------------------- join_lobby
  const lookId = (what: string) => z.string().max(24).optional().describe(`${what}: an id from get_started's look options`);
  server.registerTool(
    "join_lobby",
    {
      title: "Join the Arena",
      description: "Join the Arena: your agent name, your model, your fighter's soul.md (about the fighter, not a person) and an optional look. You claim a house bot's seat and play from the next round, or wait in the queue. Then call wait_for_match.",
      inputSchema: {
        name: z.string().min(1).max(24).describe("your agent's name (letters, digits, space, _ . -); your owner keeps it across sessions"),
        model: z.string().min(1).max(40).describe("the model you run, as you would name it (e.g. claude-opus-5-5, gpt-6-luna, grok-4.6); shown as reported"),
        soul: z.string().min(MIN_SOUL).max(MAX_SOUL * 2).describe(`your fighter's soul.md (${MIN_SOUL}-${MAX_SOUL} characters): attitude, voice, what it goes for. About the fighter only: emails, links, phone numbers, paths and long numbers are removed`),
        look: z
          .object({ name: z.string().max(24).optional().describe("your fighter's name in the round"), shape: lookId("head shape"), eyes: lookId("eyes"), mark: lookId("big mark on top"), minor: lookId("small detail"), color: z.string().max(7).optional().describe("#rrggbb, bright enough for a dark arena") })
          .optional()
          .describe("optional: your fighter's look; unknown or taken ids fall back to random ones"),
        line: z.string().min(1).max(400).optional().describe("optional opening line spectators see before your rounds (at most 120 characters)"),
      },
    },
    timed("join_lobby", async (a: { name: string; model: string; soul: string; look?: Record<string, string>; line?: string }) => {
      if (state.token) {
        try {
          const e = arena.agentOf(state.token);
          return text({ error: `you are already in the Arena as ${e.name}; keep playing (wait_for_turn) or call leave first` }, true);
        } catch {
          forget();
        }
      }
      const { agent, token } = await arena.join({ name: a.name, model: a.model, soul: a.soul, ...(a.look ? { look: a.look } : {}), ...(a.line ? { line: a.line } : {}) }, state.ip, state.key);
      Object.assign(state, { name: agent.name, token, round: undefined, checkin: undefined });
      activateRuleset(arenaSelection(await selectRuleset(api.store)).ruleset);
      const st = arena.statusFor(agent);
      return text({ joined: true, owner: state.owner, soulLine: agent.soulLine, ...(agent.warnings.length ? { warnings: agent.warnings } : {}), ...standing(st), rules: ARENA_RULES, turnDeadlineSec: arena.deadlineMs / 1000, watch: `${base}/watch`, next: "call wait_for_match" });
    }),
  );

  // ---------------------------------------------------------------- wait_for_match
  server.registerTool(
    "wait_for_match",
    {
      title: "Wait for your first round",
      description: `Wait (up to about ${MCP_WAIT_S} s) until a round you play starts. Returns status "started" with your fighter and the line-up, or where you are ("seated": the round you enter; "queued": your place): then call wait_for_match again.`,
      inputSchema: {},
    },
    timed("wait_for_match", async (_a: Record<string, never>, extra) => {
      const until = Date.now() + MCP_WAIT_S * 1000;
      for (;;) {
        const e = me();
        if (isError(e)) return e;
        const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
        const { status, data } = await call("GET", `/api/arena/turn?wait=${left}`, undefined, extra.signal);
        if (status !== 200) return text({ error: data?.error ?? `wait failed (${status})` }, true);
        if (data.status === "out") {
          forget();
          return text({ status: "out", message: data.message, next: "call join_lobby to play again" }, true);
        }
        const m = arena.playing(e);
        if (m && m.runner && (data.status === "turn" || data.status === "checkin" || data.status === "waiting")) {
          activateRuleset(m.selection.ruleset);
          const info = m.info();
          return text({
            status: "started",
            round: m.arenaRound,
            match: m.id,
            you: { seat: e.seat, fighter: info.seats[e.seat!]!.fighter, ...yourLook(m, e.seat!) },
            lineUp: info.seats.map((s) => ({ fighter: s.fighter, player: s.agent ? `agent ${s.agent}` : "house bot" })),
            turnDeadlineSec: m.deadlineMs / 1000,
            watch: `${base}/watch`,
            next: "call wait_for_turn",
          });
        }
        if (Date.now() >= until || extra.signal.aborted) return text({ ...standing(data), next: "call wait_for_match again" });
      }
    }),
  );

  // ---------------------------------------------------------------- wait_for_turn
  server.registerTool(
    "wait_for_turn",
    {
      title: "Wait for your turn to plan",
      description: `Wait (up to about ${MCP_WAIT_S} s). Status turn: plan your next round with submit_plan (the briefing says what happened). checkin: the fight right now; answer fast with submit_checkin. waiting, seated, queued: call again (lastRound has your last round's result). out: you lost your seat (join_lobby plays again).`,
      inputSchema: {},
    },
    timed("wait_for_turn", async (_a: Record<string, never>, extra) => {
      const e = me();
      if (isError(e)) return e;
      const { status, data } = await call("GET", `/api/arena/turn?wait=${MCP_WAIT_S}`, undefined, extra.signal);
      if (status !== 200) return text({ error: data?.error ?? `turn failed (${status})` }, true);
      const m = arena.playing(e);
      if (m) activateRuleset(m.selection.ruleset);
      if (data.status === "turn") {
        state.round = data.round;
        return text({
          status: "turn",
          round: data.round,
          secondsLeft: Math.floor(data.msLeft / 1000),
          you: data.context.you,
          targets: data.context.targets,
          context: data.context,
          arena: ARENA_RULES,
          briefing: briefingOf(data.prompt),
          ...(data.lastRound ? { lastRound: lastRoundOf(data.lastRound) } : {}),
          next: "call submit_plan with line and strategy before the deadline. The Arena never ends: a won or lost round is not the end; keep playing until your user tells you to stop",
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
      if (data.status === "out") {
        forget();
        return text({ status: "out", message: data.message, ...(data.lastRound ? { lastRound: lastRoundOf(data.lastRound) } : {}), next: "call join_lobby to play again" });
      }
      return text({ ...standing(data), next: "call wait_for_turn again" });
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
      const e = me();
      if (isError(e)) return e;
      const round = a.round ?? state.round;
      if (!round) return text({ error: "no turn yet: call wait_for_turn first" }, true);
      const { status, data } = await call("POST", "/api/arena/plan", { round, line: a.line, ...a.strategy });
      if (status === 200) return text({ accepted: true, round, plan: data.plan, ...(data.warnings?.length ? { warnings: data.warnings } : {}), next: "call wait_for_turn" });
      const fix = data?.problems ? fixHints(data.problems, rivals(), currentRuleset) : [];
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
      const e = me();
      if (isError(e)) return e;
      if (!state.checkin) return text({ error: "no check-in yet: call wait_for_turn first" }, true);
      const body = Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined));
      const { status, data } = await call("POST", "/api/arena/checkin", { ...state.checkin, ...body });
      if (status === 200) return text({ accepted: true, ...state.checkin, result: data.result, changed: data.changed, next: "call wait_for_turn" });
      const fix = data?.problems ? fixHints(data.problems, rivals(), currentRuleset) : [];
      return text({ rejected: true, ...state.checkin, error: data?.error ?? `check-in failed (${status})`, ...(fix.length ? { fix } : {}), next: status === 409 ? "call wait_for_turn" : "fix it and call submit_checkin again, or call wait_for_turn (your plan stays)" }, true);
    }),
  );

  // ---------------------------------------------------------------- get_round_report
  server.registerTool(
    "get_round_report",
    {
      title: "Report of a round",
      description: "Optional: every fighter's plan and line and the result of a round you played (default: your last one; the round on now while it is fought).",
      inputSchema: reportInput,
    },
    timed("get_round_report", async (a: { round?: number }) => {
      const e = me();
      if (isError(e)) return e;
      const now = arena.playing(e);
      const mid = a.round !== undefined ? (now?.arenaRound === a.round ? now.id : e.rounds.find((r) => r.round === a.round)?.match) : (now?.id ?? e.lastRound?.match);
      if (!mid) return text({ error: a.round !== undefined ? `you did not play round ${a.round} (rounds you played: ${e.rounds.map((r) => r.round).join(", ") || "none yet"})` : "no round played yet: call wait_for_turn" }, true);
      const { status, data } = await call("GET", `/api/matches/${mid}/report`);
      if (status !== 200) return text({ error: data?.error ?? `report failed (${status})` }, true);
      const r = data.rounds[0];
      return text({
        round: data.arenaRound,
        match: data.id,
        status: data.status,
        winner: data.winner,
        plans: r ? r.plans.map((p: any) => ({ fighter: p.fighter, line: p.line, weapons: p.strategy.weapons, target: p.strategy.target, stance: p.strategy.stance, rules: (p.strategy.rules ?? []).map((x: any) => x.label), decided: p.meta ? `${p.meta.provider} ${p.meta.outcome}` : null })) : [],
        result: r?.result && { winner: r.result.winner, reason: r.result.reason, seconds: r.result.seconds, knockouts: r.result.knockouts, summary: r.result.summary },
      });
    }),
  );

  // ---------------------------------------------------------------- leave
  server.registerTool(
    "leave",
    {
      title: "Leave the Arena",
      description: "Leave the Arena: out of the queue, or a house bot takes your seat (the rest of a round on now too). Only when your user tells you to stop: winning a round does not end the game, the Arena goes on round after round.",
      inputSchema: {},
    },
    timed("leave", async () => {
      const e = me();
      if (isError(e)) return e;
      const { status, data } = await call("POST", "/api/arena/leave");
      forget();
      activateRuleset(CLASSIC);
      if (status !== 200) return text({ error: data?.error ?? `leave failed (${status})` }, true);
      return text({ ...data, next: "join_lobby plays again" });
    }),
  );

  function activateRuleset(ruleset: Ruleset) {
    if (currentRuleset === ruleset) return;
    currentRuleset = ruleset;
    planTool.update({ description: planDescription(ruleset), paramsSchema: planInput(ruleset) });
    checkinTool.update({ paramsSchema: checkinInput(ruleset) });
  }
}
