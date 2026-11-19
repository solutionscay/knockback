import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Tally } from "../src/flow/score";
import {
  CHARACTERS,
  initialMorale,
  initPhysics,
  Match,
  matchWinner,
  MORALE_EFFECT,
  pickLine,
  replayMatch,
  Rng,
  updateMorale,
  VoiceSession,
  type Brain,
  type DecideContext,
  type FighterRoundFacts,
  type RoundFacts,
} from "../src/sim";

setDefaultTimeout(240_000);
beforeAll(async () => {
  await initPhysics();
});

function findMatch(pred: (m: Match) => boolean, from = 1, to = 60): Match {
  for (let s = from; s <= to; s++) {
    const m = new Match(s);
    m.playToEnd();
    if (pred(m)) return m;
  }
  throw new Error("no seed found");
}

const fighter = (id: number, over: Partial<FighterRoundFacts> = {}): FighterRoundFacts => ({
  id,
  won: false,
  survived: false,
  hpEnd: 0,
  outOrder: 0,
  kosDealt: [],
  koBy: null,
  damageDealt: 0,
  damageTaken: 0,
  humiliations: [],
  ...over,
});
const facts = (round: number, fs: FighterRoundFacts[]): RoundFacts => ({
  round,
  winner: fs.find((f) => f.won)!.id,
  reason: "last-standing",
  seconds: 40,
  fighters: fs,
  chainReactions: 0,
  platformsFallen: 0,
  biggestHit: null,
});

describe("best of 3", () => {
  test("match winner rule: first to 2, round 3 decides", () => {
    expect(matchWinner([1, 0, 0, 0], [0])).toBe(-1);
    expect(matchWinner([2, 0, 0, 0], [0, 0])).toBe(0);
    expect(matchWinner([1, 1, 0, 0], [0, 1])).toBe(-1);
    expect(matchWinner([1, 2, 0, 0], [0, 1, 1])).toBe(1);
    expect(matchWinner([1, 1, 1, 0], [0, 1, 2])).toBe(2); // three different winners: the decider takes it
  });

  test("a 2-0 match stops after two rounds", () => {
    const m = findMatch((x) => x.round === 2);
    expect(m.over).toBe(true);
    expect(Math.max(...m.wins)).toBe(2);
    expect(m.wins[m.winner]).toBe(2);
    expect(m.results[0]!.winner).toBe(m.results[1]!.winner);
    expect(m.record.rounds.length).toBe(2);
    expect(() => m.prepareRound()).toThrow();
  });

  test("a 2-1 match goes to round three", () => {
    const m = findMatch((x) => x.round === 3 && x.decidedBy() === "two-wins");
    expect(m.wins[m.winner]).toBe(2);
    expect(m.wins.reduce((a, b) => a + b, 0)).toBe(3);
    expect(m.results[2]!.winner).toBe(m.winner);
  });

  test("health and the level reset every round; morale carries over", () => {
    const m = new Match(7);
    m.prepareRound();
    while (!m.step()) {
      /* round 1 */
    }
    m.finishRound();
    const destroyed = m.fight!.sim.stats.cellsDestroyed;
    expect(destroyed).toBeGreaterThan(0);
    const moraleAfter1 = m.morale.map((x) => x.score);
    m.prepareRound();
    const sim = m.fight!.sim;
    expect(sim.fighters.every((f) => f.hp === 100 && f.alive)).toBe(true);
    expect(Buffer.from(sim.grid.mat).equals(Buffer.from(m.level.grid.mat))).toBe(true);
    expect(sim.tick).toBe(0);
    expect(m.moraleAtStart[1]!.map((x) => x.score)).toEqual(moraleAfter1);
    expect(m.morale.map((x) => x.score)).not.toEqual(initialMorale(CHARACTERS.map((c) => c.moraleBaseline)).map((x) => x.score));
  });

  test("tally: each round win +3, each knockout +1", () => {
    const m = new Match(3);
    m.playToEnd();
    const t = new Tally();
    for (const r of m.results) t.add(r);
    for (let i = 0; i < 4; i++) expect(t.points[i]).toBe(m.wins[i]! * 3 + m.kos[i]!);
  });
});

