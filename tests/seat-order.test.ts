/**
 * Contract: no seat acts first every tick (#159). The fighters act (inputs, then pickups) in an order that turns with
 * the tick. In fixed seat order, seat 0 won every trade of blows and every race for an item.
 *
 * Hand-built flat level, inputs by hand. No real time, no network, no provider.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { actSeat, Grid, initPhysics, Mat, NO_INPUT, resolveRuleset, Sim, type Input, type LevelDef } from "../src/sim";

beforeAll(async () => {
  await initPhysics();
});

const RULESET = resolveRuleset({ pickups: { supply: { firstTick: 36_000 } } });

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

describe("act order", () => {
  test("each seat acts first once in every four ticks, and the order keeps every seat", () => {
    const first = [0, 0, 0, 0];
    for (let tick = 0; tick < 400; tick++) {
      const order = [0, 1, 2, 3].map((k) => actSeat(tick, k, 4));
      expect([...order].sort()).toEqual([0, 1, 2, 3]);
      first[order[0]!]!++;
    }
    expect(first).toEqual([100, 100, 100, 100]);
  });

  test("four fighters on one item: who gets it turns with the tick, no seat favoured", () => {
    const sim = new Sim(1, level(), undefined, RULESET);
    sim.zoneEnabled = false;
    for (const it of sim.items()) sim.entityStore.remove(it);
    const inputs: Input[] = [NO_INPUT, NO_INPUT, NO_INPUT, NO_INPUT];
    const F = RULESET.combat.fighter;
    const place = () => {
      for (const f of sim.fighters) {
        f.entity.body.setTranslation({ x: 0, y: F.halfHeight + F.radius + 0.02 }, true);
        f.entity.body.setLinvel({ x: 0, y: 0 }, true);
      }
    };
    place();
    sim.step(inputs);
    sim.events = [];
    const got = [0, 0, 0, 0];
    for (let k = 0; k < 8; k++) {
      place();
      const tick = sim.tick;
      sim.spawnItem("health", 0, 0.4);
      sim.step(inputs);
      const picks = sim.events.filter((e) => e.type === "pickup");
      sim.events = [];
      expect(picks.length).toBe(1);
      const who = (picks[0] as { fighter: number }).fighter;
      expect(who).toBe(actSeat(tick, 0, 4));
      got[who]!++;
    }
    expect(got).toEqual([2, 2, 2, 2]);
  });
});
