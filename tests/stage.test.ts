/**
 * Contract: the stage (#100). Jump-through platforms: a fighter jumps up through one and stands on it, holds down to
 * drop through it, and a crate dropped on it stays on it. Wall jump: a fighter climbs a narrow pit wall to wall, but not
 * just after a knock, and never beside the void (the arena's outer face). Digging punches break soft cells, never rock.
 *
 * The scenes are built by hand (no level generator), so they move only when these mechanics change.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { CELL, CLASSIC, F_ONEWAY, Grid, initPhysics, Mat, NO_INPUT, resolveRuleset, Sim, type Input, type LevelDef } from "../src/sim";

beforeAll(async () => {
  await initPhysics();
});

const QUIET = resolveRuleset({ pickups: { supply: { firstTick: 36_000 }, armory: { nearSpawn: 0, middle: 0, high: 0, spread: { skyDrops: 0 } } } });
const F = CLASSIC.combat.fighter;

/** Dirt ground with its top at y = 0 (x -20..20), bedrock under it. `build` adds to it. Seat 0 stands at (x, y). */
function scene(build: (g: Grid) => void, x: number, y: number, ground: [number, number] = [0, 80]) {
  const g = new Grid(80, 40, -20, -6);
  for (let cx = ground[0]; cx < ground[1]; cx++) for (let cy = 0; cy < 12; cy++) g.set(cx, cy, cy < 2 ? Mat.Bedrock : Mat.Dirt);
  build(g);
  const level: LevelDef = {
    seed: 1, attempt: 0, theme: "junkyard", name: "STAGE", width: 40, minX: -20, maxX: 20, grid: g,
    props: [], spawns: [{ x, y }, { x: 15, y: 0 }, { x: 16, y: 0 }, { x: 17, y: 0 }],
    pits: [], zoneCenter: 0, platforms: 0, towers: 0, walls: [], bridges: 0,
  };
  const sim = new Sim(1, level, undefined, QUIET);
  sim.zoneEnabled = false;
  for (const it of sim.items()) sim.entityStore.remove(it);
  const spots: [number, number][] = [[x, y], [15, 0], [16, 0], [17, 0]];
  sim.fighters.forEach((f, i) => {
    f.entity.body.setTranslation({ x: spots[i]![0], y: spots[i]![1] + F.halfHeight + F.radius + 0.02 }, true);
    f.entity.body.setLinvel({ x: 0, y: 0 }, true);
  });
  const inputs: Input[] = [NO_INPUT, NO_INPUT, NO_INPUT, NO_INPUT];
  const run = (ticks: number, each?: (t: number) => void) => {
    for (let t = 0; t < ticks; t++) {
      each?.(t);
      sim.step(inputs);
      sim.events = [];
    }
  };
  for (let i = 0; i < 20; i++) sim.step(inputs);
  return { sim, me: sim.fighters[0]!, inputs, run };
}

describe("jump-through platforms (#100)", () => {
  // a one-way platform 2.5 m up over x -2..2 (cells 36-43 at cy 16: top at y 2.5)
  const platform = (g: Grid) => {
    for (let cx = 36; cx < 44; cx++) g.set(cx, 16, Mat.Wood, F_ONEWAY);
  };

  test("a fighter jumps up through it and stands on it; holding down drops it through", () => {
    const { sim, me, inputs, run } = scene(platform, 0, 0);
    expect(sim.feetY(me)).toBeLessThan(0.1);
    run(80, (t) => (inputs[0] = { ...NO_INPUT, jump: t < 5 }));
    expect(me.grounded).toBe(true);
    expect(sim.feetY(me)).toBeGreaterThan(2.4);
    expect(sim.nav.surfaceAt(sim.pos(me).x, sim.feetY(me))?.oneWay).toBe(true);
    inputs[0] = { ...NO_INPUT, down: true };
    run(40);
    inputs[0] = NO_INPUT;
    run(20);
    expect(sim.feetY(me)).toBeLessThan(0.1);
    expect(sim.stats.platformDrops).toBe(1);
  });

  test("a crate dropped on it stays on top; the nav graph jumps up through it and drops through it", () => {
    const { sim, run } = scene(platform, 8, 0);
    const crate = sim.addProp("crate", 0, 5);
    run(90);
    expect(crate.body.translation().y - crate.hh).toBeGreaterThan(2.4);
    const top = sim.nav.surfaces.find((s) => s.oneWay)!;
    const floor = sim.nav.surfaces.find((s) => s.y === 0 && s.x0 <= -2 && s.x1 >= 2)!;
    expect(sim.nav.links.some((l) => l.from === floor.id && l.to === top.id && l.through && sim.nav.canFly(sim.grid, l))).toBe(true);
    expect(sim.nav.links.some((l) => l.from === top.id && l.to === floor.id && l.through && sim.nav.canFly(sim.grid, l))).toBe(true);
  });
});

