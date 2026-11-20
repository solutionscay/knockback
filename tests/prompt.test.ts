import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { checkFactsFromStats, checkLine } from "../src/ai/factcheck";
import { buildPrompt, whatHappenedLines } from "../src/ai/prompt";
import { exampleSouls, initPhysics, Match, ReplayDivergedError, replayMatch, StatsCollector, type RoundFacts } from "../src/sim";

setDefaultTimeout(120_000);
beforeAll(async () => {
  await initPhysics();
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
    expect(checkLine("Goldie, that rocket was cheap!", 0, NAMES, f).mismatches[0]!.claim).toBe("weapon (rocket) by Goldie");
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

export type { RoundFacts };
