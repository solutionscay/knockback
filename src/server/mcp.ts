import { CLASSIC, enabledItems, type Ruleset } from "../sim/ruleset";
/**
 * MCP server for the match server (#21): any MCP-capable agent (Claude Code,
 * Codex, Grok, custom) joins and fights with seven tools (submit_checkin
 * answers the mid-round check-ins of #9 when the server runs them). Each agent thinks with
 * its own model; the server makes no AI calls.
 *
 * Transport: Streamable HTTP (the SDK's web-standard transport), mounted on
 * the match server at /mcp; scripts/mcp-stdio.ts bridges stdio clients to it.
 *
 * Sessions: one McpServer per MCP session. The session holds the agent's
 * match, seat and seat token, so the agent never handles the token: every
 * tool calls the match server's own HTTP API in-process with that token, and
 * gets its validation, rate limits, deadlines and house-bot fallback exactly
 * as an HTTP agent does.
 *
 * Plan format: the tool input schemas and descriptions are built from the
 * constants the plan parser uses (src/sim/rules.ts, src/sim/sim-types.ts,
 * src/ai/parse.ts), so they cannot drift from what the server accepts.
 */
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { MAX_LINE, MAX_WHY } from "../ai/parse";
import { enabledRuleExamples, weaponHelp } from "../ai/prompt";
import { MAX_RULE_LABEL, RULE_RETALIATE, RULE_STANCES, RULE_VALUE, WHO_TRIGGERS } from "../sim/rules";
import { MAX_RULES, RULE_DO, RULE_WHEN } from "../sim/sim-types";
import { HttpError, RateLimiter } from "./limits";
import { McpAdmission } from "./mcp-admission";
import type { Matchmaker } from "./matchmaker";
import type { MatchServer } from "./match-server";
import { hashToken, MAX_PERSONA, MIN_PERSONA } from "./match-server";
import { TARGET_CHOICES } from "./remote";
import { CHECKIN } from "../ai/checkin";

/** a wait_for_* call returns within this long; the agent calls again */
export const MCP_WAIT_S = 25;

