import { beforeAll, expect, test } from "bun:test";
import { parseAnswer } from "../src/ai/parse";
import { Controller } from "../src/sim/controller";
import { POWER } from "../src/sim/constants";
import { initPhysics, NO_INPUT } from "../src/sim";
import { idle, place, sandbox, stepN } from "./helpers";

beforeAll(initPhysics);

test("jetpack fuel is spent only during thrust, and the empty pack stops lifting", () => {
  const sim = sandbox();
  const f = sim.fighters[0]!;
  const input = { ...NO_INPUT, thrust: true };
  const pack = POWER.jetpack;
  sim.applyItem(f, "jetpack");
  stepN(sim, 20);
  expect(f.power.jetpack).toBe(pack.fuelTicks);
  const start = sim.pos(f).y;
  f.stun = 3;
  const events = stepN(sim, pack.fuelTicks + 3, [input]);
  expect(f.power.jetpack).toBe(0);
  expect(sim.pos(f).y - start).toBeGreaterThan(8);
  expect(events.filter(e => e.type === "jetpack")).toHaveLength(1);
  expect(events.filter(e => e.type === "power" && e.power === "jetpack" && !e.on)).toHaveLength(1);
  stepN(sim, 1, [input]);
  expect(f.jetting).toBe(false);
  stepN(sim, 45, [input]);
  expect(sim.vel(f).y).toBeLessThan(0);
});

test("a bot flies around a high platform's lip and lands where the jump graph has no route", () => {
  const sim = sandbox();
  const f = place(sim, 0, -7.8, 0.85);
  const t = place(sim, 1, -3, 4.85);
  const ctl = new Controller(f.id, 0);
  ctl.targetId = t.id;
  ctl.setStrategy({ target: "grudge", grudge: t.id, stance: "rush", weapons: [], line: "" }, sim);
  const platform = sim.nav.surfaces[t.surface]!;
  expect(platform.y).toBe(4);
  expect(sim.nav.plan(f.surface, sim.pos(f).x).cost[platform.id]).toBe(Infinity);
  sim.applyItem(f, "jetpack");
  let landed = false;
  for (let i = 0; i < 140 && !landed; i++) {
    const inputs = idle();
    inputs[0] = { ...ctl.think(sim), fire: false };
    sim.step(inputs);
    landed = f.grounded && Math.abs(sim.feetY(f) - platform.y) < 0.25;
  }
  expect(landed).toBe(true);
  expect(f.power.jetpack).toBeLessThan(POWER.jetpack.fuelTicks);
});

test("a bot boosts inward from outside the zone", () => {
  const sim = sandbox();
  const f = place(sim, 0, 22, 0.85);
  sim.zoneEnabled = true;
  sim.zone.startHalf = 16;
  sim.applyItem(f, "jetpack");
  const input = new Controller(f.id, 0).think(sim);
  expect(input.thrust).toBe(true);
  expect(input.move).toBeLessThan(0);
});

test("plans can seek, use and recognize a held jetpack", () => {
  const { strategy, ruleProblems } = parseAnswer(JSON.stringify({
    weapons: ["bat"], target: "nearest", stance: "rush", line: "Up we go!",
    rules: [
      { when: "item_near", item: "jetpack", do: "seek" },
      { when: "holds", who: "enemy", item: "jetpack", do: "use", do_item: "jetpack" },
    ],
  }), 0, ["One", "Two", "Three", "Four"]);
  expect(ruleProblems).toBeUndefined();
  expect(strategy?.rules?.map(r => r.doItem)).toEqual(["jetpack", "jetpack"]);
});
