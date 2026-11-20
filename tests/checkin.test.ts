/** Mid-round check-ins (#9): schedule, status prompt, answer parsing, the loop's latency rule and fallbacks. */
import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { applyTick, buildCheckinPrompt, CHECKIN, checkinFlags, checkinStatus, checkinTicks, parseCheckin } from "../src/ai/checkin";
import { checkinStats } from "../src/ai/checkin-log";
import { seatsFor } from "../src/ai/decide";
import { registerProvider, registerStubs } from "../src/ai/providers";
import { MatchRunner, type RunnerEvent } from "../src/ai/runner";
import { exampleSouls, initPhysics, Match, replayMatch, type MatchRecord, type Strategy } from "../src/sim";
import { sanitizeRecord } from "../src/viewer/sanitize";

setDefaultTimeout(120_000);
beforeAll(async () => {
  await initPhysics();
  registerStubs(20);
  // answers every check-in after a fixed delay with a stance flip (round plans come at once)
  registerProvider("fixed", {
    label: "fixed/test",
    ask: async (prompt, signal) => {
      if (!prompt.startsWith("Knockback check-in")) return `{"weapons":["shotgun"],"target":"nearest","stance":"rush","line":"Here I come."}`;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 1500);
        signal.addEventListener("abort", () => (clearTimeout(t), reject(new Error("aborted"))), { once: true });
      });
      const rushing = /^PLAN: target [^,]+, rush,/m.test(prompt);
      return `{"stance":"${rushing ? "distance" : "rush"}","line":"New plan."}`;
    },
  });
});

const NAMES = ["Ada", "Bix", "Cog", "Dot"];
const PLAN: Strategy = { target: "nearest", stance: "rush", weapons: ["rocket", "bat"], retaliate: "turn", line: "", rules: [{ when: "my_health_below", value: 30, do: "stance", stance: "cover", label: "hide when hurt" }] };
const hashes = (rec: Pick<MatchRecord, "rounds">) => rec.rounds.map((r) => r.fight.finalHash);

describe("check-in schedule and latency rule", () => {
  test("every 10 s from 10 s, capped per round, none in the last 5 s", () => {
    expect(checkinTicks()).toEqual([600, 1200, 1800, 2400, 3000, 3600].slice(0, CHECKIN.maxPerRound));
    expect(checkinTicks({ ...CHECKIN, maxPerRound: 20 }).at(-1)).toBe(4800); // 80 s: the last one at least 5 s before the 90 s time-out
    expect(checkinTicks({ ...CHECKIN, maxPerRound: 2 })).toEqual([600, 1200]);
  });

  test("an answer applies at the check-in tick plus its latency in ticks (at least the minimum; plus a lead at broadcast pace)", () => {
    expect(applyTick(600, 1500)).toBe(690);
    expect(applyTick(600, 1501)).toBe(691); // rounded up
    expect(applyTick(600, 20)).toBe(600 + CHECKIN.minApplyS * 60);
    expect(applyTick(600, 1500, CHECKIN, true)).toBe(690 + Math.round(CHECKIN.leadS * 60));
  });

  test("flags", () => {
    expect(checkinFlags({})).toBe(false);
    expect(checkinFlags({ checkins: "off" })).toBe(false);
    expect(checkinFlags({ checkins: "on", "checkin-deadline": "5", "checkin-max": "3" })).toEqual({ deadlineMs: 5000, maxPerRound: 3 });
    expect(() => checkinFlags({ checkins: "maybe" })).toThrow(/on or off/);
    expect(() => checkinFlags({ checkins: "on", "checkin-deadline": "0" })).toThrow(/checkin-deadline/);
  });
});

