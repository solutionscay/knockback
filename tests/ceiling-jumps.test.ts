/**
 * Contract: a higher jump never loses a route (#84). A jump under a ceiling is flown the same way by the planner
 * (NavGraph.arcClear / flightAim) and by the controller: hold beside the ceiling's edge until the body fits under it,
 * then go under, never over onto the platform. A link a weaker profile makes and a stronger one cannot fly at its own
 * jump is flown at the weaker profile (a capped run and a short hop), so a stronger profile reaches every surface a
 * weaker one reaches.
 *
 * The generated level of seed 4 (Classic, the case #79 found) and a hand-built level; house controllers. No real time,
 * no network, no provider.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { CLASSIC, CLOSE_QUARTERS, Grid, initPhysics, Mat, NO_INPUT, resolveRuleset, Sim, type Fighter, type Input, type LevelDef, type Ruleset } from "../src/sim";
import { fighterStats, NEUTRAL_BUILD, type Build } from "../src/sim/build";
import { Controller } from "../src/sim/controller";
import { generateLevel } from "../src/sim/levelgen";
import { NavGraph } from "../src/sim/nav";

beforeAll(async () => {
  await initPhysics();
});

const F = CLASSIC.combat.fighter;
const build = (b: Partial<Build>): Build => ({ ...NEUTRAL_BUILD, ...b });
const JUMP2 = build({ jump: 2, health: -1, power: -1 });
/** no zone pressure, no drops, no pickups lying about */
const QUIET = resolveRuleset({ pickups: { supply: { firstTick: 36_000 }, armory: { nearSpawn: 0, middle: 0, high: 0, spread: { skyDrops: 0 } } } });

/** The navigation graph of a build's mobility profile (only speed and jump matter). */
const graph = (grid: Grid, ruleset: Ruleset, b: Build) => {
  const st = fighterStats(ruleset, b);
  return NavGraph.fromGrid(grid, 2, ruleset).withMobility({ walkSpeed: st.walkSpeed, jumpSpeed: st.jumpSpeed, airAccel: st.airAccel });
};

/**
 * Seat 0 plays `b` with a house controller (item stance: it goes for the one bat), standing at (x, feet); the other
 * seats stand still where `parked` puts them. Runs until seat 0 holds the bat or `ticks` pass; reports each tick.
 */