describe("morale", () => {
  const base = () => initialMorale([30, 30, 30, 30]);

  test("a clean round win makes you cocky; being knocked out first lowers morale", () => {
    const f = facts(1, [
      fighter(0, { won: true, survived: true, hpEnd: 90, kosDealt: [{ victim: 1, weapon: "bat", cause: "ringout" }] }),
      fighter(1, { koBy: { by: 0, weapon: "bat", cause: "hp" }, outOrder: 1 }),
      fighter(2, { koBy: { by: 3, weapon: "rocket", cause: "hp" }, outOrder: 2 }),
      fighter(3, { koBy: { by: 0, weapon: "shotgun", cause: "hp" }, outOrder: 3 }),
    ]);
    const m = updateMorale(base(), f, [1, 0, 0, 0]);
    expect(m[0]!.state).toBe("cocky");
    expect(m[0]!.score).toBeGreaterThan(60);
    expect(m[1]!.score).toBeLessThan(m[3]!.score); // first out hurts more
    expect(m[1]!.grudge).toBe(0);
  });

  test("humiliation by someone makes you furious with a grudge; a self-own does not", () => {
    const f = facts(1, [
      fighter(0, { won: true, survived: true, hpEnd: 40 }),
      fighter(1, { koBy: { by: 0, weapon: "bat", cause: "ringout" }, outOrder: 1, humiliations: [{ kind: "bat-ringout", by: 0 }] }),
      fighter(2, { survived: true, hpEnd: 50, humiliations: [{ kind: "own-explosive", by: 2 }] }),
      fighter(3, { survived: true, hpEnd: 60 }),
    ]);
    const m = updateMorale(base(), f, [1, 0, 0, 0]);
    expect(m[1]!.state).toBe("furious");
    expect(m[1]!.grudge).toBe(0);
    expect(m[2]!.state).not.toBe("furious");
    expect(m[2]!.score).toBeLessThan(30);
  });

  test("desperate: no wins, someone on match point, morale low", () => {
    const start = initialMorale([-30, 30, 30, 30]);
    const f = facts(1, [
      fighter(0, { koBy: { by: -1, weapon: "fall", cause: "ringout" }, outOrder: 1 }),
      fighter(1, { won: true, survived: true, hpEnd: 50 }),
      fighter(2, { koBy: { by: 1, weapon: "rocket", cause: "hp" }, outOrder: 2 }),
      fighter(3, { koBy: { by: 1, weapon: "rocket", cause: "hp" }, outOrder: 3 }),
    ]);
    const m = updateMorale(start, f, [0, 1, 0, 0]);
    expect(m[0]!.state).toBe("desperate");
    expect(m[1]!.state).not.toBe("desperate");
  });

  test("morale's behavior nudges stay small", () => {
    for (const e of Object.values(MORALE_EFFECT)) {
      expect(e.aim).toBeGreaterThanOrEqual(0.85);
      expect(e.aim).toBeLessThanOrEqual(1.35);
    }
  });
});

