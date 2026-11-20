import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seatsFor } from "../src/ai/decide";
import { registerProvider, registerStubs } from "../src/ai/providers";
import { MatchRunner, type RunnerEvent } from "../src/ai/runner";
import { RateLimiter } from "../src/server/limits";
import { MatchServer } from "../src/server/match-server";
import { checkPlanShape } from "../src/server/remote";
import { exampleSouls, initPhysics, replayMatch } from "../src/sim";

setDefaultTimeout(120_000);
beforeAll(async () => {
  await initPhysics();
  registerStubs(5);
});

const SOUL = readFileSync("souls/rat.md", "utf8");
const hashes = (rec: { rounds: { fight: { finalHash: string } }[] }) => rec.rounds.map((r) => r.fight.finalHash);
const tmp = () => mkdtempSync(join(tmpdir(), "kb-server-"));

function client(server: MatchServer, ip = "1.2.3.4") {
  return async (method: string, path: string, body?: unknown, key?: string, raw?: { type?: string; text?: string }) => {
    const headers: Record<string, string> = {};
    if (body !== undefined || raw) headers["content-type"] = raw?.type ?? "application/json";
    if (key) headers.authorization = `Bearer ${key}`;
    const res = (await server.handle(new Request(`http://kb.test${path}`, { method, headers, ...(body !== undefined || raw ? { body: raw?.text ?? JSON.stringify(body) } : {}) }), ip))!;
    return { status: res.status, data: res.headers.get("content-type")?.includes("json") ? ((await res.json()) as any) : null };
  };
}

const PLAN = { weapons: ["rocket", "bat"], target: "weakest", stance: "rush", retaliate: "attacker", rules: [{ when: "my_health_below", value: 30, do: "seek", item: "health", label: "patch up" }], why: "rush the weak one", line: "Coming through!" };

describe("MatchRunner", () => {
  test("plays a match with mixed seats, emits match, decisions, round and done in order, and the record replays", async () => {
    const souls = exampleSouls();
    const events: RunnerEvent[] = [];
    const r = new MatchRunner({ seed: 77, seats: seatsFor(["stub", "junk", "house", "broken"], souls), onEvent: (e) => events.push(e) });
    const m = await r.run();
    const file = r.save(tmp(), "test");
    expect(m.over).toBe(true);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("match");
    expect(types.at(-1)).toBe("done");
    expect(types.filter((t) => t === "decisions").length).toBe(m.round);
    expect(types.filter((t) => t === "round").length).toBe(m.round);
    expect(r.match.record.rounds[0]!.meta!.map((x) => x.outcome)).toEqual(["ok", "fallback-invalid", "house", "fallback-error"]);
    expect(file).toMatch(/^test-77-.*\.json$/);
    expect(hashes(replayMatch(r.savedRecord()).record)).toEqual(hashes(r.match.record));
    expect(r.log.some((l) => l.startsWith("MATCH: "))).toBe(true);
  });
});

describe("plan shape", () => {
  test("unknown fields, wrong types and answer mixed with fields are rejected before parsing", () => {
    expect(checkPlanShape({ round: 1, ...PLAN })).toEqual([]);
    expect(checkPlanShape({ round: 1, ...PLAN, hack: 1 }).join()).toContain("unknown field");
    expect(checkPlanShape({ ...PLAN }).join()).toContain("round");
    expect(checkPlanShape({ round: 1, ...PLAN, weapons: "rocket" }).join()).toContain("weapons");
    expect(checkPlanShape({ round: 1, ...PLAN, line: "" }).join()).toContain("line");
    expect(checkPlanShape({ round: 1, answer: "x", stance: "rush" }).join()).toContain("not both");
    expect(checkPlanShape({ round: 1, ...PLAN, rules: [{ when: "x".repeat(100), do: "seek" }] }).join()).toContain("rule 1");
  });
});

