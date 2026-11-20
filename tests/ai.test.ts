import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { decideRound, loadSouls, parseLineup, seatsFor } from "../src/ai/decide";
import { cleanLine, jsonObjects, MAX_LINE, parseAnswer } from "../src/ai/parse";
import { buildPrompt } from "../src/ai/prompt";
import { grokText, registerStubs } from "../src/ai/providers";
import { Fight, initPhysics, Match, REFLEX, replayMatch, StatsCollector } from "../src/sim";
import { sanitizeDecision, sanitizeRecord } from "../src/viewer/sanitize";

setDefaultTimeout(240_000);
beforeAll(async () => {
  await initPhysics();
  registerStubs(20);
});

describe("parsing AI answers", () => {
  test("finds the plan inside prose or Markdown, with aliases", () => {
    const p = parseAnswer('Okay!\n```json\n{"loadout":["Hook","baseball bat"],"target":"pike","stance":"Rush","retaliate":"attacker","line":"  \\"Batter up, darling.\\" "}\n```', 0);
    expect(p.strategy).toEqual({ target: "grudge", grudge: 1, stance: "rush", loadout: ["grapple", "bat"], retaliate: "attacker", line: "" });
    expect(p.line).toBe("Batter up, darling.");
  });

  test("targets by name, colour or preference; never yourself", () => {
    expect(parseAnswer('{"loadout":["rocket","bat"],"target":"gold","stance":"cover","line":"x"}', 0).strategy?.grudge).toBe(3);
    expect(parseAnswer('{"loadout":["rocket","bat"],"target":"weakest","stance":"cover","line":"x"}', 0).strategy?.target).toBe("weakest");
    expect(parseAnswer('{"loadout":["rocket","bat"],"target":"Brick","stance":"cover","line":"x"}', 0).strategy).toBeNull();
  });

  test("rejects bad plans but keeps a usable line; defaults retaliate to turn", () => {
    const p = parseAnswer('{"loadout":["rocket","rocket"],"target":"nearest","stance":"rush","line":"I only brought rockets."}', 2);
    expect(p.strategy).toBeNull();
    expect(p.line).toBe("I only brought rockets.");
    expect(p.problems.join()).toContain("loadout");
    expect(parseAnswer('{"loadout":["rocket","bat"],"target":"nearest","stance":"rush","line":"ok"}', 2).strategy!.retaliate).toBe("turn");
    expect(parseAnswer("no json at all", 2).problems).toEqual(["no JSON object"]);
  });

  test("takes a later valid object when an earlier one is junk; trims long lines", () => {
    const p = parseAnswer('{"thinking": "hmm"} then {"loadout":["shotgun","grenade"],"target":"leader","stance":"item","line":"Mine."}', 3);
    expect(p.strategy?.loadout).toEqual(["shotgun", "grenade"]);
    expect(cleanLine("x".repeat(400))!.length).toBeLessThanOrEqual(MAX_LINE);
    expect(jsonObjects('a {"b": "}"} c').length).toBe(1);
    expect(grokText('{"text":"{\\"a\\":1}","stopReason":"end_turn"}')).toBe('{"a":1}');
    expect(() => grokText('{"text":"","stopReason":"max_turn_requests"}')).toThrow();
  });

  test("lineup flags", () => {
    expect(parseLineup(undefined)).toEqual(["claude", "codex", "grok", "claude"]);
    expect(parseLineup("pike=house,goldie=stub")).toEqual(["claude", "house", "grok", "stub"]);
    expect(parseLineup("stub,stub,junk,slow")).toEqual(["stub", "stub", "junk", "slow"]);
    expect(() => parseLineup("brick=gemini")).toThrow();
  });
});

describe("the prompt", () => {
  test("has the soul, the rules, standings, the round stats for this fighter, last lines and the choices", () => {
    const m = new Match(9);
    m.playRound();
    const souls = loadSouls("souls");
    const ctx = m.contextFor(1);
    const p = buildPrompt(souls[1]!, ctx, { level: m.level, lastLines: m.record.rounds[0]!.lines, lastHealth: m.facts[0]!.fighters.map((f) => f.hpEnd) });
    expect(p).toContain("You are Pike");
    expect(p).toContain("Geometry, darling");
    expect(p).toContain("best of 3");
    expect(p).toContain(`YOUR ROUND: ${m.facts[0]!.stats.summary[1]}`);
    expect(p).toContain("DAMAGE YOU TOOK");
    expect(p).toContain(m.record.rounds[0]!.lines[0]!);
    expect(p).toContain("retaliate");
    expect(p).toContain(m.level.theme);
    expect(p.length).toBeLessThan(6000);
  });
});

