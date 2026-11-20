import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Fight, initPhysics, Match, replayFight, replayMatch, RULE_EVAL, type Rule, type SimEvent, type Strategy } from "../src/sim";
import { flatLevel } from "./helpers";

setDefaultTimeout(120_000);
beforeAll(async () => {
  await initPhysics();
});

/** Seat 0 owns the rules; its plan otherwise goes after seat 3 (grudge). */
const plan = (rules: Rule[] = [], over: Partial<Strategy> = {}): Strategy => ({ target: "grudge", grudge: 3, stance: "cover", weapons: ["shotgun", "rocket"], retaliate: "turn", line: "", ...(rules.length ? { rules } : {}), ...over });
const others = (): Strategy[] => [1, 2, 3].map(() => ({ target: "nearest", stance: "cover", weapons: ["shotgun"], retaliate: "turn", line: "" }));

const place = (f: Fight, id: number, x: number, y = 0.9) => {
  const b = f.sim.fighters[id]!.entity.body;
  b.setTranslation({ x, y }, true);
  b.setLinvel({ x: 0, y: 0 }, true);
};
/** The rule owner (seat 0) stands armed in the middle of the flat test level, away from its edges. */
function setUp(f: Fight) {
  place(f, 0, 2);
  f.sim.fighters[0]!.weapons = ["shotgun", "rocket"];
  f.step();
}
function fight(rules: Rule[], props: Parameters<typeof flatLevel>[0] = [], over: Partial<Strategy> = {}) {
  const f = new Fight(7, [plan(rules, over), ...others()], { level: flatLevel(props) });
  // These setups add their own pickups, so the shuffled armory cannot trigger a rule early.
  for (const item of f.sim.items()) item.body.setTranslation({ x: 0, y: -30 }, true);
  const evs: SimEvent[] = [];
  f.onEvent = (e) => evs.push(e);
  f.step();
  setUp(f);
  return { f, evs, c: f.controllers[0]!, sim: f.sim };
}
/** Step until cond() or n ticks; returns ticks taken (or -1). */
const until = (f: Fight, cond: () => boolean, n = 60) => {
  for (let i = 1; i <= n; i++) {
    f.step();
    if (cond()) return i;
  }
  return -1;
};
const ruleOn = (evs: SimEvent[], i = 0) => evs.some((e) => e.type === "rule" && e.fighter === 0 && e.rule === i && e.on);

describe("every trigger fires in a small set-up fight (#6)", () => {
  test("holds -> target: someone picks up a rocket, the target changes within 0.5 s", () => {
    const { f, evs, c, sim } = fight([{ when: "holds", who: "enemy", item: "rocket", do: "target", label: "chase the rocket" }]);
    expect(c.targetId).toBe(3);
    const p = sim.pos(sim.fighters[2]!);
    sim.spawnItem("rocket", p.x, p.y);
    const t = until(f, () => c.targetId === 2, 30);
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThanOrEqual(30);
    expect(ruleOn(evs)).toBe(true);
  });

  test("my_health_below -> seek: low on health, it goes for a health pack", () => {
    const { f, evs, c, sim } = fight([{ when: "my_health_below", value: 40, do: "seek", doItem: "health", label: "patch up" }]);
    const me = sim.fighters[0]!;
    me.hp = 30;
    const p = sim.pos(me);
    sim.spawnItem("health", p.x - 5, p.y);
    until(f, () => ruleOn(evs), 30);
    expect(c.rules.seeking()).toEqual(["health"]);
    expect(until(f, () => me.pickups.includes("health"), 240)).toBeGreaterThan(0);
  });

  test("health_below -> target", () => {
    const { f, evs, c, sim } = fight([{ when: "health_below", who: "enemy", value: 30, do: "target", label: "finish the wounded" }]);
    sim.fighters[1]!.hp = 20;
    expect(until(f, () => c.targetId === 1, 30)).toBeGreaterThan(0);
    expect(evs.find((e) => e.type === "rule" && e.on)).toMatchObject({ fighter: 0, rule: 0, subject: 1 });
  });

  test("near_ledge -> use: a rival at the pit edge, the hook comes out", () => {
    const { f, c, sim } = fight([{ when: "near_ledge", who: "enemy", do: "use", doItem: "grapple", label: "hook them off" }]);
    sim.fighters[0]!.weapons = ["grapple", "shotgun"];
    place(f, 2, 9.2); // the pit starts at x = 10
    expect(until(f, () => c.rules.use() === "grapple", 40)).toBeGreaterThan(0);
    expect(c.rules.state[0]!.subject).toBe(2);
  });

  test("near_barrel -> stance: the target stands by a barrel, the stance changes", () => {
    const { f, c, sim } = fight([{ when: "near_barrel", who: "target", do: "stance", stance: "distance", label: "back off the barrel" }], [{ kind: "barrel", x: 20, y: 0.6 }]);
    place(f, 3, 21);
    expect(until(f, () => c.rules.stance() === "distance", 40)).toBeGreaterThan(0);
    expect(c.stanceNow(sim)).toBe("distance");
  });

  test("on_streak -> avoid: the hot hand is never targeted", () => {
    const { f, c, sim } = fight([{ when: "on_streak", who: "enemy", value: 1, do: "avoid", label: "dodge the hot hand" }]);
    sim.fighters[3]!.kos = 1;
    expect(until(f, () => c.rules.avoided().includes(3), 30)).toBeGreaterThan(0);
    until(f, () => false, 60);
    expect(c.targetId).not.toBe(3);
  });

  test("chasing_me -> target: a rival who has chased me for 3 s becomes my target", () => {
    // only seat 2 chases seat 0 (seat 3 goes after seat 1)
    const strategies = [plan([{ when: "chasing_me", who: "enemy", do: "target", label: "turn on the chaser" }]), others()[0]!, { ...others()[1]!, target: "grudge" as const, grudge: 0 }, { ...others()[2]!, target: "grudge" as const, grudge: 1 }];
    const f = new Fight(7, strategies, { level: flatLevel() });
    f.step();
    setUp(f);
    const c = f.controllers[0]!;
    expect(until(f, () => c.targetId === 2, RULE_EVAL.chaseTicks + 40)).toBeGreaterThan(RULE_EVAL.chaseTicks - 40);
  });

  test("hit_me -> retaliate: just hit by a rival, the retaliate setting changes", () => {
    const { f, c, sim } = fight([{ when: "hit_me", who: "enemy", do: "retaliate", retaliate: "attacker", label: "bite back" }]);
    sim.damageFighter(sim.fighters[0]!, 2, 1, 0, 0, "test", 0, 0);
    expect(until(f, () => c.rules.retaliate() === "attacker", 20)).toBeGreaterThan(0);
  });

  test("item_near -> seek: a shield close by", () => {
    const { f, c, sim } = fight([{ when: "item_near", item: "shield", do: "seek", doItem: "shield", label: "grab the shield" }]);
    const p = sim.pos(sim.fighters[0]!);
    sim.spawnItem("shield", p.x - 3, p.y);
    expect(until(f, () => c.rules.seeking().includes("shield"), 30)).toBeGreaterThan(0);
  });

  test("alone_with -> use: the last two", () => {
    const { f, c, sim } = fight([{ when: "alone_with", do: "use", doItem: "shotgun", label: "duel with the shotgun" }]);
    sim.fighters[0]!.weapons = ["shotgun", "rocket"];
    sim.damageFighter(sim.fighters[1]!, 1000, 3, 0, 0, "test", 0, 0);
    sim.damageFighter(sim.fighters[2]!, 1000, 3, 0, 0, "test", 0, 0);
    expect(until(f, () => c.rules.use() === "shotgun", 20)).toBeGreaterThan(0);
    expect(c.rules.state[0]!.subject).toBe(3);
  });

  test("the base plan comes back when the rule stops", () => {
    const { f, c, sim } = fight([{ when: "health_below", who: "enemy", value: 30, do: "target", label: "finish the wounded" }]);
    sim.fighters[1]!.hp = 20;
    until(f, () => c.targetId === 1, 30);
    sim.fighters[1]!.hp = 90;
    expect(until(f, () => c.targetId === 3, 120)).toBeGreaterThan(0);
    expect(c.strategy.target).toBe("grudge");
  });
});

