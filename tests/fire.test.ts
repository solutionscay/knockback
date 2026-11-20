import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CHAIN, FIRE, initPhysics, Mat, WEAPONS, type Input } from "../src/sim";
import { F_CHARRED } from "../src/sim/grid";
import { igniteCell, igniteFighter, igniteProp } from "../src/sim/sim-fire";
import { idle, place, sandbox, stepN } from "./helpers";

beforeAll(async () => {
  await initPhysics();
});

// sandbox: flat dirt ground (top y 0), steel platform y 3.5..4 at x -6..0 with chains at both ends
const flame = (aimX = 1, aimY = 0): Input => ({ move: 0, jump: false, aimX, aimY, weapon: "flamethrower", fire: true });
const only = (id: number, input: Input): Input[] => idle().map((x, i) => (i === id ? input : x));
const arm = (sim: ReturnType<typeof sandbox>, id: number) => {
  const f = sim.fighters[id]!;
  sim.applyItem(f, "flamethrower");
  f.swap = 0;
  return f;
};
/** make the sandbox platform wooden planks */
const woodPlatform = (sim: ReturnType<typeof sandbox>) => {
  const g = sim.grid;
  const py = g.cy(4) - 1;
  for (let cx = g.cx(-6); cx < g.cx(0); cx++) {
    const i = g.idx(cx, py);
    g.mat[i] = Mat.Wood;
    g.hp[i] = 20;
  }
  return py;
};

describe("flamethrower (#32)", () => {
  test("a pulse hurts a fighter in the cone, pushes lightly, sets them alight and uses fuel; out of range is safe", () => {
    const sim = sandbox();
    const f = arm(sim, 0);
    expect(f.fuel).toBe(WEAPONS.flamethrower.fuel);
    place(sim, 0, -20, 0.9);
    const near = place(sim, 1, -17.5, 0.9);
    const hp0 = near.hp;
    const evs = stepN(sim, 1, only(0, flame(1, 0)));
    expect(evs.some((e) => e.type === "fire" && e.weapon === "flamethrower")).toBe(true);
    expect(near.hp).toBeLessThan(hp0);
    expect(near.burning).toBeGreaterThanOrEqual(FIRE.fighterTicks - 1); // it already burned for this tick
    expect(near.burnBy).toBe(0);
    expect(near.burnCause).toBe("flamethrower");
    expect(Math.abs(near.entity.body.linvel().x)).toBeLessThan(4); // a light push, not a launch
    expect(f.fuel).toBe(WEAPONS.flamethrower.fuel - 1);

    const sim2 = sandbox();
    arm(sim2, 0);
    place(sim2, 0, -20, 0.9);
    const far = place(sim2, 1, -20 + WEAPONS.flamethrower.range + 1.5, 0.9);
    stepN(sim2, 1, only(0, flame(1, 0)));
    expect(far.hp).toBe(100);
    expect(far.burning).toBe(0);
  });

  test("burning hurts over time, credited to whoever lit it, and a flame kill counts as the flamethrower", () => {
    const sim = sandbox();
    const v = place(sim, 1, -17, 0.9);
    igniteFighter(sim, v, 0, "flamethrower");
    const evs = stepN(sim, FIRE.fighterTicks + 5);
    const burns = evs.filter((e) => e.type === "hit" && e.target === 1);
    expect(burns.length).toBeGreaterThanOrEqual(4);
    expect(burns.every((e) => e.type === "hit" && e.source === 0 && e.cause === "flamethrower")).toBe(true);
    expect(v.burning).toBe(0);
    expect(100 - v.hp).toBeCloseTo(FIRE.fighterDps * (FIRE.fighterTicks / 60), 0);

    const sim2 = sandbox();
    const w = place(sim2, 1, -17, 0.9);
    w.hp = 1;
    igniteFighter(sim2, w, 0, "flamethrower");
    const ko = stepN(sim2, 40).find((e) => e.type === "ko");
    expect(ko).toMatchObject({ fighter: 1, by: 0, weapon: "flamethrower" });
  });

  test("an empty tank is thrown away", () => {
    const sim = sandbox();
    const f = arm(sim, 0);
    f.fuel = 2;
    place(sim, 0, -20, 0.9);
    const evs = stepN(sim, 12, only(0, flame(1, 0)));
    expect(evs.filter((e) => e.type === "fire" && e.weapon === "flamethrower").length).toBe(2);
    expect(evs.some((e) => e.type === "fuelOut" && e.fighter === 0)).toBe(true);
    expect(f.weapons).not.toContain("flamethrower");
  });
});

