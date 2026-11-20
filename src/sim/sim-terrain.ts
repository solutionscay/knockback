import RAPIER from "@dimforge/rapier2d-deterministic-compat";
import { DT } from "./constants";
import type { Sim } from "./sim";
import { type Entity, type Fighter } from "./sim-types";
import { clamp } from "./dmath";
import { CELL, Mat } from "./grid";
import { buildPieceColliders, components, pieceCellWorld, type PieceCell } from "./terrain";
import { chainAtCell, hangPiece } from "./sim-chains";

export function crumbleUnder(sim: Sim, f: Fighter, x: number) {
  const g = sim.grid;
  const cy = g.cy(sim.feetY(f) - 0.1);
  for (const ox of [-0.3, 0, 0.3]) {
    const cx = g.cx(x + ox);
    if (g.matAt(cx, cy) !== Mat.Crumble) continue;
    const m = Mat.Crumble;
    damageTerrainCell(sim, cx, cy, m, sim.ruleset.arena.terrain.crumbleDps * DT);
  }
}

/** Damage the static cell just behind a hit point on terrain. */
export function chipTerrain(sim: Sim, x: number, y: number, dx: number, dy: number, dmg: number) {
  const g = sim.grid;
  const cx = g.cx(x + dx * 0.05);
  const cy = g.cy(y + dy * 0.05);
  const m = g.matAt(cx, cy);
  if (m !== Mat.Empty) damageTerrainCell(sim, cx, cy, m, dmg);
}

/** Damage one static cell; returns true when it broke (with stats and a carve event). */
export function damageTerrainCell(sim: Sim, cx: number, cy: number, mat: Mat, damage: number): boolean {
  if (!sim.terrain.damageCell(cx, cy, damage)) return false;
  sim.stats.cellsDestroyed++;
  const g = sim.grid;
  sim.events.push({ type: "carve", tick: sim.tick, cells: [{ x: g.wx(cx) + CELL / 2, y: g.wy(cy) + CELL / 2, mat }] });
  return true;
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
    // a group with one anchor left hangs from that chain (#34)
    let hanger = -1;
    let snappedBy: number | null = null; // its last chain snapped this tick: who broke it
    const cells: PieceCell[] = comp.map((c) => {
      const cell: PieceCell = { lx: c.cx - minCx, ly: c.cy - minCy, mat: c.mat, hp: c.hp };
      const ch = chainAtCell(sim, c.cx, c.cy);
      if (ch && c.anchor && !ch.broken) {
        cell.chain = ch.id;
        hanger = ch.id;
      } else if (ch?.broken) {
        cell.stub = ch.id;
        if (ch.brokenTick === sim.tick) snappedBy = ch.lastHitBy;
      }
      return cell;
    });
    const e = makePiece(sim, cells, sim.grid.wx(minCx), sim.grid.wy(minCy), 0, { x: 0, y: 0 }, 0);
    sim.stats.cellsDetached += cells.length;
    sim.stats.piecesFallen++;
    if (cells.length >= 4) sim.stats.platformsFallen++;
    const t = e.body.translation();
    sim.events.push({ type: "detach", tick: sim.tick, entity: e.id, cells: cells.length, x: t.x + e.hw, y: t.y + e.hh });
    if (hanger >= 0) {
      sim.stats.platformsSwung++;
      sim.events.push({ type: "platformSwing", tick: sim.tick, entity: e.id, chain: hanger, x: t.x + e.hw, y: t.y + e.hh });
    } else if (snappedBy !== null) {
      // it falls, and what it crushes is credited to whoever broke the chain
      e.triggeredBy = snappedBy;
      sim.stats.platformsDropped++;
      sim.events.push({ type: "platformFall", tick: sim.tick, entity: e.id, x: t.x + e.hw, y: t.y + e.hh, by: e.triggeredBy });
    }
  }
}

function makePiece(sim: Sim, cells: PieceCell[], x: number, y: number, angle: number, v: { x: number; y: number }, w: number): Entity {
  const body = sim.world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y).setRotation(angle).setLinvel(v.x, v.y).setAngvel(w).setLinearDamping(0.05).setAngularDamping(0.4).setCcdEnabled(cells.length >= 6),
  );
  const colliders = buildPieceColliders(sim.world, body, cells, sim.grid.density);
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
  hangPiece(sim, e);
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
  prunePiece(sim, e);
}

/** Drop a piece's cells with no hit points left, splitting what remains into new pieces. */
export function prunePiece(sim: Sim, e: Entity) {
  const t = e.body.translation();
  const a = e.body.rotation();
  const cells = e.cells!;
  const left = cells.filter((c) => c.hp > 0);
  const v = e.body.linvel();
  const w = e.body.angvel();
  sim.entityStore.remove(e);
  if (left.length === 0) return;
  for (const comp of components(left)) {
    const p = makePiece(sim, comp, t.x, t.y, a, v, w);
    if (e.triggeredBy !== undefined) p.triggeredBy = e.triggeredBy;
  }
}
