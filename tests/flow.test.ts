import { describe, expect, test } from "bun:test";
import { betweenBeats, betweenOrder, closingBeats, FlowRunner, introOrder, openingBeats, readTime, roundBeats, scoreFight, simRuns, Tally, type Beat } from "../src/flow";
import type { FightResult as MatchResult } from "../src/sim/fight";

const result = (winner: number, kos: number[]): MatchResult => ({
  winner,
  reason: "last-standing",
  ticks: 3000,
  kos,
  damage: [0, 0, 0, 0],
  survivors: [winner],
  koLog: [],
});
const lines = ["a short one", "a much longer line that takes a while to read out loud", "mid length line here", "ok"];
const label = (b: Beat) => (b.kind === "countdown" ? String(b.value) : b.kind === "dialogue" ? `${b.phase}${b.fighter}` : b.kind);

/** Plays the beat list the way the game does: append after each round result. */
function playFlow(roundWinners: number[]): string[] {
  const seen: string[] = [];
  let round = 1;
  let wins = [0, 0, 0, 0];
  let fightOver = false;
  const runner: FlowRunner = new FlowRunner([...openingBeats([2, 3, 1, 0], lines), ...roundBeats(1)], (b) => {
    seen.push(label(b));
    if (b.kind === "fight") fightOver = false;
    if (b.kind === "roundEnd") {
      const w = roundWinners[round - 1]!;
      wins[w]!++;
      const over = Math.max(...wins) >= 2 || round === 3;
      if (over) runner.append(closingBeats());
      else {
        round++;
        runner.append([...betweenBeats(betweenOrder(w, [1, 2, 0, 3].map((x, i) => (i === w ? 0 : x))), lines, round), ...roundBeats(round)]);
      }
    }
  });
  for (let i = 0; i < 20000 && !runner.done; i++) {
    if (runner.beat.kind === "fight" && runner.t > 1) fightOver = true;
    runner.update(1 / 30, fightOver);
  }
  void wins;
  wins = [];
  return seen;
}

describe("match beats", () => {
  test("opening: level card, intro lines in order, then round 1", () => {
    const b = [...openingBeats([2, 3, 1, 0], lines), ...roundBeats(1)];
    expect(b.map(label)).toEqual(["level", "intro2", "intro3", "intro1", "intro0", "3", "2", "1", "go", "fight", "roundEnd"]);
    expect(b.filter((x) => simRuns(x) === "fight").map((x) => x.kind)).toEqual(["go", "fight"]);
    expect(simRuns(b[1]!)).toBe("frozen"); // dialogue freezes the arena
  });

  test("a 2-0 match: two rounds with one dialogue block between, then celebrate", () => {
    const seen = playFlow([1, 1]);
    const r = seen.join(" ");
    expect(seen.filter((x) => x === "fight").length).toBe(2);
    expect(seen.filter((x) => x.startsWith("between")).length).toBe(4);
    expect(seen[seen.length - 1]).toBe("celebrate");
    expect(r).toContain("roundEnd between");
  });

  test("a 2-1 match: three rounds, two dialogue blocks", () => {
    const seen = playFlow([1, 2, 1]);
    expect(seen.filter((x) => x === "fight").length).toBe(3);
    expect(seen.filter((x) => x.startsWith("between")).length).toBe(8);
    expect(seen.filter((x) => x === "celebrate").length).toBe(1);
  });

  test("between rounds the first one out speaks first, the winner speaks last", () => {
    // winner 2; out order: fighter 1 went out first, then 3, fighter 0 survived
    expect(betweenOrder(2, [0, 1, 0, 2])).toEqual([1, 3, 0, 2]);
    expect(introOrder([50, 30, -15, 15])).toEqual([2, 3, 1, 0]);
  });

  test("dialogue read time grows with the line, with a floor", () => {
    expect(readTime("ok")).toBe(2.6);
    expect(readTime(lines[1]!)).toBeGreaterThan(readTime(lines[0]!) - 1e-9);
  });

  test("tap advances a line; skip-all jumps past the dialogue block", () => {
    const entered: string[] = [];
    const r = new FlowRunner([...openingBeats([0, 1, 2, 3], lines), ...roundBeats(1)], (b) => entered.push(label(b)));
    r.update(3, false); // past the level card
    expect(r.beat.kind).toBe("dialogue");
    r.skip();
    r.update(0.001, false);
    expect(label(r.beat)).toBe("intro1");
    r.skipWhile((b) => b.kind === "dialogue");
    expect(label(r.beat)).toBe("3");
    expect(entered).toContain("intro3"); // every skipped beat still fired onEnter
  });
});

describe("scores and tally", () => {
  test("round win 3, each knockout 1", () => {
    const s = scoreFight(result(2, [1, 0, 2, 0]));
    expect(s.map((x) => x.total)).toEqual([1, 0, 5, 0]);
  });

  test("the tally adds up across rounds and matches", () => {
    const t = new Tally();
    t.add(result(2, [1, 0, 2, 0]));
    t.add(result(0, [3, 0, 0, 0]));
    expect(t.points).toEqual([7, 0, 5, 0]);
    expect(t.ranking()).toEqual([0, 2, 1, 3]);
    expect(Tally.from(JSON.parse(JSON.stringify(t))).points).toEqual(t.points);
  });
});
