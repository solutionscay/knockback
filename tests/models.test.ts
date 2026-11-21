/** Model spotlight: who plays each seat, model stats over records, GET /api/models, /models, the badge. */
import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seatsFor } from "../src/ai/decide";
import { registerStubs } from "../src/ai/providers";
import { MatchRunner } from "../src/ai/runner";
import { MatchServer } from "../src/server/match-server";
import { SqliteStore } from "../src/server/store";
import { exampleSouls, initPhysics } from "../src/sim";
import { Match } from "../src/sim/match";
import { ENGINE_VERSION } from "../src/sim/engine-version";
import { CLASSIC } from "../src/sim/ruleset";
import {
  dedupe,
  fightStatsOf,
  headToHead,
  isRealAi,
  leaderboard,
  leaderboardText,
  matchKey,
  modelOf,
  prettyModel,
  remoteLabel,
  seatEntries,
  wilson,
  type SeatEntry,
} from "../src/stats/models";
import { modelBadgeHtml } from "../src/viewer/model-badge";

setDefaultTimeout(120_000);
beforeAll(async () => {
  await initPhysics();
  registerStubs(5);
});

const SOUL = readFileSync("souls/rat.md", "utf8");
const tmp = () => mkdtempSync(join(tmpdir(), "kb-models-"));

/** A finished house-bot match with the given labels and its fight stats, as saved. */
function played(seed: number, labels: string[]) {
  const m = new Match(seed);
  m.playToEnd();
  return { m, rec: { ...JSON.parse(JSON.stringify(m.record)), labels, totalMs: seed * 10, fightStats: fightStatsOf(m.facts) } };
}

describe("modelOf: who plays a seat", () => {
  test("provider labels, house, test stubs", () => {
    expect(modelOf("claude/haiku")).toMatchObject({ key: "claude-haiku", name: "CLAUDE HAIKU", provider: "anthropic", selfReported: false });
    expect(modelOf("codex/gpt-6-luna")).toMatchObject({ key: "gpt-6-luna", name: "GPT-6 LUNA (CODEX)", provider: "openai" });
    expect(modelOf("grok/grok-4.6")).toMatchObject({ key: "grok-4-6", name: "GROK 4.6", provider: "xai" });
    expect(modelOf("house")).toMatchObject({ key: "house", name: "HOUSE BOT", provider: "house" });
    expect(modelOf(null).name).toBe("HOUSE BOT");
    expect(modelOf("stub/test")).toMatchObject({ name: "STUB (TEST)", test: true });
  });

  test("remote agents: shown as reported, marked self-reported; without a model, not guessed", () => {
    const m = modelOf(remoteLabel("Zapbit", "claude-opus-5-5"));
    expect(m).toMatchObject({ key: "self:claude-opus-5-5", name: "CLAUDE OPUS 5.5", provider: "anthropic", selfReported: true, agent: "Zapbit" });
    expect(modelOf(remoteLabel("Other", "Claude Opus 5.5")).key).toBe(m.key); // same claim, same row
    expect(modelOf(remoteLabel("G", "grok-4.6")).provider).toBe("xai");
    expect(modelOf(remoteLabel("Steady"))).toMatchObject({ key: "remote:unreported", name: "MODEL NOT REPORTED", selfReported: false });
    expect(prettyModel("gpt-6-luna")).toBe("GPT-6 LUNA");
    expect(prettyModel("anthropic/claude-sonnet-5-5")).toBe("CLAUDE SONNET 5.5");
  });

  test("the badge escapes what it shows and marks self-reported claims", () => {
    const h = modelBadgeHtml("remote/X@<script>", "lg");
    expect(h).not.toContain("<script>");
    expect(h).toContain("SELF-REPORTED");
    expect(modelBadgeHtml("claude/haiku", "sm")).toContain("CLAUDE HAIKU");
    expect(modelBadgeHtml("claude/haiku")).not.toContain("SELF-REPORTED");
  });
});

