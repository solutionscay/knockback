/**
 * Contract (#65): the crown, streaks and the round leaderboard of agents only.
 *
 * - The winner of a round holds the crown; it keeps it and its streak grows while it wins; the next winner takes it.
 *   A house bot can hold it (its reign is not recorded). Streak records count only rounds with 2 or more agents.
 * - The crown is kept in the store and brought up to date from the stored rounds: it survives a restart, also one that
 *   came between a round's end and the crown's update.
 * - The leaderboard counts rounds and agent seats only, per agent and per owner, against agents (2+ agents) and against
 *   house bots only (one agent), with the best streaks.
 *
 * The rules and the store are driven with stored rounds whose winners the test sets (the sim decides real winners;
 * these tests must not depend on it). One test plays real rounds and checks the wiring: the crown goes to the winner,
 * and its holder starts the next round with the crown mark.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLASSIC } from "../src/sim/ruleset";
import { crownSeat, nextCrown, type Crown, type PlayedRound } from "../src/server/crown";
import { tierOf } from "../src/server/server-match";
import { SqliteStore } from "../src/server/store";
import { initPhysics } from "../src/sim";
import { arenaServer, call, enter, round } from "./helpers/arena";

const outDir = mkdtempSync(join(tmpdir(), "kb-crown-"));
beforeAll(async () => {
  await initPhysics();
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

const AGENTS: Record<string, string> = { Ann: "Oz", Ben: "Oz", Cat: "Cy" };

/** Store one finished Arena round: its seats (agent name per seat, null = house bot) and its winning seat. */
async function stored(store: SqliteStore, n: number, seats: (string | null)[], winner: number, status: "over" | "failed" = "over") {
  const id = `m_${n.toString(16).padStart(8, "0")}`;
  const kinds = seats.map((s) => (s ? "remote" : "house"));
  await store.insertMatch({ ruleset: CLASSIC, id, arenaRound: n, seed: n, kinds, deadlineMs: 1000, status, createdAt: n * 1000, startedAt: n * 1000, endedAt: n * 1000 + 500, error: null, winner: status === "over" ? winner : null });
  for (const [seat, name] of seats.entries()) if (name) await store.insertSeat({ matchId: id, seat, name, soul: "s", owner: AGENTS[name]!, look: null, model: "claude-opus-5-5", client: "claude-code/2.1.0", tokenHash: `t-${name}`, joinedAt: 0, leftAt: null, leftRound: null });
  if (status === "over") await store.insertRecord({ matchId: id, path: `/records/r${n}.json`, tier: tierOf(kinds), seed: n, hashes: ["h"], winner, createdAt: n * 1000 + 500, stats: "[]" });
}

const holderOf = (c: Crown | null) => (c ? (c.holder.kind === "agent" ? c.holder.name : `house@${c.holder.seat}`) : null);

