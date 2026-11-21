import { describe, expect, test } from "bun:test";
import { ENGINE_VERSION, generateIdentities, type Strategy } from "../src/sim";
import { bestRule, CALLOUT, CalloutManager, planChangeText, ruleTagText } from "../src/viewer/callouts";
import { sanitizeDecision, sanitizePlanUpdates, sanitizeRecord } from "../src/viewer/sanitize";

const NAMES = ["Brick", "Pike", "Squeaks", "Goldie"];
const S = (o: Partial<Strategy> = {}): Strategy => ({ target: "nearest", stance: "rush", weapons: ["bat", "shotgun"], retaliate: "turn", line: "", ...o });

/** Run the manager at 30 fps for `seconds`, returning the most callouts seen on screen at once. */
function run(m: CalloutManager, from: number, seconds: number, suppressed = () => false) {
  let peak = 0;
  for (let t = from; t < from + seconds; t += 1 / 30) peak = Math.max(peak, m.update(t, suppressed()).length);
  return peak;
}

describe("callout clutter limits (#10, #11)", () => {
  test("a stub with many plan updates and rule firings never puts more than 2 callouts on screen", () => {
    const m = new CalloutManager();
    let peak = 0;
    // 40 plan updates and 60 rule firings in bursts over 30 s
    for (let t = 0; t < 30; t += 1 / 30) {
      const frame = Math.round(t * 30);
      if (frame % 22 === 0) m.add({ kind: "thought", fighter: frame % 4, text: "→ target Pike", line: "Change of plan!", at: t });
      if (frame % 15 === 0) m.add({ kind: "rule", fighter: (frame / 15) % 4, text: "RULE: x", subject: 1, at: t });
      peak = Math.max(peak, m.update(t, false).length);
    }
    expect(peak).toBe(CALLOUT.maxVisible);
    expect(m.peak).toBe(2);
    expect(m.shownLog.filter((c) => c.kind === "thought").length).toBeGreaterThan(15);
  });

  test("each plan update gets its callout when updates are spread out", () => {
    const m = new CalloutManager();
    for (let k = 0; k < 8; k++) m.add({ kind: "thought", fighter: k % 4, text: `→ update ${k}`, at: k * 1.4 });
    // add them at their times
    const m2 = new CalloutManager();
    let next = 0;
    for (let t = 0; t < 16; t += 1 / 30) {
      while (next < 8 && next * 1.4 <= t) m2.add({ kind: "thought", fighter: next % 4, text: `→ update ${next}`, at: next++ * 1.4 });
      m2.update(t, false);
    }
    expect(m2.shownLog.map((c) => c.text)).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((k) => `→ update ${k}`));
    expect(m2.peak).toBeLessThanOrEqual(2);
  });

  test("a thought outranks a rule tag; a newer callout replaces its fighter's; old rule tags are dropped", () => {
    const m = new CalloutManager();
    m.add({ kind: "rule", fighter: 0, text: "RULE: a", at: 0 });
    m.add({ kind: "rule", fighter: 1, text: "RULE: b", at: 0 });
    m.update(0, false);
    m.add({ kind: "thought", fighter: 2, text: "→ target Pike", at: 0.1 });
    expect(m.update(0.1, false).map((c) => c.text).sort()).toEqual(["RULE: b", "→ target Pike"]); // the oldest rule tag gave way
    m.add({ kind: "thought", fighter: 2, text: "→ take cover", at: 0.2 });
    expect(m.update(0.2, false).map((c) => c.text)).toContain("→ take cover"); // replaced the same fighter's thought
    m.add({ kind: "rule", fighter: 3, text: "RULE: late", at: 0.3 });
    run(m, 0.3, 1.2); // full of thoughts... the late rule tag waits past its limit and is dropped
    expect(m.shownLog.some((c) => c.text === "RULE: late")).toBe(false);
  });

  test("nothing shows during knockout slow motion or the round end; queued rule tags are dropped, thoughts wait", () => {
    const m = new CalloutManager();
    m.add({ kind: "rule", fighter: 0, text: "RULE: a", at: 0 });
    m.add({ kind: "thought", fighter: 1, text: "→ rush in", at: 0 });
    expect(run(m, 0, 1, () => true)).toBe(0);
    expect(m.update(1.05, false).map((c) => c.text)).toEqual(["→ rush in"]);
  });

  test("?thoughts=off: a disabled manager never shows anything", () => {
    const m = new CalloutManager(false);
    m.add({ kind: "thought", fighter: 1, text: "→ rush in", at: 0 });
    expect(run(m, 0, 2)).toBe(0);
  });
});

