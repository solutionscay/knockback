/**
 * Contract: the weapon economy (#95). One weapon slot plus fists: a pickup drops the carried weapon, which keeps its
 * ammo. Every weapon runs out (the bat counts hits on fighters, the flamethrower its fuel); empty, it is thrown away.
 * A fighter can drop its weapon on purpose. New weapons land apart from loose weapons and fighters. Plans can swap to
 * fists, drop, and react to their ammo.
 *
 * Hand-built flat level, inputs by hand. No real time, no network, no provider.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { CLASSIC, exampleSouls, Grid, initPhysics, Mat, Match, NO_INPUT, resolveRuleset, Sim, type Fighter, type Input, type LevelDef, type SimEvent } from "../src/sim";
import { parseRules } from "../src/ai/parse";
import { checkRule } from "../src/sim/rules";
import { RuleEngine } from "../src/sim/ruleeval";
import { isPickupWeapon } from "../src/sim/sim-types";
import { looseWeapons, weaponSpot } from "../src/sim/weapon-spots";

beforeAll(async () => {
  await initPhysics();
});

const RULESET = resolveRuleset({ pickups: { supply: { firstTick: 36_000 } } });
const T = RULESET.weapons.table;

/** A flat bedrock floor (feet at y 0) from -30 to 30. */
function level(): LevelDef {
  const minX = -30, width = 60;
  const grid = new Grid(width * 2, 40, minX, -5);
  grid.fillRect(grid.cx(-30), grid.cy(-5), grid.cx(29.99), grid.cy(-0.01), Mat.Bedrock);
  return {
    seed: 0, attempt: 0, theme: "warehouse", name: "test", width, minX, maxX: minX + width, grid, props: [],
    spawns: [-18, -6, 6, 18].map((x) => ({ x, y: 0 })), pits: [], zoneCenter: 0, platforms: 0, towers: 0, bridges: 0,
  };
}

function sandbox() {
  const sim = new Sim(1, level(), undefined, RULESET);
  sim.zoneEnabled = false;
  for (const it of sim.items()) sim.entityStore.remove(it);
  const events: SimEvent[] = [];
  const inputs: Input[] = [NO_INPUT, NO_INPUT, NO_INPUT, NO_INPUT];
  const step = (n = 1) => {
    for (let i = 0; i < n; i++) {
      sim.step(inputs);
      events.push(...sim.events);
      sim.events = [];
    }
  };
  const place = (f: Fighter, x: number) => {
    f.entity.body.setTranslation({ x, y: RULESET.combat.fighter.halfHeight + RULESET.combat.fighter.radius + 0.02 }, true);
    f.entity.body.setLinvel({ x: 0, y: 0 }, true);
  };
  const [a, b, c, d] = sim.fighters as [Fighter, Fighter, Fighter, Fighter];
  place(a, -10);
  place(b, -8.6);
  place(c, 10);
  place(d, 20);
  step(30);
  /** f pulls the trigger once with what it holds (or `weapon`), aiming along x */
  const fire = (f: Fighter, dir = 1, weapon: Input["weapon"] = null) => {
    inputs[f.id] = { ...NO_INPUT, aimX: dir, aimY: 0, weapon, fire: true };
    step();
    inputs[f.id] = NO_INPUT;
  };
  const items = () => sim.items().filter((e) => isPickupWeapon(e.itemType));
  return { sim, events, inputs, step, place, fire, items, a, b, c, d };
}

