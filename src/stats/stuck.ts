/**
 * Stuck and aimless detector (#88): watches a fight tick by tick and flags stretches where a fighter is busy going
 * nowhere while the fight goes on without it.
 *
 * A window of WINDOW_TICKS (3 s) is flagged for a fighter when, over the whole window:
 *   - it is alive, two or more fighters are alive, and the round is not in its finish pause;
 *   - it deals no fighter damage and takes none (it is not in a fight);
 *   - its feet stay in a box under BOX_W wide and BOX_H high (low net displacement);
 *   - and it is active: JUMPS or more jumps (takeoffs) -> "hop" (jumping in place), or else a walked path of
 *     PATH_M or more with REVERSALS or more turns -> "pace" (oscillating left and right).
 * Standing still (no jumps, no pacing) is not counted here: that is the #69 "staring" metric (scripts/behavior.ts).
 * Flagged windows that touch merge into one episode. An episode is labelled with what the fighter was doing at its
 * start: stance, retaliate, held weapon, build, the map theme, the seat kind, and whether its target could be
 * reached (a nav route to the target's surface, or the target inside the held weapon's reach).
 */
import type { Fight } from "../sim/fight";
import { weaponReach } from "../sim/controller-weapons";
import type { Input, SimEvent } from "../sim/sim-types";

export const WINDOW_TICKS = 180;
const STEP_TICKS = 15;
const BOX_W = 2.0;
const BOX_H = 2.5;
const JUMPS = 3;
const PATH_M = 5;
const REVERSALS = 3;

export type StuckKind = "hop" | "pace";

export interface StuckEpisode {
  fighter: number;
  kind: StuckKind;
  start: number;
  end: number;
  x: number;
  y: number;
  jumps: number;
  path: number;
  fires: number;
  stance: string;
  /** the plan's stance (stance is the one played, after the controller's guards) */
  plan: string;
  retaliate: string;
  weapon: string;
  build: string;
  theme: string;
  seat: string;
  target: number;
  reachable: boolean;
  routeCost: number;
  grounded: boolean;
  /** fighters alive at the start */
  alive: number;
  /** distance to the target at the start (-1: none) */
  targetDist: number;
}

interface Sample {
  x: number;
  y: number;
  takeoff: boolean;
  fire: boolean;
  busy: boolean;
}

/** The detector for one fight. Call `tick()` after every `fight.step()` (or `Match.step()`), `hit()` on hit events. */
export class StuckDetector {
  readonly episodes: StuckEpisode[] = [];
  /** alive ticks per fighter (with 2+ alive) */
  readonly aliveTicks = [0, 0, 0, 0];
  /** alive ticks per fighter by held weapon ("w:rocket") and by stance played ("s:cover") */
  readonly exposure: Record<string, number>[] = [{}, {}, {}, {}];
  /** "staring" ticks per fighter, as the #69 scorecard counts them (scripts/behavior.ts): 1.5 s or more under 0.6 m/s,
   * target alive, not firing. Kept beside the stuck counts so a fix that trades pacing for standing shows. */
  readonly stareTicks = [0, 0, 0, 0];
  private readonly stillRun = [0, 0, 0, 0];
  private readonly samples: Sample[][] = [[], [], [], []];
  private readonly inputs: (Input | null)[] = [null, null, null, null];
  private readonly lastFight = [-1e9, -1e9, -1e9, -1e9];
  private readonly wasGrounded = [true, true, true, true];
  private readonly open: (StuckEpisode | null)[] = [null, null, null, null];

  constructor(
    private readonly fight: Fight,
    private readonly seatKinds: string[] = ["house", "house", "house", "house"],
  ) {
    fight.controllers.forEach((c, i) => {
      const think = c.think.bind(c);
      c.think = (s) => (this.inputs[i] = think(s));
    });
  }

  event(e: SimEvent) {
    if (e.type === "hit" && e.source >= 0 && e.source !== e.target) {
      this.lastFight[e.source] = e.tick;
      this.lastFight[e.target] = e.tick;
    }
  }

