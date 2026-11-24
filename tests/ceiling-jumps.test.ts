/**
 * Contract (#84): a jump under a ceiling is flown the same way by the planner (NavGraph.arcClear / flightAim) and by the
 * controller: hold beside the ceiling's edge until the body fits under it, then go under, never over onto the platform.
 * A link is run up to and flown at the base walk speed the planner flew it at, also with the Speed power-up.
 *
 * The generated level of seed 4 (Classic, the case #79 found) and a hand-built level; house controllers. No real time,
 * no network, no provider.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { CLASSIC, initPhysics, NO_INPUT, resolveRuleset, Sim, type Fighter, type Input, type LevelDef } from "../src/sim";
import { Controller } from "../src/sim/controller";
import { generateLevel } from "../src/sim/levelgen";
import { NavGraph } from "../src/sim/nav";

beforeAll(async () => {
  await initPhysics();
});

const F = CLASSIC.combat.fighter;
/** The level data these seeds were picked with (before #100: more pits, flat roofs, bridges, no jump-through platforms,
 * no hard frame, and the four themes before the beach, #111): the same seeds, the same levels. */
const OLD_STAGE = { oneWay: 0, catwalk: false, frame: 0 };
const PITTED = resolveRuleset({ arena: { enabledThemes: ["warehouse", "rooftop", "junkyard", "construction"], themes: {
  warehouse: { pitChance: 0.6, extraPits: [0, 1], stage: OLD_STAGE },
  rooftop: { pitChance: 0.85, extraPits: [1, 2], ground: { heights: "roof", runs: "whole", steps: false }, stage: OLD_STAGE },
  junkyard: { pitChance: 0.55, extraPits: [0, 1], stage: OLD_STAGE }, construction: { pitChance: 0.6, extraPits: [0, 1], stage: OLD_STAGE },
} } });
/** no zone pressure, no drops, no pickups lying about */
const QUIET = resolveRuleset({ pickups: { supply: { firstTick: 36_000 }, armory: { nearSpawn: 0, middle: 0, high: 0, spread: { skyDrops: 0 } } } });

/**
 * Seat 0 plays a house controller (item stance: it goes for the one bat), standing at (x, feet); the other seats stand
 * still where `parked` puts them. Runs until seat 0 holds the bat or `ticks` pass; reports each tick.
 */
function fetchBat(lv: LevelDef, start: [number, number], bat: [number, number], parked: [number, number][], ticks: number, each: (sim: Sim, me: Fighter) => void) {
  const sim = new Sim(1, lv, undefined, QUIET);
  sim.zoneEnabled = false;
  for (const it of sim.items()) sim.entityStore.remove(it);
  const spots = [start, ...parked];
  sim.fighters.forEach((f, i) => {
    f.entity.body.setTranslation({ x: spots[i]![0], y: spots[i]![1] + F.halfHeight + F.radius + 0.02 }, true);
    f.entity.body.setLinvel({ x: 0, y: 0 }, true);
  });
  const inputs: Input[] = [NO_INPUT, NO_INPUT, NO_INPUT, NO_INPUT];
  for (let i = 0; i < 20; i++) sim.step(inputs); // settle
  sim.spawnItem("bat", bat[0], bat[1]);
  const me = sim.fighters[0]!;
  const c = new Controller(0, 0);
  c.peers = [c];
  c.setStrategy({ target: "nearest", stance: "item", weapons: ["bat"], line: "" }, sim);
  while (sim.tick < ticks && !me.pickups.includes("bat")) {
    inputs[0] = c.think(sim);
    sim.step(inputs);
    each(sim, me);
  }
  return { sim, me };
}