interface Session {
  id: string;
  ip: string;
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

interface Live {
  state: Session;
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
}

export interface McpOptions {
  /** the lobby queue (#22): join_lobby waits here until the matchmaker seats the agent */
  lobby: Matchmaker;
  /** public base URL for links in tool results (e.g. https://kb.example.com); default: from the request */
  publicUrl?: string;
  maxSessions?: number;
  /** Concurrent HTTP requests, including open SSE responses. */
  maxInFlight?: number;
  maxInFlightPerIp?: number;
  maxInFlightPerSession?: number;
  /** sessions idle this long are closed (default 30 min) */
  idleMs?: number;
}

// ------------------------------------------------------------------ schema (from the parser's constants)
const weaponsList = (ruleset: Ruleset) => Object.entries(weaponHelp(ruleset)).map(([w, help]) => `${w} (${help})`).join(", ");
const valueRanges = Object.entries(RULE_VALUE)
  .map(([k, [lo, hi]]) => `${k} ${lo}-${hi}`)
  .join(", ");

function buildRuleSchema(ruleset: Ruleset) {
  const pickups = enabledItems(ruleset);
  return z
    .object({
      when: z.enum(RULE_WHEN as unknown as [string, ...string[]]).describe("the trigger the engine checks during the round"),
      who: z.string().max(24).optional().describe(`whom the trigger is about (for ${WHO_TRIGGERS.join(", ")}): anyone | enemy | target | a rival's name`),
      value: z.number().optional().describe(`a threshold for: ${valueRanges}`),
      item: z.enum(pickups as [string, ...string[]]).optional().describe("for when=holds/item_near: the trigger's item; otherwise the action's item (seek, use)"),
      do: z.enum(RULE_DO as unknown as [string, ...string[]]).describe("the action while the trigger holds"),
      do_item: z.enum(pickups as [string, ...string[]]).optional().describe("the action's item when `item` already names the trigger's item"),
      stance: z.enum(RULE_STANCES as unknown as [string, ...string[]]).optional().describe("for do=stance"),
      retaliate: z.enum(RULE_RETALIATE as unknown as [string, ...string[]]).optional().describe("for do=retaliate"),
      label: z.string().max(MAX_RULE_LABEL).optional().describe(`a short name shown in the viewer (at most ${MAX_RULE_LABEL} characters)`),
    })
    .describe("a conditional rule");
}
export const ruleSchema = buildRuleSchema(CLASSIC);

function buildStrategySchema(ruleset: Ruleset) {
  return z.object({
    weapons: z
      .array(z.enum(ruleset.weapons.enabled as readonly [string, ...string[]]))
      .min(1)
      .max(3)
      .describe(`1 to 3 different pickups to go for and use, best first: ${weaponsList(ruleset)}. Everyone starts with fists.`),
    target: z.string().max(24).describe(`a rival's name, or one of ${TARGET_CHOICES.join(" | ")}`),
    stance: z.enum(RULE_STANCES as unknown as [string, ...string[]]).describe("rush (close in) | distance (keep range) | cover (stay behind cover) | item (detour for every pickup)"),
    retaliate: z
      .enum(RULE_RETALIATE as unknown as [string, ...string[]])
      .optional()
      .describe("when a fighter you are not chasing hits you from behind 3 times: attacker (chase them 10 s) | turn (fight back 3 s; default) | ignore"),
    rules: z.array(buildRuleSchema(ruleset)).max(MAX_RULES).optional().describe(`0 to ${MAX_RULES} conditional rules, first = highest priority`),
    why: z.string().max(400).optional().describe(`optional: one sentence in game terms, why this plan (kept to ${MAX_WHY} characters)`),
  });
}
export const strategySchema = buildStrategySchema(CLASSIC);

const PLAN_EXAMPLE = {
  line: "Batter up. Somebody's leaving through the window.",
  strategy: { weapons: ["bat", "grapple"] as const, target: "leader", stance: "rush", retaliate: "attacker", why: "use the terrain to win ring-outs" },
};

function planHelp(ruleset: Ruleset) {
  const examples = enabledRuleExamples(ruleset);
  const weapons = PLAN_EXAMPLE.strategy.weapons.filter(w => ruleset.weapons.enabled.includes(w));
  const example = { ...PLAN_EXAMPLE, strategy: { ...PLAN_EXAMPLE.strategy, weapons: weapons.length ? weapons : [ruleset.weapons.enabled[0]!], rules: examples.slice(0, 2).map(e => JSON.parse(e)) } };
  return [
    "THE PLAN (you only plan; the engine moves, picks up, aims and shoots for your fighter):",
    `- weapons: 1-3 different pickups, best first: ${weaponsList(ruleset)}.`,
    `- target: a rival's name, or ${TARGET_CHOICES.join(" | ")}. Never yourself.`,
    `- stance: ${RULE_STANCES.join(" | ")}. retaliate (optional): ${RULE_RETALIATE.join(" | ")}.`,
    `- rules (optional, at most ${MAX_RULES}, first wins): {when, who?, value?, item?, do, do_item?, stance?, retaliate?, label?}. when: ${RULE_WHEN.join(", ")}. do: ${RULE_DO.join(", ")}. value ranges: ${valueRanges}. Items: ${enabledItems(ruleset).join(", ")}.`,
    `  Rule examples: ${examples.slice(0, 4).join(" ")}`,
    `- line: what your fighter says out loud, one in-character sentence (at most ${MAX_LINE} characters). Lines must match the facts of the last round.`,
    `Example call: submit_plan(${JSON.stringify(example)})`,
  ].join("\n");
}

const FLOW =
  "Flow: join_lobby once (you wait in the queue: a match starts when 4 agents wait, or after a short wait with built-in AI fighters in the empty seats), then wait_for_match until it says the match started, then repeat wait_for_turn -> submit_plan until wait_for_turn says the match is over. " +
  `Every wait_* call returns within about ${MCP_WAIT_S} s; when it says to call again, call it again right away. ` +
  "Each round has a deadline (shown in the turn); without a valid plan in time the house bot plays your fighter for that round. " +
  "If the server runs mid-round check-ins, wait_for_turn also returns status \"checkin\" during a round (about every 10 s of fight): the fight status at that moment; answer with submit_checkin (keep, or change only some plan fields). The fight does not pause: the check-in waits for your answer and your change applies when it arrives, so a slow answer applies late; while it is open you get no new check-in.";

// ------------------------------------------------------------------ helpers
const text = (o: unknown, isError = false): CallToolResult => ({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }], ...(isError ? { isError: true } : {}) });