describe("model stats over records", () => {
  test("fight stats come from the round facts and add up", () => {
    const { m } = played(41, ["house", "house", "house", "house"]);
    const fs = fightStatsOf(m.facts);
    expect(fs.rounds.length).toBe(m.facts.length);
    m.facts.forEach((f, r) => {
      const seats = fs.rounds[r]!.seats;
      expect(seats.reduce((a, s) => a + s.kos, 0)).toBe(f.fighters.reduce((a, x) => a + x.kosDealt.length, 0));
      for (const s of seats) expect(s.alive).toBeLessThanOrEqual(fs.rounds[r]!.seconds + 0.05);
      // a winner who survived was on the field the whole round (when nobody survives, the last one out wins)
      if (f.fighters[f.winner]!.survived) expect(seats[f.winner]!.alive).toBeCloseTo(fs.rounds[r]!.seconds, 0);
      else expect(f.fighters.every((x) => !x.survived)).toBe(true);
    });
  });

  test("seat entries: wins, rounds, fallbacks, autopilot, fight stats; nothing without fightStats or from another engine", () => {
    const { m, rec } = played(42, ["claude/haiku", "codex/gpt-6-luna", "house", "remote/Zap@grok-4.6"]);
    rec.rounds[0].meta = [
      { provider: "claude/haiku", ms: 10, outcome: "ok" },
      { provider: "codex/gpt-6-luna", ms: 10, outcome: "fallback-timeout" },
      { provider: "house", ms: 0, outcome: "house" },
      { provider: "remote/Zap@grok-4.6", ms: 5, outcome: "ok" },
    ];
    rec.control = [{ seat: 3, mode: "autopilot", round: 1, phase: "fight", tick: 10, reason: "connection lost", line: "x" }];
    const es = seatEntries(rec);
    expect(es.map((e) => e.model.key)).toEqual(["claude-haiku", "gpt-6-luna", "house", "self:grok-4-6"]);
    expect(es.filter((e) => e.wonMatch).map((e) => e.seat)).toEqual([m.winner]);
    expect(es.map((e) => e.roundWins)).toEqual(m.wins);
    expect(es[1]).toMatchObject({ plans: 1, fallbacks: 1 });
    expect(es[2]!.plans).toBe(0);
    expect(es[3]!.autopilot).toBe(true);
    expect(seatEntries({ ...rec, fightStats: undefined })).toEqual([]);
    expect(seatEntries({ ...rec, engine: ENGINE_VERSION - 1 })).toEqual([]);
    expect(es.reduce((a, e) => a + e.fight.kos, 0)).toBe(m.facts.reduce((a, f) => a + f.stats.kos.filter((k) => k.by >= 0 && k.by !== k.victim).length, 0));
    expect(seatEntries({ seed: 1 })).toEqual([]);
    expect(isRealAi(es)).toBe(true);
    expect(isRealAi(seatEntries({ ...rec, labels: ["house", "house", "house", "house"] }))).toBe(false);
    expect(isRealAi(seatEntries({ ...rec, labels: ["stub/test", "claude/haiku", "house", "house"] }))).toBe(false);
  });

  test("copies of a match count once (seed + total time)", () => {
    const { rec } = played(43, ["claude/haiku", "house", "house", "house"]);
    const a = seatEntries(rec);
    const b = seatEntries(JSON.parse(JSON.stringify(rec)));
    const c = seatEntries({ ...rec, totalMs: rec.totalMs + 1 }); // another match
    expect(matchKey(rec)).toBe(a[0]!.match);
    const { kept, dropped } = dedupe([a, b, c]);
    expect(kept.length).toBe(2);
    expect(dropped).toBe(1);
  });

  test("leaderboard: ranked by win rate, small samples provisional, ± from the Wilson interval", () => {
    // synthetic entries: A wins 6 of 10, B 2 of 10, C 1 of 2 (provisional)
    const fight = { kos: 1, ringouts: 0, damage: 50, taken: 40, alive: 60, roundSeconds: 90 };
    const mk = (match: string, key: string, won: boolean): SeatEntry => ({ match, seat: 0, model: { ...modelOf("house"), key, name: key.toUpperCase(), provider: "other" }, wonMatch: won, rounds: 3, roundWins: won ? 2 : 0, plans: 3, fallbacks: 0, autopilot: false, fight });
    const sets: SeatEntry[][] = [];
    for (let i = 0; i < 10; i++) sets.push([mk(`m${i}`, "a", i < 6), mk(`m${i}`, "b", i >= 6 && i < 8)]);
    const ab = leaderboard(sets, { minMatches: 5 });
    expect(ab.rows.map((r) => r.key)).toEqual(["a", "b"]);
    expect(ab.rows[0]).toMatchObject({ matches: 10, wins: 6, winRate: 0.6, provisional: false, kosPerMatch: 1, survival: 60 / 90 });
    expect(ab.rows[0]!.low).toBeLessThan(0.6);
    expect(ab.rows[0]!.high).toBeGreaterThan(0.6);
    sets.push([mk("x1", "c", true), mk("x1", "a", false)]);
    sets.push([mk("x2", "c", false), mk("x2", "a", true)]);
    const lb = leaderboard(sets, { minMatches: 5 });
    expect(lb.matches).toBe(12);
    expect(lb.rows.find((r) => r.key === "c")!.provisional).toBe(true);
    expect(lb.rows.at(-1)!.key).toBe("c"); // provisional rows after the ranked ones, even with a 50% win rate
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
    const w = wilson(5, 10);
    expect(w.low).toBeCloseTo(0.237, 2);
    expect(w.high).toBeCloseTo(0.763, 2);
    const h = headToHead(sets);
    expect(h.cell.a!.b).toEqual({ ahead: 6, met: 10 });
    expect(h.cell.b!.a).toEqual({ ahead: 2, met: 10 });
    const text = leaderboardText(lb, h);
    expect(text).toContain(`ENGINE v${ENGINE_VERSION}`);
    expect(text).toContain("provisional");
    expect(text).toContain("head to head");
  });
});

