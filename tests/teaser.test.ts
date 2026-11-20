import { describe, expect, test } from "bun:test";
import { cuesOnOutput, sceneList } from "../scripts/teaser/media";
import { OptionError, parseTeaserArgs } from "../scripts/teaser/options";
import { CARD_MAX_S, chunks, deadStretches, END_CAPTION_S, outTime, planVideo, typedFrame, WIN_S, type Timeline } from "../scripts/teaser/plan";

/** A two-round match timeline as the viewer logs it: beats with their first frame, the sim tick per frame. */
function timeline(fight1 = 600, fight2 = 300): Timeline {
  const spec: [string, number][] = [
    ["level", 144],
    ["dialogue", 217], ["dialogue", 225], ["dialogue", 300], ["dialogue", 180],
    ["countdown", 45], ["countdown", 45], ["countdown", 45], ["go", 54],
    ["fight", fight1], ["roundEnd", 271],
    ["dialogue", 240], ["dialogue", 240], ["dialogue", 240], ["dialogue", 240],
    ["countdown", 45], ["countdown", 45], ["countdown", 45], ["go", 54],
    ["fight", fight2], ["roundEnd", 271], ["celebrate", 900],
  ];
  const beats: Timeline["beats"] = [];
  const ticks: number[] = [];
  let frame = 1;
  let round = 1;
  spec.forEach(([kind, n], index) => {
    if (kind === "roundEnd") round++;
    beats.push({ frame, kind, round, index });
    for (let i = 0; i < n; i++) ticks.push(kind === "fight" ? i + 1 : 0);
    frame += n;
  });
  return { beats, ticks, frames: frame - 1 };
}

describe("segment planner", () => {
  test("every card of every round, fully typed by the end and at most 2.6 s; rounds in full", () => {
    const t = timeline();
    const p = planVideo(t, [[], []], 60);
    const cards = p.segments.filter((s) => s.kind === "dialogue");
    expect(cards.length).toBe(8);
    expect(cards.filter((s) => s.label.endsWith("(round 1)")).length).toBe(4);
    expect(cards.filter((s) => s.label.endsWith("(round 2)")).length).toBe(4);
    for (const c of cards) {
      const beat = t.beats.find((b) => b.frame <= c.from && b.kind === "dialogue" && c.to < (t.beats[t.beats.indexOf(b) + 1]?.frame ?? Infinity))!;
      const end = t.beats[t.beats.indexOf(beat) + 1]!.frame - 1;
      expect(c.to).toBe(end); // to the card's end: the line is fully typed on screen
      expect(typedFrame(beat.frame, end)).toBeLessThanOrEqual(end);
      expect(c.outLength).toBeLessThanOrEqual(CARD_MAX_S + 1e-9);
    }
    const fights = p.segments.filter((s) => s.kind === "fight");
    expect(fights.map((s) => [s.from, s.to, s.speed])).toEqual([
      [t.beats[9]!.frame, t.beats[10]!.frame - 1, 1],
      [t.beats[19]!.frame, t.beats[20]!.frame - 1, 1],
    ]);
    expect(p.segments.filter((s) => s.kind === "roundEnd").length).toBe(2);
    expect(p.segments.filter((s) => s.kind === "countdown").length).toBe(6);
    expect(p.segments[0]!.kind).toBe("level");
  });

  test("the output is continuous: frames in order, each segment where the last ended; the win screen is capped", () => {
    const p = planVideo(timeline(), [[], []], 60);
    p.frames.forEach((f, i) => expect(f.out).toBe(i));
    for (let i = 1; i < p.segments.length; i++) expect(p.segments[i]!.outStart).toBeCloseTo(p.segments[i - 1]!.outStart + p.segments[i - 1]!.outLength);
    const win = p.segments.find((s) => s.kind === "celebrate")!;
    expect(win.outLength).toBeCloseTo(WIN_S);
    expect(p.length).toBeCloseTo(p.frames.length / 60);
    // source frames only go forward (one continuous take inside each segment)
    for (let i = 1; i < p.frames.length; i++) expect(p.frames[i]!.src).toBeGreaterThan(p.frames[i - 1]!.src);
  });

  test("a dead stretch plays at 2x, tagged; the rest of the round around it plays at 1x", () => {
    const p = planVideo(timeline(), [[[200, 379]], []], 60);
    const r1 = p.segments.filter((s) => s.kind === "fight" && s.round === 1);
    expect(r1.map((s) => s.speed)).toEqual([1, 2, 1]);
    expect(r1[1]!.label).toContain("2x");
    expect(r1[1]!.outLength).toBeCloseTo(180 / 2 / 60);
    const tagged = p.frames.filter((f) => f.tag);
    expect(tagged.length).toBe(90);
    // the round is still continuous: 1x part ends where 2x starts
    expect(r1[1]!.from).toBe(r1[0]!.to + 1);
    expect(r1[2]!.from).toBe(r1[1]!.to + 1);
  });

  test("30 fps keeps every other frame and the same length", () => {
    const a = planVideo(timeline(), [[], []], 60);
    const b = planVideo(timeline(), [[], []], 30);
    // each segment rounds its frame count up, so at most one extra frame per segment
    expect(Math.abs(b.frames.length - a.frames.length / 2)).toBeLessThanOrEqual(b.segments.length);
    expect(b.length).toBeCloseTo(a.length, 0);
    expect(b.segments.every((s) => s.step === (s.speed === 2 ? 4 : 2))).toBe(true);
  });

  test("captions: the start one over round 1's cards only, the end one over the last 3 s", () => {
    const p = planVideo(timeline(), [[], []], 60);
    const start = p.frames.filter((f) => f.caption === "start");
    const r1cards = p.segments.filter((s) => s.label.endsWith("(round 1)"));
    expect(start.length).toBe(Math.round(r1cards.reduce((a, s) => a + s.outLength, 0) * 60));
    expect(p.frames.filter((f) => f.caption === "end").length).toBe(END_CAPTION_S * 60);
    expect(p.frames[p.frames.length - 1]!.caption).toBe("end");
    expect(p.frames[0]!.caption).toBeNull(); // the arena card stays clean
  });

  test("source frames map to output time (2x halves it; cut frames have none)", () => {
    const t = timeline();
    const p = planVideo(t, [[[200, 379]], []], 60);
    const fight = p.segments.find((s) => s.kind === "fight")!;
    expect(outTime(p, fight.from)).toBeCloseTo(fight.outStart);
    const fast = p.segments.find((s) => s.speed === 2)!;
    expect(outTime(p, fast.from + 60)! - outTime(p, fast.from)!).toBeCloseTo(0.5);
    expect(outTime(p, t.beats[1]!.frame + 1)).toBeNull(); // the start of the first card is cut
    const cues = cuesOnOutput(p, [{ t: 0, sound: "ko", gain: 1, pan: 0, pitch: 1, seed: 1, frame: fight.from }, { t: 0, sound: "ko", gain: 1, pan: 0, pitch: 1, seed: 1, frame: t.beats[1]!.frame + 1 }]);
    expect(cues.length).toBe(1);
    expect(cues[0]!.t).toBeCloseTo(fight.outStart);
  });

  test("dead stretches: 3 s or more with nobody near and no action, trimmed at both ends", () => {
    const near: boolean[] = [];
    for (let t = 0; t < 100; t++) near[t] = true;
    // near until 99, action at 100 and 700: active up to 190, dead 191-609 and 791-1000; each trimmed by 30
    expect(deadStretches(1000, [100, 700], near)).toEqual([
      [221, 579],
      [821, 970],
    ]);
    expect(deadStretches(1000, Array.from({ length: 20 }, (_, i) => i * 50), [])).toEqual([]); // busy all the way
  });

  test("chunks split the frames evenly for the capture pages", () => {
    const xs = Array.from({ length: 10 }, (_, i) => i);
    expect(chunks(xs, 3)).toEqual([[0, 1, 2, 3], [4, 5, 6, 7], [8, 9]]);
    expect(chunks(xs, 1)).toEqual([xs]);
    expect(chunks(xs, 20).length).toBe(10);
  });

  test("scene list merges cards and rounds into readable lines", () => {
    const rows = sceneList(planVideo(timeline(), [[[200, 379]], []], 60), ["A", "B", "C", "D"]);
    expect(rows.some((r) => r.includes("Trash-talk cards") && r.includes("(round 1)"))).toBe(true);
    expect(rows.some((r) => r.includes("Round 1 in full") && r.includes("2x"))).toBe(true);
    expect(rows.some((r) => r.includes("Win screen"))).toBe(true);
  });
});

