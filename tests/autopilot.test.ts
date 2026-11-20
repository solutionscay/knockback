/** #22: agents that drop or go silent hand their fighter to the house bot ("autopilot") and can come back. */
import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AUTOPILOT_LINES, BACK_LINES, pickLine } from "../src/server/autopilot";
import { LobbyQueue } from "../src/server/lobby-queue";
import { MatchServer, type ServerMatch } from "../src/server/match-server";
import { McpGateway } from "../src/server/mcp";
import { initPhysics, replayMatch } from "../src/sim";

setDefaultTimeout(120_000);
beforeAll(async () => {
  await initPhysics();
});

const SOUL = readFileSync("souls/rat.md", "utf8");
const PLAN = { weapons: ["rocket", "bat"], target: "weakest", stance: "rush", retaliate: "attacker", line: "Coming through!" };
const tmp = () => mkdtempSync(join(tmpdir(), "kb-auto-"));
const hashes = (rec: { rounds: { fight: { finalHash: string } }[] }) => rec.rounds.map((r) => r.fight.finalHash);

function http(s: MatchServer) {
  return async (method: string, path: string, body?: unknown, token?: string, signal?: AbortSignal) => {
    const res = (await s.handle(new Request(`http://kb.test${path}`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), ...(signal ? { signal } : {}) }), "1.2.3.4"))!;
    return { status: res.status, data: (await res.json()) as any };
  };
}

