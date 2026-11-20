import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideRound, loadSouls, parseLineup, seatsFor } from "../src/ai/decide";
import { cleanLine, jsonObjects, MAX_LINE, parseAnswer } from "../src/ai/parse";
import { buildPrompt } from "../src/ai/prompt";
import { grokText, registerStubs } from "../src/ai/providers";
import { exampleSouls, Fight, houseStrategy, initPhysics, initialMorale, Match, parseSoul, REFLEX, replayMatch, Rng, StatsCollector, TEMPERAMENT_MORALE, VoiceSession, type DecideContext, type Soul } from "../src/sim";
import { sanitizeDecision, sanitizeRecord } from "../src/viewer/sanitize";

setDefaultTimeout(240_000);
beforeAll(async () => {
  await initPhysics();
  registerStubs(20);
});

const NAMES = ["Brick", "Pike", "Squeaks", "Goldie"];
const souls = () => loadSouls("souls").map((l) => l.soul);

describe("parsing AI answers", () => {
  test("finds the plan inside prose or Markdown, with aliases", () => {
    const p = parseAnswer('Okay!\n```json\n{"weapons":["Hook","baseball bat"],"target":"pike","stance":"Rush","retaliate":"attacker","line":"  \\"Batter up, darling.\\" "}\n```', 0, NAMES);
    expect(p.strategy).toEqual({ target: "grudge", grudge: 1, stance: "rush", weapons: ["grapple", "bat"], retaliate: "attacker", line: "" });
    expect(p.line).toBe("Batter up, darling.");
  });

  test("weapons: 1 to 3 different pickups; 'loadout' still accepted; targets by soul name or preference, never yourself", () => {
    expect(parseAnswer('{"weapons":["rocket"],"target":"goldie","stance":"cover","line":"x"}', 0, NAMES).strategy?.grudge).toBe(3);
    expect(parseAnswer('{"loadout":["rocket","bat"],"target":"weakest","stance":"cover","line":"x"}', 0, NAMES).strategy?.weapons).toEqual(["rocket", "bat"]);
    expect(parseAnswer('{"weapons":["rocket","bat"],"target":"Brick","stance":"cover","line":"x"}', 0, NAMES).strategy).toBeNull();
    expect(parseAnswer('{"weapons":["rocket","bat","grenade","shotgun"],"target":"nearest","stance":"cover","line":"x"}', 0, NAMES).strategy).toBeNull();
    expect(parseAnswer('{"weapons":["fist"],"target":"nearest","stance":"cover","line":"x"}', 0, NAMES).strategy).toBeNull();
    // names come from the souls: swap a soul and its name becomes a target
    expect(parseAnswer('{"weapons":["bat"],"target":"Vex","stance":"rush","line":"x"}', 0, ["A", "Vex", "C", "D"]).strategy?.grudge).toBe(1);
  });

  test("rejects bad plans but keeps a usable line; defaults retaliate to turn", () => {
    const p = parseAnswer('{"weapons":["rocket","rocket"],"target":"nearest","stance":"rush","line":"I only brought rockets."}', 2, NAMES);
    expect(p.strategy).toBeNull();
    expect(p.line).toBe("I only brought rockets.");
    expect(p.problems.join()).toContain("weapons");
    expect(parseAnswer('{"weapons":["rocket","bat"],"target":"nearest","stance":"rush","line":"ok"}', 2, NAMES).strategy!.retaliate).toBe("turn");
    expect(parseAnswer("no json at all", 2, NAMES).problems).toEqual(["no JSON object"]);
  });

  test("takes a later valid object when an earlier one is junk; trims long lines", () => {
    const p = parseAnswer('{"thinking": "hmm"} then {"weapons":["shotgun","grenade"],"target":"leader","stance":"item","line":"Mine."}', 3, NAMES);
    expect(p.strategy?.weapons).toEqual(["shotgun", "grenade"]);
    expect(cleanLine("x".repeat(400))!.length).toBeLessThanOrEqual(MAX_LINE);
    expect(jsonObjects('a {"b": "}"} c').length).toBe(1);
    expect(grokText('{"text":"{\\"a\\":1}","stopReason":"end_turn"}')).toBe('{"a":1}');
    expect(() => grokText('{"text":"","stopReason":"max_turn_requests"}')).toThrow();
  });

  test("lineup flags (by seat or by soul name)", () => {
    expect(parseLineup(undefined)).toEqual(["claude", "codex", "grok", "claude"]);
    expect(parseLineup("pike=house,goldie=stub", NAMES)).toEqual(["claude", "house", "grok", "stub"]);
    expect(parseLineup("stub,stub,junk,slow")).toEqual(["stub", "stub", "junk", "slow"]);
    expect(parseLineup("vex=house", ["A", "Vex", "C", "D"])).toEqual(["claude", "house", "grok", "claude"]);
    expect(() => parseLineup("brick=gemini", NAMES)).toThrow();
  });
});