describe("dialogue and the decision slot", () => {
  const ctxFor = (me: number, last: RoundFacts | null, session = new VoiceSession(), seed = 1): DecideContext => ({
    phase: last ? "between" : "intro",
    round: last ? last.round + 1 : 1,
    me,
    names: CHARACTERS.map((c) => c.name),
    wins: last ? [0, 0, 0, 0].map((_, i) => (i === last.winner ? 1 : 0)) : [0, 0, 0, 0],
    morale: initialMorale(CHARACTERS.map((c) => c.moraleBaseline)),
    last,
    history: last ? [last] : [],
    session,
    lineRng: new Rng(seed),
    strategyRng: new Rng(seed + 1),
  });
  const strat = { target: "nearest" as const, stance: "rush" as const, loadout: ["bat", "grapple"] as ["bat", "grapple"], line: "" };

  test("lines reference what actually happened", () => {
    const f = facts(1, [
      fighter(0, { won: true, survived: true, hpEnd: 30, kosDealt: [{ victim: 1, weapon: "bat", cause: "ringout" }] }),
      fighter(1, { koBy: { by: 0, weapon: "bat", cause: "ringout" }, outOrder: 1, humiliations: [{ kind: "bat-ringout", by: 0 }] }),
      fighter(2, { survived: true, hpEnd: 40, humiliations: [{ kind: "own-explosive", by: 2 }] }),
      fighter(3, { koBy: { by: 0, weapon: "shotgun", cause: "hp" }, outOrder: 2 }),
    ]);
    const pike = pickLine(ctxFor(1, f), strat);
    expect(pike.line).toContain("Brick"); // "Struck with a stick. By Brick."
    const squeaks = pickLine(ctxFor(2, f), strat);
    expect(squeaks.line.toLowerCase()).toContain("own");
    const goldie = pickLine(ctxFor(3, f), strat);
    expect(goldie.line).toContain("Brick");
  });

  test("no repeated lines within a session until the relevant lines run dry", () => {
    const session = new VoiceSession();
    const fitting = CHARACTERS[0]!.lines.filter((t) => (t[0] === "intro" || t[0] === "state") && (t[1] === "*" || t[1].includes("cocky"))).length;
    const seen = new Set<string>();
    for (let i = 0; i < fitting; i++) {
      const p = pickLine(ctxFor(0, null, session, i), strat);
      expect(seen.has(p.id)).toBe(false);
      session.used.add(p.id);
      seen.add(p.id);
    }
    expect(seen.size).toBe(fitting);
    // once dry it may repeat rather than go silent
    const again = pickLine(ctxFor(0, null, session, 99), strat);
    expect(again.line.length).toBeGreaterThan(5);
  });

  test("the decision slot: a custom brain's strategy is used and its line recorded", () => {
    const calls: DecideContext[] = [];
    const brain: Brain = (ctx) => {
      calls.push(ctx);
      return { line: `round ${ctx.round} from ${ctx.names[ctx.me]}`, strategy: { target: "weakest", stance: "cover", loadout: ["grenade", "bat"], line: "" } };
    };
    const m = new Match(5, { brains: [brain, brain, brain, brain] });
    m.prepareRound();
    expect(calls.length).toBe(4);
    expect(calls[0]!.phase).toBe("intro");
    expect(m.fight!.sim.fighters.every((f) => f.weapons[0] === "grenade" && f.weapons[1] === "bat")).toBe(true);
    expect(m.record.rounds[0]!.lines[2]).toBe("round 1 from Squeaks");
    while (!m.step()) {
      /* round */
    }
    m.finishRound();
    m.prepareRound();
    expect(calls.length).toBe(8);
    expect(calls[4]!.phase).toBe("between");
    expect(calls[4]!.last).not.toBeNull();
    expect(calls[4]!.wins.reduce((a, b) => a + b, 0)).toBe(1);
  });
});

describe("determinism and replay of a full match", () => {
  test("same seed, same match (all rounds, lines and hashes)", () => {
    for (const seed of [11, 12]) {
      const a = new Match(seed);
      a.playToEnd();
      const b = new Match(seed);
      b.playToEnd();
      expect(JSON.stringify(b.record)).toBe(JSON.stringify(a.record));
    }
  });

  test("a match record replays to the same per-round hashes and winner", () => {
    for (const seed of [21, 22, 23]) {
      const m = new Match(seed);
      m.playToEnd();
      const rec = JSON.parse(JSON.stringify(m.record));
      const r = replayMatch(rec);
      expect(r.record.rounds.map((x) => x.fight.finalHash)).toEqual(m.record.rounds.map((x) => x.fight.finalHash));
      expect(r.winner).toBe(m.winner);
      expect(r.record.rounds.map((x) => x.lines)).toEqual(m.record.rounds.map((x) => x.lines));
    }
  });
});
