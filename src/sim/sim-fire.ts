/**
 * Fire (#33) and the flamethrower (#32).
 *
 * What burns: wood and crumble cells (static, or on a loose piece), crates,
 * and the fuses of barrels, TNT and gas cans (they catch, then go off as if
 * shot). Fighters catch fire by touching any of it, or from the flamethrower.
 *
 * Fire is updated at a fixed tick interval, in a fixed order (cell index,
 * entity id), with every chance drawn from the Sim's seeded RNG and no trig,
 * so it is the same in every JS engine. A burning cell loses hit points,
 * may light its flammable 4-neighbours, and either burns out (charred, never
 * catches again) or is destroyed, which can drop or split a platform. A
 * burning anchor cell eats its chain (#34), so a burning platform swings and
 * falls.
 *
 * This file is the flamethrower and the fire update; lighting things is in sim-ignite.ts.
 */
import RAPIER from "@dimforge/rapier2d-deterministic-compat";
import { DT } from "./constants";
import { length2D } from "./dmath";
import { CELL, F_ANCHOR, F_CHARRED } from "./grid";
import type { Sim } from "./sim";
import { chainAtCell, damageChain, shootChains } from "./sim-chains";
import { catchFighters, cellCanCatch, igniteCell, igniteEntityAt, igniteFighter, ignitePieceCell, igniteProp, propFlammable } from "./sim-ignite";
import { hitProp } from "./sim-objects";
import { igniteOilNear } from "./sim-liquid";
import { damageTerrainCell, prunePiece } from "./sim-terrain";
import type { Entity, Fighter } from "./sim-types";
import { throwAway } from "./sim-items";
import { pieceCellWorld, type PieceCell } from "./terrain";

// --------------------------------------------------------------- flamethrower

/** cos and sin of 0, 0.22 and 0.44 rad: the cone's 5 rays, as fixed numbers (no trig at run time). */
const RAYS: readonly [number, number][] = [
  [1, 0],
  [0.9758974493306055, 0.21822962308086932],
  [0.9758974493306055, -0.21822962308086932],
  [0.9047516183275669, 0.4259394650659996],
  [0.9047516183275669, -0.4259394650659996],
];

/** One pulse of flame from (ox, oy) along (dx, dy). */
export function fireFlamethrower(sim: Sim, f: Fighter, ox: number, oy: number, dx: number, dy: number) {
  const W = sim.ruleset.weapons.table.flamethrower;
  const hitFighters: { fi: Fighter; rx: number; ry: number }[] = [];
  for (const [baseCos, baseSin] of RAYS) {
    let co = baseCos;
    let si = baseSin;
    if (W.spreadScale !== 1) {
      si *= W.spreadScale;
      const length = length2D(co, si);
      co /= length;
      si /= length;
    }
    const rx = dx * co - dy * si;
    const ry = dx * si + dy * co;
    const hit = sim.raycast(ox, oy, rx, ry, W.range, f.entity.collider);
    const dist = hit ? hit.dist : W.range;
    shootChains(sim, ox, oy, ox + rx * dist, oy + ry * dist, W.chainDamage, f.id, "fire");
    // #94: the flame lights the oil it passes over (no RNG drawn on a level without liquids)
    if (sim.liquids.on) for (let d = 0.5; d <= dist; d += 0.5) igniteOilNear(sim, ox + rx * d, oy + ry * d, 0.3, f.id);
    if (!hit) continue;
    const hx = ox + rx * dist;
    const hy = oy + ry * dist;
    if (hit.terrain) {
      const g = sim.grid;
      if (sim.rng.chance(W.igniteChance)) igniteCell(sim, g.cx(hx + rx * 0.05), g.cy(hy + ry * 0.05), f.id, "flame");
      continue;
    }
    const e = hit.entity!;
    if (e.kind === "fighter" && e.fighter) {
      if (e.fighter.alive && !hitFighters.some((h) => h.fi === e.fighter)) hitFighters.push({ fi: e.fighter, rx, ry });
    } else if (e.kind === "chunk" || propFlammable(e, sim.ruleset)) {
      if (sim.rng.chance(W.igniteChance)) igniteEntityAt(sim, e, hx, hy, f.id, "flame");
    }
  }
  for (const h of hitFighters) {
    const t = h.fi.entity.body.translation();
    sim.damageFighter(h.fi, W.damage, f.id, h.rx * W.push, h.ry * W.push + W.push * 0.3, "flamethrower", t.x, t.y);
    igniteFighter(sim, h.fi, f.id, "flamethrower");
  }
  sim.stats.flamePulses++;
  if (--f.ammo.flamethrower <= 0) {
    // empty: the tank is thrown away (#95: like every weapon)
    sim.events.push({ type: "fuelOut", tick: sim.tick, fighter: f.id });
    throwAway(sim, f, "flamethrower");
  }
}

