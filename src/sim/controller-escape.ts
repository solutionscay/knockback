/**
 * Getting out of bad terrain (#100). A house bot standing in a pocket (a blast crater, a carved hole, a box under a
 * fallen ledge): the floor its plan can reach, in all, is under ESCAPE.trappedFloor meters (a crater's ragged walls are
 * one-cell steps the nav graph cannot use) for ESCAPE.confirmTicks. It then heads for the nearest open floor it cannot
 * reach (ESCAPE.lookUp meters above its feet at most): walks and hops up the steps toward it; facing a wall too tall to
 * hop onto (no step within ESCAPE.wallH), or making no progress for ESCAPE.stallTicks, it digs at the rim up and
 * ahead with ESCAPE.digWith: digging punches (Input.dig: arena.terrain.dig, a carve at arm's length; no ammo spent).
 * Not the bat or hammer, whose wide carve takes the floor under the bot too, and no blast at point blank. The swings cycle flat, steep and near straight up: a staircase. Then it climbs
 * again. It hops only onto a step, never in place. It stops once it stands at the exit's height, or after
 * ESCAPE.giveUpTicks (and waits ESCAPE.restTicks before trying again).
 *
 * Deterministic (no RNG); it only reads the sim. The controller hands it the round's input when it is not shooting.
 */
import type { NavGraph } from "./nav";
import type { Sim } from "./sim";
import type { Fighter, Input, Weapon } from "./sim-types";

export const ESCAPE = {
  /** reachable floor (total width of the surfaces the plan reaches) below this: trapped */
  trappedFloor: 8,
  /** how often the floor is measured, and how long trapped before acting */
  checkTicks: 15,
  confirmTicks: 30,
  /** a wall in front at least this tall (m above the feet, solid all the way) is dug, not hopped */
  wallH: 2.6,
  /** the open floor to head for: at least this wide, at most lookUp m above the feet and lookDown below */
  minFloor: 2,
  lookUp: 6,
  lookDown: 1,
  /** climbing with no progress (0.3 m closer) this long: dig */
  stallTicks: 30,
  /** one round of digging, then climb again */
  digTicks: 70,
  giveUpTicks: 1200,
  /** hopping in place (#88's pattern): this many jumps within hopTicks inside hopBox m: walk (and dig) for breakTicks */
  hops: 3,
  hopTicks: 240,
  hopBox: 1,
  breakTicks: 120,
  /** what it digs with, the first it holds (fists always): digging punches (#95: every weapon's ammo is precious) */
  digWith: ["fist"] as Weapon[],
  restTicks: 120,
};

/** The total width of the surfaces a fighter's plan reaches from `surface` at x (#100: the trapped measure). */
export function reachableFloor(sim: Sim, surface: number, x: number): { floor: number; plan: ReturnType<NavGraph["plan"]> } {
  const plan = sim.nav.fighterPlan(sim.grid, surface, x);
  let floor = 0;
  sim.nav.surfaces.forEach((s, i) => {
    if (plan.cost[i] !== Infinity) floor += s.x1 - s.x0;
  });
  return { floor, plan };
}

interface Exit { x: number; y: number }

export class Escape {
  private trappedSince = -1;
  private nextCheck = 0;
  private active = false;
  private started = 0;
  private restUntil = -1;
  private exit: Exit | null = null;
  /** recent jumps (tick, x) and the hop-breaker's end */
  private jumps: { t: number; x: number }[] = [];
  private breakUntil = -1;
  private breakDir: 1 | -1 = 1;
  breaks = 0;
  private best = Infinity;
  private bestTick = 0;
  private digUntil = -1;
  /** for tests and stats: ticks spent escaping, digs started */
  escapeTicks = 0;
  digs = 0;
  /** each escape: when it started and ended, where from, how many digs, and whether the plan reached open floor */
  readonly log: { start: number; end: number; x: number; y: number; digs: number; out: boolean }[] = [];

  constructor(id: number) {
    this.nextCheck = id * 3; // the seats measure on different ticks
  }

  get escaping() {
    return this.active;
  }

