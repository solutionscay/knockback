/**
 * Ignition (#33): what can catch fire, and lighting it. Static cells, the cells of loose pieces, props (crates
 * burn; barrels, TNT and gas cans light their fuse), and fighters, who catch fire by touching any of it.
 * Every chance is drawn from the Sim's seeded RNG, in a fixed order. The burning itself is in sim-fire.ts.
 */
import RAPIER from "@dimforge/rapier2d-deterministic-compat";
import { CELL, F_CHARRED, swimmable } from "./grid";
import { CLASSIC, type Ruleset } from "./ruleset";
import type { Sim } from "./sim";
import { light } from "./sim-objects";
import type { Entity, Fighter } from "./sim-types";
import { pieceCellWorld, type PieceCell } from "./terrain";

/** Static burning cells: grid index -> fire steps left and who lit it. */
export interface CellFire {
  burn: number;
  by: number;
}

export function propFlammable(e: Entity, ruleset: Ruleset = CLASSIC): boolean {
  return ruleset.fire.props.includes(e.kind);
}

/** A static cell that can catch: solid, flammable, not burned out, not already burning. */
export function cellCanCatch(sim: Sim, i: number): boolean {
  const g = sim.grid;
  return g.mat[i] !== 0 && sim.ruleset.fire.materials.includes(g.mat[i]!) && !(g.flags[i]! & F_CHARRED) && !sim.fires.has(i);
}

function burnTime(sim: Sim): number {
  return sim.rng.int(sim.ruleset.fire.burnMin, sim.ruleset.fire.burnMax);
}

/** Light a static cell. source: "flame", "blast" (counted as a new fire) or "spread". */
export function igniteCell(sim: Sim, cx: number, cy: number, by: number, source: string): boolean {
  const g = sim.grid;
  if (!g.solid(cx, cy)) return false;
  const i = g.idx(cx, cy);
  if (!cellCanCatch(sim, i)) return false;
  sim.fires.set(i, { burn: burnTime(sim), by });
  sim.stats.cellsIgnited++;
  if (source !== "spread") {
    sim.stats.firesStarted++;
    sim.events.push({ type: "ignite", tick: sim.tick, what: "cell", x: g.wx(cx) + CELL / 2, y: g.wy(cy) + CELL / 2, source, by });
  }
  return true;
}

export function ignitePieceCell(sim: Sim, e: Entity, c: PieceCell, by: number, source: string): boolean {
  if (!sim.ruleset.fire.materials.includes(c.mat) || c.charred || c.burn || c.hp <= 0) return false;
  c.burn = burnTime(sim);
  c.burnBy = by;
  sim.stats.cellsIgnited++;
  if (source !== "spread") {
    sim.stats.firesStarted++;
    const w = pieceCellWorld(e.body.translation(), e.body.rotation(), c);
    sim.events.push({ type: "ignite", tick: sim.tick, what: "piece", x: w.x, y: w.y, source, by });
  }
  return true;
}

/** Light a prop: crates burn; barrels, TNT and gas cans light their fuse (and burn until they go). */
export function igniteProp(sim: Sim, e: Entity, by: number, source: string): boolean {
  // a fuse already burning (shot, blasted) is not a new fire
  if (e.dead || !propFlammable(e, sim.ruleset) || e.burn || e.fuse !== undefined || e.thrust !== undefined) return false;
  e.burn = burnTime(sim);
  e.burnBy = by;
  sim.stats.propsIgnited++;
  if (source !== "spread") sim.stats.firesStarted++;
  const t = e.body.translation();
  sim.events.push({ type: "ignite", tick: sim.tick, what: "prop", x: t.x, y: t.y, source, by });
  if (e.kind !== "crate") {
    sim.stats.propsBurnedOff++;
    light(sim, e, by, 0, "fire");
  }
  return true;
}

