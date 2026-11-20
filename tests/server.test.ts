import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seatsFor } from "../src/ai/decide";
import { registerProvider, registerStubs } from "../src/ai/providers";
import { MatchRunner, ResumeError, type RunnerEvent, type StoredRound } from "../src/ai/runner";
import { RateLimiter } from "../src/server/limits";
import { LiveStream } from "../src/server/live";
import { MatchServer } from "../src/server/match-server";
import { checkPlanShape } from "../src/server/remote";
import { SqliteStore } from "../src/server/store";
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

describe("MatchRunner replay (resume)", () => {
  // seeds where the house bot plans in every round (house seats and fallbacks), so its random draws matter
  for (const seed of [3, 77, 2026]) {
    test(`seed ${seed}: replaying stored rounds, then playing on, gives the uninterrupted match`, async () => {
      const lineup = ["stub", "junk", "house", "broken"];
      const stored: StoredRound[] = [];
      const full = new MatchRunner({ seed, seats: seatsFor(lineup, exampleSouls()), onDecided: (_, ask) => void stored.push(JSON.parse(JSON.stringify(ask))) });
      await full.run();
      full.match.record.rounds.forEach((r, i) => (stored[i]!.finalHash = r.fight.finalHash));
      for (let cut = 1; cut < stored.length; cut++) {
        const resumed = new MatchRunner({ seed, seats: seatsFor(lineup, exampleSouls()) });
        resumed.start();
        for (const row of stored.slice(0, cut)) await resumed.replayRound(row);
        await resumed.run();
        expect(hashes(resumed.match.record)).toEqual(hashes(full.match.record));
        expect(resumed.match.record.rounds.map((r) => r.lines)).toEqual(full.match.record.rounds.map((r) => r.lines));
      }
      // a stored hash that the engine doesn't reproduce stops the resume
      const bad = new MatchRunner({ seed, seats: seatsFor(lineup, exampleSouls()) });
      expect(bad.replayRound({ ...stored[0]!, finalHash: "deadbeef" })).rejects.toBeInstanceOf(ResumeError);
    });
  }
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

type Call = ReturnType<typeof client>;
const joinBody = (name: string, extra: Record<string, unknown> = {}) => ({ name, persona: SOUL, ...extra });

/** Long-poll and answer every turn with `answer(turn)` (null: stay silent for that turn) until the match is over. */
async function playSeat(call: Call, mid: string, token: string | undefined, answer: (t: any) => Record<string, unknown> | null, q = "") {
  for (;;) {
    const r = await call("GET", `/api/matches/${mid}/turn?${q}wait=5`, undefined, token);
    if (r.status !== 200) throw new Error(`turn: ${r.status} ${JSON.stringify(r.data)}`);
    const t = r.data;
    if (t.status === "over" || t.status === "left") return t;
    if (t.status !== "turn") continue;
    const body = answer(t);
    if (!body) await Bun.sleep(t.msLeft + 50); // never answer: wait the turn out
    else expect((await call("POST", `/api/matches/${mid}/plan?${q}`, { round: t.round, ...body }, token)).status).toBe(200);
  }
}

test("HTTP ruleset selection stores the preset version and body across a database reopen", async () => {
  const path = join(tmp(), "match-server.db");
  const store = new SqliteStore(path);
  const server = new MatchServer({ store, outDir: tmp() });
  const call = client(server);
  let id: string;
  try {
    expect((await store.defaultRulesetPreset())?.name).toBe("Classic");
    expect((await store.listRulesetPresets()).map(p => p.name)).toEqual(["Classic", "Chaos", "Close Quarters", "Sniper Alley"]);
    await store.putRulesetPreset("Fast Fire", { fire: { spread: 0.18 } });
    await store.setDefaultRulesetPreset("Fast Fire");
    const invalid = await call("POST", "/api/matches", { ruleset: { fire: { spread: 2 } } });
    expect(invalid.status).toBe(400);
    expect(JSON.stringify(invalid.data)).toContain("fire.spread");
    expect((await call("POST", "/api/matches", { ruleset: "Sniper Alley" })).status).toBe(400);
    const named = await call("POST", "/api/matches", { ruleset: "Fast Fire", fillAfterSec: 300 });
    expect(named.status).toBe(201);
    expect(named.data).toMatchObject({ ruleset: "Fast Fire", rulesetVersion: 1 });
    id = named.data.id;
    const byDefault = await call("POST", "/api/matches", { fillAfterSec: 300 });
    expect(byDefault.data).toMatchObject({ ruleset: "Fast Fire", rulesetVersion: 1 });
    const inline = await client(server, "1.2.3.5")("POST", "/api/matches", { ruleset: { fire: { spread: 0.2 } }, fillAfterSec: 300 });
    expect(inline.status).toBe(201);
    expect(inline.data.ruleset).toBe("Custom");
    expect((await store.getMatch(inline.data.id))?.ruleset?.fire.spread).toBe(0.2);
    await store.putRulesetPreset("Fast Fire", { fire: { spread: 0.3 } });
  } finally {
    await store.close();
  }
  const reopened = new SqliteStore(path);
  try {
    expect(await reopened.getMatch(id)).toMatchObject({ preset: "Fast Fire", presetVersion: 1, ruleset: { fire: { spread: 0.18 } } });
    expect(await reopened.defaultRulesetPreset()).toMatchObject({ version: 2, ruleset: { fire: { spread: 0.3 } } });
  } finally {
    await reopened.close();
  }
});

describe("ops", () => {
  test("GET /api/health: ok with the version and match counts, without rate limiting; 503 when the store fails", async () => {
    const s = new MatchServer({ outDir: tmp(), version: "abc123" });
    for (let i = 0; i < 80; i++) await s.handle(new Request("http://kb.test/api/health"), "1.1.1.1"); // more than the per-address burst
    const res = (await s.handle(new Request("http://kb.test/api/health"), "1.1.1.1"))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, version: "abc123", matches: { open: 0, running: 0 }, store: "ok" });
    await s.store.close();
    expect((await s.handle(new Request("http://kb.test/api/health")))!.status).toBe(503);
  });

  test("GET /api/health keeps storage errors in the server log", async () => {
    const detail = "cannot read /example/private/storage.db";
    const store = new SqliteStore(":memory:");
    store.listMatches = async () => {
      throw new Error(detail);
    };
    const logs: string[] = [];
    const s = new MatchServer({ outDir: tmp(), store, log: (message) => logs.push(message) });
    try {
      const res = (await s.handle(new Request("http://kb.test/api/health")))!;
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false, error: "storage unavailable" });
      expect(logs.join("\n")).toContain(detail);
    } finally {
      await store.close();
    }
  });

  test("GET /lobby is the landing page; /api/live without ?match prefers the newest started match", async () => {
    const s = new MatchServer({ outDir: tmp(), defaultFillAfterMs: 300_000 });
    const lobby = (await s.handle(new Request("http://kb.test/lobby")))!;
    expect(lobby.headers.get("content-type")).toContain("text/html");
    const html = await lobby.text();
    expect(html).toContain('src="/?live"');
    expect(html).toContain("/api/matches");
    const played = await s.createMatch({ seats: ["remote", "house", "house", "house"], seed: 3 });
    await played.start(); // nobody joined: house bots
    for (let i = 0; i < 400 && played.status !== "over"; i++) await Bun.sleep(25);
    const open = await s.createMatch({ seats: ["remote", "remote", "house", "house"] }); // newer, but not started
    const res = (await s.handle(new Request("http://kb.test/api/live")))!;
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    reader.cancel();
    expect(first).toContain(`"seed":3`);
    expect(open.status).toBe("open");
    await open.start();
  });

  test("the live stream sends an SSE comment while someone watches", async () => {
    const live = new LiveStream(64, 20);
    live.broadcast({ type: "match" });
    const reader = live.response().body!.getReader();
    let text = "";
    while (!text.includes(": ping")) text += new TextDecoder().decode((await reader.read()).value);
    expect(text.startsWith('data: {"type":"match"}')).toBe(true);
    reader.cancel();
    live.close();
  });
});