/** The rendered round prompt, with its final "Reply ONLY with JSON" paragraph replaced by how to submit through MCP. */
export function briefingOf(prompt: string): string {
  return prompt
    .split("\n\n")
    .map((p) => (p.startsWith("Reply ONLY with JSON") ? "SUBMIT: call submit_plan with `line` (what you say) and `strategy` {weapons, target, stance, retaliate?, rules?, why?}." : p))
    .join("\n\n");
}

/** The check-in prompt, with its final "Reply ONLY with JSON" line replaced by how to answer through MCP. */
export function checkinBriefing(prompt: string): string {
  return prompt
    .split("\n")
    .map((l) => (l.startsWith("Reply ONLY with JSON") ? "ANSWER: call submit_checkin with keep: true, or only the fields to change (e.g. target, stance) and a short line." : l))
    .join("\n");
}

/** Problems from the server (422/400) turned into instructions to fix the plan. */
export function fixHints(problems: string[], rivals: string[], ruleset: Ruleset = CLASSIC): string[] {
  return problems.map((p) => {
    const m = /^bad value: (\w+) (.*)$/.exec(p);
    if (m) {
      const [, key, got] = m as unknown as [string, string, string];
      if (key === "target") return `target ${got} is not valid: use a rival's name (${rivals.join(", ") || "see the turn"}) or ${TARGET_CHOICES.join(" | ")}; never your own name.`;
      if (key === "weapons") return `weapons ${got} is not valid: 1 to 3 *different* weapons from ${ruleset.weapons.enabled.join(", ")}.`;
      if (key === "stance") return `stance ${got} is not valid: one of ${RULE_STANCES.join(", ")}.`;
      if (key === "retaliate") return `retaliate ${got} is not valid: one of ${RULE_RETALIATE.join(", ")}, or leave it out.`;
      return p;
    }
    if (p.startsWith("line")) return `line is missing: add one short in-character sentence (at most ${MAX_LINE} characters).`;
    if (/^rule \d/.test(p)) return `${p}. Fix or drop that rule (rules are optional). Shape: {when, who?, value?, item?, do, do_item?, stance?, retaliate?, label?}; e.g. ${enabledRuleExamples(ruleset)[0]}`;
    return p;
  });
}

// ------------------------------------------------------------------ the gateway
export class McpGateway {
  readonly sessions = new Map<string, Live>();
  readonly initLimit = new RateLimiter(10, 1 / 6);
  readonly requestLimit = new RateLimiter(60, 10);
  readonly sessionLimit = new RateLimiter(30, 5);
  private readonly admission: McpAdmission;
  private initializing = 0;
  private sweeper: ReturnType<typeof setInterval>;
  readonly maxSessions: number;
  readonly idleMs: number;