describe("deciding a round (stub providers)", () => {
  test("valid answers are used; junk, timeouts and errors fall back to the house bot", async () => {
    const m = new Match(4);
    const seats = seatsFor(["stub", "junk", "slow", "broken"], loadSouls("souls"));
    const t0 = performance.now();
    const ask = await decideRound(m, seats, 400);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(1500); // the slow one is cut off at the deadline
    expect(ask.meta.map((x) => x.outcome)).toEqual(["ok", "fallback-invalid", "fallback-timeout", "fallback-error"]);
    expect(ask.decisions[0]!.strategy.loadout).toEqual(["rocket", "bat"]);
    expect(ask.decisions[0]!.line).toBe("Brick is coming for you.");
    for (const d of ask.decisions.slice(1)) expect(d.line.length).toBeGreaterThan(5); // bot lines
    m.prepareRound(ask.decisions, ask.meta);
    expect(m.fight!.sim.fighters[0]!.weapons).toEqual(["rocket", "bat"]);
  });

  test("house seats need no provider", async () => {
    const m = new Match(4);
    const ask = await decideRound(m, seatsFor(["house", "house", "stub", "house"], loadSouls("souls")), 400);
    expect(ask.meta.map((x) => x.outcome)).toEqual(["house", "house", "ok", "house"]);
  });

  test("an AI match record (all decisions + meta) replays exactly", async () => {
    const m = new Match(13);
    const seats = seatsFor(["stub", "junk", "house", "stub"], loadSouls("souls"));
    while (!m.over) {
      const ask = await decideRound(m, seats, 400);
      m.prepareRound(ask.decisions, ask.meta);
      while (!m.step()) {
        /* round */
      }
      m.finishRound();
    }
    const rec = JSON.parse(JSON.stringify(m.record));
    const r = replayMatch(rec);
    expect(r.record.rounds.map((x) => x.fight.finalHash)).toEqual(m.record.rounds.map((x) => x.fight.finalHash));
    expect(r.record.rounds.map((x) => x.lines)).toEqual(m.record.rounds.map((x) => x.lines));
    expect(r.record.rounds[0]!.meta!.map((x) => x.outcome)).toEqual(["ok", "fallback-invalid", "house", "ok"]);
    expect(r.winner).toBe(m.winner);
  });
});

describe("round stats", () => {
  test("damage matrix: a shotgun blast is one hit, side and range are recorded, summary lines read plainly", () => {
    const c = new StatsCollector();
    for (let k = 0; k < 6; k++) c.hit(1, 3, 2, "shotgun", 3, false, 100); // one blast, six pellets
    for (let t = 0; t < 4; t++) c.hit(1, 3, 10, "rocket", 15, true, 200 + t * 60);
    for (let t = 0; t < 40; t++) c.sample([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 40, y: 0 }, { x: 60, y: 0 }], [2, 3, 1, 0]);
    const st = c.finish([{ victim: 3, by: 1, weapon: "rocket", cause: "hp" }], ["Red", "Blue", "Green", "Gold"]);
    const s = st.damage[1]![3]!;
    expect(s.hits).toBe(5);
    expect(s.damage).toBe(52);
    expect(s.fromBehind).toBe(4);
    expect(s.byRange.long).toBe(4);
    expect(s.byRange.close).toBe(1);
    expect(st.summary[3]).toContain("Blue hit you 5 times (4 from behind) with the rocket at long range, 52 damage, and you never turned on Blue.");
    expect(st.summary[3]).toContain("You chased Red all round and never landed a hit.");
    expect(st.summary[3]).toContain("You were knocked out by Blue with the rocket.");
  });

  test("a real round: stats agree with the fight", () => {
    const m = new Match(21);
    const f = m.playRound();
    const st = f.stats;
    expect(st.summary.length).toBe(4);
    for (let a = 0; a < 4; a++) {
      const dealt = st.damage[a]!.reduce((x, s, v) => x + (v === a ? 0 : s.damage), 0);
      expect(dealt).toBeLessThanOrEqual(m.fight!.sim.fighters[a]!.damageDealt + 1e-6);
    }
    expect(st.targetSeconds.flat().reduce((a, b) => a + b, 0)).toBeGreaterThan(10);
  });
});