describe("hysteresis and determinism (#6)", () => {
  test("a flickering trigger toggles the rule at most once a second", () => {
    const { f, evs, sim } = fight([{ when: "health_below", who: "enemy", value: 30, do: "target", label: "finish the wounded" }]);
    for (let t = 0; t < 600; t++) {
      sim.fighters[1]!.hp = Math.floor(t / 7) % 2 ? 20 : 60; // flips every 7 ticks
      f.step();
    }
    const ticks = evs.filter((e): e is Extract<SimEvent, { type: "rule" }> => e.type === "rule" && e.fighter === 0).map((e) => e.tick);
    expect(ticks.length).toBeGreaterThan(2);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]! - ticks[i - 1]!).toBeGreaterThanOrEqual(RULE_EVAL.minOnTicks);
  });

  test("a fight with rules replays to the same hashes; a match with house rules too", () => {
    const rules: Rule[] = [
      { when: "health_below", who: "enemy", value: 40, do: "target", label: "finish the wounded" },
      { when: "my_health_below", value: 50, do: "seek", doItem: "health", label: "patch up" },
      { when: "near_ledge", who: "enemy", do: "use", doItem: "bat", label: "bat them off" },
    ];
    const a = new Fight(9, [plan(rules), plan(rules.slice(1), { grudge: 0 }), ...others().slice(1)]);
    a.playToEnd();
    const r = replayFight(JSON.parse(JSON.stringify(a.record)));
    expect(r.finalHash).toBe(a.record.finalHash);
    expect(r.checkpoints).toEqual(a.record.checkpoints);
    const m = new Match(21);
    m.playToEnd();
    expect(m.record.rounds.some((rd) => rd.strategies.some((s) => s.rules?.length))).toBe(true);
    expect(replayMatch(JSON.parse(JSON.stringify(m.record))).record.rounds.map((x) => x.fight.finalHash)).toEqual(m.record.rounds.map((x) => x.fight.finalHash));
  });

  test("rule events are in the fight events and in RoundFacts (firings and active time per rule)", () => {
    let fired = 0;
    for (const seed of [1, 2, 3, 4]) {
      const m = new Match(seed);
      const evs: SimEvent[] = [];
      m.onEvent = (e) => evs.push(e);
      m.playToEnd();
      m.facts.forEach((f, r) => {
        const strategies = m.record.rounds[r]!.strategies;
        f.stats.rules.forEach((rs, seat) => expect(rs.length).toBe(strategies[seat]!.rules?.length ?? 0));
        fired += f.stats.rules.flat().reduce((a, x) => a + x.fires, 0);
        for (const x of f.stats.rules.flat()) if (x.fires === 0) expect(x.activeTicks).toBe(0);
      });
      const starts = evs.filter((e) => e.type === "rule" && e.on).length;
      expect(starts).toBe(m.facts.reduce((a, f) => a + f.stats.rules.flat().reduce((b, x) => b + x.fires, 0), 0));
    }
    expect(fired).toBeGreaterThan(5);
  });
});