describe("command-line options", () => {
  const now = new Date("2026-11-20T12:34:00Z");
  test("defaults: 1080 + 720, 60 fps, 6 pages; out folder from the source", () => {
    expect(parseTeaserArgs(["--record", "records/x.json"], now)).toEqual({ source: { kind: "record", file: "records/x.json" }, out: "videos/record-2026-11-20-12-34", sizes: [1080, 720], fps: 60, fast: false, workers: 6, keepFrames: false });
    expect(parseTeaserArgs(["--seed", "42"], now).out).toBe("videos/42-2026-11-20-12-34");
  });
  test("--fast: 30 fps, 720p only; explicit --fps / --sizes win", () => {
    const f = parseTeaserArgs(["--seed", "7", "--fast"], now);
    expect([f.fps, f.sizes, f.fast]).toEqual([30, [720], true]);
    const g = parseTeaserArgs(["--seed", "7", "--fast", "--fps", "60", "--sizes", "720,1080"], now);
    expect([g.fps, g.sizes]).toEqual([60, [1080, 720]]);
  });
  test("sources: record, seed, best-of, server; one at a time", () => {
    expect(parseTeaserArgs(["--best-of", "4"], now).source).toEqual({ kind: "best-of", n: 4 });
    expect(parseTeaserArgs(["--server", "http://localhost:5176/"], now).source).toEqual({ kind: "server", url: "http://localhost:5176" });
    expect(parseTeaserArgs(["--seed=9", "--out=/tmp/v"], now)).toMatchObject({ source: { kind: "seed", seed: 9 }, out: "/tmp/v" });
    expect(() => parseTeaserArgs(["--seed", "1", "--best-of", "2"], now)).toThrow(/pick one source/);
    expect(() => parseTeaserArgs([], now)).toThrow(/pick a source/);
  });
  test("bad values are refused clearly", () => {
    expect(() => parseTeaserArgs(["--seed", "x"], now)).toThrow(OptionError);
    expect(() => parseTeaserArgs(["--seed", "1", "--fps", "24"], now)).toThrow(/30 or 60/);
    expect(() => parseTeaserArgs(["--seed", "1", "--sizes", "480"], now)).toThrow(/1080 and\/or 720/);
    expect(() => parseTeaserArgs(["--seed", "1", "--color", "red"], now)).toThrow(/unknown option/);
    expect(() => parseTeaserArgs(["--best-of", "99"], now)).toThrow(/1-12/);
    expect(() => parseTeaserArgs(["--server", "localhost"], now)).toThrow(/base URL/);
    expect(() => parseTeaserArgs(["--record"], now)).toThrow(/needs a value/);
    expect(() => parseTeaserArgs(["--help"], now)).toThrow(/bun run teaser/);
  });
});
