/**
 * Contract: the lightning sword (#72). Fire slashes what is close and casts a bolt at what is further off; a bolt
 * hits the first thing on its line and makes the floor there live; live ground shocks (damage and a stun) whoever
 * stands on it, the owner too, for its time and then stops, credited to the bolt's owner. The house fighter keeps the
 * bolt at range and stays off live ground. All of it replays exactly.
 *
 * Hand-built flat levels, a ruleset with the lightning sword as the only weapon, inputs given by hand (or house
 * controllers for the AI contracts). No real time, no network, no provider.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { Fight, Grid, initPhysics, Mat, NO_INPUT, resolveRuleset, Sim, type Fighter, type Input, type LevelDef, type SimEvent, type Strategy } from "../src/sim";
import { electrify, onLiveGround } from "../src/sim/sim-lightning";

beforeAll(async () => {
  await initPhysics();
});

const RULESET = resolveRuleset({ weapons: { enabled: ["lightning"] }, pickups: { enabled: ["health"], supply: { firstTick: 36_000 }, armory: { nearSpawn: 0, middle: 0, high: 0, spread: { skyDrops: 0 } } } });
const SPEC = RULESET.weapons.table.lightning;

/** A flat bedrock floor (feet at y 0) from -20 to 20, plus solid boxes [x0, x1, y0, y1]. */
function level(boxes: [number, number, number, number][] = [], spawns = [-12, -4, 4, 12]): LevelDef {
  const minX = -20, width = 40;
  const grid = new Grid(width * 2, 40, minX, -5);
  const fill = (x0: number, x1: number, y0: number, y1: number) => grid.fillRect(grid.cx(x0), grid.cy(y0), grid.cx(x1 - 0.01), grid.cy(y1 - 0.01), Mat.Bedrock);
  fill(-20, 20, -5, 0);
  for (const [x0, x1, y0, y1] of boxes) fill(x0, x1, y0, y1);
  return {
    seed: 0, attempt: 0, theme: "warehouse", name: "test", width, minX, maxX: minX + width, grid, props: [],
    spawns: spawns.map((x) => ({ x, y: 0 })), pits: [], zoneCenter: 0, platforms: 0, towers: 0, bridges: 0,
  };
}

/** A sandbox: no zone, no pickups lying about, fighters placed by hand, inputs by hand. */
function sandbox(boxes: [number, number, number, number][] = []) {
  const sim = new Sim(1, level(boxes), undefined, RULESET);
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
  /** Put a fighter standing at x (feet on the floor), still. */
  const place = (f: Fighter, x: number) => {
    f.entity.body.setTranslation({ x, y: RULESET.combat.fighter.halfHeight + RULESET.combat.fighter.radius + 0.02 }, true);
    f.entity.body.setLinvel({ x: 0, y: 0 }, true);
  };
  const [a, b, c, d] = sim.fighters as [Fighter, Fighter, Fighter, Fighter];
  place(a, -6);
  place(b, 0);
  place(c, 6);
  place(d, 16);
  step(30); // settle: everyone grounded
  sim.applyItem(a, "lightning");
  step(RULESET.combat.swapTicks + 1);
  /** a pulls the trigger once, aiming at (x, y) from its aim point */
  const fire = (x: number, y: number) => {
    const p = sim.pos(a);
    const dx = x - p.x, dy = y - (p.y + RULESET.tactics.weapons.aimHeight);
    const l = Math.hypot(dx, dy);
    inputs[a.id] = { ...NO_INPUT, aimX: dx / l, aimY: dy / l, weapon: "lightning", fire: true };
    step();
    inputs[a.id] = NO_INPUT;
  };
  return { sim, events, inputs, step, place, fire, a, b, c, d };
}

const hits = (events: SimEvent[], target: number) => events.filter((e): e is Extract<SimEvent, { type: "hit" }> => e.type === "hit" && e.target === target);

