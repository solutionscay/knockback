import { beforeAll, expect, test } from "bun:test";
import { checkRule, CLASSIC, Fight, Grid, initPhysics, Mat, NO_INPUT, validateRuleset, type LevelDef, type Strategy } from "../src/sim";
import { Liquid } from "../src/sim/grid";
import { sprayCoolant } from "../src/sim/sim-freeze";
import { walkSpeedNow } from "../src/sim/sim-movement";

beforeAll(initPhysics);

function scene() {
  const grid = new Grid(80, 36, -20, -5);
  grid.fillRect(0, 0, 79, 9, Mat.Bedrock);
  const level: LevelDef = {
    seed: 1, attempt: 0, theme: "warehouse", name: "Freeze", width: 40, minX: -20, maxX: 20,
    grid, props: [], spawns: [-6, -3, 9, 14].map(x => ({ x, y: 0 })), pits: [], zoneCenter: 0,
    platforms: 0, towers: 0, walls: [], bridges: 0,
  };
  const plan: Strategy = { target: "nearest", stance: "hold", weapons: ["freezegun"], line: "" };
  const fight = new Fight(1, Array(4).fill(plan), { level });
  const sim = fight.sim;
  for (const item of sim.items()) sim.entityStore.remove(item);
  const shooter = sim.fighters.find(f => sim.pos(f).x === -6)!;
  const rival = sim.fighters.find(f => sim.pos(f).x === -3)!;
  for (let i = 0; i < 5; i++) sim.step(Array(4).fill(NO_INPUT));
  return { sim, fight, shooter, rival };
}

test("coolant slows once per pulse, refreshes the timer and wears off", () => {
  const { sim, shooter, rival } = scene();
  const p = sim.pos(shooter), spec = CLASSIC.weapons.table.freezegun;
  const shoot = () => sprayCoolant(sim, shooter, p.x, p.y, 1, 0);
  const speed = walkSpeedNow(CLASSIC, rival);
  shoot();
  expect(rival.maxHp - rival.hp).toBeCloseTo(spec.damage);
  expect(walkSpeedNow(CLASSIC, rival)).toBeCloseTo(speed * spec.speedMul);
  sim.step(Array(4).fill(NO_INPUT));
  shoot();
  expect(rival.chilled).toBe(spec.chillTicks);
  for (let i = 0; i < spec.chillTicks; i++) sim.step(Array(4).fill(NO_INPUT));
  expect(walkSpeedNow(CLASSIC, rival)).toBe(speed);
});

test("a spray freezes water into solid footing, leaving oil and water behind the wall alone", () => {
  const { sim, shooter } = scene();
  const g = sim.grid;
  const y = 3.25, cy = g.cy(y);
  for (let x = 0; x < 5; x += 0.5) {
    g.liq[g.idx(g.cx(x), cy)] = x === 1 ? Liquid.Oil : Liquid.Water;
    g.liq[g.idx(g.cx(x), cy - 1)] = Liquid.Water;
  }
  for (let row = 10; row < cy + 5; row++) sim.terrain.placeCell(g.cx(2), row, Mat.Bedrock);
  sim.step(Array(4).fill(NO_INPUT));
  sprayCoolant(sim, shooter, 0.1, y, 1, 0);
  expect(g.matAt(g.cx(0.5), cy)).toBe(Mat.Ice);
  expect(g.liq[g.idx(g.cx(1), cy)]).toBe(Liquid.Oil);
  expect(g.liq[g.idx(g.cx(3), cy)]).toBe(Liquid.Water);
  sim.step(Array(4).fill(NO_INPUT));
  expect(sim.raycast(0.75, y + 1, 0, -1, 1)?.terrain).toBeTruthy();
});

test("bots fire the gun in reach and the ruleset controls its plan action", () => {
  const { sim, fight, shooter, rival } = scene();
  sim.applyItem(shooter, "freezegun");
  for (const c of fight.controllers) if (c !== fight.controllers[shooter.id]) c.think = () => NO_INPUT;
  for (let i = 0; i < 120 && !rival.chilled; i++) fight.step();
  expect(rival.chilled).toBeGreaterThan(0);
  const rule = { when: "my_health_below", value: 40, do: "use", doItem: "freezegun", label: "chill" } as const;
  expect(checkRule(rule, 0)).toBeNull();
  expect(checkRule(rule, 0, validateRuleset({ weapons: { enabled: ["bat"] } }))).toBeTruthy();
  for (const patch of [{ speedMul: 1 }, { chillTicks: 0 }, { range: 13 }, { spread: 2 }, { ammo: 0 }])
    expect(() => validateRuleset({ weapons: { table: { freezegun: patch } } })).toThrow();
});
