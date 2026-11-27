/**
 * Contract: the force field (#40).
 *   stops       shots, rockets, grenades and blasts stop at its edge; fighters walk through and punches land
 *   absorbs     it breaks after `absorb` damage and goes down after `ticks`
 *   one         at most one force field is in play at a time (on the floor, carried or up)
 *   rules       its settings are validated; turned off, it never drops and plans can't name it
 *   replays     a fight in which one goes up replays to the same hash
 *   bots        bots pick it up and deploy it, a "use force field" rule deploys it, and nobody shoots into a field
 *
 * Hand-built levels with no randomness in their layout for the mechanics; generated rounds for the bots.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { checkRule, CLASSIC, enabledItems, Fight, Grid, initPhysics, Mat, NO_INPUT, replayFight, resolveRuleset, RulesetError, validateRuleset, type Input, type LevelDef, type SimEvent, type Strategy } from "../src/sim";
import { fieldInPlay, insideField } from "../src/sim/sim-field";
import { supplyDrop } from "../src/sim/sim-items";
import { knockOut } from "../src/sim/sim-damage";

beforeAll(async () => {
  await initPhysics();
});

/** A bedrock floor across the level (feet at y 0); spawns are [x, y] feet. */
function level(spawns: [number, number][]): LevelDef {
  const minX = -30, width = 60;
  const grid = new Grid(width * 2, 40, minX, -5);
  grid.fillRect(grid.cx(minX), grid.cy(-5), grid.cx(minX + width - 0.01), grid.cy(-0.01), Mat.Bedrock);
  return {
    seed: 0, attempt: 0, theme: "warehouse", name: "test", width, minX, maxX: minX + width, grid, props: [],
    spawns: spawns.map(([x, y]) => ({ x, y })), pits: [], zoneCenter: 0, platforms: 0, towers: 0, bridges: 0,
  };
}

const plan = (s: Partial<Strategy>): Strategy => ({ target: "nearest", stance: "hold", weapons: ["rifle"], line: "", ...s });
const STILL: Input = { ...NO_INPUT };

/**
 * A holder at x 0 with its field up, a shooter at x -10, two bystanders far right; nobody moves unless told. Returns
 * the fight, the four fighters and the field.
 */
function scene(ruleset = CLASSIC) {
  const f = new Fight(1, [0, 1, 2, 3].map(() => plan({})), { level: level([[-10, 0], [0, 0], [24, 0], [27, 0]]), ruleset });
  const sim = f.sim;
  sim.zoneEnabled = false;
  for (const it of sim.items()) sim.entityStore.remove(it);
  const at = (x: number) => sim.fighters.find((o) => Math.abs(sim.pos(o).x - x) < 1)!;
  const shooter = at(-10), holder = at(0);
  for (const c of f.controllers) c.think = () => STILL;
  for (let i = 0; i < 10; i++) f.step();
  sim.applyItem(holder, "forcefield");
  expect(holder.forceField).toBe(1);
  f.controllers[holder.id]!.think = () => ({ ...STILL, field: true });
  f.step();
  f.controllers[holder.id]!.think = () => STILL;
  expect(sim.fields.length).toBe(1);
  return { f, sim, shooter, holder, field: sim.fields[0]! };
}

const events = (f: Fight) => {
  const out: SimEvent[] = [];
  f.onEvent = (e) => out.push(e);
  return out;
};

