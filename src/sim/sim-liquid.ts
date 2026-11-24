/**
 * Liquids, sand, mud and ice in the sim (#94). The liquid layer is `Grid.liq` (whole cells, never solid); how it and
 * sand settle is liquid-flow.ts. This file is what they do:
 *
 * - Water slows a fighter in it, cancels most of gravity (a fighter in it sinks slowly; jump is a swim stroke), puts
 *   out a burning fighter, burning cells beside it and burning props in it.
 * - Oil is slippery. Fire (a burning cell beside it, a burning fighter or prop in it, a flame, a blast, lava) lights
 *   it: a burning oil cell burns fighters in or just over it, lights the oil and flammable cells beside it, and after
 *   `oil.burnTicks` is used up (gone).
 * - Lava and acid hurt a fighter in them over time (lava also sets them alight) and melt the solid cells beside them
 *   (bedrock never). Lava lights oil; lava meeting water cools to rock; lava melts ice into water.
 * - Slime (#125) is thick water: it slows more and floats a fighter (who sinks slower and swims out), and smothers fire.
 * - Mud slows whoever stands on it; ice is slippery (applyInput reads `footing`).
 *
 * The level settles one step every `liquids.flowTicks` ticks while the terrain changed since the last step (a carve
 * can open a basin); reactions and oil fires run on the same clock. Fixed scan orders, no RNG: the same in every
 * JS engine. A level with none of these (every current theme) never runs any of it, and its hash is unchanged.
 */
import RAPIER from "@dimforge/rapier2d-deterministic-compat";
import { DT } from "./constants";
import { CELL, Grid, Liquid, Mat, swimmable } from "./grid";
import { flowStep } from "./liquid-flow";
import type { Sim } from "./sim";
import { igniteCell, igniteFighter } from "./sim-ignite";
import { damageTerrainCell } from "./sim-terrain";
import type { Fighter } from "./sim-types";

export interface OilFire {
  /** ticks burning */
  t: number;
  /** who lit it (credit), or -1 */
  by: number;
}

/** #114: ticks before a fighter's next splash event (a swimmer's strokes splashed several times a second) */
const SPLASH_REARM = 45;

export class LiquidState {
  /** the level has liquids or #94 materials: everything here runs (else nothing does) */
  readonly on: boolean;
  /** the terrain changed since the last settle step that moved nothing */
  active = true;
  private lastVersion: number;
  private step = 0;
  /** burning oil cells: grid index -> fire */
  readonly oilFires = new Map<number, OilFire>();
  private readonly seen;
  /** per fighter: the liquid its body was in last tick (splash events) */
  readonly inside: number[] = [0, 0, 0, 0];
  /** #114: per fighter: the tick of its last splash event (a swimmer's every stroke re-enters the water) */
  readonly splashed: number[] = [-SPLASH_REARM, -SPLASH_REARM, -SPLASH_REARM, -SPLASH_REARM];
  /** per fighter: on slippery footing (its collider takes no friction from the ground) */
  readonly slick: boolean[] = [false, false, false, false];

  constructor(grid: Grid, version: number) {
    this.on = grid.hasLiquid() || grid.countMat(Mat.Sand) + grid.countMat(Mat.Mud) + grid.countMat(Mat.Ice) > 0;
    this.lastVersion = version;
    this.seen = new Uint8Array(grid.mat.length);
  }

  /** One settle step of the level, if the terrain changed. */
  settle(sim: Sim) {
    if (sim.terrain.version !== this.lastVersion) this.active = true;
    if (!this.active) return;
    const g = sim.grid;
    this.seen.fill(0);
    const moved = flowStep(g, this.step++, (a, b) => sim.terrain.moveCell(a, b), this.seen, (i) => sim.terrain.removeCell(i % g.cols, Math.floor(i / g.cols)));
    this.lastVersion = sim.terrain.version;
    if (!moved) this.active = false;
  }
}

/** The liquid a fighter's body is in: at its middle, else at its feet. */
export function bodyLiquid(sim: Sim, f: Fighter): number {
  const p = f.entity.body.translation();
  const g = sim.grid;
  return g.liquidAt(p.x, p.y) || g.liquidAt(p.x, sim.feetY(f) + 0.15);
}

export interface Footing {
  /** walk speed, ground acceleration and jump multipliers */
  speed: number;
  accel: number;
  jump: number;
  /** afloat in water or slime (a jump is a swim stroke) */
  swim: boolean;
}
const SURE: Footing = { speed: 1, accel: 1, jump: 1, swim: false };

/**
 * Slippery footing (ice, oil) takes the ground's contact friction away from the fighter (its collider combines
 * friction by Min: 0), so only its own grip (the lowered acceleration) slows it. Set only on a change.
 */
export function setSlick(sim: Sim, f: Fighter, slick: boolean) {
  if (sim.liquids.slick[f.id] === slick) return;
  sim.liquids.slick[f.id] = slick;
  f.entity.collider.setFrictionCombineRule(slick ? RAPIER.CoefficientCombineRule.Min : RAPIER.CoefficientCombineRule.Average);
}

