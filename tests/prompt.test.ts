import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { checkFactsFromStats, checkLine } from "../src/ai/factcheck";
import { decideRound, seatsFor } from "../src/ai/decide";
import { cleanWhy, MAX_WHY, parseAnswer } from "../src/ai/parse";
import { buildPrompt, examplesFor, lastPlanLines, PLAN_EXAMPLES, RULE_EXAMPLES, ruleExamplesFor, ruleResultLine, rulesSection, whatHappenedLines } from "../src/ai/prompt";
import { registerStubs } from "../src/ai/providers";
import { exampleSouls, initPhysics, Match, ReplayDivergedError, replayMatch, StatsCollector, type RoundFacts } from "../src/sim";

setDefaultTimeout(120_000);
beforeAll(async () => {
  await initPhysics();
  registerStubs(5);
});

const NAMES = ["Brick", "Pike", "Squeaks", "Goldie"];

/**
 * A fixed round (the match-2611 round-3 situation): Goldie hit Brick 10 times
 * with the bat (2 from behind), Pike hit him 5 times with the rocket (3 from
 * behind) and knocked him out at 64 s. Brick knocked out Squeaks with the shotgun.
 */
function fixedStats() {
  const c = new StatsCollector();
  for (let t = 0; t < 10; t++) c.hit(3, 0, 3.4, "bat", 2, t < 2, 100 + t * 30);
  for (let t = 0; t < 5; t++) c.hit(1, 0, 3, "rocket", 12, t < 3, 1000 + t * 60);
  for (let t = 0; t < 4; t++) c.hit(0, 2, 9, "shotgun", 3, false, 2000 + t * 40);
  return c.finish(
    [
      { victim: 2, by: 0, weapon: "shotgun", cause: "hp", tick: 2200 },
      { victim: 0, by: 1, weapon: "rocket", cause: "hp", tick: 64 * 60 },
    ],
    NAMES,
  );
}

describe("WHAT HAPPENED TO YOU (#4)", () => {
  test("each fact, one per sentence, names only, matches the fixed round", () => {
    const lines = whatHappenedLines(fixedStats(), 0, NAMES);
    expect(lines).toEqual([
      "You were knocked out by Pike (rocket) at 64 s.",
      "Most damage to you: Goldie (34, bat).",
      "Most hits on you from behind: Pike (3 of the 5 hits from behind).",
      "You knocked out Squeaks (shotgun).",
    ]);
    for (const l of lines) expect(l).not.toMatch(/\b(he|she|him|her|they|them)\b/i); // no pronouns
  });

  test("survivors, nobody hurt, nobody from behind, no knockouts", () => {
    const lines = whatHappenedLines(fixedStats(), 3, NAMES); // Goldie: untouched, survived, no KO
    expect(lines).toEqual(["You survived the round.", "Nobody damaged you.", "Nobody hit you from behind.", "You knocked out: nobody."]);
    const st = fixedStats();
    st.kos.push({ victim: 1, by: -1, weapon: "fall", cause: "ringout", tick: 600 });
    expect(whatHappenedLines(st, 1, NAMES)[0]).toBe("You were rung out by a fall at 10 s; no fighter gets the credit.");
  });

  test("the block is in the prompt for rounds 2 and 3 (not before round 1), with the instruction", () => {
    const m = new Match(9);
    const p1 = buildPrompt(exampleSouls()[0]!, m.contextFor(0), { level: m.level, lastLines: null, lastHealth: null });
    expect(p1).not.toContain("WHAT HAPPENED TO YOU");
    for (let r = 1; r <= 2 && !m.over; r++) {
      m.playRound();
      if (m.over) break;
      const ctx = m.contextFor(0);
      const p = buildPrompt(exampleSouls()[0]!, ctx, { level: m.level, lastLines: m.record.rounds[r - 1]!.lines, lastHealth: null });
      expect(p).toContain(`WHAT HAPPENED TO YOU: ${whatHappenedLines(m.facts[r - 1]!.stats, 0, m.names).join(" ")}`);
      expect(p).toContain("If your line accuses someone, it must match these facts.");
    }
  });

  test("the post-check flags the 2611 accusation and accepts true ones", () => {
    const f = checkFactsFromStats(fixedStats());
    expect(checkLine("Goldie, you're the one who shot me in the back.", 0, NAMES, f).mismatches).toEqual([]); // Goldie did hit from behind (2)
    const ko = checkLine("Goldie knocked me out, and Brick never forgets!", 0, NAMES, f);
    expect(ko.mismatches.length).toBe(1);
    expect(ko.mismatches[0]!.facts).toContain("knocked out by Pike (rocket)");
    expect(checkLine("Pike knocked me out with that rocket.", 0, NAMES, f).mismatches).toEqual([]);
    expect(checkLine("Goldie's rocket was cheap!", 0, NAMES, f).mismatches[0]!.claim).toBe("weapon (rocket) by Goldie");
    expect(checkLine("Goldie's bat still rattles my helmet!", 0, NAMES, f).mismatches).toEqual([]);
    // wishes are not accusations (the two false positives of the first 10-match run)
    expect(checkLine("Oh, Goldie, my lucky foot says grab that rocket!", 0, NAMES, f).checked).toBe(false);
    expect(checkLine("Goldie's bat still rattles my helmet, find me that shotgun!", 0, NAMES, f).mismatches).toEqual([]);
    expect(checkLine("Round three, here I come!", 0, NAMES, f).checked).toBe(false);
  });
});

