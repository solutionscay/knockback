import { beforeAll, expect, test } from "bun:test";
import { CLASSIC, checkRule, Grid, initPhysics, Mat, NO_INPUT, Sim, validateRuleset, type LevelDef } from "../src/sim";
import { useTeleportPad } from "../src/sim/teleport-pads";

beforeAll(initPhysics);
function scene() {
  const grid = new Grid(80, 36, -20, -4);
  grid.fillRect(0, 0, 30, 7, Mat.Bedrock);
  grid.fillRect(50, 0, 79, 7, Mat.Bedrock);
  const level: LevelDef = { seed: 1, attempt: 0, name: "pads", theme: "rooftop", grid,
    minX: -20, maxX: 20, width: 40, towers: 0, walls: [], zoneCenter: 0, bridges: 0, platforms: 0, pits: [],
    spawns: [-12, -16, 14, 18].map(x => ({ x, y: 0 })), props: [],
    teleportPads: [{ x: -8, y: 0 }, { x: 8, y: 0 }] };
  const sim = new Sim(1, level);
  sim.zoneEnabled = false;
  for (const item of sim.items()) sim.entityStore.remove(item);
  for (let i = 0; i < 12; i++) sim.step(Array(4).fill(NO_INPUT));
  const f = sim.fighters.find(f => sim.pos(f).x < -10)!;
  const y = sim.pos(f).y;
  const stand = (x: number) => { f.entity.body.setTranslation({ x, y }, true); f.grounded = true; };
  return { sim, f, stand };
}

test("cross in both directions with the incoming velocity, rearming only off the exit", () => {
  const { sim, f, stand } = scene();
  stand(-8);
  f.entity.body.setLinvel({ x: 3, y: 1.5 }, true);
  useTeleportPad(sim, f);
  expect(sim.pos(f).x).toBe(8);
  expect(sim.vel(f)).toMatchObject({ x: 3, y: 1.5 });
  stand(8);
  useTeleportPad(sim, f);
  expect(sim.pos(f).x).toBe(8);
  stand(10); useTeleportPad(sim, f);
  stand(8); useTeleportPad(sim, f);
  expect(sim.pos(f).x).toBe(8);
  sim.tick = f.teleportReadyAt;
  stand(8); useTeleportPad(sim, f);
  expect(sim.pos(f).x).toBe(-8);
  expect(sim.events.filter(e => e.type === "teleport")).toHaveLength(2);
});

test("graph plans through a pair in both directions and drops the link when the floor is gone", () => {
  const { sim, f, stand } = scene();
  const a = sim.nav.surfaceAt(-8, 0)!, b = sim.nav.surfaceAt(8, 0)!;
  expect(sim.nav.fighterPlan(sim.grid, a.id, -12).firstLink[b.id]?.kind).toBe("teleport");
  expect(sim.nav.fighterPlan(sim.grid, b.id, 12).firstLink[a.id]?.kind).toBe("teleport");
  // Simulate a shaft carved below the exit and force a graph rebuild on the normal step.
  const cx = sim.grid.cx(8);
  for (let cy = 0; cy < 8; cy++) sim.grid.clear(cx, cy);
  sim.terrain.version++;
  stand(-8); useTeleportPad(sim, f);
  expect(sim.pos(f).x).toBe(-8);
  for (let t = 0; t < 30; t++) sim.step(Array(4).fill(NO_INPUT));
  expect(sim.nav.links.some(l => l.kind === "teleport")).toBe(false);
});

test("an occupied exit holds the traveler at the entrance", () => {
  const { sim, f, stand } = scene();
  const blocker = sim.fighters.find(o => o !== f)!;
  blocker.entity.body.setTranslation({ x: 8, y: sim.pos(f).y }, true);
  stand(-8); useTeleportPad(sim, f);
  expect(sim.pos(f).x).toBe(-8);
  expect(f.teleportLocked).toBe(false);
});

test("rules validate placement and allow a flank when a rival is near a pad", () => {
  expect(checkRule({ when: "near_pad", who: "enemy", do: "stance", stance: "flank", label: "flank" }, 0)).toBeNull();
  expect(validateRuleset({ arena: { teleport: { themes: [] } } }).arena.teleport.themes).toEqual([]);
  for (const patch of [{ halfWidth: 0 }, { insetShare: 0.5 }, { contactHeight: 0.6 }, { routeCost: 0 }])
    expect(() => validateRuleset({ arena: { teleport: patch } })).toThrow();
  expect(CLASSIC.arena.teleport.themes).toContain("space");
});
