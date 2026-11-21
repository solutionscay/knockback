/** Mid-round check-ins for remote agents (#9): HTTP (GET /turn status "checkin", POST /checkin) and MCP (submit_checkin). */
import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Matchmaker } from "../src/server/matchmaker";
import { MatchServer, type ServerMatch } from "../src/server/match-server";
import { McpGateway } from "../src/server/mcp";
import { SqliteStore } from "../src/server/store";
import { initPhysics, replayMatch } from "../src/sim";

setDefaultTimeout(120_000);
beforeAll(async () => {
  await initPhysics();
});

const SOUL = readFileSync("souls/rat.md", "utf8");
const PLAN = { weapons: ["rocket", "bat"], target: "weakest", stance: "rush", retaliate: "attacker", line: "Coming through!" };
const tmp = () => mkdtempSync(join(tmpdir(), "kb-checkin-"));
const hashes = (rec: { rounds: { fight: { finalHash: string } }[] }) => rec.rounds.map((r) => r.fight.finalHash);
const CHECKINS: { maxPerRound: number; capMs: number } = { maxPerRound: 2, capMs: 1500 }; // the cap stands in for a silent agent

function http(s: MatchServer) {
  return async (method: string, path: string, body?: unknown, token?: string, signal?: AbortSignal) => {
    const res = (await s.handle(new Request(`http://kb.test${path}`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), ...(signal ? { signal } : {}) }), "1.2.3.4"))!;
    return { status: res.status, data: (await res.json()) as any };
  };
}

