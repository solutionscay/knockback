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
  // #125: the cave in the rotation as well (match seeds pick from seven themes)
  // #127: space in the rotation as well (match seeds pick from eight themes; its rounds play low gravity)
  // #135: a swimmer plans from the pool it is in and swims for the way out (fight 1001 is a forest round, with a creek)
  // #69: the ledge guard runs after the zone's and the hop-breaker's walks; the hop-breaker walks in the air only the
  // way the landing allows; the going-nowhere back-off obeys the air's landing; a chunk up to 2.6 m off in the line
  // is walked up to and broken
  // #156: the zone stops (regular and sudden death) only on ground a fighter can hold, and sudden death closes to the
  // nearest such ground (match rounds 1 and 3 move; fight 1001 and the neutral match keep their hashes)
  // #159: sudden-death drops land on ground the survivors reach; a swimmer lifted out of the water by a stroke still
  // plans from its pool; an escape from a pocket starts on the ground and never pushes over a drop (fight 1001, Close
  // Quarters and the match move; the neutral match keeps its hashes)
  // #159 (seat order): the fighters act (inputs, then pickups) in an order that turns with the tick, not in seat order,
  // so no seat lands first in every trade of blows or wins every race for an item (every hash moves; the neutral match
  // now plays three rounds)
  // #163: debris on the way to a pickup (a crate, glass, a small chunk the hop cannot clear) is punched through, and a
  // pickup under a prop or a chunk is taken from the floor beside it, not from on top (fight 1001 keeps its hash; the
  // plan update, Close Quarters and the match move; the neutral match keeps its first round)
  // #40: the force field. The state hash now covers it (each fighter's carried force field, the fields that are up, and
  // the force field drop's own random stream), so every hash moves, even in rounds where none drops. Rounds where a
  // supply drop brings one play differently from then on: in both golden matches one drops and goes up twice in round
  // 1, and one drops in round 3 but never goes up; round 2 sees no drop (it moves by the hash's new fields and by what
  // round 1 left: morale and plans); fight 1001, the plan update and Close Quarters see no drop and move only by the
  // hash's new fields
  // #174: Drop and crate draws now include the freeze gun. The hash includes its ammo, cooldown and each fighter’s chill timer.
  fight: "e1142fad",
  fightWithUpdate: "64e07536",
  closeQuarters: "ca151c32",
  // house bots play their souls' builds (#80)
  match: ["ac90c754", "33b39db7", "ff9a2114"],
  /** the same match with every house bot on a neutral build: the old game (#79) */
  neutralMatch: ["778ee87e", "474f9510", "75c45747"],
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
