/**
 * Mid-round plan updates in the engine (#8): applied at their tick, in
 * fighter order, recorded, hashed, replayed exactly.
 */
import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { CHECKPOINT_TICKS, Fight, initPhysics, Match, replayFight, replayMatch, ReplayDivergedError, type MatchRecord, type PlanUpdate, type SimEvent, type Strategy } from "../src/sim";
import { sanitizeRecord } from "../src/viewer/sanitize";

// several whole matches per test: room for a loaded machine
setDefaultTimeout(60_000);
beforeAll(async () => {
  await initPhysics();
});

const plan = (p: Partial<Strategy>): Strategy => ({ target: "nearest", stance: "rush", weapons: ["rocket", "bat"], retaliate: "turn", line: "", ...p });
const BASE = [plan({}), plan({ stance: "distance", weapons: ["shotgun"] }), plan({ target: "weakest" }), plan({ stance: "item", weapons: ["grenade", "grapple"] })];
const UPDATES: PlanUpdate[] = [
  { tick: 300, fighter: 2, strategy: plan({ target: "grudge", grudge: 0, stance: "distance" }), line: "You first.", source: "checkin" },
  { tick: 720, fighter: 0, strategy: plan({ stance: "cover", weapons: ["grenade"] }), source: "checkin" },
  { tick: 1300, fighter: 3, strategy: plan({ target: "strongest", stance: "rush", rules: [{ when: "my_health_below", value: 30, do: "stance", stance: "cover", label: "hide when hurt" }] }), why: "low on health", source: "checkin" },
];

function fightWith(updates: PlanUpdate[], seed = 77): Fight {
  const f = new Fight(seed, BASE, {}, updates);
  f.playToEnd();
  return f;
}

describe("plan updates in a fight (#8)", () => {
  test("a fight with 3 updates replays to the same hash; without them the hash differs", () => {
    const f = fightWith(UPDATES);
    expect(f.record.version).toBe(5);
    expect(f.record.updates!.map((u) => u.tick)).toEqual([300, 720, 1300]);
    const rec = JSON.parse(JSON.stringify(f.record));
    const again = replayFight(rec);
    expect(again.finalHash).toBe(f.record.finalHash);
    expect(again.checkpoints).toEqual(f.record.checkpoints);
    const none = fightWith([]);
    expect(none.record.version).toBe(4);
    expect(none.record.updates).toBeUndefined();
    expect(none.record.finalHash).not.toBe(f.record.finalHash);
    // before the first update the two fights are the same; from the first checkpoint after it they differ
    const firstAfter = Math.ceil(300 / CHECKPOINT_TICKS) - 1;
    expect(f.record.checkpoints.slice(0, firstAfter)).toEqual(none.record.checkpoints.slice(0, firstAfter));
    expect(f.record.checkpoints[firstAfter]).not.toBe(none.record.checkpoints[firstAfter]);
  });

  test("a record missing an update fails at the first checkpoint after it", () => {
    const f = fightWith(UPDATES);
    const missing = { ...JSON.parse(JSON.stringify(f.record)), updates: f.record.updates!.filter((u) => u.tick !== 720) };
    const r = replayFight(missing);
    const k = Math.ceil(720 / CHECKPOINT_TICKS) - 1;
    expect(r.checkpoints.slice(0, k)).toEqual(f.record.checkpoints.slice(0, k));
    expect(r.checkpoints[k]).not.toBe(f.record.checkpoints[k]);
  });

  test("the update's tick, not only its plan, is in the hash", () => {
    // same plan one tick later: even if play turned out the same, the hash must not
    const a = fightWith([UPDATES[0]!]);
    const b = fightWith([{ ...UPDATES[0]!, tick: 301 }]);
    expect(a.record.finalHash).not.toBe(b.record.finalHash);
  });

  test("a line, a why or rule labels don't change the hash (the viewer may trim them)", () => {
    const a = fightWith(UPDATES);
    const relabeled = UPDATES.map((u) => ({ ...u, line: "different", why: undefined, strategy: { ...u.strategy, line: "x", rules: u.strategy.rules?.map((r) => ({ ...r, label: "other" })) } }));
    expect(fightWith(relabeled).record.finalHash).toBe(a.record.finalHash);
  });

  test("updates for two fighters at the same tick apply in fighter order", () => {
    const f = new Fight(77, BASE);
    const seen: SimEvent[] = [];
    f.onEvent = (e) => {
      if (e.type === "plan") seen.push(e);
    };
    f.addUpdate({ tick: 120, fighter: 3, strategy: plan({ stance: "cover" }) });
    f.addUpdate({ tick: 120, fighter: 1, strategy: plan({ stance: "rush" }) });
    f.addUpdate({ tick: 60, fighter: 2, strategy: plan({ stance: "item" }) });
    expect(f.planUpdates.map((u) => [u.tick, u.fighter])).toEqual([[60, 2], [120, 1], [120, 3]]);
    while (f.sim.tick < 200) f.step();
    expect(seen.map((e) => (e.type === "plan" ? [e.tick, e.fighter] : []))).toEqual([[60, 2], [120, 1], [120, 3]]);
    expect(f.controllers[1]!.strategy.stance).toBe("rush");
    expect(f.controllers[3]!.strategy.stance).toBe("cover");
    // added in any order, the same result
    const g = new Fight(77, BASE, {}, [f.planUpdates[2]!, f.planUpdates[0]!, f.planUpdates[1]!]);
    g.playToEnd();
    f.playToEnd();
    expect(g.record.finalHash).toBe(f.record.finalHash);
  });

  test("an update for a tick that has passed is an error; the current tick is fine", () => {
    const f = new Fight(77, BASE);
    while (f.sim.tick < 100) f.step();
    expect(() => f.addUpdate({ tick: 99, fighter: 0, strategy: plan({}) })).toThrow(/already at tick 100/);
    expect(() => f.addUpdate({ tick: 100, fighter: 5, strategy: plan({}) })).toThrow(/no such fighter/);
    f.addUpdate({ tick: 100, fighter: 0, strategy: plan({ stance: "cover" }) });
    f.step();
    expect(f.controllers[0]!.strategy.stance).toBe("cover");
  });
});