describe("match server API", () => {
  test("rejects bad input with clear errors", async () => {
    const s = new MatchServer({ outDir: tmp() });
    const call = client(s);
    const m = await call("POST", "/api/matches", { fillAfterSec: 300 });
    const J = `/api/matches/${m.data.id}/join`;
    expect((await call("POST", J, { name: "", persona: SOUL })).data.problems.join()).toContain("name");
    expect((await call("POST", J, { name: "Ok", persona: "short" })).data.problems.join()).toContain("persona");
    expect((await call("POST", J, joinBody("Ok", { look: { hat: "big" } }))).data.problems.join()).toContain("look.hat");
    expect((await call("POST", J, joinBody("Ok", { admin: true }))).status).toBe(400);
    expect((await call("POST", J, joinBody("Ok", { seat: 9 }))).status).toBe(400);
    expect((await call("POST", J, undefined, undefined, { text: "{nope" })).status).toBe(400);
    expect((await call("POST", J, undefined, undefined, { type: "text/plain", text: "{}" })).status).toBe(415);
    expect((await call("POST", J, undefined, undefined, { text: JSON.stringify({ name: "Big", persona: "x".repeat(20_000) }) })).status).toBe(413);
    expect((await call("POST", J, undefined, undefined, { text: "[1,2]" })).status).toBe(400);
    expect((await call("POST", "/api/agents", joinBody("Old"))).status).toBe(410); // registration is gone
    expect((await call("POST", "/api/matches", { seats: ["house", "house", "house", "house"] })).data.problems.join()).toContain("remote");
    expect((await call("POST", "/api/matches", { seats: ["remote", "claude", "house", "house"] })).status).toBe(400); // no local AI over HTTP
    expect((await call("POST", "/api/matches", { deadlineSec: 999 })).data.problems.join()).toContain("deadlineSec");
    expect((await call("GET", "/api/matches/m_nope")).status).toBe(404);
    expect((await call("GET", "/api/nope")).status).toBe(404);
    const a = await call("POST", J, joinBody("Agent 1", { look: { color: "#ff8800" } }));
    expect(a.status).toBe(201);
    expect(a.data.token).toMatch(/^st_[0-9a-f]{48}$/);
    expect(s.matches.get(m.data.id)!.agents[a.data.seat]!.tokenHash).not.toContain(a.data.token.slice(3)); // only the hash is kept
    expect((await call("GET", `/api/matches/${m.data.id}/turn?wait=0`)).status).toBe(401); // no token
    expect((await call("GET", `/api/matches/${m.data.id}/turn?wait=0&seat=0`)).status).toBe(401); // ?seat only in open mode
    expect((await call("GET", `/api/matches/${m.data.id}/turn?wait=0`, undefined, "st_wrong")).status).toBe(401);
    expect((await call("GET", `/api/matches/${m.data.id}/turn?wait=0`, undefined, a.data.token)).data.status).toBe("open");
    expect((await call("GET", "/api")).data.endpoints["POST /api/matches/:id/leave"]).toBeDefined();
    s.matches.get(m.data.id)!.start(); // don't leave the fill timer running
  });

  test("rate limits per address", async () => {
    const s = new MatchServer({ outDir: tmp() });
    const call = client(s, "9.9.9.9");
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await s.createMatch({ fillAfterMs: 300_000 })).id);
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await call("POST", `/api/matches/${ids[i % 4]}/join`, joinBody(`A${i}`))).status);
    expect(codes.slice(0, 8).every((c) => c === 201)).toBe(true);
    expect(codes[8]).toBe(429); // 8 seats per address
    for (const m of s.matches.values()) m.start();
  });

  test("per-address cap on open matches", async () => {
    const s = new MatchServer({ outDir: tmp() });
    const call = client(s, "7.7.7.7");
    expect((await call("POST", "/api/matches", { fillAfterSec: 300 })).status).toBe(201);
    expect((await call("POST", "/api/matches", { fillAfterSec: 300 })).status).toBe(201);
    expect((await call("POST", "/api/matches", { fillAfterSec: 300 })).status).toBe(429);
    for (const m of s.matches.values()) m.start();
  });

  test("a full match: 2 agents plan, 1 never answers, 1 house bot; tokens and plans are checked; the record replays", async () => {
    const out = tmp();
    const s = new MatchServer({ outDir: out });
    const call = client(s);
    const m = (await call("POST", "/api/matches", { seats: ["remote", "remote", "remote", "house"], seed: 31337, deadlineSec: 2, fillAfterSec: 30 })).data;
    const other = await s.createMatch({ seats: ["remote", "remote", "house", "house"], fillAfterMs: 300_000 });
    const otherToken = (await call("POST", `/api/matches/${other.id}/join`, joinBody("Elsewhere"))).data.token;
    const tokens: string[] = [];
    for (const n of ["Planner", "Answerer", "Silent"]) tokens.push((await call("POST", `/api/matches/${m.id}/join`, joinBody(n))).data.token);
    expect((await call("POST", `/api/matches/${m.id}/join`, joinBody("Late"))).status).toBe(409);
    const seen = { rejected: [] as number[], rounds: 0 };
    const planner = async () => {
      for (;;) {
        const t = (await call("GET", `/api/matches/${m.id}/turn?wait=5`, undefined, tokens[0])).data;
        if (t.status === "over") return t;
        if (t.status !== "turn") continue;
        expect(t.context.you.seat).toBe(0);
        expect(t.prompt).toContain(`You are ${t.context.you.name}`);
        expect(t.schema.stance.values).toContain("rush");
        if (t.round > 1) expect(t.context.lastRound.whatHappenedToYou.length).toBeGreaterThan(0);
        // a plan with no token, another seat's token, or another match's token is refused
        expect((await call("POST", `/api/matches/${m.id}/plan`, { round: t.round, ...PLAN })).status).toBe(401);
        expect((await call("POST", `/api/matches/${m.id}/plan`, { round: t.round, ...PLAN }, otherToken)).status).toBe(401);
        // bad plans: unknown stance, a bad rule, the wrong round; then a good one
        seen.rejected.push((await call("POST", `/api/matches/${m.id}/plan`, { round: t.round, ...PLAN, stance: "dance" }, tokens[0])).status);
        seen.rejected.push((await call("POST", `/api/matches/${m.id}/plan`, { round: t.round, ...PLAN, rules: [{ when: "moon", do: "seek" }] }, tokens[0])).status);
        seen.rejected.push((await call("POST", `/api/matches/${m.id}/plan`, { round: t.round + 1, ...PLAN }, tokens[0])).status);
        const ok = await call("POST", `/api/matches/${m.id}/plan`, { round: t.round, ...PLAN, target: t.context.targets[0] }, tokens[0]);
        expect(ok.status).toBe(200);
        expect(ok.data.plan.target).toBe(t.context.targets[0]);
        seen.rejected.push((await call("POST", `/api/matches/${m.id}/plan`, { round: t.round, ...PLAN }, tokens[0])).status); // already planned
        seen.rounds++;
      }
    };
    const raw = 'Sure:\n```json\n{"weapons":["shotgun"],"target":"nearest","stance":"cover","line":"Raw reply works."}\n```';
    const [a, , c] = await Promise.all([planner(), playSeat(call, m.id, tokens[1], () => ({ answer: raw })), playSeat(call, m.id, tokens[2], () => null)]);
    expect(a.record).toMatch(/^\/records\/remote-31337-/);
    expect(c.winner).toBe(a.winner);
    for (let k = 0; k < 4; k++) expect(seen.rejected.filter((_, i) => i % 4 === k)).toEqual(Array(seen.rounds).fill([422, 422, 409, 409][k]));
    // after the end the token still reads the result
    expect((await call("GET", `/api/matches/${m.id}/turn?wait=0`, undefined, tokens[0])).data.status).toBe("over");

    const rep = (await call("GET", `/api/matches/${m.id}/report`)).data;
    expect(rep.status).toBe("over");
    expect(rep.rounds.length).toBe(seen.rounds);
    for (const r of rep.rounds) {
      expect(r.plans.map((p: any) => p.meta.outcome).filter((_: unknown, i: number) => i !== 2)).toEqual(["ok", "ok", "house"]);
      expect(["fallback-timeout", "fallback-error"]).toContain(r.plans[2].meta.outcome); // missed deadline -> autopilot (#22)
      expect(r.plans[0].meta.provider).toBe("remote/Planner");
      expect(r.plans[1].line).toBe("Raw reply works.");
    }
    expect((await call("GET", `/api/matches/${m.id}/report?round=1`)).data.rounds.length).toBe(1);
    const rec = JSON.parse(readFileSync(join(out, a.record.replace("/records/", "")), "utf8"));
    expect(hashes(replayMatch(rec).record)).toEqual(hashes(rec));
    expect(rec.labels).toEqual(["remote/Planner", "remote/Answerer", "remote/Silent", "house"]);
    expect(rec.souls[0].id).toBe("planner");
    other.start();
  });

  test("open mode: no token needed, the seat is named with ?seat=N; a token still works", async () => {
    const s = new MatchServer({ outDir: tmp(), open: true });
    const call = client(s);
    const m = await s.createMatch({ seats: ["remote", "remote", "house", "house"], seed: 8, deadlineMs: 2000, fillAfterMs: 30_000 });
    const a = (await call("POST", `/api/matches/${m.id}/join`, joinBody("NoToken"))).data;
    const b = (await call("POST", `/api/matches/${m.id}/join`, joinBody("WithToken"))).data;
    expect((await call("GET", `/api/matches/${m.id}/turn?wait=0`)).status).toBe(400); // which seat?
    const [x] = await Promise.all([playSeat(call, m.id, undefined, () => PLAN, `seat=${a.seat}&`), playSeat(call, m.id, b.token, () => PLAN)]);
    expect(x.status).toBe("over");
    expect(m.runner!.match.record.rounds.every((r) => r.meta!.slice(0, 2).every((mm) => mm.outcome === "ok"))).toBe(true);
  });

  test("leave: before the start the seat is free again; mid-match the house bot plays it from the next turn", async () => {
    const s = new MatchServer({ outDir: tmp() });
    const call = client(s);
    const m = await s.createMatch({ seats: ["remote", "remote", "house", "house"], seed: 21, deadlineMs: 3000, fillAfterMs: 30_000 });
    const early = (await call("POST", `/api/matches/${m.id}/join`, joinBody("Early"))).data;
    expect((await call("POST", `/api/matches/${m.id}/leave`, undefined, early.token)).data).toEqual({ seat: 0, status: "open", houseFromRound: null });
    expect((await call("GET", `/api/matches/${m.id}/turn?wait=0`, undefined, early.token)).status).toBe(401); // token gone
    const stay = (await call("POST", `/api/matches/${m.id}/join`, joinBody("Stayer"))).data;
    const quit = (await call("POST", `/api/matches/${m.id}/join`, joinBody("Quitter"))).data;
    expect(stay.seat).toBe(0); // the freed seat
    const quitter = async () => {
      for (;;) {
        const t = (await call("GET", `/api/matches/${m.id}/turn?wait=5`, undefined, quit.token)).data;
        if (t.status !== "turn") continue;
        if (t.round === 1) {
          expect((await call("POST", `/api/matches/${m.id}/plan`, { round: 1, ...PLAN }, quit.token)).status).toBe(200);
          continue;
        }
        const l = await call("POST", `/api/matches/${m.id}/leave`, undefined, quit.token); // during round 2's turn
        expect(l.data).toEqual({ seat: 1, status: "running", houseFromRound: 2 });
        expect((await call("POST", `/api/matches/${m.id}/plan`, { round: 2, ...PLAN }, quit.token)).status).toBe(409);
        expect((await call("GET", `/api/matches/${m.id}/turn?wait=0`, undefined, quit.token)).data.status).toBe("left");
        return;
      }
    };
    const t0 = Date.now();
    await Promise.all([playSeat(call, m.id, stay.token, () => PLAN), quitter()]);
    const meta = m.runner!.match.record.rounds.map((r) => r.meta![1]!);
    expect(meta[0]!.outcome).toBe("ok");
    expect(meta.slice(1).every((x) => x.outcome === "fallback-error" && x.detail === "the agent left the match")).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3000 * meta.length); // leaving doesn't wait out the deadline
    expect(m.info().seats[1]).toMatchObject({ agent: "Quitter", houseFromRound: 2 });
  });

  test("a remote plan plays exactly like the same answer from a local provider", async () => {
    const answer = JSON.stringify(PLAN);
    registerProvider("fixedplan", { label: "fixed/test", ask: async () => answer });
    const s = new MatchServer({ outDir: tmp() });
    const call = client(s);
    const m = await s.createMatch({ seats: ["house", "remote", "house", "house"], seed: 99, deadlineMs: 5000, fillAfterMs: 30_000 });
    const a = (await call("POST", `/api/matches/${m.id}/join`, joinBody("Same"))).data;
    await playSeat(call, m.id, a.token, () => PLAN);
    const remote = m.runner!.match.record;
    const souls = exampleSouls();
    souls[1] = m.runner!.match.opts.souls![1]!;
    const local = new MatchRunner({ seed: 99, seats: seatsFor(["house", "fixedplan", "house", "house"], souls) });
    await local.run();
    expect(hashes(remote)).toEqual(hashes(local.match.record));
    expect(remote.rounds.map((r) => r.strategies)).toEqual(local.match.record.rounds.map((r) => r.strategies));
  });

  test("storage: an open match and its seat tokens survive a restart; a finished match's report loads from storage", async () => {
    const dir = tmp();
    const db = join(dir, "server.db");
    const a = new MatchServer({ outDir: dir, store: new SqliteStore(db) });
    const m = await a.createMatch({ seats: ["remote", "remote", "house", "house"], seed: 61, deadlineMs: 2000, fillAfterMs: 300_000 });
    const first = (await client(a)("POST", `/api/matches/${m.id}/join`, joinBody("Before"))).data;
    await a.store.close(); // the old server is gone (its fill timer would never fire in a dead process)

    const b = new MatchServer({ outDir: dir, store: new SqliteStore(db) });
    expect(await b.resume()).toEqual({ open: [m.id], running: [] });
    const call = client(b);
    expect((await call("GET", `/api/matches/${m.id}/turn?wait=0`, undefined, first.token)).data.status).toBe("open"); // same token
    const second = (await call("POST", `/api/matches/${m.id}/join`, joinBody("After"))).data;
    expect(second.seat).toBe(1);
    await Promise.all([playSeat(call, m.id, first.token, () => PLAN), playSeat(call, m.id, second.token, () => PLAN)]);
    const played = b.matches.get(m.id)!.runner!.match.record;
    await b.store.close();

    const c = new MatchServer({ outDir: dir, store: new SqliteStore(db) });
    expect(await c.resume()).toEqual({ open: [], running: [] });
    // three requests at once load (replay) the finished match once
    const loads: string[] = [];
    const orig = c.store.listRounds.bind(c.store);
    c.store.listRounds = (id: string) => (loads.push(id), orig(id));
    const reps = await Promise.all([0, 1, 2].map(() => client(c)("GET", `/api/matches/${m.id}/report`)));
    expect(reps.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(loads).toEqual([m.id]);
    const rep = reps[0]!.data;
    expect(rep.status).toBe("over");
    expect(rep.rounds.map((r: any) => r.result.finalHash)).toEqual(hashes(played));
    expect(rep.record).toMatch(/^\/records\/remote-61-/);
    expect((await client(c)("GET", `/api/matches/${m.id}/turn?wait=0`, undefined, first.token)).data.status).toBe("over");
    expect((await client(c)("GET", "/api/records")).data.records[0].hashes).toEqual(hashes(played));
    await c.store.close();
  });

  test("empty remote seats get the house bot when the fill timer ends; the live stream replays history", async () => {
    const s = new MatchServer({ outDir: tmp(), defaultFillAfterMs: 50 });
    const m = await s.createMatch({ seats: ["remote", "remote", "house", "house"], seed: 5 });
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
