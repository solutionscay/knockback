import { describe, expect, test } from "bun:test";
import { FlowRunner, matchBeats, scoreFight, simRuns, Tally, type Beat } from "../src/flow";
import type { MatchResult } from "../src/sim/match";

const result = (winner: number, kos: number[]): MatchResult => ({
  winner,
  reason: "last-standing",
  ticks: 3000,
  kos,
  damage: [0, 0, 0, 0],
  survivors: [winner],
  koLog: [],
});

describe("match beats", () => {
  test("the loop is intro x4, 3 2 1, FIGHT, fight, end, celebrate", () => {
    const b = matchBeats(4);
    expect(b.map((x) => (x.kind === "countdown" ? String(x.value) : x.kind === "intro" ? `intro${x.fighter}` : x.kind))).toEqual([
      "intro0", "intro1", "intro2", "intro3", "3", "2", "1", "go", "fight", "end", "celebrate",
    ]);
    expect(b.filter((x) => simRuns(x) === "fight").map((x) => x.kind)).toEqual(["go", "fight"]);
    expect(simRuns(b[0]!)).toBe("frozen");
  });

  test("the runner holds the fight open until the sim ends it", () => {
    const entered: Beat["kind"][] = [];
    const r = new FlowRunner(matchBeats(4), (b) => entered.push(b.kind));
    for (let i = 0; i < 2000; i++) r.update(1 / 60, false);
    expect(r.beat.kind).toBe("fight");
    r.update(1 / 60, true);
    expect(r.beat.kind).toBe("end");
    for (let i = 0; i < 2000; i++) r.update(1 / 60, true);
    expect(r.done).toBe(true);
    expect(entered).toEqual(["intro", "intro", "intro", "intro", "countdown", "countdown", "countdown", "go", "fight", "end", "celebrate"]);
  });

  test("a fight that ends during FIGHT! skips straight to the end beat", () => {
    const r = new FlowRunner(matchBeats(4));
    while (r.beat.kind !== "go") r.update(0.05, false);
    r.update(0.01, true);
    expect(r.beat.kind as string).toBe("end");
  });
});

describe("scores and tally", () => {
  test("win 3, each knockout 1", () => {
    const s = scoreFight(result(2, [1, 0, 2, 0]));
    expect(s.map((x) => x.total)).toEqual([1, 0, 5, 0]);
    expect(s[2]).toEqual({ fighter: 2, win: 3, kos: 2, total: 5 });
  });

  test("the tally adds up across matches and ranks fighters", () => {
    const t = new Tally();
    t.add(result(2, [1, 0, 2, 0]));
    t.add(result(0, [3, 0, 0, 0]));
    expect(t.points).toEqual([7, 0, 5, 0]);
    expect(t.wins).toEqual([1, 0, 1, 0]);
    expect(t.matches).toBe(2);
    expect(t.ranking()).toEqual([0, 2, 1, 3]);
    const back = Tally.from(JSON.parse(JSON.stringify(t)));
    expect(back.points).toEqual(t.points);
    expect(Tally.from({ junk: true }).points).toEqual([0, 0, 0, 0]);
  });
});