describe("souls", () => {
  test("the four example souls parse cleanly and carry identity, attitude, voice and values", () => {
    const loaded = loadSouls("souls");
    expect(loaded.map((l) => l.soul.name)).toEqual(NAMES);
    for (const l of loaded) {
      const p = parseSoul(readFileSync(l.file, "utf8"));
      expect(p.errors).toEqual([]);
      expect(l.soul.values.length).toBeGreaterThan(1);
      expect(l.soul.lines.length).toBeGreaterThan(20);
      expect(l.soul.body).toMatch(/sparingly/);
    }
    expect(exampleSouls().map((s) => s.name)).toEqual(NAMES); // bundled copies match the files
    expect(exampleSouls()).toEqual(loaded.map((l) => l.soul));
  });

  test("validation: bad values are errors, missing values are filled from the text", () => {
    const bad = parseSoul("---\nname: Zap\nstance: hover\ncolor: blue\nweapons: laser, bat\n---\nA fighter.");
    expect(bad.errors.join(" | ")).toContain("stance");
    expect(bad.errors.join(" | ")).toContain("color");
    expect(bad.errors.join(" | ")).toContain("laser");
    const guessed = parseSoul("# Nibs\n\nNibs is nervous and hides behind cover. Goes for the weakest. Holds a grudge forever. Loves grenades.", 2);
    expect(guessed.errors).toEqual([]);
    expect(guessed.soul.name).toBe("Nibs");
    expect(guessed.soul.stance).toBe("cover");
    expect(guessed.soul.target).toBe("weakest");
    expect(guessed.soul.retaliate).toBe("attacker");
    expect(guessed.soul.temperament).toBe("nervous");
    expect(guessed.soul.weapons).toEqual(["grenade"]);
    expect(parseSoul("just some text").errors).toContain("name is missing");
  });

  test("loadSouls refuses invalid or duplicate souls with a clear message", () => {
    const dir = mkdtempSync(join(tmpdir(), "souls-"));
    for (const n of ["a", "b", "c"]) writeFileSync(`${dir}/${n}.md`, `---\nname: ${n}\n---\nbody`);
    expect(() => loadSouls(dir)).toThrow(/need 4/);
    writeFileSync(`${dir}/d.md`, "---\nname: d\nstance: fly\n---\nbody");
    expect(() => loadSouls(dir)).toThrow(/d\.md: stance/);
    writeFileSync(`${dir}/d.md`, "---\nname: a\n---\nbody");
    expect(() => loadSouls(dir)).toThrow(/different/);
  });

  test("house bots map soul fields to strategies; swap a soul and the fighter changes", () => {
    const ss = exampleSouls();
    const ctx = (soulsArr: Soul[], me: number): DecideContext => ({
      phase: "intro",
      round: 1,
      me,
      names: soulsArr.map((s) => s.name),
      souls: soulsArr,
      wins: [0, 0, 0, 0],
      morale: initialMorale(soulsArr.map((s) => TEMPERAMENT_MORALE[s.temperament])),
      last: null,
      history: [],
      session: new VoiceSession(),
      lineRng: new Rng(1),
      strategyRng: new Rng(2),
    });
    const brick = houseStrategy(ctx(ss, 0));
    expect(brick.stance).toBe("rush");
    expect(brick.weapons[0]).toBe("bat");
    expect(brick.retaliate).toBe("attacker");
    const pike = houseStrategy(ctx(ss, 1));
    expect(pike.stance).toBe("distance");
    expect(pike.weapons[0]).toBe("rocket");
    // seat 0 gets Pike's soul: seat 0 now plays like Pike, talks like Pike, has Pike's name and color
    const swapped = [ss[1]!, ss[0]!, ss[2]!, ss[3]!];
    expect(houseStrategy(ctx(swapped, 0))).toEqual({ ...pike, grudge: undefined });
    const m = new Match(7, { souls: swapped });
    m.prepareRound();
    expect(m.fight!.sim.fighters[0]!.name).toBe("Pike");
    expect(m.fight!.sim.fighters[0]!.color).toBe(ss[1]!.color);
    expect(ss[1]!.lines.map((l) => l[2])).toContain(m.record.rounds[0]!.lines[0]);
    // a soul with no lines of its own still talks, in its voice
    const plain = parseSoul("---\nname: Nobody\nvoice: sly\n---\nQuiet type.", 3).soul;
    const m2 = new Match(7, { souls: [ss[0]!, ss[1]!, ss[2]!, plain] });
    m2.prepareRound();
    expect(m2.record.rounds[0]!.lines[3]!.length).toBeGreaterThan(5);
  });
});

