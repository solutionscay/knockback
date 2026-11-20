/**
 * Fire (#33) and the flamethrower (#32).
 *
 * What burns: wood and crumble cells (static, or on a loose piece), crates,
 * and the fuses of barrels, TNT and gas cans (they catch, then go off as if
 * shot). Fighters catch fire by touching any of it, or from the flamethrower.
 *
 * Fire is updated every FIRE.step ticks, in a fixed order (cell index,
 * entity id), with every chance drawn from the Sim's seeded RNG and no trig,
 * so it is the same in every JS engine. A burning cell loses hit points,
 * may light its flammable 4-neighbours, and either burns out (charred, never
 * catches again) or is destroyed, which can drop or split a platform. A
 * burning anchor cell eats its chain (#34), so a burning platform swings and
 * falls.
 */
import RAPIER from "@dimforge/rapier2d-deterministic-compat";
import { CRATE, DT, FIGHTER, FIRE, WEAPONS } from "./constants";
import { CELL, F_ANCHOR, F_CHARRED, flammable } from "./grid";
import type { Sim } from "./sim";
import { chainAtCell, damageChain, shootChains } from "./sim-chains";
import { hitProp, light } from "./sim-objects";
import { damageTerrainCell, prunePiece } from "./sim-terrain";
import type { Entity, Fighter } from "./sim-types";
import { pieceCellWorld, type PieceCell } from "./terrain";

/** Static burning cells: grid index -> fire steps left and who lit it. */
export interface CellFire {
  burn: number;
  by: number;
}

const FLAMMABLE_PROPS = new Set(["crate", "barrel", "tnt", "gas"]);

export function propFlammable(e: Entity): boolean {
  return FLAMMABLE_PROPS.has(e.kind);
}

function burnTime(sim: Sim): number {
  return sim.rng.int(FIRE.burnMin, FIRE.burnMax);
}

/** Light a static cell. source: "flame", "blast" (counted as a new fire) or "spread". */
export function igniteCell(sim: Sim, cx: number, cy: number, by: number, source: string): boolean {
  const g = sim.grid;
  if (!g.solid(cx, cy)) return false;
  const i = g.idx(cx, cy);
  if (!flammable(g.mat[i]!) || g.flags[i]! & F_CHARRED || sim.fires.has(i)) return false;
  sim.fires.set(i, { burn: burnTime(sim), by });
  sim.stats.cellsIgnited++;
  if (source !== "spread") {
    sim.stats.firesStarted++;
    sim.events.push({ type: "ignite", tick: sim.tick, what: "cell", x: g.wx(cx) + CELL / 2, y: g.wy(cy) + CELL / 2, source, by });
  }
  return true;
}

