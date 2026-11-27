/**
 * The deploy's wait (#167): waitIdle reads the Arena state until it is idle, or gives up at the timeout. A fake clock
 * and a fake state source: no server, no real time.
 */
import { describe, expect, test } from "bun:test";
import { hasDrain, stateOfHealth, waitIdle, type ArenaState } from "../src/server/wait-idle";

const running = (round: number): ArenaState => ({ round, status: "running", drain: null, idle: false });
const over = (round: number): ArenaState => ({ round, status: "over", drain: null, idle: true });

/** A clock that only moves when the waiter sleeps, and a source that answers from a script of states (or errors). */
function fake(script: (ArenaState | Error)[]) {
  let t = 0;
  const reads: number[] = [];
  const lines: string[] = [];
  return {
    reads,
    lines,
    opts: {
      now: () => t,
      sleep: async (ms: number) => void (t += ms),
      read: async () => {
        reads.push(t);
        const s = script[Math.min(reads.length - 1, script.length - 1)]!;
        if (s instanceof Error) throw s;
        return s;
      },
      log: (s: string) => void lines.push(s),
    },
  };
}

describe("waitIdle", () => {
  test("idle at once: no wait", async () => {
    const f = fake([over(7)]);
    expect(await waitIdle({ ...f.opts, timeoutMs: 150_000 })).toEqual({ ok: true, state: over(7), waitedMs: 0 });
  });

  test("waits for the round on now to end, one read a second, one line per change", async () => {
    const f = fake([running(7), running(7), running(7), over(7)]);
    const r = await waitIdle({ ...f.opts, timeoutMs: 150_000 });
    expect(r).toEqual({ ok: true, state: over(7), waitedMs: 3000 });
    expect(f.reads).toEqual([0, 1000, 2000, 3000]);
    expect(f.lines).toEqual(["round 7 running", "round 7 over (idle)"]);
  });

  test("a drain: idle only once the next round is held", async () => {
    const until = "2026-11-27T12:10:00.000Z";
    const f = fake([
      { round: 7, status: "running", drain: { held: false, until }, idle: false },
      { round: 7, status: "over", drain: { held: false, until }, idle: false }, // the win screen: the loop has not parked yet
      { round: 7, status: "over", drain: { held: true, until }, idle: true },
    ]);
    const r = await waitIdle({ ...f.opts, timeoutMs: 150_000 });
    expect(r.ok && r.state.drain?.held).toBe(true);
    expect(f.lines).toEqual(["round 7 running; drain on, waiting for the round to end", "round 7 over; drain on, waiting for the round to end", "round 7 over; drain on, next round held (idle)"]);
  });

  test("timeout: the last state, after exactly the timeout (the last sleep is cut to fit)", async () => {
    const f = fake([running(9)]);
    const r = await waitIdle({ ...f.opts, timeoutMs: 2500 });
    expect(r).toEqual({ ok: false, state: running(9), waitedMs: 2500, error: null });
    expect(f.reads).toEqual([0, 1000, 2000, 2500]);
  });

  test("read errors: it keeps trying; a server that comes back is read again", async () => {
    const f = fake([new Error("connection refused"), new Error("connection refused"), over(3)]);
    const r = await waitIdle({ ...f.opts, timeoutMs: 10_000 });
    expect(r).toMatchObject({ ok: true, waitedMs: 2000 });
    expect(f.lines).toEqual(["cannot read the state: connection refused", "round 3 over (idle)"]);
  });

  test("a server that never answers: timeout with no state and the error", async () => {
    const f = fake([new Error("connection refused")]);
    expect(await waitIdle({ ...f.opts, timeoutMs: 3000, intervalMs: 500 })).toEqual({ ok: false, state: null, waitedMs: 3000, error: "connection refused" });
    expect(f.reads).toHaveLength(7);
  });
});

describe("stateOfHealth", () => {
  test("the arena part of /api/health", () => {
    const arena = { round: 4, status: "running", drain: null, idle: false };
    expect(stateOfHealth({ ok: true, arenaRound: 4, matches: { open: 0, running: 1 }, arena })).toEqual(arena as ArenaState);
  });
  test("a server from before #167 (no arena): from arenaRound and matches", () => {
    expect(stateOfHealth({ ok: true, arenaRound: 5674, matches: { open: 0, running: 1 } })).toEqual(running(5674));
    expect(stateOfHealth({ ok: true, arenaRound: 5674, matches: { open: 0, running: 0 } })).toEqual(over(5674));
    expect(stateOfHealth({ ok: true, arenaRound: 12, matches: { open: 1, running: 0 } })).toEqual({ round: 12, status: "open", drain: null, idle: false });
    expect(() => stateOfHealth({ ok: false, error: "storage unavailable" })).toThrow(/no Arena state/);
  });
  test("hasDrain: only a server that carries arena gets SIGUSR2", () => {
    expect(hasDrain({ ok: true, arena: { round: 1, status: "over", drain: null, idle: true } })).toBe(true);
    expect(hasDrain({ ok: true, arenaRound: 5674, matches: { open: 0, running: 1 } })).toBe(false);
    expect(hasDrain(null)).toBe(false);
  });
});