describe("the prompt", () => {
  test("has the soul, the equal-start rules, standings, this fighter's round stats, last lines, own lines and the choices", () => {
    const m = new Match(9);
    m.playRound();
    const ctx = m.contextFor(1);
    const p = buildPrompt(souls()[1]!, ctx, { level: m.level, lastLines: m.record.rounds[0]!.lines, lastHealth: m.facts[0]!.fighters.map((f) => f.hpEnd), myLines: [m.record.rounds[0]!.lines[1]!] });
    expect(p).toContain("You are Pike");
    expect(p).toContain("Geometry, darling");
    expect(p).toContain("sparingly");
    expect(p).toContain("best of 3");
    expect(p).toContain("only their fists");
    expect(p).toContain("WHAT HAPPENED TO YOU");
    expect(p).toContain("DAMAGE YOU TOOK");
    expect(p).toContain("PICKUPS");
    expect(p).toContain(m.record.rounds[0]!.lines[0]!);
    expect(p).toContain("YOUR EARLIER LINES");
    expect(p).toContain("attacker = chase that fighter for 10 s");
    expect(p).toContain('"weapons"');
    expect(p).not.toContain("## Lines"); // the house bot's line bank stays out of the prompt
    expect(p).toContain(m.level.theme);
    expect(p.length).toBeLessThan(7000);
  });
});

