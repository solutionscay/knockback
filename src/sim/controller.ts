/**
 * Strategy controller: turns a fighter's round strategy { target preference,
 * stance, weapon preferences, retaliate } into frame-by-frame inputs. The
 * engine does all target picking, pickup hunting, weapon switching, aiming
 * and movement. Every fighter gets the same controller and the same aim.
 */
import { FIGHTER, REFLEX, WEAPONS } from "./constants";
import type { Link, Surface } from "./nav";
import { clamp, zoneHalfAt, type Fighter, type Input, type Sim, type Strategy, type Weapon } from "./sim";

export interface Goal {
  surface: number;
  x: number;
  /** the pickup this goal is for, if any */
  item?: number;
}

/** Aim noise (perpendicular offset per meter of range): the same for everyone. */
export const AIM_NOISE = 0.07;

/**
 * Pickup hunting (path cost in meters-ish). Unarmed fighters go a long way
 * for any weapon; armed ones detour only for a better one, or for anything
 * when their stance is "item".
 */
export const PICKUP = { unarmedLimit: 70, upgradeLimit: 14, itemStanceLimit: 34, rankCost: 3, healthBelowHp: 50, healthLimit: 16, giveUpTicks: 100, skipTicks: 420 };

const NO_FIRE: Input = { move: 0, jump: false, aimX: 1, aimY: 0, weapon: null, fire: false };

export class Controller {
  strategy: Strategy;
  goal: Goal | null = null;
  /** All controllers in the match. */
  peers: Controller[] = [];
  private nextEval = 0;
  private nextRetarget = 0;
  private nextWeapon = 0;
  private wanted: Weapon | null = null;
  private activeLink: Link | null = null;
  private stuck = 0;
  private navVersion = -1;
  /** Ticks without line of sight to the target (stalemate breaker). */
  private noLos = 0;
  /** Effective target this tick. */
  targetId = -1;
  /** pickup being chased: give up on it if we stop getting closer (unreachable spots) */
  private chase: { id: number; best: number; since: number } | null = null;
  private skipItems = new Map<number, number>();
  /** recent hits taken (for the back-attack reflex) */
  private hitLog: { src: number; tick: number; behind: boolean }[] = [];
  /** active reflex: who to face/fight and until when */
  reflex: { attacker: number; until: number; mode: "glance" | "fight" | "switch" } | null = null;
  /** every reflex triggered this fight (for stats and tests) */
  reflexLog: { tick: number; attacker: number; mode: "glance" | "fight" | "switch" }[] = [];

  /**
   * Called for every hit this fighter takes (from Fight, in event order: deterministic).
   * Repeated hits from behind by a non-target trigger the reflex.
   */
  onHit(src: number, behind: boolean, _damage: number, tick: number) {
    const log = this.hitLog;
    if (!log.length || log[log.length - 1]!.src !== src || log[log.length - 1]!.tick !== tick) log.push({ src, tick, behind });
    while (log.length && log[0]!.tick < tick - REFLEX.windowTicks) log.shift();
    if (src === this.targetId) return;
    if (this.reflex && this.reflex.attacker === src && tick < this.reflex.until) return;
    const n = log.filter((h) => h.src === src && h.behind).length;
    if (n < REFLEX.hits) return;
    const rule = this.strategy.retaliate ?? "turn";
    const mode = rule === "attacker" ? "switch" : rule === "turn" ? "fight" : "glance";
    const span = mode === "switch" ? REFLEX.switchTicks : mode === "fight" ? REFLEX.fightTicks : REFLEX.glanceTicks;
    this.reflex = { attacker: src, until: tick + span, mode };
    this.reflexLog.push({ tick, attacker: src, mode });
    this.hitLog = log.filter((h) => h.src !== src);
    if (mode !== "glance") this.nextEval = 0; // re-plan movement toward the attacker now
  }

  constructor(
    readonly fighterId: number,
    readonly aimNoise: number,
  ) {
    this.strategy = { target: "nearest", stance: "rush", weapons: ["shotgun", "rocket", "bat"], line: "" };
  }

