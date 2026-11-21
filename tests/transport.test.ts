import { describe, expect, test } from "bun:test";
import { LiveStream } from "../src/server/live";
import { McpAdmission } from "../src/server/mcp-admission";
import { HttpError, RateLimiter } from "../src/server/limits";
import { MatchServer, ServerMatch } from "../src/server/match-server";
import { Matchmaker } from "../src/server/matchmaker";

const lobbyOf = (api: MatchServer) => new Matchmaker(api, { tickMs: 60_000 });
import { McpGateway } from "../src/server/mcp";

const decode = (v: Uint8Array | undefined) => new TextDecoder().decode(v);
const request = (sid = "a", signal?: AbortSignal) => new Request("http://kb.test/mcp", { headers: { "mcp-session-id": sid }, signal });
const streaming = () => new Response(new ReadableStream<Uint8Array>({}), { headers: { "content-type": "text/event-stream" } });
const persona = "A loud brawler who loves the bat and never backs down.";

describe("spectator resource bounds", () => {
  test("drops a stalled reader at its byte limit while an active reader keeps receiving", async () => {
    const live = new LiveStream(2, 0, 64);
    const slow = live.response().body!.getReader();
    const fast = live.response().body!.getReader();
    expect(live.response().status).toBe(503);
    try {
      for (let i = 0; i < 10; i++) {
        live.broadcast({ i });
        expect(decode((await fast.read()).value)).toContain(`"i":${i}`);
      }
      expect(live.size).toBe(1);
      await expect(slow.read()).rejects.toThrow("too slow");
    } finally {
      await fast.cancel();
      live.close();
    }
  });

  test("a reader already waiting gets every event once, in order (enqueue may re-enter pull)", async () => {
    const live = new LiveStream(1, 0);
    const reader = live.response().body!.getReader();
    let text = "";
    const reading = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        text += decode(value);
      }
    })();
    for (let i = 0; i < 12; i++) {
      await Bun.sleep(2); // the reader is waiting when the event comes
      live.broadcast({ i });
    }
    await Bun.sleep(10);
    live.close();
    await reading;
    expect([...(text.match(/"i":\d+/g) ?? [])]).toEqual(Array.from({ length: 12 }, (_, i) => `"i":${i}`));
  });

  test("late join replays history larger than the queue in order", async () => {
    const live = new LiveStream(1, 0, 32);
    for (let i = 0; i < 20; i++) live.broadcast({ i });
    const reader = live.response().body!.getReader();
    try {
      for (let i = 0; i < 20; i++) expect(decode((await reader.read()).value)).toContain(`"i":${i}`);
    } finally {
      await reader.cancel();
      expect(live.size).toBe(0);
      live.close();
    }
  });

  test("a single oversized event disconnects rather than exceeding the bound", async () => {
    const live = new LiveStream(1, 0, 32);
    const reader = live.response().body!.getReader();
    live.broadcast({ text: "x".repeat(100) });
    expect(live.size).toBe(0);
    await expect(reader.read()).rejects.toThrow("too slow");
    live.close();
  });

  test("eviction closes the old match stream and rejects new subscribers", async () => {
    class Server extends MatchServer {
      addFinished(id: string) {
        const m = new ServerMatch(id, 1, ["house", "house", "house", "house"], 2000, 300000, this);
        m.status = "over";
        this.add(m);
        return m;
      }
    }
    const api = new Server({ outDir: "." });
    const old = api.addFinished("old");
    const reader = old.live.response().body!.getReader();
    try {
      for (let i = 0; i < 200; i++) api.addFinished(`m${i}`);
      expect(api.matches.has("old")).toBe(false);
      expect((await reader.read()).done).toBe(true);
      expect(old.live.size).toBe(0);
      expect(old.live.response().status).toBe(503);
    } finally {
      await reader.cancel();
      await api.store.close();
    }
  });
});

