/**
 * Contract 9: the fighter controller carries out a plan with sense (#69). A fighter never walks or jumps off the map
 * on its own (knockback can still ring it out), and it fights at its weapon's range, not at fist range.
 *
 * Hand-built levels with no randomness in their layout; house controllers only.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { Fight, Grid, initPhysics, Mat, resolveRuleset, type LevelDef, type Strategy } from "../src/sim";

beforeAll(async () => {
  await initPhysics();
});

/** A flat level: a floor of bedrock from x0 to x1 (feet at y 0), plus extra solid boxes. */
function level(floors: [number, number][], boxes: [number, number, number, number][], spawns: number[]): LevelDef {
  const minX = -20, width = 40;
  const grid = new Grid(width * 2, 40, minX, -5);
  const fill = (x0: number, x1: number, y0: number, y1: number) => grid.fillRect(grid.cx(x0), grid.cy(y0), grid.cx(x1 - 0.01), grid.cy(y1 - 0.01), Mat.Bedrock);
  for (const [x0, x1] of floors) fill(x0, x1, -5, 0);
  for (const [x0, x1, y0, y1] of boxes) fill(x0, x1, y0, y1);
  return {
    seed: 0, attempt: 0, theme: "warehouse", name: "test", width, minX, maxX: minX + width, grid, props: [],
    spawns: spawns.map((x) => ({ x, y: 0 })), pits: [], zoneCenter: 0, platforms: 0, towers: 0, bridges: 0,
  };
}

const plan = (s: Partial<Strategy>): Strategy => ({ target: "nearest", stance: "rush", weapons: ["bat"], line: "", ...s });

describe("fighter behavior", () => {
  test("ledge safety: a fighter whose target is across a gap it cannot jump does not fall in", () => {
    // a 3 m pit (the nav graph sees a jump), with a wall hanging over it 2 m above the floor: no body makes that jump
    const lv = level([[-20, -1.5], [1.5, 20]], [[-2.5, 2.5, 2, 12]], [-10, 6, 10, 14]);
    for (const seed of [1, 2, 3]) {
      // bats only (reach 2 m, the pit is 4): no grapple or blast pulls it across, so a fall can only be its own
      const f = new Fight(seed, [0, 1, 2, 3].map(() => plan({})), { level: lv, ruleset: resolveRuleset({ weapons: { enabled: ["bat"] }, pickups: { enabled: ["health"] } }) });
      const left = f.sim.fighters.find((x) => f.sim.pos(x).x < 0)!;
      while (!f.over && f.sim.tick < 600) f.step();
      const ko = f.result().koLog.find((k) => k.fighter === left.id);
      // alive, or knocked out by a rival: never a fall of its own
      expect(ko === undefined || (ko.by >= 0 && ko.by !== left.id)).toBe(true);
      expect(left.removed).toBe(false);
    }
  });

  test("weapon range: a rush fighter with a rocket stops at rocket range, not at fist range", () => {
    // open floor; the rusher starts 28 m from three fighters who hold their spots, and is the only one armed
    const lv = level([[-20, 20]], [], [-15, 13, 15, 17]);
    const ruleset = resolveRuleset({ weapons: { enabled: ["rocket"] }, pickups: { enabled: ["health"] } });
    for (const seed of [1, 2]) {
      const f = new Fight(seed, [0, 1, 2, 3].map(() => plan({ stance: "hold", weapons: ["rocket"] })), { level: lv, ruleset });
      const sim = f.sim;
      for (const it of sim.items()) sim.entityStore.remove(it);
      const rusher = sim.fighters.find((x) => sim.pos(x).x < 0)!;
      sim.applyItem(rusher, "rocket");
      f.controllers[rusher.id]!.setStrategy(plan({ stance: "rush", weapons: ["rocket"] }), sim);
      const { standOff, min } = ruleset.tactics.weapons.reach.rocket;
      const dist: number[] = [];
      // 7 s: before the first supply drop
      while (!f.over && sim.tick < 420) {
        f.step();
        const t = f.controllers[rusher.id]!.targetId;
        const target = t >= 0 ? sim.fighters[t]! : null;
        if (sim.tick < 240 || !target || target.removed || rusher.removed || sim.weapon(rusher) !== "rocket") continue;
        const a = sim.pos(rusher), b = sim.pos(target);
        dist.push(Math.hypot(a.x - b.x, a.y - b.y));
      }
      dist.sort((a, b) => a - b);
      expect(dist.length).toBeGreaterThan(30);
      expect(dist[Math.floor(dist.length / 2)]!).toBeGreaterThan(standOff * 0.7);
      expect(dist[0]!).toBeGreaterThan(min * 2);
    }
  });
});