describe("replays from another engine are refused", () => {
  test("a record whose rounds don't end in the recorded state throws a clear error", () => {
    const m = new Match(5);
    m.playToEnd();
    const rec = JSON.parse(JSON.stringify(m.record));
    expect(() => replayMatch(rec)).not.toThrow();
    rec.rounds[0].fight.finalHash = "deadbeef";
    expect(() => replayMatch(rec)).toThrow(ReplayDivergedError);
    expect(() => replayMatch(rec)).toThrow(/older engine/);
  });
});

describe("YOUR LAST PLAN (#3)", () => {
  const plan = { target: "weakest" as const, stance: "distance" as const, weapons: ["bat" as const, "shotgun" as const], retaliate: "turn" as const, line: "" };
  function planStats() {
    const c = new StatsCollector();
    c.pickup(0, "bat", 120);
    c.pickup(0, "health", 300);
    for (let t = 0; t < 8; t++) c.hit(0, 2, 5, "bat", 2, false, 400 + t * 40); // 40 bat damage to Squeaks
    c.hit(0, 2, 10, "rocket", 9, false, 900); // and 10 with a rocket
    for (let t = 0; t < 3; t++) c.hit(1, 0, 6, "rocket", 12, true, 1200 + t * 50);
    // 31 s chasing Squeaks at 9 m
    for (let t = 0; t < 62; t++) c.sample([{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 9, y: 0 }, { x: -30, y: 0 }], [2, 0, 1, 1]);
    return c.finish([{ victim: 0, by: 1, weapon: "rocket", cause: "hp", tick: 3000 }], NAMES, [[{ tick: 1300, attacker: 1, mode: "fight" }, { tick: 1500, attacker: 1, mode: "fight" }, { tick: 2000, attacker: 3, mode: "fight" }], [], [], []]);
  }

  test("one fact for each field of the plan", () => {
    expect(lastPlanLines(plan, planStats(), 0, NAMES)).toEqual([
      "target: weakest: you chased Squeaks most (31 s) and did 50 damage to Squeaks.",
      "weapons: bat > shotgun: you got the bat at 2 s; you never got the shotgun; 80% of your damage was bat.",
      "retaliate: turn: the reflex fired 3 times: 2 against Pike, 1 against Goldie; Pike then knocked you out.",
      "stance: distance: average distance to your target was 9 m.",
    ]);
    const quiet = lastPlanLines({ ...plan, target: "grudge", grudge: 3, weapons: ["grenade"] }, new StatsCollector().finish([], NAMES), 0, NAMES);
    expect(quiet).toEqual(["target: Goldie: you chased nobody for long.", "weapons: grenade: you never got the grenade; you did no damage.", "retaliate: turn: the reflex never fired.", "stance: distance: you had no target to measure."]);
  });

  test("the block is in rounds 2 and 3, the line bank stays out, and prompts stay under 7k characters", () => {
    let longest = 0;
    let checked = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const m = new Match(seed);
      const souls = m.souls;
      for (let r = 1; !m.over; r++) {
        const prev = m.record.rounds[m.record.rounds.length - 1];
        for (let i = 0; i < 4; i++) {
          const p = buildPrompt(souls[i]!, m.contextFor(i), { level: m.level, lastLines: prev?.lines ?? null, lastHealth: null, myLines: m.record.rounds.map((x) => x.lines[i]!), lastPlans: prev?.strategies ?? null, seed });
          if (r > 1) {
            expect(p).toContain(`YOUR LAST PLAN AND HOW IT WENT: ${lastPlanLines(prev!.strategies[i]!, m.facts[r - 2]!.stats, i, m.names).join(" ")}`);
            expect(p).toContain("EXAMPLES of changing a plan:");
            checked++;
          } else expect(p).not.toContain("YOUR LAST PLAN");
          expect(p).not.toContain("## Lines");
          const spoken = new Set(m.record.rounds.flatMap((x) => x.lines));
          for (const l of souls[i]!.lines) if (!spoken.has(l[2])) expect(p).not.toContain(l[2]); // only lines actually said appear (as quotes)
          expect(p).toContain('"why"');
          expect(p).toContain("Change your weapons if last round's pickups or knockouts say so.");
          longest = Math.max(longest, p.length);
        }
        m.playRound();
      }
    }
    expect(checked).toBeGreaterThan(30);
    // budget: about 5.9k after #3, plus the RULES section (at most 1,200 by design, #7)
    expect(longest).toBeLessThan(7000);
  });

  test("examples rotate by seed, round and seat (2 per prompt), and the retaliate text names no trap", () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 8; seed++) for (const e of examplesFor(seed, 2, 0)) seen.add(e);
    expect(seen.size).toBe(PLAN_EXAMPLES.length);
    expect(examplesFor(5, 2, 1)).not.toEqual(examplesFor(5, 2, 2));
    const m = new Match(3);
    const p = buildPrompt(m.souls[0]!, m.contextFor(0), { level: m.level, lastLines: null, lastHealth: null });
    expect((p.match(/default/gi) ?? []).length).toBe(1);
    expect(p).not.toMatch(/abandon your plan|bad when/);
    // no anchoring example answer: the plan's own fields are placeholders (only the rotated example rule is concrete)
    expect(p).toContain('"stance":"<stance>","retaliate":"<attacker|turn|ignore>"');
  });
});