describe("MCP admission", () => {
  test("address and session limits apply before dispatch and remain held for SSE", async () => {
    const gate = new McpAdmission(10, 1, 1);
    let calls = 0;
    const dispatch = async () => { calls++; return streaming(); };
    const first = await gate.run(request(), "ip1", dispatch);
    try {
      await expect(gate.run(request("b"), "ip1", dispatch)).rejects.toMatchObject({ status: 429 });
      await expect(gate.run(request(), "ip2", dispatch)).rejects.toMatchObject({ status: 429 });
      expect(calls).toBe(1);
      const other = await gate.run(request("b"), "ip2", dispatch);
      await other.body!.cancel();
    } finally {
      await first.body!.cancel();
    }
    const again = await gate.run(request(), "ip1", dispatch);
    await again.body!.cancel();
  });

  test("global capacity is held before response headers exist and released after errors", async () => {
    const gate = new McpAdmission(1, 10, 10);
    let finish!: (r: Response) => void;
    const pending = gate.run(request(), "ip1", () => new Promise<Response>((r) => { finish = r; }));
    await expect(gate.run(request("b"), "ip2", async () => new Response())).rejects.toMatchObject({ status: 503 });
    finish(new Response("ok"));
    await pending;
    await expect(gate.run(request(), "ip1", async () => { throw new Error("dispatch failed"); })).rejects.toThrow("dispatch failed");
    expect((await gate.run(request(), "ip1", async () => new Response())).status).toBe(200);
  });

  test.each(["completion", "error", "abort"] as const)("releases a stream slot on %s", async (mode) => {
    const gate = new McpAdmission(1, 1, 1);
    const abort = new AbortController();
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const res = await gate.run(request("a", abort.signal), "ip", async () => new Response(new ReadableStream<Uint8Array>({ start(c) { ctl = c; } }), { headers: { "content-type": "text/event-stream" } }));
    const reader = res.body!.getReader();
    if (mode === "error") {
      ctl.error(new Error("broken stream"));
      await expect(reader.read()).rejects.toThrow("broken stream");
    } else {
      if (mode === "completion") ctl.close();
      else abort.abort();
      expect((await reader.read()).done).toBe(true);
    }
    expect((await gate.run(request(), "ip", async () => new Response())).status).toBe(200);
  });

  test("concurrent initialization reserves session capacity before reading its body", async () => {
    const api = new MatchServer({ outDir: "." });
    const gw = new McpGateway(api, { lobby: lobbyOf(api), maxSessions: 1 });
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    let reading!: () => void;
    const ready = new Promise<void>(r => { reading = r; });
    const body = new ReadableStream<Uint8Array>({ start(c) { ctl = c; }, pull() { reading(); } }, { highWaterMark: 0 });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const pending = gw.handle(new Request("http://kb.test/mcp", { method: "POST", headers, body }), "ip1");
    try {
      await ready;
      const denied = await gw.handle(new Request("http://kb.test/mcp", { method: "POST", headers, body: "{}" }), "ip2");
      expect(denied.status).toBe(503);
      ctl.enqueue(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } })));
      ctl.close();
      const accepted = await pending;
      expect(accepted.status).toBe(200);
      await accepted.text();
      expect(gw.sessions.size).toBe(1);
    } finally {
      gw.close();
      await api.store.close();
    }
  });

  test("gateway holds admission until an existing session's SSE response is cancelled", async () => {
    const api = new MatchServer({ outDir: "." });
    const gw = new McpGateway(api, { lobby: lobbyOf(api), maxInFlight: 1 });
    let calls = 0;
    gw.sessions.set("known", { state: { id: "known", ip: "ip", createdAt: 0, lastSeen: 0 }, transport: { handleRequest: async () => { calls++; return streaming(); }, close: async () => {} } } as any);
    try {
      const first = await gw.handle(request("known"), "ip1");
      expect((await gw.handle(request("known"), "ip2")).status).toBe(503);
      expect(calls).toBe(1);
      await first.body!.cancel();
      const next = await gw.handle(request("known"), "ip2");
      expect(next.status).toBe(200);
      await next.body!.cancel();
    } finally {
      gw.close();
      await api.store.close();
    }
  });

  test("gateway rate limits existing-session traffic before invoking its transport", async () => {
    class Gateway extends McpGateway {
      // Keep token refill independent of machine load.
      override readonly requestLimit = new RateLimiter(60, 10, () => 0);
      override readonly sessionLimit = new RateLimiter(30, 5, () => 0);
    }
    const api = new MatchServer({ outDir: "." });
    const gw = new Gateway(api, { lobby: lobbyOf(api) });
    let calls = 0;
    // Isolate admission from SDK dispatch; this transport would otherwise accept every call.
    gw.sessions.set("known", { state: { id: "known", ip: "ip", createdAt: 0, lastSeen: 0 }, transport: { handleRequest: async () => { calls++; return new Response(); }, close: async () => {} } } as any);
    try {
      for (let i = 0; i < 30; i++) expect((await gw.handle(request("known"), `ip${i}`)).status).toBe(200);
      const denied = await gw.handle(request("known"), "new-ip");
      expect(denied.status).toBe(429);
      expect(denied.headers.get("retry-after")).not.toBeNull();
      expect(calls).toBe(30);
      for (let i = 0; i < 60; i++) expect((await gw.handle(request("missing"), "no-session-ip")).status).toBe(404);
      expect((await gw.handle(request("missing"), "no-session-ip")).status).toBe(429);
    } finally {
      gw.close();
      await api.store.close();
    }
  });
});

describe("lobby admission", () => {
  test("invalid joins do not allocate a match or storage row", async () => {
    const api = new MatchServer({ outDir: "." });
    const lobby = lobbyOf(api);
    try {
      await expect(lobby.enqueue({ name: "bad!", persona }, "ip")).rejects.toBeInstanceOf(HttpError);
      expect(lobby.waiting()).toEqual([]);
      expect(api.matches.size).toBe(0);
      expect(await api.store.listMatches()).toEqual([]);
    } finally {
      lobby.close();
      await api.store.close();
    }
  });

  test.each(["rate limit", "storage failure"] as const)("a %s retires a newly created empty match", async (mode) => {
    const api = new MatchServer({ outDir: "." });
    const lobby = new Matchmaker(api, { tickMs: 60_000, fillAfterMs: 0 });
    const create = api.createMatch.bind(api);
    let created!: ServerMatch;
    api.createMatch = async (options, sel) => (created = await create(options, sel));
    // the queue join takes one of the address's join tokens; the seat join then finds none left
    if (mode === "rate limit") for (let i = 0; i < 9; i++) api.joinLimit.take("ip");
    else api.store.insertSeat = async () => { throw new Error("storage failure"); };
    try {
      await lobby.enqueue({ name: "Agent", persona }, "ip");
      expect(lobby.waiting()).toEqual([]); // the agent could not take its seat: out of the queue
      expect(api.tokens.size).toBe(0);
      const m = created;
      expect(api.matches.size).toBe(0);
      const live = (await api.handle(new Request("http://kb.test/api/live"), "observer"))!;
      expect(live.status).toBe(404); // no stale default pointer to the cancelled match
      expect(m.status).toBe("failed");
      expect(m.agents.every((a) => !a)).toBe(true);
      expect((await api.store.getMatch(m.id))!.status).toBe("failed");
      await m.start(); // a stale fill callback must not start the failed match
      expect(m.status).toBe("failed");
      expect(await api.resume()).toEqual({ open: [], running: [] });
    } finally {
      lobby.close();
      await api.store.close();
    }
  });
});
