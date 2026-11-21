/**
 * Contract 10: a rocket hit is real damage, and rocket users hit a moving target (#73).
 *   falloff  a blast hurts most at its center, less with distance, and nothing past its radius
 *   lead     a fighter aims a rocket where a walking target will be when the rocket gets there
 *
 * Hand-built levels with no randomness in their layout; house controllers only.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { Fight, Grid, initPhysics, Mat, NO_INPUT, resolveRuleset, type LevelDef, type Strategy } from "../src/sim";

beforeAll(async () => {
  await initPhysics();
});

/** A bedrock floor across the level (feet at y 0), plus solid boxes [x0, x1, y0, y1]; spawns are [x, y] feet. */
function level(boxes: [number, number, number, number][], spawns: [number, number][]): LevelDef {
  const minX = -30, width = 60;
  const grid = new Grid(width * 2, 40, minX, -5);
  const fill = (x0: number, x1: number, y0: number, y1: number) => grid.fillRect(grid.cx(x0), grid.cy(y0), grid.cx(x1 - 0.01), grid.cy(y1 - 0.01), Mat.Bedrock);
  fill(minX, minX + width, -5, 0);
  for (const [x0, x1, y0, y1] of boxes) fill(x0, x1, y0, y1);
  return {
    seed: 0, attempt: 0, theme: "warehouse", name: "test", width, minX, maxX: minX + width, grid, props: [],
    spawns: spawns.map(([x, y]) => ({ x, y })), pits: [], zoneCenter: 0, platforms: 0, towers: 0, bridges: 0,
  };
}

const plan = (s: Partial<Strategy>): Strategy => ({ target: "nearest", stance: "hold", weapons: ["rocket"], line: "", ...s });
const rocketsOnly = resolveRuleset({ weapons: { enabled: ["rocket"] }, pickups: { enabled: ["health"] } });

describe("rockets", () => {
  test("falloff: a rocket blast hurts most at its center, less further out, and nothing past its radius", () => {
    const spec = rocketsOnly.weapons.table.rocket;
    const body = rocketsOnly.combat.fighter.radius;
    // a fresh fighter for each blast, so its health (and knockback growth) starts the same; the shooter is far away
    const hurt = (offset: number) => {
      const f = new Fight(1, [0, 1, 2, 3].map(() => plan({})), { level: level([], [[-25, 0], [0, 0], [20, 0], [25, 0]]), ruleset: rocketsOnly });
      const target = f.sim.fighters.find((x) => Math.abs(f.sim.pos(x).x) < 1)!;
      const shooter = f.sim.fighters.find((x) => f.sim.pos(x).x < -20)!;
      // a few ticks so the fighters stand on the floor and the physics world knows where they are
      for (let i = 0; i < 10; i++) f.step();
      const p = f.sim.pos(target);
      const hp = target.hp;
      f.sim.explode(p.x + offset, p.y, spec, "rocket", shooter.id, 0, null);
      return hp - target.hp;
    };
    const direct = hurt(0);
    const half = hurt(body + spec.radius / 2);
    const edge = hurt(body + spec.radius * 0.95);
    const outside = hurt(body + spec.radius + 0.3);
    // a direct hit is the rocket's full damage, and that is real damage: a tenth of a fighter's health or more
    expect(direct).toBeCloseTo(spec.damage, 5);
    expect(direct).toBeGreaterThanOrEqual(rocketsOnly.combat.fighter.maxHp / 10);
    expect(half).toBeLessThan(direct * 0.8);
    expect(half).toBeGreaterThan(edge);
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(direct * 0.5);
    expect(outside).toBe(0);
  });

  test("lead: a rocket fired up at a target walking along a ledge lands on it, not where it was", () => {
    // the shooter stands on the floor; the target walks straight away along a ledge 4 m up. A rocket aimed at where
    // the target is now crosses the ledge's height there and flies over it or bursts behind it: only a lead by the
    // rocket's real flight time lands the blast on the target.
    const ruleset = resolveRuleset({ ...rocketsOnly, tactics: { ...rocketsOnly.tactics, aimNoise: 0 } });
    for (const gap of [12, 15, 18]) {
      const ledge = -22 + gap;
      const f = new Fight(1, [0, 1, 2, 3].map(() => plan({})), { level: level([[ledge, 30, 0, 2.5]], [[-24, 0], [ledge + 1, 2.5], [27, 2.5], [29, 2.5]]), ruleset });
      const sim = f.sim;
      for (const it of sim.items()) sim.entityStore.remove(it);
      const shooter = sim.fighters.find((x) => sim.pos(x).x < -23)!;
      const target = sim.fighters.find((x) => Math.abs(sim.pos(x).x - (ledge + 1)) < 1)!;
      sim.applyItem(shooter, "rocket");
      // the first rocket is ready after 1 s: the target is walking at full speed by then
      shooter.cooldown.rocket = 60;
      // the target walks away; the two far fighters stand still and are never the nearest
      for (const c of f.controllers) {
        if (c === f.controllers[shooter.id]) continue;
        c.think = () => ({ ...NO_INPUT, move: c === f.controllers[target.id] ? 1 : 0 });
      }
      let fired = -1;
      let damage = 0;
      f.onEvent = (e) => {
        if (e.type === "fire" && e.fighter === shooter.id && fired < 0) fired = e.tick;
        if (e.type === "hit" && e.cause === "rocket" && e.target === target.id && damage === 0) damage = e.damage;
      };
      while (!f.over && sim.tick < 240 && damage === 0) f.step();
      expect(fired).toBeGreaterThan(0);
      // the first rocket bursts on the target or on the ledge at its feet: most of a direct hit
      expect(damage).toBeGreaterThan(ruleset.weapons.table.rocket.damage * 0.75);
    }
  });
});
