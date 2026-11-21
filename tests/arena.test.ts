/**
 * Contract 9: the Arena (#64). Rounds run without stopping with house bots in every seat no agent holds; an agent
 * that joins claims a house bot's seat and plays from the next round; a silent agent loses its seat after 2 missed
 * rounds; an agent that leaves gives its seat back at once; with more than 4 agents the last-placed one goes to the
 * back of the queue; after a restart the round in progress resumes and agents join again.
 *
 * Everything runs in-process (MatchServer.handle, no port) at fast pace. Rounds are driven directly
 * (arena.playRound()) or by the loop with an injected sleep; turn deadlines are far away (one test uses a tiny one
 * for an agent that never answers: how long it is does not change the result). Agents act over the HTTP API.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArenaOptions } from "../src/server/arena";
import { MatchServer } from "../src/server/match-server";
import { SqliteStore } from "../src/server/store";
import { initPhysics } from "../src/sim";

const outDir = mkdtempSync(join(tmpdir(), "kb-arena-"));
beforeAll(async () => {
  await initPhysics();
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

const server = (arena: ArenaOptions = {}, store?: SqliteStore) => new MatchServer({ outDir, pace: "fast", ...(store ? { store } : {}), arena: { deadlineMs: 600_000, seed: (r) => 7000 + r, ...arena } });

const SOUL = "A cocky bruiser who loves the bat and a good ring-out. Talks in short, loud taunts and never backs down.";
let ipN = 0;
/** One request; each from its own address so per-address limits never decide a result. */
async function call(api: MatchServer, method: string, path: string, opts: { auth?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth) headers.authorization = `Bearer ${opts.auth}`;
  const res = (await api.handle(new Request(`http://kb.test${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) }), `10.9.${Math.floor(++ipN / 250)}.${ipN % 250}`))!;
  return { status: res.status, headers: res.headers, data: (await res.json().catch(() => null)) as any };
}
/** Owner keys per store (two servers on one store share them). */
const keys = new WeakMap<object, Map<string, string>>();
async function ownerKey(api: MatchServer, owner: string) {
  const mine = keys.get(api.store) ?? new Map<string, string>();
  keys.set(api.store, mine);
  if (!mine.has(owner)) mine.set(owner, (await call(api, "POST", "/api/keys", { body: { owner } })).data.key);
  return mine.get(owner)!;
}
/** An agent joins the Arena over HTTP: its seat token and where it is. */
async function enter(api: MatchServer, name: string, owner = `${name}-owner`) {
  const r = await call(api, "POST", "/api/queue", { auth: await ownerKey(api, owner), body: { name, model: "claude-opus-5-5", soul: SOUL, line: `${name} is here.` } });
  expect(r.status).toBe(201);
  return { token: r.data.token as string, ...r.data };
}
const turn = async (api: MatchServer, token: string, wait = 0) => (await call(api, "GET", `/api/arena/turn?wait=${wait}`, { auth: token })).data;
/** Long-poll until the agent's turn comes (returns on every change; no result depends on how long it takes). */
async function untilTurn(api: MatchServer, token: string) {
  for (;;) {
    const t = await turn(api, token, 30);
    if (t.status === "turn" || t.status === "out") return t;
  }
}
const plan = (api: MatchServer, token: string, round: number, line = `Round ${round}, here I come.`) => call(api, "POST", "/api/arena/plan", { auth: token, body: { round, weapons: ["rocket", "bat"], target: "weakest", stance: "rush", line } });

describe("the Arena", () => {
  test("the loop runs rounds without stopping, house bots in every seat, and streams each round", async () => {
    let api!: MatchServer;
    // the loop's pause between rounds: after round 3 it stops
    api = server({ sleep: async () => void (api.arena.round >= 3 && api.arena.stop()) });
    const live = (await call(api, "GET", "/api/queue")).data;
    expect(live.seats.map((s: { holder: string }) => s.holder)).toEqual(["house", "house", "house", "house"]);
    // a spectator on the Arena stream before the first round
    const res = (await api.handle(new Request("http://kb.test/api/live"), "10.8.0.1"))!;
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();

    await api.arena.start();

    const rows = (await api.store.listMatches()).reverse();
    expect(rows.map((r) => [r.arenaRound, r.status, r.kinds.join(",")])).toEqual([1, 2, 3].map((n) => [n, "over", "house,house,house,house"]));
    // each round is one round: maxRounds 1, one round in its record
    for (const r of rows) {
      expect(r.ruleset.round).toMatchObject({ maxRounds: 1, winsToTake: 1 });
      expect((await api.store.getRecord(r.id))?.hashes).toHaveLength(1);
    }
    // the stream went on from round to round: each one starts with its match event
    const text: string[] = [];
    const dec = new TextDecoder();
    while (text.join("").split('"type":"done"').length - 1 < 3) text.push(dec.decode((await reader.read()).value));
    const starts = [...text.join("").matchAll(/"type":"match".*?"matchId":"(m_[0-9a-f]{8})","arenaRound":(\d+)/g)].map((m) => [m[1], Number(m[2])]);
    expect(starts).toEqual(rows.map((r) => [r.id, r.arenaRound]));
    await reader.cancel();
  });

  test("an agent claims a house bot's seat and plays from the next round", async () => {
    const api = server();
    const a = await enter(api, "Alpha");
    expect(a).toMatchObject({ status: "seated", seat: 0, entersRound: 1 });
    const r1 = api.arena.playRound();
    const t1 = await untilTurn(api, a.token);
    expect(t1).toMatchObject({ status: "turn", round: 1, seat: 0 });

    // while round 1 waits for Alpha's plan, Bravo joins: it takes a house bot's seat for round 2, not this round
    const b = await enter(api, "Bravo");
    expect(b).toMatchObject({ status: "seated", seat: 1, entersRound: 2 });
    expect(api.arena.current!.kinds).toEqual(["remote", "house", "house", "house"]);
    expect((await turn(api, b.token)).status).toBe("seated");
    expect((await plan(api, b.token, 1)).status).toBe(409); // no round of Bravo's yet

    expect((await plan(api, a.token, 2)).status).toBe(409); // the round named must be the one played
    expect((await plan(api, a.token, 1, "Alpha opens.")).status).toBe(200);
    const m1 = await r1;
    expect(m1.runner!.match.record.rounds[0]!.meta![0]!.outcome).toBe("ok");

    const r2 = api.arena.playRound();
    const [ta, tb] = await Promise.all([untilTurn(api, a.token), untilTurn(api, b.token)]);
    expect([ta.round, tb.round, tb.seat]).toEqual([2, 2, 1]);
    expect(api.arena.current!.kinds).toEqual(["remote", "remote", "house", "house"]);
    await plan(api, a.token, 2);
    expect((await plan(api, b.token, 2, "Bravo was here.")).status).toBe(200);
    const m2 = await r2;
    const report = (await call(api, "GET", `/api/matches/${m2.id}/report`)).data;
    expect(report.arenaRound).toBe(2);
    expect(report.rounds[0].plans[1].line).toBe("Bravo was here.");
    expect(report.seats.map((s: { agent: string | null }) => s.agent)).toEqual(["Alpha", "Bravo", null, null]);
    // the agent hears how its last round went
    expect((await turn(api, b.token)).lastRound).toMatchObject({ round: 2, played: true, match: m2.id });
  });

  test("a silent agent keeps its seat for one missed round and loses it after 2", async () => {
    // a turn nobody answers ends at its deadline; how short it is does not change the result
    const api = server({ deadlineMs: 5 });
    const s = await enter(api, "Mute");
    const m1 = await api.arena.playRound();
    expect(m1.kinds[0]).toBe("remote");
    expect(m1.runner!.match.record.rounds[0]!.meta![0]!.outcome).toBe("fallback-timeout"); // the autopilot played it
    expect(api.arena.seats[0]?.name).toBe("Mute"); // one miss: still its seat
    expect(api.arena.statusFor(api.arena.seats[0]!).status).toBe("seated"); // (a request would count as being back)

    // it said nothing since: the next round starts with the autopilot at once, and that is the second miss
    const m2 = await api.arena.playRound();
    expect(m2.kinds[0]).toBe("remote");
    expect(m2.runner!.control[0]).toMatchObject({ seat: 0, mode: "autopilot", reason: "still away after a missed round" });
    expect(api.arena.seats[0]).toBeNull();
    const out = await turn(api, s.token);
    expect(out.status).toBe("out");
    expect(out.message).toContain("missed 2 rounds in a row");
    expect((await plan(api, s.token, 3)).status).toBe(410);

    const m3 = await api.arena.playRound();
    expect(m3.kinds).toEqual(["house", "house", "house", "house"]);
  });

  test("an agent that leaves gives its seat to a house bot at once; a queued agent leaves the queue", async () => {
    const api = server();
    const q = await enter(api, "Quitter");
    const r1 = api.arena.playRound();
    await untilTurn(api, q.token);
    const left = await call(api, "POST", "/api/arena/leave", { auth: q.token });
    expect(left.data).toMatchObject({ left: true, seat: 0 });
    const m1 = await r1;
    // the house bot played the rest of this round
    expect(m1.runner!.match.record.rounds[0]!.meta![0]!.outcome).not.toBe("ok");
    expect(m1.runner!.control.map((c) => c.reason)).toContain("left the match");
    expect((await turn(api, q.token)).status).toBe("out");
    expect((await api.arena.playRound()).kinds).toEqual(["house", "house", "house", "house"]);

    // with every seat taken, a fifth agent waits; then it leaves the queue
    for (const n of ["S1", "S2", "S3", "S4"]) await enter(api, n);
    const w = await enter(api, "Waiter");
    expect(w).toMatchObject({ status: "queued", position: 1 });
    expect((await call(api, "POST", "/api/arena/leave", { auth: w.token })).data).toMatchObject({ left: true, from: "the queue" });
    expect((await call(api, "GET", "/api/queue")).data.queue).toEqual([]);
  });

  test("with more than 4 agents, the last-placed agent goes to the back of the queue and the first waiting one takes its seat", async () => {
    const api = server();
    const four = [];
    for (const n of ["Ace", "Bea", "Cy", "Dee"]) four.push(await enter(api, n));
    const e = await enter(api, "Eve");
    expect(e).toMatchObject({ status: "queued", position: 1 });

    const r1 = api.arena.playRound();
    const turns = await Promise.all(four.map((x) => untilTurn(api, x.token)));
    expect(turns.map((t) => t.round)).toEqual([1, 1, 1, 1]);
    for (const x of four) expect((await plan(api, x.token, 1)).status).toBe(200);
    const m1 = await r1;
    const last = m1.info().placing!.at(-1)!;
    const loser = four[last]!;

    expect(api.arena.seats[last]?.name).toBe("Eve");
    expect(await turn(api, e.token)).toMatchObject({ status: "seated", seat: last, entersRound: 2 });
    expect(await turn(api, loser.token)).toMatchObject({ status: "queued", position: 1 });
    // the others keep their seats
    expect(api.arena.seats.map((x) => x?.name)).toEqual(four.map((x, i) => (i === last ? "Eve" : x.agent)));

    const r2 = api.arena.playRound();
    expect((await untilTurn(api, e.token)).round).toBe(2);
    expect(api.arena.current!.agents[last]?.name).toBe("Eve");
    // everyone in round 2 plans
    for (const [i, x] of four.entries()) if (i !== last) await untilTurn(api, x.token).then(() => plan(api, x.token, 2));
    await plan(api, e.token, 2);
    await r2;
  });

  test("after a restart the round in progress resumes; agents join again and the round numbers go on", async () => {
    const store = new SqliteStore(":memory:");
    const before = server({}, store);
    const p = await enter(before, "Planner", "Pat");
    const s = await enter(before, "Sleeper", "Sam");
    void before.arena.playRound(); // this process "dies" with round 1 waiting for Sleeper
    await Promise.all([untilTurn(before, p.token), untilTurn(before, s.token)]);
    expect((await plan(before, p.token, 1, "Planned before the restart.")).status).toBe(200);
    const mid = before.arena.current!.id;

    const after = server({}, store);
    expect(await after.resume()).toEqual({ round: 1 });
    const m = after.arena.current!;
    expect(m.id).toBe(mid);
    await m.done;
    expect(m.status).toBe("over");
    const meta = m.runner!.match.record.rounds[0]!.meta!;
    // Planner's accepted plan survived the restart; Sleeper's seat went to the autopilot at once
    expect(meta[0]!.outcome).toBe("ok");
    expect(m.runner!.match.record.rounds[0]!.lines[0]).toBe("Planned before the restart.");
    expect(meta[1]!.outcome).not.toBe("ok");
    expect(m.runner!.control).toContainEqual(expect.objectContaining({ seat: 1, mode: "autopilot", reason: "the server restarted" }));
    expect(existsSync(join(outDir, m.runner!.recordFile!))).toBe(true);

    // the new process does not know the old seat tokens: agents join again (same name, same owner)
    expect((await call(after, "GET", "/api/arena/turn?wait=0", { auth: p.token })).status).toBe(401);
    const again = await enter(after, "Planner", "Pat");
    expect(again).toMatchObject({ status: "seated", entersRound: 2 });
    const r2 = after.arena.playRound();
    expect((await untilTurn(after, again.token)).round).toBe(2);
    await plan(after, again.token, 2);
    expect((await r2).arenaRound).toBe(2);

    // let the dead process's round end too (it shares the store), so nothing is left waiting
    await before.arena.leave(before.arena.seats[1]!);
  });
});
