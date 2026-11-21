/**
 * Contract 1: determinism. The same seed, ruleset and plans give the same fight hash, on every run and every machine.
 * A record replays to its recorded state; a record that does not is reported, never replayed into a different result.
 *
 * The golden hashes below move only when the sim changes on purpose. Then update them in the same commit, and say why.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { CLOSE_QUARTERS, Fight, FightDivergedError, initPhysics, Match, replayFight, replayMatch, ReplayDivergedError, type FightRecord, type MatchRecord, type PlanUpdate, type Strategy } from "../src/sim";

beforeAll(async () => {
  await initPhysics();
});

const PLANS: Strategy[] = [
  { target: "weakest", stance: "rush", weapons: ["rocket", "bat"], retaliate: "attacker", line: "" },
  { target: "nearest", stance: "distance", weapons: ["shotgun"], line: "" },
  { target: "grudge", grudge: 0, stance: "cover", weapons: ["grenade", "rifle"], line: "" },
  { target: "leader", stance: "item", weapons: ["bat", "rocket", "shotgun"], rules: [{ when: "my_health_below", value: 40, do: "seek", doItem: "health", label: "patch up" }], line: "" },
];
const UPDATE: PlanUpdate = { tick: 300, fighter: 1, strategy: { target: "strongest", stance: "rush", weapons: ["bat"], line: "" } };

const GOLDEN_MATCH_SEED = 7;
const GOLDEN = {
  fight: "ee757597",
  fightWithUpdate: "6a4e4050",
  closeQuarters: "f74910d2",
  match: ["6bf41688", "b6e1bf90", "50ccd789"],
};

const fight = (seed: number, opts: ConstructorParameters<typeof Fight>[2] = {}, updates: PlanUpdate[] = []) => {
  const f = new Fight(seed, PLANS, opts, updates);
  f.playToEnd();
  return f;
};
/** Made once, on first use, and shared: each test stands on its own (no order between tests). */
const once = <T>(make: () => T) => {
  let v: { value: T } | undefined;
  return () => (v ??= { value: make() }).value;
};
const fightWithUpdate = once(() => fight(1001, {}, [UPDATE]));
const match = once(() => {
  const m = new Match(GOLDEN_MATCH_SEED);
  m.playToEnd();
  return m;
});
/** Records as stored on disk (a JSON round trip). */
const fightRecord = (): FightRecord => JSON.parse(JSON.stringify(fightWithUpdate().record));
const matchRecord = (): MatchRecord => JSON.parse(JSON.stringify(match().record));

describe("determinism", () => {
  test("golden hashes", () => {
    expect(fight(1001).record.finalHash).toBe(GOLDEN.fight);
    expect(fightWithUpdate().record.finalHash).toBe(GOLDEN.fightWithUpdate);
    expect(fight(1001, { ruleset: CLOSE_QUARTERS }).record.finalHash).toBe(GOLDEN.closeQuarters);
    expect(match().record.rounds.map((r) => r.fight.finalHash)).toEqual(GOLDEN.match);
  });

  test("a fight record replays to its recorded hash and checkpoints", () => {
    const rec = fightRecord();
    const r = replayFight(rec);
    expect(r.finalHash).toBe(rec.finalHash);
    expect(r.checkpoints).toEqual(rec.checkpoints);
  });

  test("a match record replays; a tampered one is reported as diverged", () => {
    const rec = matchRecord();
    expect(replayMatch(rec).record.rounds.map((r) => r.fight.finalHash)).toEqual(rec.rounds.map((r) => r.fight.finalHash));
    // a plan the fight never played: the replay must not pass for the recorded match
    const bad = matchRecord();
    const s = bad.rounds[0]!.strategies[0]!;
    bad.rounds[0]!.strategies[0] = { ...s, stance: s.stance === "rush" ? "hold" : "rush", target: s.target === "weakest" ? "strongest" : "weakest" };
    expect(() => replayMatch(bad)).toThrow(ReplayDivergedError);
  });

  test("a fight record that does not reach its recorded hash throws instead of returning another hash", () => {
    // a record whose plans no longer give its hash (a changed sim or a damaged file)
    const bad = fightRecord();
    bad.strategies = bad.strategies.map((s) => ({ ...s, stance: s.stance === "rush" ? "hold" : "rush" }));
    expect(() => replayFight(bad)).toThrow(FightDivergedError);
  });
});
