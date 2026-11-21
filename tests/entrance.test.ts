/**
 * Contract 10: the Arena entrance and the entry boost (#66). An agent that takes a house bot's seat enters at the
 * intro of its first round: the record names it, its line and the house bot it kicks out (as the viewers last saw
 * it), and the viewer plays an entrance beat for it. In that round its fighter starts with a shield and a damage
 * boost (10 s), if the round has a house bot; with 4 agents there is no boost. The boost is in the fight record
 * (start powers per seat), so the replay gives the same hash, and a round loaded again after a restart rebuilds it.
 *
 * In-process only (MatchServer.handle, no port), fast pace, far deadlines, a temporary folder.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { arrivalBeats, DEFAULT_TIMING, openingBeats } from "../src/flow/beats";
import { roundPlayback } from "../src/flow/pacing";
import { MatchServer } from "../src/server/match-server";
import { SqliteStore } from "../src/server/store";
import { CLASSIC, ENTRANCE_SHOUT, ENTRY_BOOST, entryBoost, Fight, FightDivergedError, initPhysics, Match, replayFight, replayMatch, resolveRuleset, type FightRecord, type MatchRecord, type StartPower, type Strategy } from "../src/sim";
import { sanitizeRecord } from "../src/viewer/sanitize";
import { planVideo } from "../scripts/teaser/plan";

const outDir = mkdtempSync(join(tmpdir(), "kb-entrance-"));
beforeAll(async () => {
  await initPhysics();
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

const PLANS: Strategy[] = [
  { target: "weakest", stance: "rush", weapons: ["rocket", "bat"], line: "" },
  { target: "nearest", stance: "rush", weapons: ["bat"], line: "" },
  { target: "nearest", stance: "distance", weapons: ["shotgun"], line: "" },
  { target: "leader", stance: "item", weapons: ["grenade"], line: "" },
];
const BOOST: StartPower[] = entryBoost([1], ["house", "remote", "house", "house"]);

describe("the entry boost in the sim", () => {
  test("shield and damage for the entering seats, only when a house bot plays", () => {
    expect(BOOST).toEqual([
      { fighter: 1, power: "shield", ticks: 600 },
      { fighter: 1, power: "damage", ticks: 600 },
    ]);
    expect(entryBoost([0, 2], ["remote", "house", "remote", "house"]).map((p) => p.fighter)).toEqual([0, 0, 2, 2]);
    // 4 agents: no boost for anyone, whoever enters
    expect(entryBoost([0, 1, 2, 3], ["remote", "remote", "remote", "remote"])).toEqual([]);
  });

  test("the boosted fighter starts with both power-ups, for 10 s; the record keeps them and replays to the same hash", () => {
    const f = new Fight(1001, PLANS, { startPowers: BOOST });
    expect([f.sim.fighters[1]!.power.shield, f.sim.fighters[1]!.power.damage]).toEqual([ENTRY_BOOST.ticks, ENTRY_BOOST.ticks]);
    expect(f.sim.fighters.filter((x) => x.id !== 1).map((x) => x.power.shield + x.power.damage)).toEqual([0, 0, 0]);
    const off: number[] = [];
    f.onEvent = (e) => e.type === "power" && !e.on && e.fighter === 1 && (e.power === "shield" || e.power === "damage") && off.push(e.tick);
    f.playToEnd();
    // the damage boost acts on ticks 0..599 and runs out in the step of tick 599: 10 s (the shield too, unless 3 hits popped it)
    expect(off).toContain(ENTRY_BOOST.ticks - 1);
    expect(f.record.startPowers).toEqual(BOOST);
    // (its golden hash is in determinism.test.ts)
    const rec: FightRecord = JSON.parse(JSON.stringify(f.record));
    expect(replayFight(rec).finalHash).toBe(f.record.finalHash);
    // the same fight without the boost is another fight: a record that lost it does not pass for the boosted one
    const plain = new Fight(1001, PLANS);
    plain.playToEnd();
    expect(plain.record.finalHash).not.toBe(f.record.finalHash);
    const { startPowers: _, ...bare } = rec;
    expect(() => replayFight(bare)).toThrow(FightDivergedError);
  });

  test("a match boosts round 1 only, and its record replays exactly", () => {
    const m = new Match(77, { startPowers: BOOST });
    m.playToEnd();
    expect(m.record.rounds.length).toBeGreaterThan(1);
    expect(m.record.rounds.map((r) => r.fight.startPowers ?? null)).toEqual([BOOST, ...m.record.rounds.slice(1).map(() => null)]);
    const rec: MatchRecord = JSON.parse(JSON.stringify(m.record));
    expect(replayMatch(rec).record.rounds.map((r) => r.fight.finalHash)).toEqual(m.record.rounds.map((r) => r.fight.finalHash));
  });
});

// ------------------------------------------------------------------ the Arena

const server = (store?: SqliteStore) => new MatchServer({ outDir, pace: "fast", ...(store ? { store } : {}), arena: { deadlineMs: 600_000, seed: (r) => 9100 + r } });
const SOUL = "A cocky bruiser who loves the bat. Talks in short, loud taunts.";
let ipN = 0;
async function call(api: MatchServer, method: string, path: string, opts: { auth?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth) headers.authorization = `Bearer ${opts.auth}`;
  const res = (await api.handle(new Request(`http://kb.test${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) }), `10.66.${Math.floor(++ipN / 250)}.${ipN % 250}`))!;
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
async function enter(api: MatchServer, name: string, soul = SOUL) {
  const key = (await call(api, "POST", "/api/keys", { body: { owner: `${name}-owner` } })).data.key;
  const r = await call(api, "POST", "/api/queue", { auth: key, body: { name, model: "claude-opus-5-5", soul } });
  expect(r.status).toBe(201);
  return r.data as { token: string; seat: number; entersRound: number };
}
async function untilTurn(api: MatchServer, token: string) {
  for (;;) {
    const t = (await call(api, "GET", "/api/arena/turn?wait=30", { auth: token })).data;
    if (t.status === "turn") return t;
  }
}
const plan = (api: MatchServer, token: string, round: number) => call(api, "POST", "/api/arena/plan", { auth: token, body: { round, weapons: ["bat"], target: "nearest", stance: "rush", line: "Here." } });
/** Play the next round with these agents planning it. */
async function round(api: MatchServer, agents: { token: string }[]) {
  const r = api.arena.playRound();
  for (const a of agents) {
    const t = await untilTurn(api, a.token);
    await plan(api, a.token, t.round);
  }
  return r;
}
const savedRecord = (path: string): MatchRecord => JSON.parse(readFileSync(join(outDir, path.replace(/^\/records\//, "")), "utf8"));

describe("the entrance in the Arena", () => {
  test("an agent enters its first round: it kicks out the house bot of its seat, gets the boost, and the replay is exact", async () => {
    const store = new SqliteStore(":memory:");
    const api = server(store);
    const before = await api.arena.playRound(); // house bots only
    expect(before.runner!.match.record.entrances).toBeUndefined();
    const a = await enter(api, "Rowdy", `${SOUL}\n\n## Lines\n\n- entrance: Out of my seat! {me} is home!`);
    expect(a).toMatchObject({ seat: 0, entersRound: 2 });

    const r2 = api.arena.playRound();
    const t = await untilTurn(api, a.token);
    // the agent hears of its entrance and its boost in its turn
    expect(t.entrance).toMatchObject({ kicksOut: before.runner!.match.identities[0]!.name, boost: [{ power: "shield", seconds: 10 }, { power: "damage", seconds: 10 }] });
    await plan(api, a.token, t.round);
    const m2 = await r2;
    const rec = m2.runner!.match.record;
    const name = m2.runner!.names[0]!;
    // the house bot it kicks out is the one the viewers saw in that seat in the round before
    expect(rec.entrances).toEqual([{ seat: 0, line: `Out of my seat! ${name} is home!`, evicted: before.runner!.match.identities[0] }]);
    expect(rec.rounds[0]!.fight.startPowers).toEqual(entryBoost([0], ["remote", "house", "house", "house"]));
    // the live stream told the viewer too
    expect(m2.runner!.events[0]).toMatchObject({ type: "match", entrances: rec.entrances, startPowers: rec.rounds[0]!.fight.startPowers });
    // the saved record replays to the same hash, boost included
    const saved = savedRecord(m2.info().record!);
    expect(saved.rounds[0]!.fight.startPowers).toEqual(rec.rounds[0]!.fight.startPowers);
    expect(replayMatch(saved).record.rounds[0]!.fight.finalHash).toBe(rec.rounds[0]!.fight.finalHash);

    // its second round: no entrance, no boost
    const m3 = await round(api, [a]);
    expect(m3.runner!.match.record.entrances).toBeUndefined();
    expect(m3.runner!.match.record.rounds[0]!.fight.startPowers).toBeUndefined();

    // after a restart, the finished round loads again from the store with the same entrance and boost (its hash checks)
    const again = server(store);
    const report = await call(again, "GET", `/api/matches/${m2.id}/report`);
    expect(report.status).toBe(200);
    expect(report.data.rounds[0].result.finalHash).toBe(rec.rounds[0]!.fight.finalHash);
    expect((await again.matchOr404(m2.id)).runner!.match.record.entrances).toEqual(rec.entrances);
  });

  test("4 agents entering at once: each kicks out its house bot, and nobody gets the boost", async () => {
    const api = server();
    const before = await api.arena.playRound();
    const agents = [];
    for (const n of ["Ann", "Ben", "Cat", "Dee"]) agents.push(await enter(api, n));
    const m = await round(api, agents);
    const rec = m.runner!.match.record;
    expect(rec.entrances!.map((e) => [e.seat, e.line, e.evicted?.name])).toEqual([0, 1, 2, 3].map((s) => [s, ENTRANCE_SHOUT, before.runner!.match.identities[s]!.name]));
    expect(rec.rounds[0]!.fight.startPowers).toBeUndefined();
    expect(m.runner!.match.fight!.record.startPowers).toBeUndefined();
  });
});

// ------------------------------------------------------------------ the viewer's side

describe("the entrance beat", () => {
  test("it plays after the level card, before the intro cards, one per entering seat; broadcast pacing counts it", () => {
    const lines = ["a", "b", "c", "d"];
    const beats = openingBeats([3, 2, 1, 0], lines, [2, 0]);
    expect(beats.map((b) => (b.kind === "entrance" ? `entrance ${b.seat}` : b.kind))).toEqual(["level", "entrance 0", "entrance 2", "dialogue", "dialogue", "dialogue", "dialogue"]);
    expect(arrivalBeats([2, 0]).length).toBe(3);
    const plain = roundPlayback({ round: 1, lines, fightTicks: 600, kos: 0, endsWithKo: false });
    const entered = roundPlayback({ round: 1, lines, entering: [2, 0], fightTicks: 600, kos: 0, endsWithKo: false });
    expect(entered.preFight - plain.preFight).toBeCloseTo(2 * DEFAULT_TIMING.entrance, 6);
  });

  test("a record's entrances and start powers reach the viewer's replay; bad ones are dropped", () => {
    const ruleset = resolveRuleset({ ...CLASSIC, round: { ...CLASSIC.round, maxRounds: 1, winsToTake: 1 } });
    const m = new Match(5, { ruleset, entrances: [{ seat: 1, line: ENTRANCE_SHOUT, evicted: new Match(6).identities[1]! }], startPowers: BOOST });
    m.playToEnd();
    const raw = JSON.parse(JSON.stringify(m.record));
    const rec = sanitizeRecord(raw)!;
    expect(rec.entrances).toEqual(m.record.entrances);
    expect(rec.rounds[0]!.fight.startPowers).toEqual(BOOST);
    // the viewer replays the sanitized record to the recorded hash
    const view = new Match(rec.seed, { recorded: rec });
    view.playToEnd();
    expect(view.diverged).toBe(-1);
    expect(view.record.entrances).toEqual(m.record.entrances);
    // untrusted input: an unknown power, a seat that is no seat, a duplicate seat
    raw.rounds[0].fight.startPowers = [...BOOST, { fighter: 9, power: "shield", ticks: 600 }, { fighter: 1, power: "jetpack", ticks: 90 }];
    raw.entrances = [...raw.entrances, { seat: 1, line: "again" }, { seat: 7, line: "nobody" }];
    const bad = sanitizeRecord(raw)!;
    expect(bad.rounds[0]!.fight.startPowers).toEqual(BOOST);
    expect(bad.entrances).toEqual(m.record.entrances);
  });

  test("the teaser plan keeps the entrance in full", () => {
    const beats = [
      { frame: 1, kind: "level", round: 1, index: 0 },
      { frame: 145, kind: "entrance", round: 1, index: 1 },
      { frame: 373, kind: "dialogue", round: 1, index: 2 },
      { frame: 529, kind: "countdown", round: 1, index: 3 },
    ];
    const plan = planVideo({ beats, ticks: [], frames: 600 }, [], 60);
    expect(plan.segments.find((s) => s.kind === "entrance")).toMatchObject({ from: 145, to: 372, speed: 1 });
  });
});