describe("wall jump (#100)", () => {
  // a pit 2 m wide (cells 38-41) and 5 m deep (cy 2-11, bedrock under it): too deep to jump out of
  const pit = (g: Grid) => {
    for (let cx = 38; cx <= 41; cx++) for (let cy = 2; cy < 12; cy++) g.clear(cx, cy);
  };
  /** jump, and kick off whichever wall is beside it near the top of each jump; move toward the other wall */
  const climb = (s: ReturnType<typeof scene>, ticks: number, knocked = false) => {
    let dir = 1;
    s.run(ticks, () => {
      if (s.me.removed || s.sim.feetY(s.me) > 0.2) {
        s.inputs[0] = NO_INPUT; // out: stand
        return;
      }
      const v = s.sim.vel(s.me);
      if (knocked) s.me.kbTick = s.sim.tick;
      if (s.me.wallSide) dir = -s.me.wallSide;
      s.inputs[0] = { ...NO_INPUT, move: dir, jump: s.me.grounded || v.y < 3 };
    });
  };

  test("a fighter climbs a narrow pit wall to wall", () => {
    const s = scene(pit, 0, -5);
    expect(s.sim.feetY(s.me)).toBeLessThan(-4.9);
    let high = -Infinity;
    const run = s.run;
    s.run = (ticks, each) => run(ticks, (t) => {
      each?.(t);
      high = Math.max(high, s.sim.feetY(s.me));
    });
    climb(s, 300);
    expect(s.sim.stats.wallJumps).toBeGreaterThanOrEqual(2);
    expect(high).toBeGreaterThan(0); // out over the rim
  });

  test("not just after a knock: the same climb stays in the pit", () => {
    const s = scene(pit, 0, -5);
    climb(s, 300, true);
    expect(s.sim.stats.wallJumps).toBe(0);
    expect(s.sim.feetY(s.me)).toBeLessThan(-1);
  });

  test("never over the void: beside the arena's outer face there is no kick", () => {
    // the ground ends at x = 0 (cells 0-39); the fighter falls past its face
    const s = scene(() => {}, 0.6, 2, [0, 40]);
    s.run(30, () => {
      s.inputs[0] = { ...NO_INPUT, move: -1, jump: true };
    });
    expect(s.sim.stats.wallJumps).toBe(0);
  });
});

describe("digging punches break soft cells only (#100)", () => {
  test("dirt goes, rock stays", () => {
    const s = scene((g) => {
      for (let cy = 12; cy < 16; cy++) g.set(42, cy, Mat.Dirt); // a dirt wall to the right (x 1..1.5)
      for (let cy = 12; cy < 16; cy++) g.set(37, cy, Mat.Rock); // a rock wall to the left (x -1.5..-1)
    }, 0, 0);
    const swing = (aimX: number) =>
      s.run(200, (t) => {
        s.inputs[0] = { ...NO_INPUT, weapon: "fist", aimX, aimY: 0, fire: t % 2 === 0, dig: true };
      });
    swing(1);
    swing(-1);
    const g = s.sim.grid;
    expect([12, 13, 14].some((cy) => g.matAt(42, cy) === Mat.Empty)).toBe(true);
    expect([12, 13, 14, 15].every((cy) => g.matAt(37, cy) === Mat.Rock)).toBe(true);
    expect(s.sim.stats.digPunches).toBeGreaterThan(0);
    void CELL;
  });
});
