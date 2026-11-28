import { length2D } from "./dmath";
import { CELL, Liquid } from "./grid";
import { fieldApart } from "./sim-field";
import type { Sim } from "./sim";
import type { Entity, EntityKind } from "./sim-types";

export const isTank = (kind: EntityKind): kind is "waterTank" | "oilTank" => kind === "waterTank" || kind === "oilTank";

/** Fill connected empty cells from the rupture outwards. The floor and walls contain the initial spill. */
export function burstTank(sim: Sim, tank: Entity, owner: number) {
  if (tank.dead || !isTank(tank.kind)) return;
  const kind = tank.kind, { x, y } = tank.body.translation();
  sim.entityStore.remove(tank);
  const water = kind === "waterTank";
  const liquid = water ? Liquid.Water : Liquid.Oil;
  const g = sim.grid, spec = sim.ruleset.arena.props.tank;
  const queue: [number, number][] = [[g.cx(x), g.cy(y)]];
  const seen = new Set<number>();
  let cells = 0;
  for (let n = 0; n < queue.length && cells < spec.cells; n++) {
    const [cx, cy] = queue[n]!;
    if (!g.inside(cx, cy)) continue;
    const i = g.idx(cx, cy);
    if (seen.has(i)) continue;
    seen.add(i);
    if (g.mat[i] || (g.liq[i] && g.liq[i] !== liquid)) continue;
    if (length2D(g.wx(cx) + CELL / 2 - x, g.wy(cy) + CELL / 2 - y) > spec.radius) continue;
    if (!g.liq[i]) { g.liq[i] = liquid; cells++; }
    queue.push([cx, cy - 1], [cx - 1, cy], [cx + 1, cy], [cx, cy + 1]);
  }
  if (cells) {
    sim.liquids.on = true;
    sim.liquids.active = true;
    sim.terrain.version++; // the bot graph now has wet landing spots
  }
  const washed: number[] = [];
  if (water) for (const f of sim.alive()) {
    const p = sim.pos(f), dx = p.x - x, dy = p.y - y;
    const d = length2D(dx, dy);
    if (d >= spec.radius || fieldApart(sim, x, y, p.x, p.y)) continue;
    if (d > 0 && sim.raycast(x, y, dx / d, dy / d, d)?.terrain) continue;
    const v = sim.vel(f), dir = Math.sign(dx) || Math.sign(x - sim.zone.center) || f.facing;
    f.entity.body.setLinvel({ x: v.x + dir * spec.washSpeed * (1 - d / spec.radius), y: v.y }, true);
    if (f.burning) {
      f.burning = 0;
      sim.events.push({ type: "douse", tick: sim.tick, fighter: f.id, x: p.x, y: p.y });
    }
    if (owner >= 0 && owner !== f.id) {
      f.lastHitCause = "waterTank"; f.lastHitBy = owner; f.lastHitTick = sim.tick;
    }
    washed.push(f.id);
  }
  sim.events.push({ type: "tankBurst", tick: sim.tick, entity: tank.id, tank: kind, x, y, owner, cells, washed });
}