describe("lightning sword", () => {
  test("the slash hits a fighter in its reach, not one beyond it, and spends no bolt", () => {
    const s = sandbox();
    s.place(s.b, -6 + 1.5);
    s.step(5);
    const hp = s.b.hp;
    s.fire(s.sim.pos(s.b).x, s.sim.pos(s.b).y);
    const swing = s.events.find((e) => e.type === "swing");
    expect(swing && swing.type === "swing" && swing.weapon).toBe("lightning");
    expect(s.events.some((e) => e.type === "bolt")).toBe(false);
    expect(s.b.hp).toBeCloseTo(hp - SPEC.damage, 6);
    expect(s.a.ammo.lightning).toBe(SPEC.ammo);

    // with no bolt left, the same trigger at a fighter just past the slash's reach is a slash that misses
    const t = sandbox();
    t.a.ammo.lightning = 0;
    t.place(t.b, -6 + SPEC.reach + SPEC.radius + RULESET.combat.fighter.radius + 0.5);
    t.step(5);
    const hp2 = t.b.hp;
    t.fire(t.sim.pos(t.b).x, t.sim.pos(t.b).y);
    const miss = t.events.find((e) => e.type === "swing");
    expect(miss && miss.type === "swing" && miss.hit).toBe(false);
    expect(t.b.hp).toBe(hp2);
  });

  test("a bolt hits the first thing on its line: the near fighter, not the one behind; a wall shields what is past it", () => {
    const s = sandbox();
    const hpB = s.b.hp, hpC = s.c.hp;
    s.fire(s.sim.pos(s.c).x, s.sim.pos(s.c).y); // b (at 0) stands between a (-6) and c (6)
    const bolt = s.events.find((e) => e.type === "bolt");
    expect(bolt && bolt.type === "bolt" && bolt.target).toBe(s.b.id);
    expect(s.a.ammo.lightning).toBe(SPEC.ammo - 1);
    expect(hits(s.events, s.b.id)[0]!.damage).toBeCloseTo(SPEC.boltDamage, 6);
    expect(s.b.hp).toBeLessThan(hpB);
    expect(s.c.hp).toBe(hpC);

    // a wall at x -2.5..-1.5 between a and b: the bolt stops at the wall, b is untouched, the floor at its foot goes live
    const w = sandbox([[-2.5, -1.5, 0, 3]]);
    const hp = w.b.hp;
    w.fire(w.sim.pos(w.b).x, w.sim.pos(w.b).y);
    const wb = w.events.find((e) => e.type === "bolt");
    expect(wb && wb.type === "bolt" && wb.hit).toBe("terrain");
    expect(wb && wb.type === "bolt" && wb.x1).toBeLessThan(-2.4);
    expect(w.b.hp).toBe(hp);
    expect(w.sim.liveGround.length).toBe(1);
    expect(onLiveGround(w.sim, -3, 0)).not.toBeNull();
    expect(onLiveGround(w.sim, 0, 0)).toBeNull();
  });

  test("live ground shocks who stands on it, credited to the owner, stuns at most once per gap, and stops when its time is up", () => {
    const s = sandbox();
    s.fire(s.sim.pos(s.b).x, s.sim.pos(s.b).y);
    const strip = s.sim.liveGround[0]!;
    const born = strip.born;
    // the strip is about groundWidth wide, centered under b
    const xs = strip.points.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(SPEC.groundWidth, 1);
    // c stands on it from now on; b is moved off it
    s.place(s.c, 0.5);
    s.place(s.b, 10);
    const hpC = s.c.hp;
    s.step(SPEC.groundTicks + 40);
    const shocks = s.events.filter((e): e is Extract<SimEvent, { type: "shock" }> => e.type === "shock" && e.fighter === s.c.id);
    // a pulse every pulseTicks while live (the first one or two can miss while c drops onto the floor)
    expect(shocks.length).toBeGreaterThanOrEqual(Math.floor(SPEC.groundTicks / SPEC.pulseTicks) - 2);
    expect(shocks.every((e) => e.by === s.a.id && (e.tick - born) % SPEC.pulseTicks === 0 && e.tick < born + SPEC.groundTicks)).toBe(true);
    const fromStrip = hits(s.events, s.c.id).filter((e) => e.cause === "lightning");
    expect(fromStrip.every((e) => e.source === s.a.id && e.damage === SPEC.pulseDamage)).toBe(true);
    expect(s.c.hp).toBeCloseTo(hpC - shocks.length * SPEC.pulseDamage, 6);
    // stunned on a shock, then not again until stunGap has passed
    const stuns = shocks.filter((e) => e.stun).map((e) => e.tick);
    expect(stuns.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < stuns.length; i++) expect(stuns[i]! - stuns[i - 1]!).toBeGreaterThanOrEqual(SPEC.stunGap);
    // done: no strip, no more shocks
    expect(s.sim.liveGround.length).toBe(0);
    const after = s.events.length;
    s.step(60);
    expect(s.events.slice(after).some((e) => e.type === "shock")).toBe(false);
  });

  test("the owner is shocked on its own live ground too; a knockout by live ground is the owner's", () => {
    const s = sandbox();
    s.fire(s.sim.pos(s.b).x, s.sim.pos(s.b).y);
    s.place(s.a, 0.3); // the caster walks onto its own strip
    s.c.hp = SPEC.pulseDamage / 2;
    s.place(s.c, -0.3);
    s.step(SPEC.pulseTicks * 2 + 2);
    expect(s.events.some((e) => e.type === "shock" && e.fighter === s.a.id && e.by === s.a.id)).toBe(true);
    expect(s.a.hp).toBeLessThan(RULESET.combat.fighter.maxHp);
    const ko = s.events.find((e) => e.type === "ko" && e.fighter === s.c.id);
    expect(ko && ko.type === "ko" && ko.by).toBe(s.a.id);
    expect(ko && ko.type === "ko" && ko.weapon).toBe("lightning");
    expect(s.a.kos).toBe(1);
  });
});

