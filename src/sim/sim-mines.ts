import { DT, WEAPONS } from "./constants";
import { dcos, dsin, length2D } from "./dmath";
import type { Sim } from "./sim";
import type { Fighter, Mine } from "./sim-types";

const M = WEAPONS.mine;

export function throwMine(sim: Sim, f: Fighter, x: number, y: number, dx: number, dy: number) {
  sim.mines.push({
    id: sim.entityStore.allocateId(), owner: f.id, x, y, vx: dx * M.speed, vy: dy * M.speed + M.throwLift,
    born: sim.tick, armedAt: -1, mount: null,
  });
}

function move(sim: Sim, mine: Mine) {
  const mount = mine.mount;
  if (mount?.kind === "terrain") {
    if (sim.grid.solid(mount.cx, mount.cy)) return;
  } else if (mount?.kind === "entity") {
    const e = sim.entities.get(mount.id);
    if (e && !e.dead) {
      const p = e.body.translation();
      const rotation = e.body.rotation();
      const c = dcos(rotation), s = dsin(rotation);
      mine.x = p.x + c * mount.x - s * mount.y;
      mine.y = p.y + s * mount.x + c * mount.y;
      const v = e.body.linvel();
      mine.vx = v.x;
      mine.vy = v.y;
      return;
    }
  }
  mine.mount = null;
  mine.vy -= M.gravity * DT;
  const sx = mine.vx * DT, sy = mine.vy * DT;
  const distance = length2D(sx, sy);
  if (distance < 1e-6) return;
  const dx = sx / distance, dy = sy / distance;
  const owner = sim.fighters[mine.owner]!;
  const hit = sim.raycast(mine.x, mine.y, dx, dy, distance, owner.removed ? undefined : owner.entity.collider);
  if (!hit) {
    mine.x += sx;
    mine.y += sy;
    return;
  }
  mine.x += dx * hit.dist;
  mine.y += dy * hit.dist;
  if (hit.entity && !hit.entity.dead) {
    const e = hit.entity;
    const p = e.body.translation();
    const a = e.body.rotation();
    const c = dcos(a), s = dsin(a);
    const x = mine.x - p.x, y = mine.y - p.y;
    mine.mount = { kind: "entity", id: e.id, x: c * x + s * y, y: -s * x + c * y };
  } else {
    const cx = sim.grid.cx(mine.x + dx * 0.02), cy = sim.grid.cy(mine.y + dy * 0.02);
    if (!sim.grid.solid(cx, cy)) return;
    mine.mount = { kind: "terrain", cx, cy };
  }
  mine.vx = 0;
  mine.vy = 0;
  if (mine.armedAt < 0) mine.armedAt = sim.tick + M.armTicks;
  sim.events.push({ type: "mineStick", tick: sim.tick, x: mine.x, y: mine.y, entity: mine.id });
}

export function updateMines(sim: Sim) {
  if (sim.mines.length === 0) return;
  const keep: Mine[] = [];
  for (const mine of sim.mines) {
    move(sim, mine);
    if (mine.y < -20 || Math.abs(mine.x) > 70) continue;
    if (sim.tick === mine.armedAt) sim.events.push({ type: "mineArm", tick: sim.tick, x: mine.x, y: mine.y, entity: mine.id });
    const armed = mine.armedAt >= 0 && sim.tick >= mine.armedAt;
    const near = armed && sim.fighters.some(f => {
      if (!f.alive || f.id === mine.owner) return false;
      const p = sim.pos(f);
      return length2D(p.x - mine.x, p.y - mine.y) <= M.proximity;
    });
    if (near || sim.tick - mine.born >= M.fuse) sim.explode(mine.x, mine.y, M, "mine", mine.owner, 0, null);
    else keep.push(mine);
  }
  sim.mines = keep;
}