describe("check-in answers", () => {
  test("keep", () => {
    expect(parseCheckin(`{"keep":true}`, 0, NAMES, PLAN)).toEqual({ kind: "keep" });
    expect(parseCheckin(`Sure: {"keep": true, "line": "Steady now."}`, 0, NAMES, PLAN)).toEqual({ kind: "keep", line: "Steady now." });
  });

  test("a partial plan merges onto the current one; rules stay unless given", () => {
    const a = parseCheckin(`{"target":"Cog","stance":"cover","line":"Cog, you're done.","why":"Cog is at 12 hp"}`, 0, NAMES, PLAN);
    expect(a.kind).toBe("update");
    if (a.kind !== "update") return;
    expect(a.strategy).toMatchObject({ target: "grudge", grudge: 2, stance: "cover", weapons: ["rocket", "bat"], retaliate: "turn" });
    expect(a.strategy.rules).toEqual(PLAN.rules);
    expect(a.changed).toEqual(["target", "stance"]);
    expect(a.line).toBe("Cog, you're done.");
    expect(a.why).toBe("Cog is at 12 hp");
    const r = parseCheckin(`{"rules":[{"when":"holds","who":"anyone","item":"rocket","do":"avoid"}]}`, 0, NAMES, PLAN);
    expect(r.kind === "update" && r.strategy.rules!.map((x) => x.do)).toEqual(["avoid"]);
  });

  test("an invalid plan, junk or no JSON is never an update; no change is a keep", () => {
    expect(parseCheckin(`{"stance":"dance"}`, 0, NAMES, PLAN).kind).toBe("invalid");
    expect(parseCheckin(`{"target":"Ada"}`, 0, NAMES, PLAN).kind).toBe("invalid"); // yourself
    expect(parseCheckin(`I would rather not.`, 0, NAMES, PLAN).kind).toBe("invalid");
    expect(parseCheckin(`{"stance":"rush","weapons":["rocket","bat"]}`, 0, NAMES, PLAN).kind).toBe("keep");
  });

  test("a check-in line is short", () => {
    const a = parseCheckin(`{"stance":"cover","line":"${"very ".repeat(30)}long"}`, 0, NAMES, PLAN);
    expect(a.kind === "update" && a.line!.length).toBeLessThanOrEqual(CHECKIN.maxLine);
  });
});

describe("the status prompt", () => {
  test("built from the fight at the check-in tick, under 1,500 characters", () => {
    const m = new Match(42);
    m.prepareRound();
    m.stepUntil(600);
    for (let me = 0; me < 4; me++) {
      const st = checkinStatus(m.fight!, me, m.names, 1);
      expect(st.second).toBe(10);
      expect(st.rivals.length).toBe(3);
      expect(st.you.plan.stance).toBe(m.decisions[me]!.strategy.stance);
      const p = buildCheckinPrompt(st, exampleSouls()[me]);
      expect(p.length).toBeLessThan(1500);
      expect(p.startsWith("Knockback check-in, round 1, 10s in")).toBe(true);
      expect(p).toContain(`You are ${m.names[me]}`);
      expect(p).not.toContain("#");
      expect(p).toContain(`{"keep":true}`);
    }
  });
});

