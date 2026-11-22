/**
 * Contract: agents choose a build per round (#80). The plan parser takes `build` and refuses an illegal one with the
 * field and the rule; no build is neutral; a ruleset with builds off refuses one. A check-in cannot change the build,
 * and once the round runs a check-in shows each rival's build. The house bot plays its soul's build (neutral with
 * builds off); the autopilot that plays a missed turn plays neutral. The briefing explains builds and reports last
 * round's builds and how the fighter's own build did. Over HTTP a rival's build stays hidden while the others plan,
 * and the report shows every build once the round is played.
 *
 * In-process: the server's handle(), stub providers, fast pace; deadlines far away. No real time, no network, no
 * provider.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCheckinPrompt, checkinStatus, parseCheckin } from "../src/ai/checkin";
import { decideRound, type Seat } from "../src/ai/decide";
import { parseAnswer } from "../src/ai/parse";
import { buildRoundPrompts } from "../src/ai/prompt";
import { MatchServer } from "../src/server/match-server";
import { fixHints } from "../src/server/mcp-schema";
import { exampleSouls, Fight, houseBrain, initPhysics, Match, type Strategy } from "../src/sim";
import { buildProblem, NEUTRAL_BUILD, type Build } from "../src/sim/build";
import { placing } from "../src/sim/roundstats";
import { CLASSIC, resolveRuleset } from "../src/sim/ruleset";
import { parseSoul } from "../src/sim/soul";

beforeAll(async () => {
  await initPhysics();
});

const NAMES = ["Rex", "Moth", "Pike", "Vex"];
const GOOD = { weapons: ["rocket", "bat"], target: "weakest", stance: "rush", line: "Here I come." };
const parse = (o: Record<string, unknown>, ruleset = CLASSIC) => parseAnswer(JSON.stringify(o), 0, NAMES, ruleset);
/** builds off: every table at its level-0 value */
const OFF = resolveRuleset({ builds: { health: { hpBonus: [0, 0, 0, 0, 0] }, weight: { knockback: [1, 1, 1, 1, 1], density: [1, 1, 1, 1, 1] }, power: { mul: [1, 1, 1, 1, 1] } } });
const TANK: Build = { health: 2, weight: -1, power: -1 };