  setStrategy(s: Strategy, sim: Sim) {
    this.strategy = s;
    this.nextEval = sim.tick;
    this.nextRetarget = sim.tick;
    sim.setPrefs(this.fighterId, s.weapons ?? []);
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
        score = (o) => (o.weapons.includes(pref) ? 0 : 40) + dist(o);
        break;
      case "grudge":
        score = (o) => (o.id === this.strategy.grudge ? 0 : 40) + dist(o);
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

  private zoneBounds(sim: Sim): [number, number] {
    const half = zoneHalfAt(sim.tick + 120, sim.zone.startHalf);
    const h = Math.max(1.5, half - 1.2);
    return [sim.zone.center - h, sim.zone.center + h];
  }

  private chooseGoal(sim: Sim, me: Fighter, target: Fighter, plan: ReturnType<Sim["nav"]["plan"]>): Goal {
    const nav = sim.nav;
    const mp = sim.pos(me);
    const tp = sim.pos(target);
    const [zl, zr] = this.zoneBounds(sim);
    const zonePenalty = (x: number) => (x < zl ? 40 + (zl - x) * 6 : x > zr ? 40 + (x - zr) * 6 : 0);
    const fragilePenalty = (s: number) => (nav.surfaces[s]?.fragile ? 3 : 0);
    let stance = this.strategy.stance;
    const close = me.weapons.includes("bat") || me.weapons.includes("shotgun");

    // arm up: go for the pickups this fighter wants (fists only = go far for anything)
    const armed = me.weapons.some((w) => w !== "fist");
    {
      let best: Goal | null = null;
      let bc = Infinity;
      for (const it of sim.items()) {
        if ((this.skipItems.get(it.id) ?? -1) > sim.tick) continue;
        const type = it.itemType!;
        const isWeapon = type !== "health" && type !== "shield" && type !== "speed" && type !== "heavy" && type !== "damage" && type !== "jump";
        let limit: number;
        let extra = 0;
        if (isWeapon) {
          if (!sim.wantsWeapon(me, type as Weapon)) continue;
          if (it.owner === me.id && sim.tick - it.born < 45) continue;
          const rank = me.prefs.indexOf(type as Weapon);
          extra = Math.max(0, rank) * PICKUP.rankCost;
          limit = !armed ? PICKUP.unarmedLimit : stance === "item" ? PICKUP.itemStanceLimit : PICKUP.upgradeLimit;
        } else if (stance === "item") limit = PICKUP.itemStanceLimit;
        else if (type === "health" && me.hp < PICKUP.healthBelowHp) limit = PICKUP.healthLimit;
        else continue;
        const t = it.body.translation();
        const s = nav.surfaceAt(t.x, t.y + 0.3, 0.2);
        if (!s || plan.cost[s.id] === Infinity) continue;
        const c = plan.cost[s.id]! + Math.abs(plan.arriveX[s.id]! - t.x) + zonePenalty(t.x);
        if (c > limit) continue;
        if (c + extra < bc) {
          bc = c + extra;
          best = { surface: s.id, x: clamp(t.x, s.x0 + 0.3, s.x1 - 0.3), item: it.id };
        }
      }
      if (best) {
        // no closer for PICKUP.giveUpTicks: unreachable, skip it for a while
        const d = Math.abs(sim.pos(me).x - best.x) + Math.abs(sim.pos(me).y - (nav.surfaces[best.surface]?.y ?? 0)) * 0.5;
        if (!this.chase || this.chase.id !== best.item) this.chase = { id: best.item!, best: d, since: sim.tick };
        else if (d < this.chase.best - 0.5) this.chase = { id: best.item!, best: d, since: sim.tick };
        else if (sim.tick - this.chase.since > PICKUP.giveUpTicks) {
          this.skipItems.set(best.item!, sim.tick + PICKUP.skipTicks);
          this.chase = null;
          return this.chooseGoal(sim, me, target, plan);
        }
        return best;
      }
      this.chase = null;
      if (stance === "item") stance = close ? "rush" : "distance";
      if (!armed) stance = "rush"; // nothing to grab: scrap with fists
    }

    if (stance === "rush") {
      const side = mp.x < tp.x ? -1 : 1;
      const s = target.surface >= 0 ? nav.surfaces[target.surface] : undefined;
      if (!s || plan.cost[s.id] === Infinity) {
        return this.bestPoint(sim, plan, (px, py, sid) => Math.abs(px - tp.x) + Math.abs(py - tp.y) * 0.5 + zonePenalty(px) + fragilePenalty(sid));
      }
      const x = clamp(tp.x + side * 1.1, Math.max(s.x0 + 0.3, zl), Math.min(s.x1 - 0.3, zr));
      return { surface: s.id, x: clamp(x, s.x0 + 0.3, s.x1 - 0.3) };
    }

    const ideal = me.weapons[0] === "shotgun" ? 4.5 : stance === "cover" ? 9 : 12;
    if (stance === "cover") {
      return this.bestPoint(sim, plan, (px, py, sid) => {
        const dx = px - tp.x;
        const dy = py + 1 - tp.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        let s = Math.abs(d - ideal) * 0.8 + zonePenalty(px) + fragilePenalty(sid);
        if (d > 0.5) {
          const hit = sim.raycast(tp.x, tp.y, dx / d, dy / d, d);
          if (hit && hit.dist > d - 3.2 && (hit.terrain || (hit.entity && hit.entity.kind !== "fighter"))) s -= 7;
        }
        return s;
      });
    }
    return this.bestPoint(sim, plan, (px, py, sid) => {
      const dx = px - tp.x;
      const dy = py + 1 - tp.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      let s = Math.abs(d - ideal) + zonePenalty(px) + fragilePenalty(sid);
      if (d > 0.5) {
        const hit = sim.raycast(tp.x, tp.y, dx / d, dy / d, d);
        if (hit && hit.terrain) s += 3;
      }
      s -= Math.min(py, 5) * 0.25;
      return s;
    });
  }

  private bestPoint(sim: Sim, plan: ReturnType<Sim["nav"]["plan"]>, score: (x: number, y: number, s: number) => number): Goal {
    let best: Goal | null = null;
    let bs = Infinity;
    for (const p of sim.nav.points) {
      const c = plan.cost[p.surface]!;
      if (c === Infinity) continue;
      const s = score(p.x, p.y, p.surface) + (c + Math.abs(plan.arriveX[p.surface]! - p.x)) * 0.12;
      if (s < bs) {
        bs = s;
        best = { surface: p.surface, x: p.x };
      }
    }
    const me = sim.fighters[this.fighterId]!;
    return best ?? { surface: me.surface, x: sim.pos(me).x };
  }

  /** Is the target standing near a ledge that a yank toward me would pull them off? */
  private onLedge(sim: Sim, target: Fighter, mx: number, my: number): boolean {
    if (!target.grounded || target.surface < 0) return false;
    const s: Surface | undefined = sim.nav.surfaces[target.surface];
    if (!s) return false;
    const tp = sim.pos(target);
    if (s.dropLeft && tp.x - s.x0 < 3 && mx < tp.x) return true;
    if (s.dropRight && s.x1 - tp.x < 3 && mx > tp.x) return true;
    return tp.y - my > 1.8; // up on a platform: yank them down
  }

  /** The weapon for this situation, from the two carried. */
  private chooseWeapon(sim: Sim, me: Fighter, target: Fighter, dist: number, los: boolean): Weapon {
    const has = (w: Weapon) => me.weapons.includes(w);
    const ready = (w: Weapon) => has(w) && me.cooldown[w] < 15;
    const mp = sim.pos(me);
    if (this.blocked(dist)) {
      // a wall between us: lob over it, or break through it
      if (has("grenade")) return "grenade";
      if (has("rocket")) return "rocket";
      if (has("bat") && dist < 3) return "bat";
      if (has("shotgun")) return "shotgun";
    }
    if (has("bat") && dist < 2.4) return "bat";
    if (dist < 1.5 && !has("shotgun")) return "fist";
    if (ready("grapple") && los && dist > 3.5 && dist < 14 && (this.onLedge(sim, target, mp.x, mp.y) || has("bat") || has("shotgun"))) return "grapple";
    if (has("shotgun") && dist < 6.5) return "shotgun";
    if (has("grenade") && !los && dist > 2.5 && dist < 14) return "grenade";
    if (has("rocket") && dist >= 3) return "rocket";
    if (has("grenade") && dist > 2.5 && dist < 14) return "grenade";
    if (has("grapple") && dist > 3.5 && dist < 14) return "grapple";
    // prefer what the strategy likes among what we carry; fists if nothing else
    const carried = me.prefs.filter((w) => has(w));
    return carried[0] ?? "fist";
  }

  private blocked(dist: number) {
    return this.noLos > 60 && dist < 12;
  }

  think(sim: Sim): Input {
    const me = sim.fighters[this.fighterId]!;
    if (!me.alive) return NO_FIRE;
    let target = this.resolveTarget(sim, me);
    // the back-attack reflex overrides who we face (and, unless glancing, who we chase)
    let aimTarget = target as Fighter;
    const rf = this.reflex;
    if (rf && sim.tick < rf.until) {
      const a = sim.fighters[rf.attacker];
      if (a && a.alive && !a.removed) {
        aimTarget = a;
        if (rf.mode !== "glance") {
          target = a;
          this.targetId = a.id;
          this.nextRetarget = rf.until;
        }
      } else this.reflex = null;
    } else if (rf) this.reflex = null;
    const mp = sim.pos(me);
    const mv = sim.vel(me);
    const input: Input = { move: 0, jump: false, aimX: me.aimX, aimY: me.aimY, weapon: null, fire: false };
    if (!target) return input;
    this.targetId = target.id;
    const tp = sim.pos(target);
    const tv = sim.vel(target);
    const nav = sim.nav;

    if (this.navVersion !== sim.navVersion) {
      this.navVersion = sim.navVersion;
      this.goal = null;
      this.activeLink = null;
    }

    // ---------------------------------------------------------- movement
    const surf = me.surface >= 0 ? nav.surfaces[me.surface] : undefined;
    let moveTarget = tp.x;
    if (surf) {
      const plan = nav.plan(me.surface, mp.x);
      if (sim.tick >= this.nextEval || !this.goal || !nav.surfaces[this.goal.surface] || plan.cost[this.goal.surface] === Infinity) {
        this.goal = this.chooseGoal(sim, me, target, plan);
        this.nextEval = sim.tick + 24 + this.fighterId * 3;
      }
      const goal = this.goal;
      moveTarget = goal.x;
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
          } else moveTarget = link.landX;
        } else moveTarget = clamp(goal.x, surf.x0 + 0.4, surf.x1 - 0.4);
      } else if (me.grounded) {
        moveTarget = clamp(goal.x, surf.x0 + 0.35, surf.x1 - 0.35);
      }
    }

    // run from lit TNT / armed barrels
    for (const d of sim.dangers()) {
      const dx = mp.x - d.x;
      if (Math.abs(dx) < d.r && Math.abs(mp.y - d.y) < d.r) {
        moveTarget = mp.x + (dx >= 0 ? 4 : -4);
        break;
      }
    }

    // falling over the void: steer to the nearest ledge, double jump if we can
    if (!me.grounded) {
      const fall = nav.fallBelow(sim.grid, mp.x, sim.feetY(me));
      if (fall > 6) {
        let bx = moveTarget;
        let bd = Infinity;
        for (const s of nav.surfaces) {
          if (s.y > mp.y + 2.5) continue;
          const ex = mp.x < s.x0 ? s.x0 + 0.6 : mp.x > s.x1 ? s.x1 - 0.6 : mp.x;
          const d = Math.abs(ex - mp.x) + Math.max(0, mp.y - s.y) * 0.3;
          if (d < bd) {
            bd = d;
            bx = ex;
          }
        }
        moveTarget = bx;
        if (me.power.jump > 0 && !me.airJumped && mv.y < -1 && me.stun === 0) input.jump = true;
      } else if (this.activeLink && me.power.jump > 0 && !me.airJumped && mv.y < -2 && nav.surfaces[this.activeLink.to] && sim.feetY(me) < nav.surfaces[this.activeLink.to]!.y) {
        input.jump = true;
      }
    }

    const diff = moveTarget - mp.x;
    input.move = Math.abs(diff) < 0.15 ? 0 : clamp(diff / 0.7, -1, 1);
    if (me.grounded && Math.abs(input.move) > 0.5) {
      const dir = input.move > 0 ? 1 : -1;
      const hit = sim.raycast(mp.x, sim.feetY(me) + 0.35, dir, 0, FIGHTER.radius + 0.4, me.entity.collider);
      if (hit && hit.entity?.kind !== "fighter") input.jump = true;
      if (Math.abs(mv.x) < 0.6) this.stuck++;
      else this.stuck = 0;
      if (this.stuck > 18) {
        input.jump = true;
        this.stuck = 0;
      }
    } else this.stuck = 0;

    // ---------------------------------------------------------- weapon, aim, fire
    const atp = sim.pos(aimTarget);
    const atv = sim.vel(aimTarget);
    const dx0 = atp.x - mp.x;
    const dy0 = atp.y - mp.y;
    const dist = Math.sqrt(dx0 * dx0 + dy0 * dy0);
    const sight = dist > 0.1 ? sim.raycast(mp.x, mp.y + 0.25, dx0 / dist, (dy0 - 0.25) / dist, dist + 0.5, me.entity.collider) : null;
    const los = !!sight && sight.entity === aimTarget.entity;
    this.noLos = los ? 0 : this.noLos + 1;
    const blocked = this.blocked(dist);
    if (sim.tick >= this.nextWeapon || !this.wanted || !me.weapons.includes(this.wanted)) {
      this.wanted = this.chooseWeapon(sim, me, aimTarget, dist, los);
      this.nextWeapon = sim.tick + 12;
    }
    const weapon = this.wanted;
    input.weapon = weapon;

    let ax = dx0;
    let ay = dy0;
    if (weapon === "rocket" || weapon === "grenade") {
      const speed = weapon === "rocket" ? WEAPONS.rocket.speed : WEAPONS.grenade.speed;
      const g = weapon === "rocket" ? WEAPONS.rocket.gravity : 20;
      const t = dist / speed;
      const lx = atp.x + atv.x * t * 0.6 - mp.x;
      const ly = atp.y + Math.max(-2, atv.y * t * 0.3) - (mp.y + 0.25);
      // over a wall: the high arc
      const sol = ballisticAim(lx, ly, speed, g, blocked && weapon === "rocket");
      ax = sol.x;
      ay = sol.y;
    } else {
      ay -= 0.25;
    }
    const al = Math.sqrt(ax * ax + ay * ay) || 1;
    input.aimX = ax / al;
    input.aimY = ay / al;

    let canFire = sim.weapon(me) === weapon && me.swap === 0 && me.cooldown[weapon] === 0 && me.stun === 0;
    switch (weapon) {
      case "shotgun":
        canFire &&= dist <= WEAPONS.shotgun.range - 0.6;
        break;
      case "rocket":
        canFire &&= dist <= 34 && dist >= WEAPONS.rocket.minRange;
        break;
      case "grenade":
        canFire &&= dist <= 14 && dist > 2.5;
        break;
      case "bat":
        canFire &&= (dist <= 1.95 && Math.abs(dy0) < 1.6) || (blocked && dist < 3);
        break;
      case "fist":
        canFire &&= dist <= 1.45 && Math.abs(dy0) < 1.3;
        break;
      case "grapple":
        canFire &&= los && dist >= 3.5 && dist <= WEAPONS.grapple.range - 0.5;
        break;
    }
    if (canFire && weapon !== "bat" && weapon !== "fist" && weapon !== "grapple" && !(blocked && weapon === "shotgun")) {
      const hit = sim.raycast(mp.x, mp.y + 0.25, input.aimX, input.aimY, weapon === "shotgun" ? Math.min(dist, 6) : 2.2, me.entity.collider);
      if (hit && hit.terrain) canFire = false;
    }
    if (canFire) {
      const n = this.aimNoise * sim.rng.gauss() * (weapon === "rocket" || weapon === "grenade" ? 1 : 0.5);
      const nx = input.aimX - input.aimY * n;
      const ny = input.aimY + input.aimX * n;
      const l = Math.sqrt(nx * nx + ny * ny);
      input.aimX = nx / l;
      input.aimY = ny / l;
      input.fire = true;
    }
    return input;
  }
}

/**
 * Launch direction for a projectile with speed v under gravity g to hit (dx, dy).
 * Low arc; 45 degrees when out of range. Uses only sqrt.
 */
export function ballisticAim(dx: number, dy: number, v: number, g: number, high = false): { x: number; y: number } {
  const adx = Math.abs(dx);
  if (adx < 0.3) return { x: dx, y: dy };
  const v2 = v * v;
  const disc = v2 * v2 - g * (g * adx * adx + 2 * dy * v2);
  let tan: number;
  if (disc < 0) tan = 1;
  else tan = (v2 + (high ? 1 : -1) * Math.sqrt(disc)) / (g * adx);
  const sx = dx < 0 ? -1 : 1;
  const l = Math.sqrt(1 + tan * tan);
  return { x: sx / l, y: tan / l };
}