describe("callout texts and the best rule", () => {
  test("plan changes in 3-5 words, most important field first", () => {
    expect(planChangeText(S(), S({ target: "grudge", grudge: 1 }), NAMES)).toBe("→ target Pike");
    expect(planChangeText(S(), S({ stance: "cover" }), NAMES)).toBe("→ take cover");
    expect(planChangeText(S(), S({ weapons: ["grapple"] }), NAMES)).toBe("→ go for the hook");
    expect(planChangeText(S(), S({ retaliate: "attacker" }), NAMES)).toBe("→ retaliate: attacker");
    expect(planChangeText(S(), S({ rules: [{ when: "alone_with", do: "stance", stance: "rush", label: "duel" }] }), NAMES)).toBe("→ new rule: duel");
    expect(planChangeText(S(), S(), NAMES)).toBeNull();
    expect(ruleTagText({ when: "alone_with", do: "stance", stance: "rush", label: "a very long label that goes on and on" })).toBe("RULE: a very long label that goes…");
  });

  test("best rule: a firing followed within 5 s by a knockout by the same fighter; the closest pair wins", () => {
    const firings = [
      { tick: 100, fighter: 1, rule: 0 },
      { tick: 900, fighter: 1, rule: 1 },
      { tick: 950, fighter: 2, rule: 0 },
    ];
    expect(bestRule(firings, [{ tick: 1000, by: 1, victim: 3 }])).toEqual({ fighter: 1, rule: 1, victim: 3, gap: 100 });
    expect(bestRule(firings, [{ tick: 1000, by: 2, victim: 3 }])).toEqual({ fighter: 2, rule: 0, victim: 3, gap: 50 });
    expect(bestRule(firings, [{ tick: 500, by: 1, victim: 3 }])).toBeNull(); // 400 ticks later: too late
    expect(bestRule(firings, [{ tick: 1000, by: -1, victim: 3 }])).toBeNull(); // a fall: nobody's rule
    // a rule about the victim beats a closer fighting rule; a heal before a knockout never counts
    const typed = [
      { tick: 800, fighter: 1, rule: 0, subject: 3, action: "target" as const },
      { tick: 990, fighter: 1, rule: 1, subject: -1, action: "use" as const },
      { tick: 995, fighter: 1, rule: 2, subject: -1, action: "seek" as const },
    ];
    expect(bestRule(typed, [{ tick: 1000, by: 1, victim: 3 }])!.rule).toBe(0);
    expect(bestRule(typed.slice(1), [{ tick: 1000, by: 1, victim: 3 }])!.rule).toBe(1);
    expect(bestRule(typed.slice(2), [{ tick: 1000, by: 1, victim: 3 }])).toBeNull();
  });
});

describe("sanitizing the new fields", () => {
  test("plan updates: tick, fighter, a clean plan and line; bad ones dropped; sorted", () => {
    const ups = sanitizePlanUpdates([
      { tick: 300, fighter: 2, strategy: { target: "grudge", grudge: 1, stance: "cover", weapons: ["rocket"] }, line: "<b>hi</b>" },
      { tick: 120, fighter: 0, strategy: { target: "evil", stance: "dance" } },
      { tick: -5, fighter: 0, strategy: {} },
      { tick: 10, fighter: 9, strategy: {} },
      "junk",
    ]);
    expect(ups.map((u) => [u.tick, u.fighter])).toEqual([
      [120, 0],
      [300, 2],
    ]);
    expect(ups[0]!.strategy.target).toBe("nearest");
    expect(ups[1]!.strategy).toMatchObject({ target: "grudge", grudge: 1, stance: "cover" });
    expect(ups[1]!.line).toBe("<b>hi</b>"); // plain text, never HTML (Pixi text / escaped)
  });

  test("records: why and rule labels are clipped strings; plan updates survive sanitizing", () => {
    const d = sanitizeDecision({ line: "x", strategy: { target: "nearest", stance: "rush", weapons: ["bat"], rules: [{ when: "alone_with", do: "stance", stance: "rush", label: "x".repeat(99) }] } }, 0);
    expect(d.strategy.rules![0]!.label.length).toBe(40);
    const rec = sanitizeRecord({
      engine: ENGINE_VERSION,
      seed: 1,
      souls: [0, 1, 2, 3].map((i) => ({ id: `f${i}` })),
      identities: generateIdentities(1),
      rounds: [{ strategies: [], lines: [], meta: [{ provider: "x", ms: 1, outcome: "ok", why: "y".repeat(300) }], planUpdates: [{ tick: 5, fighter: 1, strategy: {} }], fight: { finalHash: "0" } }],
    });
    expect(rec!.rounds[0]!.meta![0]!.why!.length).toBe(100);
    expect(rec!.rounds[0]!.planUpdates!.length).toBe(1);
  });
});
