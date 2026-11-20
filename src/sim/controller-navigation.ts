import { FIGHTER } from "./constants";
import type { Controller } from "./controller";
import { PATIENCE, PICKUP } from "./controller-tuning";
import type { Link, Surface } from "./nav";
import { clamp, type Fighter, type Input, type Sim, type Weapon } from "./sim";

export interface Goal {
  surface: number;
  x: number;
  /** the pickup this goal is for, if any */
  item?: number;
}

export class ControllerNavigation {
  goal: Goal | null = null;
  private nextEval = 0;
  private activeLink: Link | null = null;
  private stuck = 0;
  private navVersion = -1;
  private skipItems = new Map<number, number>();
  /** pickup being chased: give up on it if we stop getting closer (unreachable spots) */
  private chase: { id: number; best: number; since: number } | null = null;
  /** progress toward the current goal (stuck watchdog) */
  private prog: { surface: number; x: number; best: number; since: number } | null = null;
  private badSurfaces = new Map<number, number>();
  private linkSince = -1;
  /** digging out of a pocket: hit the wall toward the goal */
  dig: { until: number; dir: 1 | -1 } | null = null;
  /** times the watchdog fired this fight (stats, tests) */
  stuckCount = 0;

  constructor(private readonly controller: Pick<Controller, "fighterId" | "stanceNow" | "pressing" | "rules">) {}

  replan(tick: number) {
    this.nextEval = tick;
  }

  private zoneBounds(sim: Sim): [number, number] {
    const half = sim.zoneHalfAhead(120);
    const h = Math.max(1.5, half - 1.2);
    return [sim.zone.center - h, sim.zone.center + h];
  }