  tick() {
    const sim = this.fight.sim;
    const n = sim.fighters.length;
    const live = sim.alive().length > 1 && !sim.roundOver;
    for (let i = 0; i < n; i++) {
      const f = sim.fighters[i]!;
      const buf = this.samples[i]!;
      if (!f.alive || f.removed || !live) {
        buf.length = 0;
        this.close(i);
        continue;
      }
      this.aliveTicks[i]!++;
      const ex = this.exposure[i]!;
      const wk = `w:${sim.weapon(f)}`, sk = `s:${this.fight.controllers[i]!.stanceNow(sim)}`;
      ex[wk] = (ex[wk] ?? 0) + 1;
      ex[sk] = (ex[sk] ?? 0) + 1;
      const p = sim.pos(f);
      const v = sim.vel(f);
      const takeoff = this.wasGrounded[i]! && !f.grounded && v.y > 2;
      this.wasGrounded[i] = f.grounded;
      const inp = this.inputs[i];
      const c = this.fight.controllers[i]!;
      const tg = c.targetId >= 0 ? sim.fighters[c.targetId] : undefined;
      if (tg && tg.alive && !tg.removed && Math.hypot(v.x, v.y) < 0.6 && !inp?.fire) {
        const r = ++this.stillRun[i]!;
        const add = r === 90 ? 90 : r > 90 ? 1 : 0;
        this.stareTicks[i]! += add;
        if (add) {
          // why: no route to the target, a ranged weapon held, the final duel
          const route = f.surface >= 0 && tg.surface >= 0 && sim.nav.fighterPlan(sim.grid, f.surface, p.x).cost[tg.surface] !== Infinity;
          const k = `stare:${route ? "route" : "noroute"}:${sim.alive().length === 2 ? "duel" : "3+"}:${c.stanceNow(sim)}`;
          ex[k] = (ex[k] ?? 0) + add;
        }
      } else this.stillRun[i] = 0;
      buf.push({ x: p.x, y: sim.feetY(f), takeoff, fire: !!inp?.fire, busy: sim.tick - this.lastFight[i]! < WINDOW_TICKS });
      if (buf.length > WINDOW_TICKS) buf.shift();
      if (buf.length < WINDOW_TICKS || sim.tick % STEP_TICKS !== 0) continue;
      const kind = this.judge(buf);
      if (kind) this.flag(i, kind, buf);
      // an episode ends once no flagged window overlaps it any more
      else if (this.open[i] && sim.tick - this.open[i]!.end >= WINDOW_TICKS) this.close(i);
    }
  }

  /** Close any open episodes (call at the end of the round). */
  finish() {
    for (let i = 0; i < 4; i++) this.close(i);
  }

  private judge(buf: Sample[]): StuckKind | null {
    if (buf[buf.length - 1]!.busy) return null; // dealt or took fighter damage in the window
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, jumps = 0, path = 0, rev = 0, dir = 0;
    for (let k = 0; k < buf.length; k++) {
      const s = buf[k]!;
      x0 = Math.min(x0, s.x);
      x1 = Math.max(x1, s.x);
      y0 = Math.min(y0, s.y);
      y1 = Math.max(y1, s.y);
      if (s.takeoff) jumps++;
      if (k > 0) {
        const dx = s.x - buf[k - 1]!.x;
        path += Math.abs(dx);
        if (Math.abs(dx) > 0.01) {
          const d = Math.sign(dx);
          if (dir !== 0 && d !== dir) rev++;
          dir = d;
        }
      }
    }
    if (x1 - x0 >= BOX_W || y1 - y0 >= BOX_H) return null;
    if (jumps >= JUMPS) return "hop";
    if (path >= PATH_M && rev >= REVERSALS) return "pace";
    return null;
  }

  private flag(i: number, kind: StuckKind, buf: Sample[]) {
    const sim = this.fight.sim;
    const tick = sim.tick;
    const ep = this.open[i];
    if (ep) {
      ep.end = tick;
      if (kind === "hop") ep.kind = "hop";
      return;
    }
    const f = sim.fighters[i]!;
    const c = this.fight.controllers[i]!;
    const p = sim.pos(f);
    const t = c.targetId >= 0 ? sim.fighters[c.targetId] : undefined;
    let routeCost = Infinity;
    let reachable = false;
    let targetDist = -1;
    const weapon = sim.weapon(f);
    if (t && t.alive && !t.removed) {
      if (f.surface >= 0 && t.surface >= 0) routeCost = sim.nav.fighterPlan(sim.grid, f.surface, p.x).cost[t.surface] ?? Infinity;
      const tp = sim.pos(t);
      const d = Math.hypot(tp.x - p.x, tp.y - p.y);
      targetDist = Math.round(d * 10) / 10;
      reachable = routeCost !== Infinity || d <= weaponReach(sim.ruleset, f, weapon).max;
    }
    const b = c.strategy.build;
    let jumps = 0, path = 0, fires = 0;
    for (let k = 0; k < buf.length; k++) {
      if (buf[k]!.takeoff) jumps++;
      if (buf[k]!.fire) fires++;
      if (k > 0) path += Math.abs(buf[k]!.x - buf[k - 1]!.x);
    }
    this.open[i] = {
      fighter: i,
      kind,
      start: tick - WINDOW_TICKS,
      end: tick,
      x: Math.round(p.x * 10) / 10,
      y: Math.round(p.y * 10) / 10,
      jumps,
      path: Math.round(path * 10) / 10,
      fires,
      stance: c.stanceNow(sim),
      plan: c.strategy.stance,
      retaliate: c.strategy.retaliate ?? "turn",
      weapon,
      build: b ? `${b.health},${b.weight},${b.power}` : "0,0,0",
      theme: sim.level.theme,
      seat: this.seatKinds[i] ?? "house",
      target: c.targetId,
      reachable,
      routeCost: routeCost === Infinity ? -1 : Math.round(routeCost * 10) / 10,
      grounded: f.grounded,
      alive: sim.alive().length,
      targetDist,
    };
  }

  private close(i: number) {
    const ep = this.open[i];
    if (!ep) return;
    this.episodes.push(ep);
    this.open[i] = null;
  }
}