/** What the fighter stands on and in (applyInput): mud, ice, water, oil. */
export function footing(sim: Sim, f: Fighter): Footing {
  if (!sim.liquids.on) return SURE;
  const L = sim.ruleset.liquids;
  let speed = 1;
  let accel = 1;
  let jump = 1;
  if (f.grounded) {
    const g = sim.grid;
    const p = f.entity.body.translation();
    const cy = g.cy(sim.feetY(f) - 0.1);
    let mud = 0;
    let ice = 0;
    for (const ox of [-0.3, 0, 0.3]) {
      const m = g.matAt(g.cx(p.x + ox), cy);
      if (m === Mat.Mud) mud++;
      else if (m === Mat.Ice) ice++;
    }
    // the most of the feet decides
    if (mud >= 2 || (mud === 1 && ice === 0 && g.matAt(g.cx(p.x), cy) === Mat.Mud)) {
      speed *= L.mud.speedMul;
      jump *= L.mud.jumpMul;
    } else if (ice >= 2 || (ice === 1 && g.matAt(g.cx(p.x), cy) === Mat.Ice)) accel *= L.ice.accelMul;
  }
  const liquid = bodyLiquid(sim, f);
  if (liquid === Liquid.Water) {
    speed *= L.water.speedMul;
    accel *= L.water.accelMul;
  } else if (liquid === Liquid.Slime) {
    speed *= L.slime.speedMul;
    accel *= L.slime.accelMul;
  } else if (liquid === Liquid.Oil) accel *= L.oil.accelMul;
  return { speed, accel, jump, swim: swimmable(liquid) && !f.grounded };
}

const N4: readonly [number, number][] = [
  [-1, 0],
  [1, 0],
  [0, 1],
  [0, -1],
];

/** Light the oil in cell (cx, cy). */
export function igniteOil(sim: Sim, cx: number, cy: number, by: number): boolean {
  const g = sim.grid;
  if (!g.inside(cx, cy)) return false;
  const i = g.idx(cx, cy);
  if (g.liq[i] !== Liquid.Oil || sim.liquids.oilFires.has(i)) return false;
  sim.liquids.oilFires.set(i, { t: 0, by });
  sim.events.push({ type: "ignite", tick: sim.tick, what: "oil", x: g.wx(cx) + CELL / 2, y: g.wy(cy) + CELL / 2, source: "oil", by });
  return true;
}

/** A blast or a flame lights the oil within r of (x, y). */
export function igniteOilNear(sim: Sim, x: number, y: number, r: number, by: number) {
  if (!sim.liquids.on) return;
  const g = sim.grid;
  for (let cy = Math.max(0, g.cy(y - r)); cy <= Math.min(g.rows - 1, g.cy(y + r)); cy++)
    for (let cx = Math.max(0, g.cx(x - r)); cx <= Math.min(g.cols - 1, g.cx(x + r)); cx++) {
      const px = g.wx(cx) + CELL / 2 - x;
      const py = g.wy(cy) + CELL / 2 - y;
      if (px * px + py * py <= r * r) igniteOil(sim, cx, cy, by);
    }
}

