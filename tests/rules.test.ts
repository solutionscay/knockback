import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseAnswer, parseRules } from "../src/ai/parse";
import { checkRule } from "../src/sim/rules";
import { initPhysics, Match, MAX_RULES, replayMatch, type Rule } from "../src/sim";
import { sanitizeRecord, sanitizeRules } from "../src/viewer/sanitize";

setDefaultTimeout(120_000);
beforeAll(async () => {
  await initPhysics();
});

const NAMES = ["Brick", "Pike", "Squeaks", "Goldie"];
const one = (o: unknown, me = 0) => parseRules([o], me, NAMES);

describe("rule parsing (#5)", () => {
  test("every trigger parses", () => {
    const cases: [unknown, Partial<Rule>][] = [
      [{ when: "holds", who: "anyone", item: "rocket", do: "target" }, { when: "holds", who: "anyone", item: "rocket" }],
      [{ when: "my_health_below", value: 30, do: "seek", item: "health" }, { when: "my_health_below", value: 30, doItem: "health" }],
      [{ when: "health_below", who: "enemy", value: 25, do: "target" }, { when: "health_below", who: "enemy", value: 25 }],
      [{ when: "near_ledge", who: "enemy", do: "use", item: "grapple" }, { when: "near_ledge", who: "enemy", doItem: "grapple" }],
      [{ when: "near_barrel", who: "target", do: "use", item: "rocket" }, { when: "near_barrel", who: "target", doItem: "rocket" }],
      [{ when: "on_streak", who: "enemy", value: 2, do: "avoid" }, { when: "on_streak", who: "enemy", value: 2, do: "avoid" }],
      [{ when: "chasing_me", who: "Pike", do: "target" }, { when: "chasing_me", who: 1 }],
      [{ when: "hit_me", who: "enemy", do: "retaliate", retaliate: "attacker" }, { when: "hit_me", retaliate: "attacker" }],
      [{ when: "item_near", item: "shield", do: "seek" }, { when: "item_near", item: "shield", doItem: "shield" }],
      [{ when: "alone_with", do: "stance", stance: "rush" }, { when: "alone_with", stance: "rush" }],
    ];
    for (const [raw, want] of cases) {
      const r = one(raw);
      expect(r.problems).toEqual([]);
      expect(r.rules[0]).toMatchObject(want);
      expect(r.rules[0]!.label.length).toBeGreaterThan(3); // auto label
      expect(r.rules[0]!.label.length).toBeLessThanOrEqual(40);
    }
    expect(new Set(cases.map(([raw]) => (raw as { when: string }).when)).size).toBe(10);
  });

  test("every action parses (and holds + use takes the action's weapon from do_item)", () => {
    const acts = [
      { when: "holds", who: "enemy", item: "bat", do: "target" },
      { when: "holds", who: "enemy", item: "bat", do: "avoid" },
      { when: "my_health_below", value: 40, do: "seek", item: "health" },
      { when: "holds", who: "target", item: "bat", do: "use", do_item: "shotgun" },
      { when: "near_ledge", who: "enemy", do: "stance", stance: "rush" },
      { when: "hit_me", who: "enemy", do: "retaliate", retaliate: "ignore" },
    ];
    const r = parseRules(acts.slice(0, 4), 0, NAMES);
    expect(r.problems).toEqual([]);
    expect(r.rules.map((x) => x.do)).toEqual(["target", "avoid", "seek", "use"]);
    expect(r.rules[3]).toMatchObject({ item: "bat", doItem: "shotgun" });
    const r2 = parseRules(acts.slice(4), 0, NAMES);
    expect(r2.rules.map((x) => x.do)).toEqual(["stance", "retaliate"]);
  });

  test("each kind of bad input drops only that rule, with a clear problem", () => {
    const bad: [unknown, RegExp][] = [
      [{ when: "teleports", who: "enemy", do: "target" }, /unknown trigger "teleports"/],
      [{ when: "holds", who: "enemy", item: "rocket", do: "explode" }, /unknown action "explode"/],
      [{ when: "holds", who: "enemy", item: "laser", do: "target" }, /unknown item "laser"/],
      [{ when: "holds", who: "Zorro", item: "rocket", do: "target" }, /no fighter named "Zorro"/],
      [{ when: "holds", who: "Brick", item: "rocket", do: "target" }, /can't be yourself/],
      [{ when: "holds", item: "rocket", do: "target" }, /needs "who"/],
      [{ when: "my_health_below", value: 5, do: "seek", item: "health" }, /out of range 10-90/],
      [{ when: "on_streak", who: "enemy", value: 7, do: "avoid" }, /out of range 1-3/],
      [{ when: "health_below", who: "enemy", value: "lots", do: "target" }, /whole-number "value"/],
      [{ when: "my_health_below", value: 30, do: "target" }, /needs a trigger about a fighter/],
      [{ when: "item_near", item: "health", do: "avoid" }, /needs a trigger about a fighter/],
      [{ when: "holds", who: "enemy", item: "bat", do: "stance", stance: "dance" }, /"stance" needs one of/],
      [{ when: "holds", who: "enemy", item: "bat", do: "retaliate" }, /"retaliate" needs one of/],
      [{ when: "near_ledge", who: "enemy", do: "use", item: "health" }, /"use" needs a weapon/],
      ["hook them", /not an object/],
    ];
    for (const [raw, re] of bad) {
      const r = parseRules([raw, { when: "alone_with", do: "stance", stance: "rush", label: "duel" }], 0, NAMES);
      expect(r.rules.map((x) => x.label)).toEqual(["duel"]); // the good rule survives
      expect(r.problems.length).toBe(1);
      expect(r.problems[0]).toMatch(/^rule 1/);
      expect(r.problems[0]).toMatch(re);
    }
    const dup = parseRules([{ when: "alone_with", do: "stance", stance: "rush" }, { when: "alone_with", do: "stance", stance: "rush", label: "again" }], 0, NAMES);
    expect(dup.rules.length).toBe(1);
    expect(dup.problems[0]).toMatch(/duplicate/);
    expect(parseRules("nope", 0, NAMES).problems[0]).toMatch(/expected a list/);
    // lenient: the retaliate value given under "item" (seen in real answers) is understood
    expect(one({ when: "hit_me", who: "enemy", do: "retaliate", item: "attacker" }).rules[0]).toMatchObject({ do: "retaliate", retaliate: "attacker" });
  });

  test("more than 4 rules are cut to 4; names resolve to seat numbers; labels are cleaned", () => {
    const many = ["Pike", "Squeaks", "Goldie", "enemy", "anyone"].map((who) => ({ when: "chasing_me", who, do: "target" }));
    const r = parseRules(many, 0, NAMES);
    expect(r.rules.length).toBe(MAX_RULES);
    expect(r.rules.map((x) => x.who)).toEqual([1, 2, 3, "enemy"]);
    expect(r.problems).toEqual([`rule 5: more than ${MAX_RULES} rules, dropped`]);
    const lab = one({ when: "alone_with", do: "stance", stance: "rush", label: `  "${"a very long label ".repeat(5)}"  ` });
    expect(lab.rules[0]!.label.length).toBeLessThanOrEqual(40);
    expect(lab.rules[0]!.label.startsWith("a very long label")).toBe(true);
  });

  test("rules are optional; bad rules never invalidate the plan; problems go with the answer", () => {
    const base = '"weapons":["rocket"],"target":"nearest","stance":"rush","line":"Go!"';
    const none = parseAnswer(`{${base}}`, 0, NAMES);
    expect(none.strategy!.rules).toBeUndefined();
    expect(none.ruleProblems).toBeUndefined();
    const mixed = parseAnswer(`{${base},"rules":[{"when":"holds","who":"anyone","item":"rocket","do":"target","label":"chase the rocket"},{"when":"flies","do":"target"}]}`, 0, NAMES);
    expect(mixed.strategy).not.toBeNull();
    expect(mixed.strategy!.rules!.map((x) => x.label)).toEqual(["chase the rocket"]);
    expect(mixed.ruleProblems).toEqual(['rule 2: unknown trigger "flies"']);
  });
});

describe("stored rules and records (#5)", () => {
  test("the viewer's sanitizer keeps valid stored rules and drops bad ones", () => {
    const good: Rule = { when: "holds", who: 1, item: "rocket", do: "target", label: "get Pike" };
    expect(checkRule(good, 0)).toBeNull();
    const out = sanitizeRules([good, { ...good, who: 0 }, { ...good, when: "evil" }, { ...good, label: "<img src=x onerror=alert(1)>".repeat(3) }, "x", good, good], 0);
    expect(out.length).toBe(2); // good, and the long label clipped to 40 (still text, shown escaped); then the list is cut at 4 entries
    expect(out[1]!.label.length).toBe(40);
  });

  test("new records are version 4 and keep rules; version 2 and 3 records still load; others are refused clearly", () => {
    const m = new Match(3);
    m.prepareRound([0, 1, 2, 3].map((i) => ({ line: "x", strategy: { target: "nearest", stance: "rush", weapons: ["bat"], rules: i === 0 ? [{ when: "alone_with", do: "stance", stance: "rush", label: "duel" }] : undefined, line: "x" } })));
    expect(m.record.version).toBe(4);
    expect(m.record.rounds[0]!.strategies[0]!.rules![0]!.label).toBe("duel");
    expect(sanitizeRecord(JSON.parse(JSON.stringify(m.record)))!.rounds[0]!.strategies[0]!.rules![0]!.label).toBe("duel");
    // The saved version 2 record still replays and preserves its original identities.
    const rec = JSON.parse(readFileSync(`${import.meta.dir}/fixtures/record-v2-match-1001.json`, "utf8"));
    expect(rec.version).toBe(2);
    expect(() => replayMatch(rec)).not.toThrow();
    expect(sanitizeRecord(rec)).not.toBeNull();
    expect(replayMatch(sanitizeRecord(rec)!).names).toEqual(rec.souls.map((s: { name: string }) => s.name));
    expect(new Match(rec.seed, { recorded: sanitizeRecord(rec)! }).identities.map((i) => i.color)).toEqual(rec.souls.map((s: { color: number }) => s.color));
    const v2made = new Match(11);
    v2made.playToEnd();
    const rec2 = { ...JSON.parse(JSON.stringify(v2made.record)), version: 2 };
    expect(replayMatch(rec2).record.rounds.map((r) => r.fight.finalHash)).toEqual(v2made.record.rounds.map((r) => r.fight.finalHash));
    expect(() => new Match(1, { recorded: { ...rec2, version: 1 } })).toThrow(/version 1.*loads versions 2, 3 and 4/);
    expect(sanitizeRecord({ ...rec2, version: 1 })).toBeNull();
  });
});