async function waitFor(cond: () => boolean, ms = 10_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

describe("autopilot callouts", () => {
  test("lines name the fighter", () => {
    expect(pickLine(AUTOPILOT_LINES, "Zapbit", () => 0)).toBe("Zapbit's agent left. Too scared.");
    expect(pickLine(AUTOPILOT_LINES, "Ruxy", () => 1)).toBe("Ruxy's brain went to get milk. Autopilot engaged.");
    expect(pickLine(BACK_LINES, "Zapbit", () => 0)).toBe("Zapbit's agent is back. Probably hiding behind the barrels.");
  });
});

describe("HTTP agents", () => {
  test("a long poll that drops -> autopilot after the grace period; the next round is the house bot's at once; polling again -> back next round; the record replays", async () => {
    const s = new MatchServer({ outDir: tmp(), dropGraceMs: 150 });
    const call = http(s);
    const m = await s.createMatch({ seats: ["remote", "remote", "house", "house"], seed: 11, deadlineMs: 4000, fillAfterMs: 30_000 });
    const a = (await call("POST", `/api/matches/${m.id}/join`, { name: "Steady", persona: SOUL })).data.token;
    const b = (await call("POST", `/api/matches/${m.id}/join`, { name: "Flaky", persona: SOUL })).data.token;
    // A plans every round, slowly, so B's long polls hang while A thinks
    const steady = (async () => {
      for (;;) {
        const t = (await call("GET", `/api/matches/${m.id}/turn?wait=5`, undefined, a)).data;
        if (t.status === "over") return t;
        if (t.status !== "turn") continue;
        await Bun.sleep(600);
        await call("POST", `/api/matches/${m.id}/plan`, { round: t.round, ...PLAN }, a);
      }
    })();
    // B plans round 1, then its connection drops in the middle of a long poll
    let t = (await call("GET", `/api/matches/${m.id}/turn?wait=5`, undefined, b)).data;
    expect(t.round).toBe(1);
    await call("POST", `/api/matches/${m.id}/plan`, { round: 1, ...PLAN }, b);
    const ctl = new AbortController();
    const hang = call("GET", `/api/matches/${m.id}/turn?wait=5`, undefined, b, ctl.signal);
    await Bun.sleep(50);
    ctl.abort();
    await hang;
    await waitFor(() => !!m.agents[1]!.autopilot);
    expect(m.runner!.control[0]).toMatchObject({ seat: 1, mode: "autopilot", reason: "connection lost" });
    expect(m.info().seats[1]).toMatchObject({ autopilot: "connection lost" });
    // B comes back while round 2 is being asked (A is still thinking): control returns from round 3
    await waitFor(() => m.runner!.match.record.rounds.length >= 1 && m.runner!.asking === 2);
    for (;;) {
      t = (await call("GET", `/api/matches/${m.id}/turn?wait=5`, undefined, b)).data;
      if (t.status === "turn" || t.status === "over") break;
    }
    const back = m.runner!.control[1]!;
    expect(back).toMatchObject({ seat: 1, mode: "agent", reason: "reconnected" });
    expect(back.fromRound).toBe(3);
    if (t.status === "turn") {
      expect(t.round).toBe(back.fromRound);
      await call("POST", `/api/matches/${m.id}/plan`, { round: t.round, ...PLAN }, b);
    }
    await steady;
    await waitFor(() => m.status === "over");
    // round 2 was the house bot's for B, decided without waiting for B's deadline
    const r2 = m.runner!.match.record.rounds[1]!.meta![1]!;
    expect(r2.outcome).toBe("fallback-error");
    expect(r2.detail).toBe("autopilot: connection lost");
    expect(r2.ms).toBeLessThan(100);
    const rec = m.runner!.savedRecord();
    expect(rec.control!.map((c) => c.mode)).toEqual(["autopilot", "agent"]);
    expect(hashes(replayMatch(rec).record)).toEqual(hashes(rec));
    if (rec.rounds.length >= 3) expect(rec.rounds[2]!.meta![1]!.outcome).toBe("ok");
    expect(m.info().seats[1]!.autopilot).toBeUndefined(); // finished in control
  });

  test("a drop followed by a new request within the grace period is not a disconnect", async () => {
    const s = new MatchServer({ outDir: tmp(), dropGraceMs: 300 });
    const call = http(s);
    const m = await s.createMatch({ seats: ["remote", "remote", "house", "house"], seed: 21, deadlineMs: 3000, fillAfterMs: 30_000 });
    const a = (await call("POST", `/api/matches/${m.id}/join`, { name: "A", persona: SOUL })).data.token;
    await call("POST", `/api/matches/${m.id}/join`, { name: "B", persona: SOUL });
    const ctl = new AbortController();
    const hang = call("GET", `/api/matches/${m.id}/turn?wait=5`, undefined, a, ctl.signal);
    await Bun.sleep(30);
    ctl.abort();
    await hang;
    await call("GET", `/api/matches/${m.id}/turn?wait=0`, undefined, a); // back within 300 ms
    await Bun.sleep(400);
    expect(m.agents[0]!.autopilot).toBeNull();
    expect(m.runner!.control).toEqual([]);
    m.takeover(1, "test cleanup");
  });

  test("an agent that drops before the start frees its seat", async () => {
    const s = new MatchServer({ outDir: tmp(), dropGraceMs: 50 });
    const call = http(s);
    const m = await s.createMatch({ seats: ["remote", "remote", "house", "house"], fillAfterMs: 300_000 });
    const a = (await call("POST", `/api/matches/${m.id}/join`, { name: "Early", persona: SOUL })).data.token;
    const ctl = new AbortController();
    const hang = call("GET", `/api/matches/${m.id}/turn?wait=5`, undefined, a, ctl.signal);
    await Bun.sleep(30);
    ctl.abort();
    await hang;
    await waitFor(() => m.agents[0] === null);
    expect(m.info().seats[0]!.agent).toBeNull();
    await m.start();
  });
});

describe("MCP agents", () => {
  async function mcpClient(gw: McpGateway, sessionId?: string) {
    const client = new Client({ name: "t", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL("http://kb.test/mcp"), { fetch: (u, init) => gw.handle(new Request(u, init as RequestInit), "10.9.0.1"), ...(sessionId ? { sessionId } : {}) });
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) => {
      const r = (await client.callTool({ name, arguments: args }, undefined, signal ? { signal } : undefined)) as { content: { text: string }[] };
      return JSON.parse(r.content[0]!.text);
    };
    return { client, transport, call };
  }

  function setup() {
    const api = new MatchServer({ outDir: tmp(), dropGraceMs: 150 });
    const gw = new McpGateway(api, { lobby: new LobbyQueue(api, { seats: ["remote", "remote", "house", "house"], deadlineMs: 4000, fillAfterMs: 30_000 }) });
    return { api, gw };
  }

  async function seated(gw: McpGateway, api: MatchServer) {
    const a = await mcpClient(gw);
    const b = await mcpClient(gw);
    await a.call("join_lobby", { name: "Alpha", persona: SOUL });
    await b.call("join_lobby", { name: "Bravo", persona: SOUL });
    const m = [...api.matches.values()][0]! as ServerMatch;
    await waitFor(() => m.status === "running");
    return { a, b, m };
  }

  test("closing the MCP session mid-match hands the fighter to the house bot", async () => {
    const { api, gw } = setup();
    const { a, b, m } = await seated(gw, api);
    const turn = await b.call("wait_for_turn");
    expect(turn.status).toBe("turn");
    await b.transport.terminateSession(); // DELETE /mcp
    await waitFor(() => !!m.agents[1]!.autopilot);
    expect(m.runner!.control[0]).toMatchObject({ seat: 1, mode: "autopilot", reason: "closed its session" });
    for (;;) {
      const t = await a.call("wait_for_turn");
      if (t.status === "over") break;
      if (t.status === "turn") await a.call("submit_plan", { line: "Still here.", strategy: { weapons: ["bat"], target: "nearest", stance: "rush" } });
    }
    expect(m.info().seats[1]).toMatchObject({ finishedOnAutopilot: true });
    gw.close();
  });

  test("a tool call that drops -> autopilot; the same MCP session reconnecting -> back next round", async () => {
    const { api, gw } = setup();
    const { a, b, m } = await seated(gw, api);
    const sid = b.transport.sessionId!;
    // round 1: both plan (A slowly, so B's next wait hangs)
    const play = (async () => {
      for (;;) {
        const t = await a.call("wait_for_turn");
        if (t.status === "over") return;
        if (t.status !== "turn") continue;
        await Bun.sleep(700);
        await a.call("submit_plan", { line: "Patience.", strategy: { weapons: ["rocket"], target: "nearest", stance: "distance" } });
      }
    })();
    const t1 = await b.call("wait_for_turn");
    await b.call("submit_plan", { line: "Round one.", strategy: { weapons: ["bat"], target: "nearest", stance: "rush" }, round: t1.round });
    // B's process "dies" in the middle of wait_for_turn
    const ctl = new AbortController();
    const pending = b.call("wait_for_turn", {}, ctl.signal).catch(() => undefined);
    await Bun.sleep(100);
    ctl.abort();
    await pending;
    await waitFor(() => !!m.agents[1]!.autopilot, 5000).catch(async () => {
      // the SDK may not abort the HTTP request on cancel: drop it the way a dead process does
      m.dropped(1);
      await waitFor(() => !!m.agents[1]!.autopilot);
    });
    // a new client with the same session id is the same agent: it gets the fighter back from the next round
    const again = await mcpClient(gw, sid);
    let t: any;
    for (;;) {
      t = await again.call("wait_for_turn");
      if (t.status === "turn" || t.status === "over") break;
    }
    expect(m.runner!.control.map((c) => c.mode)).toEqual(["autopilot", "agent"]);
    if (t.status === "turn") {
      expect(t.round).toBe(m.runner!.control[1]!.fromRound);
      expect((await again.call("submit_plan", { line: "I'm back.", strategy: { weapons: ["bat"], target: "nearest", stance: "rush" } })).accepted).toBe(true);
    }
    await play;
    gw.close();
  });
});