describe("the check-in loop (fast mode)", () => {
  async function run(lineup: string[], checkins: ConstructorParameters<typeof MatchRunner>[0]["checkins"], seed = 42, deadlineMs?: number) {
    const events: RunnerEvent[] = [];
    const runner = new MatchRunner({ seed, seats: seatsFor(lineup, exampleSouls()), lineup, checkins, deadlineMs, onEvent: (e) => events.push(e) });
    await runner.run();
    return { runner, events, rec: JSON.parse(JSON.stringify(runner.savedRecord())) as MatchRecord };
  }

  test("an answer after a fixed delay applies at check-in tick + delay in ticks; the record replays exactly (also through the viewer's sanitizer)", async () => {
    const { rec, events, runner } = await run(["fixed", "fixed", "house", "house"], { maxPerRound: 2 });
    const cs = rec.rounds.flatMap((r) => r.checkins ?? []);
    const ups = cs.filter((c) => c.outcome === "update");
    expect(ups.length).toBeGreaterThan(0);
    for (const c of ups) {
      expect(c.applyTick).toBe(applyTick(c.tick, c.ms));
      expect(c.applyTick! - c.tick).toBeGreaterThanOrEqual(90); // 1.5 s
      expect(c.applyTick! - c.tick).toBeLessThan(90 + 30);
    }
    const planned = rec.rounds.flatMap((r) => r.planUpdates ?? []);
    expect(planned.length).toBe(ups.length);
    expect(planned.every((u) => u.source === "checkin" && u.line === "New plan.")).toBe(true);
    // the stream: checkin, planUpdate (with the same tick), checkinEnd
    const kinds = events.map((e) => e.type).filter((t) => t.startsWith("checkin") || t === "planUpdate");
    expect(kinds[0]).toBe("checkin");
    expect(events.filter((e) => e.type === "planUpdate").map((e) => (e as { update: { tick: number } }).update.tick).sort()).toEqual(planned.map((u) => u.tick).sort());
    expect(runner.log.some((l) => /check-in 10 s: .* stance rush->distance, applies at 11\.\d s "New plan\."/.test(l))).toBe(true);
    expect(runner.log.some((l) => l.startsWith("\nCheck-ins:"))).toBe(true);
    // replays with no AI, in Bun and through the viewer's sanitizer
    expect(hashes(replayMatch(rec).record)).toEqual(hashes(rec));
    expect(hashes(replayMatch(sanitizeRecord(JSON.parse(JSON.stringify(rec)))!).record)).toEqual(hashes(rec));
    const stats = checkinStats([rec]);
    expect(stats[0]).toMatchObject({ provider: "fixed/test", updates: ups.length, missRate: 0 });
    expect(stats[0]!.avgMs).toBeGreaterThanOrEqual(1500);
  });

  test("slow, junk and broken providers never stop the match and never change the plan", async () => {
    const { rec } = await run(["slow", "junk", "broken", "house"], { maxPerRound: 2, deadlineMs: 300 }, 7, 300);
    expect(rec.winner).toBeGreaterThanOrEqual(0);
    expect(rec.rounds.every((r) => !r.planUpdates)).toBe(true);
    const out = (f: number) => [...new Set(rec.rounds.flatMap((r) => (r.checkins ?? []).filter((c) => c.fighter === f).map((c) => c.outcome)))];
    expect(out(0)).toEqual(["missed"]);
    expect(out(1)).toEqual(["invalid"]);
    expect(out(2)).toEqual(["error"]);
    expect(out(3)).toEqual([]); // house bots get no check-ins
    expect(hashes(replayMatch(rec).record)).toEqual(hashes(rec));
  });

  test("no check-ins (off, or only house bots asked) = the same hashes as before check-ins existed", async () => {
    const off = await run(["stub", "house", "house", "house"], false);
    const plain = new Match(42, { souls: exampleSouls() });
    // the runner's match is a plain match with the stub's decisions: replaying its record gives its hashes
    expect(hashes(replayMatch(off.rec).record)).toEqual(hashes(off.rec));
    expect(off.rec.rounds.every((r) => !r.planUpdates && !r.checkins && r.fight.version === 4)).toBe(true);
    const houseOnly = await run(["house", "house", "house", "house"], true);
    plain.playToEnd();
    expect(hashes(houseOnly.rec)).toEqual(hashes(plain.record));
    expect(houseOnly.rec.rounds.every((r) => !r.checkins)).toBe(true);
  });

  test("a knocked-out fighter gets no check-in", async () => {
    const { rec } = await run(["stub", "stub", "stub", "stub"], { maxPerRound: 6 }, 3);
    expect(rec.rounds.some((r) => (r.checkins ?? []).length < 4 * Math.ceil((r.fight.ticks - 1) / 600))).toBe(true);
    // every asked fighter was alive at its check-in tick
    const m = new Match(rec.seed, { recorded: rec });
    for (let round = 0; round < rec.rounds.length; round++) {
      m.prepareRound();
      for (const c of [...(rec.rounds[round]!.checkins ?? [])].sort((a, b) => a.tick - b.tick)) {
        m.stepUntil(c.tick);
        expect(m.fight!.sim.fighters[c.fighter]!.alive).toBe(true);
      }
      while (!m.step()) {
        /* rest */
      }
      m.finishRound();
    }
  });
});