function ignitePieceCell(sim: Sim, e: Entity, c: PieceCell, by: number, source: string): boolean {
  if (!flammable(c.mat) || c.charred || c.burn || c.hp <= 0) return false;
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
  if (e.dead || !propFlammable(e) || e.burn || e.fuse !== undefined || e.thrust !== undefined) return false;
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
function igniteEntityAt(sim: Sim, e: Entity, x: number, y: number, by: number, source: string) {
  if (e.kind === "chunk") {
    const t = e.body.translation();
    const a = e.body.rotation();
    let best: PieceCell | null = null;
    let bd = Infinity;
    for (const c of e.cells!) {
      if (!flammable(c.mat)) continue;
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

/** Set a fighter on fire (or keep them burning). */
export function igniteFighter(sim: Sim, f: Fighter, by: number, cause: string) {
  if (!f.alive) return;
  const was = f.burning > 0;
  if (!was) {
    sim.stats.fightersIgnited++;
    sim.events.push({ type: "burn", tick: sim.tick, fighter: f.id, by, cause });
  }
  f.burning = FIRE.fighterTicks;
  // the flamethrower's credit sticks over a plain fire
  if (was && f.burnCause === "flamethrower" && cause !== "flamethrower") return;
  f.burnBy = by;
  f.burnCause = cause;
}

/** A blast lights flammable things near its center (by chance). */
export function blastIgnite(sim: Sim, x: number, y: number, radius: number, owner: number) {
  const r = radius * FIRE.blastReach;
  const g = sim.grid;
  const c0 = Math.max(0, g.cx(x - r));
  const c1 = Math.min(g.cols - 1, g.cx(x + r));
  const r0 = Math.max(0, g.cy(y - r));
  const r1 = Math.min(g.rows - 1, g.cy(y + r));
  for (let cy = r0; cy <= r1; cy++)
    for (let cx = c0; cx <= c1; cx++) {
      const i = g.idx(cx, cy);
      if (g.mat[i] === 0 || !flammable(g.mat[i]!) || g.flags[i]! & F_CHARRED || sim.fires.has(i)) continue;
      const px = g.wx(cx) + CELL / 2 - x;
      const py = g.wy(cy) + CELL / 2 - y;
      if (px * px + py * py > r * r) continue;
      if (sim.rng.chance(FIRE.blastChance)) igniteCell(sim, cx, cy, owner, "blast");
    }
  const found: Entity[] = [];
  sim.world.intersectionsWithShape({ x, y }, 0, new RAPIER.Ball(r), (c) => {
    const e = sim.entityOf(c);
    if (e && !e.dead && (e.kind === "chunk" || propFlammable(e)) && !found.includes(e)) found.push(e);
    return true;
  });
  found.sort((a, b) => a.id - b.id);
  for (const e of found) if (sim.rng.chance(FIRE.blastChance)) igniteEntityAt(sim, e, x, y, owner, "blast");
}

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
  const W = WEAPONS.flamethrower;
  const hitFighters: { fi: Fighter; rx: number; ry: number }[] = [];
  for (const [co, si] of RAYS) {
    const rx = dx * co - dy * si;
    const ry = dx * si + dy * co;
    const hit = sim.raycast(ox, oy, rx, ry, W.range, f.entity.collider);
    const dist = hit ? hit.dist : W.range;
    shootChains(sim, ox, oy, ox + rx * dist, oy + ry * dist, W.chainDamage, f.id, "fire");
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
    } else if (e.kind === "chunk" || propFlammable(e)) {
      if (sim.rng.chance(W.igniteChance)) igniteEntityAt(sim, e, hx, hy, f.id, "flame");
    }
  }
  for (const h of hitFighters) {
    const t = h.fi.entity.body.translation();
    sim.damageFighter(h.fi, W.damage, f.id, h.rx * W.push, h.ry * W.push + W.push * 0.3, "flamethrower", t.x, t.y);
    igniteFighter(sim, h.fi, f.id, "flamethrower");
  }
  sim.stats.flamePulses++;
  if (--f.fuel <= 0) {
    // empty: the tank is thrown away
    const slot = f.weapons.indexOf("flamethrower");
    if (slot >= 0) f.weapons[slot] = "fist";
    f.fuel = 0;
    sim.events.push({ type: "fuelOut", tick: sim.tick, fighter: f.id });
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
    if (f.burning % 30 === 0) {
      const p = sim.pos(f);
      sim.damageFighter(f, FIRE.fighterDps * 30 * DT, f.burnBy, 0, 0, f.burnCause || "fire", p.x, p.y);
    }
  }
  if (sim.tick % FIRE.step !== 0) return;
  // burning fighters set the planks they stand on alight
  for (const f of sim.fighters) {
    if (f.burning <= 0 || !f.alive || !f.grounded) continue;
    const p = sim.pos(f);
    const g = sim.grid;
    const cx = g.cx(p.x);
    const cy = g.cy(sim.feetY(f) - 0.1);
    if (g.solid(cx, cy) && flammable(g.matAt(cx, cy)) && sim.rng.chance(FIRE.feetChance)) igniteCell(sim, cx, cy, f.burnBy, "spread");
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
    if (m === 0 || !flammable(m)) {
      sim.fires.delete(i);
      continue;
    }
    // an anchor in flames eats its chain (#34)
    if (g.flags[i]! & F_ANCHOR) {
      const ch = chainAtCell(sim, cx, cy);
      if (ch && !ch.broken && ch.piece < 0) damageChain(sim, ch, FIRE.chainDamage, fire.by, "fire", g.wx(cx) + CELL / 2, g.wy(cy) + CELL);
    }
    if (damageTerrainCell(sim, cx, cy, m, FIRE.cellDamage)) {
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
      if (g.mat[j] === 0 || !flammable(g.mat[j]!) || g.flags[j]! & F_CHARRED || sim.fires.has(j)) continue;
      if (sim.rng.chance(FIRE.spread)) igniteCell(sim, nx, ny, fire.by, "spread");
    }
    // flames lick the props resting on or against it
    if (sim.rng.chance(FIRE.spread * 2)) {
      sim.world.intersectionsWithShape({ x: g.wx(cx) + CELL / 2, y: g.wy(cy) + CELL / 2 }, 0, new RAPIER.Cuboid(CELL / 2 + FIRE.propReach / 2, CELL / 2 + FIRE.propReach / 2), (c) => {
        const e = sim.entityOf(c);
        if (e && propFlammable(e) && !e.burn) igniteProp(sim, e, fire.by, "spread");
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
      damageChain(sim, ch, FIRE.chainDamage, by, "fire", w.x, w.y);
    }
    c.hp -= FIRE.cellDamage;
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
      if (n && !n.burn && !n.charred && flammable(n.mat) && n.hp > 0 && sim.rng.chance(FIRE.spread)) ignitePieceCell(sim, e, n, by, "spread");
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
  if (sim.rng.chance(FIRE.spread * 3)) {
    const near: Entity[] = [];
    sim.world.intersectionsWithShape({ x: t.x, y: t.y }, 0, new RAPIER.Cuboid(e.hw + FIRE.propReach, e.hh + FIRE.propReach), (c) => {
      const o = sim.entityOf(c);
      if (o && o !== e && !o.dead && propFlammable(o) && !o.burn && !near.includes(o)) near.push(o);
      return true;
    });
    near.sort((x, y) => x.id - y.id);
    for (const o of near) igniteProp(sim, o, by, "spread");
    const g = sim.grid;
    for (let cy = g.cy(t.y - e.hh - FIRE.propReach); cy <= g.cy(t.y + e.hh + FIRE.propReach); cy++)
      for (let cx = g.cx(t.x - e.hw - FIRE.propReach); cx <= g.cx(t.x + e.hw + FIRE.propReach); cx++) igniteCell(sim, cx, cy, by, "spread");
  }
  if (e.kind === "crate") {
    hitProp(sim, e, FIRE.propDamage * (CRATE.hp / 14), by, "fire", t.x, t.y);
    if (e.dead) {
      sim.stats.propsBurnedOff++;
      return;
    }
  }
  if (--e.burn! <= 0) e.burn = 0;
}

/** Fighters touching burning cells, props or pieces catch fire. */
function catchFighters(sim: Sim) {
  const g = sim.grid;
  const reach = FIGHTER.radius + FIRE.touch;
  const half = FIGHTER.halfHeight + FIGHTER.radius + FIRE.touch;
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