describe("rate limiter", () => {
  test("burst, then 429 with retry-after, then refill", () => {
    let now = 0;
    const rl = new RateLimiter(2, 1, () => now);
    rl.take("a");
    rl.take("a");
    expect(() => rl.take("a")).toThrow(/too many/);
    rl.take("b");
    now = 1000;
    rl.take("a");
  });
});

describe("match server API", () => {
  test("rejects bad input with clear errors", async () => {
    const s = new MatchServer({ outDir: tmp() });
    const call = client(s);
    expect((await call("POST", "/api/agents", { name: "", persona: SOUL })).data.problems.join()).toContain("name");
    expect((await call("POST", "/api/agents", { name: "Ok", persona: "short" })).data.problems.join()).toContain("persona");
    expect((await call("POST", "/api/agents", { name: "Ok", persona: SOUL, look: { hat: "big" } })).data.problems.join()).toContain("look.hat");
    expect((await call("POST", "/api/agents", { name: "Ok", persona: SOUL, admin: true })).status).toBe(400);
    expect((await call("POST", "/api/agents", undefined, undefined, { text: "{nope" })).status).toBe(400);
    expect((await call("POST", "/api/agents", undefined, undefined, { type: "text/plain", text: "{}" })).status).toBe(415);
    expect((await call("POST", "/api/agents", undefined, undefined, { text: JSON.stringify({ name: "Big", persona: "x".repeat(20_000) }) })).status).toBe(413);
    expect((await call("POST", "/api/agents", undefined, undefined, { text: "[1,2]" })).status).toBe(400);
    expect((await call("GET", "/api/agents")).status).toBe(405);
    expect((await call("POST", "/api/matches", { seats: ["house", "house", "house", "house"] })).data.problems.join()).toContain("remote");
    expect((await call("POST", "/api/matches", { seats: ["remote", "claude", "house", "house"] })).status).toBe(400); // no local AI over HTTP
    expect((await call("POST", "/api/matches", { deadlineSec: 999 })).data.problems.join()).toContain("deadlineSec");
    expect((await call("GET", "/api/matches/m_nope")).status).toBe(404);
    expect((await call("GET", "/api/nope")).status).toBe(404);
    const m = await call("POST", "/api/matches", { fillAfterSec: 300 });
    expect((await call("POST", `/api/matches/${m.data.id}/join`, {}, "kb_wrong")).status).toBe(401);
    const a = await call("POST", "/api/agents", { name: "Agent 1", persona: SOUL, look: { color: "#ff8800" } });
    expect(a.status).toBe(201);
    expect(a.data.look).toEqual({ color: 0xff8800 });
    expect((await call("GET", `/api/matches/${m.data.id}/turn?wait=0`, undefined, a.data.key)).status).toBe(403);
    expect((await call("POST", `/api/matches/${m.data.id}/join`, { seat: 9 }, a.data.key)).status).toBe(400);
    expect((await call("GET", "/api")).data.endpoints["POST /api/agents"]).toBeDefined();
    s.matches.get(m.data.id)!.start(); // don't leave the fill timer running
  });

  test("rate limits per address", async () => {
    const s = new MatchServer({ outDir: tmp() });
    const call = client(s, "9.9.9.9");
    const codes: number[] = [];
    for (let i = 0; i < 15; i++) codes.push((await call("POST", "/api/agents", { name: `A${i}`, persona: SOUL })).status);
    expect(codes.slice(0, 10).every((c) => c === 201)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });

  test("per-address caps: agents (idle ones expire) and open matches", async () => {
    const s = new MatchServer({ outDir: tmp() });
    for (let i = 0; i < 20; i++) s.register({ name: `A${i}`, persona: SOUL }, "5.5.5.5");
    expect(() => s.register({ name: "A21", persona: SOUL }, "5.5.5.5")).toThrow(/per address/);
    s.register({ name: "Other", persona: SOUL }, "6.6.6.6");
    for (const a of s.agents.values()) a.lastSeen -= 31 * 60_000;
    s.register({ name: "A21", persona: SOUL }, "5.5.5.5"); // the idle ones were pruned
    expect(s.agents.size).toBe(1);
    const call = client(s, "7.7.7.7");
    expect((await call("POST", "/api/matches", { fillAfterSec: 300 })).status).toBe(201);
    expect((await call("POST", "/api/matches", { fillAfterSec: 300 })).status).toBe(201);
    expect((await call("POST", "/api/matches", { fillAfterSec: 300 })).status).toBe(429);
    for (const m of s.matches.values()) m.start();
  });

  test("a full match: 2 agents plan, 1 never answers, 1 house bot; plans are validated; the record replays", async () => {
    const out = tmp();
    const s = new MatchServer({ outDir: out });
    const call = client(s);
    const m = (await call("POST", "/api/matches", { seats: ["remote", "remote", "remote", "house"], seed: 31337, deadlineSec: 2, fillAfterSec: 30 })).data;
    const keys: string[] = [];
    for (const n of ["Planner", "Answerer", "Silent"]) {
      const a = await call("POST", "/api/agents", { name: n, persona: SOUL });
      keys.push(a.data.key);
    }
    expect((await call("GET", `/api/matches/${m.id}/turn?wait=0`, undefined, keys[0])).status).toBe(403);
    for (const k of keys) expect((await call("POST", `/api/matches/${m.id}/join`, {}, k)).status).toBe(200);
    expect((await call("POST", `/api/matches/${m.id}/join`, {}, keys[0])).status).toBe(409);
    const seen = { rejected: [] as number[], rounds: 0 };
    const planner = async () => {
      for (;;) {
        const t = (await call("GET", `/api/matches/${m.id}/turn?wait=5`, undefined, keys[0])).data;
        if (t.status === "over") return t;
        if (t.status !== "turn") continue;
        expect(t.context.you.seat).toBe(0);
        expect(t.prompt).toContain(`You are ${t.context.you.name}`);
        expect(t.schema.stance.values).toContain("rush");
        if (t.round > 1) expect(t.context.lastRound.whatHappenedToYou.length).toBeGreaterThan(0);
        // bad plans first: unknown stance, a bad rule, the wrong round; then a good one
        seen.rejected.push((await call("POST", `/api/matches/${m.id}/plan`, { round: t.round, ...PLAN, stance: "dance" }, keys[0])).status);
        seen.rejected.push((await call("POST", `/api/matches/${m.id}/plan`, { round: t.round, ...PLAN, rules: [{ when: "moon", do: "seek" }] }, keys[0])).status);
        seen.rejected.push((await call("POST", `/api/matches/${m.id}/plan`, { round: t.round + 1, ...PLAN }, keys[0])).status);
        const ok = await call("POST", `/api/matches/${m.id}/plan`, { round: t.round, ...PLAN, target: t.context.targets[0] }, keys[0]);
        expect(ok.status).toBe(200);
        expect(ok.data.plan.target).toBe(t.context.targets[0]);
        seen.rejected.push((await call("POST", `/api/matches/${m.id}/plan`, { round: t.round, ...PLAN }, keys[0])).status); // already planned
        seen.rounds++;
      }
    };
    const answerer = async () => {
      for (;;) {
        const t = (await call("GET", `/api/matches/${m.id}/turn?wait=5`, undefined, keys[1])).data;
        if (t.status === "over") return t;
        if (t.status !== "turn") continue;
        const r = await call("POST", `/api/matches/${m.id}/plan`, { round: t.round, answer: 'Sure:\n```json\n{"weapons":["shotgun"],"target":"nearest","stance":"cover","line":"Raw reply works."}\n```' }, keys[1]);
        expect(r.status).toBe(200);
      }
    };
    const silent = async () => {
      for (;;) {
        const t = (await call("GET", `/api/matches/${m.id}/turn?wait=5`, undefined, keys[2])).data;
        if (t.status === "over") return t;
        if (t.status === "turn") await Bun.sleep(t.msLeft + 50); // never answer: wait the turn out
      }
    };
    const [a, , c] = await Promise.all([planner(), answerer(), silent()]);
    expect(a.record).toMatch(/^\/records\/remote-31337-/);
    expect(c.winner).toBe(a.winner);
    expect(seen.rejected.filter((x, i) => i % 4 === 0)).toEqual(Array(seen.rounds).fill(422));
    expect(seen.rejected.filter((x, i) => i % 4 === 1)).toEqual(Array(seen.rounds).fill(422));
    expect(seen.rejected.filter((x, i) => i % 4 === 2)).toEqual(Array(seen.rounds).fill(409));
    expect(seen.rejected.filter((x, i) => i % 4 === 3)).toEqual(Array(seen.rounds).fill(409));

    const rep = (await call("GET", `/api/matches/${m.id}/report`)).data;
    expect(rep.status).toBe("over");
    expect(rep.rounds.length).toBe(seen.rounds);
    for (const r of rep.rounds) {
      expect(r.plans.map((p: any) => p.meta.outcome)).toEqual(["ok", "ok", "fallback-timeout", "house"]);
      expect(r.plans[0].meta.provider).toBe("remote/Planner");
      expect(r.plans[1].line).toBe("Raw reply works.");
    }
    expect((await call("GET", `/api/matches/${m.id}/report?round=1`)).data.rounds.length).toBe(1);

    // the saved record replays with no network, hash for hash
    const rec = JSON.parse(readFileSync(join(out, a.record.replace("/records/", "")), "utf8"));
    expect(hashes(replayMatch(rec).record)).toEqual(hashes(rec));
    expect(rec.labels).toEqual(["remote/Planner", "remote/Answerer", "remote/Silent", "house"]);
    expect(rec.souls[0].id).toBe("planner");
  });

  test("a remote plan plays exactly like the same answer from a local provider", async () => {
    const answer = JSON.stringify(PLAN);
    registerProvider("fixedplan", { label: "fixed/test", ask: async () => answer });
    const s = new MatchServer({ outDir: tmp() });
    const call = client(s);
    const m = (await call("POST", "/api/matches", { seats: ["house", "remote", "house", "house"], seed: 99, deadlineSec: 5, fillAfterSec: 30 })).data;
    const a = (await call("POST", "/api/agents", { name: "Same", persona: SOUL })).data;
    await call("POST", `/api/matches/${m.id}/join`, {}, a.key);
    for (;;) {
      const t = (await call("GET", `/api/matches/${m.id}/turn?wait=5`, undefined, a.key)).data;
      if (t.status === "over") break;
      if (t.status === "turn") expect((await call("POST", `/api/matches/${m.id}/plan`, { round: t.round, ...PLAN }, a.key)).status).toBe(200);
    }
    const remote = s.matches.get(m.id)!.runner!.match.record;
    const souls = exampleSouls();
    souls[1] = s.matches.get(m.id)!.runner!.match.opts.souls![1]!;
    const local = new MatchRunner({ seed: 99, seats: seatsFor(["house", "fixedplan", "house", "house"], souls) });
    await local.run();
    expect(hashes(remote)).toEqual(hashes(local.match.record));
    expect(remote.rounds.map((r) => r.strategies)).toEqual(local.match.record.rounds.map((r) => r.strategies));
  });

  test("empty remote seats get the house bot when the fill timer ends; the live stream replays history", async () => {
    const s = new MatchServer({ outDir: tmp(), defaultFillAfterMs: 50 });
    const m = s.createMatch({ seats: ["remote", "remote", "house", "house"], seed: 5 });
    for (let i = 0; i < 400 && m.status !== "over"; i++) await Bun.sleep(25);
    expect(m.status).toBe("over");
    expect(m.info().seats.map((x) => x.kind)).toEqual(["house", "house", "house", "house"]);
    const res = (await s.handle(new Request(`http://kb.test/api/live?match=${m.id}`)))!;
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes('"type":"done"')) text += new TextDecoder().decode((await reader.read()).value);
    reader.cancel();
    expect(text.indexOf('"type":"match"')).toBeLessThan(text.indexOf('"type":"decisions"'));
  });
});