  /** Re-measure every checkTicks (staggered by seat); true while trapped for confirmTicks. */
  private trapped(sim: Sim, me: Fighter): boolean {
    if (sim.tick < this.nextCheck) return this.trappedSince >= 0 && sim.tick - this.trappedSince >= ESCAPE.confirmTicks;
    this.nextCheck = sim.tick + ESCAPE.checkTicks;
    if (!me.grounded || me.surface < 0) return this.trappedSince >= 0 && sim.tick - this.trappedSince >= ESCAPE.confirmTicks;
    const { floor, plan } = reachableFloor(sim, me.surface, sim.pos(me).x);
    if (floor >= ESCAPE.trappedFloor) {
      this.trappedSince = -1;
      return false;
    }
    if (this.trappedSince < 0) this.trappedSince = sim.tick;
    if (!this.active) this.exit = this.findExit(sim, me, plan);
    return sim.tick - this.trappedSince >= ESCAPE.confirmTicks;
  }

  /** The nearest open floor the plan does not reach: wide enough, not far above or below the feet. */
  private findExit(sim: Sim, me: Fighter, plan: ReturnType<NavGraph["plan"]>): Exit | null {
    const p = sim.pos(me);
    const feet = sim.feetY(me);
    let best: Exit | null = null;
    let bestScore = Infinity;
    sim.nav.surfaces.forEach((s, i) => {
      if (plan.cost[i] !== Infinity || s.x1 - s.x0 < ESCAPE.minFloor || s.liquid) return;
      if (s.y > feet + ESCAPE.lookUp || s.y < feet - ESCAPE.lookDown) return;
      const x = Math.max(s.x0 + 0.6, Math.min(s.x1 - 0.6, p.x));
      const score = Math.abs(x - p.x) + Math.max(0, s.y - feet) * 2.5;
      if (score < bestScore) {
        bestScore = score;
        best = { x, y: s.y };
      }
    });
    return best;
  }

  /** Steer `input` out of the pocket; false when not trapped (the controller plays on as usual). */
  act(sim: Sim, me: Fighter, input: Input): boolean {
    if (!me.alive || me.stun > 0 || me.pinned > 0) return false;
    if (this.active) {
      // out once it stands at the exit's height (a route the plan sees from a half-dug ledge is not out yet)
      if (me.grounded && this.exit && sim.feetY(me) >= this.exit.y - 0.3) return this.stop(sim, 0);
    }
    const trapped = this.active || this.trapped(sim, me);
    if (!this.active) {
      if (!trapped || sim.tick < this.restUntil || !this.exit) return false;
      this.active = true;
      this.started = sim.tick;
      const p = sim.pos(me);
      this.log.push({ start: sim.tick, end: -1, x: Math.round(p.x * 10) / 10, y: Math.round(sim.feetY(me) * 10) / 10, digs: 0, out: false });
      this.best = Infinity;
      this.bestTick = sim.tick;
      this.digUntil = -1;
    }
    if (sim.tick - this.started > ESCAPE.giveUpTicks || !this.exit) return this.stop(sim, ESCAPE.restTicks);
    this.escapeTicks++;
    const p = sim.pos(me);
    const feet = sim.feetY(me);
    const exit = this.exit;
    const dir: 1 | -1 = exit.x >= p.x ? 1 : -1;
    const d = Math.abs(exit.x - p.x) + Math.max(0, exit.y - feet);
    if (d < this.best - 0.3) {
      this.best = d;
      this.bestTick = sim.tick;
    }
    input.move = 0;
    input.jump = false;
    input.fire = false;
    input.thrust = false;
    if (sim.tick < this.digUntil) {
      this.dig(sim, me, input, dir, exit, feet);
      return true;
    }
    // the column in front: a wall, and a step on it to land on (solid, with room for the body above, within a jump)
    const g = sim.grid;
    const ahead = g.cx(p.x + dir * 0.7);
    const base = g.cy(feet + 0.1);
    const wall = g.solid(ahead, base) || g.solid(ahead, base + 1) || g.solid(ahead, base + 2);
    let step = false;
    for (let cy = base; cy <= g.cy(feet + ESCAPE.wallH); cy++) {
      if (g.solid(ahead, cy) && !g.solid(ahead, cy + 1) && !g.solid(ahead, cy + 2) && !g.solid(ahead, cy + 3)) {
        step = true;
        break;
      }
    }
    const tall = wall && !step;
    if (me.grounded && (sim.tick - this.bestTick > ESCAPE.stallTicks || (tall && Math.abs(exit.x - p.x) > 0.8))) {
      this.digUntil = sim.tick + ESCAPE.digTicks;
      this.bestTick = sim.tick + ESCAPE.digTicks; // climbing gets its own time after the dig
      this.digs++;
      const cur = this.log[this.log.length - 1];
      if (cur) cur.digs++;
      this.dig(sim, me, input, dir, exit, feet);
      return true;
    }
    // climb: walk at the exit, hop whatever stands in front of the body
    input.move = dir;
    input.aimX = dir;
    input.aimY = 0;
    // hop only onto a step; on open ground it walks (no hopping in place)
    if (me.grounded && me.jumpCd === 0 && wall && step) input.jump = true;
    if (!me.grounded && me.jumpCd > 0) input.jump = true; // hold: a fuller jump
    return true;
  }