  private chooseGoal(sim: Sim, me: Fighter, target: Fighter, plan: ReturnType<Sim["nav"]["plan"]>): Goal {
    const nav = sim.nav;
    const mp = sim.pos(me);
    const tp = sim.pos(target);
    const [zl, zr] = this.zoneBounds(sim);
    const zonePenalty = (x: number) => (x < zl ? 40 + (zl - x) * 6 : x > zr ? 40 + (x - zr) * 6 : 0);
    const fragilePenalty = (s: number) => (nav.surfaces[s]?.fragile ? 3 : 0) + ((this.badSurfaces.get(s) ?? -1) > sim.tick ? 30 : 0);
    let stance = this.controller.stanceNow(sim);
    const close = me.weapons.includes("bat") || me.weapons.includes("shotgun");

    // arm up: go for the pickups this fighter wants (fists only = go far for anything)
    const armed = me.weapons.some((w) => w !== "fist");
    {
      let best: Goal | null = null;
      let bc = Infinity;
      // stalemate guards first: in sudden death, the duel or while pressing, no seek rule pulls a fighter away
      const seeking = sim.suddenDeath >= 0 || sim.alive().length === 2 || this.controller.pressing(sim) ? [] : this.controller.rules.seeking();
      for (const it of sim.items()) {
        if ((this.skipItems.get(it.id) ?? -1) > sim.tick) continue;
        const type = it.itemType!;
        const sought = seeking.indexOf(type);
        const isWeapon = type !== "health" && type !== "shield" && type !== "speed" && type !== "heavy" && type !== "damage" && type !== "jump";
        let limit: number;
        let extra = 0;
        if (sought >= 0 && (!isWeapon || sim.wantsWeapon(me, type as Weapon))) {
          // an active seek rule: go far for it, ahead of everything else
          limit = PICKUP.seekLimit;
          extra = -40 + sought * 5;
        } else if (isWeapon) {
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
        if (!s || plan.cost[s.id] === Infinity || (this.badSurfaces.get(s.id) ?? -1) > sim.tick) continue;
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

    if (this.controller.pressing(sim)) {
      // pressing: get beside the target, switching sides now and then (breaks vertical and wall deadlocks)
      const flip = Math.floor(sim.tick / PATIENCE.pressFlip) % 2 === 0 ? 1 : -1;
      const gx = tp.x + flip * 2.2;
      return this.bestPoint(sim, plan, (px, py, sid) => Math.abs(px - gx) + Math.abs(py + 0.9 - tp.y) * 0.7 + zonePenalty(px) + fragilePenalty(sid));
    }

    // an active avoid rule (the highest target/avoid rule): keep away from that fighter
    const tr = this.controller.rules.targetRule();
    const av = tr && tr.kind === "avoid" && sim.suddenDeath < 0 && sim.alive().length > 2 ? sim.fighters[tr.subject] : undefined;
    if (av && av.alive && !av.removed) {
      const ap = sim.pos(av);
      return this.bestPoint(sim, plan, (px, py, sid) => Math.abs(Math.hypot(px - ap.x, py + 1 - ap.y) - 12) + zonePenalty(px) + fragilePenalty(sid));
    }

    if (stance === "rush") {
      const side = mp.x < tp.x ? -1 : 1;
      const s = target.surface >= 0 ? nav.surfaces[target.surface] : undefined;
      if (!s || plan.cost[s.id] === Infinity || (this.badSurfaces.get(s.id) ?? -1) > sim.tick) {
        return this.bestPoint(sim, plan, (px, py, sid) => Math.abs(px - tp.x) + Math.abs(py - tp.y) * 0.5 + zonePenalty(px) + fragilePenalty(sid));
      }
      // explosives only: rush to blast range, not into your own blast
      const gap = close || !me.weapons.some((w) => w === "rocket" || w === "grenade") ? 1.1 : 4;
      const x = clamp(tp.x + side * gap, Math.max(s.x0 + 0.3, zl), Math.min(s.x1 - 0.3, zr));
      return { surface: s.id, x: clamp(x, s.x0 + 0.3, s.x1 - 0.3) };
    }

    const ideal = me.weapons[0] === "shotgun" ? 4.5 : stance === "cover" ? 9 : 12;
    if (stance === "cover") {
      // cover is not standing still: every so often, peek out somewhere with a clear shot
      const peek = (sim.tick + this.controller.fighterId * 61) % PATIENCE.peekEvery < PATIENCE.peekFor;
      return this.bestPoint(sim, plan, (px, py, sid) => {
        const dx = px - tp.x;
        const dy = py + 1 - tp.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        let s = Math.abs(d - ideal) * 0.8 + zonePenalty(px) + fragilePenalty(sid);
        if (d > 0.5) {
          const hit = sim.raycast(tp.x, tp.y, dx / d, dy / d, d);
          const hidden = !!hit && hit.dist > d - 3.2 && (hit.terrain || (!!hit.entity && hit.entity.kind !== "fighter"));
          if (peek) {
            if (!hit || hit.entity?.kind === "fighter") s -= 7;
          } else if (hidden) s -= 7;
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
    const me = sim.fighters[this.controller.fighterId]!;
    return best ?? { surface: me.surface, x: sim.pos(me).x };
  }

  steer(sim: Sim, me: Fighter, target: Fighter, mp: ReturnType<Sim["pos"]>, mv: ReturnType<Sim["vel"]>, input: Input): Surface | undefined {
    const tp = sim.pos(target);
    const nav = sim.nav;

    if (this.navVersion !== sim.navVersion) {
      this.navVersion = sim.navVersion;
      this.goal = null;
      this.activeLink = null;
    }

    const surf = me.surface >= 0 ? nav.surfaces[me.surface] : undefined;
    let moveTarget = tp.x;
    if (surf) {
      const plan = nav.plan(me.surface, mp.x);
      if (sim.tick >= this.nextEval || !this.goal || !nav.surfaces[this.goal.surface] || plan.cost[this.goal.surface] === Infinity) {
        this.goal = this.chooseGoal(sim, me, target, plan);
        this.nextEval = sim.tick + 24 + this.controller.fighterId * 3;
      }
      const goal = this.goal;
      moveTarget = goal.x;
      if (me.grounded && this.activeLink && me.jumpCd === 0) this.activeLink = null;
      // a jump still "in flight" for too long (bouncing on a pad, wedged): drop it
      if (this.activeLink && sim.tick - this.linkSince > PATIENCE.linkTicks) this.activeLink = null;
      // stuck watchdog: no progress toward the goal for a while
      const gy = nav.surfaces[goal.surface]?.y ?? sim.feetY(me);
      const gd = Math.abs(mp.x - goal.x) + Math.abs(sim.feetY(me) - gy) * 0.5;
      const pr = this.prog;
      if (!pr || pr.surface !== goal.surface || Math.abs(pr.x - goal.x) > 1.5) this.prog = { surface: goal.surface, x: goal.x, best: gd, since: sim.tick };
      else if (gd < pr.best - 0.3) {
        pr.best = gd;
        pr.since = sim.tick;
      } else if (gd > 1.2 && sim.tick - pr.since > PATIENCE.stuckTicks) {
        this.stuckCount++;
        if (goal.surface !== me.surface) this.badSurfaces.set(goal.surface, sim.tick + PATIENCE.avoidTicks);
        this.dig = { until: sim.tick + PATIENCE.digTicks, dir: goal.x >= mp.x ? 1 : -1 };
        this.activeLink = null;
        this.prog = null;
        this.nextEval = sim.tick;
      }
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
              this.linkSince = sim.tick;
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
    return surf;
  }
}
