import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { loadSouls, seatsFor } from "../src/ai/decide";
import { compareReports, computeReport, factsOf, NA, quantile, reportMarkdown, variety, type EvalDecision, type EvalMatch, type EvalRoundFacts } from "../src/ai/eval";
import { registerProvider, registerStubs } from "../src/ai/providers";
import { playAiMatch, rescoreRecord } from "../src/ai/run";
import { initPhysics, type Strategy } from "../src/sim";

setDefaultTimeout(120_000);
beforeAll(async () => {
  await initPhysics();
  registerStubs(5);
});

const NAMES = ["Brick", "Pike", "Squeaks", "Goldie"];
const S = (stance: Strategy["stance"], target: Strategy["target"], weapons: Strategy["weapons"], retaliate: Strategy["retaliate"] = "turn", grudge?: number): Strategy => ({
  stance,
  target,
  ...(grudge !== undefined ? { grudge } : {}),
  weapons,
  retaliate,
  line: "",
});
const ai = (s: Strategy, line = "x", ms = 4000, outcome: EvalDecision["meta"]["outcome"] = "ok", provider = "claude/haiku"): EvalDecision => ({ strategy: s, line, meta: { provider, ms, outcome } });
const house = (s: Strategy, line = "h"): EvalDecision => ({ strategy: s, line, meta: { provider: "house", ms: 0, outcome: "house" } });
const zero = () => [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
const facts = (winner: number, kos: EvalRoundFacts["kos"], dmg: [number, number, number][] = [], behind: [number, number, number][] = []): EvalRoundFacts => {
  const damage = zero();
  const bh = zero();
  for (const [a, v, d] of dmg) damage[a]![v] = d;
  for (const [a, v, n] of behind) bh[a]![v] = n;
  return { winner, kos, damage, behind: bh, weapons: [0, 1, 2, 3].map(() => [[], [], [], []]) };
};

/**
 * A fixed match: seats 0,1 are AI (claude), seats 2,3 house bots.
 * Round 1: Goldie (3) wins; Brick (0) knocked out by Goldie with the grapple; Pike (1) hurt most by Squeaks (2).
 * Round 2: Brick targets Goldie and adds the grapple; Pike targets Squeaks; Squeaks (house) targets Goldie.
 */
const fixed = (): EvalMatch => ({
  seed: 7,
  names: NAMES,
  seats: ["claude", "claude", "house", "house"],
  winner: 3,
  rounds: [
    {
      decisions: [ai(S("rush", "nearest", ["bat", "shotgun"])), ai(S("distance", "strongest", ["rocket"]), "x", 2000), house(S("cover", "nearest", ["grenade"])), house(S("rush", "weakest", ["grapple"]))],
      facts: facts(3, [{ victim: 0, by: 3, weapon: "grapple", cause: "ringout" }, { victim: 1, by: 2, weapon: "grenade", cause: "hp" }, { victim: 2, by: 3, weapon: "bat", cause: "hp" }], [
        [3, 0, 30],
        [2, 1, 50],
        [3, 1, 10],
        [3, 2, 40],
      ], [[2, 1, 4]]),
    },
    {
      decisions: [
        ai(S("rush", "grudge", ["bat", "grapple"], "attacker", 3), "Goldie hooked me off the roof, I want revenge"),
        ai(S("distance", "grudge", ["rocket", "grenade"], "turn", 2), "Squeaks shot me in the back and Goldie knocked me out", 9000),
        house(S("cover", "grudge", ["grenade", "bat"], "turn", 3)),
        house(S("rush", "weakest", ["grapple"])),
      ],
      facts: facts(3, [{ victim: 0, by: 3, weapon: "bat", cause: "hp" }]),
    },
  ],
});

describe("metric functions on fixed records", () => {
  test("variety: distribution, entropy and top share", () => {
    const v = variety(["a", "a", "b", "b"]);
    expect(v.entropy).toBe(1);
    expect(v.topShare).toBe(0.5);
    expect(variety(["x", "x", "x"]).entropy).toBe(0);
    const rep = computeReport([fixed()]);
    expect(rep.variety.ai).not.toBe(NA);
    const va = rep.variety.ai as Exclude<typeof rep.variety.ai, typeof NA>;
    expect(va.answers).toBe(4);
    expect(va.stance.dist).toEqual({ rush: 2, distance: 2 });
    expect(va.target.dist).toEqual({ nearest: 1, strongest: 1, Goldie: 1, Squeaks: 1 });
    expect(va.target.entropy).toBe(2);
    expect(va.retaliate.topShare).toBe(0.75);
    expect(va.weapon1.dist).toEqual({ bat: 2, rocket: 2 });
  });

  test("plan change: how often and which fields", () => {
    const rep = computeReport([fixed()]);
    expect(rep.change.ai).toEqual({ transitions: 2, changed: 2, changeRate: 1, fields: { stance: 0, target: 2, retaliate: 1, weapons: 2, rules: 0 } });
    expect(rep.change.house).toEqual({ transitions: 2, changed: 1, changeRate: 0.5, fields: { stance: 0, target: 1, retaliate: 0, weapons: 1, rules: 0 } });
    expect(rep.change.byFighter["Brick (claude)"]!.fields).toEqual({ stance: 0, target: 1, retaliate: 1, weapons: 1, rules: 0 });
    expect(rep.change.checkinsPerRound).toBe(NA);
  });

  test("follows the stats: killer, winner, top damager, and the killer's weapon in the wish list", () => {
    const f = computeReport([fixed()]).follows;
    const a = f.ai as Exclude<typeof f.ai, typeof NA>;
    expect(a.decisions).toBe(2);
    expect(a.targetedKiller).toEqual({ chances: 2, hits: 2, rate: 1 }); // Brick went for Goldie, Pike for Squeaks: their killers
    expect(a.targetedWinner).toEqual({ chances: 2, hits: 1, rate: 0.5 }); // only Brick targeted Goldie
    expect(a.targetedTopDamager).toEqual({ chances: 2, hits: 2, rate: 1 }); // Goldie hurt Brick most, Squeaks hurt Pike most
    expect(a.killerWeaponAdded).toEqual({ chances: 2, hits: 2, rate: 1 }); // grapple for Brick, grenade for Pike
    const h = f.house as Exclude<typeof f.house, typeof NA>;
    expect(h.targetedKiller).toEqual({ chances: 1, hits: 1, rate: 1 }); // Squeaks, knocked out by Goldie, targets Goldie
    expect(h.targetedWinner.chances).toBe(1); // Goldie herself won: no chance for her
  });

  test("facts: a line naming a rival with an event is checked against the round (heuristic)", () => {
    const fc = factsOf([fixed()]);
    expect(fc.checked).toBe(2);
    // "Goldie hooked me" fits (Goldie damaged Brick); "Squeaks shot me in the back" fits (4 hits from behind);
    // "Goldie knocked me out" does not: Squeaks knocked Pike out (each claim is pinned on the rival named just before it)
    expect(fc.mismatches.length).toBe(1);
    expect(fc.mismatches[0]!.fighter).toBe("Pike");
    expect(fc.mismatches[0]!.claim).toContain("knockout");
    expect(fc.mismatches[0]!.facts).toContain("knocked out by Squeaks");
  });

  test("reliability: response times, timeouts, errors, invalid answers and fallbacks per provider", () => {
    const m = fixed();
    m.rounds[1]!.decisions[0] = ai(S("rush", "nearest", ["bat"]), "bot line", 20000, "fallback-timeout");
    m.rounds[1]!.decisions[1] = ai(S("rush", "nearest", ["bat"]), "bot line", 300, "fallback-invalid", "codex/gpt-6-luna");
    const rel = computeReport([m]).reliability;
    expect(rel["claude/haiku"]).toEqual({ calls: 3, hedged: 0, ok: 2, timeouts: 1, errors: 0, invalid: 0, fallbacks: 1, ms: { median: 4000, p90: 20000, max: 20000 } });
    expect(rel["codex/gpt-6-luna"]!.invalid).toBe(1);
    expect(rel["codex/gpt-6-luna"]!.fallbacks).toBe(1);
    // fallbacks are not the AI's own plans: left out of variety and change
    const rep = computeReport([m]);
    expect((rep.variety.ai as { answers: number }).answers).toBe(2);
    expect(rep.change.ai).toBe(NA);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  });

  test("results: AI seats against house seats", () => {
    const r = computeReport([fixed()]).results;
    expect(r.ai).toEqual({ seats: 2, roundWins: 0, roundWinRate: 0, matchWins: 0, matchWinRate: 0 });
    expect(r.house).toEqual({ seats: 2, roundWins: 2, roundWinRate: 0.5, matchWins: 1, matchWinRate: 0.5 });
  });

  test("groups for features that don't exist yet say n/a; compare gives the change for each metric", () => {
    const a = computeReport([fixed()]);
    expect(a.change.checkinsPerRound).toBe(NA); // check-ins don't exist yet
    expect((a.rules.ai as { plansWithRules: number }).plansWithRules).toBe(0); // no rules in these plans
    const md = reportMarkdown(a);
    for (const h of ["## Variety", "## Change", "## Rules", "## Follows the stats", "## Facts", "## Reliability", "## Results"]) expect(md).toContain(h);
    expect(md).toContain("Plan rules (#5-#7)");
    const m2 = fixed();
    m2.rounds[1]!.decisions[1] = ai(S("distance", "strongest", ["rocket"]), "quiet");
    const b = computeReport([m2]);
    const d = compareReports(a, b);
    const tr = d.find((x) => x.metric === "follows.ai.targetedTopDamager.rate")!;
    expect(tr).toEqual({ metric: "follows.ai.targetedTopDamager.rate", old: 1, new: 0.5, delta: -0.5 });
    expect(d.find((x) => x.metric === "facts.mismatches")!.delta).toBe(-1);
    expect(d.find((x) => x.metric === "rules.rulesPerPlan")).toBeUndefined(); // n/a is not a number
    expect(reportMarkdown(b, { compare: d })).toContain("## Compared with the old report");
  });

  test("facts: a claim with the name after it, and a correct line, give no mismatch", () => {
    const m = fixed();
    m.rounds[1]!.decisions[1] = ai(S("distance", "strongest", ["rocket"]), "You knocked me out, Squeaks. Lucky.");
    m.rounds[1]!.decisions[0] = ai(S("rush", "nearest", ["bat"]), "Pike, you shot me in the back!"); // Pike never hit Brick
    const fc = factsOf([m]);
    expect(fc.checked).toBe(2);
    expect(fc.mismatches.map((x) => x.fighter)).toEqual(["Brick", "Brick"]); // a back claim and a hit claim, both on Pike
  });

  test("no house seats: the house column is the house bot's plan in the AI's place", () => {
    const m = fixed();
    m.seats = ["claude", "claude", "codex", "codex"];
    m.rounds[0]!.decisions = m.rounds[0]!.decisions.map((d) => ({ ...d, meta: { provider: "x", ms: 1, outcome: "ok" as const }, house: S("rush", "nearest", ["bat"]) }));
    m.rounds[1]!.decisions = m.rounds[1]!.decisions.map((d, i) => ({ ...d, meta: { provider: "x", ms: 1, outcome: "ok" as const }, house: i === 0 ? S("rush", "grudge", ["bat", "grapple"], "attacker", 3) : S("rush", "nearest", ["bat"]) }));
    const r = computeReport([m]);
    expect(r.houseInAiPlace).toBe(true);
    const h = r.follows.house as Exclude<typeof r.follows.house, typeof NA>;
    expect(h.decisions).toBe(4);
    expect(h.targetedKiller).toEqual({ chances: 3, hits: 1, rate: 0.333 }); // only seat 0's house plan went after its killer
    expect(h.killerWeaponAdded.hits).toBe(1); // grapple joined seat 0's house list
    expect((r.variety.house as { answers: number }).answers).toBe(8);
    expect(reportMarkdown(r)).toContain("in the same spots");
  });

  test("rules: plans with rules, rejected, fired, by trigger and action, never fired (#7)", () => {
    const m = fixed();
    const R1 = { when: "health_below" as const, who: "enemy" as const, value: 30, do: "target" as const, label: "finish the wounded" };
    const R2 = { when: "my_health_below" as const, value: 30, do: "seek" as const, doItem: "health" as const, label: "patch up" };
    m.rounds[0]!.decisions[0] = { ...m.rounds[0]!.decisions[0]!, strategy: { ...m.rounds[0]!.decisions[0]!.strategy, rules: [R1, R2] } };
    m.rounds[0]!.decisions[1] = { ...m.rounds[0]!.decisions[1]!, meta: { ...m.rounds[0]!.decisions[1]!.meta, ruleProblems: ['rule 1: unknown trigger "flies"'] } };
    m.rounds[0]!.facts.rules = [[{ fires: 2, activeTicks: 300 }, { fires: 0, activeTicks: 0 }], [], [], []];
    const r = computeReport([m]).rules.ai as Exclude<ReturnType<typeof computeReport>["rules"]["ai"], typeof NA>;
    expect(r.plans).toBe(4);
    expect(r.plansWithRules).toBe(1);
    expect(r.plansWithRulesRate).toBe(0.25);
    expect(r.rulesWritten).toBe(2);
    expect(r.rejected).toBe(1);
    expect(r.rejectedRate).toBe(0.333);
    expect(r.fired).toBe(1);
    expect(r.firedRate).toBe(0.5);
    expect(r.byWhen.health_below).toEqual({ written: 1, fired: 1, firings: 2 });
    expect(r.byDo.seek).toEqual({ written: 1, fired: 0, firings: 0 });
    expect(r.neverFired).toEqual(["Brick, round 1: 'patch up' (my_health_below -> seek)"]);
    expect(reportMarkdown(computeReport([m]))).toContain("| plans with 1+ rules | 1/4 (25%)");
  });

  test("an empty or house-only run reports n/a for the AI side", () => {
    const m = fixed();
    m.seats = ["house", "house", "house", "house"];
    for (const rd of m.rounds) rd.decisions = rd.decisions.map((d) => house(d.strategy));
    const r = computeReport([m]);
    expect(r.variety.ai).toBe(NA);
    expect(r.follows.ai).toBe(NA);
    expect(r.results.ai).toBe(NA);
    expect(r.reliability).toEqual({});
  });
});

describe("a real stub match feeds the report", () => {
  test("the report agrees with the match record", async () => {
    const souls = loadSouls("souls").map((l) => l.soul);
    const p = await playAiMatch(1001, seatsFor(["stub", "junk", "house", "house"], souls), souls, 400);
    const rep = computeReport([p.eval]);
    const rounds = p.match.record.rounds.length;
    expect(rep.rounds).toBe(rounds);
    expect(rep.reliability["stub/test"]!.calls).toBe(rounds);
    expect(rep.reliability["junk/test"]!.invalid).toBe(rounds);
    expect((rep.variety.ai as { answers: number }).answers).toBe(rounds); // junk's stand-in plans don't count
    const houseWins = p.match.record.rounds.filter((r) => r.winner >= 2).length;
    expect((rep.results.house as { roundWins: number }).roundWins).toBe(houseWins);
    expect(p.log.length).toBeGreaterThan(rounds * 5);
    // the suit-up (#19): stub answers a plan, junk nonsense: both fall back to the seeded look, counted
    expect(rep.looks).toMatchObject({ asked: 2, ok: 0, fallbacks: { invalid: 2 }, fallbackRate: 1 });
    expect(reportMarkdown(rep)).toContain("## Looks (suit up)");
    // rescoring the saved record (exact replay, no AI calls) gives the same report
    const again = rescoreRecord(JSON.parse(JSON.stringify(p.match.record)), ["stub", "junk", "house", "house"]);
    expect(computeReport([again])).toEqual(rep);
  });
});

describe("look choice in the eval (#19)", () => {
  test("variety, fallbacks and the choices per soul", async () => {
    const souls = loadSouls("souls").map((l) => l.soul);
    const looks: Record<string, string> = { brawler: '{"name":"Krak","shape":"barrel","eyes":"set","color":"#ff6a3d","mark":"horns","minor":"scratch","line":"Move."}', sniper: '{"name":"Scope","shape":"gem","eyes":"slit","color":"#7ad7ff","mark":"antenna","minor":"none","line":"Already aimed."}' };
    registerProvider("dresser", {
      label: "dresser/test",
      ask: async (prompt) => {
        if (prompt.startsWith("Knockback suit-up")) return looks[souls.find((s) => prompt.includes(s.body.slice(0, 60)))!.id] ?? "no idea";
        return '{"weapons":["bat"],"target":"nearest","stance":"rush","line":"Go."}';
      },
    });
    const p = await playAiMatch(7, seatsFor(["dresser", "dresser", "dresser", "house"], souls), souls, 400);
    expect(p.match.identities[0]).toMatchObject({ name: "Krak", shape: "barrel", mark: "horns" });
    expect(p.match.identities[1]).toMatchObject({ name: "Scope", shape: "gem" });
    expect(p.log.some((l) => l.includes("suit up: seat 2") && l.includes("fallback-invalid"))).toBe(true);
    const rep = computeReport([p.eval]);
    const lk = rep.looks as Exclude<typeof rep.looks, "n/a" | undefined>;
    expect(lk).toMatchObject({ asked: 3, ok: 2, fallbacks: { invalid: 1 }, variety: { choices: 2, names: 2, shapes: 2, marks: 2 } });
    expect(lk.bySoul.brawler).toEqual({ choices: 1, shapes: { barrel: 1 }, marks: { horns: 1 } });
    expect(lk.samples[0]).toContain("brawler (dresser) -> Krak: barrel");
    expect(computeReport([{ ...p.eval, looks: undefined }]).looks).toBe(NA);
    // --suit-up off: the seeded identities, no looks in the report
    const off = await playAiMatch(7, seatsFor(["dresser", "dresser", "dresser", "house"], souls), souls, 400, undefined, { suitUp: false });
    expect(off.match.record.suitUp).toBeUndefined();
  });
});
