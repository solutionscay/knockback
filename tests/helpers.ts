/** Test fixtures: a flat, hand-built level so physics tests are predictable. */
import { CELL, F_ANCHOR, Grid, Mat } from "../src/sim/grid";
import type { LevelDef, PropSpec } from "../src/sim/levelgen";
import { NO_INPUT, Sim, type Input } from "../src/sim/sim";

/**
 * 60 m wide. Ground (dirt, 2 bedrock rows at the bottom) from x=-28 to 28 with
 * its top at y=0, a pit at x 10..14, and one floating steel platform at y=4,
 * x -6..0, anchored at both ends.
 */
export function flatLevel(props: PropSpec[] = []): LevelDef {
  const W = 60;
  const grid = new Grid(W / CELL, 64, -W / 2, -8);
  for (let cx = 0; cx < grid.cols; cx++) {
    const x = grid.wx(cx) + CELL / 2;
    if (x < -28 || x > 28 || (x > 10 && x < 14)) continue;
    for (let cy = 0; cy < grid.cy(0); cy++) grid.set(cx, cy, cy < 2 ? Mat.Bedrock : Mat.Dirt);
  }
  const py = grid.cy(4) - 1;
  for (let cx = grid.cx(-6); cx < grid.cx(0); cx++) grid.set(cx, py, Mat.Steel);
  grid.flags[grid.idx(grid.cx(-6), py)]! |= F_ANCHOR;
  grid.flags[grid.idx(grid.cx(0) - 1, py)]! |= F_ANCHOR;
  return {
    seed: 0,
    attempt: 0,
    theme: "warehouse",
    name: "TEST",
    width: W,
    minX: -W / 2,
    maxX: W / 2,
    grid,
    props,
    spawns: [
      { x: -20, y: 0 },
      { x: -16, y: 0 },
      { x: 18, y: 0 },
      { x: 22, y: 0 },
    ],
    pits: [{ x0: 10, x1: 14 }],
    zoneCenter: 0,
    platforms: 1,
    towers: 0,
    bridges: 0,
  };
}

export function idle(): Input[] {
  return [NO_INPUT, NO_INPUT, NO_INPUT, NO_INPUT];
}

/** A sandbox sim on the flat level: zone off, fighters parked at known spots. */
export function sandbox(props: PropSpec[] = [], seed = 1): Sim {
  const sim = new Sim(seed, flatLevel(props));
  sim.zoneEnabled = false;
  for (const e of [...sim.entities.values()]) if (e.kind === "item") e.body.setTranslation({ x: 0, y: -30 }, true); // no stray pickups
  const spots = [-20, -16, 18, 22];
  sim.fighters.forEach((f, i) => {
    f.entity.body.setTranslation({ x: spots[i]!, y: 0.9 }, true);
    f.entity.body.setLinvel({ x: 0, y: 0 }, true);
  });
  for (let i = 0; i < 30; i++) sim.step(idle());
  sim.events = [];
  return sim;
}

export function place(sim: Sim, id: number, x: number, y: number) {
  const f = sim.fighters[id]!;
  f.entity.body.setTranslation({ x, y }, true);
  f.entity.body.setLinvel({ x: 0, y: 0 }, true);
  sim.step(idle()); // scene queries see the new position only after a step
  sim.events = [];
  return f;
}

export function stepN(sim: Sim, n: number, inputs: Input[] = idle()) {
  const evs: Sim["events"] = [];
  for (let i = 0; i < n; i++) {
    sim.step(inputs);
    evs.push(...sim.events);
    sim.events = [];
  }
  return evs;
}