describe("the crown (#65)", () => {
  test("rules: the winner takes it; the holder's streak grows; only rounds with 2+ agents count for records", () => {
    const r = (arenaRound: number, tier: PlayedRound["tier"], winner: number, winnerName: string | null = null): PlayedRound => ({ arenaRound, tier, winner, winnerName, winnerOwner: winnerName ? AGENTS[winnerName]! : null });
    const steps: [PlayedRound, string, number, number][] = [
      [r(1, "bot-only", 2), "house@2", 1, 0],
      [r(2, "warm-up", 2), "house@2", 2, 0], // the same house bot (seat 2) defends
      [r(3, "bot-only", 1), "house@1", 1, 0], // another house bot takes it
      [r(4, "featured", 0, "Ann"), "Ann", 1, 1],
      [r(5, "warm-up", 3, "ann"), "Ann", 2, 1], // a warm-up win keeps the crown and the streak, no record round
      [r(6, "featured", 1, "Ann"), "Ann", 3, 2], // the seat does not matter for an agent
      [r(7, "featured", 2, "Cat"), "Cat", 1, 1],
    ];
    let c: Crown | null = null;
    const seen = steps.map(([round]) => ((c = nextCrown(c, round)), [holderOf(c), c.streak, c.ranked]));
    expect(seen).toEqual(steps.map(([, h, s, k]) => [h, s, k]));

    // the mark in the next line-up: an agent by name, a house bot only while its seat is still a house bot's
    const ann: Crown = { holder: { kind: "agent", name: "Ann", owner: "Oz" }, streak: 3, ranked: 2, wonRound: 6 };
    expect(crownSeat(ann, [null, "Ben", "ann", null])).toBe(2);
    expect(crownSeat(ann, ["Ben", null, null, null])).toBeNull(); // Ann is not in this round
    const house: Crown = { holder: { kind: "house", seat: 1 }, streak: 1, ranked: 0, wonRound: 3 };
    expect(crownSeat(house, ["Ann", null, null, null])).toBe(1);
    expect(crownSeat(house, [null, "Ann", null, null])).toBeNull(); // Ann kicked the champion out
  });

  test("crown and streaks survive a restart (also one before the crown was updated); the board counts agent seats only", async () => {
    const store = new SqliteStore(":memory:");
    for (const o of ["Oz", "Cy"]) await store.createOwner(o, `k-${o}`);
    const a = arenaServer(join(outDir, "s"), {}, store);
    await stored(store, 1, [null, null, null, null], 2); // bot-only, house bot in seat 2 wins
    await stored(store, 2, ["Ann", null, null, null], 2); // warm-up, the same house bot defends
    await stored(store, 3, ["Ann", "Ben", null, null], 0); // Ann takes it
    await stored(store, 4, ["Ann", "Ben", "Cat", null], 0);
    await stored(store, 5, ["Ann", null, null, null], 0); // warm-up: streak 3, still 2 ranked
    await stored(store, 6, ["Ann", null, "Cat", null], 0); // streak 4, 3 ranked
    await a.arena.catchUpCrown();
    expect(a.arena.crownView()).toMatchObject({ holder: { kind: "agent", agent: "Ann", owner: "Oz" }, streak: 4, ranked: 3, wonRound: 6 });

    // the process dies after round 7 ended, before it updated the crown; a new one catches up from the store
    await stored(store, 7, ["Ann", null, "Cat", null], 2);
    const b = arenaServer(join(outDir, "s"), {}, store);
    await b.resume();
    expect(b.arena.crownView()).toMatchObject({ holder: { kind: "agent", agent: "Cat", owner: "Cy" }, streak: 1, ranked: 1, wonRound: 7 });
    await stored(store, 8, ["Ann", null, "Cat", null], 2);
    await stored(store, 9, ["Ann", null, "Cat", null], 1, "failed"); // a failed round changes nothing
    await b.arena.catchUpCrown();
    expect(b.arena.crownView()).toMatchObject({ holder: { agent: "Cat" }, streak: 2, ranked: 2 });
    await stored(store, 10, [null, null, null, null], 3); // a house bot takes it: its reign is not recorded
    await b.arena.catchUpCrown();
    expect(b.arena.crownView()).toMatchObject({ holder: { kind: "house", seat: 3 }, streak: 1, ranked: 0 });
    // applied once: catching up again changes nothing
    await b.arena.catchUpCrown();
    expect(await store.getCrown()).toMatchObject({ round: 10, crown: { streak: 1 } });
    // Ann takes the crown back: a new streak of 1 never lowers her best of 3
    await stored(store, 11, ["Ann", "Ben", null, null], 0);
    await b.arena.catchUpCrown();
    expect(b.arena.crownView()).toMatchObject({ holder: { agent: "Ann" }, streak: 1, ranked: 1 });

    const board = (await call(b, "GET", "/api/leaderboard")).data;
    expect(board.agents.map((x: any) => [x.name, x.owner, x.vsAgents, x.vsHouse, x.bestStreak])).toEqual([
      ["Ann", "Oz", { rounds: 6, wins: 4 }, { rounds: 2, wins: 1 }, 3],
      ["Cat", "Cy", { rounds: 4, wins: 2 }, { rounds: 0, wins: 0 }, 2],
      ["Ben", "Oz", { rounds: 3, wins: 0 }, { rounds: 0, wins: 0 }, 0],
    ]);
    expect(board.owners.map((x: any) => [x.owner, x.agents, x.vsAgents, x.vsHouse, x.bestStreak, x.bestBy])).toEqual([
      ["Oz", 2, { rounds: 9, wins: 4 }, { rounds: 2, wins: 1 }, 3, "Ann"],
      ["Cy", 1, { rounds: 4, wins: 2 }, { rounds: 0, wins: 0 }, 2, "Cat"],
    ]);
    expect(board.agents[0].label).toBe("remote/Ann@claude-opus-5-5|claude-code/2.1.0");
    expect(board.crown).toMatchObject({ holder: { kind: "agent", agent: "Ann" }, streak: 1 });
  });

  test("each stored round counts once, however often the crown catches up", async () => {
    const store = new SqliteStore(":memory:");
    for (const o of ["Oz", "Cy"]) await store.createOwner(o, `k-${o}`);
    const a = arenaServer(join(outDir, "once"), {}, store);
    await stored(store, 1, ["Ann", "Ben", null, null], 0);
    await stored(store, 2, ["Ann", "Ben", null, null], 0);
    await a.arena.catchUpCrown();
    await a.arena.catchUpCrown();
    await arenaServer(join(outDir, "once"), {}, store).resume(); // a restart catches up too
    expect((await store.getCrown()).crown).toMatchObject({ holder: { name: "Ann" }, streak: 2, ranked: 2, wonRound: 2 });
    expect(await store.listStreaks()).toEqual([{ name: "Ann", owner: "Oz", best: 2, round: 2 }]);
  });

  test("live: the winner takes the crown and starts the next round with the crown mark", async () => {
    const api = arenaServer(join(outDir, "live"));
    const ann = await enter(api, "Ann");
    const ben = await enter(api, "Ben");
    const live = (await api.handle(new Request("http://kb.test/api/live"), "10.8.0.2"))!.body!.getReader();
    const m1 = await round(api, [ann, ben]);
    const w = m1.runner!.match.winner;
    const won = m1.agents[w]?.name ?? null;
    const q = (await call(api, "GET", "/api/queue")).data;
    expect(q.crown).toMatchObject({ streak: 1, wonRound: 1, holder: won ? { kind: "agent", agent: won } : { kind: "house", seat: w } });
    expect(q.lastRound).toMatchObject({ number: 1, match: m1.id, tier: "featured", winner: w, replay: `/replay/${m1.id}` });
    expect(q.lastRound.seats.find((s: { place: number }) => s.place === 1).seat).toBe(w);

    const m2 = await round(api, [ann, ben]);
    expect(m2.crown).toEqual({ seat: w, streak: 1 }); // the holder plays the same seat (agents keep theirs; house bots hold theirs)
    expect((await call(api, "GET", `/api/matches/${m2.id}`)).data.crown).toEqual({ seat: w, streak: 1 });
    // spectators get the mark with the round's start on the Arena stream
    let text = "";
    while (!text.includes(`"matchId":"${m2.id}"`)) text += new TextDecoder().decode((await live.read()).value);
    await live.cancel();
    expect(text).toContain(`"matchId":"${m2.id}","arenaRound":2,"crown":{"seat":${w},"streak":1}`);
    const kept = m2.runner!.match.winner === w;
    expect((await call(api, "GET", "/api/queue")).data.crown.streak).toBe(kept ? 2 : 1);
  });
});