describe("force field", () => {
  test("stops: a rifle round ends on the edge, the holder is not hit, the field takes the round's damage", () => {
    const { f, sim, shooter, holder, field } = scene();
    const ev = events(f);
    sim.applyItem(shooter, "rifle");
    f.controllers[shooter.id]!.think = () => ({ ...STILL, weapon: "rifle", fire: true, aimX: 1, aimY: 0 });
    for (let i = 0; i < 40; i++) f.step();
    const shots = ev.filter((e) => e.type === "shot");
    expect(shots.length).toBeGreaterThan(0);
    for (const s of shots) if (s.type === "shot") {
      expect(s.hit).toBe("field");
      expect(Math.hypot(s.x1 - field.x, s.y1 - field.y)).toBeCloseTo(field.r, 3);
    }
    expect(holder.hp).toBe(holder.maxHp);
    const hits = ev.filter((e) => e.type === "fieldHit");
    expect(hits.length).toBe(shots.length);
    expect(field.absorbed).toBeCloseTo(shots.length * CLASSIC.weapons.table.rifle.damage, 6);
  });

  test("stops: a rocket bursts on the edge and its blast does not reach the holder", () => {
    const { f, sim, shooter, holder, field } = scene();
    const ev = events(f);
    sim.applyItem(shooter, "rocket");
    f.controllers[shooter.id]!.think = () => ({ ...STILL, weapon: "rocket", fire: true, aimX: 1, aimY: 0 });
    for (let i = 0; i < 90; i++) f.step();
    const booms = ev.filter((e) => e.type === "explosion");
    expect(booms.length).toBeGreaterThan(0);
    const b = booms[0]!;
    if (b.type === "explosion") expect(Math.abs(Math.hypot(b.x - field.x, b.y - field.y) - field.r)).toBeLessThan(0.2);
    expect(holder.hp).toBe(holder.maxHp);
    expect(ev.some((e) => e.type === "fieldHit" && e.cause === "rocket")).toBe(true);
  });

  test("stops: a blast outside the edge hurts nobody inside; the same blast with no field does", () => {
    const spec = CLASSIC.weapons.table.rocket;
    const { sim, shooter, holder, field } = scene();
    const p = sim.pos(holder);
    sim.explode(field.x - field.r - 0.3, p.y, spec, "rocket", shooter.id, 0, null);
    expect(holder.hp).toBe(holder.maxHp);
    expect(field.absorbed).toBe(spec.damage);
    // control: the same blast once the field is gone
    sim.fields = [];
    sim.explode(field.x - field.r - 0.3, p.y, spec, "rocket", shooter.id, 0, null);
    expect(holder.hp).toBeLessThan(holder.maxHp);
  });

  test("stops: a grenade thrown at the field bounces off and never gets inside", () => {
    const { f, sim, shooter, field } = scene();
    sim.applyItem(shooter, "grenade");
    // one throw: it fires once the swap is done
    const thrown = () => [...sim.entities.values()].some((e) => e.kind === "grenade");
    let fired = false;
    f.controllers[shooter.id]!.think = () => (fired || (fired = thrown()) ? STILL : { ...STILL, weapon: "grenade", fire: true, aimX: 0.94, aimY: 0.34 });
    let seen = false;
    for (let i = 0; i < 100; i++) {
      f.step();
      for (const e of sim.entities.values()) if (e.kind === "grenade" && !e.dead) {
        seen = true;
        const t = e.body.translation();
        expect(insideField(field, t.x, t.y)).toBe(false);
      }
    }
    expect(seen).toBe(true);
    expect(field.stopped.length).toBe(1);
  });

  test("walk through: a fighter walks into the field, and a punch across its edge lands", () => {
    const { f, sim, shooter, holder, field } = scene();
    f.controllers[shooter.id]!.think = () => ({ ...STILL, move: 1 });
    let inside = false;
    for (let i = 0; i < 180 && !inside; i++) {
      f.step();
      const p = sim.pos(shooter);
      inside = insideField(field, p.x, p.y);
    }
    expect(inside).toBe(true);
    // the holder punches from inside at a rival standing just outside the edge
    f.controllers[shooter.id]!.think = () => STILL;
    shooter.entity.body.setTranslation({ x: field.x + field.r + 0.15, y: sim.pos(shooter).y }, true);
    holder.entity.body.setTranslation({ x: field.x + field.r - 0.6, y: sim.pos(holder).y }, true);
    for (let i = 0; i < 5; i++) f.step();
    const hp = shooter.hp;
    f.controllers[holder.id]!.think = () => ({ ...STILL, weapon: "fist", fire: true, aimX: 1, aimY: 0 });
    for (let i = 0; i < 30; i++) f.step();
    expect(shooter.hp).toBeLessThan(hp);
  });

  test("absorbs: it breaks once it has taken its damage, and the next blast gets through", () => {
    const spec = CLASSIC.weapons.table.rocket;
    const { f, sim, shooter, holder, field } = scene();
    const ev = events(f);
    const p = sim.pos(holder);
    const n = Math.ceil(CLASSIC.pickups.forceField.absorb / spec.damage);
    for (let i = 0; i < n; i++) sim.explode(field.x - field.r - 0.3, p.y, spec, "rocket", shooter.id, 0, null);
    expect(holder.hp).toBe(holder.maxHp);
    f.step();
    expect(sim.fields.length).toBe(0);
    expect(ev.find((e) => e.type === "fieldDown")).toMatchObject({ reason: "broken" });
    sim.explode(field.x - field.r - 0.3, p.y, spec, "rocket", shooter.id, 0, null);
    expect(holder.hp).toBeLessThan(holder.maxHp);
  });

  test("absorbs: untouched, it goes down after its ticks", () => {
    const { f, sim, field } = scene();
    const ev = events(f);
    const end = field.born + CLASSIC.pickups.forceField.ticks;
    while (sim.tick < end - 1) f.step();
    expect(sim.fields.length).toBe(1);
    f.step();
    f.step();
    expect(sim.fields.length).toBe(0);
    expect(ev.find((e) => e.type === "fieldDown")).toMatchObject({ reason: "time", absorbed: 0 });
  });

  test("one: supply drops bring at most one force field into play, and another only once it is gone", () => {
    const rs = resolveRuleset({ pickups: { supply: { weaponChance: 0 }, forceField: { dropChance: 1, firstTick: 0 } } });
    const f = new Fight(3, [0, 1, 2, 3].map(() => plan({})), { level: level([[-20, 0], [-10, 0], [10, 0], [20, 0]]), ruleset: rs });
    const sim = f.sim;
    for (const it of sim.items()) sim.entityStore.remove(it);
    const count = () => sim.items().filter((e) => e.itemType === "forcefield").length;
    for (let n = 0; n < 8; n++) supplyDrop(sim, n);
    expect(count()).toBe(1);
    // carried: still in play, no second one
    const loose = sim.items().find((e) => e.itemType === "forcefield")!;
    sim.entityStore.remove(loose);
    sim.applyItem(sim.fighters[0]!, "forcefield");
    for (let n = 0; n < 8; n++) supplyDrop(sim, n);
    expect(count()).toBe(0);
    expect(fieldInPlay(sim)).toBe(true);
    // up: still in play; gone: the next drop can bring one again
    for (const c of f.controllers) c.think = () => ({ ...STILL, field: true });
    f.step();
    expect(sim.fields.length).toBe(1);
    for (let n = 0; n < 8; n++) supplyDrop(sim, n);
    expect(count()).toBe(0);
    sim.fields = [];
    expect(fieldInPlay(sim)).toBe(false);
    supplyDrop(sim, 9);
    expect(count()).toBe(1);
  });

  test("rules: bad settings are refused with the field named; turned off, no drop and no plan names it", () => {
    expect(() => validateRuleset({ pickups: { forceField: { radius: 0.5 } } })).toThrow(RulesetError);
    expect(() => validateRuleset({ pickups: { forceField: { radius: 0.5 } } })).toThrow(/pickups\.forceField\.radius/);
    expect(() => validateRuleset({ pickups: { forceField: { dropChance: 1.5 } } })).toThrow(/pickups\.forceField\.dropChance/);
    expect(() => validateRuleset({ tactics: { forceField: { shelterMargin: 3 } } })).toThrow(/shelterMargin/);
    expect(() => validateRuleset({ pickups: { forceField: { wall: true } } })).toThrow(/unknown setting/);
    const off = resolveRuleset({ pickups: { supply: { weaponChance: 0 }, forceField: { enabled: false, dropChance: 1, firstTick: 0 } } });
    expect(enabledItems(off)).not.toContain("forcefield");
    expect(enabledItems(CLASSIC)).toContain("forcefield");
    const rule = { when: "my_health_below", value: 50, do: "use", doItem: "forcefield", label: "bubble up" } as const;
    expect(checkRule(rule, 0, CLASSIC)).toBeNull();
    expect(checkRule(rule, 0, off)).toBe("item is disabled in this ruleset");
    const f = new Fight(3, [0, 1, 2, 3].map(() => plan({})), { level: level([[-20, 0], [-10, 0], [10, 0], [20, 0]]), ruleset: off });
    for (let n = 0; n < 12; n++) supplyDrop(f.sim, n);
    expect(f.sim.items().some((e) => e.itemType === "forcefield")).toBe(false);
  });

  // generated rounds: house-style plans, a ruleset where every power-up drop may be the force field
  const often = resolveRuleset({ pickups: { forceField: { dropChance: 1, firstTick: 0 } } });
  const PLANS: Strategy[] = [
    { target: "nearest", stance: "rush", weapons: ["rocket", "rifle"], line: "" },
    { target: "weakest", stance: "cover", weapons: ["grenade", "rifle"], line: "" },
    { target: "leader", stance: "distance", weapons: ["sniper", "rocket"], line: "" },
    { target: "nearest", stance: "hold", weapons: ["railgun", "crossbow"], line: "" },
  ];

  test("replays and bots: a bot picks one up and deploys it against a rocket; the fight replays to the same hash", () => {
    const f = new Fight(3, PLANS, { ruleset: often });
    const ev = events(f);
    const why: string[] = [];
    const prev = f.onEvent!;
    f.onEvent = (e) => {
      prev(e);
      if (e.type === "fieldUp") why.push(f.controllers[e.fighter]!.field.reason);
    };
    f.playToEnd();
    const up = ev.find((e) => e.type === "fieldUp");
    expect(up).toBeDefined();
    if (up?.type !== "fieldUp") return;
    // picked up first, by the fighter that deployed it
    expect(ev.some((e) => e.type === "pickup" && e.item === "forcefield" && e.fighter === up.fighter && e.tick < up.tick)).toBe(true);
    expect(why[0]).toBe("rocket");
    expect(ev.some((e) => e.type === "fieldHit" && e.field === up.field)).toBe(true);
    const rec = JSON.parse(JSON.stringify(f.record));
    expect(replayFight(rec).finalHash).toBe(f.record.finalHash);
  });

  test("bots: a \"use force field\" rule deploys it while active", () => {
    const rule = { when: "item_near", item: "forcefield", do: "seek", label: "get the bubble" } as const;
    const use = { when: "my_health_below", value: 90, do: "use", doItem: "forcefield", label: "bubble up" } as const;
    const plans = PLANS.map((p) => ({ ...p, rules: [rule, use] }));
    let ruled = 0;
    for (const seed of [3, 6, 9, 14]) {
      const f = new Fight(seed, plans, { ruleset: often });
      f.onEvent = (e) => {
        if (e.type === "fieldUp" && f.controllers[e.fighter]!.field.reason === "rule") {
          ruled++;
          expect(f.sim.fighters[e.fighter]!.hp).toBeLessThan(f.sim.fighters[e.fighter]!.maxHp * 0.9);
        }
      };
      f.playToEnd();
    }
    expect(ruled).toBeGreaterThan(0);
  });

  test("bots: a rifle bot holds fire at a rival inside a field, and fires at it once the field is gone", () => {
    const { f, sim, shooter, holder } = scene();
    const ev = events(f);
    sim.applyItem(shooter, "rifle");
    // a duel (the bystanders are out), so no other target draws the shot: only holding fire keeps it from the field
    for (const o of sim.fighters) if (o !== shooter && o !== holder) knockOut(sim, o, "ringout", 30, 0);
    // the shooter plays its own controller; the holder stands still inside its field
    const c = f.controllers[shooter.id]!;
    c.think = Object.getPrototypeOf(c).think.bind(c);
    for (let i = 0; i < 150; i++) f.step();
    const shotsAt = () => ev.filter((e) => e.type === "shot" && e.fighter === shooter.id).length;
    expect(ev.filter((e) => e.type === "fieldHit").length).toBe(0);
    expect(shotsAt()).toBe(0);
    // the field goes: now it shoots
    sim.fields = [];
    for (let i = 0; i < 150; i++) f.step();
    expect(shotsAt()).toBeGreaterThan(0);
  });
});