describe("deciding a round (stub providers)", () => {
  test("valid answers are used; junk, timeouts and errors fall back to the house bot", async () => {
    const m = new Match(4);
    const seats = seatsFor(["stub", "junk", "slow", "broken"], souls());
    const t0 = performance.now();
    const ask = await decideRound(m, seats, 400);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(1500); // the slow one is cut off at the deadline
    expect(ask.meta.map((x) => x.outcome)).toEqual(["ok", "fallback-invalid", "fallback-timeout", "fallback-error"]);
    expect(ask.decisions[0]!.strategy.weapons).toEqual(["rocket", "bat"]);
    expect(ask.decisions[0]!.line).toBe("Brick is coming for you.");
    for (const d of ask.decisions.slice(1)) expect(d.line.length).toBeGreaterThan(5); // bot lines
    m.prepareRound(ask.decisions, ask.meta);
    expect(m.fight!.sim.fighters[0]!.prefs.slice(0, 2)).toEqual(["rocket", "bat"]);
  });

  test("per-provider deadlines and hedging (#14): a hanging first call is beaten by a hedged second one", async () => {
    const m = new Match(4);
    const t0 = performance.now();
    const ask = await decideRound(m, seatsFor(["tail", "house", "house", "house"], souls())); // no override: per-provider deadlines
    expect(ask.meta[0]!.outcome).toBe("ok");
    expect(ask.meta[0]!.hedged).toBe(true);
    expect(performance.now() - t0).toBeLessThan(2000); // hedged after 100 ms, answered 20 ms later
    expect(ask.decisions[0]!.line).toContain("second try");
    const { PROVIDERS } = await import("../src/ai/providers");
    expect(PROVIDERS.codex!.deadlineMs).toBe(45_000);
    expect(PROVIDERS.codex!.hedgeAfterMs).toBe(15_000);
    expect(PROVIDERS.grok!.deadlineMs).toBe(30_000);
    // an explicit deadline still overrides every provider
    const ask2 = await decideRound(m, seatsFor(["slow", "house", "house", "house"], souls()), 300);
    expect(ask2.meta[0]!.outcome).toBe("fallback-timeout");
  });

  test("house seats need no provider", async () => {
    const m = new Match(4);
    const ask = await decideRound(m, seatsFor(["house", "house", "stub", "house"], souls()), 400);
    expect(ask.meta.map((x) => x.outcome)).toEqual(["house", "house", "ok", "house"]);
  });

  test("an AI match record (all decisions + meta) replays exactly", async () => {
    const m = new Match(13);
    const seats = seatsFor(["stub", "junk", "house", "stub"], souls());
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
    { target: "grudge" as const, grudge: 3, stance: "rush" as const, weapons: ["rocket" as const, "bat" as const], retaliate, line: "" },
    { target: "nearest" as const, stance: "distance" as const, weapons: ["rocket" as const, "shotgun" as const], line: "" },
    { target: "nearest" as const, stance: "cover" as const, weapons: ["grenade" as const, "shotgun" as const], line: "" },
    { target: "nearest" as const, stance: "rush" as const, weapons: ["grapple" as const, "shotgun" as const], line: "" },
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
  test("unknown values become plain defaults; lines stay plain strings", () => {
    const d = sanitizeDecision({ line: "<img src=x onerror=alert(1)>", strategy: { weapons: ["<b>", "bat"], stance: "<script>", target: "grudge", grudge: 9, retaliate: "x" } }, 0);
    expect(d.strategy.weapons).toEqual(["bat"]);
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

describe("collectible weapons", () => {
  test("a pickup fills a fist slot first, then replaces the weapon not in hand and drops it", () => {
    const f0 = new Fight(2);
    const sim = f0.sim;
    const f = sim.fighters[0]!;
    sim.setPrefs(0, ["rocket", "bat"]);
    expect(f.weapons).toEqual(["fist", "fist"]);
    expect(sim.wantsWeapon(f, "grenade")).toBe(true); // anything beats fists
    sim.applyItem(f, "grenade");
    expect(f.weapons.filter((w) => w !== "fist")).toEqual(["grenade"]);
    expect(sim.weapon(f)).toBe("grenade");
    sim.applyItem(f, "rocket");
    expect([...f.weapons].sort()).toEqual(["grenade", "rocket"]);
    expect(sim.weapon(f)).toBe("rocket");
    // full: only a better-ranked weapon than the one not in hand is wanted
    // prefs are rocket, bat, then the unlisted ones in a fixed order: shotgun, grenade, grapple
    expect(sim.wantsWeapon(f, "grapple")).toBe(false); // ranks below the grenade it would replace
    expect(sim.wantsWeapon(f, "rocket")).toBe(false); // already carried
    expect(sim.wantsWeapon(f, "bat")).toBe(true); // bat (rank 1) beats grenade (rank 3)
    const before = sim.items().length;
    sim.applyItem(f, "bat");
    expect([...f.weapons].sort()).toEqual(["bat", "rocket"]);
    const dropped = sim.items().filter((e) => e.itemType === "grenade" && e.owner === 0);
    expect(sim.items().length).toBe(before + 1);
    expect(dropped.length).toBe(1);
  });

  test("weapons wait in the arena at the start, one near every spawn, and a knocked-out fighter drops his", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const f = new Fight(seed);
      const weapons = f.sim.items().filter((e) => ["rocket", "shotgun", "bat", "grenade", "grapple"].includes(e.itemType!));
      expect(weapons.length).toBeGreaterThanOrEqual(5);
      for (const fi of f.sim.fighters) {
        const p = f.sim.pos(fi);
        const d = Math.min(...weapons.map((e) => Math.hypot(e.body.translation().x - p.x, e.body.translation().y - p.y)));
        expect(d).toBeLessThan(9);
      }
    }
    const f = new Fight(3);
    f.step();
    const v = f.sim.fighters[1]!;
    v.weapons = ["rocket", "bat"];
    const n = f.sim.items().length;
    f.sim.damageFighter(v, 1000, 0, 0, 0, "test", 0, 0);
    expect(v.weapons).toEqual(["fist", "fist"]);
    expect(f.sim.items().length).toBe(n + 2);
  });

  test("everyone arms up early in real rounds, and wishes differ by soul", () => {
    const firsts: number[] = [];
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const m = new Match(seed);
      m.prepareRound();
      const first = [-1, -1, -1, -1];
      m.onEvent = (e) => {
        if (e.type === "pickup" && ["rocket", "shotgun", "bat", "grenade", "grapple"].includes(e.item) && first[e.fighter]! < 0) first[e.fighter] = e.tick;
      };
      while (!m.step()) {
        /* round */
      }
      for (const t of first) if (t >= 0) firsts.push(t / 60);
      expect(new Set(m.decisions.map((d) => d.strategy.weapons[0])).size).toBeGreaterThan(1);
    }
    firsts.sort((a, b) => a - b);
    expect(firsts.length).toBeGreaterThanOrEqual(20);
    expect(firsts[Math.floor(firsts.length / 2)]!).toBeLessThan(4); // median under 4 s
  });

  test("a record carries its souls: replay needs no soul files and reproduces names, lines and hashes", () => {
    const custom = [...exampleSouls()];
    custom[2] = parseSoul("---\nname: Vex\ncolor: #aa55ff\nvoice: smug\nstance: distance\nweapons: rocket, grenade\n---\nCold and patient.", 2).soul;
    const m = new Match(31, { souls: custom });
    m.playToEnd();
    const rec = JSON.parse(JSON.stringify(m.record));
    expect(rec.souls[2].name).toBe("Vex");
    const r = replayMatch(rec);
    expect(r.names).toEqual(["Brick", "Pike", "Vex", "Goldie"]);
    expect(r.record.rounds.map((x) => x.fight.finalHash)).toEqual(m.record.rounds.map((x) => x.fight.finalHash));
    expect(r.record.rounds.map((x) => x.lines)).toEqual(m.record.rounds.map((x) => x.lines));
    expect(sanitizeRecord(rec)!.souls[2]!.color).toBe(0xaa55ff);
  });
});