const plan = (s: Partial<Strategy>): Strategy => ({ target: "nearest", stance: "rush", weapons: ["lightning"], line: "", ...s });

describe("lightning sword: the house fighter", () => {
  test("keeps the bolt at range: bolts from the reach's min out, the slash only up close", () => {
    const reach = RULESET.tactics.weapons.reach.lightning;
    let bolts = 0;
    for (const seed of [1, 2, 3]) {
      // the armed fighter rushes three who hold their spots, 16 m away and more
      const f = new Fight(seed, [0, 1, 2, 3].map(() => plan({ stance: "hold" })), { level: level([], [-14, 4, 8, 12]), ruleset: RULESET });
      const sim = f.sim;
      for (const it of sim.items()) sim.entityStore.remove(it);
      const me = sim.fighters.find((x) => sim.pos(x).x < 0)!;
      sim.applyItem(me, "lightning");
      f.controllers[me.id]!.setStrategy(plan({ stance: "rush" }), sim);
      f.onEvent = (e) => {
        if ((e.type !== "bolt" && e.type !== "swing") || e.fighter !== me.id) return;
        const target = sim.fighters[f.controllers[me.id]!.targetId]!;
        const d = Math.hypot(sim.pos(target).x - sim.pos(me).x, sim.pos(target).y - sim.pos(me).y);
        if (e.type === "bolt") {
          bolts++;
          // a bolt is never cast at someone inside the gap the reach keeps (its live ground would catch the caster)
          expect(d).toBeGreaterThanOrEqual(reach.min - 0.5);
        }
      };
      while (!f.over && sim.tick < 600 && me.ammo.lightning > 0) f.step();
    }
    expect(bolts).toBeGreaterThanOrEqual(6);
  });

  test("a rival too close for a bolt and too far for the slash: it backs off to bolt range before it casts", () => {
    const reach = RULESET.tactics.weapons.reach.lightning;
    for (const seed of [1, 2]) {
      const f = new Fight(seed, [0, 1, 2, 3].map(() => plan({ stance: "hold" })), { level: level([], [-6, 14, 16, 18]), ruleset: RULESET });
      const sim = f.sim;
      sim.zoneEnabled = false;
      for (const it of sim.items()) sim.entityStore.remove(it);
      const me = sim.fighters.reduce((l, x) => (sim.pos(x).x < sim.pos(l).x ? x : l));
      const rival = sim.fighters.find((x) => x !== me && sim.pos(x).x < 15)!;
      // armed and ready (the swap done) while the rivals are far off
      sim.applyItem(me, "lightning");
      for (let t = 0; t < 30; t++) f.step();
      // then the rival stands just inside the bolt's minimum (where the sim would still cast a bolt: its body is past boltMinRange)
      const gap = reach.min - 0.1;
      expect(gap - RULESET.combat.fighter.radius).toBeGreaterThan(SPEC.boltMinRange);
      rival.entity.body.setTranslation({ x: sim.pos(me).x + gap, y: sim.pos(me).y }, true);
      rival.entity.body.setLinvel({ x: 0, y: 0 }, true);
      f.controllers[me.id]!.setStrategy(plan({ stance: "rush" }), sim);
      // the distance it saw when it cast each bolt (the controller decides from the positions before the step)
      const at: number[] = [];
      let before = 0;
      f.onEvent = (e) => {
        if (e.type === "bolt" && e.fighter === me.id) at.push(before);
      };
      for (let t = 0; t < 90; t++) {
        before = Math.hypot(sim.pos(rival).x - sim.pos(me).x, sim.pos(rival).y - sim.pos(me).y);
        f.step();
      }
      expect(at.length).toBeGreaterThan(0);
      expect(Math.min(...at)).toBeGreaterThanOrEqual(reach.min);
    }
  });

  test("walks off live ground the short way, and stays off it", () => {
    for (const seed of [1, 2]) {
      // alone at the left end: the nearest rival is 20 m away, so nobody fights or knocks it about
      const f = new Fight(seed, [0, 1, 2, 3].map(() => plan({ stance: "hold" })), { level: level([], [-14, 6, 10, 14]), ruleset: RULESET });
      const sim = f.sim;
      sim.zoneEnabled = false;
      for (const it of sim.items()) sim.entityStore.remove(it);
      for (let i = 0; i < 30; i++) f.step();
      const me = sim.fighters.reduce((l, x) => (sim.pos(x).x < sim.pos(l).x ? x : l));
      const caster = sim.fighters.reduce((r, x) => (sim.pos(x).x > sim.pos(r).x ? x : r));
      // live ground from just left of it to well right of it (toward the rivals, where it would go anyway), as a bolt
      // from the far fighter's sword leaves it
      const x0 = sim.pos(me).x;
      const strip = electrify(sim, caster.id, x0 + SPEC.groundWidth / 2 - 0.3, 0.1)!;
      expect(strip.points[0]!.x).toBeLessThan(x0);
      let off = -1;
      let backOn = false;
      for (let t = 0; t < SPEC.groundTicks - 10; t++) {
        f.step();
        const on = !!onLiveGround(sim, sim.pos(me).x, sim.feetY(me));
        if (!on && off < 0) off = t;
        if (off >= 0 && on) backOn = true;
      }
      // off the near (left) end, right after the first stun, and never back on while it is live
      expect(off).toBeGreaterThanOrEqual(0);
      expect(off).toBeLessThan(SPEC.stunTicks + 20);
      expect(backOn).toBe(false);
    }
  });

  test("does not walk or hop onto live ground on its way: it waits at the edge, then goes on", () => {
    for (const seed of [1, 2]) {
      // a fist fighter at the left rushes the fighters who hold at the right; a strip lies across its way
      const f = new Fight(seed, [0, 1, 2, 3].map(() => plan({ stance: "hold" })), { level: level([], [-14, 6, 10, 14]), ruleset: RULESET });
      const sim = f.sim;
      sim.zoneEnabled = false;
      for (const it of sim.items()) sim.entityStore.remove(it);
      const me = sim.fighters.reduce((l, x) => (sim.pos(x).x < sim.pos(l).x ? x : l));
      const caster = sim.fighters.reduce((r, x) => (sim.pos(x).x > sim.pos(r).x ? x : r));
      f.controllers[me.id]!.setStrategy(plan({ stance: "rush" }), sim);
      const strip = electrify(sim, caster.id, -8, 0.1)!;
      const lastX = strip.points[strip.points.length - 1]!.x;
      let stepped = false;
      while (sim.tick < strip.born + SPEC.groundTicks - 1) {
        f.step();
        if (onLiveGround(sim, sim.pos(me).x, sim.feetY(me))) stepped = true;
      }
      expect(stepped).toBe(false);
      expect(sim.pos(me).x).toBeLessThan(strip.points[0]!.x);
      // the strip is gone: on it goes
      for (let t = 0; t < 120; t++) f.step();
      expect(sim.pos(me).x).toBeGreaterThan(lastX);
    }
  });

  test("a lightning fight replays exactly: same seed, same hash, tick by tick", () => {
    const run = () => {
      const f = new Fight(5, [0, 1, 2, 3].map((i) => plan({ stance: i % 2 ? "rush" : "distance" })), { level: level([[-1, 1, 0, 1.5]]), ruleset: resolveRuleset({ weapons: { enabled: ["lightning"] }, pickups: { enabled: ["health"] } }) });
      const hashes: string[] = [];
      let bolts = 0, shocks = 0;
      f.onEvent = (e) => {
        if (e.type === "bolt") bolts++;
        if (e.type === "shock") shocks++;
      };
      while (!f.over && f.sim.tick < 1800) {
        f.step();
        if (f.sim.tick % 120 === 0) hashes.push(f.sim.hash());
      }
      return { hashes, bolts, shocks };
    };
    const one = run(), two = run();
    expect(one.bolts).toBeGreaterThan(0);
    expect(one.shocks).toBeGreaterThan(0);
    expect(two).toEqual(one);
  });
});
