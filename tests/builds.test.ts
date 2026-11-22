/**
 * Contract: fighter builds (#79, #83). A build is three attribute levels, health, weight and power, each -2..+2, that
 * add up to 0. Each attribute changes its own part of the body and nothing else (no build changes speed or jump); a
 * build and a power-up multiply within the ruleset's caps; every value that reads max HP reads the fighter's own; a
 * record with builds replays exactly. (Neutral = the old game: the golden hashes in determinism.test.ts.)
 *
 * Hand-built flat levels, inputs by hand or house controllers. No real time, no network, no provider.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { CLASSIC, Fight, Grid, initPhysics, Mat, Match, NO_INPUT, replayFight, replayMatch, resolveRuleset, Sim, validateRuleset, Rng, houseBrain, FightDivergedError, ReplayDivergedError, type Fighter, type Input, type LevelDef, type Strategy } from "../src/sim";
import { BUILD_ATTRIBUTES, buildProblem, fighterStats, LEGAL_BUILDS, NEUTRAL_BUILD, randomBuild, type Build } from "../src/sim/build";
import { kbMult } from "../src/sim/sim-damage";
import { applyInput } from "../src/sim/sim-movement";
import { sanitizeRecord } from "../src/viewer/sanitize";

beforeAll(async () => {
  await initPhysics();
});

const F = CLASSIC.combat.fighter;
const B = CLASSIC.builds;
const P = CLASSIC.pickups.power;
const build = (b: Partial<Build>): Build => ({ ...NEUTRAL_BUILD, ...b });
/** no zone pressure, no drops, no pickups lying about */
const QUIET = resolveRuleset({ pickups: { supply: { firstTick: 36_000 }, armory: { nearSpawn: 0, middle: 0, high: 0, spread: { skyDrops: 0 } } } });

/** A flat bedrock floor (feet at y 0) from -20 to 20, plus solid boxes [x0, x1, y0, y1] of `mat`. */
function level(boxes: [number, number, number, number][] = [], spawns = [-15, -5, 5, 15], mat = Mat.Bedrock): LevelDef {
  const minX = -20, width = 40;
  const grid = new Grid(width * 2, 40, minX, -5);
  const fill = (x0: number, x1: number, y0: number, y1: number, m: Mat) => grid.fillRect(grid.cx(x0), grid.cy(y0), grid.cx(x1 - 0.01), grid.cy(y1 - 0.01), m);
  fill(-20, 20, -5, 0, Mat.Bedrock);
  for (const [x0, x1, y0, y1] of boxes) fill(x0, x1, y0, y1, mat);
  return {
    seed: 0, attempt: 0, theme: "warehouse", name: "test", width, minX, maxX: minX + width, grid, props: [],
    spawns: spawns.map((x) => ({ x, y: 0 })), pits: [], zoneCenter: 0, platforms: 0, towers: 0, bridges: 0,
  };
}

/** A sandbox sim: seat 0 plays `mine` (at -16, room to run right), seat 1 `theirs` (at 12), the rest neutral; still, inputs by hand. */
function sandbox(mine: Build, theirs: Build = NEUTRAL_BUILD) {
  const sim = new Sim(1, level(), undefined, QUIET, [mine, theirs]);
  sim.zoneEnabled = false;
  for (const it of sim.items()) sim.entityStore.remove(it);
  const inputs: Input[] = [NO_INPUT, NO_INPUT, NO_INPUT, NO_INPUT];
  const step = (n = 1) => {
    for (let i = 0; i < n; i++) sim.step(inputs);
  };
  sim.fighters.forEach((f, i) => {
    f.entity.body.setTranslation({ x: [-16, 12, 15, 18][i]!, y: F.halfHeight + F.radius + 0.02 }, true);
    f.entity.body.setLinvel({ x: 0, y: 0 }, true);
  });
  step(30); // settle: everyone grounded
  const [me, other] = sim.fighters as [Fighter, Fighter];
  return { sim, inputs, step, me, other };
}