/** Light whatever flammable thing an entity is (a prop, or the nearest cells of a piece to a point). */
export function igniteEntityAt(sim: Sim, e: Entity, x: number, y: number, by: number, source: string) {
  if (e.kind === "chunk") {
    const t = e.body.translation();
    const a = e.body.rotation();
    let best: PieceCell | null = null;
    let bd = Infinity;
    for (const c of e.cells!) {
      if (!sim.ruleset.fire.materials.includes(c.mat)) continue;
      const w = pieceCellWorld(t, a, c);
      const d = (w.x - x) * (w.x - x) + (w.y - y) * (w.y - y);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    if (best && bd < 0.6 * 0.6) ignitePieceCell(sim, e, best, by, source);
  } else igniteProp(sim, e, by, source);
}

/**
 * Set a fighter on fire (or keep them burning). A fighter in water, slime or coolant does not catch: the liquid puts
 * the fire out on the same tick, so a swimmer beside a fire or in a flame was lit and doused again and again (#131:
 * repeated "burn" and "douse" events, two or more DOUSED labels). Same test as sim-liquid's bodyLiquid.
 */
export function igniteFighter(sim: Sim, f: Fighter, by: number, cause: string) {
  if (!f.alive) return;
  if (sim.liquids.on) {
    const p = f.entity.body.translation();
    if (swimmable(sim.grid.liquidAt(p.x, p.y) || sim.grid.liquidAt(p.x, sim.feetY(f) + 0.15))) return;
  }
  const was = f.burning > 0;
  if (!was) {
    sim.stats.fightersIgnited++;
    sim.events.push({ type: "burn", tick: sim.tick, fighter: f.id, by, cause });
  }
  f.burning = sim.ruleset.fire.fighterTicks;
  // the flamethrower's credit sticks over a plain fire
  if (was && f.burnCause === "flamethrower" && cause !== "flamethrower") return;
  f.burnBy = by;
  f.burnCause = cause;
}

/** A blast lights flammable things near its center (by chance). */
export function blastIgnite(sim: Sim, x: number, y: number, radius: number, owner: number) {
  const r = radius * sim.ruleset.fire.blastReach;
  const g = sim.grid;
  const c0 = Math.max(0, g.cx(x - r));
  const c1 = Math.min(g.cols - 1, g.cx(x + r));
  const r0 = Math.max(0, g.cy(y - r));
  const r1 = Math.min(g.rows - 1, g.cy(y + r));
  for (let cy = r0; cy <= r1; cy++)
    for (let cx = c0; cx <= c1; cx++) {
      const i = g.idx(cx, cy);
      if (!cellCanCatch(sim, i)) continue;
      const px = g.wx(cx) + CELL / 2 - x;
      const py = g.wy(cy) + CELL / 2 - y;
      if (px * px + py * py > r * r) continue;
      if (sim.rng.chance(sim.ruleset.fire.blastChance)) igniteCell(sim, cx, cy, owner, "blast");
    }
  const found: Entity[] = [];
  sim.world.intersectionsWithShape({ x, y }, 0, new RAPIER.Ball(r), (c) => {
    const e = sim.entityOf(c);
    if (e && !e.dead && (e.kind === "chunk" || propFlammable(e, sim.ruleset)) && !found.includes(e)) found.push(e);
    return true;
  });
  found.sort((a, b) => a.id - b.id);
  for (const e of found) if (sim.rng.chance(sim.ruleset.fire.blastChance)) igniteEntityAt(sim, e, x, y, owner, "blast");
}

/** Fighters touching burning cells, props or pieces catch fire. */
export function catchFighters(sim: Sim) {
  const g = sim.grid;
  const reach = sim.ruleset.combat.fighter.radius + sim.ruleset.fire.touch;
  const half = sim.ruleset.combat.fighter.halfHeight + sim.ruleset.combat.fighter.radius + sim.ruleset.fire.touch;
  for (const f of sim.fighters) {
    if (!f.alive || f.removed) continue;
    const p = sim.pos(f);
    let by = -2;
    if (sim.fires.size) {
      for (let cy = g.cy(p.y - half); cy <= g.cy(p.y + half) && by === -2; cy++)
        for (let cx = g.cx(p.x - reach); cx <= g.cx(p.x + reach); cx++) {
          if (!g.inside(cx, cy)) continue;
          const fire = sim.fires.get(g.idx(cx, cy));
          if (fire) {
            by = fire.by;
            break;
          }
        }
    }
    if (by === -2) {
      sim.world.intersectionsWithShape({ x: p.x, y: p.y }, 0, new RAPIER.Cuboid(reach, half), (c) => {
        const e = sim.entityOf(c);
        if (!e || e.dead || e === f.entity) return true;
        if (e.burn) by = e.burnBy ?? -1;
        else if (e.kind === "chunk") {
          const t = e.body.translation();
          const a = e.body.rotation();
          for (const cell of e.cells!) {
            if (!cell.burn) continue;
            const w = pieceCellWorld(t, a, cell);
            if (Math.abs(w.x - p.x) < reach + CELL / 2 && Math.abs(w.y - p.y) < half + CELL / 2) {
              by = cell.burnBy ?? -1;
              break;
            }
          }
        }
        return by === -2;
      });
    }
    if (by !== -2) igniteFighter(sim, f, by === f.id ? -1 : by, "fire");
  }
}
