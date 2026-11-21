import { arenaQuarter } from "./level-spawns";
import type { Controller } from "./controller";
import { runUp, type Link, type Surface } from "./nav";
import { clamp, length2D } from "./dmath";
import { type Sim } from "./sim";
import { POWER_LIST, type Fighter, type Input, type Weapon } from "./sim-types";
import { coverSpots, hasLongGun, isLongGun, nearestRival, shelters, spotFree } from "./tactical";

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
  /** the jump in flight (#69): where it lands, kept as a point so it outlives a nav rebuild */
  private jumpTo: { x: number; y: number } | null = null;
  /** where the feet last stood (#69): the ledge to fall back on */
  private foothold: { x: number; y: number } | null = null;
  /** the link this fighter is walking to this tick: its edge is not a ledge to stop at */
  private edgeLink: Link | null = null;
  /** digging out of a pocket: hit the wall toward the goal */
  dig: { until: number; dir: 1 | -1 } | null = null;
  /** times the watchdog fired this fight (stats, tests) */
  stuckCount = 0;
  /** overwatch (#38): the chosen perch and until when it is kept */
  perch: { surface: number; x: number; y: number; until: number } | null = null;
  /** flank (#38): the side of the target to come round to, the waypoint reached, since when */
  flankPlan: { target: number; side: 1 | -1; since: number; around: boolean } | null = null;
  /** cover (#38): the cover spot being held */
  coverSpot: { surface: number; x: number; y: number; side: 1 | -1 } | null = null;
  /** hold (#38): the spot this fighter defends */
  holdSpot: { surface: number; x: number; y: number } | null = null;

  constructor(private readonly controller: Pick<Controller, "fighterId" | "stanceNow" | "pressing" | "rules">) {}

  replan(tick: number) {
    this.nextEval = tick;
  }

  /** A new plan: forget the stance's chosen spots (#38). */
  resetStance() {
    this.perch = null;
    this.flankPlan = null;
    this.holdSpot = null;
    this.coverSpot = null;
  }

  private zoneBounds(sim: Sim): [number, number] {
    const half = sim.zoneHalfAhead(120);
    const h = Math.max(1.5, half - 1.2);
    return [sim.zone.center - h, sim.zone.center + h];
  }

  private chooseGoal(sim: Sim, me: Fighter, target: Fighter, plan: ReturnType<Sim["nav"]["plan"]>, crossingWall: boolean, flank: number, weapon?: Weapon): Goal {
    const nav = sim.nav;
    const mp = sim.pos(me);
    const tp = sim.pos(target);
    const [zl, zr] = this.zoneBounds(sim);
    const zonePenalty = (x: number) => (x < zl ? 40 + (zl - x) * 6 : x > zr ? 40 + (x - zr) * 6 : 0);
    const fragilePenalty = (s: number) => (nav.surfaces[s]?.fragile ? 3 : 0) + ((this.badSurfaces.get(s) ?? -1) > sim.tick ? 30 : 0);
    if (flank) {
      // Step around the obstruction at a different x before trying to breach again.
      const x = tp.x + flank * 4.5;
      return this.bestPoint(sim, plan, (px, py, sid) => Math.abs(px - x) + Math.abs(py + 0.84 - tp.y) * 0.8 + zonePenalty(px) + fragilePenalty(sid));
    }
    if (crossingWall) {
      const to = nav.surfaces[target.surface];
      if (to && plan.cost[to.id] !== Infinity && (this.badSurfaces.get(to.id) ?? -1) <= sim.tick) {
        return { surface: to.id, x: clamp(tp.x, to.x0 + 0.35, to.x1 - 0.35) };
      }
      return this.bestPoint(sim, plan, (x, y, sid) => Math.abs(x - tp.x) + Math.abs(y + 0.84 - tp.y) + zonePenalty(x) + fragilePenalty(sid));
    }
    let stance = this.controller.stanceNow(sim);
    const close = me.weapons.includes("hammer") || me.weapons.includes("bat") || me.weapons.includes("shotgun") || me.weapons.includes("flamethrower");

    // arm up: go for the pickups this fighter wants (fists only = go far for anything)
    const armed = me.weapons.some((w) => w !== "fist");
    const opening = sim.ruleset.pickups.armory.spread;
    const preferLocal = opening.enabled && !armed && sim.tick < opening.preferLocalTicks;
    const quarter = (x: number) => arenaQuarter(sim.level.minX, sim.level.width, x);
    {
      let best: Goal | null = null;
      let bc = Infinity;
      // stalemate guards first: in sudden death, the duel or while pressing, no seek rule pulls a fighter away
      const seeking = sim.suddenDeath >= 0 || sim.alive().length === 2 || this.controller.pressing(sim) ? [] : this.controller.rules.seeking();
      for (const it of sim.items()) {
        if ((this.skipItems.get(it.id) ?? -1) > sim.tick) continue;
        const type = it.itemType!;
        if (type === "jetpack" && me.power.jetpack > sim.ruleset.pickups.power.jetpack.fuelTicks / 2) continue;
        const sought = seeking.indexOf(type);
        const isWeapon = !(POWER_LIST as readonly string[]).includes(type);
        let limit: number;
        let extra = 0;
        if (sought >= 0 && (!isWeapon || sim.wantsWeapon(me, type as Weapon))) {
          // an active seek rule: go far for it, ahead of everything else
          limit = sim.ruleset.tactics.pickup.seekLimit;
          extra = -40 + sought * 5;
        } else if (isWeapon) {
          if (!sim.wantsWeapon(me, type as Weapon)) continue;
          if (it.owner === me.id && sim.tick - it.born < 45) continue;
          const rank = me.prefs.indexOf(type as Weapon);
          extra = Math.max(0, rank) * sim.ruleset.tactics.pickup.rankCost;
          limit = !armed ? sim.ruleset.tactics.pickup.unarmedLimit : stance === "item" ? sim.ruleset.tactics.pickup.itemStanceLimit : sim.ruleset.tactics.pickup.upgradeLimit;
          // overwatch (#38): a long gun first, from further away
          if (stance === "overwatch" && isLongGun(sim.ruleset, type as Weapon) && !hasLongGun(sim, me)) {
            limit = Math.max(limit, sim.ruleset.tactics.stances.overwatch.longGunLimit);
            extra -= 10;
          }
        } else if (type === "jetpack") limit = sim.ruleset.tactics.pickup.jetpackLimit;
        else if (stance === "item") limit = sim.ruleset.tactics.pickup.itemStanceLimit;
        else if (type === "health" && me.hp < sim.ruleset.tactics.pickup.healthBelowHp) limit = sim.ruleset.tactics.pickup.healthLimit;
        else continue;
        const t = it.body.translation();
        if (preferLocal && isWeapon && sought < 0 && quarter(mp.x) !== quarter(t.x)) extra += opening.otherQuarterCost;
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
        // no closer for sim.ruleset.tactics.pickup.giveUpTicks: unreachable, skip it for a while
        const d = Math.abs(sim.pos(me).x - best.x) + Math.abs(sim.pos(me).y - (nav.surfaces[best.surface]?.y ?? 0)) * 0.5;
        if (!this.chase || this.chase.id !== best.item) this.chase = { id: best.item!, best: d, since: sim.tick };
        else if (d < this.chase.best - 0.5) this.chase = { id: best.item!, best: d, since: sim.tick };
        else if (sim.tick - this.chase.since > sim.ruleset.tactics.pickup.giveUpTicks) {
          this.skipItems.set(best.item!, sim.tick + sim.ruleset.tactics.pickup.skipTicks);
          this.chase = null;
          return this.chooseGoal(sim, me, target, plan, crossingWall, flank, weapon);
        }
        return best;
      }
      this.chase = null;
      if (stance === "item") stance = close ? "rush" : "distance";
      if (!armed) stance = "rush"; // nothing to grab: scrap with fists
    }

    if (this.controller.pressing(sim)) {
      // pressing: get beside the target, switching sides now and then (breaks vertical and wall deadlocks)
      const flip = Math.floor(sim.tick / sim.ruleset.tactics.patience.pressFlip) % 2 === 0 ? 1 : -1;
      const gx = tp.x + flip * 2.2;
      return this.bestPoint(sim, plan, (px, py, sid) => Math.abs(px - gx) + Math.abs(py + 0.9 - tp.y) * 0.7 + zonePenalty(px) + fragilePenalty(sid));
    }

    // an active avoid rule (the highest target/avoid rule): keep away from that fighter
    const tr = this.controller.rules.targetRule();
    const av = tr && tr.kind === "avoid" && sim.suddenDeath < 0 && !sim.openingPressure && sim.alive().length > 2 ? sim.fighters[tr.subject] : undefined;
    if (av && av.alive && !av.removed) {
      const ap = sim.pos(av);
      return this.bestPoint(sim, plan, (px, py, sid) => Math.abs(Math.hypot(px - ap.x, py + 1 - ap.y) - 12) + zonePenalty(px) + fragilePenalty(sid));
    }

    const tactics = sim.ruleset.tactics.weapons;
    const reach = weapon ? tactics.reach[weapon] : undefined;
    if (stance === "rush") {
      const side = mp.x < tp.x ? -1 : 1;
      const s = target.surface >= 0 ? nav.surfaces[target.surface] : undefined;
      if (!s || plan.cost[s.id] === Infinity || (this.badSurfaces.get(s.id) ?? -1) > sim.tick) {
        return this.bestPoint(sim, plan, (px, py, sid) => Math.abs(px - tp.x) + Math.abs(py - tp.y) * 0.5 + zonePenalty(px) + fragilePenalty(sid));
      }
      // explosives only: rush to blast range, not into your own blast
      const gap = reach ? Math.min(reach.max, Math.max(tactics.rushGap, reach.min))
        : close || !me.weapons.some((w) => w === "rocket" || w === "grenade" || w === "railgun" || w === "mine") ? 1.1 : 4;
      const x = clamp(tp.x + side * gap, Math.max(s.x0 + 0.3, zl), Math.min(s.x1 - 0.3, zr));
      return { surface: s.id, x: clamp(x, s.x0 + 0.3, s.x1 - 0.3) };
    }

    const ideal = reach ? clamp(reach.standOff, reach.min, reach.max) : me.weapons.includes("hammer") ? 2.2 : me.weapons[0] === "mine" ? 5 : me.weapons[0] === "flamethrower" ? 2.6 : me.weapons[0] === "shotgun" ? 4.5 : stance === "cover" ? 9 : 12;
    const st = sim.ruleset.tactics.stances;
    const tac = sim.tactical;
    const tFeet = sim.feetY(target);
    if (stance === "overwatch") {
      // high ground with sightlines over the fight, at the long gun's stand-off; keep a chosen perch a while
      const ow = st.overwatch;
      const p0 = this.perch;
      if (p0 && sim.tick < p0.until && nav.surfaces[p0.surface] && plan.cost[p0.surface] !== Infinity && zonePenalty(p0.x) === 0) return { surface: p0.surface, x: p0.x };
      const gun = me.weapons.find((w) => isLongGun(sim.ruleset, w));
      const standOff = gun ? sim.ruleset.tactics.weapons.reach[gun].standOff : ideal;
      const g = this.bestPoint(sim, plan, (px, py, sid, i) => {
        const d = length2D(px - tp.x, py - tFeet);
        let s = -Math.min(Math.max(tac.rise[i]!, 0), ow.maxRise) * ow.riseWeight - tac.view(i) * ow.viewWeight + Math.abs(d - standOff) * ow.reachWeight;
        if (tac.sees(px, py, tp.x, tFeet)) s -= 3;
        return s + zonePenalty(px) + fragilePenalty(sid);
      });
      this.perch = { ...g, y: nav.surfaces[g.surface]?.y ?? 0, until: sim.tick + ow.holdTicks };
      return g;
    }
    if (stance === "hold") {
      const hold = st.hold;
      let spot = this.holdSpot;
      // the spot's floor broke: the nearest point still there, or a new spot
      if (spot && (!nav.surfaces[spot.surface] || Math.abs((nav.surfaces[spot.surface]?.y ?? -99) - spot.y) > 0.01 || spot.x < nav.surfaces[spot.surface]!.x0 || spot.x > nav.surfaces[spot.surface]!.x1)) {
        const i = tac.pointAt(spot.x, spot.y, 2.5);
        spot = i >= 0 ? { surface: nav.points[i]!.surface, x: nav.points[i]!.x, y: nav.points[i]!.y } : null;
      }
      if (!spot || zonePenalty(spot.x) > 0 || plan.cost[spot.surface] === Infinity) {
        const spots = coverSpots(sim);
        const caches = sim.items().filter((e) => e.itemType && !(POWER_LIST as readonly string[]).includes(e.itemType)).map((e) => e.body.translation());
        const g = this.bestPoint(sim, plan, (px, py, sid, i) => {
          let s = -Math.max(0, tac.rise[i]!) * hold.riseWeight + Math.abs(px - mp.x) * hold.homeWeight;
          if (spots.some((c) => c.surface === sid && Math.abs(c.x - px) < 0.6)) s -= hold.coverBonus;
          if (caches.some((c) => Math.abs(c.x - px) < 3 && Math.abs(c.y - py) < 1.5)) s -= hold.itemBonus;
          return s + zonePenalty(px) * 2 + fragilePenalty(sid);
        });
        spot = { ...g, y: nav.surfaces[g.surface]?.y ?? 0 };
      }
      this.holdSpot = spot;
      // a target inside the leash: fight it from within the held area; otherwise stay on the spot
      const near = length2D(tp.x - spot.x, tFeet - spot.y) <= hold.leash;
      if (!near) return { surface: spot.surface, x: spot.x };
      const held = spot;
      return this.bestPoint(sim, plan, (px, py, sid) => {
        const out = length2D(px - held.x, py - held.y);
        if (out > hold.radius) return 1000 + out;
        return Math.abs(length2D(px - tp.x, py - tFeet) - ideal) * 0.6 + zonePenalty(px) + fragilePenalty(sid);
      });
    }
    if (stance === "flank") {
      // route around the target: first a waypoint on its far side, off the straight line (from above when there is
      // a level above), then close in from there
      const fl = st.flank;
      let f = this.flankPlan;
      if (!f || f.target !== target.id || sim.tick - f.since > fl.giveUpTicks) {
        f = { target: target.id, side: mp.x < tp.x ? 1 : -1, since: sim.tick, around: false };
        this.flankPlan = f;
      }
      const side = f.side;
      if ((mp.x - tp.x) * side > 0.4) f.around = true;
      if (f.around) {
        const s = target.surface >= 0 ? nav.surfaces[target.surface] : undefined;
        if (s && plan.cost[s.id] !== Infinity) return { surface: s.id, x: clamp(tp.x + side * Math.max(1.1, reach ? Math.min(reach.max, reach.standOff * 0.5) : 1.1), s.x0 + 0.3, s.x1 - 0.3) };
      }
      const myFeet = sim.feetY(me);
      const lo = Math.min(mp.x, tp.x), hi = Math.max(mp.x, tp.x);
      return this.bestPoint(sim, plan, (px, py, sid) => {
        let s = Math.abs(px - (tp.x + side * fl.gap)) + Math.abs(py - (tFeet + 2)) * 0.5;
        // the straight line: same level as both of us, between us
        if (px > lo && px < hi && Math.abs(py - tFeet) < 1.5 && Math.abs(py - myFeet) < 1.5) s += fl.corridorPenalty;
        // behind it: on the side it faces away from
        if ((px - tp.x) * side > 0 && side === -target.facing) s -= fl.behindBonus;
        return s + zonePenalty(px) + fragilePenalty(sid);
      });
    }
    if (stance === "cover") {
      // move between sim-computed cover spots (a wall beside the spot, between it and the target); every so
      // often peek out somewhere with a clear shot, then duck back
      const cv = st.cover;
      const peek = (sim.tick + this.controller.fighterId * 61) % cv.peekEvery < cv.peekFor;
      if (!peek) {
        // hide from the nearest rival (the one who can shoot first), keep a spot while it still shelters me,
        // otherwise the best sheltered spot within reach
        const threat = nearestRival(sim, me) ?? target;
        const hp = sim.pos(threat);
        const hides = (c: { x: number; y: number; side: number }) => c.side === (hp.x > c.x ? 1 : -1) && shelters(sim, threat, c.x, c.y);

        const held = this.coverSpot;
        if (held && nav.surfaces[held.surface] && plan.cost[held.surface] !== Infinity && hides(held) && zonePenalty(held.x) === 0) return { surface: held.surface, x: held.x };
        // candidates: the computed cover spots (a wall or a crate beside them) and every nav point (ledges and
        // platform undersides shelter too); a spot must shelter me from the threat to count
        let best: { surface: number; x: number; y: number; side: 1 | -1 } | null = null, bs = Infinity;
        const consider = (surface: number, x: number, y: number, side: 1 | -1, bonus: number) => {
          const cost = plan.cost[surface]!;
          if (cost === Infinity || (this.badSurfaces.get(surface) ?? -1) > sim.tick) return;
          const travel = cost + Math.abs(plan.arriveX[surface]! - x);
          if (travel > cv.spotRange || zonePenalty(x) > 0) return;
          const d = length2D(x - tp.x, y - tFeet);
          // the nearest shelter wins: getting out of the line matters more than the ideal range
          const sc = Math.abs(d - ideal) * cv.rangeWeight + fragilePenalty(surface) + travel - bonus;
          if (sc >= bs || !shelters(sim, threat, x, y)) return;
          bs = sc;
          best = { surface, x, y, side };
        };
        for (const c of coverSpots(sim)) if (c.side === (hp.x > c.x ? 1 : -1)) consider(c.surface, c.x, c.y, c.side, cv.coverBonus);
        const free = spotFree(sim);
        for (const p of nav.points) if (free(p)) consider(p.surface, p.x, p.y, hp.x > p.x ? 1 : -1, 0);
        this.coverSpot = best;
        if (best) return { surface: (best as { surface: number }).surface, x: (best as { x: number }).x };
      }
      // peek (or nowhere to hide): the nearest point with a clear shot when peeking, out of sight otherwise
      const myFeet = sim.feetY(me);
      return this.bestPoint(sim, plan, (px, py, sid) => {
        const d = length2D(px - tp.x, py - tFeet);
        let s = Math.abs(d - ideal) * cv.rangeWeight + length2D(px - mp.x, py - myFeet) + zonePenalty(px) + fragilePenalty(sid);
        const clear = tac.sees(px, py, tp.x, tFeet);
        if (peek ? clear : !clear) s -= 7;
        return s;
      });
    }
    return this.bestPoint(sim, plan, (px, py, sid) => {
      const dx = px - tp.x;
      const dy = py + 1 - tp.y;
      const d = length2D(dx, dy);
      let s = Math.abs(d - ideal) + zonePenalty(px) + fragilePenalty(sid);
      if (d > 0.5) {
        const hit = sim.raycast(tp.x, tp.y, dx / d, dy / d, d);
        if (hit && hit.terrain) s += reach ? tactics.terrainPenalty : 3;
      }
      s -= Math.min(py, 5) * 0.25;
      return s;
    });
  }

  private bestPoint(sim: Sim, plan: ReturnType<Sim["nav"]["plan"]>, score: (x: number, y: number, s: number, i: number) => number): Goal {
    let best: Goal | null = null;
    let bs = Infinity;
    for (let i = 0; i < sim.nav.points.length; i++) {
      const p = sim.nav.points[i]!;
      const c = plan.cost[p.surface]!;
      if (c === Infinity) continue;
      const s = score(p.x, p.y, p.surface, i) + (c + Math.abs(plan.arriveX[p.surface]! - p.x)) * 0.12;
      if (s < bs) {
        bs = s;
        best = { surface: p.surface, x: p.x };
      }
    }
    const me = sim.fighters[this.controller.fighterId]!;
    return best ?? { surface: me.surface, x: sim.pos(me).x };
  }

  steer(sim: Sim, me: Fighter, target: Fighter, mp: ReturnType<Sim["pos"]>, mv: ReturnType<Sim["vel"]>, input: Input, crossingWall: boolean, flank: number, weapon?: Weapon): Surface | undefined {
    const tp = sim.pos(target);
    const nav = sim.nav;

    if (this.navVersion !== sim.navVersion) {
      this.navVersion = sim.navVersion;
      this.goal = null;
      this.activeLink = null;
    }

    const surf = me.surface >= 0 ? nav.surfaces[me.surface] : undefined;
    let moveTarget = tp.x;
    this.edgeLink = null;
    if (me.grounded) this.foothold = { x: mp.x, y: sim.feetY(me) };
    if (me.grounded && me.jumpCd === 0) this.jumpTo = null;
    if (surf) {
      let plan = nav.fighterPlan(sim.grid, me.surface, mp.x, sim.ruleset);
      // the zone is coming and no jump we can make leads into it: a risky jump beats being pushed into the pit
      const [zl, zr] = this.zoneBounds(sim);
      if ((mp.x < zl || mp.x > zr) && !nav.surfaces.some((s) => plan.cost[s.id] !== Infinity && s.x1 > zl && s.x0 < zr)) plan = nav.plan(me.surface, mp.x);
      if (sim.tick >= this.nextEval || !this.goal || !nav.surfaces[this.goal.surface] || plan.cost[this.goal.surface] === Infinity) {
        this.goal = this.chooseGoal(sim, me, target, plan, crossingWall, flank, weapon);
        this.nextEval = sim.tick + 24 + this.controller.fighterId * 3;
      }
      const goal = this.goal;
      moveTarget = goal.x;
      if (me.grounded && this.activeLink && me.jumpCd === 0) this.activeLink = null;
      // a jump still "in flight" for too long (bouncing on a pad, wedged): drop it
      if (this.activeLink && sim.tick - this.linkSince > sim.ruleset.tactics.patience.linkTicks) this.activeLink = null;
      // stuck watchdog: no progress toward the goal for a while
      const gy = nav.surfaces[goal.surface]?.y ?? sim.feetY(me);
      const gd = Math.abs(mp.x - goal.x) + Math.abs(sim.feetY(me) - gy) * 0.5;
      const pr = this.prog;
      if (!pr || pr.surface !== goal.surface || Math.abs(pr.x - goal.x) > 1.5) this.prog = { surface: goal.surface, x: goal.x, best: gd, since: sim.tick };
      else if (gd < pr.best - 0.3) {
        pr.best = gd;
        pr.since = sim.tick;
      } else if (gd > 1.2 && sim.tick - pr.since > sim.ruleset.tactics.patience.stuckTicks) {
        this.stuckCount++;
        if (goal.surface !== me.surface) this.badSurfaces.set(goal.surface, sim.tick + sim.ruleset.tactics.patience.avoidTicks);
        this.dig = { until: sim.tick + sim.ruleset.tactics.patience.digTicks, dir: goal.x >= mp.x ? 1 : -1 };
        this.activeLink = null;
        this.prog = null;
        this.nextEval = sim.tick;
      }
      if (this.activeLink) {
        moveTarget = this.activeLink.landX;
      } else if (!me.grounded) {
        // in the air with no jump planned (a hop, a knock, a nav rebuild): head for the landing, then the goal
        moveTarget = this.jumpTo ? this.jumpTo.x : goal.x;
      } else if (goal.surface !== me.surface) {
        const link = plan.firstLink[goal.surface];
        if (link) {
          this.edgeLink = link;
          if (link.kind === "jump") {
            moveTarget = link.takeoffX;
            if (runUp(nav, link)) {
              // across a gap (#69): run through the takeoff point at full speed; past it, back up for a run-up
              const dir = Math.sign(link.landX - link.takeoffX) || 1;
              const ahead = (mp.x - link.takeoffX) * dir;
              moveTarget = ahead > 0.4 ? link.takeoffX - dir * 1.2 : ahead > -2.5 ? link.landX : link.takeoffX;
            }
            if (Math.abs(mp.x - link.takeoffX) < 0.4 && (!runUp(nav, link) || mv.x * Math.sign(link.landX - link.takeoffX) > sim.ruleset.combat.fighter.walkSpeed * 0.7)) {
              input.jump = true;
              this.activeLink = link;
              this.linkSince = sim.tick;
              this.jumpTo = { x: link.landX, y: nav.surfaces[link.to]!.y };
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

    // in the air (#69): only steer where a surface can still catch us
    if (!me.grounded) moveTarget = this.landing(sim, me, mp, mv, moveTarget, input);

    const diff = moveTarget - mp.x;
    input.move = Math.abs(diff) < 0.15 ? 0 : clamp(diff / 0.7, -1, 1);
    if (me.grounded && Math.abs(input.move) > 0.5) {
      const dir = input.move > 0 ? 1 : -1;
      const hit = sim.raycast(mp.x, sim.feetY(me) + 0.35, dir, 0, sim.ruleset.combat.fighter.radius + 0.4, me.entity.collider);
      // hop over what is in the way, unless the goal is right here in front of it (#38: a cover spot against a wall)
      const stopsShort = this.goal?.surface === me.surface && Math.abs(moveTarget - mp.x) < (hit ? hit.dist : 0);
      if (hit && hit.entity?.kind !== "fighter" && !stopsShort) input.jump = true;
      if (Math.abs(mv.x) < 0.6) this.stuck++;
      else this.stuck = 0;
      if (this.stuck > 18) {
        input.jump = true;
        this.stuck = 0;
      }
    } else this.stuck = 0;
    this.guardLedge(sim, me, mp, mv, input);
    return surf;
  }

  /**
   * Ledge safety on the ground (#69): no input walks the fighter off an edge with nothing below, unless the link it
   * is taking starts at that edge. Knockback can still throw it off; its own feet cannot.
   */
  guardLedge(sim: Sim, me: Fighter, mp: { x: number }, mv: { x: number }, input: Input) {
    if (!me.grounded || me.surface < 0 || input.move === 0) return;
    const s = sim.nav.surfaces[me.surface];
    if (!s) return;
    const dir = input.move > 0 ? 1 : -1;
    const edge = dir > 0 ? s.x1 : s.x0;
    const link = this.edgeLink ?? this.activeLink;
    if (link && link.from === s.id && Math.abs(link.takeoffX - edge) < 1.2 && Math.sign(link.landX - link.takeoffX) === dir) return;
    const v = Math.max(0, mv.x * dir);
    const room = (edge - mp.x) * dir - v * v / (2 * sim.ruleset.combat.fighter.groundAccel);
    if (room > 0.35) return;
    if (sim.nav.fallBelow(sim.grid, edge + dir * 0.6, s.y) !== Infinity) return;
    input.move = 0;
  }

  /**
   * Where the fighter can still land from here (#69): for each surface below the arc, the x span it can reach by the
   * time its feet come down to that surface, from its velocity, air control and gravity.
   */
  private landingSpans(sim: Sim, me: Fighter, mp: { x: number }, mv: { x: number; y: number }) {
    const F = sim.ruleset.combat.fighter, g = sim.ruleset.combat.gravity;
    const vmax = F.walkSpeed * (me.power.speed > 0 ? sim.ruleset.pickups.power.speed.mul : 1) * (me.power.heavy > 0 ? sim.ruleset.pickups.power.heavy.speedMul : 1);
    const acc = F.airAccel * (me.power.speed > 0 ? 1.3 : 1);
    const feet = sim.feetY(me);
    // distance covered in t seconds when steering hard toward `to` (+1 / -1)
    const travel = (to: number, t: number) => {
      const v1 = to * vmax, t1 = Math.abs(v1 - mv.x) / acc;
      return t <= t1 ? mv.x * t + to * acc * t * t / 2 : (mv.x + v1) / 2 * t1 + v1 * (t - t1);
    };
    const spans: { surface: Surface; lo: number; hi: number }[] = [];
    for (const s of sim.nav.surfaces) {
      const disc = mv.y * mv.y + 2 * g * (feet - s.y);
      if (disc < 0) continue;
      const t = (mv.y + Math.sqrt(disc)) / g;
      if (t < 0) continue;
      // a margin for steering that is not perfect, and for the body overhanging the edge
      const lo = Math.max(s.x0 + 0.15, mp.x + travel(-1, t) + 0.1);
      const hi = Math.min(s.x1 - 0.15, mp.x + travel(1, t) - 0.1);
      if (lo <= hi) spans.push({ surface: s, lo, hi });
    }
    return spans;
  }

  /**
   * Ledge safety in the air (#69): keep steering for `want` while a surface can still catch us there. When none can
   * (a jump that hit a ceiling, a knock over a pit), land on the planned link's surface if it can still be reached,
   * else on the surface we left, else on the reachable surface nearest to `want`. Nowhere at all: steer for the
   * nearest ledge and use the double jump.
   */
  private landing(sim: Sim, me: Fighter, mp: { x: number; y: number }, mv: { x: number; y: number }, want: number, input: Input): number {
    const spans = this.landingSpans(sim, me, mp, mv);
    const to = this.jumpTo, back = this.foothold;
    if (to && me.power.jump > 0 && !me.airJumped && mv.y < -2 && me.stun === 0 && sim.feetY(me) < to.y) input.jump = true;
    if (spans.some((s) => want >= s.lo && want <= s.hi)) return want;
    const on = (p: { x: number; y: number } | null) => (s: (typeof spans)[number]) => !!p && Math.abs(s.surface.y - p.y) < 0.3 && p.x >= s.surface.x0 - 0.5 && p.x <= s.surface.x1 + 0.5;
    const pick = spans.find(on(to)) || spans.find(on(back)) ||
      spans.reduce<(typeof spans)[number] | undefined>((best, s) => {
        const d = Math.max(s.lo - want, want - s.hi, 0) - s.surface.y * 0.01;
        return !best || d < Math.max(best.lo - want, want - best.hi, 0) - best.surface.y * 0.01 ? s : best;
      }, undefined);
    if (pick) {
      if (to && !on(to)(pick)) {
        this.activeLink = null;
        this.jumpTo = null;
      }
      const inset = Math.min(0.5, (pick.hi - pick.lo) / 2);
      return clamp(want, pick.lo + inset, pick.hi - inset);
    }
    // nothing can catch us: the nearest ledge below, and the double jump
    let bx = want, bd = Infinity;
    const feet = sim.feetY(me);
    for (const s of sim.nav.surfaces) {
      if (s.y > feet) continue;
      const ex = mp.x < s.x0 ? s.x0 + 0.6 : mp.x > s.x1 ? s.x1 - 0.6 : mp.x;
      const d = Math.abs(ex - mp.x) + (feet - s.y) * 0.3;
      if (d < bd) {
        bd = d;
        bx = ex;
      }
    }
    if (me.power.jump > 0 && !me.airJumped && mv.y < -1 && me.stun === 0) input.jump = true;
    return bx;
  }
}