/** The tick's liquid update (Sim.step, before the physics step). */
export function updateLiquids(sim: Sim) {
  const L = sim.ruleset.liquids;
  const g = sim.grid;
  // fighters, every tick
  for (const f of sim.fighters) {
    if (!f.alive || f.removed) continue;
    const liquid = bodyLiquid(sim, f);
    const p = f.entity.body.translation();
    if (liquid !== sim.liquids.inside[f.id]) {
      if (liquid && sim.tick - sim.liquids.splashed[f.id]! >= SPLASH_REARM) {
        sim.events.push({ type: "splash", tick: sim.tick, fighter: f.id, liquid, x: p.x, y: p.y });
        sim.liquids.splashed[f.id] = sim.tick;
      }
      sim.liquids.inside[f.id] = liquid;
    }
    if (swimmable(liquid)) {
      if (f.burning > 0) {
        f.burning = 0;
        sim.events.push({ type: "douse", tick: sim.tick, fighter: f.id, x: p.x, y: p.y });
      }
      // buoyancy: most of gravity cancelled, and a slow sink at most
      const W = liquid === Liquid.Slime ? L.slime : L.water;
      const v = f.entity.body.linvel();
      let vy = v.y + sim.ruleset.combat.gravity * W.buoyancy * DT;
      if (vy < -W.sinkSpeed) vy = -W.sinkSpeed;
      f.entity.body.setLinvel({ x: v.x, y: vy }, true);
    } else if (liquid === Liquid.Oil) {
      if (f.burning > 0) igniteOil(sim, g.cx(p.x), g.cy(sim.feetY(f) + 0.15), f.burnBy);
    } else if (liquid === Liquid.Lava || liquid === Liquid.Acid) {
      const dps = liquid === Liquid.Lava ? L.lava.dps : L.acid.dps;
      const cause = liquid === Liquid.Lava ? "lava" : "acid";
      // credit: whoever knocked them in, if lately (knockOut's attribution); the clock is staggered per seat
      if ((sim.tick + f.id * 11) % 15 === 0) sim.damageFighter(f, dps * 15 * DT, -1, 0, 0, cause, p.x, p.y);
      if (liquid === Liquid.Lava && f.alive) igniteFighter(sim, f, f.lastHitBy, "lava");
    }
  }
  // burning oil burns what is in or just over it
  if (sim.liquids.oilFires.size) {
    for (const f of sim.fighters) {
      if (!f.alive || f.removed) continue;
      const p = f.entity.body.translation();
      const feet = sim.feetY(f);
      for (const y of [feet - 0.3, feet + 0.15, p.y]) {
        if (!g.inside(g.cx(p.x), g.cy(y))) continue;
        const fire = sim.liquids.oilFires.get(g.idx(g.cx(p.x), g.cy(y)));
        if (fire) {
          igniteFighter(sim, f, fire.by, "oil");
          if ((sim.tick + f.id * 5) % 15 === 0) sim.damageFighter(f, L.oil.dps * 15 * DT, -1, 0, 0, "oil", p.x, p.y);
          break;
        }
      }
    }
  }
  if (sim.tick % L.flowTicks !== 0) return;
  sim.liquids.settle(sim);
  react(sim);
  burnOil(sim);
  // props: burning ones light oil, water puts them out
  for (const e of sim.entities.values()) {
    if (e.dead || e.kind === "fighter" || e.kind === "chunk") continue;
    const t = e.body.translation();
    const at = g.liquidAt(t.x, t.y - e.hh + 0.1);
    if (!at) continue;
    if (e.burn && swimmable(at)) e.burn = 0;
    else if (e.burn && at === Liquid.Oil) igniteOil(sim, g.cx(t.x), g.cy(t.y - e.hh + 0.1), e.burnBy ?? -1);
  }
}

/** Liquids against their neighbours: melting, cooling, putting out and lighting. */
function react(sim: Sim) {
  const g = sim.grid;
  const L = sim.ruleset.liquids;
  const step = L.flowTicks * DT;
  for (let i = 0; i < g.liq.length; i++) {
    const k = g.liq[i]!;
    if (k === Liquid.None) continue;
    const cx = i % g.cols;
    const cy = (i - cx) / g.cols;
    for (const [dx, dy] of N4) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!g.inside(nx, ny)) continue;
      const j = g.idx(nx, ny);
      const m = g.mat[j]!;
      const n = g.liq[j]!;
      if (swimmable(k)) {
        // water (and slime) puts out the burning cell beside it
        if (m !== Mat.Empty && sim.fires.has(j)) sim.fires.delete(j);
      } else if (k === Liquid.Oil) {
        const fire = sim.fires.get(j);
        if (fire) igniteOil(sim, cx, cy, fire.by);
      } else {
        // lava and acid
        if (k === Liquid.Lava && n === Liquid.Water) {
          // cools to rock where the lava was
          sim.terrain.placeCell(cx, cy, Mat.Rock);
          sim.liquids.oilFires.delete(i);
          break;
        }
        if (k === Liquid.Lava && n === Liquid.Oil) igniteOil(sim, nx, ny, -1);
        if (m === Mat.Empty || m === Mat.Bedrock) continue;
        if (k === Liquid.Lava && m === Mat.Ice) {
          if (sim.terrain.removeCell(nx, ny)) g.liq[j] = Liquid.Water;
          continue;
        }
        damageTerrainCell(sim, nx, ny, m, (k === Liquid.Lava ? L.lava.meltDps : L.acid.meltDps) * step);
      }
    }
  }
}

function burnOil(sim: Sim) {
  const fires = sim.liquids.oilFires;
  if (!fires.size) return;
  const g = sim.grid;
  const L = sim.ruleset.liquids;
  for (const i of [...fires.keys()].sort((a, b) => a - b)) {
    const fire = fires.get(i)!;
    if (g.liq[i] !== Liquid.Oil) {
      // flowed away or cooled over
      fires.delete(i);
      continue;
    }
    const before = fire.t;
    fire.t += L.flowTicks;
    const cx = i % g.cols;
    const cy = (i - cx) / g.cols;
    if (before < L.oil.spreadTicks && fire.t >= L.oil.spreadTicks) {
      for (const [dx, dy] of N4) {
        igniteOil(sim, cx + dx, cy + dy, fire.by);
        igniteCell(sim, cx + dx, cy + dy, fire.by, "spread");
      }
    }
    if (fire.t >= L.oil.burnTicks) {
      g.liq[i] = Liquid.None;
      fires.delete(i);
      sim.liquids.active = true;
    }
  }
}
