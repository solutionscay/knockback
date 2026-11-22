/**
 * #81: viewers show builds. Contracts: every legal build has one shape name, shared with the agents' examples; the
 * chip gives the levels back exactly; the dialogue card and the HUD chip show the build the fighter plays; the health
 * bar's length follows max HP; untrusted builds (records, the live stream) reach the viewer only when legal.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { houseBrain, initPhysics, Match } from "../src/sim";
import { BUILD_ATTRIBUTES, BUILD_EXAMPLES, BUILD_SHAPES, BUILD_SHORT, buildChipText, buildLevels, buildShape, buildUp, LEGAL_BUILDS, NEUTRAL_BUILD, type Build } from "../src/sim/build";
import { BUILD_COLOR, buildGlow, hpBarWidth, hpTickStep } from "../src/viewer/build-view";
import { dialogueHtml } from "../src/viewer/game-hud";
import { GamePlans } from "../src/viewer/game-plans";
import { sanitizeDecision, sanitizePlanUpdates, sanitizeRecord, sanitizeSoul } from "../src/viewer/sanitize";

beforeAll(async () => {
  await initPhysics();
});

const TANK: Build = { health: 2, weight: 0, power: -2 };
const GLASS: Build = { health: -2, weight: 0, power: 2 };
const SCRAPPER: Build = { health: 1, weight: -2, power: 1 };

/** A match whose seats play these builds, with round 1 prepared (its fight is the one the viewer shows); not for playToEnd. */
function matchWith(builds: Build[], seed = 7) {
  const m = new Match(seed, { brains: builds.map((b) => (ctx) => { const d = houseBrain(ctx); return { ...d, strategy: { ...d.strategy, build: b } }; }) });
  const decisions = m.prepareRound();
  return { m, decisions };
}

/** Read a chip's levels back: "HP +2 · WGT 0 · PWR −2" -> the build. */
function readLevels(text: string): Build {
  const out: Record<string, number> = {};
  for (const part of text.split(" · ")) {
    const [label, value] = part.split(" ");
    const attr = BUILD_ATTRIBUTES.find((a) => BUILD_SHORT[a] === label);
    if (!attr) throw new Error(`unknown label in ${text}`);
    out[attr] = Number(value!.replace("−", "-"));
  }
  return out as unknown as Build;
}

describe("shape names", () => {
  test("every legal build has exactly one shape name, given by the attributes it raises; every name is used", () => {
    const used = new Set<string>();
    for (const b of LEGAL_BUILDS) {
      const name = buildShape(b);
      const matches = BUILD_SHAPES.filter((s) => s.up.length === buildUp(b).length && s.up.every((a) => b[a] > 0));
      expect(matches.map((s) => s.name)).toEqual([name]);
      used.add(name);
    }
    expect([...used].sort()).toEqual(BUILD_SHAPES.map((s) => s.name).sort());
    // BALANCED is neutral and nothing else
    expect(LEGAL_BUILDS.filter((b) => buildShape(b) === "BALANCED")).toEqual([NEUTRAL_BUILD]);
  });

  test("the agents' example builds carry their shape's name (agents and viewers name builds the same)", () => {
    for (const e of BUILD_EXAMPLES) expect(e.name.toUpperCase()).toBe(buildShape(e.build));
  });
});