describe("builds in the plan", () => {
  test("a plan's build is played as given; no build is neutral", () => {
    expect(parse({ ...GOOD, build: TANK }).strategy!.build).toEqual(TANK);
    expect(parse(GOOD).strategy!.build).toEqual(NEUTRAL_BUILD);
  });

  const BAD: [what: string, build: unknown, rule: RegExp][] = [
    ["levels that do not add up to 0", { health: 1, weight: 1, power: 0 }, /add up to \+2; they must add up to 0/],
    ["a level out of range", { health: 3, weight: -2, power: -1 }, /health must be from -2 to 2, not 3/],
    ["a level that is not a whole number", { health: 0.5, weight: -0.5, power: 0 }, /health must be a whole number from -2 to 2/],
    ["speed, which is not part of a build", { health: 0, weight: 0, power: 0, speed: 0 }, /unknown attribute "speed"/],
    ["a missing attribute", { health: 1, weight: -1 }, /power must be a whole number/],
    ["a build that is not an object", [1, -1, 0], /object with health, weight and power/],
  ];
  for (const [what, build, rule] of BAD)
    test(`refuses ${what}: the problem names build, the value and the rule, and the fix hint says how to fix it`, () => {
      const p = parse({ ...GOOD, build });
      expect(p.strategy).toBeNull();
      expect(p.problems).toHaveLength(1);
      expect(p.problems[0]!.startsWith(`build ${JSON.stringify(build)}: `)).toBe(true);
      expect(p.problems[0]).toMatch(rule);
      const [hint] = fixHints(p.problems.map((x) => `bad value: ${x}`), NAMES.slice(1));
      expect(hint).toMatch(rule);
      expect(hint).toContain('Fix: {"health":h,"weight":w,"power":p}, each a whole number from -2 to 2, adding up to 0');
    });

  test("with builds off in the ruleset a build is refused; no build is neutral", () => {
    const p = parse({ ...GOOD, build: TANK }, OFF);
    expect(p.strategy).toBeNull();
    expect(p.problems[0]).toContain("builds are off in this match");
    expect(fixHints(p.problems.map((x) => `bad value: ${x}`), [], OFF)).toEqual(["build is not part of this match: leave it out."]);
    expect(parse(GOOD, OFF).strategy!.build).toEqual(NEUTRAL_BUILD);
  });

  test("a check-in cannot change the build; a check-in update keeps the round's build", () => {
    const current: Strategy = { target: "weakest", stance: "rush", weapons: ["bat"], retaliate: "turn", build: TANK, line: "" };
    const refused = parseCheckin(JSON.stringify({ stance: "cover", build: NEUTRAL_BUILD }), 0, NAMES, current);
    expect(refused).toEqual({ kind: "invalid", problems: ["build: your build is fixed for the round; a check-in cannot change it (leave build out)"] });
    const changed = parseCheckin(JSON.stringify({ stance: "cover" }), 0, NAMES, current);
    expect(changed.kind).toBe("update");
    expect(changed.kind === "update" && changed.strategy.build).toEqual(TANK);
  });

  test("once the round runs, a check-in shows each rival's build and the fighter's own", () => {
    const builds: Build[] = [TANK, NEUTRAL_BUILD, { health: -2, weight: 0, power: 2 }, { health: -1, weight: 2, power: -1 }];
    const f = new Fight(3, builds.map((build) => ({ target: "nearest", stance: "rush", weapons: ["bat"], build, line: "" })));
    for (let i = 0; i < 60; i++) f.step();
    const st = checkinStatus(f, 0, NAMES, 1);
    expect(st.you.build).toEqual(TANK);
    expect(st.rivals.map((r) => r.build)).toEqual(builds.slice(1));
    const prompt = buildCheckinPrompt(st);
    expect(prompt).toContain("YOU: ");
    expect(prompt).toContain("build health +2, weight -1, power -1");
    expect(prompt).toContain("Moth ");
    expect(prompt).toContain("(build neutral)");
    expect(prompt).toContain("(build health -2, weight 0, power +2)");
    expect(buildCheckinPrompt(st, undefined, undefined, OFF)).not.toContain("build");
  });
});

describe("house bots and the autopilot", () => {
  test("each bundled soul has its own legal build, and the house bot plays it (neutral with builds off)", () => {
    const souls = exampleSouls();
    const builds = souls.map((s) => s.build);
    expect(builds.every((b) => buildProblem(b) === null && JSON.stringify(b) !== JSON.stringify(NEUTRAL_BUILD))).toBe(true);
    expect(new Set(builds.map((b) => JSON.stringify(b))).size).toBe(4);
    for (const ruleset of [CLASSIC, OFF]) {
      const m = new Match(5, { ruleset });
      const played = m.prepareRound().map((d) => d.strategy.build);
      expect(played).toEqual(ruleset === CLASSIC ? builds : builds.map(() => NEUTRAL_BUILD));
    }
  });

  test("a bad build line in a soul is an error that names it", () => {
    expect(parseSoul("---\nbuild: health +2, weight 0, power -1\n---\nA fighter.").errors).toEqual(["build: the levels add up to +1; they must add up to 0 (each point up is paid by a point down)"]);
    expect(parseSoul("---\nbuild: speed +1, health -1\n---\nA fighter.").errors).toEqual(['build: "speed +1" is not "health|weight|power LEVEL"']);
    expect(parseSoul("---\nbuild: power +1, health -1\n---\nA fighter.").soul.build).toEqual({ health: -1, weight: 0, power: 1 });
  });

  test("a missed turn is played by the autopilot with a neutral build; a house seat plays its soul's build", async () => {
    const souls = exampleSouls();
    const match = new Match(9, { souls });
    const failing: Seat = { providerName: "stub", provider: { label: "stub/down", ask: async () => Promise.reject(new Error("down")), deadlineMs: 600_000 }, soul: souls[0]! };
    const junk: Seat = { providerName: "stub", provider: { label: "stub/junk", ask: async () => "no plan today", deadlineMs: 600_000 }, soul: souls[1]! };
    const house: Seat = { providerName: "house", provider: null, soul: souls[2]! };
    const agent: Seat = { providerName: "stub", provider: { label: "stub/ok", ask: async () => JSON.stringify({ ...GOOD, target: "nearest", build: TANK }), deadlineMs: 600_000 }, soul: souls[3]! };
    const ask = await decideRound(match, [failing, junk, house, agent]);
    expect(ask.meta.map((m) => m.outcome)).toEqual(["fallback-error", "fallback-invalid", "house", "ok"]);
    expect(ask.decisions.map((d) => d.strategy.build)).toEqual([NEUTRAL_BUILD, NEUTRAL_BUILD, souls[2]!.build, TANK]);
    // the autopilot is the house bot's plan with the build taken away, nothing else
    const again = new Match(9, { souls });
    const bot = houseBrain(again.contextFor(0));
    expect({ ...ask.decisions[0]!.strategy, build: bot.strategy.build } as Strategy).toEqual(bot.strategy);
  });
});