// ------------------------------------------------------------------ the update

export function updateFire(sim: Sim) {
  // burning fighters: hurt twice a second, credited to whoever lit them
  for (const f of sim.fighters) {
    if (f.burning <= 0) continue;
    if (!f.alive) {
      f.burning = 0;
      continue;
    }
    f.burning--;
    // on a fixed clock (staggered per seat), so standing in fire, which keeps relighting them, still hurts
    if ((sim.tick + f.id * 7) % 30 === 0) {
      const p = sim.pos(f);
      sim.damageFighter(f, sim.ruleset.fire.fighterDps * 30 * DT, f.burnBy, 0, 0, f.burnCause || "fire", p.x, p.y);
    }
  }
  if (sim.tick % sim.ruleset.fire.step !== 0) return;
  // burning fighters set the planks they stand on alight
  for (const f of sim.fighters) {
    if (f.burning <= 0 || !f.alive || !f.grounded) continue;
    const p = sim.pos(f);
    const g = sim.grid;
    const cx = g.cx(p.x);
    const cy = g.cy(sim.feetY(f) - 0.1);
    if (g.solid(cx, cy) && sim.ruleset.fire.materials.includes(g.matAt(cx, cy)) && sim.rng.chance(sim.ruleset.fire.feetChance)) igniteCell(sim, cx, cy, f.burnBy, "spread");
  }
  if (sim.fires.size) burnCells(sim);
  burnEntities(sim);
  catchFighters(sim);
}

function burnCells(sim: Sim) {
  const g = sim.grid;
  const order = [...sim.fires.keys()].sort((a, b) => a - b);
  for (const i of order) {
    const fire = sim.fires.get(i)!;
    const cx = i % g.cols;
    const cy = (i - cx) / g.cols;
    const m = g.mat[i]!;
    if (m === 0 || !sim.ruleset.fire.materials.includes(m)) {
      sim.fires.delete(i);
      continue;
    }
    // an anchor in flames eats its chain (#34)
    if (g.flags[i]! & F_ANCHOR) {
      const ch = chainAtCell(sim, cx, cy);
      if (ch && !ch.broken && ch.piece < 0) damageChain(sim, ch, sim.ruleset.fire.chainDamage, fire.by, "fire", g.wx(cx) + CELL / 2, g.wy(cy) + CELL);
    }
    if (damageTerrainCell(sim, cx, cy, m, sim.ruleset.fire.cellDamage)) {
      sim.stats.cellsBurnedDown++;
      sim.fires.delete(i);
      continue;
    }
    for (const [nx, ny] of [
      [cx - 1, cy],
      [cx + 1, cy],
      [cx, cy + 1],
      [cx, cy - 1],
    ] as const) {
      if (!g.inside(nx, ny)) continue;
      const j = g.idx(nx, ny);
      if (!cellCanCatch(sim, j)) continue;
      if (sim.rng.chance(sim.ruleset.fire.spread)) igniteCell(sim, nx, ny, fire.by, "spread");
    }
    // flames lick the props resting on or against it
    if (sim.rng.chance(sim.ruleset.fire.spread * 2)) {
      sim.world.intersectionsWithShape({ x: g.wx(cx) + CELL / 2, y: g.wy(cy) + CELL / 2 }, 0, new RAPIER.Cuboid(CELL / 2 + sim.ruleset.fire.propReach / 2, CELL / 2 + sim.ruleset.fire.propReach / 2), (c) => {
        const e = sim.entityOf(c);
        if (e && propFlammable(e, sim.ruleset) && !e.burn) igniteProp(sim, e, fire.by, "spread");
        return true;
      });
    }
    if (--fire.burn <= 0) {
      g.flags[i]! |= F_CHARRED;
      sim.fires.delete(i);
      sim.stats.cellsBurnedOut++;
    }
  }
}