describe("RULES in the prompt (#7)", () => {
  test("the section exists in every round, stays under 1,200 characters, and its examples are valid rules", () => {
    for (let seed = 0; seed < 10; seed++) {
      const sec = rulesSection(ruleExamplesFor(seed, 1 + (seed % 3), seed % 4).slice(0, 2));
      expect(sec.length).toBeLessThan(1200);
      expect(sec).toContain("RULES (optional");
      expect(sec).toContain("A rule that never fires does nothing.");
    }
    for (const ex of RULE_EXAMPLES) expect(parseAnswer(`{"weapons":["bat"],"target":"nearest","stance":"rush","line":"x","rules":[${ex}]}`, 0, NAMES).ruleProblems).toBeUndefined();
    const m = new Match(3);
    const p = buildPrompt(m.souls[0]!, m.contextFor(0), { level: m.level, lastLines: null, lastHealth: null, seed: 3 });
    expect(p).toContain("RULES (optional");
    expect(p).toMatch(/"rules":\[0 to 4 rules, e\.g\. \{"when"/); // one example rule in the reply format
  });

  test("rule results for a fixed round: firings, active time, never fired", () => {
    const rules = [
      { when: "holds" as const, who: "anyone" as const, item: "rocket" as const, do: "target" as const, label: "chase the rocket holder" },
      { when: "my_health_below" as const, value: 30, do: "seek" as const, doItem: "health" as const, label: "patch up" },
    ];
    expect(ruleResultLine(rules, [{ fires: 3, activeTicks: 720 }, { fires: 0, activeTicks: 0 }])).toBe("YOUR RULES: 'chase the rocket holder' fired 3 times (12 s active); 'patch up' never fired.");
    expect(ruleResultLine(undefined, undefined)).toBe("YOUR RULES: you wrote none last round.");
    // and in the prompt, from a real round: the stats the engine recorded
    const m = new Match(5);
    m.prepareRound([0, 1, 2, 3].map((i) => ({ line: "x", strategy: { target: "nearest", stance: "rush", weapons: ["shotgun"], rules: i === 0 ? [{ when: "health_below", who: "enemy", value: 60, do: "target", label: "finish the wounded" }] : undefined, line: "x" } })));
    while (!m.step()) {
      /* round */
    }
    m.finishRound();
    if (!m.over) {
      const f = m.facts[0]!.stats.rules[0]![0]!;
      const p = buildPrompt(m.souls[0]!, m.contextFor(0), { level: m.level, lastLines: m.record.rounds[0]!.lines, lastHealth: null, lastPlans: m.record.rounds[0]!.strategies, seed: 5, lastRuleProblems: ['rule 2: unknown trigger "flies"'] });
      expect(p).toContain(f.fires > 0 ? `'finish the wounded' fired ${f.fires} time${f.fires > 1 ? "s" : ""} (${Math.round(f.activeTicks / 60)} s active)` : "'finish the wounded' never fired");
      expect(p).toContain('RULES REJECTED LAST ROUND: rule 2: unknown trigger "flies".');
    }
  });
});

describe("why (#3)", () => {
  test("parsed and validated; optional; never makes a plan invalid", () => {
    const base = '"weapons":["rocket"],"target":"nearest","stance":"rush","line":"Go!"';
    expect(parseAnswer(`{${base},"why":"Pike knocked me out with rockets, so I want one too"}`, 0, NAMES).why).toBe("Pike knocked me out with rockets, so I want one too");
    const none = parseAnswer(`{${base}}`, 0, NAMES);
    expect(none.strategy).not.toBeNull();
    expect(none.why).toBeUndefined();
    const bad = parseAnswer(`{${base},"why":42}`, 0, NAMES);
    expect(bad.strategy).not.toBeNull();
    expect(bad.why).toBeUndefined();
    expect(cleanWhy("x ".repeat(200))!.length).toBeLessThanOrEqual(MAX_WHY);
  });

  test("kept in the decision meta, the match record and the prompts file (raw answer)", async () => {
    const m = new Match(4);
    const ask = await decideRound(m, seatsFor(["stub", "house", "house", "house"], m.souls), 400);
    expect(ask.meta[0]!.why).toBe("stub plan: rush the weakest with rocket and bat");
    expect(ask.raw[0]).toContain('"why"');
    m.prepareRound(ask.decisions, ask.meta);
    expect(JSON.parse(JSON.stringify(m.record)).rounds[0].meta[0].why).toBe("stub plan: rush the weakest with rocket and bat");
    expect(ask.meta[1]!.why).toBeUndefined();
  });
});

export type { RoundFacts };
