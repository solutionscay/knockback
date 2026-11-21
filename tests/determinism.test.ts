/**
 * Contract 1: determinism. The same seed, ruleset and plans give the same fight hash, on every run and every machine.
 * A record replays to its recorded state; a record from another engine version is refused, not replayed into a
 * different result.
 *
 * The golden hashes below change only with ENGINE_VERSION (src/sim/engine-version.ts). If a change moves them without
 * a version bump, old records would replay differently: bump ENGINE_VERSION and update the goldens in the same commit.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { CLOSE_QUARTERS, ENGINE_VERSION, Fight, initPhysics, Match, OtherEngineError, replayFight, replayMatch, ReplayDivergedError, type FightRecord, type MatchRecord, type PlanUpdate, type Strategy } from "../src/sim";

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

/** The engine these goldens were made with. */
const GOLDEN_ENGINE = 7;
const GOLDEN_MATCH_SEED = 7;
const GOLDEN = {
  fight: "37127b56",
  fightWithUpdate: "341024d8",
  closeQuarters: "dfe9d344",
  match: ["9a315974", "496a60dd"],
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
  test("golden hashes of the current engine", () => {
    expect(ENGINE_VERSION).toBe(GOLDEN_ENGINE); // a version bump: update the goldens below
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

  test("a match record from another engine is refused", () => {
    expect(() => replayMatch({ ...matchRecord(), engine: ENGINE_VERSION - 1 })).toThrow(OtherEngineError);
    const { engine: _drop, ...noEngine } = matchRecord();
    expect(() => replayMatch(noEngine as MatchRecord)).toThrow(OtherEngineError);
  });

  // replayFight must refuse an old engine's record instead of replaying it into another hash
  test("a fight record from another engine is refused", () => {
    expect(() => replayFight({ ...fightRecord(), engine: ENGINE_VERSION - 1 } as FightRecord)).toThrow(/engine/);
  });
});