/** What a body does, measured in the sim. */
function measure(b: Build) {
  const out: Record<string, number> = {};
  {
    const { sim, inputs, step, me } = sandbox(b);
    out.maxHp = me.maxHp;
    out.startHp = me.hp;
    out.mass = me.entity.body.mass();
    inputs[0] = { ...NO_INPUT, move: 1 };
    step(90);
    // the speed the body is driven at, once at speed: one more input sets it exactly (before contact and damping)
    applyInput(sim, me, inputs[0]);
    out.topSpeed = sim.vel(me).x;
  }
  {
    const { sim, inputs, step, me } = sandbox(b);
    const y0 = sim.feetY(me);
    inputs[0] = { ...NO_INPUT, jump: true };
    step(1);
    inputs[0] = NO_INPUT;
    let apex = 0;
    for (let i = 0; i < 90; i++) {
      step(1);
      apex = Math.max(apex, sim.feetY(me) - y0);
    }
    out.apex = apex;
  }
  {
    // the same knock taken from a neutral rival at full HP: how hard it launches me (velocity before physics runs)
    const { sim, me, other } = sandbox(b);
    sim.damageFighter(me, 0, other.id, 6, 6, "bat", 0, 0);
    out.launch = sim.vel(me).y;
    sim.damageFighter(me, 10, other.id, 0, 0, "bat", 0, 0);
    out.hpTaken = me.maxHp - me.hp;
  }
  {
    // the same hit dealt to a neutral rival
    const { sim, me, other } = sandbox(b);
    sim.damageFighter(other, 10, me.id, 6, 6, "bat", 0, 0);
    out.dealtDamage = other.maxHp - other.hp;
    out.dealtLaunch = sim.vel(other).y;
  }
  return out;
}

/** The measurements each attribute may change. */
const EFFECT: Record<keyof Build, string[]> = {
  health: ["maxHp", "startHp"],
  weight: ["launch", "mass"],
  power: ["dealtDamage", "dealtLaunch"],
};

