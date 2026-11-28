import { length2D } from "./dmath";
import { CELL, Liquid, Mat } from "./grid";
import type { Sim } from "./sim";
import { absorbHit, fieldCut } from "./sim-field";
import type { Fighter, ForceField } from "./sim-types";

/** Resolve all three rays against the same terrain, then apply each contact once. */
export function sprayCoolant(sim: Sim, shooter: Fighter, ox: number, oy: number, dx: number, dy: number) {
  const spec = sim.ruleset.weapons.table.freezegun;
  const g = sim.grid;
  const cells = new Set<number>();
  const victims = new Set<Fighter>();
  const fields = new Map<ForceField, { x: number; y: number }>();
  for (const slope of [0, -spec.spread, spec.spread]) {
    const length = length2D(1, slope);
    const rx = (dx - dy * slope) / length, ry = (dy + dx * slope) / length;
    const hit = sim.raycast(ox, oy, rx, ry, spec.range, shooter.entity.collider);
    const cut = fieldCut(sim, ox, oy, rx, ry, hit?.dist ?? spec.range);
    const dist = cut?.dist ?? hit?.dist ?? spec.range;
    if (cut) fields.set(cut.field, { x: ox + rx * dist, y: oy + ry * dist });
    else if (hit?.entity?.fighter?.alive) victims.add(hit.entity.fighter);
    for (let d = 0; d < dist; d += CELL / 2) {
      const cx = g.cx(ox + rx * d), cy = g.cy(oy + ry * d);
      if (g.inside(cx, cy) && g.liq[g.idx(cx, cy)] === Liquid.Water) cells.add(g.idx(cx, cy));
    }
  }
  for (const [field, p] of fields) absorbHit(sim, field, spec.damage, p.x, p.y, "freezegun", shooter.id);
  for (const victim of victims) {
    const p = sim.pos(victim);
    victim.chilled = spec.chillTicks;
    sim.damageFighter(victim, spec.damage, shooter.id, 0, 0, "freezegun", p.x, p.y);
  }
  for (const i of cells) sim.terrain.placeCell(i % g.cols, Math.floor(i / g.cols), Mat.Ice);
  sim.events.push({ type: "freeze", tick: sim.tick, fighter: shooter.id, cells: cells.size, hits: victims.size });
}