describe("fire (#33)", () => {
  test("a burning plank spreads along the platform, then chars or burns away; steel never catches", () => {
    const sim = sandbox();
    const g = sim.grid;
    const py = woodPlatform(sim);
    const mid = g.cx(-3);
    expect(igniteCell(sim, mid, py, 2, "flame")).toBe(true);
    expect(sim.stats.firesStarted).toBe(1);
    let most = 0;
    for (let i = 0; i < 60 * 12; i++) {
      stepN(sim, 1);
      most = Math.max(most, sim.fires.size);
    }
    expect(most).toBeGreaterThan(2); // it spread
    expect(sim.stats.cellsIgnited).toBeGreaterThan(2);
    expect(sim.stats.cellsBurnedDown + sim.stats.cellsBurnedOut).toBeGreaterThan(0);
    // every plank that burned out is charred and won't catch again
    for (let cx = g.cx(-6); cx < g.cx(0); cx++) {
      const i = g.idx(cx, py);
      if (g.mat[i] && g.flags[i]! & F_CHARRED) expect(igniteCell(sim, cx, py, 2, "flame")).toBe(false);
    }
    // the steel version doesn't burn at all
    const s2 = sandbox();
    expect(igniteCell(s2, mid, py, 2, "flame")).toBe(false);
    expect(igniteCell(s2, mid, s2.grid.cy(-1), 2, "flame")).toBe(false); // dirt
  });

  test("a burning anchor eats its chain: the platform swings (#34)", () => {
    const sim = sandbox();
    const g = sim.grid;
    const py = woodPlatform(sim);
    const ch = sim.chains[0]!;
    igniteCell(sim, ch.cx, ch.cy, 3, "flame");
    let evs: ReturnType<typeof stepN> = [];
    for (let i = 0; i < 60 * 8 && !ch.broken; i++) evs = evs.concat(stepN(sim, 1));
    expect(ch.broken).toBe(true);
    expect(["fire", "anchor"]).toContain(ch.cause);
    expect(evs.some((e) => e.type === "platformSwing")).toBe(true);
    expect(g.solid(g.cx(-3), py)).toBe(false); // the platform came loose
  });

  test("a chain burned on purpose: its hit points drop while its anchor burns", () => {
    const sim = sandbox();
    woodPlatform(sim);
    const ch = sim.chains[1]!;
    igniteCell(sim, ch.cx, ch.cy, 3, "flame");
    stepN(sim, FIRE.step * 3);
    expect(ch.hp).toBeLessThan(CHAIN.hp);
    expect(ch.lastHitBy).toBe(3);
  });

  test("crates burn down; barrels and TNT that catch fire go off", () => {
    const sim = sandbox([
      { kind: "crate", x: -12, y: 0 },
      { kind: "barrel", x: 4, y: 0 },
      { kind: "tnt", x: 8, y: 0 },
    ]);
    const of = (k: string) => [...sim.entities.values()].find((e) => e.kind === k)!;
    const crate = of("crate"), barrel = of("barrel"), tnt = of("tnt");
    expect(igniteProp(sim, crate, 1, "flame")).toBe(true);
    expect(igniteProp(sim, barrel, 1, "flame")).toBe(true);
    expect(igniteProp(sim, tnt, 1, "flame")).toBe(true);
    expect(barrel.fuse).toBeDefined();
    expect(tnt.fuse).toBeDefined();
    const evs = stepN(sim, 60 * 6);
    expect(evs.filter((e) => e.type === "explosion").length).toBeGreaterThanOrEqual(2);
    expect(crate.dead).toBe(true);
    expect(evs.some((e) => e.type === "break" && e.kind === "crate")).toBe(true);
  });

  test("a fighter standing on burning planks catches fire and is hurt, credited to whoever lit them", () => {
    const sim = sandbox();
    const g = sim.grid;
    const py = woodPlatform(sim);
    const v = place(sim, 2, -3, 4 + 0.9);
    stepN(sim, 10);
    igniteCell(sim, g.cx(-3), py, 1, "flame");
    const evs = stepN(sim, 90);
    expect(evs.find((e) => e.type === "burn" && e.fighter === 2)).toMatchObject({ by: 1, cause: "fire" });
    expect(evs.some((e) => e.type === "hit" && e.target === 2 && e.source === 1 && e.cause === "fire")).toBe(true);
    expect(v.hp).toBeLessThan(100);
  });

  test("a blast lights planks it leaves standing", () => {
    let lit = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const sim = sandbox([], seed);
      woodPlatform(sim);
      sim.explode(-3, 2.2, { radius: 2.4, damage: 0, knockback: 0, blockDamage: 0, terrainDamage: 30 }, "grenade", 0, 0, null);
      lit += sim.fires.size;
    }
    expect(lit).toBeGreaterThan(0);
  });

  test("fire is deterministic: the same start burns the same way", () => {
    const run = () => {
      const sim = sandbox();
      const py = woodPlatform(sim);
      igniteCell(sim, sim.grid.cx(-4), py, 0, "flame");
      stepN(sim, 600);
      return sim.hash();
    };
    expect(run()).toBe(run());
  });

  test("no trig in the fire code (engines differ on Math.sin/cos)", () => {
    const src = readFileSync(`${import.meta.dir}/../src/sim/sim-fire.ts`, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(src).not.toMatch(/Math\.(sin|cos|tan|atan2?|asin|acos|exp|log|pow)\b/);
  });
});