describe("records carry fight stats", () => {
  test("a runner's saved record has fightStats matching its facts (not part of any hash)", async () => {
    const r = new MatchRunner({ seed: 9, seats: seatsFor(["stub", "house", "house", "house"], exampleSouls()) });
    await r.run();
    const saved = r.savedRecord();
    expect(saved.fightStats).toEqual(fightStatsOf(r.match.facts));
    const es = seatEntries(JSON.parse(JSON.stringify(saved)));
    expect(es[0]!.model.name).toBe("STUB (TEST)");
    expect(es.length).toBe(4);
  });
});

function client(server: MatchServer, ip = "1.2.3.4") {
  return async (method: string, path: string, body?: unknown) => {
    const res = (await server.handle(new Request(`http://kb.test${path}`, { method, ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) }), ip))!;
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, data: type.includes("json") ? ((await res.json()) as any) : await res.text() };
  };
}

async function untilOver(s: MatchServer, id: string) {
  for (let i = 0; i < 2000 && s.matches.get(id)!.status !== "over"; i++) await new Promise((r) => setTimeout(r, 10));
  expect(s.matches.get(id)!.status).toBe("over");
}

describe("match server: self-reported models and GET /api/models", () => {
  test("join takes an optional model: shown on the seat (self-reported), in the label and the record; bad ones refused", async () => {
    const out = tmp();
    const s = new MatchServer({ outDir: out });
    const call = client(s);
    const m = await s.createMatch({ seats: ["remote", "remote", "house", "house"], seed: 515, deadlineMs: 30, fillAfterMs: 300_000 });
    const J = `/api/matches/${m.id}/join`;
    expect((await call("POST", J, { name: "Bad", persona: SOUL, model: "x@y" })).data.problems.join()).toContain("model");
    expect((await call("POST", J, { name: "Bad", persona: SOUL, model: 5 })).status).toBe(400);
    expect((await call("POST", J, { name: "Zap", persona: SOUL, model: "claude-opus-5-5" })).status).toBe(201);
    expect((await call("POST", J, { name: "Quiet", persona: SOUL })).status).toBe(201);
    const open = (await call("GET", `/api/matches/${m.id}`)).data;
    expect(open.seats[0].model).toMatchObject({ name: "CLAUDE OPUS 5.5", selfReported: true, agent: "Zap" });
    expect(open.seats[1].model).toMatchObject({ key: "remote:unreported" });
    expect(open.seats[2].model).toMatchObject({ name: "HOUSE BOT" });
    m.start();
    await untilOver(s, m.id);
    const over = (await call("GET", `/api/matches/${m.id}`)).data;
    expect(over.seats[0].label).toBe("remote/Zap@claude-opus-5-5");
    const rec = JSON.parse(readFileSync(join(out, over.record.replace("/records/", "")), "utf8"));
    expect(rec.labels[0]).toBe("remote/Zap@claude-opus-5-5");
    expect(rec.fightStats.rounds.length).toBe(rec.rounds.length);
    // the leaderboard reads the record index (stats saved with the record)
    const lb = (await call("GET", "/api/models?min=1")).data;
    expect(lb.minMatches).toBe(1);
    const row = lb.rows.find((r: { key: string }) => r.key === "self:claude-opus-5-5");
    expect(row).toMatchObject({ matches: 1, selfReported: true });
    expect(lb.rows.some((r: { key: string }) => r.key === "house")).toBe(true);
  });

  test("the seat's model survives a restart (stored with the seat)", async () => {
    const store = new SqliteStore(":memory:");
    const s = new MatchServer({ outDir: tmp(), store });
    const m = await s.createMatch({ seats: ["remote", "house", "house", "house"], fillAfterMs: 300_000 });
    await client(s)("POST", `/api/matches/${m.id}/join`, { name: "Zap", persona: SOUL, model: "gpt-6-luna" });
    await new Promise((r) => setTimeout(r, 20));
    expect((await store.listSeats(m.id))[0]!.model).toBe("gpt-6-luna");
    m.start();
    await untilOver(s, m.id);
    await store.close();
  });

  test("the index's stats: test providers left out, copies counted once, other engines not loaded", async () => {
    const store = new SqliteStore(":memory:");
    const s = new MatchServer({ outDir: tmp(), store });
    const a = played(61, ["claude/haiku", "codex/gpt-6-luna", "grok/grok-4.6", "house"]).rec;
    const t = played(62, ["stub/test", "house", "house", "house"]).rec;
    const row = (id: string, seed: number) => store.insertMatch({ id, seed, kinds: ["house", "house", "house", "house"], deadlineMs: 1, fillAfterMs: 1, status: "over", createdAt: 1, startedAt: 1, endedAt: 2, creator: null, error: null, winner: 0, ruleset: CLASSIC });
    for (const [id, seed] of [["m1", 61], ["m2", 61], ["m3", 62], ["m4", 63]] as const) await row(id, seed);
    const rec = (matchId: string, r: typeof a, createdAt: number, engine = ENGINE_VERSION) => store.insertRecord({ matchId, path: `/records/${matchId}.json`, seed: r.seed, hashes: [], winner: r.winner, createdAt, engine, stats: JSON.stringify(seatEntries(r)) });
    await rec("m1", a, 1);
    await rec("m2", a, 2); // a copy of m1
    await rec("m3", t, 3); // test provider
    await rec("m4", a, 4, ENGINE_VERSION - 1); // another engine version: not loaded
    const lb = (await client(s)("GET", "/api/models")).data;
    expect(lb.matches).toBe(1);
    expect(lb.duplicates).toBe(1);
    expect(lb.rows.map((r: { name: string }) => r.name).sort()).toEqual(["CLAUDE HAIKU", "GPT-6 LUNA (CODEX)", "GROK 4.6", "HOUSE BOT"]);
    expect(lb.rows.every((r: { provisional: boolean }) => r.provisional)).toBe(true); // 1 match < 10
    // ?min only re-ranks the cached entries: no rebuild per query string
    const cached = s.modelsCache;
    const again = (await client(s)("GET", "/api/models?min=1")).data;
    expect(s.modelsCache).toBe(cached);
    expect(again.minMatches).toBe(1);
    expect(again.rows.every((r: { provisional: boolean }) => !r.provisional)).toBe(true);
    await store.close();
  });

  test("/models and the lobby show the leaderboard", async () => {
    const s = new MatchServer({ outDir: tmp() });
    const page = await s.handle(new Request("http://kb.test/models"), "1.1.1.1");
    expect(page!.status).toBe(200);
    const html = await page!.text();
    expect(html).toContain("WHICH MODEL IS BEST");
    expect(html).toContain("/api/models");
    expect(html).toContain(".kb-mb");
    const lobby = await (await s.handle(new Request("http://kb.test/lobby"), "1.1.1.1"))!.text();
    expect(lobby).toContain("Which model is best");
    expect(lobby).toContain("renderBoard");
    expect((await client(s)("GET", "/api")).data.endpoints["GET /api/models"]).toBeDefined();
  });
});