async function waitFor(cond: () => boolean, ms = 20_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

type Mode = "answer" | "silent" | "drop";

/** An HTTP agent: plans every round; at a check-in it answers (first with a bad value), stays silent, or drops its connection. */
async function agent(call: ReturnType<typeof http>, m: ServerMatch, token: string, mode: Mode) {
  const seen: any[] = [];
  for (;;) {
    const t = (await call("GET", `/api/matches/${m.id}/turn?wait=5`, undefined, token)).data;
    if (t.status === "over") return seen;
    if (t.status === "turn") await call("POST", `/api/matches/${m.id}/plan`, { round: t.round, ...PLAN }, token);
    if (t.status !== "checkin") continue;
    seen.push(t);
    if (mode === "silent") {
      await Bun.sleep(t.msLeft + 100);
      continue;
    }
    if (mode === "drop") {
      // the agent's process dies with a request in flight (its connection closes): nothing more from it
      const ctl = new AbortController();
      ctl.abort();
      await call("GET", `/api/matches/${m.id}/turn?wait=5`, undefined, token, ctl.signal);
      return seen;
    }
    const bad = await call("POST", `/api/matches/${m.id}/checkin`, { round: t.round, tick: t.tick, stance: "dance" }, token);
    expect(bad.status).toBe(422);
    expect(bad.data.problems.join(" ")).toContain("stance");
    const stance = t.checkin.you.plan.stance === "rush" ? "cover" : "rush";
    const ok = await call("POST", `/api/matches/${m.id}/checkin`, { round: t.round, tick: t.tick, stance, line: "Switching!" }, token);
    expect(ok.status).toBe(200);
    expect(ok.data).toMatchObject({ accepted: true, result: "update", changed: ["stance"] });
    const again = await call("POST", `/api/matches/${m.id}/checkin`, { round: t.round, tick: t.tick, keep: true }, token);
    expect(again.status).toBe(409); // the first valid answer is final
  }
}

describe("check-ins over HTTP", () => {
  test("a check-in turn carries the fight status; an answer becomes a plan update at check-in tick + latency; the record replays", async () => {
    const s = new MatchServer({ outDir: tmp(), checkins: CHECKINS });
    const call = http(s);
    const m = await s.createMatch({ seats: ["remote", "house", "house", "house"], seed: 1, deadlineMs: 4000, fillAfterMs: 30_000 });
    const tok = (await call("POST", `/api/matches/${m.id}/join`, { name: "Answerer", persona: SOUL })).data.token;
    const seen = await agent(call, m, tok, "answer");
    await waitFor(() => m.status === "over");
    expect(seen.length).toBeGreaterThan(0);
    const c = seen[0];
    expect(c).toMatchObject({ status: "checkin", round: 1, tick: 600, second: 10 });
    expect(c.checkin.you.name).toBe(m.runner!.names[0]);
    expect(c.checkin.rivals.length).toBe(3);
    expect(c.prompt.startsWith("Knockback check-in")).toBe(true);
    expect(c.schema.stance.values).toContain("cover");
    const rec = m.runner!.savedRecord();
    const ups = rec.rounds.flatMap((r) => r.planUpdates ?? []);
    const cs = rec.rounds.flatMap((r) => r.checkins ?? []);
    expect(ups.length).toBe(seen.length);
    for (const u of cs.filter((x) => x.outcome === "update")) expect(u.applyTick! - u.tick).toBeGreaterThanOrEqual(60);
    expect(ups.every((u) => u.fighter === 0 && u.line === "Switching!")).toBe(true);
    expect(hashes(replayMatch(JSON.parse(JSON.stringify(rec))).record)).toEqual(hashes(rec));
    expect(rec.control ?? []).toEqual([]);
  });

  test("a silent agent: its check-in stays open until the cap, then a miss that keeps the plan; not a disconnect", async () => {
    const s = new MatchServer({ outDir: tmp(), checkins: CHECKINS });
    const call = http(s);
    const m = await s.createMatch({ seats: ["remote", "house", "house", "house"], seed: 1, deadlineMs: 4000, fillAfterMs: 30_000 });
    const tok = (await call("POST", `/api/matches/${m.id}/join`, { name: "Quiet", persona: SOUL })).data.token;
    const seen = await agent(call, m, tok, "silent");
    await waitFor(() => m.status === "over");
    expect(seen.length).toBeGreaterThan(0);
    const rec = m.runner!.savedRecord();
    expect(rec.rounds.every((r) => !r.planUpdates)).toBe(true);
    expect([...new Set(rec.rounds.flatMap((r) => (r.checkins ?? []).map((x) => x.outcome)))]).toEqual(["missed"]);
    expect(rec.control ?? []).toEqual([]);
    expect(rec.rounds.every((r) => r.meta![0]!.outcome === "ok")).toBe(true);
  });

  test("a connection dropped during a check-in: autopilot at that check-in's tick (phase checkin); no more check-ins; the record replays", async () => {
    const s = new MatchServer({ outDir: tmp(), checkins: CHECKINS, dropGraceMs: 100 });
    const call = http(s);
    const m = await s.createMatch({ seats: ["remote", "house", "house", "house"], seed: 1, deadlineMs: 4000, fillAfterMs: 30_000 });
    const tok = (await call("POST", `/api/matches/${m.id}/join`, { name: "Dropper", persona: SOUL })).data.token;
    const seen = await agent(call, m, tok, "drop");
    await waitFor(() => m.status === "over");
    expect(seen.length).toBe(1);
    const rec = m.runner!.savedRecord();
    expect(rec.control![0]).toMatchObject({ seat: 0, mode: "autopilot", round: 1, phase: "checkin", tick: 600, reason: "connection lost" });
    const cs = rec.rounds.flatMap((r) => r.checkins ?? []);
    expect(cs[0]).toMatchObject({ tick: 600, fighter: 0, outcome: "autopilot" });
    expect(cs.length).toBe(1); // on autopilot: no more check-ins
    expect(rec.rounds.every((r) => !r.planUpdates)).toBe(true);
    expect(hashes(replayMatch(JSON.parse(JSON.stringify(rec))).record)).toEqual(hashes(rec));
    expect(m.info().seats[0]).toMatchObject({ autopilot: "connection lost", finishedOnAutopilot: true });
  });

  test("the store keeps each round's plan updates (a resume replays them)", async () => {
    const store = new SqliteStore(":memory:");
    const s = new MatchServer({ outDir: tmp(), checkins: CHECKINS, store });
    const call = http(s);
    const m = await s.createMatch({ seats: ["remote", "house", "house", "house"], seed: 1, deadlineMs: 4000, fillAfterMs: 30_000 });
    const tok = (await call("POST", `/api/matches/${m.id}/join`, { name: "Answerer", persona: SOUL })).data.token;
    await agent(call, m, tok, "answer");
    await waitFor(() => m.status === "over");
    const rows = await store.listRounds(m.id);
    expect(rows.map((r) => r.planUpdates ?? [])).toEqual(m.runner!.match.record.rounds.map((r) => r.planUpdates ?? []));
    // rebuilt from storage, the finished match replays its stored updates to the same hashes
    const s2 = new MatchServer({ outDir: tmp(), store });
    const loaded = (await http(s2)("GET", `/api/matches/${m.id}/report`)).data;
    expect(loaded.rounds.map((r: { result: { finalHash: string } }) => r.result.finalHash)).toEqual(hashes(m.runner!.match.record));
  });
});

describe("check-ins over MCP", () => {
  test("wait_for_turn returns status checkin; submit_checkin changes the plan; keep keeps it", async () => {
    const api = new MatchServer({ outDir: tmp(), checkins: CHECKINS });
    // the lobby's match with a fixed seed whose first round lasts past the first check-in
    const create = api.createMatch.bind(api);
    api.createMatch = (c = {}) => create({ ...c, seed: 1 });
    const gw = new McpGateway(api, { lobby: new Matchmaker(api, { fillAfterMs: 0, roster: ["house"], deadlineMs: 4000, usageFile: null, tickMs: 50 }), publicUrl: "http://kb.test" });
    const client = new Client({ name: "checkin-agent", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL("http://kb.test/mcp"), { fetch: (url, init) => gw.handle(new Request(url, init as RequestInit), "10.0.0.9") }));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { data: JSON.parse(r.content.map((c) => c.text).join("")), isError: !!r.isError };
    };
    expect((await call("join_lobby", { name: "Mcp", persona: SOUL })).isError).toBe(false);
    while ((await call("wait_for_match")).data.status !== "started");
    const results: string[] = [];
    let first: any = null;
    for (;;) {
      const t = (await call("wait_for_turn")).data;
      if (t.status === "over") break;
      if (t.status === "turn") await call("submit_plan", { line: "Here we go.", strategy: { weapons: ["rocket"], target: "nearest", stance: "rush" } });
      if (t.status !== "checkin") continue;
      first ??= t;
      const r = results.length % 2 === 0 ? await call("submit_checkin", { stance: t.fight.you.plan.stance === "cover" ? "rush" : "cover", line: "Plan B!" }) : await call("submit_checkin", { keep: true });
      expect(r.isError).toBe(false);
      results.push(r.data.result);
    }
    expect(first).toMatchObject({ status: "checkin", round: 1, tick: 600, atSecond: 10 });
    expect(first.briefing).toContain("ANSWER: call submit_checkin");
    expect(first.briefing).not.toContain("Reply ONLY with JSON");
    expect(results[0]).toBe("update");
    if (results.length > 1) expect(results[1]).toBe("keep");
    const m = [...api.matches.values()][0]!;
    const rec = m.runner!.savedRecord();
    expect(rec.rounds.flatMap((r) => r.planUpdates ?? []).length).toBe(results.filter((x) => x === "update").length);
    expect(hashes(replayMatch(JSON.parse(JSON.stringify(rec))).record)).toEqual(hashes(rec));
    gw.close();
  });
});
