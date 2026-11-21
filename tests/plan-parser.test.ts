/**
 * Contract 4: plan parser. The one parser for AI answers and agent plans (src/ai/parse.ts): a valid plan parses into
 * the strategy the fight plays, wherever the JSON sits in the text; each kind of invalid plan is refused with a problem
 * that names the field and the bad value, and only that field.
 */
import { describe, expect, test } from "bun:test";
import { parseAnswer } from "../src/ai/parse";
import { resolveRuleset } from "../src/sim/ruleset";

const NAMES = ["Rex", "Moth", "Pike", "Vex"];
const ME = 0;
const GOOD = { weapons: ["rocket", "bat"], target: "weakest", stance: "rush", retaliate: "attacker", line: "Here I come." };
const parse = (o: Record<string, unknown>, ruleset?: ReturnType<typeof resolveRuleset>) => parseAnswer(JSON.stringify(o), ME, NAMES, ruleset);

describe("plan parser", () => {
  test("a valid plan parses into the strategy the fight plays", () => {
    const p = parse({ ...GOOD, why: "they are hurt", rules: [{ when: "my_health_below", value: 30, do: "seek", item: "health", label: "patch up" }] });
    expect(p.problems).toEqual([]);
    expect(p.line).toBe("Here I come.");
    expect(p.why).toBe("they are hurt");
    expect(p.strategy).toMatchObject({ target: "weakest", stance: "rush", weapons: ["rocket", "bat"], retaliate: "attacker" });
    expect(p.strategy!.rules).toEqual([{ when: "my_health_below", value: 30, do: "seek", doItem: "health", label: "patch up" }]);
  });

  test("a rival's name targets that rival; aliases and case are accepted", () => {
    const p = parse({ ...GOOD, target: "pike", weapons: ["Baseball Bat", "HOOK"], stance: " Cover " });
    expect(p.strategy).toMatchObject({ target: "grudge", grudge: 2, weapons: ["bat", "grapple"], stance: "cover" });
  });

  test("the plan is found inside prose and Markdown fences", () => {
    const p = parseAnswer(`Sure! Here is my plan:\n\`\`\`json\n${JSON.stringify(GOOD)}\n\`\`\`\nGood luck {everyone}.`, ME, NAMES);
    expect(p.strategy?.weapons).toEqual(["rocket", "bat"]);
    expect(p.line).toBe("Here I come.");
  });

  test("no JSON at all", () => {
    expect(parseAnswer("I will rush the weakest with a rocket.", ME, NAMES)).toMatchObject({ strategy: null, problems: ["no JSON object"] });
  });

  const BAD: [what: string, change: Record<string, unknown>, field: string, shown: string][] = [
    ["an unknown weapon", { weapons: ["laser"] }, "weapons", '"laser"'],
    ["no weapons", { weapons: [] }, "weapons", "[]"],
    ["the same weapon twice", { weapons: ["bat", "bat"] }, "weapons", '"bat","bat"'],
    ["more than 3 weapons", { weapons: ["bat", "rocket", "shotgun", "rifle"] }, "weapons", '"rifle"'],
    ["an unknown stance", { stance: "dance" }, "stance", '"dance"'],
    ["a missing stance", { stance: undefined }, "stance", "undefined"],
    ["itself as the target", { target: "Rex" }, "target", '"Rex"'],
    ["an unknown target", { target: "the moon" }, "target", '"the moon"'],
    ["an unknown retaliate", { retaliate: "sulk" }, "retaliate", '"sulk"'],
  ];
  for (const [what, change, field, shown] of BAD)
    test(`refuses ${what}, naming ${field} and the value`, () => {
      const p = parse({ ...GOOD, ...change });
      expect(p.strategy).toBeNull();
      expect(p.problems).toHaveLength(1);
      expect(p.problems[0]!.startsWith(`${field} `)).toBe(true);
      expect(p.problems[0]).toContain(shown);
    });

  test("refuses a weapon the ruleset turned off", () => {
    const p = parse(GOOD, resolveRuleset({ weapons: { enabled: ["bat", "shotgun"] } }));
    expect(p.strategy).toBeNull();
    expect(p.problems).toEqual(['weapons ["rocket","bat"]']);
  });

  test("a missing line is reported while the plan itself stays valid", () => {
    const p = parse({ ...GOOD, line: "   " });
    expect(p.strategy).not.toBeNull();
    expect(p.line).toBeNull();
  });

  const BAD_RULES: [what: string, rule: Record<string, unknown>, says: string][] = [
    ["an unknown trigger", { when: "full_moon", do: "flee" }, 'unknown trigger "full_moon"'],
    ["an unknown action", { when: "my_health_below", value: 30, do: "dance" }, 'unknown action "dance"'],
    ["a value out of range", { when: "my_health_below", value: 500, do: "seek", item: "health" }, '"value" 500 is out of range'],
    ["a missing value", { when: "my_health_below", do: "seek", item: "health" }, 'needs a whole-number "value"'],
    ["itself as who", { when: "chasing_me", who: "Rex", do: "target" }, `"who" can't be yourself`],
    ["an unknown item", { when: "my_health_below", value: 30, do: "seek", item: "pizza" }, 'unknown item "pizza"'],
  ];
  for (const [what, rule, says] of BAD_RULES)
    test(`a rule with ${what} is dropped with a problem that says so; the plan stays`, () => {
      const p = parse({ ...GOOD, rules: [rule, { when: "my_health_below", value: 30, do: "seek", item: "health" }] });
      expect(p.strategy).not.toBeNull();
      expect(p.strategy!.rules).toHaveLength(1); // the good rule is kept
      expect(p.ruleProblems).toHaveLength(1);
      expect(p.ruleProblems![0]).toStartWith("rule 1");
      expect(p.ruleProblems![0]).toContain(says);
    });
});