describe("plan updates in a match (#8)", () => {
  /** Play a house-bot match, adding `ups(round)` during each round with stepUntil + addUpdate. */
  function playWith(seed: number, ups: (round: number, m: Match) => PlanUpdate[]): Match {
    const m = new Match(seed);
    while (!m.over) {
      m.prepareRound();
      for (const u of ups(m.round, m)) {
        if (m.stepUntil(u.tick)) break;
        m.addUpdate(u);
      }
      while (!m.step()) {
        /* rest of the round */
      }
      m.finishRound();
    }
    return m;
  }
  const ups = (round: number, m: Match): PlanUpdate[] => [
    { tick: 600, fighter: round % 4, strategy: { ...m.decisions[round % 4]!.strategy, stance: "cover" }, line: "Regrouping.", source: "checkin" },
    { tick: 1200, fighter: (round + 1) % 4, strategy: { ...m.decisions[(round + 1) % 4]!.strategy, target: "weakest" }, source: "checkin" },
  ];

  test("stepUntil + addUpdate: the record has the updates with ticks and replays to the same hashes", () => {
    const m = playWith(9, ups);
    const plain = new Match(9);
    plain.playToEnd();
    expect(m.record.rounds[0]!.planUpdates!.map((u) => u.tick)).toEqual([600, 1200]);
    expect(m.record.rounds[0]!.fight.updates).toEqual(m.record.rounds[0]!.planUpdates);
    expect(m.record.rounds[0]!.fight.finalHash).not.toBe(plain.record.rounds[0]!.fight.finalHash);
    const rec: MatchRecord = JSON.parse(JSON.stringify(m.record));
    const again = replayMatch(rec);
    expect(again.record.rounds.map((r) => r.fight.finalHash)).toEqual(m.record.rounds.map((r) => r.fight.finalHash));
    expect(again.record.rounds.map((r) => r.winner)).toEqual(m.record.rounds.map((r) => r.winner));
    // the viewer's path: sanitized record (updates checked like plans), same hashes
    const viewer = replayMatch(sanitizeRecord(JSON.parse(JSON.stringify(m.record)))!);
    expect(viewer.record.rounds.map((r) => r.fight.finalHash)).toEqual(m.record.rounds.map((r) => r.fight.finalHash));
    // drop an update: the replay is refused as diverged
    const missing: MatchRecord = JSON.parse(JSON.stringify(m.record));
    missing.rounds[0]!.planUpdates = missing.rounds[0]!.planUpdates!.slice(0, 1);
    expect(() => replayMatch(missing)).toThrow(ReplayDivergedError);
  });

  test("with no updates, records and hashes are exactly as before", () => {
    const m = playWith(9, () => []);
    const plain = new Match(9);
    plain.playToEnd();
    expect(JSON.stringify(m.record)).toBe(JSON.stringify(plain.record));
    expect(m.record.rounds.every((r) => r.fight.version === 4 && !("planUpdates" in r))).toBe(true);
  });

  test("an update for a passed tick is an error at the match level too", () => {
    const m = new Match(9);
    m.prepareRound();
    m.stepUntil(500);
    expect(() => m.addUpdate({ tick: 400, fighter: 0, strategy: m.decisions[0]!.strategy })).toThrow(/already at tick 500/);
  });
});
