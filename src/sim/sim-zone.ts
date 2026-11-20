import { DT, STALEMATE, ZONE } from "./constants";
import type { Sim } from "./sim";
import { WEAPON_LIST, type Fighter } from "./sim-types";
import { clamp } from "./dmath";

export function zoneHalfAt(tick: number, startHalf: number): number {
  const k = clamp((tick - ZONE.holdTicks) / (ZONE.shrinkEndTicks - ZONE.holdTicks), 0, 1);
  return startHalf + (ZONE.endHalf - startHalf) * k;
}

export class SimZone {
  private sdHalf = Infinity;

  /** Quiet too long with 2+ alive: sudden death (sticky for the round). */
  checkStalemate(sim: Sim, tick: number) {
    const z = sim.zone;
    const alive = sim.alive();
    if (sim.suddenDeath < 0 && alive.length >= 2 && tick - sim.lastClashTick >= STALEMATE.quietTicks) {
      sim.suddenDeath = tick;
      this.sdHalf = z.half;
      sim.events.push({ type: "suddenDeath", tick, quietTicks: tick - sim.lastClashTick });
    }
    if (sim.suddenDeath < 0) return;
    this.sdHalf = Math.max(STALEMATE.endHalf, this.sdHalf - (STALEMATE.shrinkPerSec * DT));
    z.half = Math.min(z.half, this.sdHalf);
    // a weapon between the survivors
    if (alive.length >= 2 && (tick - sim.suddenDeath) % STALEMATE.dropEvery === 0) {
      let sx = 0;
      for (const f of alive) sx += sim.pos(f).x;
      const x = clamp(sx / alive.length, z.center - z.half + 0.5, z.center + z.half - 0.5);
      const e = sim.spawnItem(sim.rng.pick(WEAPON_LIST), x, 15);
      sim.events.push({ type: "itemSpawn", tick, entity: e.id, item: e.itemType!, x, y: 15 });
    }
  }

  /** Zone half-width `ticks` from now (sudden death included): where to stand. */
  halfAhead(sim: Sim, ticks: number): number {
    const base = zoneHalfAt(sim.tick + ticks, sim.zone.startHalf);
    if (sim.suddenDeath < 0) return base;
    return Math.min(base, Math.max(STALEMATE.endHalf, this.sdHalf - STALEMATE.shrinkPerSec * (ticks / 60)));
  }
}

export function zonePush(sim: Sim, f: Fighter) {
  const z = sim.zone;
  const p = f.entity.body.translation();
  const out = !sim.zoneEnabled ? 0 : p.x < z.center - z.half ? z.center - z.half - p.x : p.x > z.center + z.half ? -(p.x - z.center - z.half) : 0;
  f.outsideZone = out !== 0;
  if (out === 0) {
    f.outsideTicks = 0;
    return;
  }
  const dir = out > 0 ? 1 : -1;
  const depth = Math.abs(out);
  // stuck outside (behind a wall, in a hole): the zone flings you back in, over obstacles
  const sd = sim.suddenDeath >= 0;
  const after = sd ? STALEMATE.shockAfter : ZONE.shockAfter;
  const every = sd ? STALEMATE.shockEvery : ZONE.shockEvery;
  if (++f.outsideTicks >= after && (f.outsideTicks - after) % every === 0) {
    const p2 = sim.pos(f);
    sim.damageFighter(f, sd ? STALEMATE.shockDamage : ZONE.shockDamage, -1, 0, 0, "zone", p2.x, p2.y);
    if (!f.alive) return;
    f.entity.body.setLinvel({ x: dir * ZONE.shockX, y: ZONE.shockY }, true);
    f.stun = Math.max(f.stun, 18);
    f.grounded = false;
    sim.events.push({ type: "zap", tick: sim.tick, fighter: f.id, x: p2.x, y: p2.y, dir });
    return;
  }
  const v = f.entity.body.linvel();
  let nvx: number;
  if (f.grounded && f.stun === 0) {
    const min = Math.min(14, ZONE.pushSpeed + ZONE.pushSpeedPerMeter * depth);
    nvx = dir > 0 ? Math.max(v.x, min) : Math.min(v.x, -min);
  } else {
    const a = ZONE.pushAccel + ZONE.pushPerMeter * depth;
    const w = v.x + dir * a * DT;
    nvx = dir > 0 ? Math.max(v.x, Math.min(w, 14)) : Math.min(v.x, Math.max(w, -14));
  }
  f.entity.body.setLinvel({ x: nvx, y: v.y }, true);
}
