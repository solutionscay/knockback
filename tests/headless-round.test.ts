/**
 * Contract 8: headless rounds. The eval loop (src/ai/run.ts) and the match runner (src/ai/runner.ts) play each round
 * headless at once from the seats' decisions. The fight is the sim's own: house seats give the same match as the
 * sim's house brains, a saved eval record rescores to the same eval input, and the stored rounds of a runner match
 * replay to the same fights (the server's resume); a stored round that does not is refused.
 *
 * Seats are house bots and one in-process stub provider with a fixed answer: no model, no network, no real time.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import type { Seat } from "../src/ai/decide";
import { playAiMatch, rescoreRecord } from "../src/ai/run";
import { MatchRunner, ResumeError, type StoredRound } from "../src/ai/runner";
import { exampleSouls, initPhysics, Match, ReplayDivergedError, replayMatch, type MatchRecord, type PlanUpdate } from "../src/sim";

beforeAll(async () => {
  await initPhysics();
});

const SEED = 2;
const ANSWER = JSON.stringify({ weapons: ["rocket", "bat"], target: "weakest", stance: "rush", retaliate: "attacker", line: "Here I come." });
const souls = exampleSouls();
const house = (i: number): Seat => ({ providerName: "house", provider: null, soul: souls[i]! });
const stub = (i: number): Seat => ({ providerName: "stub", provider: { label: "stub/fixed", ask: async () => ANSWER, deadlineMs: 600_000 }, soul: souls[i]! });
const mixed = (): Seat[] => [house(0), stub(1), house(2), house(3)];
const hashes = (rec: MatchRecord) => rec.rounds.map((r) => r.fight.finalHash);

/** A runner match in fast mode; its rounds stored as the server stores them (decisions, then hash and plan updates). */
async function runStored(seats: Seat[]) {
  const stored: StoredRound[] = [];
  const runner = new MatchRunner({
    seed: SEED,
    seats,
    onDecided: (_round, ask) => void stored.push({ decisions: ask.decisions, meta: ask.meta, prompts: ask.prompts, raw: ask.raw }),
    onPlayed: (round, finalHash, planUpdates) => void Object.assign(stored[round - 1]!, { finalHash, planUpdates }),
  });
  await runner.run();
  return { runner, stored: JSON.parse(JSON.stringify(stored)) as StoredRound[] };
}
/** Played once, on first use, and shared: each test stands on its own (no order between tests). */
let storedMatch: ReturnType<typeof runStored> | undefined;
const stored = () => (storedMatch ??= runStored(mixed()));

describe("headless rounds", () => {
  test("house seats in the runner and the eval loop play the sim's own house-bot match", async () => {
    const sim = new Match(SEED, { souls });
    sim.playToEnd();
    const seats = [0, 1, 2, 3].map(house);
    const runner = new MatchRunner({ seed: SEED, seats });
    await runner.run();
    const played = await playAiMatch(SEED, seats, souls, undefined, false, { suitUp: false });
    expect(hashes(runner.match.record)).toEqual(hashes(sim.record));
    expect(hashes(played.match.record)).toEqual(hashes(sim.record));
    expect([runner.match.winner, played.match.winner]).toEqual([sim.winner, sim.winner]);
  });

  test("an eval record rescores to the eval input it was played with; a tampered one is refused", async () => {
    const lineup = ["house", "stub", "house", "house"];
    const played = await playAiMatch(SEED, mixed(), souls, undefined, false, { suitUp: false });
    expect(played.match.over).toBe(true);
    expect(played.prompts.map((p) => p.round)).toEqual(played.match.record.rounds.map((_, i) => i + 1));
    // the stub's plan was played, and the house plan in its place was kept for comparison
    expect(played.eval.rounds.every((r) => r.decisions[1]!.meta.outcome === "ok" && r.decisions[1]!.strategy.stance === "rush" && r.decisions[1]!.house)).toBe(true);
    const rec = (): MatchRecord => JSON.parse(JSON.stringify(played.match.record));
    expect(rescoreRecord(rec(), lineup)).toEqual(played.eval);
    const bad = rec();
    // plans the fight never played: the rescore must not pass for the played match
    bad.rounds[0]!.strategies = bad.rounds[0]!.strategies.map((s) => ({ ...s, stance: s.stance === "rush" ? "hold" : "rush", target: s.target === "weakest" ? "strongest" : "weakest" }));
    expect(() => rescoreRecord(bad, lineup)).toThrow(ReplayDivergedError);
  });

  test("a runner match replays from its stored rounds to the same fights", async () => {
    const { runner, stored: rounds } = await stored();
    expect(runner.match.over).toBe(true);
    expect(replayMatch(JSON.parse(JSON.stringify(runner.savedRecord()))).winner).toBe(runner.match.winner);
    const again = new MatchRunner({ seed: SEED, seats: mixed() });
    for (const r of rounds) await again.replayRound(r);
    expect(hashes(again.match.record)).toEqual(hashes(runner.match.record));
    expect(again.match.winner).toBe(runner.match.winner);
  });

  test("a stored round whose fight ends elsewhere is refused at resume", async () => {
    const s = (await stored()).stored[0]!;
    const wrongHash = new MatchRunner({ seed: SEED, seats: mixed() });
    await expect(wrongHash.replayRound({ ...s, finalHash: "00000000" })).rejects.toThrow(ResumeError);
    // a house seat whose stored plan is not the house bot's would change every later round (refused before the hash is compared)
    const wrongPlan = new MatchRunner({ seed: SEED, seats: mixed() });
    const decisions = s.decisions.map((d, i) => (i === 0 ? { ...d, strategy: { ...d.strategy, stance: d.strategy.stance === "rush" ? "hold" : "rush" } } : d)) as StoredRound["decisions"];
    await expect(wrongPlan.replayRound({ ...s, decisions, finalHash: null })).rejects.toThrow(ResumeError);
  });

  test("a stored round's plan updates apply at their ticks and go into the record", async () => {
    const s = (await stored()).stored[0]!;
    const plain = new MatchRunner({ seed: SEED, seats: mixed() });
    await plain.replayRound(s);
    const update: PlanUpdate = { tick: 300, fighter: 1, strategy: { target: "strongest", stance: "distance", weapons: ["shotgun"], line: "" }, source: "checkin" };
    const updated = new MatchRunner({ seed: SEED, seats: mixed() });
    await updated.replayRound({ ...s, finalHash: null, planUpdates: [update] });
    const round = updated.match.record.rounds[0]!;
    expect(round.planUpdates).toEqual([update]);
    expect(round.fight.finalHash).not.toBe(plain.match.record.rounds[0]!.fight.finalHash);
    // the record with the update replays to the same fight
    const rec: MatchRecord = JSON.parse(JSON.stringify({ ...updated.match.record, winner: -1 }));
    const replay = new Match(rec.seed, { recorded: rec });
    replay.playRound();
    expect(replay.record.rounds[0]!.fight.finalHash).toBe(round.fight.finalHash);
  });
});
