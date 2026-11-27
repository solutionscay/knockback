import { DT } from "./constants";
import { clamp } from "./dmath";
import type { Surface } from "./nav";
import type { Sim } from "./sim";
import type { Fighter, Input } from "./sim-types";

type Point = { x: number; y: number };
type Flight = { x: number; y: number; edge: number; until: number; crossedLip: boolean };
type Burst = { direction: number; until: number; rescue: boolean };

export class JetpackPilot {
  private flight: Flight | null = null;
  private burst: Burst | null = null;
  private nextBurst = 0;

  steer(sim: Sim, me: Fighter, target: Fighter, p: Point, v: Point, input: Input, rush: boolean, requested: boolean): boolean {
    if (me.stun > 0) return false;
    if (this.flight && (sim.tick > this.flight.until ||
        sim.nav.surfaceAt(this.flight.x, this.flight.y, 0.1)?.y !== this.flight.y ||
        (me.grounded && Math.abs(sim.feetY(me) - this.flight.y) < 0.3))) this.flight = null;
    if (this.flight) {
      if (this.fly(sim, me, p, v, input, this.flight)) return true;
      this.flight = null;
    }
    if (me.power.jetpack <= 0) return false;

    const t = sim.pos(target);
    const [lo, hi] = sim.zoneAhead(60);
    const outside = sim.zoneEnabled && (p.x < lo + 0.5 || p.x > hi - 0.5);
    const falling = !me.grounded && v.y < -1 && sim.nav.fallBelow(sim.grid, p.x, sim.feetY(me)) > 5;
    const inward = Math.sign(sim.zone.center - p.x);
    if (this.burst && (sim.tick >= this.burst.until || (!this.burst.rescue && (outside || falling)))) {
      this.nextBurst = sim.tick + 22;
      this.burst = null;
    }
    if (!this.burst && (outside || falling) &&
        (falling || this.clear(sim, me, p.x, p.y, 0, 1, 2.3))) {
      // Hold through the first reversal of a fall. Releasing as soon as vy
      // approaches zero leaves the fighter in the pit and wastes the tank.
      this.burst = { direction: outside ? inward : 0, until: sim.tick + 36, rescue: true };
    }
    if (this.burst) {
      const dir = outside ? inward : this.burst.direction;
      if (dir) input.move = dir;
      return this.boost(input);
    }

    const upper = sim.nav.surfaces[target.surface];
    const rise = upper ? upper.y - sim.feetY(me) : 0;
    if (upper && target.grounded && rise > 2.5 && !outside && Math.abs(t.x - p.x) < 11) {
      const cost = sim.nav.fighterPlan(sim.grid, me.surface, p.x).cost[upper.id] ?? Infinity;
      if (requested || cost > 15) {
        this.flight = this.route(sim, me, p, upper);
        if (this.flight) return this.fly(sim, me, p, v, input, this.flight);
      }
    }

    // A chase burst is useful across open space, with no ceiling to hit.
    const dx = t.x - p.x;
    const dir = Math.sign(dx);
    const distance = Math.abs(dx);
    if (sim.tick >= this.nextBurst && !outside && !falling && v.y < 3 &&
        (rush || requested) && distance > (requested ? 3 : 7) && distance < 17 &&
        Math.abs(t.y - p.y) < 2 && (requested || input.move * dir > 0.5) &&
        this.clear(sim, me, p.x, p.y, dir, 0, Math.min(distance - 1, 5)) &&
        this.clear(sim, me, p.x, p.y, 0, 1, 2.8)) {
      input.move = dir;
      this.burst = { direction: dir, until: sim.tick + 22, rescue: false };
      return this.boost(input);
    }
    return false;
  }

  private route(sim: Sim, me: Fighter, p: Point, surface: Surface): Flight | null {
    if (surface.x1 - surface.x0 < 1.5) return null;
    const { radius, halfHeight } = sim.ruleset.combat.fighter;
    const feet = halfHeight + radius;
    const top = surface.y + feet + 0.35;
    const rise = top - p.y;
    const pack = sim.ruleset.pickups.power.jetpack;
    const burnSeconds = me.power.jetpack * DT;
    // Conservative budget: reserve time for acceleration and crossing the lip.
    if (rise > Math.max(0, burnSeconds - pack.riseSpeed / (pack.thrust - sim.ruleset.combat.gravity) / 2 - 0.15) * pack.riseSpeed) return null;

    let best: Flight | null = null;
    let score = Infinity;
    for (const side of [-1, 1]) {
      const lip = side < 0 ? surface.x0 : surface.x1;
      const edge = lip + side * (radius + 0.25);
      const approach = Math.abs(edge - p.x);
      if (approach > 7 || approach > score) continue;
      if (approach > 0.35 && !this.clear(sim, me, p.x, p.y, Math.sign(edge - p.x), 0, approach)) continue;
      // Check both sides of the capsule as it rises beside the lip.
      if (![-radius, radius].every((offset) =>
        this.clear(sim, me, edge + offset, p.y, 0, 1, rise + feet))) continue;
      const x = lip - side * 0.75;
      if (!this.clear(sim, me, edge, top, -side, 0, Math.abs(x - edge))) continue;
      score = approach;
      best = { x, y: surface.y, edge, until: sim.tick + 160, crossedLip: false };
    }
    return best;
  }

  private fly(sim: Sim, me: Fighter, p: Point, v: Point, input: Input, flight: Flight): boolean {
    const body = sim.ruleset.combat.fighter;
    const above = p.y >= flight.y + (body.halfHeight + body.radius) + 0.22;
    const over = Math.abs(p.x - flight.x) < 0.6;
    if (!above && !over && (me.power.jetpack <= 0 || flight.crossedLip)) return false;
    if (above) flight.crossedLip = true;
    const x = flight.crossedLip || over ? flight.x : flight.edge;
    input.move = clamp((x - p.x) * 1.8 - v.x * 0.14, -1, 1);
    input.jump = false;
    if (me.power.jetpack > 0 && !above && !over && Math.abs(flight.edge - p.x) < 0.55) this.boost(input);
    return true;
  }

  private boost(input: Input) {
    input.thrust = true;
    input.jump = false;
    return true;
  }

  private clear(sim: Sim, me: Fighter, x: number, y: number, dx: number, dy: number, distance: number): boolean {
    const hit = sim.raycast(x, y, dx, dy, distance, me.entity.collider);
    return !hit || hit.entity?.kind === "fighter" || hit.entity?.kind === "item";
  }
}