describe("the briefing", () => {
  test("explains builds with three examples, and reports last round's builds and how the fighter's own did", () => {
    const souls = exampleSouls();
    const builds: Build[] = [TANK, NEUTRAL_BUILD, { health: -2, weight: 0, power: 2 }, { health: -1, weight: 2, power: -1 }];
    const m = new Match(11, { souls, brains: builds.map((build) => (ctx) => { const d = houseBrain(ctx); return { ...d, strategy: { ...d.strategy, build } }; }) });
    const first = buildRoundPrompts(m, souls, [0, 1, 2, 3].map((i) => m.contextFor(i)));
    expect(first[0]).toContain("BUILD: your fighter's body for the round. health, weight and power, each a whole number from -2 to 2, adding up to 0");
    expect(first[0]).toContain('tank {"health":2,"weight":0,"power":-2}');
    expect(first[0]).toContain('glass cannon {"health":-2,"weight":0,"power":2}');
    expect(first[0]).toContain('anchor {"health":-1,"weight":2,"power":-1}');
    expect(first[0]).toContain('"build":{"health":<n>,"weight":<n>,"power":<n>}');
    expect(first[0]).not.toContain("BUILDS LAST ROUND");
    m.prepareRound();
    const facts = m.finishRound();
    const prompts = buildRoundPrompts(m, souls, [0, 1, 2, 3].map((i) => m.contextFor(i)));
    const n = m.names;
    expect(prompts[1]).toContain(`BUILDS LAST ROUND: ${n[0]} health +2, weight -1, power -1; ${n[1]} (you) neutral; ${n[2]} health -2, weight 0, power +2; ${n[3]} health -1, weight 2, power -1.`.replace("weight 2", "weight +2"));
    const me = facts.fighters[0]!;
    const place = placing(facts).indexOf(0) + 1;
    expect(prompts[0]).toContain(`YOUR BUILD (health +2, weight -1, power -1): place ${place} of 4; you took ${Math.round(me.damageTaken)} damage`);
    expect(prompts[0]).toContain(`you dealt ${Math.round(me.damageDealt)} damage and ${me.kosDealt.length} knockout`);
  });

  test("with builds off the briefing says nothing about builds", () => {
    const m = new Match(11, { ruleset: OFF });
    m.prepareRound();
    m.finishRound();
    const [p] = buildRoundPrompts(m, m.souls, [0, 1, 2, 3].map((i) => m.contextFor(i)));
    expect(p).not.toMatch(/build/i);
  });
});