describe("chips", () => {
  test("a chip's levels read back as the build, for every legal build; neutral is BALANCED, not three zeros", () => {
    const chips = new Set<string>();
    for (const b of LEGAL_BUILDS) {
      const text = buildLevels(b);
      chips.add(buildChipText(b));
      if (buildUp(b).length === 0) {
        expect(text).toBe("BALANCED");
        expect(buildChipText(b)).toBe("BALANCED");
        continue;
      }
      expect(readLevels(text)).toEqual(b);
      expect(buildChipText(b).startsWith(`${buildShape(b)} · `)).toBe(true);
    }
    expect(chips.size).toBe(LEGAL_BUILDS.length);
  });

  test("the dialogue card shows the build its fighter plays: shape name and every level", () => {
    const builds = [TANK, GLASS, NEUTRAL_BUILD, SCRAPPER];
    const { m, decisions } = matchWith(builds);
    builds.forEach((b, i) => {
      const html = dialogueHtml(m, decisions[i]!, null, { kind: "dialogue", fighter: i, phase: "intro", round: 1, duration: 2 });
      const chip = html.match(/<b class="bld">(.*?)<\/b>/)?.[1];
      expect(chip).toBeDefined();
      const text = chip!.replace(/<i>·<\/i>/g, " · ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (buildUp(b).length === 0) expect(text).toBe("BALANCED");
      else expect(text).toBe(`${buildShape(b)} ${buildLevels(b)}`);
    });
  });

  test("the HUD chip names the build each fighter plays in the shown fight", () => {
    const builds = [GLASS, TANK, SCRAPPER, NEUTRAL_BUILD];
    const { m, decisions } = matchWith(builds);
    const lineup = { innerHTML: "", className: "" } as unknown as HTMLElement;
    new GamePlans().startLineup(lineup, m.fight!, decisions);
    const chips = lineup.innerHTML.split('<div class="chip"').slice(1);
    expect(chips.length).toBe(4);
    chips.forEach((c, i) => expect(c.match(/<em class="bld"[^>]*>([^<]*)<\/em>/)?.[1]).toBe(buildShape(builds[i]!)));
  });

  test("the body cue: none for neutral, one layer per raised attribute in that attribute's chip color", () => {
    for (const b of LEGAL_BUILDS) expect(buildGlow(b).map((g) => g.color)).toEqual(buildUp(b).map((a) => BUILD_COLOR[a]));
  });
});

describe("health bars", () => {
  test("a bar's length follows the fighter's max HP: neutral is the base length, a tank's is longer, a glass cannon's shorter", () => {
    const builds = [TANK, NEUTRAL_BUILD, GLASS, SCRAPPER];
    const { m } = matchWith(builds);
    const base = m.ruleset.combat.fighter.maxHp;
    const [tank, neutral, glass, scrapper] = m.fight!.sim.fighters.map((f) => hpBarWidth(f.maxHp, base, 92));
    expect(neutral).toBe(92);
    expect(tank!).toBeGreaterThan(scrapper!);
    expect(scrapper!).toBeGreaterThan(neutral!);
    expect(neutral!).toBeGreaterThan(glass!);
    for (const f of m.fight!.sim.fighters) expect(hpBarWidth(f.maxHp, base, 92) / 92).toBeCloseTo(f.maxHp / base, 9);
  });
});

describe("health bars from untrusted rulesets", () => {
  test("a record's huge or tiny max HP cannot make a bar endless or its ticks countless", () => {
    for (const maxHp of [1, 1e6, 1e12]) {
      const w = hpBarWidth(maxHp, 100, 92);
      expect(w).toBeGreaterThanOrEqual(46);
      expect(w).toBeLessThanOrEqual(184);
      expect(Math.floor(maxHp / hpTickStep(maxHp))).toBeLessThanOrEqual(8);
    }
  });
});

describe("sanitizing builds (records and the live stream are untrusted)", () => {
  const BAD: unknown[] = [
    { health: 3, weight: -1, power: -2 }, // out of range
    { health: 1, weight: 0, power: 0 }, // does not add up to 0
    { health: 0.5, weight: -0.5, power: 0 }, // not whole numbers
    { health: "1", weight: -1, power: 0 }, // a string
    { health: 1, weight: -1, power: 0, speed: 0 }, // a key that is not an attribute
    { health: 1, weight: -1 }, // a missing attribute
    [1, -1, 0],
    null,
    "tank",
  ];

  test("a decision (record round or live decisions event) keeps a legal build exactly and drops any other", () => {
    for (const b of LEGAL_BUILDS) expect(sanitizeDecision({ strategy: { build: { ...b } } }, 0).strategy.build).toEqual({ ...b });
    for (const b of BAD) expect(sanitizeDecision({ strategy: { build: b } }, 0).strategy.build).toBeUndefined();
  });

  test("plan updates and souls: an illegal build never comes through", () => {
    for (const b of BAD) {
      const ups = sanitizePlanUpdates([{ fighter: 1, tick: 30, strategy: { build: b } }]);
      expect(ups[0]!.strategy.build).toBeUndefined();
      expect(sanitizeSoul({ build: b }, 0).build).toEqual({ ...NEUTRAL_BUILD });
    }
    expect(sanitizeSoul({ build: SCRAPPER }, 0).build).toEqual(SCRAPPER);
  });

  test("a record: no illegal build is left anywhere in it, in the round's strategies or the fight's copy", () => {
    const builds = [TANK, GLASS, SCRAPPER, NEUTRAL_BUILD];
    const m = new Match(7, { brains: builds.map((b) => (ctx) => { const d = houseBrain(ctx); return { ...d, strategy: { ...d.strategy, build: b } }; }) });
    m.playToEnd();
    const raw = JSON.parse(JSON.stringify(m.record));
    const kept = sanitizeRecord(JSON.parse(JSON.stringify(raw)))!;
    expect(kept.rounds[0]!.strategies.map((s) => s.build)).toEqual([TANK, GLASS, SCRAPPER, NEUTRAL_BUILD]);
    raw.rounds[0].strategies[1].build = BAD[1];
    raw.rounds[0].fight.strategies[2].build = BAD[0];
    const rec = sanitizeRecord(raw)!;
    expect(rec.rounds[0]!.strategies[1]!.build).toBeUndefined();
    for (const rd of rec.rounds) for (const s of [...rd.strategies, ...rd.fight.strategies]) if (s.build !== undefined) expect(LEGAL_BUILDS).toContainEqual(s.build);
  });
});