describe("one weapon slot plus fists", () => {
  test("a pickup drops the carried weapon, which keeps its ammo and gives it back", () => {
    const s = sandbox();
    s.sim.applyItem(s.a, "rocket");
    expect(s.a.weapons).toEqual(["fist", "rocket"]);
    expect(s.a.ammo.rocket).toBe(T.rocket.ammo);
    s.step(RULESET.combat.swapTicks + 1);
    s.fire(s.a, -1);
    expect(s.a.ammo.rocket).toBe(T.rocket.ammo - 1);
    s.sim.applyItem(s.a, "shotgun");
    expect(s.a.weapons).toEqual(["fist", "shotgun"]);
    const dropped = s.items().find((e) => e.itemType === "rocket")!;
    expect(dropped.ammo).toBe(T.rocket.ammo - 1);
    expect(s.sim.events.concat(s.events).some((e) => e.type === "drop" && e.reason === "swap" && e.weapon === "rocket")).toBe(true);
    // c picks the dropped rocket up with what was left in it
    s.sim.applyItem(s.c, "rocket", dropped.ammo);
    expect(s.c.ammo.rocket).toBe(T.rocket.ammo - 1);
  });

  test("dropping on purpose leaves the weapon on the floor with its ammo; fists in hand", () => {
    const s = sandbox();
    s.place(s.b, 0); // nobody in front to pick it up
    s.sim.applyItem(s.a, "rifle");
    s.a.ammo.rifle = 5;
    s.inputs[s.a.id] = { ...NO_INPUT, drop: true };
    s.step();
    s.inputs[s.a.id] = NO_INPUT;
    expect(s.a.weapons).toEqual(["fist", "fist"]);
    expect(s.sim.weapon(s.a)).toBe("fist");
    expect(s.items().map((e) => [e.itemType, e.ammo])).toEqual([["rifle", 5]]);
  });
});

describe("ammo on every weapon", () => {
  test("every pickup weapon has ammo", () => {
    for (const w of CLASSIC.weapons.enabled.filter(isPickupWeapon)) expect(CLASSIC.weapons.table[w].ammo).toBeGreaterThan(0);
  });

  test("the last round fired throws the weapon away: no item, fists in hand", () => {
    const s = sandbox();
    s.sim.applyItem(s.a, "shotgun");
    s.a.ammo.shotgun = 1;
    s.step(RULESET.combat.swapTicks + 1);
    s.fire(s.a);
    expect(s.a.weapons).toEqual(["fist", "fist"]);
    expect(s.events.some((e) => e.type === "empty" && e.fighter === s.a.id && e.weapon === "shotgun")).toBe(true);
    expect(s.items()).toEqual([]);
  });

  test("the bat spends a hit only when it lands on a fighter", () => {
    const s = sandbox();
    s.sim.applyItem(s.a, "bat");
    s.step(RULESET.combat.swapTicks + 1);
    s.fire(s.a, -1); // at the air
    expect(s.a.ammo.bat).toBe(T.bat.ammo);
    s.step(T.bat.cooldown);
    s.fire(s.a, 1); // b is 1.4 m to the right
    expect(s.events.some((e) => e.type === "hit" && e.target === s.b.id && e.cause === "bat")).toBe(true);
    expect(s.a.ammo.bat).toBe(T.bat.ammo - 1);
  });

  test("the flamethrower burns its fuel; dry, it is thrown away", () => {
    const s = sandbox();
    s.sim.applyItem(s.a, "flamethrower");
    expect(s.a.ammo.flamethrower).toBe(T.flamethrower.ammo);
    s.a.ammo.flamethrower = 2;
    s.step(RULESET.combat.swapTicks + 1);
    s.fire(s.a, -1);
    expect(s.a.ammo.flamethrower).toBe(1);
    s.step(T.flamethrower.cooldown);
    s.fire(s.a, -1);
    expect(s.a.weapons).toEqual(["fist", "fist"]);
    expect(s.events.some((e) => e.type === "fuelOut" && e.fighter === s.a.id)).toBe(true);
  });
});

describe("who wants a weapon", () => {
  test("bare-handed: anything; armed: a weapon it ranks higher; low on ammo: anything with more left", () => {
    const s = sandbox();
    s.sim.setPrefs(s.a.id, ["rocket", "shotgun"]);
    expect(s.sim.wantsWeapon(s.a, "grapple")).toBe(true);
    s.sim.applyItem(s.a, "shotgun");
    expect(s.sim.wantsWeapon(s.a, "rocket")).toBe(true);
    expect(s.sim.wantsWeapon(s.a, "grapple")).toBe(false);
    expect(s.sim.wantsWeapon(s.a, "shotgun")).toBe(false);
    s.a.ammo.shotgun = 1;
    expect(s.sim.wantsWeapon(s.a, "grapple")).toBe(true);
    expect(s.sim.wantsWeapon(s.a, "shotgun")).toBe(true);
    // ...but not a weapon even emptier than its own
    expect(s.sim.wantsWeapon(s.a, "grapple", 0)).toBe(false);
  });
});