  /** Swing (or shoot) at the rim up and ahead: a ramp toward the exit. */
  private dig(sim: Sim, me: Fighter, input: Input, dir: 1 | -1, exit: Exit, feet: number) {
    const w = ESCAPE.digWith.find((x) => x === "fist" || me.weapons.includes(x)) ?? "fist";
    input.weapon = w;
    // up the wall when the exit is above: a staircase, cycling the swing flat (the next step), steep and near straight
    // up (the room over it); straight ahead otherwise
    const AIMS: readonly [number, number][] = [[1, 0.2], [0.6, 0.8], [0.3, 0.95]];
    const [ax, ay] = exit.y > feet + 0.5 ? AIMS[(sim.tick >> 5) % 3]! : [1, 0.1];
    const l = Math.sqrt(ax * ax + ay * ay);
    input.aimX = (dir * ax) / l;
    input.aimY = ay / l;
    input.move = 0;
    input.fire = (sim.weapon(me) === w || w === "fist") && me.swap === 0 && me.cooldown[w] === 0;
    input.dig = w === "fist";
  }

  /**
   * Outside the zone, a bot never stands still (#100): the zone zaps it every second and it would land where it
   * stood (a rifle held steady at a target, a hole behind a wall). With no walk of its own, it walks toward the zone's
   * middle. On the final input.
   */
  intoZone(sim: Sim, me: Fighter, input: Input) {
    if (input.move !== 0 || !me.alive || !me.outsideZone) return;
    input.move = sim.zone.center >= sim.pos(me).x ? 1 : -1;
  }

  /**
   * The hop-breaker, on the final input: a bot that has hopped `hops` times in hopTicks without moving hopBox m sideways
   * (a jump turned back by a ceiling, a shot taken mid-air) stops jumping for breakTicks and walks toward its target
   * (the zone's middle when outside it), digging a wall in front with digWith.
   */
  breakHops(sim: Sim, me: Fighter, input: Input, targetX: number | null) {
    if (!me.alive) return;
    const p = sim.pos(me);
    if (sim.tick < this.breakUntil) {
      input.jump = false;
      input.thrust = false;
      if (input.fire) return; // a shot it is taking stays
      input.move = this.breakDir;
      const g = sim.grid;
      const ahead = g.cx(p.x + this.breakDir * 0.7);
      const feet = sim.feetY(me);
      if (me.grounded && (g.solid(ahead, g.cy(feet + 0.3)) || g.solid(ahead, g.cy(feet + 1.2)))) {
        this.dig(sim, me, input, this.breakDir, { x: p.x + this.breakDir * 3, y: feet }, feet);
      }
      return;
    }
    if (input.jump && me.grounded && me.jumpCd === 0) {
      this.jumps.push({ t: sim.tick, x: p.x });
      while (this.jumps.length && sim.tick - this.jumps[0]!.t > ESCAPE.hopTicks) this.jumps.shift();
      if (this.jumps.length >= ESCAPE.hops) {
        let x0 = Infinity, x1 = -Infinity;
        for (const j of this.jumps) {
          x0 = Math.min(x0, j.x);
          x1 = Math.max(x1, j.x);
        }
        if (x1 - x0 < ESCAPE.hopBox) {
          const to = me.outsideZone || targetX === null ? sim.zone.center : targetX;
          this.breakDir = to >= p.x ? 1 : -1;
          this.breakUntil = sim.tick + ESCAPE.breakTicks;
          this.jumps = [];
          this.breaks++;
          input.jump = false;
        }
      }
    }
  }

  private stop(sim: Sim, rest: number): false {
    const cur = this.log[this.log.length - 1];
    if (cur && cur.end < 0) {
      cur.end = sim.tick;
      cur.out = rest === 0;
    }
    this.active = false;
    this.exit = null;
    this.digUntil = -1;
    this.restUntil = sim.tick + rest;
    return false;
  }
}