describe("builds", () => {
  test("the build rules: health, weight and power, each -2..+2, add up to 0; neutral is legal", () => {
    expect(buildProblem(NEUTRAL_BUILD)).toBeNull();
    expect(buildProblem(build({ health: 2, weight: -1, power: -1 }))).toBeNull();
    expect(buildProblem(build({ health: -2, power: 2 }))).toBeNull();
    expect(buildProblem(build({ health: 1 }))).toMatch(/add up to \+1/);
    expect(buildProblem(build({ weight: -1 }))).toMatch(/add up to -1/);
    expect(buildProblem(build({ health: 3, power: -3 }))).toMatch(/health must be from -2 to 2/);
    expect(buildProblem(build({ weight: 0.5, power: -0.5 }))).toMatch(/whole number/);
    expect(buildProblem({ ...NEUTRAL_BUILD, luck: 0 })).toMatch(/unknown attribute "luck"/);
    expect(buildProblem({ ...NEUTRAL_BUILD, speed: 0 })).toMatch(/unknown attribute "speed"/);
    expect(buildProblem({ health: 0, weight: 0 })).toMatch(/power must be a whole number/);
    expect(buildProblem([0, 0, 0])).toMatch(/object with health, weight and power/);
    // the list of legal builds is exactly the legal ones (counted by brute force over every level combination)
    let n = 0;
    for (let h = -3; h <= 3; h++) for (let w = -3; w <= 3; w++) for (let p = -3; p <= 3; p++)
      if (buildProblem({ health: h, weight: w, power: p }) === null) n++;
    expect(n).toBe(19);
    expect(LEGAL_BUILDS.length).toBe(n);
    expect(LEGAL_BUILDS.every((b) => buildProblem(b) === null)).toBe(true);
    // the sim refuses an illegal build instead of playing something else
    expect(() => new Fight(1, [0, 1, 2, 3].map(() => ({ target: "nearest", stance: "rush", weapons: ["bat"], line: "", build: build({ health: 2 }) })), { level: level(), ruleset: QUIET })).toThrow(/illegal build/);
  });

  test("each attribute changes what it should and only that (max HP, knockback taken, damage dealt; never speed or jump)", () => {
    const neutral = measure(NEUTRAL_BUILD);
    // every attribute up and down, each paid for by others; the changed measurements must be exactly those of the
    // attributes whose level is not 0
    const builds: Build[] = [
      build({ health: 2, power: -2 }),
      build({ health: -2, weight: 2 }),
      build({ weight: 2, health: -1, power: -1 }),
      build({ power: 2, weight: -1, health: -1 }),
    ];
    for (const b of builds) {
      const m = measure(b);
      const allowed = new Set(BUILD_ATTRIBUTES.filter((a) => b[a] !== 0).flatMap((a) => EFFECT[a]));
      for (const key of Object.keys(neutral)) {
        if (allowed.has(key)) expect({ build: b, key, changed: Math.abs(m[key]! - neutral[key]!) > 1e-6 }).toEqual({ build: b, key, changed: true });
        else expect({ build: b, key, value: m[key] }).toEqual({ build: b, key, value: neutral[key] });
      }
    }
    // and by the table: the direction and size of each change
    const tank = measure(build({ health: 2, power: -2 }));
    expect(tank.maxHp).toBe(F.maxHp + B.health.hpBonus[4]!);
    expect(tank.dealtDamage).toBeCloseTo(neutral.dealtDamage! * B.power.mul[0]!, 9);
    expect(neutral.topSpeed).toBeCloseTo(F.walkSpeed, 5);
    const heavy = measure(build({ weight: 2, health: -1, power: -1 }));
    expect(heavy.mass / neutral.mass!).toBeCloseTo(B.weight.density[4]!, 6);
    expect(heavy.launch).toBeLessThan(neutral.launch!);
    expect(measure(build({ power: 2, weight: -1, health: -1 })).dealtDamage).toBeCloseTo(neutral.dealtDamage! * B.power.mul[4]!, 9);
  });

  test("the stats table: one attribute's level moves only its own stats", () => {
    const base = fighterStats(CLASSIC, NEUTRAL_BUILD);
    expect(base).toEqual({ maxHp: F.maxHp, knockback: 1, density: CLASSIC.combat.density, power: 1 });
    const owns: Record<keyof Build, (keyof typeof base)[]> = { health: ["maxHp"], weight: ["knockback", "density"], power: ["power"] };
    for (const a of BUILD_ATTRIBUTES) {
      for (const level of [-2, -1, 1, 2]) {
        const s = fighterStats(CLASSIC, build({ [a]: level }));
        const moved = (Object.keys(base) as (keyof typeof base)[]).filter((k) => s[k] !== base[k]);
        expect({ a, level, moved }).toEqual({ a, level, moved: owns[a] });
      }
    }
  });

  test("kbMult, healing and health rules use the fighter's own max HP", () => {
    // knockback grows with the missing share of the fighter's own max: 65 of 130 is half missing, 65 of 100 is 35%
    expect(kbMult({ hp: 65, maxHp: 130 }, CLASSIC)).toBeCloseTo(1 + 0.5 * F.kbGrowth, 12);
    expect(kbMult({ hp: 65, maxHp: 100 }, CLASSIC)).toBeCloseTo(1 + 0.35 * F.kbGrowth, 12);
    const HI = F.maxHp + B.health.hpBonus[4]!, LO = F.maxHp + B.health.hpBonus[0]!;
    // and damageFighter launches by it: the same hit at the same HP launches the tank harder than a neutral body
    {
      const a = sandbox(build({ health: 2, power: -2 }));
      const n = sandbox(NEUTRAL_BUILD);
      a.me.hp = n.me.hp = 65;
      a.sim.damageFighter(a.me, 0.001, a.other.id, 0, 6, "bat", 0, 0);
      n.sim.damageFighter(n.me, 0.001, n.other.id, 0, 6, "bat", 0, 0);
      expect(a.sim.vel(a.me).y / n.sim.vel(n.me).y).toBeCloseTo(kbMult({ hp: 65, maxHp: HI }, CLASSIC) / kbMult({ hp: 65, maxHp: F.maxHp }, CLASSIC), 3);
    }
    // a health pickup heals up to the fighter's own max
    const { sim, me, other } = sandbox(build({ health: 2, power: -2 }), build({ health: -2, power: 2 }));
    me.hp = HI - 10;
    sim.applyItem(me, "health");
    expect(me.hp).toBe(HI);
    other.hp = LO - 10;
    sim.applyItem(other, "health");
    expect(other.hp).toBe(LO);
    // my_health_below and health_below: percent of the fighter's own max. Between half the base max and half the
    // tank's, the tank is below 50% and a base body is not; between half the low max and half the base, the low body is
    // not below 50% and a base body is
    const tankHp = Math.floor(HI / 2) - 1, lowHp = Math.ceil(LO / 2) + 1;
    expect(tankHp >= F.maxHp / 2 && lowHp < F.maxHp / 2).toBe(true);
    const plans: Strategy[] = [0, 1, 2, 3].map(() => ({ target: "nearest", stance: "hold", weapons: ["bat"], line: "" }));
    plans[0] = { ...plans[0]!, build: build({ health: 2, power: -2 }), rules: [{ when: "my_health_below", value: 50, do: "seek", doItem: "health", label: "" }] };
    plans[1] = { ...plans[1]!, build: build({ health: -2, power: 2 }), rules: [{ when: "my_health_below", value: 50, do: "seek", doItem: "health", label: "" }] };
    plans[2] = { ...plans[2]!, rules: [{ when: "health_below", who: 0, value: 50, do: "target", label: "" }] };
    plans[3] = { ...plans[3]!, rules: [{ when: "health_below", who: 1, value: 50, do: "target", label: "" }] };
    const f = new Fight(1, plans, { level: level(), ruleset: QUIET });
    const s = f.sim;
    s.fighters[0]!.hp = tankHp;
    s.fighters[1]!.hp = lowHp;
    f.controllers.forEach((c, i) => c.rules.evaluate(s, c, s.fighters[i]!));
    expect(f.controllers.map((c) => c.rules.state[0]!.active)).toEqual([true, false, true, false]);
  });

  test("a build and a power-up stack within the caps: Heavy and Damage; Speed and Jump do not depend on the build", () => {
    const caps = B.caps;
    // Speed: the power-up's own mul, whatever the build
    const topSpeed = (b: Build) => {
      const { sim, inputs, step, me } = sandbox(b);
      sim.applyItem(me, "speed");
      inputs[0] = { ...NO_INPUT, move: 1 };
      step(90);
      applyInput(sim, me, inputs[0]);
      return sim.vel(me).x;
    };
    expect(topSpeed(NEUTRAL_BUILD)).toBeCloseTo(F.walkSpeed * P.speed.mul, 5);
    expect(topSpeed(build({ weight: 2, power: -2 }))).toBeCloseTo(F.walkSpeed * P.speed.mul, 5);

    // Heavy: knockback taken never below caps.knockbackTaken, density never above caps.density
    const heavyHit = (b: Build) => {
      const { sim, me, other } = sandbox(b);
      const mass = me.entity.body.mass();
      sim.applyItem(me, "heavy");
      sim.step([NO_INPUT, NO_INPUT, NO_INPUT, NO_INPUT]);
      const heavyMass = me.entity.body.mass();
      me.hp = me.maxHp;
      me.entity.body.setLinvel({ x: 0, y: 0 }, true);
      sim.damageFighter(me, 0.001, other.id, 0, 6, "bat", 0, 0);
      return { launch: sim.vel(me).y, density: heavyMass / mass * (me.stats.density / CLASSIC.combat.density) };
    };
    const kb = kbMult({ hp: 100, maxHp: 100 }, CLASSIC) * 6;
    const tank = heavyHit(build({ weight: 2, power: -2 }));
    expect(tank.launch).toBeCloseTo(kb * caps.knockbackTaken, 3);
    expect(B.weight.knockback[4]! * P.heavy.kbMul).toBeLessThan(caps.knockbackTaken);
    expect(tank.density).toBeCloseTo(caps.density, 6);
    const plain = heavyHit(NEUTRAL_BUILD);
    expect(plain.launch).toBeCloseTo(kb * P.heavy.kbMul, 3);
    expect(plain.density).toBeCloseTo(P.heavy.densityMul, 6);

    // Jump: the power-up's air jump is 0.95 of the base jump, whatever the build
    const airJump = (b: Build) => {
      const { sim, inputs, step, me } = sandbox(b);
      sim.applyItem(me, "jump");
      inputs[0] = { ...NO_INPUT, jump: true };
      step(1);
      inputs[0] = NO_INPUT;
      step(20); // in the air, rising slower
      expect(me.grounded).toBe(false);
      applyInput(sim, me, { ...NO_INPUT, jump: true });
      return sim.vel(me).y;
    };
    expect(airJump(NEUTRAL_BUILD)).toBeCloseTo(F.jumpSpeed * 0.95, 5);
    expect(airJump(build({ weight: -2, health: 2 }))).toBeCloseTo(F.jumpSpeed * 0.95, 5);

    // Damage: power x the power-up, within caps.damage and caps.knockbackDealt
    const dealt = (b: Build) => {
      const { sim, me, other } = sandbox(b);
      sim.applyItem(me, "damage");
      sim.damageFighter(other, 10, me.id, 0, 6, "bat", 0, 0);
      return { damage: other.maxHp - other.hp, launch: sim.vel(other).y };
    };
    const strong = dealt(build({ power: 2, health: -2 }));
    expect(strong.damage).toBeCloseTo(10 * caps.damage, 9);
    expect(B.power.mul[4]! * P.damage.mul).toBeGreaterThan(caps.damage);
    const normal = dealt(NEUTRAL_BUILD);
    expect(normal.damage).toBeCloseTo(10 * P.damage.mul, 9);
    // the knockback is applied at the target's HP after the hit: compare each against its own kbMult
    expect(strong.launch / kbMult({ hp: 100 - 10 * caps.damage, maxHp: 100 }, CLASSIC)).toBeCloseTo(6 * caps.knockbackDealt, 3);
    expect(normal.launch / kbMult({ hp: 100 - 10 * P.damage.mul, maxHp: 100 }, CLASSIC)).toBeCloseTo(6 * P.damage.kbMul, 3);
  });

  test("a record with builds replays to the same hash; without its builds it does not", () => {
    const plans: Strategy[] = [
      { target: "weakest", stance: "rush", weapons: ["rocket", "bat"], line: "", build: build({ health: -2, weight: 1, power: 1 }) },
      { target: "nearest", stance: "distance", weapons: ["shotgun"], line: "", build: build({ weight: 2, power: -2 }) },
      { target: "nearest", stance: "cover", weapons: ["grenade", "rifle"], line: "", build: build({ power: 2, health: -1, weight: -1 }) },
      { target: "leader", stance: "item", weapons: ["bat"], line: "" },
    ];
    const f = new Fight(1001, plans);
    f.playToEnd();
    const rec = JSON.parse(JSON.stringify(f.record));
    expect(rec.strategies[0].build).toEqual(plans[0]!.build);
    expect(replayFight(rec).finalHash).toBe(f.record.finalHash);
    expect(() => replayFight({ ...rec, strategies: rec.strategies.map(({ build: _b, ...s }: Strategy) => s) })).toThrow(FightDivergedError);

    // a match with random builds, through the viewer's record sanitizer (record files are untrusted input)
    const rng = new Rng(5);
    const m = new Match(3, { brains: [0, 1, 2, 3].map(() => (ctx) => { const d = houseBrain(ctx); return { ...d, strategy: { ...d.strategy, build: randomBuild(rng) } }; }) });
    m.playToEnd();
    const mrec = sanitizeRecord(JSON.parse(JSON.stringify(m.record)))!;
    expect(mrec.rounds[0]!.strategies.map((s) => s.build)).toEqual(m.record.rounds[0]!.strategies.map((s) => s.build));
    expect(replayMatch(mrec).record.rounds.map((r) => r.fight.finalHash)).toEqual(m.record.rounds.map((r) => r.fight.finalHash));
    const stripped = sanitizeRecord(JSON.parse(JSON.stringify(m.record)))!;
    stripped.rounds[0]!.strategies = stripped.rounds[0]!.strategies.map(({ build: _b, ...s }) => s);
    expect(() => replayMatch(stripped)).toThrow(ReplayDivergedError);
  });

  test("random builds for batches: legal, and the same for the same seed", () => {
    const draw = (seed: number) => {
      const r = new Rng(seed);
      return Array.from({ length: 200 }, () => randomBuild(r));
    };
    const a = draw(9);
    expect(a.every((b) => buildProblem(b) === null)).toBe(true);
    expect(draw(9)).toEqual(a);
    expect(draw(10)).not.toEqual(a);
    // every level of every attribute shows up
    for (const at of BUILD_ATTRIBUTES) expect(new Set(a.map((b) => b[at])).size).toBe(5);
  });

  test("the ruleset keeps neutral the old game (level 0 is the base, no cap binds a neutral build) and levels in order", () => {
    expect(() => validateRuleset({ builds: { power: { mul: [0.8, 0.9, 1.05, 1.1, 1.2] } } })).toThrow(/level 0 must be the base/);
    expect(() => validateRuleset({ builds: { health: { hpBonus: [-30, -15, 5, 15, 30] } } })).toThrow(/level 0 must be the base/);
    expect(() => validateRuleset({ builds: { caps: { density: 1.2 } } })).toThrow(/builds.caps/);
    expect(() => validateRuleset({ builds: { caps: { knockbackTaken: 0.6 } } })).toThrow(/builds.caps/);
    expect(() => validateRuleset({ builds: { caps: { damage: 1.5 } } })).toThrow(/builds.caps/);
    expect(() => validateRuleset({ builds: { health: { hpBonus: [-100, -15, 0, 15, 30] } } })).toThrow(/positive max HP/);
    // a level up is never less of its attribute
    expect(() => validateRuleset({ builds: { power: { mul: [0.9, 0.8, 1, 1.1, 1.2] } } })).toThrow(/level up/);
    expect(() => validateRuleset({ builds: { weight: { knockback: [1.3, 1.15, 1, 1.1, 0.75] } } })).toThrow(/level up/);
    expect(() => validateRuleset({ builds: { health: { hpBonus: [-16, -8, 0, 16, 8] } } })).toThrow(/level up/);
    // a preset can tune the values (and turn builds off by setting every level to the base)
    const off = validateRuleset({ builds: { health: { hpBonus: [0, 0, 0, 0, 0] }, weight: { knockback: [1, 1, 1, 1, 1], density: [1, 1, 1, 1, 1] }, power: { mul: [1, 1, 1, 1, 1] } } });
    expect(fighterStats(off, build({ health: 2, weight: -1, power: -1 }))).toEqual(fighterStats(off, NEUTRAL_BUILD));
  });
});