describe("where weapons land", () => {
  test("a new weapon keeps its distance from loose weapons and fighters", () => {
    const s = sandbox();
    s.sim.spawnItem("rifle", 0, 0.4);
    const cfg = RULESET.pickups.spots;
    for (let k = 0; k < 6; k++) {
      const p = weaponSpot(s.sim, s.sim.rng)!;
      expect(p).not.toBeNull();
      for (const q of looseWeapons(s.sim)) expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThanOrEqual(cfg.itemGap * cfg.relax ** 5 - 0.01);
      s.sim.spawnItem("shotgun", p.x, p.y + 0.4);
    }
    // the first few keep the full gaps
    const loose = looseWeapons(s.sim).slice(0, 3);
    for (let i = 0; i < loose.length; i++) for (let j = i + 1; j < loose.length; j++) expect(Math.hypot(loose[i]!.x - loose[j]!.x, loose[i]!.y - loose[j]!.y)).toBeGreaterThanOrEqual(cfg.itemGap - 0.01);
    for (const f of s.sim.fighters) for (const q of loose) expect(Math.hypot(s.sim.pos(f).x - q.x, s.sim.pos(f).y - 0.84 - q.y)).toBeGreaterThanOrEqual(cfg.fighterGap - 1);
  });

  test("Classic starts with four weapons, apart, and keeps the floor to a few", () => {
    const souls = exampleSouls();
    for (let seed = 1; seed <= 6; seed++) {
      const m = new Match(seed, { souls, ruleset: { ...CLASSIC, round: { ...CLASSIC.round, maxRounds: 1, winsToTake: 1 } } });
      m.prepareRound();
      const sim = m.fight!.sim;
      const start = looseWeapons(sim);
      expect(start.length).toBe(4);
      for (let i = 0; i < start.length; i++) for (let j = i + 1; j < start.length; j++) expect(Math.hypot(start[i]!.x - start[j]!.x, start[i]!.y - start[j]!.y)).toBeGreaterThan(3);
      let peak = 0;
      while (!m.step()) if (sim.tick % 60 === 0 && sim.suddenDeath < 0) peak = Math.max(peak, looseWeapons(sim).length);
      // the supply cap is 3 in play; dropped and knocked-out fighters' weapons come on top
      expect(peak).toBeLessThanOrEqual(8);
    }
  });
});

describe("plan rules: drop, swap, my_ammo_below", () => {
  const names = ["Ada", "Bo", "Cy", "Di"];
  test("the parser takes them; checks refuse what makes no sense", () => {
    const { rules, problems } = parseRules([
      { when: "my_ammo_below", value: 30, do: "seek", item: "shotgun" },
      { when: "health_below", who: "target", value: 20, do: "swap", item: "fists" },
      { when: "my_ammo_below", value: 15, do: "drop" },
      { when: "alone_with", do: "swap", item: "health" },
    ], 0, names);
    expect(rules.map((r) => [r.when, r.do, r.doItem ?? null])).toEqual([["my_ammo_below", "seek", "shotgun"], ["health_below", "swap", "fist"], ["my_ammo_below", "drop", null]]);
    expect(problems).toHaveLength(1);
    expect(checkRule({ when: "alone_with", do: "drop", doItem: "health", label: "x" }, 0)).toMatch(/drop/);
    expect(checkRule({ when: "my_ammo_below", value: 5, do: "drop", label: "x" }, 0)).toMatch(/out of range/);
  });

  test("my_ammo_below reads the carried weapon (bare-handed counts as empty); a drop rule drops once per start", () => {
    const s = sandbox();
    const engine = new RuleEngine([
      { when: "my_ammo_below", value: 50, do: "drop", label: "ditch" },
      { when: "my_ammo_below", value: 50, do: "swap", doItem: "fist", label: "fists" },
    ]);
    const ctl = { targetId: -1, peers: [], hitBy: () => false } as never;
    s.sim.applyItem(s.a, "rocket");
    engine.evaluate(s.sim, ctl, s.a);
    expect(engine.state[0]!.active).toBe(false);
    s.a.ammo.rocket = 1;
    engine.dirty = true;
    engine.evaluate(s.sim, ctl, s.a);
    expect(engine.state[0]!.active).toBe(true);
    expect(engine.swap()).toBe("fist");
    expect(engine.takeDrop("rocket")).toBe(true);
    expect(engine.takeDrop("rocket")).toBe(false);
  });
});
