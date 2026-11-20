import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { seatsFor } from "../src/ai/decide";
import { registerStubs } from "../src/ai/providers";
import { MatchRunner } from "../src/ai/runner";
import { DEFAULT_TIMING as T, readTime } from "../src/flow/beats";
import { playbackAt, roundPlayback, VIEWER_KO_EXTRA_S } from "../src/flow/pacing";
import { exampleSouls, initPhysics } from "../src/sim";

setDefaultTimeout(120_000);
beforeAll(async () => {
  await initPhysics();
  registerStubs(1);
});

const lines = ["Short.", "A somewhat longer line that takes a while to read out loud.", "Mid length line here.", "Ok."];

describe("broadcast pacing", () => {
  test("a round's playback is the viewer's beats: lines, countdown, FIGHT!/fight in real time, round end", () => {
    const talk = lines.reduce((a, l) => a + readTime(l), 0);
    const r1 = roundPlayback({ round: 1, lines, fightTicks: 60 * 40, kos: 3, endsWithKo: true });
    expect(r1.preFight).toBeCloseTo(T.level + talk + 3 * T.count, 6);
    expect(r1.fight).toBeCloseTo(40 + 2 * VIEWER_KO_EXTRA_S, 6); // the round-ending knockout's slow motion is in the round end
    expect(r1.roundEnd).toBe(T.roundEnd);
    expect(r1.total).toBeCloseTo(r1.preFight + r1.fight + r1.roundEnd, 6);
    const r2 = roundPlayback({ round: 2, lines, fightTicks: 60 * 90, kos: 2, endsWithKo: false });
    expect(r2.preFight).toBeCloseTo(talk + 3 * T.count, 6); // no level card after round 1
    expect(r2.fight).toBeCloseTo(90 + 2 * VIEWER_KO_EXTRA_S, 6); // time-out: every knockout slowed the fight
    expect(roundPlayback({ round: 2, lines, fightTicks: 10, kos: 0, endsWithKo: false }).fight).toBe(T.go); // FIGHT! shows even for a split-second round
  });

  test("playbackAt: plan before the fight, a fight tick during it, the round end after", () => {
    const p = roundPlayback({ round: 2, lines, fightTicks: 600, kos: 0, endsWithKo: true });
    expect(playbackAt(p, 0, 600)).toEqual({ phase: "plan", tick: null });
    expect(playbackAt(p, p.preFight + p.fight / 2, 600)).toEqual({ phase: "fight", tick: 300 });
    expect(playbackAt(p, p.total, 600)).toEqual({ phase: "roundEnd", tick: 600 });
  });

  test("broadcast mode waits for each round's playback; fast-forwards when nobody is watching; same match either way", async () => {
    const seats = () => seatsFor(["stub", "house", "house", "house"], exampleSouls());
    const fast = new MatchRunner({ seed: 9, seats: seats() });
    const t0 = performance.now();
    await fast.run();
    const fastMs = performance.now() - t0;

    const scale = 0.01;
    const paced = new MatchRunner({ seed: 9, seats: seats(), pace: "broadcast", paceScale: scale });
    const t1 = performance.now();
    await paced.run();
    const pacedMs = performance.now() - t1;
    expect(paced.match.record.rounds.map((r) => r.fight.finalHash)).toEqual(fast.match.record.rounds.map((r) => r.fight.finalHash));
    const expected = paced.match.record.rounds.reduce((a, r, i) => a + roundPlayback({ round: i + 1, lines: r.lines, fightTicks: r.fight.ticks, kos: paced.match.facts[i]!.stats.kos.length, endsWithKo: paced.match.results[i]!.reason !== "time-out" }).total, 0);
    expect(pacedMs).toBeGreaterThanOrEqual(expected * 1000 * scale - T.level * 1000 * scale - 50);

    const nobody = new MatchRunner({ seed: 9, seats: seats(), pace: "broadcast", shouldPace: () => false });
    const t2 = performance.now();
    await nobody.run();
    expect(performance.now() - t2).toBeLessThan(fastMs + 2000);
  });
});