describe("over HTTP", () => {
  const outDir = mkdtempSync(join(tmpdir(), "kb-builds-"));
  const api = new MatchServer({ outDir, pace: "fast", arena: { deadlineMs: 600_000 } });
  afterAll(() => rmSync(outDir, { recursive: true, force: true }));
  let ip = 0;
  const call = async (method: string, path: string, opts: { auth?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.auth) headers.authorization = `Bearer ${opts.auth}`;
    const res = (await api.handle(new Request(`http://kb.test${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) }), `10.4.0.${++ip}`))!;
    return { status: res.status, data: (await res.json().catch(() => null)) as any };
  };
  const seat = async (owner: string, name: string) => {
    const key = (await call("POST", "/api/keys", { body: { owner } })).data.key as string;
    const soul = "A patient scrapper who waits for the right moment. Talks quietly and never wastes a word in a fight.";
    return (await call("POST", "/api/queue", { auth: key, body: { name, model: "claude-opus-5-5", soul } })).data.token as string;
  };
  const turn = async (token: string) => {
    let t = await call("GET", "/api/arena/turn?wait=30", { auth: token });
    while (t.data.status !== "turn") t = await call("GET", "/api/arena/turn?wait=30", { auth: token });
    return t.data;
  };
  const plan = (round: number, build?: unknown) => ({ round, weapons: ["rocket", "bat"], target: "nearest", stance: "rush", line: "Here.", ...(build !== undefined ? { build } : {}) });

  test("a rival's build stays hidden while the others plan; the report and the next turn show every build", async () => {
    const ada = await seat("Ada", "Basher"), bo = await seat("Bo", "Moth");
    const round = api.arena.playRound();
    const t1 = await turn(ada);
    expect(t1.schema.build.type).toContain("whole numbers from -2 to 2 that add up to 0");
    const bad = await call("POST", "/api/arena/plan", { auth: ada, body: plan(1, { health: 2, weight: 0, power: 0 }) });
    expect(bad.status).toBe(422);
    expect(bad.data.problems).toEqual(['bad value: build {"health":2,"weight":0,"power":0}: the levels add up to +2; they must add up to 0 (each point up is paid by a point down)']);
    const ok = await call("POST", "/api/arena/plan", { auth: ada, body: plan(1, TANK) });
    expect(ok.data.plan.build).toEqual(TANK);
    // Ada's plan is in, Bo still plans: nothing Bo or the public can read names Ada's build
    const hidden = JSON.stringify(TANK).slice(1, -1);
    const boTurn = await turn(bo);
    const m = api.arena.current!;
    for (const view of [boTurn, (await call("GET", `/api/matches/${m.id}/report`)).data, (await call("GET", `/api/matches/${m.id}`)).data, (await call("GET", "/api/queue")).data])
      expect(JSON.stringify(view)).not.toContain(hidden);
    expect((await call("POST", "/api/arena/plan", { auth: bo, body: plan(1) })).status).toBe(200);
    await round;
    const report = (await call("GET", `/api/matches/${m.id}/report`)).data;
    expect(report.rounds[0].plans.map((p: { strategy: Strategy }) => p.strategy.build)).toEqual([TANK, NEUTRAL_BUILD, exampleSouls()[2]!.build, exampleSouls()[3]!.build]);
    // round 2: each turn carries round 1's builds, and how the agent's own build did
    const next = api.arena.playRound();
    const t2 = await turn(ada);
    expect(t2.lastBuilds.fighters.map((f: { build: Build }) => f.build)).toEqual(report.rounds[0].plans.map((p: { strategy: Strategy }) => p.strategy.build));
    expect(t2.lastBuildsNote).toStartWith("Round 1: BUILDS LAST ROUND: ");
    expect(t2.lastBuildsNote).toContain("YOUR BUILD (health +2, weight -1, power -1): place ");
    for (const t of [ada, bo]) await call("POST", "/api/arena/plan", { auth: t, body: plan(2) });
    await next;
  });
});
