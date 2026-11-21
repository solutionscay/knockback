import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MatchServer } from "../src/server/match-server";
import { Matchmaker, type MatchmakerOptions } from "../src/server/matchmaker";
import { initPhysics } from "../src/sim";

setDefaultTimeout(120_000);
beforeAll(async () => {
  await initPhysics();
});

const SOUL = readFileSync("souls/rat.md", "utf8");
const tmp = () => mkdtempSync(join(tmpdir(), "kb-mm-"));
const agent = (name: string, extra: Record<string, unknown> = {}) => ({ name, persona: SOUL, ...extra });

function setup(opts: MatchmakerOptions = {}, server: ConstructorParameters<typeof MatchServer>[0] = { outDir: tmp() }) {
  const api = new MatchServer(server);
  const mm = new Matchmaker(api, { tickMs: 20, deadlineMs: 4000, ...opts });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, ip = "10.0.0.1") => {
    const res = (await api.handle(new Request(`http://kb.test${path}`, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), ip))!;
    return { status: res.status, data: (await res.json()) as any };
  };
  return { api, mm, call };
}

const until = async (ok: () => boolean, ms = 5000) => {
  for (const t0 = Date.now(); !ok(); ) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await Bun.sleep(10);
  }
};

describe("matchmaker", () => {
  test("nobody queued: nothing runs, however long the lobby waits", async () => {
    const { api, mm } = setup({ fillAfterMs: 0 });
    await Bun.sleep(150); // several ticks
    expect(api.matches.size).toBe(0);
    expect(await api.store.listMatches()).toEqual([]);
    expect(mm.summary()).toMatchObject({ waiting: [], needed: 4, fillsInSec: null, blocked: false });
    mm.close();
  });

  test("4 waiting agents open one match of outside agents, oldest first; the 5th waits; never the same name twice", async () => {
    const { api, mm } = setup({ fillAfterMs: 300_000, maxConcurrent: 2 });
    for (const n of ["Ann", "Bo", "Cy"]) await mm.enqueue(agent(n), `10.0.1.${n.length}`);
    expect(api.matches.size).toBe(0);
    expect(mm.summary()).toMatchObject({ needed: 1, waiting: [{ position: 1, agent: "Ann" }, { position: 2, agent: "Bo" }, { position: 3, agent: "Cy" }] });
    await expect(mm.enqueue(agent("bo"), "10.0.1.9")).rejects.toThrow("already in the queue");
    const d = await mm.enqueue(agent("Di"), "10.0.1.4");
    expect(d.seated).toMatchObject({ seat: 3 });
    const m = [...api.matches.values()][0]!;
    expect(m.kinds).toEqual(["remote", "remote", "remote", "remote"]);
    expect(m.agents.map((a) => a!.name)).toEqual(["Ann", "Bo", "Cy", "Di"]);
    await until(() => m.status !== "open");
    await mm.enqueue(agent("Ed"), "10.0.1.5");
    expect(mm.position("ed")).toBe(1);
    expect(mm.summary().needed).toBe(3);
    mm.close();
  });

  test("one agent waits the fill time: house bots take the empty seats", async () => {
    const { api, mm } = setup({ fillAfterMs: 120 });
    const e = await mm.enqueue(agent("Solo"), "10.0.2.1");
    expect(e.seated).toBeNull(); // not yet: the fill wait runs
    expect(mm.summary().fillsInSec).toBe(1);
    await until(() => !!e.seated);
    expect(api.matches.get(e.seated!.match)!.kinds).toEqual(["remote", "house", "house", "house"]);
    expect(mm.summary()).not.toHaveProperty("roster");
    expect(mm.summary()).not.toHaveProperty("ai");
    mm.close();
  });

  test("minAgents: house bots fill only around enough outside agents", async () => {
    const { api, mm } = setup({ fillAfterMs: 0, minAgents: 2 });
    await mm.enqueue(agent("One"), "10.0.3.1");
    await Bun.sleep(80);
    expect(api.matches.size).toBe(0);
    const two = await mm.enqueue(agent("Two"), "10.0.3.2");
    expect(two.seated).not.toBeNull();
    expect(api.matches.get(two.seated!.match)!.kinds).toEqual(["remote", "remote", "house", "house"]);
    mm.close();
  });

  test("max concurrent: the queue waits while a matchmaker match runs, and starts the next when it ends", async () => {
    const { api, mm } = setup({ fillAfterMs: 0, maxConcurrent: 1 });
    const a = await mm.enqueue(agent("First"), "10.0.4.1");
    const first = api.matches.get(a.seated!.match)!;
    const b = await mm.enqueue(agent("Second"), "10.0.4.2");
    expect(b.seated).toBeNull();
    expect(mm.summary().blocked).toBe(true);
    await until(() => first.status === "over", 60_000); // the silent agent's seat falls back; fast pace
    await until(() => !!b.seated);
    expect(b.seated!.match).not.toBe(first.id);
    mm.close();
  });

  test("rulesets never share a match; the ratings hook chooses who plays with the oldest", async () => {
    const order: MatchmakerOptions["order"] = (_o, c) => [...c].reverse(); // e.g. by rating: the newest first here
    const { api, mm } = setup({ fillAfterMs: 300_000, maxConcurrent: 3, order });
    await api.store.putRulesetPreset("Bat Only", { weapons: { enabled: ["bat"] }, pickups: { enabled: ["health"] } });
    await mm.enqueue(agent("Old"), "10.0.5.1");
    await mm.enqueue(agent("Bat"), "10.0.5.2", "Bat Only");
    for (const n of ["P2", "P3", "P4", "P5"]) await mm.enqueue(agent(n), `10.0.5.${n.length + 3}`);
    const m = [...api.matches.values()][0]!;
    // when P4 arrived: Old + three of the same ruleset in the hook's order (P4, P3, P2); Bat (other ruleset) and P5 wait
    expect(m.agents.map((a) => a!.name)).toEqual(["Old", "P4", "P3", "P2"]);
    expect(mm.waiting().map((e) => e.name)).toEqual(["Bat", "P5"]);
    mm.close();
  });

  test("a queued agent that goes silent is dropped", async () => {
    const { mm } = setup({ fillAfterMs: 300_000, idleMs: 60 });
    await mm.enqueue(agent("Ghost"), "10.0.6.1");
    await until(() => mm.waiting().length === 0);
    mm.close();
  });
});

