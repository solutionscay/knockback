/**
 * Strategy controller: turns a fighter's match strategy { target preference,
 * weapon, stance } into frame-by-frame inputs. The engine does all aiming,
 * target picking and movement.
 */
import { FIGHTER, WEAPONS, zoneHalfAt } from "./constants";
import type { Link } from "./nav";
import { clamp, NO_INPUT, type Fighter, type Input, type Sim, type Strategy, type Weapon } from "./sim";

export interface Goal {
  surface: number;
  x: number;
}

/** Per-personality aim noise (perpendicular offset per meter of range). */
export const AIM_NOISE: Record<Fighter["personality"], number> = {
  aggressive: 0.1,
  sniper: 0.025,
  coward: 0.12,
  opportunist: 0.06,
};

export class Controller {
  strategy: Strategy;
  goal: Goal | null = null;
  /** All controllers in the match (to resolve "whoever has the rocket"). */
  peers: Controller[] = [];
  private nextEval = 0;
  private nextRetarget = 0;
  private activeLink: Link | null = null;
  private stuck = 0;
  /** Effective target this tick (may differ from order.target if it is down). */
  targetId = -1;

  constructor(
    readonly fighterId: number,
    readonly aimNoise: number,
  ) {
    this.strategy = { target: "nearest", weapon: "rocket", stance: "distance", line: "" };
  }

  setStrategy(s: Strategy, sim: Sim) {
    this.strategy = s;
    this.nextEval = sim.tick; // re-plan now
    this.nextRetarget = sim.tick;
  }

  /** Pick a target from the preference; sticky for a second so it does not flicker. */
  private resolveTarget(sim: Sim, me: Fighter): Fighter | null {
    const cur = this.targetId >= 0 ? sim.fighters[this.targetId] : undefined;
    if (cur && cur.alive && cur.id !== me.id && sim.tick < this.nextRetarget) return cur;
    this.nextRetarget = sim.tick + 60;
    const p = sim.pos(me);
    const foes = sim.fighters.filter((o) => o.alive && o.id !== me.id);
    if (foes.length === 0) return null;
    const dist = (o: Fighter) => {
      const q = sim.pos(o);
      return Math.abs(q.x - p.x) + Math.abs(q.y - p.y);
    };
    const pref = this.strategy.target;
    let score: (o: Fighter) => number;
    switch (pref) {
      case "weakest":
        score = (o) => o.hp + dist(o) * 0.8;
        break;
      case "strongest":
        score = (o) => -o.hp + dist(o) * 0.8;
        break;
      case "leader":
        score = (o) => -o.damageDealt - o.kos * 40 + dist(o) * 0.8;
        break;
      case "rocket":
      case "shotgun":
        score = (o) => (this.peers[o.id]?.strategy.weapon === pref ? 0 : 40) + dist(o);
        break;
      default:
        score = dist;
    }
    let best = foes[0]!;
    let bs = score(best);
    for (const o of foes) {
      const v = score(o);
      if (v < bs) {
        bs = v;
        best = o;
      }
    }
    return best;
  }

  /** The zone interval two seconds from now, with a margin. */
  private zoneBounds(sim: Sim): [number, number] {
    const half = zoneHalfAt(sim.tick + 120);
    const h = Math.max(1.5, half - 1.2);
    return [sim.zone.center - h, sim.zone.center + h];
  }