describe("the back-attack reflex", () => {
  const strategies = (retaliate: "attacker" | "turn" | "ignore") => [
    { target: "grudge" as const, grudge: 3, stance: "rush" as const, loadout: ["rocket", "bat"] as ["rocket", "bat"], retaliate, line: "" },
    { target: "nearest" as const, stance: "distance" as const, loadout: ["rocket", "shotgun"] as ["rocket", "shotgun"], line: "" },
    { target: "nearest" as const, stance: "cover" as const, loadout: ["grenade", "shotgun"] as ["grenade", "shotgun"], line: "" },
    { target: "nearest" as const, stance: "rush" as const, loadout: ["grapple", "shotgun"] as ["grapple", "shotgun"], line: "" },
  ];

  test("repeated hits from behind by a non-target trigger it, by the retaliate rule", () => {
    for (const [rule, mode] of [
      ["attacker", "switch"],
      ["turn", "fight"],
      ["ignore", "glance"],
    ] as const) {
      const f = new Fight(1, strategies(rule));
      f.step();
      const c = f.controllers[0]!;
      expect(c.targetId).toBe(3);
      c.onHit(1, true, 5, 10);
      c.onHit(1, true, 5, 40);
      expect(c.reflex).toBeNull();
      c.onHit(1, true, 5, 70);
      expect(c.reflex?.mode).toBe(mode);
      expect(c.reflex?.attacker).toBe(1);
      f.sim.tick = 71;
      c.think(f.sim);
      expect(c.targetId).toBe(rule === "ignore" ? 3 : 1); // glancing keeps chasing the target
    }
  });

  test("hits from the front, from the target, or spread out do not trigger it", () => {
    const f = new Fight(1, strategies("attacker"));
    f.step();
    const c = f.controllers[0]!;
    for (let t = 0; t < 5; t++) c.onHit(1, false, 5, t * 30); // from the front
    for (let t = 0; t < 5; t++) c.onHit(3, true, 5, 200 + t * 30); // from my own target
    for (let t = 0; t < 3; t++) c.onHit(2, true, 5, 1000 + t * (REFLEX.windowTicks + 1)); // too spread out
    expect(c.reflexLog).toEqual([]);
  });

  test("it is deterministic and actually fires in real fights", () => {
    let fired = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const a = new Match(seed);
      a.playToEnd();
      const b = new Match(seed);
      b.playToEnd();
      expect(b.record.rounds.map((r) => r.fight.finalHash)).toEqual(a.record.rounds.map((r) => r.fight.finalHash));
      fired += a.fight!.controllers.reduce((n, c) => n + c.reflexLog.length, 0);
    }
    expect(fired).toBeGreaterThan(0);
  });
});

describe("untrusted records and streams", () => {
  test("unknown values become the signature play; lines stay plain strings", () => {
    const d = sanitizeDecision({ line: "<img src=x onerror=alert(1)>", strategy: { loadout: ["<b>", "bat"], stance: "<script>", target: "grudge", grudge: 9, retaliate: "x" } }, 0);
    expect(d.strategy.loadout).toEqual(["bat", "grapple"]);
    expect(d.strategy.stance).toBe("rush");
    expect(d.strategy.grudge).toBeUndefined();
    expect(d.strategy.retaliate).toBe("turn");
    expect(d.line).toBe("<img src=x onerror=alert(1)>"); // shown via textContent, never as HTML
    expect(sanitizeRecord({ seed: "x", rounds: [] })).toBeNull();
  });

  test("a sanitized real record still replays to the same hashes", () => {
    const m = new Match(3);
    m.playToEnd();
    const r = replayMatch(sanitizeRecord(JSON.parse(JSON.stringify(m.record)))!);
    expect(r.record.rounds.map((x) => x.fight.finalHash)).toEqual(m.record.rounds.map((x) => x.fight.finalHash));
  });
});
