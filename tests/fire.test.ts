/**
 * Contract: fire (#33). Fire spreads through planks by seeded chance, eats the chain of a burning anchor (#34), burns
 * loose pieces down, and sets fighters who touch it alight, credited to whoever lit it. All of it is deterministic.
 *
 * The scene is built by hand (no level generator) and has no start weapons or supply drops (#95), so it moves only
 * when fire, blasts or chains change.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { CELL, F_ANCHOR, Grid, initPhysics, Mat, NO_INPUT, Sim, type LevelDef, type SimEvent } from "../src/sim";
import { resolveRuleset } from "../src/sim/ruleset";

/** Classic without start weapons or supply drops (#95): the scene moves only with fire, blasts and chains. */
const RULESET = resolveRuleset({ pickups: { armory: { spread: { startWeapons: 0, powerStart: 0, betweenCaches: 0, skyDrops: 0 } }, supply: { firstTick: 36_000 } } });
import { pieceCellWorld } from "../src/sim/terrain";

beforeAll(async () => {
  await initPhysics();
});

/** Concrete ground with its top at y = 0, a strip of planks in it with a crate on them, and two wooden platforms hung from chains. */
function scene() {
  const g = new Grid(80, 40, -20, -4);
  for (let cx = 0; cx < g.cols; cx++) for (let cy = 0; cy < 8; cy++) g.set(cx, cy, cy < 2 ? Mat.Bedrock : Mat.Concrete);
  for (let cx = 60; cx <= 70; cx++) g.set(cx, 7, Mat.Wood); // planks around x = 13
  const platform = (cx0: number, cx1: number) => {
    for (let cx = cx0; cx <= cx1; cx++) g.set(cx, 14, Mat.Wood);
    g.flags[g.idx(cx0, 14)]! |= F_ANCHOR;
    g.flags[g.idx(cx1, 14)]! |= F_ANCHOR;
  };
  platform(34, 45); // A: x -3..3, y 3
  platform(2, 9); // B: x -19..-15, y 3
  const level: LevelDef = {
    seed: 1, attempt: 0, theme: "warehouse", name: "FIRE", width: 40, minX: -20, maxX: 20, grid: g,
    props: [{ kind: "crate", x: 10.5, y: 0 }], spawns: [{ x: -9, y: 0 }, { x: -7, y: 0 }, { x: 13, y: 0 }, { x: 16, y: 0 }],
    pits: [], zoneCenter: 0, platforms: 2, towers: 0, walls: [], bridges: 0,
  };
  const sim = new Sim(1, level, undefined, RULESET);
  sim.zoneEnabled = false;
  const events: SimEvent[] = [];
  const run = (ticks: number) => {
    for (let t = 0; t < ticks; t++) {
      sim.step([NO_INPUT, NO_INPUT, NO_INPUT, NO_INPUT]);
      events.push(...sim.events);
      sim.events = [];
    }
  };
  const blast = (x: number, y: number, radius: number, chainDamage: number, owner: number) => {
    sim.explode(x, y, { radius, damage: 0, knockback: 0, blockDamage: chainDamage, terrainDamage: 0 }, "barrel", owner, 0, null);
    events.push(...sim.events);
    sim.events = [];
  };
  const cellCenter = (cx: number, cy: number) => ({ x: g.wx(cx) + CELL / 2, y: g.wy(cy) + CELL / 2 });
  const chunks = () => [...sim.entities.values()].filter((e) => e.kind === "chunk" && !e.dead);

  // A loses its left chain to a blast and swings down as a loose piece
  const a = cellCenter(34, 14);
  blast(a.x, a.y + 0.6, 1.5, 60, -1);
  // B and the planks are lit by blasts that do not touch the chains
  const onPlanks = sim.fighters.find((f) => Math.abs(sim.pos(f).x - 13) < 0.5)!;
  const lighter = (onPlanks.id + 1) % 4;
  const b = cellCenter(5, 14);
  blast(b.x + 0.25, b.y, 1.5, 0, lighter);
  const p = cellCenter(66, 7);
  blast(p.x + 1, p.y, 1.5, 0, lighter);
  run(120);
  const piece = chunks()[0]!; // B still hangs: A is the only loose piece
  const pieceCells = piece.cells!.length;
  const w = pieceCellWorld(piece.body.translation(), piece.body.rotation(), piece.cells![6]!);
  blast(w.x, w.y + 0.45, 2, 0, lighter); // off the cell, inside the 0.6 m reach of a blast on a piece
  run(900);
  return { sim, events, onPlanks, lighter, piece, pieceCells, chunks };
}