function fetchBat(lv: LevelDef, b: Build, start: [number, number], bat: [number, number], parked: [number, number][], ticks: number, each: (sim: Sim, me: Fighter) => void) {
  const sim = new Sim(1, lv, undefined, QUIET, [b]);
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
  // (underside 5.5). Before #84 a +1 or +2 jump rose past the platform's edge and landed on top of it.
  const lv4 = () => generateLevel(4, undefined, CLASSIC);
  const seed4Link = (nav: NavGraph) => nav.links.find((l) => nav.surfaces[l.from]!.x0 === 19.5 && nav.surfaces[l.from]!.y === 2 && nav.surfaces[l.to]!.x1 === 19.5 && nav.surfaces[l.to]!.y === 3)!;

  test("seed 4: a +2-jump fighter plans the jump under the platform and lands on the link's target, never on the platform", () => {
    const lv = lv4();
    const nav = graph(lv.grid, CLASSIC, JUMP2);
    const link = seed4Link(nav);
    const from = nav.surfaces[link.from]!, to = nav.surfaces[link.to]!;
    const platform = nav.surfaces.find((s) => s.y === 6 && s.x0 === 14.5)!;
    expect(nav.fighterPlan(lv.grid, from.id, 22).cost[to.id]).toBeLessThan(Infinity);
    // under the platform, on the link's target: the bat
    let landed = -1, onPlatform = false;
    const { me } = fetchBat(lv, JUMP2, [22, from.y], [16, to.y + 0.4], [[-29.8, 4], [-9.3, 3], [9.7, 6.5]], 400, (sim, f) => {
      if (f.grounded && f.surface === to.id && landed < 0) landed = sim.tick;
      if (f.surface === platform.id && sim.feetY(f) > platform.y - 0.2) onPlatform = true;
    });
    expect(landed).toBeGreaterThan(0);
    expect(onPlatform).toBe(false);
    expect(me.pickups).toContain("bat");
  });

  test("under a ceiling the body holds beside its edge, then goes under: the +2 jump flies the seed 4 link at its own jump", () => {
    const lv = lv4();
    for (const jump of [1, 2]) {
      const nav = graph(lv.grid, CLASSIC, build({ jump, health: -jump }));
      expect(nav.flight(lv.grid, seed4Link(nav))).toBe(nav.mobility);
    }
    // the flight rule, beside the platform's edge (x 19.5; the platform ends at 19, its top is 6):
    const nav = graph(lv.grid, CLASSIC, JUMP2);
    const link = seed4Link(nav);
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

  test("the planner's arc under a ceiling: each clause of the flight rule keeps a jump every profile flies at its own speed", () => {
    // [seed, from, to] (x0, x1, y), Classic; each row breaks when one clause of flightAim or arcClear is taken out
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
      const lv = generateLevel(seed, undefined, CLASSIC);
      for (const jump of [0, 1, 2]) {
        const nav = graph(lv.grid, CLASSIC, build({ jump }));
        const l = nav.links.find((k) => {
          const f = nav.surfaces[k.from]!, t = nav.surfaces[k.to]!;
          return f.x0 === a[0] && f.x1 === a[1] && f.y === a[2] && t.x0 === b[0] && t.x1 === b[1] && t.y === b[2];
        })!;
        expect({ seed, jump, why, own: nav.flight(lv.grid, l) === nav.mobility }).toEqual({ seed, jump, why, own: true });
      }
    }
  });

  // a ledge 3 m up with a slab 2 m above it (underside 5): a neutral jump tops out inside that window, a +2 jump shoots
  // through it and hits the slab's side
  const windowLevel = (): LevelDef => {
    const minX = -20, width = 40;
    const grid = new Grid(width * 2, 40, minX, -5);
    const fill = (x0: number, x1: number, y0: number, y1: number) => grid.fillRect(grid.cx(x0), grid.cy(y0), grid.cx(x1 - 0.01), grid.cy(y1 - 0.01), Mat.Bedrock);
    fill(-20, 20, -5, 0);
    fill(2, 8, 2.5, 3);
    fill(1.5, 12, 5, 5.5);
    return {
      seed: 0, attempt: 0, theme: "warehouse", name: "test", width, minX, maxX: minX + width, grid, props: [],
      spawns: [-15, -5, 15, 18].map((x) => ({ x, y: 0 })), pits: [], zoneCenter: 0, platforms: 0, towers: 0, bridges: 0,
    };
  };

  test("a jump only a weaker profile makes is flown at that profile: a short hop the body really jumps", () => {
    const lv = windowLevel();
    const nav = graph(lv.grid, CLASSIC, JUMP2);
    const floor = nav.surfaces.find((s) => s.y === 0)!, ledge = nav.surfaces.find((s) => s.y === 3)!;
    const up = nav.links.find((l) => l.from === floor.id && l.to === ledge.id && l.takeoffX < ledge.x0)!;
    expect(nav.arcClear(lv.grid, up)).toBe(false); // its own jump cannot
    const fl = nav.flight(lv.grid, up)!;
    expect(fl.jumpSpeed).toBeLessThan(nav.mobility.jumpSpeed);
    expect(nav.fighterPlan(lv.grid, floor.id, -4).cost[ledge.id]).toBeLessThan(Infinity);
    // the body: it jumps at the flight's take-off speed (a short hop, read one physics step after the jump: a little
    // under it; a full +2 jump reads above 12.7) and gets onto the ledge
    let takeoff = NaN, landed = false;
    const { me } = fetchBat(lv, JUMP2, [-4, 0], [5, 3.4], [[-15, 0], [15, 0], [18, 0]], 300, (sim, f) => {
      const v = sim.vel(f).y;
      if (Number.isNaN(takeoff) && v > 3) takeoff = v;
      if (f.grounded && f.surface === ledge.id) landed = true;
    });
    expect(takeoff).toBeLessThan(fl.jumpSpeed);
    expect(takeoff).toBeGreaterThan(fl.jumpSpeed - 1);
    expect(landed).toBe(true);
    expect(me.pickups).toContain("bat");
  });

  test("a drop only a slower profile makes is run at that profile's walk speed, and the body makes it", () => {
    // seed 30, Classic: a drop off the right end of [-2.5, 4] at y 4 to the floor at y 0, with a platform [5.5, 10.5]
    // at y 3.5 just 1.5 m on: walked off at a +2 speed, the body flies onto that platform; at the base speed it drops
    const lv = generateLevel(30, undefined, CLASSIC);
    const fast = build({ speed: 2, health: -1, power: -1 });
    const nav = graph(lv.grid, CLASSIC, fast);
    const top = nav.surfaces.find((s) => s.x0 === -2.5 && s.y === 4)!, floor = nav.surfaces.find((s) => s.x0 === -1 && s.y === 0)!;
    const ledge = nav.surfaces.find((s) => s.x0 === 5.5 && s.y === 3.5)!;
    const drop = nav.links.find((l) => l.kind === "drop" && l.from === top.id && l.to === floor.id && l.landX > l.takeoffX)!;
    const fl = nav.flight(lv.grid, drop)!;
    expect(fl.walkSpeed).toBeLessThan(nav.mobility.walkSpeed);
    let onLedge = false, onFloor = false;
    const { me } = fetchBat(lv, fast, [1, 4], [8, 0.4], [[-29.3, 1], [-11.3, 1], [33.2, 1]], 300, (sim, f) => {
      if (f.grounded && f.surface === ledge.id) onLedge = true;
      if (f.grounded && f.surface === floor.id) onFloor = true;
    });
    expect(onLedge).toBe(false);
    expect(onFloor).toBe(true);
    expect(me.pickups).toContain("bat");
  });

  test("a stronger mobility profile reaches every surface a weaker one reaches (generated levels, both presets)", () => {
    const profiles: [number, number][] = [];
    for (let speed = 0; speed <= 2; speed++) for (let jump = 0; jump <= 2; jump++) profiles.push([speed, jump]);
    const losses: string[] = [];
    for (const ruleset of [CLASSIC, CLOSE_QUARTERS])
      for (let seed = 1; seed <= 12; seed++) {
        const lv = generateLevel(seed, undefined, ruleset);
        const navs = profiles.map(([speed, jump]) => graph(lv.grid, ruleset, build({ speed, jump })));
        for (const sp of lv.spawns) {
          const s = navs[0]!.surfaceAt(sp.x, sp.y + 0.05, 0);
          if (!s) continue;
          const cost = navs.map((n) => n.fighterPlan(lv.grid, s.id, sp.x).cost);
          profiles.forEach(([ps, pj], a) =>
            profiles.forEach(([qs, qj], b) => {
              if (qs > ps || qj > pj) return;
              const lost = cost[b]!.findIndex((c, i) => c !== Infinity && cost[a]![i] === Infinity);
              if (lost >= 0) losses.push(`${ruleset === CLASSIC ? "classic" : "close quarters"} seed ${seed}: (${ps},${pj}) loses surface ${lost} that (${qs},${qj}) reaches`);
            }),
          );
        }
      }
    expect(losses).toEqual([]);
  });
});
