import RAPIER from "@dimforge/rapier2d-deterministic-compat";
import { G, WEAPONS, groups } from "./constants";
import { clamp, length2D } from "./dmath";
import { CELL, Mat, type Grid } from "./grid";
import { traceRail } from "./rail-terrain";
import type { Sim } from "./sim";
import { hitProp } from "./sim-objects";
import { damagePiece, damageTerrainCell } from "./sim-terrain";
import type { Entity, Fighter } from "./sim-types";

export function fireRailgun(sim: Sim, f: Fighter, x: number, y: number, dx: number, dy: number) {
  const spec = WEAPONS.railgun;
  const fighters = new Map<Entity, number>();
  const obstacle: { entity: Entity | null; distance: number } = { entity: null, distance: spec.range };
  sim.world.intersectionsWithRay(new RAPIER.Ray({ x, y }, { x: dx, y: dy }), spec.range, true, hit => {
    const entity = sim.entityOf(hit.collider);
    if (!entity || entity.dead) return true;
    const d = hit.timeOfImpact;
    if (entity.fighter?.alive) fighters.set(entity, d);
    else if (entity.kind !== "fighter" && (d < obstacle.distance || (d === obstacle.distance && entity.id < (obstacle.entity?.id ?? Infinity)))) {
      obstacle.distance = d;
      obstacle.entity = entity;
    }
    return true;
  }, undefined, groups(0xffff, G.FIGHTER | G.PROP), f.entity.collider);

  const distance = traceRail(sim.grid, x, y, dx, dy, obstacle.distance, (cx, cy) => {
    damageTerrainCell(sim, cx, cy, sim.grid.matAt(cx, cy), spec.terrainDamage);
  });
  for (const [e, d] of [...fighters].sort((a, b) => a[1] - b[1] || a[0].id - b[0].id)) {
    if (d > distance) break;
    sim.damageFighter(e.fighter!, spec.damage, f.id, dx * spec.knockback, dy * spec.knockback + spec.lift, "railgun", x + dx * d, y + dy * d);
  }
  const ex = x + dx * distance, ey = y + dy * distance;
  const e = obstacle.entity;
  if (e && distance === obstacle.distance) {
    if (e.kind === "chunk") damagePiece(sim, e, ex, ey, CELL, spec.propDamage);
    else hitProp(sim, e, spec.propDamage, f.id, "railgun", ex, ey);
  }
  sim.events.push({ type: "rail", tick: sim.tick, fighter: f.id, x0: x, y0: y, x1: ex, y1: ey });
}

/** Highest continuous floor within one allowed step of the previous wave sample. */
function floorAt(grid: Grid, x: number, y: number): number | null {
  const step = WEAPONS.hammer.groundStep;
  const cx = grid.cx(x);
  for (let cy = grid.cy(y + step) - 1; cy >= grid.cy(y - step) - 1; cy--) {
    const top = grid.wy(cy + 1);
    if (top >= y - step && grid.solid(cx, cy) && !grid.solid(cx, cy + 1)) return top;
  }
  return null;
}

export function slamHammer(sim: Sim, f: Fighter, x: number, dx: number) {
  const spec = WEAPONS.hammer;
  const y = sim.feetY(f);
  const grid = sim.grid;
  const impactX = x + Math.sign(dx) * 0.85;
  const impactY = y + 0.65;
  const r = spec.terrainRadius;
  // Carve the wall in front of the swing while leaving the wave's floor intact.
  for (let cy = grid.cy(y + 0.2); cy <= grid.cy(impactY + r); cy++) {
    for (let cx = grid.cx(impactX - r); cx <= grid.cx(impactX + r); cx++) {
      const mat = grid.matAt(cx, cy);
      if (mat === Mat.Empty || grid.wy(cy) + CELL / 2 <= y + 0.2) continue;
      const d = length2D(grid.wx(cx) + CELL / 2 - impactX, grid.wy(cy) + CELL / 2 - impactY);
      if (d < r) damageTerrainCell(sim, cx, cy, mat, spec.terrainDamage * (1 - d / r));
    }
  }
  const props = new Set<Entity>();
  sim.world.intersectionsWithShape({ x: impactX, y: impactY }, 0, new RAPIER.Ball(r), c => {
    const e = sim.entityOf(c);
    if (e && !e.dead && e.kind !== "fighter" && e.kind !== "item" && e.kind !== "grenade") props.add(e);
    return true;
  });
  for (const e of [...props].sort((a, b) => a.id - b.id)) {
    if (e.dead) continue;
    if (e.kind === "chunk") damagePiece(sim, e, impactX, impactY, r, spec.terrainDamage);
    else hitProp(sim, e, spec.propDamage, f.id, "hammer", impactX, impactY);
  }
  const paths = [-1, 1].map(dir => {
    const path = [{ x, y }];
    let prev = y;
    for (let d = CELL / 2; d <= spec.range; d += CELL / 2) {
      const wx = x + dir * d;
      const top = floorAt(sim.grid, wx, prev);
      if (top === null) break;
      path.push({ x: wx, y: top });
      prev = top;
    }
    return path;
  });
  for (const rival of sim.fighters) {
    if (!rival.alive || rival === f) continue;
    const p = sim.pos(rival);
    const rx = p.x - x;
    const dir = rx < 0 ? -1 : 1;
    const d = Math.abs(rx);
    const point = paths[rx < 0 ? 0 : 1]![Math.round(d / (CELL / 2))];
    if (!point || Math.abs(sim.feetY(rival) - point.y) > spec.feetReach) continue;
    const scale = clamp(1 - d / (spec.range * 1.6), 0, 1);
    sim.damageFighter(rival, spec.damage * scale, f.id, dir * spec.knockback * scale, spec.lift * scale, "hammer", p.x, p.y);
  }
  sim.events.push({ type: "shockwave", tick: sim.tick, fighter: f.id, x, y, paths });
}