const once = <T>(make: () => T) => {
  let v: { value: T } | undefined;
  return () => (v ??= { value: make() }).value;
};
const burned = once(scene);

describe("fire", () => {
  test("a burning anchor eats its chain, and the platform that falls is credited to whoever lit it", () => {
    const { sim, events, lighter } = burned();
    const bChains = sim.chains.filter((c) => c.cx === 2 || c.cx === 9);
    expect(bChains.some((c) => c.broken && c.cause === "fire")).toBe(true);
    expect(events.find((e) => e.type === "platformFall")).toMatchObject({ x: -17, by: lighter });
    expect(sim.chains.find((c) => c.cx === 34)!.cause).toBe("barrel");
  });

  test("a loose piece lit by a blast burns down: cells char or burn away, and it breaks up", () => {
    const { events, piece, pieceCells, chunks } = burned();
    expect(events.some((e) => e.type === "ignite" && e.what === "piece")).toBe(true);
    const fallenB = events.find((e) => e.type === "platformFall")!;
    const left = chunks().filter((e) => fallenB.type === "platformFall" && e.id !== fallenB.entity).flatMap((e) => e.cells!);
    expect(piece.dead).toBe(true);
    expect(left.length).toBeLessThan(pieceCells);
    expect(left.some((c) => c.charred)).toBe(true);
  });

  test("a crate on burning planks catches and burns away", () => {
    const { sim, events, lighter } = burned();
    expect(events.find((e) => e.type === "ignite" && e.what === "prop")).toMatchObject({ source: "spread", by: lighter });
    expect([...sim.entities.values()].some((e) => e.kind === "crate" && !e.dead)).toBe(false);
    expect(sim.stats.propsBurnedOff).toBe(1);
  });

  test("fighters on burning planks catch fire, credited to whoever lit them, and are hurt; the others are not", () => {
    const { sim, events, onPlanks, lighter } = burned();
    const burns = events.filter((e) => e.type === "burn");
    expect(burns.map((e) => e.type === "burn" && e.fighter)).toContain(onPlanks.id);
    for (const e of burns) expect(e).toMatchObject({ by: lighter, cause: "fire" });
    expect(onPlanks.hp).toBeLessThan(100);
    const burnt = new Set(burns.map((e) => e.type === "burn" && e.fighter));
    for (const f of sim.fighters) if (!burnt.has(f.id)) expect(f.hp).toBe(100);
  });

  test("the same scene burns the same way: golden hash and counters", () => {
    const { sim } = burned();
    const again = scene().sim;
    expect(again.hash()).toBe(sim.hash());
    expect(again.stats).toEqual(sim.stats);
    const { firesStarted, cellsIgnited, cellsBurnedDown, cellsBurnedOut, propsIgnited, propsBurnedOff, fightersIgnited } = sim.stats;
    expect({ hash: sim.hash(), firesStarted, cellsIgnited, cellsBurnedDown, cellsBurnedOut, propsIgnited, propsBurnedOff, fightersIgnited }).toEqual({
      hash: "10b73476",
      firesStarted: 10,
      cellsIgnited: 31,
      cellsBurnedDown: 10,
      cellsBurnedOut: 14,
      propsIgnited: 1,
      propsBurnedOff: 1,
      fightersIgnited: 2,
    });
  });
});
