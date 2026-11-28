import { beforeAll, expect, test } from "bun:test";
import { checkRule, CLASSIC, Grid, initPhysics, Mat, NO_INPUT, Sim, validateRuleset, type LevelDef } from "../src/sim";
import { Liquid } from "../src/sim/grid";
import { sightTarget } from "../src/sim/controller-aim";
import { chooseCombatWeapon } from "../src/sim/controller-weapons";
import { hitProp } from "../src/sim/sim-objects";
import { igniteOilNear } from "../src/sim/sim-liquid";

beforeAll(initPhysics);

function scene(kind: "oilTank" | "waterTank") {
  const grid = new Grid(80, 32, -20, -4);
  grid.fillRect(0, 0, 79, 7, Mat.Bedrock);
  const level: LevelDef = { seed: 1, attempt: 0, name: "tank", theme: "warehouse", grid,
    minX: -20, maxX: 20, width: 40, towers: 0, walls: [], zoneCenter: 0, bridges: 0, platforms: 0, pits: [],
    spawns: [-15, 1.6, 9, 15].map(x => ({ x, y: 0 })), props: [{ kind, x: 0, y: 0 }] };
  const sim = new Sim(1, level);
  sim.zoneEnabled = false;
  for (let i = 0; i < 3; i++) sim.step(Array(4).fill(NO_INPUT));
  const tank = [...sim.entities.values()].find(e => e.kind === kind)!;
  const burst = () => sim.explode(0, 0.6, { radius: 2, knockback: 0, damage: 0, terrainDamage: 0, blockDamage: 0 }, "rocket", 0, 0, null);
  return { sim, tank, burst };
}

test("only a blast ruptures a tank, waking a dry map and washing a burning fighter outward once", () => {
  const { sim, tank, burst } = scene("waterTank");
  const f = sim.fighters.find(f => sim.pos(f).x > 1 && sim.pos(f).x < 2)!;
  f.burning = 30;
  const vx = sim.vel(f).x;
  hitProp(sim, tank, 100, 0, "rifle", 0, 0.6);
  expect(tank.dead).toBe(false);
  expect(sim.liquids.on).toBe(false);
  burst();
  expect(sim.vel(f).x).toBeGreaterThan(vx);
  expect(f.burning).toBe(0);
  expect(tank.dead).toBe(true);
  expect(sim.liquids.on).toBe(true);
  expect(sim.grid.liq.filter(l => l === Liquid.Water)).toHaveLength(CLASSIC.arena.props.tank.cells);
  burst();
  expect(sim.events.filter(e => e.type === "tankBurst")).toHaveLength(1);
});

test("spilled oil persists, can ignite, and the same blast replays to the same state", () => {
  const play = () => {
    const { sim, burst } = scene("oilTank");
    burst();
    expect(sim.grid.liq.filter(l => l === Liquid.Oil)).toHaveLength(CLASSIC.arena.props.tank.cells);
    igniteOilNear(sim, 0, 0.7, 1, 0);
    expect(sim.liquids.oilFires.size).toBeGreaterThan(0);
    for (let i = 0; i < 30; i++) sim.step(Array(4).fill(NO_INPUT));
    return sim.hash();
  };
  expect(play()).toBe(play());
});

test("plans can call for a rocket near a tank and spill size stays bounded", () => {
  expect(checkRule({ when: "near_tank", who: "target", do: "use", doItem: "rocket", label: "burst it" }, 0)).toBeNull();
  for (const patch of [{ radius: 0 }, { cells: 0 }, { cells: 65 }, { washSpeed: 13 }])
    expect(() => validateRuleset({ arena: { props: { tank: patch } } })).toThrow();
});


test("the shared controller shoots a tank that shields a nearby rival", () => {
  const { sim } = scene("waterTank");
  const shooter = sim.fighters.find(f => sim.pos(f).x < -10)!;
  const rival = sim.fighters.find(f => sim.pos(f).x > 1 && sim.pos(f).x < 2)!;
  sim.applyItem(shooter, "rocket");
  const p = sim.pos(shooter);
  const sight = sightTarget(sim, shooter, rival, p);
  expect(sight.sight?.entity?.kind).toBe("waterTank");
  const choice = chooseCombatWeapon(sim, shooter, p, sight);
  expect(choice.weapon).toBe("rocket");
  expect(choice.shot).toBeDefined();
});