describe("ceiling jumps (#84)", () => {
  // seed 4, Classic: a jump from [19.5, 23.5] at y 2 up onto [-0.5, 19.5] at y 3, under a platform [14.5, 19] at y 6
  // (underside 5.5). A body that rises past the platform's edge lands on top of it.
  const lv4 = () => generateLevel(4, undefined, PITTED);
  const seed4Link = (nav: NavGraph) => nav.links.find((l) => nav.surfaces[l.from]!.x0 === 19.5 && nav.surfaces[l.from]!.y === 2 && nav.surfaces[l.to]!.x1 === 19.5 && nav.surfaces[l.to]!.y === 3)!;

  test("seed 4: a fighter plans the jump under the platform and lands on the link's target, never on the platform", () => {
    const lv = lv4();
    const nav = NavGraph.fromGrid(lv.grid, 2, CLASSIC);
    const link = seed4Link(nav);
    const from = nav.surfaces[link.from]!, to = nav.surfaces[link.to]!;
    const platform = nav.surfaces.find((s) => s.y === 6 && s.x0 === 14.5)!;
    expect(nav.fighterPlan(lv.grid, from.id, 22).cost[to.id]).toBeLessThan(Infinity);
    // under the platform, on the link's target: the bat
    let landed = -1, onPlatform = false;
    const { me } = fetchBat(lv, [22, from.y], [16, to.y + 0.4], [[-29.8, 4], [-9.3, 3], [9.7, 6.5]], 400, (sim, f) => {
      if (f.grounded && f.surface === to.id && landed < 0) landed = sim.tick;
      if (f.surface === platform.id && sim.feetY(f) > platform.y - 0.2) onPlatform = true;
    });
    expect(landed).toBeGreaterThan(0);
    expect(onPlatform).toBe(false);
    expect(me.pickups).toContain("bat");
  });

  test("under a ceiling the body holds beside its edge, then goes under", () => {
    const lv = lv4();
    // the flight rule, beside the platform's edge (x 19.5; the platform ends at 19, its top is 6):
    const nav = NavGraph.fromGrid(lv.grid, 2, CLASSIC);
    const link = seed4Link(nav);
    expect(nav.canFly(lv.grid, link)).toBe(true);
    // rising fast enough to get onto the platform, too tall to pass under it: hold beside its edge (19 + the body box)
    const hold = nav.flightAim(lv.grid, link, 19.5, 5, -1, 7.8);
    expect(hold).toBeGreaterThan(19.3);
    expect(hold).toBeLessThan(19.6);
    // as fast, but low enough to pass under it now: go under, for the landing
    expect(nav.flightAim(lv.grid, link, 19.5, 3.8, -1, 9)).toBe(link.landX);
    // coming down from above the platform's top: hold until the feet are low enough, then go under
    expect(nav.flightAim(lv.grid, link, 19.5, 5.8, -1, -1)).toBeGreaterThan(19.3);
    expect(nav.flightAim(lv.grid, link, 19.5, 3.8, -1, -6)).toBe(link.landX);
  });

  test("the planner's arc under a ceiling: each clause of the flight rule keeps a jump a fighter can fly", () => {
    // [seed, from, to] (x0, x1, y), Classic: links under a ceiling, each named for the clause of flightAim or arcClear it
    // needs. Some clauses bit only for the +1 and +2 jumps of the old speed and jump builds (the braking hold of seed
    // 32 is one); with one mobility the golden hashes keep them.
    const cases: [number, [number, number, number], [number, number, number], string][] = [
      [10, [4, 13, 2], [15, 19, 3], "a ceiling stops the rise where the head meets it, not a whole step (0.4 m) short"],
      [32, [-22, -16, 2], [-13, -3, 0], "a hold started at full speed brakes in time to stop beside the platform"],
      [68, [17, 31, 0], [5, 17, 1], "the landing is under the platform when the body's front is, not only its middle"],
      [15, [13, 14, 2.5], [17, 20.5, 2], "the platform over the landing ends where the overhang stops overlapping it"],
      [4, [-25.5, -22.5, 9.5], [-34, -28, 4], "a platform below the takeoff is flown over, not waited under"],
      [1, [-16.5, -10, 5], [-28, -17.5, 0], "a platform the body cannot rise onto is no reason to hold (a drop past one level with it)"],
      [73, [3, 10, 9], [13.5, 20, 8], "a platform that does not overhang the landing is flown over"],
    ];
    for (const [seed, a, b, why] of cases) {
      const lv = generateLevel(seed, undefined, PITTED);
      const nav = NavGraph.fromGrid(lv.grid, 2, CLASSIC);
      const l = nav.links.find((k) => {
        const f = nav.surfaces[k.from]!, t = nav.surfaces[k.to]!;
        return f.x0 === a[0] && f.x1 === a[1] && f.y === a[2] && t.x0 === b[0] && t.x1 === b[1] && t.y === b[2];
      });
      expect({ seed, why, flies: !!l && nav.canFly(lv.grid, l) }).toEqual({ seed, why, flies: true });
    }
  });

  test("with the Speed power-up the way down to the floor is still flown at the base speed the planner flew", () => {
    // seed 30, Classic: off the right end of [-2.5, 4] at y 4 down to the floor at y 0, with a platform [5.5, 10.5]
    // at y 3.5 just 1.5 m on: flown at Speed power-up speed, the body can carry onto that platform
    const lv = generateLevel(30, undefined, PITTED);
    const nav = NavGraph.fromGrid(lv.grid, 2, CLASSIC);
    const top = nav.surfaces.find((s) => s.x0 === -2.5 && s.y === 4)!, floor = nav.surfaces.find((s) => s.x0 === -1 && s.y === 0)!;
    const ledge = nav.surfaces.find((s) => s.x0 === 5.5 && s.y === 3.5)!;
    const drop = nav.links.find((l) => l.kind === "drop" && l.from === top.id && l.to === floor.id && l.landX > l.takeoffX)!;
    expect(nav.canFly(lv.grid, drop)).toBe(true);
    let onLedge = false, onFloor = false, topSpeed = 0;
    fetchBat(lv, [1, 4], [8, 0.4], [[-29.3, 1], [-11.3, 1], [33.2, 1]], 300, (sim, f) => {
      f.power.speed = 600;
      // the flight off the top, while the body is still above it
      if (!onFloor && sim.feetY(f) > top.y + 0.2) topSpeed = Math.max(topSpeed, Math.abs(sim.vel(f).x));
      if (f.grounded && f.surface === ledge.id) onLedge = true;
      if (f.grounded && f.surface === floor.id) onFloor = true;
    });
    // off the top: never faster than the planner's base walk speed (the Speed power-up alone runs about 9 m/s)
    expect(topSpeed).toBeLessThan(F.walkSpeed + 0.05);
    expect(topSpeed).toBeGreaterThan(F.walkSpeed - 0.5);
    expect(onLedge).toBe(false);
    expect(onFloor).toBe(true);
  });
});