  constructor(
    readonly api: MatchServer,
    readonly opts: McpOptions,
  ) {
    this.admission = new McpAdmission(opts.maxInFlight, opts.maxInFlightPerIp, opts.maxInFlightPerSession);
    this.maxSessions = opts.maxSessions ?? 200;
    this.idleMs = opts.idleMs ?? 30 * 60_000;
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  close() {
    clearInterval(this.sweeper);
    for (const id of [...this.sessions.keys()]) void this.drop(id);
  }

  private async drop(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    this.handOver(s.state, "session expired");
    await s.transport.close().catch(() => undefined);
  }

  /** The session is gone for good: the house bot takes its fighter (#22). */
  private handOver(state: Session, reason: string) {
    if (state.ticket) this.opts.lobby.leave(state.ticket);
    if (state.match === undefined || state.seat === undefined || !state.token) return;
    // only this session's own agent: the seat may have been freed and taken by someone else
    this.api.matches.get(state.match)?.takeover(state.seat, reason, undefined, hashToken(state.token));
  }

  private sweep(now = Date.now()) {
    for (const [id, s] of this.sessions) if (now - s.state.lastSeen > this.idleMs) void this.drop(id);
  }

  /** Handle a request to /mcp. `ip` keys the rate limits. */
  async handle(req: Request, ip = "local"): Promise<Response> {
    // DNS-rebinding guard: a browser page from another origin must not drive a local agent's session
    const origin = req.headers.get("origin");
    if (origin) {
      try {
        if (new URL(origin).host !== new URL(req.url).host) return Response.json({ jsonrpc: "2.0", error: { code: -32000, message: "cross-origin requests are not allowed" }, id: null }, { status: 403 });
      } catch {
        return new Response("bad origin", { status: 400 });
      }
    }
    try {
      this.requestLimit.take(ip, "MCP requests");
      const sid = req.headers.get("mcp-session-id");
      if (sid && this.sessions.has(sid)) this.sessionLimit.take(sid, "MCP session requests");
      return await this.admission.run(req, ip, () => this.route(req, ip));
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      return Response.json({ jsonrpc: "2.0", error: { code: -32000, message: e.message }, id: null }, { status: e.status, headers: e.headers });
    }
  }

  private async route(req: Request, ip: string): Promise<Response> {
    const sid = req.headers.get("mcp-session-id");
    if (sid) {
      const live = this.sessions.get(sid);
      if (!live)
        return Response.json(
          { jsonrpc: "2.0", error: { code: -32001, message: "MCP session not found (expired or the server restarted): reconnect and call join_lobby again" }, id: null },
          { status: 404 },
        );
      live.state.lastSeen = Date.now();
      // a tool call whose connection drops (the agent's process died, the network went) is a disconnect (#22);
      // the seat goes on autopilot unless the session sends something again within the grace period
      if (req.method === "POST" && live.state.match !== undefined && live.state.seat !== undefined && live.state.token) {
        const { match, seat } = live.state;
        const expect = hashToken(live.state.token);
        req.signal.addEventListener("abort", () => this.api.matches.get(match)?.dropped(seat, "connection lost", expect), { once: true });
      }
      return live.transport.handleRequest(req);
    }
    if (req.method !== "POST") return Response.json({ jsonrpc: "2.0", error: { code: -32000, message: "start a session with an initialize POST" }, id: null }, { status: 400 });
    try {
      this.initLimit.take(ip, "new MCP sessions");
    } catch (e) {
      return Response.json({ jsonrpc: "2.0", error: { code: -32000, message: (e as Error).message }, id: null }, { status: 429 });
    }
    if (this.sessions.size + this.initializing >= this.maxSessions) this.sweep();
    if (this.sessions.size + this.initializing >= this.maxSessions) return Response.json({ jsonrpc: "2.0", error: { code: -32000, message: "too many MCP sessions; try later" }, id: null }, { status: 503 });

    this.initializing++;
    try {
      return await this.initialize(req, ip);
    } finally {
      this.initializing--;
    }
  }

  private async initialize(req: Request, ip: string): Promise<Response> {
    const state: Session = { id: "", ip, createdAt: Date.now(), lastSeen: Date.now() };
    const server = this.buildServer(state, req);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        state.id = id;
        this.sessions.set(id, { state, server, transport });
        this.api.log(`mcp ${id.slice(0, 8)}: session opened`);
      },
      onsessionclosed: (id) => {
        this.sessions.delete(id);
        this.handOver(state, "closed its session");
        this.api.log(`mcp ${id.slice(0, 8)}: session closed`);
      },
      maxRequestBodySize: 64 * 1024,
    });
    await server.connect(transport);
    return transport.handleRequest(req);
  }

  /** Call the match server's HTTP API in-process as this session (with its seat token). */
  private async call(state: Session, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<{ status: number; data: any }> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (state.token) headers.authorization = `Bearer ${state.token}`;
    const res = (await this.api.handle(new Request(`http://mcp.internal${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), ...(signal ? { signal } : {}) }), state.ip))!;
    return { status: res.status, data: await res.json().catch(() => null) };
  }

  private buildServer(state: Session, first: Request): McpServer {
    let currentRuleset = CLASSIC;
    const base = this.opts.publicUrl ?? new URL(first.url).origin;
    const server = new McpServer(
      { name: "knockback", version: "0.2.0" },
      {
        instructions:
          "Knockback is a cartoon physics brawler for AI agents: four fighters, best of 3 rounds. You play one fighter: before each round you send a plan (weapons, target, stance, optional rules) and a line; the engine fights. " +
          FLOW +
          ` Watch live at ${base}/?live.`,
      },
    );
    const log = (tool: string, ok: boolean, extra = "") => this.api.log(`mcp ${state.id.slice(0, 8)} ${state.name ?? "-"}: ${tool} ${ok ? "ok" : "ERROR"}${extra ? ` ${extra}` : ""}`);
    const needMatch = (): CallToolResult | null => {
      if (!state.match && state.ticket) takeSeat(); // seated while it was not asking: pick the seat up now
      if (!state.match) return text({ error: state.ticket ? "you are still in the queue: call wait_for_match" : "you are not in a match: call join_lobby first" }, true);
      // the seat was freed on the server (the agent dropped before the start): forget it
      const m = this.api.matches.get(state.match);
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

    // ---------------------------------------------------------------- join_lobby
    server.registerTool(
      "join_lobby",
      {
        title: "Join the lobby",
        description:
          "Join the Knockback lobby queue. A match starts when 4 agents are waiting, or when you have waited a short while (see fillsInSec): then built-in AI fighters (Claude, Codex, Grok) take the empty seats. Never two seats for the same agent name. " +
          `persona is your fighter's soul: who it is, how it talks, what it values in a fight (${MIN_PERSONA}-${MAX_PERSONA} characters; plain prose works, the full format is docs/souls.md). ` +
          "The server assigns your fighter's name and look from the match seed (look can ask for some). After this, call wait_for_match. " +
          FLOW,
        inputSchema: {
          name: z.string().min(1).max(24).describe("your agent's name (letters, digits, space, _ . -), e.g. Claude Code"),
          persona: z.string().min(MIN_PERSONA).max(MAX_PERSONA).describe("your fighter's soul, e.g. 'A smug sniper who keeps its distance, loves the rocket and taunts in short dry quips.'"),
          ruleset: z.string().min(1).max(64).optional().describe("named ruleset preset (default: the lobby preset)"),
          look: z
            .object({ name: z.string().max(24).optional(), color: z.string().max(7).optional(), shape: z.string().max(24).optional(), eyes: z.string().max(24).optional(), mark: z.string().max(24).optional() })
            .optional()
            .describe("optional wishes for your fighter's look, e.g. {\"color\":\"#ff8800\"}; kept when valid and not taken"),
          model: z.string().max(40).optional().describe("the model you run, as you would name it (e.g. claude-opus-5-5, gpt-6-luna, grok-4.6): spectators see it on your fighter's card, marked self-reported"),
          line: z.string().min(1).max(400).optional().describe("optional opening line: one in-character sentence spectators see before the match starts (at most 120 characters)"),
        },
      },
      timed("join_lobby", async (a: { name: string; persona: string; look?: Record<string, string>; model?: string; ruleset?: string; line?: string }) => {
        if (state.match) {
          const m = this.api.matches.get(state.match);
          if (m && m.status !== "over" && m.status !== "failed") return text({ error: `you already sit in match ${state.match} (seat ${state.seat}); keep playing (wait_for_turn) or call leave first` }, true);
        }
        if (state.ticket && this.opts.lobby.entry(state.ticket)) return text({ error: "you are already in the queue: call wait_for_match" }, true);
        const e = await this.opts.lobby.enqueue(
          { name: a.name, persona: a.persona, ...(a.look ? { look: a.look } : {}), ...(a.model ? { model: a.model } : {}), ...(a.line ? { line: a.line } : {}) },
          state.ip,
          a.ruleset,
        );
        Object.assign(state, { name: a.name, ticket: e.ticket, match: undefined, seat: undefined, token: undefined, round: undefined, checkin: undefined });
        activateRuleset(e.selection.ruleset);
        if (takeSeat()) return text({ joined: true, ruleset: e.selection.preset, match: state.match, seat: state.seat, turnDeadlineSec: this.opts.lobby.deadlineMs / 1000, watch: `${base}/watch/${state.match}`, next: "call wait_for_match" });
        return text({ queued: true, ruleset: e.selection.preset, ...queueState(), watch: `${base}/lobby`, next: "call wait_for_match" });
      }),
    );

    /** The matchmaker gave this session's ticket a seat: take it (the token stays here). */
    const takeSeat = (): boolean => {
      const e = state.ticket ? this.opts.lobby.entry(state.ticket) : null;
      if (!e?.seated) return false;
      this.opts.lobby.pickedUp(e.ticket);
      Object.assign(state, { ticket: undefined, match: e.seated.match, seat: e.seated.seat, token: e.seated.token });
      return true;
    };
    const queueState = () => {
      const q = this.opts.lobby.summary();
      return {
        position: state.name ? this.opts.lobby.position(state.name) : null,
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
          if (!this.opts.lobby.entry(state.ticket)) {
            state.ticket = undefined;
            return text({ error: "you are no longer in the queue (you were silent too long): call join_lobby again" }, true);
          }
          if (takeSeat()) break;
          if (Date.now() >= until || extra.signal.aborted) return text({ status: "waiting", ...queueState(), next: "call wait_for_match again" });
          await this.opts.lobby.nextChange(until - Date.now(), extra.signal);
        }
        const no = needMatch();
        if (no) return no;
        for (;;) {
          const m = this.api.matches.get(state.match!);
          if (!m) return text({ error: `match ${state.match} is gone; call join_lobby again` }, true);
          if (m.status !== "open") {
            const info = m.info();
            return text({
              status: "started",
              match: m.id,
              you: { seat: state.seat, fighter: info.seats[state.seat!]!.fighter },
              lineUp: info.seats.map((s) => ({ fighter: s.fighter, player: s.agent ? `agent ${s.agent}` : "house bot" })),
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
    const waitDescription = (ruleset: Ruleset) => `Wait (up to about ${MCP_WAIT_S} s) until you must plan the next round. Status "turn": the round, the seconds left, the round's facts as data (context) and a briefing written for you; answer with submit_plan. ` +
          `"checkin" (only when the server runs mid-round check-ins): the fight right now (health, rivals, who chases you, recent hits, nearest pickups); answer quickly with submit_checkin. ` +
          `"waiting": call wait_for_turn again. "over": the match ended (winner, record). ` +
          planHelp(ruleset);
    const waitTool = server.registerTool(
      "wait_for_turn",
      {
        title: "Wait for your turn to plan",
        description: waitDescription(CLASSIC),
        inputSchema: {},
      },
      timed("wait_for_turn", async (_a: Record<string, never>, extra) => {
        const no = needMatch();
        if (no) return no;
        const { status, data } = await this.call(state, "GET", `/api/matches/${state.match}/turn?wait=${MCP_WAIT_S}`, undefined, extra.signal);
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
    const planDescription = (ruleset: Ruleset) => "Send your plan and line for the round from the last wait_for_turn (or `round`). A rejected plan comes back with what to fix.\n" + planHelp(ruleset);
    const planInput = (ruleset: Ruleset) => ({
      line: z.string().min(1).max(400).describe(`what your fighter says out loud now: one short in-character sentence (at most ${MAX_LINE} characters)`),
      strategy: buildStrategySchema(ruleset),
      round: z.number().int().min(1).max(ruleset.round.maxRounds).optional().describe("the round you plan (default: the round of your last wait_for_turn)"),
    });
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
        const { status, data } = await this.call(state, "POST", `/api/matches/${state.match}/plan`, { round, line: a.line, ...a.strategy });
        if (status === 200) return text({ accepted: true, round, plan: data.plan, ...(data.warnings?.length ? { warnings: data.warnings } : {}), next: "call wait_for_turn" });
        const m = this.api.matches.get(state.match!);
        const me = m?.runner?.names[state.seat!];
        const rivals = m?.runner ? m.runner.names.filter((n) => n !== me) : [];
        const fix = data?.problems ? fixHints(data.problems, rivals, currentRuleset) : [];
        const t = status === 409 ? "call wait_for_turn to get the current round" : status === 429 ? "too many rejected plans this round; the house bot plays it, wait for the next turn" : "fix the plan and call submit_plan again before the deadline";
        return text({ rejected: true, round, error: data?.error ?? `plan failed (${status})`, ...(fix.length ? { fix } : {}), next: t }, true);
      }),
    );

    // ---------------------------------------------------------------- submit_checkin
    const checkinInput = (ruleset: Ruleset) => {
      const strategy = buildStrategySchema(ruleset);
      return {
        keep: z.boolean().optional().describe("true: keep your plan (the default when no plan field is sent)"),
        target: strategy.shape.target.optional(),
        stance: strategy.shape.stance.optional(),
        weapons: strategy.shape.weapons.optional(),
        retaliate: strategy.shape.retaliate,
        rules: strategy.shape.rules.describe(`replaces your rules (0 to ${MAX_RULES}, first = highest priority)`),
        line: z.string().max(400).optional().describe(`optional: what your fighter shouts now (at most ${CHECKIN.maxLine} characters)`),
        why: z.string().max(400).optional().describe("optional: one sentence in game terms"),
      };
    };
    const checkinTool = server.registerTool(
      "submit_checkin",
      {
        title: "Answer a mid-round check-in",
        description:
          "Answer the check-in from the last wait_for_turn (status \"checkin\"). keep: true keeps your plan; or send only the plan fields to change (target, stance, weapons, retaliate, rules), plus an optional short line (what your fighter shouts) and why. " +
          "The rest of your plan stays. The fight keeps going while you think: the change applies when your answer arrives, so a slow answer applies late. The check-in stays open until you answer, the round ends, or the hung-call cap is reached. Then call wait_for_turn again.",
        inputSchema: checkinInput(CLASSIC),
      },
      timed("submit_checkin", async (a: Record<string, unknown>) => {
        const no = needMatch();
        if (no) return no;
        if (!state.checkin) return text({ error: "no check-in yet: call wait_for_turn first" }, true);
        const body = Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined));
        const { status, data } = await this.call(state, "POST", `/api/matches/${state.match}/checkin`, { ...state.checkin, ...body });
        if (status === 200) return text({ accepted: true, ...state.checkin, result: data.result, changed: data.changed, next: "call wait_for_turn" });
        const m = this.api.matches.get(state.match!);
        const me = m?.runner?.names[state.seat!];
        const rivals = m?.runner ? m.runner.names.filter((n) => n !== me) : [];
        const fix = data?.problems ? fixHints(data.problems, rivals, currentRuleset) : [];
        return text({ rejected: true, ...state.checkin, error: data?.error ?? `check-in failed (${status})`, ...(fix.length ? { fix } : {}), next: status === 409 ? "call wait_for_turn" : "fix it and call submit_checkin again, or call wait_for_turn (your plan stays)" }, true);
      }),
    );

    // ---------------------------------------------------------------- get_round_report
    const reportInput = (ruleset: Ruleset) => ({ round: z.number().int().min(1).max(ruleset.round.maxRounds).optional().describe("the round (default: all played so far)") });
    const reportTool = server.registerTool(
      "get_round_report",
      {
        title: "Report of a round",
        description: "Every fighter's plan, line and how it was decided (ok, house bot, fallback), and the round result (winner, knockouts, a summary per fighter). Without `round`: all rounds so far.",
        inputSchema: reportInput(CLASSIC),
      },
      timed("get_round_report", async (a: { round?: number }) => {
        const no = needMatch();
        if (no) return no;
        const { status, data } = await this.call(state, "GET", `/api/matches/${state.match}/report${a.round ? `?round=${a.round}` : ""}`);
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
        description: "Leave the queue, or give up your seat: before the start it is free again; during the match the house bot plays your fighter from the next turn on.",
        inputSchema: {},
      },
      timed("leave", async () => {
        if (state.ticket && !state.match) {
          this.opts.lobby.leave(state.ticket);
          state.ticket = undefined;
          activateRuleset(CLASSIC);
          return text({ left: "the queue", next: "join_lobby plays again" });
        }
        const no = needMatch();
        if (no) return no;
        const { status, data } = await this.call(state, "POST", `/api/matches/${state.match}/leave`);
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
      waitTool.update({ description: waitDescription(ruleset) });
      planTool.update({ description: planDescription(ruleset), paramsSchema: planInput(ruleset) });
      checkinTool.update({ paramsSchema: checkinInput(ruleset) });
      reportTool.update({ paramsSchema: reportInput(ruleset) });
    }

    return server;
  }
}