  private chooseGoal(sim: Sim, me: Fighter, target: Fighter, plan: ReturnType<Sim["nav"]["plan"]>): Goal {
    const nav = sim.nav;
    const mp = sim.pos(me);
    const tp = sim.pos(target);
    const [zl, zr] = this.zoneBounds(sim);
    const zonePenalty = (x: number) => (x < zl ? 40 + (zl - x) * 6 : x > zr ? 40 + (x - zr) * 6 : 0);
    const weapon = this.weapon(me);
    let stance = this.strategy.stance;

    if (stance === "item") {
      let best: Goal | null = null;
      let bc = Infinity;
      for (const it of sim.items()) {
        const t = it.body.translation();
        const s = nav.surfaceAt(t.x, t.y + 0.3, 0.2);
        if (!s) continue;
        const c = plan.cost[s.id]! + Math.abs(plan.arriveX[s.id]! - t.x) + zonePenalty(t.x);
        if (c < bc) {
          bc = c;
          best = { surface: s.id, x: clamp(t.x, s.x0 + 0.3, s.x1 - 0.3) };
        }
      }
      if (best) return best;
      stance = "distance";
    }

    if (stance === "rush") {
      const side = mp.x < tp.x ? -1 : 1;
      const s = nav.surfaces[target.surface]!;
      let x = clamp(tp.x + side * 1.1, s.x0 + 0.3, s.x1 - 0.3);
      if (plan.cost[s.id] === Infinity) {
        // cannot reach: get as close as possible on reachable surfaces
        return this.bestPoint(sim, plan, (px, py) => Math.abs(px - tp.x) + Math.abs(py - tp.y) * 0.5 + zonePenalty(px));
      }
      x = clamp(x, Math.max(s.x0 + 0.3, zl), Math.min(s.x1 - 0.3, zr));
      return { surface: s.id, x: clamp(x, s.x0 + 0.3, s.x1 - 0.3) };
    }

    const ideal = weapon === "shotgun" ? 4.5 : stance === "cover" ? 9 : 12;
    if (stance === "cover") {
      return this.bestPoint(sim, plan, (px, py) => {
        const dx = px - tp.x;
        const dy = py + 1 - tp.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        let s = Math.abs(d - ideal) * 0.8 + zonePenalty(px);
        if (d > 0.5) {
          const hit = sim.raycast(tp.x, tp.y, dx / d, dy / d, d);
          if (hit && hit.entity && hit.entity.kind !== "fighter" && hit.dist > d - 3.2) s -= 8;
          else if (hit && !hit.entity && hit.dist > d - 3.2) s -= 6; // terrain cover
        }
        return s;
      });
    }
    // distance
    return this.bestPoint(sim, plan, (px, py) => {
      const dx = px - tp.x;
      const dy = py + 1 - tp.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      let s = Math.abs(d - ideal) + zonePenalty(px);
      // prefer a clear line of fire
      if (d > 0.5) {
        const hit = sim.raycast(tp.x, tp.y, dx / d, dy / d, d);
        if (hit && !hit.entity) s += 3;
      }
      s -= Math.min(py, 5) * 0.25; // a bit of height is nice
      return s;
    });
  }

  private bestPoint(sim: Sim, plan: ReturnType<Sim["nav"]["plan"]>, score: (x: number, y: number) => number): Goal {
    let best: Goal | null = null;
    let bs = Infinity;
    for (const p of sim.nav.points) {
      const c = plan.cost[p.surface]!;
      if (c === Infinity) continue;
      const pathCost = c + Math.abs(plan.arriveX[p.surface]! - p.x);
      const s = score(p.x, p.y) + pathCost * 0.12;
      if (s < bs) {
        bs = s;
        best = { surface: p.surface, x: p.x };
      }
    }
    const me = sim.fighters[this.fighterId]!;
    return best ?? { surface: me.surface, x: sim.pos(me).x };
  }

  private weapon(me: Fighter): Weapon {
    if (this.strategy.weapon === "grenade" && me.grenades <= 0) return "rocket";
    return this.strategy.weapon;
  }

