/**
 * MCP server for the match server (#21): any MCP-capable agent (Claude Code,
 * Codex, Grok, custom) joins and fights. Plug and play: the person adds the MCP
 * config from the JOIN panel (it carries their owner key) and tells the agent
 * "play Knockback"; the server instructions and get_started teach the agent the
 * rest. Each agent thinks with its own model; the server makes no AI calls.
 *
 * Auth: the owner key (src/server/keys.ts) on the initialize request, as
 * `Authorization: Bearer kbk_...` (a `?key=` on the URL is not accepted). No
 * key, no session. A revoked key ends its sessions at their next request.
 *
 * Transport: Streamable HTTP (the SDK's web-standard transport), mounted on
 * the match server at /mcp; scripts/mcp-stdio.ts bridges stdio clients to it.
 *
 * Sessions: one McpServer per MCP session. The session holds the agent's
 * Arena seat token (#64), so the agent never handles it: every tool calls the
 * match server's own HTTP API in-process with that token, and gets its
 * validation, rate limits, deadlines and house-bot fallback exactly as an HTTP
 * agent does. A session that closes or expires leaves the Arena (a house bot
 * takes its seat); a tool call whose connection drops is a disconnect (the
 * autopilot plays until the agent is back).
 *
 * Modules: this file is the gateway (transport, session lifetime, auth, rate limits, HTTP adaptation);
 * src/server/mcp-tools.ts registers the tools on each session's server; src/server/mcp-schema.ts builds the tool
 * input schemas and help text from the constants the plan parser uses (src/sim/rules.ts, src/sim/sim-types.ts,
 * src/ai/parse.ts), so they cannot drift from what the server accepts.
 */
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { HttpError, RateLimiter } from "./limits";
import { McpAdmission } from "./mcp-admission";
import { INSTRUCTIONS } from "./mcp-schema";
import { registerTools, type Session } from "./mcp-tools";
import type { MatchServer } from "./match-server";
import { hashToken } from "./seat-tokens";
import { hashKey, keyOf } from "./keys";

interface Live {
  state: Session;
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
}

export interface McpOptions {
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

// ------------------------------------------------------------------ the gateway
export class McpGateway {
  readonly sessions = new Map<string, Live>();
  readonly initLimit = new RateLimiter(10, 1 / 6);
  readonly requestLimit = new RateLimiter(60, 10);
  readonly sessionLimit = new RateLimiter(30, 5);
  /** per owner key: requests, and new sessions (one key cannot flood the server from many addresses) */
  readonly keyRequestLimit = new RateLimiter(120, 20);
  readonly keyInitLimit = new RateLimiter(10, 1 / 6);
  /** live sessions one key may hold */
  readonly sessionsPerKey = 8;
  private readonly admission: McpAdmission;
  private initializing = 0;
  private sweeper: ReturnType<typeof setInterval>;
  readonly maxSessions: number;
  readonly idleMs: number;

  constructor(
    readonly api: MatchServer,
    readonly opts: McpOptions = {},
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

  /** The session is gone for good: its agent leaves the Arena, a house bot takes its seat (#64). */
  private handOver(state: Session, reason: string) {
    if (!state.token) return;
    // only this session's own agent (by its token): the agent may have joined again from another session
    void this.api.arena.leaveByHash(hashToken(state.token), reason).catch((e) => this.api.log(`mcp: leave failed: ${e instanceof Error ? e.message : String(e)}`));
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
          { jsonrpc: "2.0", error: { code: -32001, message: "MCP session not found (expired or the server restarted): reconnect and call join_lobby again (the same name takes your seat back while you still hold it)" }, id: null },
          { status: 404 },
        );
      // a revoked key ends its sessions at their next request
      if (!(await this.api.store.ownerOfKey(live.state.keyHash))) {
        void this.drop(sid);
        return Response.json({ jsonrpc: "2.0", error: { code: -32001, message: "this owner key was revoked: get a new one on the JOIN panel" }, id: null }, { status: 401 });
      }
      this.keyRequestLimit.take(live.state.keyHash, "MCP requests with this key");
      live.state.lastSeen = Date.now();
      // a tool call whose connection drops (the agent's process died, the network went) is a disconnect (#22);
      // the seat goes on autopilot unless the session sends something again within the grace period
      if (req.method === "POST" && live.state.token) {
        const expect = hashToken(live.state.token);
        req.signal.addEventListener("abort", () => this.api.arena.dropped(expect, "connection lost"), { once: true });
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
    const key = keyOf(req);
    const owner = key ? await this.api.store.ownerOfKey(hashKey(key)) : null;
    const where = `${this.opts.publicUrl ?? new URL(req.url).origin}/lobby#join`;
    if (!key || !owner) return Response.json({ jsonrpc: "2.0", error: { code: -32001, message: `${key ? "this owner key is unknown or revoked" : "an owner key is needed"}: get one on the JOIN panel (${where}) and add the MCP config it shows` }, id: null }, { status: 401 });
    const keyHash = hashKey(key);
    this.keyInitLimit.take(keyHash, "new MCP sessions with this key");
    if ([...this.sessions.values()].filter((l) => l.state.keyHash === keyHash).length >= this.sessionsPerKey) return Response.json({ jsonrpc: "2.0", error: { code: -32000, message: `at most ${this.sessionsPerKey} MCP sessions per owner key` }, id: null }, { status: 429 });
    const state: Session = { id: "", ip, key, keyHash, owner, createdAt: Date.now(), lastSeen: Date.now() };
    const server = this.buildServer(state, req);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        state.id = id;
        this.sessions.set(id, { state, server, transport });
        this.api.log(`mcp ${id.slice(0, 8)}: session opened (owner ${owner})`);
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
    const base = this.opts.publicUrl ?? new URL(first.url).origin;
    const server = new McpServer(
      { name: "knockback", version: "0.2.0" },
      {
        instructions: `${INSTRUCTIONS} Watch at ${base}/watch.`,
      },
    );
    registerTools(server, { state, api: this.api, base, call: (method, path, body, signal) => this.call(state, method, path, body, signal) });
    return server;
  }
}
