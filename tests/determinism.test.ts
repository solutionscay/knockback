/**
 * Contract 1: determinism. The same seed, ruleset and plans give the same fight hash, on every run and every machine.
 * A record replays to its recorded state; a record that does not is reported, never replayed into a different result.
 *
 * The golden hashes below move only when the sim changes on purpose. Then update them in the same commit, and say why.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { CLOSE_QUARTERS, Fight, FightDivergedError, houseBrain, initPhysics, Match, replayFight, replayMatch, ReplayDivergedError, type FightRecord, type MatchRecord, type PlanUpdate, type Strategy } from "../src/sim";

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
  // #95: the weapon economy (few, spread-out weapons, one slot plus fists, ammo on every weapon, bots that re-arm)
  // #100: the stage (a gap with a catwalk, jump-through platforms, soft over hard ground, wall jump); bots climb or dig out
  // #111: the beach in the rotation (match seeds pick from five themes); bots afloat swim for a rim
  // #109 (on top of #111): a few more weapons (5 at the start, a drop every 6 s, 4 in play), a drop for a fighter cut off from every
  // weapon, bare-handed bots go for one first, the jetpack lasts 3 s, the ground check sees corners; a bot breaks a chunk
  // lodged in its line of sight
  // #114: the forest in the rotation (match seeds pick from six themes); a stale landing no longer steers a swimmer, a run-up
  // on mud asks for what mud allows, a swimmer's splash re-arms after 45 ticks
  fight: "b4f79ad7",
  fightWithUpdate: "15b87cb9",
  closeQuarters: "38c66ba0",
  // house bots play their souls' builds (#80)
  match: ["9fc581ee", "a92df55a", "db5e2591"],
  /** the same match with every house bot on a neutral build: the old game (#79) */
  neutralMatch: ["44774354", "671c41ac", "fdf6fc31"],
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

  test("neutral builds are the old game (#79): plans with explicit neutral builds give the golden hashes", () => {
    const neutral = { health: 0, weight: 0, power: 0 };
    const f = new Fight(1001, PLANS.map((s) => ({ ...s, build: neutral })));
    f.playToEnd();
    expect(f.record.finalHash).toBe(GOLDEN.fight);
    // and house bots on neutral builds play the old house-bot match
    const neutralHouse = [0, 1, 2, 3].map(() => (ctx: Parameters<typeof houseBrain>[0]) => {
      const d = houseBrain(ctx);
      return { ...d, strategy: { ...d.strategy, build: neutral } };
    });
    const m = new Match(GOLDEN_MATCH_SEED, { brains: neutralHouse });
    m.playToEnd();
    expect(m.record.rounds.map((r) => r.fight.finalHash)).toEqual(GOLDEN.neutralMatch);
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
