import RAPIER from "@dimforge/rapier2d-deterministic-compat";
import { CRUMBLE_DPS, DT } from "./constants";
import type { Sim } from "./sim";
import { type Entity, type Fighter } from "./sim-types";
import { clamp } from "./dmath";
import { CELL, Mat } from "./grid";
import { buildPieceColliders, components, pieceCellWorld, type PieceCell } from "./terrain";

export function crumbleUnder(sim: Sim, f: Fighter, x: number) {
  const g = sim.grid;
  const cy = g.cy(sim.feetY(f) - 0.1);
  for (const ox of [-0.3, 0, 0.3]) {
    const cx = g.cx(x + ox);
    if (g.matAt(cx, cy) !== Mat.Crumble) continue;
    const m = Mat.Crumble;
    if (sim.terrain.damageCell(cx, cy, CRUMBLE_DPS * DT)) {
      sim.stats.cellsDestroyed++;
      sim.events.push({ type: "carve", tick: sim.tick, cells: [{ x: g.wx(cx) + CELL / 2, y: g.wy(cy) + CELL / 2, mat: m }] });
    }
  }
}

/** Damage the static cell just behind a hit point on terrain. */
export function chipTerrain(sim: Sim, x: number, y: number, dx: number, dy: number, dmg: number) {
  const g = sim.grid;
  const cx = g.cx(x + dx * 0.05);
  const cy = g.cy(y + dy * 0.05);
  const m = g.matAt(cx, cy);
  if (m !== Mat.Empty && sim.terrain.damageCell(cx, cy, dmg)) {
    sim.stats.cellsDestroyed++;
    sim.events.push({ type: "carve", tick: sim.tick, cells: [{ x: g.wx(cx) + CELL / 2, y: g.wy(cy) + CELL / 2, mat: m }] });
  }
}

/** Rebuild changed terrain colliders and drop whatever lost its support. */
export function flushTerrain(sim: Sim) {
  const groupsLoose = sim.terrain.detachUnsupported();
  sim.terrain.flushColliders();
  for (const comp of groupsLoose) {
    let minCx = Infinity;
    let minCy = Infinity;
    for (const c of comp) {
      minCx = Math.min(minCx, c.cx);
      minCy = Math.min(minCy, c.cy);
    }
    const cells: PieceCell[] = comp.map((c) => ({ lx: c.cx - minCx, ly: c.cy - minCy, mat: c.mat, hp: c.hp }));
    const e = makePiece(sim, cells, sim.grid.wx(minCx), sim.grid.wy(minCy), 0, { x: 0, y: 0 }, 0);
    sim.stats.cellsDetached += cells.length;
    sim.stats.piecesFallen++;
    if (cells.length >= 4) sim.stats.platformsFallen++;
    const t = e.body.translation();
    sim.events.push({ type: "detach", tick: sim.tick, entity: e.id, cells: cells.length, x: t.x + e.hw, y: t.y + e.hh });
  }
}

function makePiece(sim: Sim, cells: PieceCell[], x: number, y: number, angle: number, v: { x: number; y: number }, w: number): Entity {
  const body = sim.world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y).setRotation(angle).setLinvel(v.x, v.y).setAngvel(w).setLinearDamping(0.05).setAngularDamping(0.4).setCcdEnabled(cells.length >= 6),
  );
  const colliders = buildPieceColliders(sim.world, body, cells);
  let maxX = 0;
  let maxY = 0;
  for (const c of cells) {
    maxX = Math.max(maxX, c.lx + 1);
    maxY = Math.max(maxY, c.ly + 1);
  }
  const e: Entity = {
    id: sim.entityStore.allocateId(),
    kind: "chunk",
    body,
    collider: colliders[0]!,
    colliders,
    hw: (maxX * CELL) / 2,
    hh: (maxY * CELL) / 2,
    hp: cells.length,
    maxHp: cells.length,
    dead: false,
    born: sim.tick,
    cells,
  };
  sim.entityStore.register(e);
  return e;
}

/** Damage the cells of a loose piece within radius r of (x, y); splits it if needed. */
export function damagePiece(sim: Sim, e: Entity, x: number, y: number, r: number, dmg: number) {
  const t = e.body.translation();
  const a = e.body.rotation();
  const cells = e.cells!;
  let changed = false;
  const broken: { x: number; y: number; mat: number }[] = [];
  for (const c of cells) {
    const w = pieceCellWorld(t, a, c);
    const d = Math.sqrt((w.x - x) * (w.x - x) + (w.y - y) * (w.y - y));
    if (d > r + CELL * 0.5) continue;
    c.hp -= dmg * clamp(1 - d / (r + CELL), 0.2, 1);
    if (c.hp <= 0) {
      changed = true;
      broken.push({ x: w.x, y: w.y, mat: c.mat });
    }
  }
  if (!changed) return;
  sim.stats.cellsDestroyed += broken.length;
  sim.events.push({ type: "carve", tick: sim.tick, cells: broken });
  const left = cells.filter((c) => c.hp > 0);
  const v = e.body.linvel();
  const w = e.body.angvel();
  sim.entityStore.remove(e);
  if (left.length === 0) return;
  for (const comp of components(left)) {
    makePiece(sim, comp, t.x, t.y, a, v, w);
  }
}