  think(sim: Sim): Input {
    const me = sim.fighters[this.fighterId]!;
    if (!me.alive) return NO_INPUT;
    const target = this.resolveTarget(sim, me);
    const mp = sim.pos(me);
    const mv = sim.vel(me);
    const input: Input = { move: 0, jump: false, aimX: me.aimX, aimY: me.aimY, fire: null };
    if (!target) return input;
    this.targetId = target.id;
    const tp = sim.pos(target);
    const tv = sim.vel(target);

    // ---------------------------------------------------------- movement
    const plan = sim.nav.plan(me.surface, mp.x, sim.bridgeIntact());
    if (sim.tick >= this.nextEval || !this.goal || plan.cost[this.goal.surface] === Infinity) {
      this.goal = this.chooseGoal(sim, me, target, plan);
      this.nextEval = sim.tick + 24 + this.fighterId * 3;
    }
    const goal = this.goal;
    const surf = sim.nav.surfaces[me.surface]!;
    let moveTarget = goal.x;
    if (me.grounded && this.activeLink && me.jumpCd === 0) this.activeLink = null;
    if (this.activeLink) {
      moveTarget = this.activeLink.landX;
    } else if (goal.surface !== me.surface) {
      const link = plan.firstLink[goal.surface];
      if (link) {
        if (link.kind === "jump") {
          moveTarget = link.takeoffX;
          if (me.grounded && Math.abs(mp.x - link.takeoffX) < 0.4) {
            input.jump = true;
            this.activeLink = link;
            moveTarget = link.landX;
          }
        } else {
          moveTarget = link.landX;
        }
      } else {
        moveTarget = clamp(goal.x, surf.x0 + 0.4, surf.x1 - 0.4);
      }
    } else if (me.grounded) {
      moveTarget = clamp(goal.x, surf.x0 + 0.35, surf.x1 - 0.35);
    }
    const diff = moveTarget - mp.x;
    input.move = Math.abs(diff) < 0.15 ? 0 : clamp(diff / 0.7, -1, 1);

    if (me.grounded && Math.abs(input.move) > 0.5) {
      const dir = input.move > 0 ? 1 : -1;
      const feet = sim.feetY(me);
      const hit = sim.raycast(mp.x, feet + 0.35, dir, 0, FIGHTER.radius + 0.4, me.entity.collider);
      if (hit && hit.entity?.kind !== "fighter") input.jump = true;
      if (Math.abs(mv.x) < 0.6) this.stuck++;
      else this.stuck = 0;
      if (this.stuck > 18) {
        input.jump = true;
        this.stuck = 0;
      }
    } else {
      this.stuck = 0;
    }

    // ---------------------------------------------------------- aim + fire
    let weapon = this.weapon(me);
    const dx0 = tp.x - mp.x;
    const dy0 = tp.y - mp.y;
    const dist = Math.sqrt(dx0 * dx0 + dy0 * dy0);
    // Rockets work up close too, but the blast hits the shooter. No shotgun
    // fallback: close range belongs to the fighters who chose shotguns.
    let ax = dx0;
    let ay = dy0;
    if (weapon === "rocket" || weapon === "grenade") {
      const speed = weapon === "rocket" ? WEAPONS.rocket.speed : WEAPONS.grenade.speed;
      const g = weapon === "rocket" ? WEAPONS.rocket.gravity : 20;
      const t = dist / speed;
      const lx = tp.x + tv.x * t * 0.6 - mp.x;
      const ly = tp.y + Math.max(-2, tv.y * t * 0.3) - (mp.y + 0.25);
      const sol = ballisticAim(lx, ly, speed, g);
      ax = sol.x;
      ay = sol.y;
    }
    const al = Math.sqrt(ax * ax + ay * ay) || 1;
    input.aimX = ax / al;
    input.aimY = ay / al;

    let canFire = me.cooldown[weapon] === 0 && me.stun === 0;
    if (weapon === "shotgun") canFire &&= dist <= WEAPONS.shotgun.range - 0.6;
    if (weapon === "rocket") canFire &&= dist <= 34 && dist >= WEAPONS.rocket.minRange;
    if (weapon === "grenade") canFire &&= dist <= 14 && dist > 2.5;
    if (canFire) {
      // do not shoot straight into terrain right in front
      const hit = sim.raycast(mp.x, mp.y + 0.25, input.aimX, input.aimY, weapon === "shotgun" ? Math.min(dist, 6) : 2.2, me.entity.collider);
      if (hit && !hit.entity) canFire = false;
    }
    if (canFire) {
      const n = this.aimNoise * sim.rng.gauss() * (weapon === "shotgun" ? 0.5 : 1);
      const nx = input.aimX - input.aimY * n;
      const ny = input.aimY + input.aimX * n;
      const l = Math.sqrt(nx * nx + ny * ny);
      input.aimX = nx / l;
      input.aimY = ny / l;
      input.fire = weapon;
    }
    return input;
  }
}

/**
 * Launch direction for a projectile with speed v under gravity g to hit (dx, dy).
 * Low arc; 45 degrees when out of range. Uses only sqrt.
 */
export function ballisticAim(dx: number, dy: number, v: number, g: number): { x: number; y: number } {
  const adx = Math.abs(dx);
  if (adx < 0.3) return { x: dx, y: dy };
  const v2 = v * v;
  const disc = v2 * v2 - g * (g * adx * adx + 2 * dy * v2);
  let tan: number;
  if (disc < 0) tan = 1;
  else tan = (v2 - Math.sqrt(disc)) / (g * adx);
  const sx = dx < 0 ? -1 : 1;
  const l = Math.sqrt(1 + tan * tan);
  return { x: sx / l, y: tan / l };
}