describe("HTTP queue and GET /api/join", () => {
  test("POST /api/queue -> ticket; long poll -> seated with a working seat token; DELETE leaves", async () => {
    const { mm, call } = setup({ fillAfterMs: 150 });
    const bad = await call("POST", "/api/queue", { name: "x", persona: "short" });
    expect(bad.status).toBe(400);
    const q = await call("POST", "/api/queue", agent("Http", { model: "claude-opus-5-5", line: "Here I am." }));
    expect(q.status).toBe(201);
    expect(q.data).toMatchObject({ status: "queued", agent: "Http", position: 1, needed: 3 });
    expect(q.data.ticket).toMatch(/^qt_[0-9a-f]{24}$/);
    expect((await call("GET", "/api/queue?name=http")).data.you).toEqual({ name: "http", position: 1 });
    const pub = await call("GET", "/api/queue");
    expect(JSON.stringify(pub.data)).not.toContain(q.data.ticket); // tickets stay secret
    const s = await call("GET", `/api/queue/${q.data.ticket}?wait=5`);
    expect(s.data).toMatchObject({ status: "seated", agent: "Http", seat: 0 });
    const turn = await call("GET", `/api/matches/${s.data.match}/turn?wait=0`, undefined, { authorization: `Bearer ${s.data.token}` });
    expect(turn.status).toBe(200);
    expect((await call("GET", `/api/queue/${q.data.ticket}`)).status).toBe(404); // picked up: no longer in the queue
    const r = await call("POST", "/api/queue", agent("Leaver"), {}, "10.0.9.2");
    expect((await call("DELETE", `/api/queue/${r.data.ticket}`)).data).toEqual({ left: true });
    expect(mm.position("Leaver")).toBeNull();
    mm.close();
  });

  test("GET /api/join: the public URL, per-client commands, a ready prompt, the queue and your place", async () => {
    const { mm, call } = setup({ fillAfterMs: 300_000, publicUrl: "https://kb.example.com/" });
    await mm.enqueue(agent("Brixel"), "10.0.10.1");
    const j = (await call("GET", "/api/join?name=Brixel&persona=A%20smug%20sniper")).data;
    expect(j).toMatchObject({ publicUrl: "https://kb.example.com", mcp: "https://kb.example.com/mcp", api: "https://kb.example.com/api", lobby: "https://kb.example.com/lobby", queue: { waiting: 1, needed: 3 }, you: { name: "Brixel", position: 1 } });
    expect(Object.keys(j.clients)).toEqual(["claude", "codex", "grok", "json"]);
    expect(j.clients.claude.setup).toBe("claude mcp add --transport http knockback 'https://kb.example.com/mcp'");
    expect(j.prompt).toContain('join_lobby with name "Brixel"');
    expect(j.prompt).toContain("A smug sniper");
    mm.close();
    // without a configured URL: from the request, honouring the proxy's https
    const other = setup();
    const k = (await other.call("GET", "/api/join", undefined, { "x-forwarded-proto": "https" })).data;
    expect(k.mcp).toBe("https://kb.test/mcp");
    other.mm.close();
  });
});
