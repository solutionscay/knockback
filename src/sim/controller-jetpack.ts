import { DT, FIGHTER, GRAVITY, POWER } from "./constants";
import { clamp } from "./dmath";
import type { Surface } from "./nav";
import type { Fighter, Input, Sim } from "./sim";

type Point = { x: number; y: number };
type Flight = { x: number; y: number; edge: number; until: number };

const FEET = FIGHTER.halfHeight + FIGHTER.radius;
const CLEARANCE = FIGHTER.radius + 0.25;

export class JetpackPilot {
  private flight: Flight | null = null;

  steer(sim: Sim, me: Fighter, target: Fighter, p: Point, v: Point, input: Input, rush: boolean, requested: boolean): boolean {
    if (me.stun > 0) return false;
    if (this.flight && (sim.tick > this.flight.until ||
        sim.nav.surfaceAt(this.flight.x, this.flight.y, 0.1)?.y !== this.flight.y ||
        (me.grounded && Math.abs(sim.feetY(me) - this.flight.y) < 0.3))) this.flight = null;
    if (this.flight) {
      if (this.fly(me, p, v, input, this.flight)) return true;
      this.flight = null;
    }
    if (me.power.jetpack <= 0) return false;

    const t = sim.pos(target);
    const half = sim.zoneHalfAhead(60);
    const outside = sim.zoneEnabled && Math.abs(p.x - sim.zone.center) > half - 0.5;
    const falling = !me.grounded && v.y < -1 && sim.nav.fallBelow(sim.grid, p.x, sim.feetY(me)) > 5;
    if (outside || falling) {
      const x = outside ? clamp(p.x, sim.zone.center - half + 2, sim.zone.center + half - 2) : p.x;
      input.move = outside ? Math.sign(x - p.x) : input.move;
      if (falling || (outside && Math.abs(input.move) > 0.5 && this.clear(sim, me, p.x, p.y, 0, 1, 2.3))) {
        this.boost(input);
        return true;
      }
    }

    const upper = sim.nav.surfaces[target.surface];
    const rise = upper ? upper.y - sim.feetY(me) : 0;
    if (upper && target.grounded && rise > 2.5 && !outside && Math.abs(t.x - p.x) < 11) {
      const cost = sim.nav.plan(me.surface, p.x).cost[upper.id] ?? Infinity;
      if (requested || cost > 15) {
        this.flight = this.route(sim, me, p, upper);
        if (this.flight) return this.fly(me, p, v, input, this.flight);
      }
    }

    // A chase burst is useful across open space, with no ceiling to hit.
    const dx = t.x - p.x;
    const dir = Math.sign(dx);
    const distance = Math.abs(dx);
    if ((rush || requested) && distance > (requested ? 3 : 7) && distance < 17 &&
        Math.abs(t.y - p.y) < 2 && (requested || input.move * dir > 0.5) &&
        this.clear(sim, me, p.x, p.y, dir, 0, Math.min(distance - 1, 5)) &&
        this.clear(sim, me, p.x, p.y, 0, 1, 2.8)) {
      input.move = dir;
      this.boost(input);
      return true;
    }
    return false;
  }

  private route(sim: Sim, me: Fighter, p: Point, surface: Surface): Flight | null {
    if (surface.x1 - surface.x0 < 1.5) return null;
    const top = surface.y + FEET + 0.35;
    const rise = top - p.y;
    const pack = POWER.jetpack;
    const burnSeconds = me.power.jetpack * DT;
    // Conservative budget: reserve time for acceleration and crossing the lip.
    if (rise > Math.max(0, burnSeconds - pack.riseSpeed / (pack.thrust - GRAVITY) / 2 - 0.15) * pack.riseSpeed) return null;

    let best: Flight | null = null;
    let score = Infinity;
    for (const side of [-1, 1]) {
      const lip = side < 0 ? surface.x0 : surface.x1;
      const edge = lip + side * CLEARANCE;
      const approach = Math.abs(edge - p.x);
      if (approach > 7 || approach > score) continue;
      if (approach > 0.35 && !this.clear(sim, me, p.x, p.y, Math.sign(edge - p.x), 0, approach)) continue;
      // Check both sides of the capsule as it rises beside the lip.
      if (![-FIGHTER.radius, FIGHTER.radius].every((offset) =>
        this.clear(sim, me, edge + offset, p.y, 0, 1, rise + FEET))) continue;
      const x = lip - side * 0.75;
      if (!this.clear(sim, me, edge, top, -side, 0, Math.abs(x - edge))) continue;
      score = approach;
      best = { x, y: surface.y, edge, until: sim.tick + 160 };
    }
    return best;
  }

  private fly(me: Fighter, p: Point, v: Point, input: Input, flight: Flight): boolean {
    const above = p.y >= flight.y + FEET + 0.22;
    const over = Math.abs(p.x - flight.x) < 0.6;
    if (!above && me.power.jetpack <= 0 && !over) return false;
    const x = above || over ? flight.x : flight.edge;
    input.move = clamp((x - p.x) * 1.8 - v.x * 0.14, -1, 1);
    input.jump = false;
    if (me.power.jetpack > 0 && !above && !over && Math.abs(flight.edge - p.x) < 0.55) this.boost(input);
    return true;
  }

  private boost(input: Input) {
    input.thrust = true;
    input.jump = false;
  }

  private clear(sim: Sim, me: Fighter, x: number, y: number, dx: number, dy: number, distance: number): boolean {
    const hit = sim.raycast(x, y, dx, dy, distance, me.entity.collider);
    return !hit || hit.entity?.kind === "fighter" || hit.entity?.kind === "item";
  }
}