function burnEntities(sim: Sim) {
  for (const e of [...sim.entities.values()]) {
    if (e.dead) continue;
    if (e.kind === "chunk") burnPiece(sim, e);
    else if (e.burn) burnProp(sim, e);
  }
}

function burnPiece(sim: Sim, e: Entity) {
  const cells = e.cells!;
  if (!cells.some((c) => c.burn)) return;
  const t = e.body.translation();
  const a = e.body.rotation();
  const at = new Map<number, PieceCell>();
  for (const c of cells) at.set(c.ly * 4096 + c.lx, c);
  let lost = false;
  for (const c of cells) {
    if (!c.burn) continue;
    const by = c.burnBy ?? -1;
    if (c.chain !== undefined) {
      const ch = sim.chains[c.chain]!;
      const w = pieceCellWorld(t, a, c);
      damageChain(sim, ch, sim.ruleset.fire.chainDamage, by, "fire", w.x, w.y);
    }
    c.hp -= sim.ruleset.fire.cellDamage;
    if (c.hp <= 0) {
      c.burn = 0;
      lost = true;
      sim.stats.cellsBurnedDown++;
      continue;
    }
    for (const [dx, dy] of [
      [-1, 0],
      [1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const n = at.get((c.ly + dy) * 4096 + c.lx + dx);
      if (n && !n.burn && !n.charred && sim.ruleset.fire.materials.includes(n.mat) && n.hp > 0 && sim.rng.chance(sim.ruleset.fire.spread)) ignitePieceCell(sim, e, n, by, "spread");
    }
    if (--c.burn! <= 0) {
      c.burn = 0;
      c.charred = true;
      sim.stats.cellsBurnedOut++;
    }
  }
  if (lost) {
    const broken = cells.filter((c) => c.hp <= 0).map((c) => ({ ...pieceCellWorld(t, a, c), mat: c.mat }));
    sim.stats.cellsDestroyed += broken.length;
    sim.events.push({ type: "carve", tick: sim.tick, cells: broken });
    prunePiece(sim, e);
  }
}

function burnProp(sim: Sim, e: Entity) {
  const by = e.burnBy ?? -1;
  const t = e.body.translation();
  // spread to flammable props and cells it touches
  if (sim.rng.chance(sim.ruleset.fire.spread * 3)) {
    const near: Entity[] = [];
    sim.world.intersectionsWithShape({ x: t.x, y: t.y }, 0, new RAPIER.Cuboid(e.hw + sim.ruleset.fire.propReach, e.hh + sim.ruleset.fire.propReach), (c) => {
      const o = sim.entityOf(c);
      if (o && o !== e && !o.dead && propFlammable(o, sim.ruleset) && !o.burn && !near.includes(o)) near.push(o);
      return true;
    });
    near.sort((x, y) => x.id - y.id);
    for (const o of near) igniteProp(sim, o, by, "spread");
    const g = sim.grid;
    for (let cy = g.cy(t.y - e.hh - sim.ruleset.fire.propReach); cy <= g.cy(t.y + e.hh + sim.ruleset.fire.propReach); cy++)
      for (let cx = g.cx(t.x - e.hw - sim.ruleset.fire.propReach); cx <= g.cx(t.x + e.hw + sim.ruleset.fire.propReach); cx++) igniteCell(sim, cx, cy, by, "spread");
  }
  if (e.kind === "crate") {
    hitProp(sim, e, sim.ruleset.fire.propDamage * (sim.ruleset.arena.props.crate.hp / 14), by, "fire", t.x, t.y);
    if (e.dead) {
      sim.stats.propsBurnedOff++;
      return;
    }
  }
  if (--e.burn! <= 0) e.burn = 0;
}
