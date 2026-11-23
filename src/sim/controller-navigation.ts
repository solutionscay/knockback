import { arenaQuarter } from "./level-spawns";
import type { Controller } from "./controller";
import { Liquid } from "./grid";
import { hazardous, LIQUID_COST, runUp, type Link, type NavGraph, type Surface } from "./nav";
import { clamp, length2D } from "./dmath";
import { type Sim } from "./sim";
import { POWER_LIST, type Fighter, type Input, type Weapon } from "./sim-types";
import { RANGED_STANDOFF, weaponReach } from "./controller-weapons";
import { onLiveGround } from "./sim-lightning";
import { lowOnAmmo } from "./sim-items";
import { walkSpeedNow } from "./sim-movement";
import { SPEED_ACCEL_MUL } from "./constants";
import { coverSpots, hasLongGun, isLongGun, nearestRival, shelters, spotFree } from "./tactical";

/** Still, not firing, with a live target this long: the goal is not working (#69). */
const IDLE_TICKS = 40;
/** then look for a spot with a shot this long */
const VANTAGE_TICKS = 120;
const isWeaponItem = (t: unknown) => typeof t === "string" && !(POWER_LIST as readonly string[]).includes(t);
const isRanged = (sim: Sim, w: Weapon) => w !== "fist" && sim.ruleset.tactics.weapons.reach[w].standOff >= RANGED_STANDOFF;
/** A goal on live ground (#72) costs this much: fighters stand somewhere else while it is live. */
const LIVE_GROUND_COST = 25;
/**
 * Going nowhere (#88): over this many ticks, out of a fight, the feet stay in a box this small while the fighter hops,
 * paces or pushes. Then it escapes: backs off for ESCAPE_TICKS and plans around the spot.
 */
const NOWHERE_TICKS = 100;
const NOWHERE_W = 1.6;
const NOWHERE_H = 2.5;
const ESCAPE_TICKS = 36;
/** a blocked way (a prop or a wall the fighter cannot get past) is planned around this long */
const BLOCKER_TICKS = 180;
/** a hop needs this much headroom over the head to clear what is in front (#88) */
const HOP_HEADROOM = 1.1;

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
  private prog: { surface: number; x: number; y: number; best: number; since: number } | null = null;
  /** surfaces to stay off for a while, by where they are (#88: surface ids change with every nav rebuild) */
  private badSurfaces: { x0: number; x1: number; y: number; until: number }[] = [];
  /** ways that turned out blocked (#88): from (x, y) on, going `dir`, nothing gets through until `until` */
  blockers: { x: number; y: number; dir: 1 | -1; until: number }[] = [];
  /** going-nowhere watchdog (#88): recent feet positions, takeoffs and moves */
  private trail: { x: number; y: number; jump: boolean; move: number }[] = [];
  private wasGrounded = true;
  /** escaping (#88): until this tick, back off this way */
  private escapeUntil = 0;
  private escapeDir: 1 | -1 = 1;
  /** this tick's jump is a hop over something in the way (a guard that stops the walk drops it too, #88) */
  hopped = false;
  /** times the going-nowhere watchdog fired this fight (stats, tests) */
  nowhereCount = 0;
  /** stranded (#88): no route to the target and nothing that reaches it, since this tick; it digs toward the target */
  private strandedAt = -1e9;
  /** where the vantage search started (#88): the spot to leave, fixed for the whole search */
  private vantageFrom: { surface: number; x: number } | null = null;
  private linkSince = -1;
  /** the jump in flight (#69): where it lands, kept as a point so it outlives a nav rebuild */
  private jumpTo: { x: number; y: number } | null = null;
  /** where the feet last stood (#69): the ledge to fall back on */
  private foothold: { x: number; y: number } | null = null;
  /** the link this fighter is walking to this tick: its edge is not a ledge to stop at */
  private edgeLink: Link | null = null;
  /** wedged (#69): ticks stuck in the air (between two corners), and until when to push the other way */
  private wedged = 0;
  private rockUntil = 0;
  private rockDir = 0;
  /** idle watchdog (#69): ticks still, with a live target, not firing */
  private idle = 0;
  /** looking for a spot with a shot until this tick */
  private vantageUntil = 0;
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

  constructor(private readonly controller: Pick<Controller, "fighterId" | "stanceNow" | "pressing" | "rules" | "lastFight">) {}

  private addBlocker(sim: Sim, me: Fighter, dir: 1 | -1): boolean {
    const s = me.surface >= 0 ? sim.nav.surfaces[me.surface] : undefined;
    const p = sim.pos(me);
    if (!s || Math.abs(sim.feetY(me) - s.y) > 1.2) return false;
    this.blockers = this.blockers.filter((b) => b.until > sim.tick);
    if (this.blockers.some((b) => b.dir === dir && Math.abs(b.x - p.x) < 0.5 && Math.abs(b.y - s.y) < 0.4)) return false;
    this.blockers.push({ x: p.x, y: s.y, dir, until: sim.tick + BLOCKER_TICKS });
    return true;
  }

  /** The way on is blocked right here (#88: a prop under a low roof): plan around it now. */
  private blockWay(sim: Sim, me: Fighter, dir: 1 | -1) {
    if (!this.addBlocker(sim, me, dir)) return;
    const g = this.goal;
    if (g?.item !== undefined) this.skipItems.set(g.item, sim.tick + sim.ruleset.tactics.pickup.skipTicks);
    this.goal = null;
    this.activeLink = null;
    this.prog = null;
    this.nextEval = sim.tick;
  }

  /** Is surface `sid` one to stay off now? (matched by place, so a nav rebuild keeps it) */
  private isBad(sim: Sim, sid: number): boolean {
    const s = sim.nav.surfaces[sid];
    if (!s || !this.badSurfaces.length) return false;
    return this.badSurfaces.some((b) => b.until > sim.tick && Math.abs(b.y - s.y) < 0.3 && b.x0 < s.x1 && b.x1 > s.x0);
  }

  private markBad(sim: Sim, sid: number, ticks: number) {
    const s = sim.nav.surfaces[sid];
    if (!s) return;
    this.badSurfaces = this.badSurfaces.filter((b) => b.until > sim.tick);
    this.badSurfaces.push({ x0: s.x0, x1: s.x1, y: s.y, until: sim.tick + ticks });
  }

  /**
   * Is the way to a spot blocked (#88)? A route leaves my surface at the spot itself (same surface) or at its first
   * link's takeoff; a blocker on my surface stops everything past it in its direction.
   */
  private wayBlocked(sim: Sim, me: Fighter, plan: ReturnType<NavGraph["plan"]>, sid: number, x: number): boolean {
    if (!this.blockers.length || me.surface < 0) return false;
    const s = sim.nav.surfaces[me.surface];
    if (!s) return false;
    const exit = sid === me.surface ? x : plan.firstLink[sid]?.takeoffX;
    if (exit === undefined) return false;
    return this.blockers.some((b) => b.until > sim.tick && Math.abs(b.y - s.y) < 0.4 && b.x >= s.x0 - 0.5 && b.x <= s.x1 + 0.5 && (exit - b.x) * b.dir > 0.3);
  }

  /**
   * Going nowhere (#88), called with each tick's final input: hopping, pacing or pushing in place for NOWHERE_TICKS
   * with no fight going on. It then backs off, marks the way it was trying as blocked (a prop or a wall it cannot get
   * past), drops the pickup or surface it was heading for, and plans again. True when it trips.
   */
  watchNowhere(sim: Sim, me: Fighter, input: Input, target: Fighter | null): boolean {
    const p = sim.pos(me);
    const feet = sim.feetY(me);
    const takeoff = this.wasGrounded && !me.grounded && sim.vel(me).y > 2;
    this.wasGrounded = me.grounded;
    const quiet = sim.tick - this.controller.lastFight > NOWHERE_TICKS;
    if (!target || !target.alive || target.removed || me.stun > 0 || !quiet || sim.tick < this.escapeUntil) {
      this.trail.length = 0;
      return false;
    }
    const tr = this.trail;
    tr.push({ x: p.x, y: feet, jump: takeoff, move: input.move });
    if (tr.length > NOWHERE_TICKS) tr.shift();
    if (tr.length < NOWHERE_TICKS || sim.tick % 10 !== 0) return false;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, jumps = 0, path = 0, rev = 0, dir = 0, push = 0, pushSum = 0;
    for (let k = 0; k < tr.length; k++) {
      const t = tr[k]!;
      x0 = Math.min(x0, t.x);
      x1 = Math.max(x1, t.x);
      y0 = Math.min(y0, t.y);
      y1 = Math.max(y1, t.y);
      if (t.jump) jumps++;
      if (Math.abs(t.move) > 0.5) push++;
      pushSum += t.move;
      if (k > 0) {
        const dx = t.x - tr[k - 1]!.x;
        path += Math.abs(dx);
        if (Math.abs(dx) > 0.01) {
          const d = Math.sign(dx);
          if (dir && d !== dir) rev++;
          dir = d;
        }
      }
    }
    if (x1 - x0 >= NOWHERE_W || y1 - y0 >= NOWHERE_H) return false;
    const hopping = jumps >= 2, pacing = path >= 3 && rev >= 2, pushing = push > tr.length * 0.6;
    if (!hopping && !pacing && !pushing) return false;
    // the way it was trying to go: the moves' average, or toward the goal
    const want: 1 | -1 = Math.abs(pushSum) > tr.length * 0.15 ? (pushSum > 0 ? 1 : -1) : (this.goal?.x ?? sim.pos(target).x) >= p.x ? 1 : -1;
    this.addBlocker(sim, me, want);
    const g = this.goal;
    if (g?.item !== undefined) this.skipItems.set(g.item, sim.tick + sim.ruleset.tactics.pickup.skipTicks);
    if (g && g.surface !== me.surface) this.markBad(sim, g.surface, sim.ruleset.tactics.patience.avoidTicks);
    this.escapeDir = want === 1 ? -1 : 1;
    this.escapeUntil = sim.tick + ESCAPE_TICKS;
    this.vantageUntil = 0;
    this.vantageFrom = null;
    this.activeLink = null;
    this.goal = null;
    this.prog = null;
    this.nextEval = sim.tick;
    this.nowhereCount++;
    tr.length = 0;
    return true;
  }

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

  /**
   * No idle gaps (#69): called with each tick's input. Still, not firing, with a live target for IDLE_TICKS means
   * the goal gives no shot; the fighter then moves to a spot with one for a while. True when it trips.
   */
  watchIdle(sim: Sim, me: Fighter, input: Input, target: Fighter | null): boolean {
    const v = sim.vel(me);
    const busy = input.fire || me.scope > 0 || me.railCharge > 0 || me.stun > 0 || Math.abs(v.x) > 0.6 || Math.abs(v.y) > 0.6;
    if (!target || !target.alive || target.removed || busy) {
      this.idle = 0;
      return false;
    }
    if (++this.idle < IDLE_TICKS) return false;
    this.idle = 0;
    // no route to the target and nothing carried reaches it (#88): no spot gives a shot, so no search for one (it
    // only paces back and forth); wait at the nearest point, or go for a pickup that reaches
    if (me.surface >= 0 && target.surface >= 0 && sim.nav.fighterPlan(sim.grid, me.surface, sim.pos(me).x).cost[target.surface] === Infinity) {
      const tp = sim.pos(target), mp = sim.pos(me);
      const reach = me.weapons.reduce((r, w) => Math.max(r, weaponReach(sim.ruleset, me, w).max), weaponReach(sim.ruleset, me, "fist").max);
      if (reach < length2D(tp.x - mp.x, tp.y - mp.y) - 2) {
        this.strandedAt = sim.tick;
        return true;
      }
    }
    // the spot to leave is this one, for the whole search (#88: not wherever the fighter stands at each re-plan)
    if (sim.tick >= this.vantageUntil) this.vantageFrom = { surface: me.surface, x: sim.pos(me).x };
    this.vantageUntil = sim.tick + VANTAGE_TICKS;
    this.nextEval = sim.tick;
    return true;
  }

  /**
   * Digging toward a target it cannot get to (#88): stranded, standing, with terrain right in the line to the target,
   * the direction to swing (melee carves terrain). Never down into a pit. Null when there is nothing to dig.
   */
  tunnel(sim: Sim, me: Fighter, target: Fighter): { x: number; y: number } | null {
    if (sim.tick - this.strandedAt > 120 || !me.grounded || me.stun > 0 || Math.abs(sim.vel(me).x) > 0.8) return null;
    if (me.surface < 0 || target.surface < 0 || sim.nav.fighterPlan(sim.grid, me.surface, sim.pos(me).x).cost[target.surface] !== Infinity) {
      this.strandedAt = -1e9;
      return null;
    }
    const mp = sim.pos(me), tp = sim.pos(target);
    const d = length2D(tp.x - mp.x, tp.y - mp.y);
    if (d < 0.5) return null;
    const dir = { x: (tp.x - mp.x) / d, y: (tp.y - mp.y) / d };
    const hit = sim.raycast(mp.x, mp.y, dir.x, dir.y, 1.5, me.entity.collider);
    if (!hit || !hit.terrain) return null;
    // down through the floor: only with ground under it to land on
    if (dir.y < -0.5 && sim.nav.fallBelow(sim.grid, mp.x + dir.x * 1.2, sim.feetY(me) - 1.2) === Infinity) return null;
    this.strandedAt = sim.tick; // still at it
    return dir;
  }

  /** A reachable spot, not this one, that sees the target at the stand-off of the longest weapon carried (#69). */
  private vantage(sim: Sim, me: Fighter, target: Fighter, plan: ReturnType<NavGraph["plan"]>, zonePenalty: (x: number) => number, fragilePenalty: (s: number) => number): Goal {
    const reach = (w: Weapon) => weaponReach(sim.ruleset, me, w);
    const gun = me.weapons.reduce<Weapon>((best, w) => (reach(w).max > reach(best).max ? w : best), "fist");
    const ideal = clamp(reach(gun).standOff, reach(gun).min, reach(gun).max);
    const mp = sim.pos(me), tp = sim.pos(target), tFeet = sim.feetY(target);
    const from = this.vantageFrom ?? { surface: me.surface, x: mp.x };
    const hold = this.controller.stanceNow(sim) === "hold" ? this.holdSpot : null;
    return this.bestPoint(sim, plan, (px, py, sid) => {
      let s = Math.abs(length2D(px - tp.x, py - tFeet) - ideal) * 0.3;
      if (!sim.tactical.sees(px, py, tp.x, tFeet)) s += 8;
      if (sid === from.surface && Math.abs(px - from.x) < 1.5) s += 20;
      if (hold && length2D(px - hold.x, py - hold.y) > sim.ruleset.tactics.stances.hold.radius) s += 1000;
      return s + zonePenalty(px) + fragilePenalty(sid);
    });
  }

  private zoneBounds(sim: Sim): [number, number] {
    const half = sim.zoneHalfAhead(120);
    const h = Math.max(1.5, half - 1.2);
    return [sim.zone.center - h, sim.zone.center + h];
  }

  private chooseGoal(sim: Sim, me: Fighter, target: Fighter, plan: ReturnType<NavGraph["plan"]>, crossingWall: boolean, flank: number, weapon?: Weapon): Goal {
    const nav = sim.nav;
    const mp = sim.pos(me);
    const tp = sim.pos(target);
    const [zl, zr] = this.zoneBounds(sim);
    const zonePenalty = (x: number) => (x < zl ? 40 + (zl - x) * 6 : x > zr ? 40 + (x - zr) * 6 : 0);
    // #94: a pool floor costs its liquid (lava and acid: never a place to stand)
    const fragilePenalty = (s: number) => (nav.surfaces[s]?.fragile ? 3 : 0) + LIQUID_COST[nav.surfaces[s]?.liquid ?? 0]! + (this.isBad(sim, s) ? 30 : 0);
    if (flank) {
      // Step around the obstruction at a different x before trying to breach again.
      const x = tp.x + flank * 4.5;
      return this.bestPoint(sim, plan, (px, py, sid) => Math.abs(px - x) + Math.abs(py + 0.84 - tp.y) * 0.8 + zonePenalty(px) + fragilePenalty(sid));
    }
    if (crossingWall) {
      const to = nav.surfaces[target.surface];
      if (to && plan.cost[to.id] !== Infinity && !this.isBad(sim, to.id) && !this.wayBlocked(sim, me, plan, to.id, tp.x)) {
        return { surface: to.id, x: clamp(tp.x, to.x0 + 0.35, to.x1 - 0.35) };
      }
      return this.bestPoint(sim, plan, (x, y, sid) => Math.abs(x - tp.x) + Math.abs(y + 0.84 - tp.y) + zonePenalty(x) + fragilePenalty(sid));
    }
    let stance = this.controller.stanceNow(sim);
    // overwatch and distance want a weapon that fights from range; without one they keep away and go for one (#69)
    const ranged = me.weapons.some((w) => isRanged(sim, w));
    const hangBack = (stance === "overwatch" || stance === "distance") && !ranged;
    const close = me.weapons.includes("hammer") || me.weapons.includes("bat") || me.weapons.includes("shotgun") || me.weapons.includes("flamethrower");

    // arm up: go for the pickups this fighter wants (fists only = go far for anything; low on ammo = re-arm, #95)
    const armed = me.weapons.some((w) => w !== "fist");
    const low = armed && lowOnAmmo(sim.ruleset, me);
    const opening = sim.ruleset.pickups.armory.spread;
    const preferLocal = opening.enabled && !armed && sim.tick < opening.preferLocalTicks;
    const quarter = (x: number) => arenaQuarter(sim.level.minX, sim.level.width, x);
    // no route to the target (#88): a weapon that fights from range, or the jetpack, is worth a long way
    const stranded = target.surface >= 0 && plan.cost[target.surface] === Infinity;
    // ...and nothing carried reaches it from here: any pickup beats standing about
    const tDist = length2D(tp.x - mp.x, tp.y - mp.y);
    const nothingReaches = stranded && me.weapons.every((w) => weaponReach(sim.ruleset, me, w).max < tDist - 2);
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
        if (sought >= 0 && (!isWeapon || sim.wantsWeapon(me, type as Weapon, it.ammo))) {
          // an active seek rule: go far for it, ahead of everything else
          limit = sim.ruleset.tactics.pickup.seekLimit;
          extra = -40 + sought * 5;
        } else if (isWeapon) {
          if (!sim.wantsWeapon(me, type as Weapon, it.ammo)) continue;
          if (it.owner === me.id && sim.tick - it.born < 45) continue;
          const rank = me.prefs.indexOf(type as Weapon);
          // bare-handed or low (#95): the nearest weapon, whatever it is
          extra = !armed || low ? 0 : Math.max(0, rank) * sim.ruleset.tactics.pickup.rankCost;
          limit = !armed ? sim.ruleset.tactics.pickup.unarmedLimit : stance === "item" ? sim.ruleset.tactics.pickup.itemStanceLimit : sim.ruleset.tactics.pickup.upgradeLimit;
          if (low) limit = Math.max(limit, sim.ruleset.tactics.pickup.rearmLimit);
          if ((stranded && isRanged(sim, type as Weapon)) || nothingReaches) limit = Math.max(limit, sim.ruleset.tactics.pickup.unarmedLimit);
          // overwatch (#38) and distance (#69): a long gun first, from further away
          if ((stance === "overwatch" && isLongGun(sim.ruleset, type as Weapon) && !hasLongGun(sim, me)) || (hangBack && isRanged(sim, type as Weapon))) {
            limit = Math.max(limit, sim.ruleset.tactics.stances.overwatch.longGunLimit);
            extra -= 10;
          }
        } else if (type === "jetpack") limit = stranded ? sim.ruleset.tactics.pickup.unarmedLimit : sim.ruleset.tactics.pickup.jetpackLimit;
        else if (stance === "item") limit = sim.ruleset.tactics.pickup.itemStanceLimit;
        else if (type === "health" && me.hp < sim.ruleset.tactics.pickup.healthBelowHp) limit = sim.ruleset.tactics.pickup.healthLimit;
        else if (nothingReaches) limit = sim.ruleset.tactics.pickup.unarmedLimit;
        else continue;
        const t = it.body.translation();
        if (preferLocal && isWeapon && sought < 0 && quarter(mp.x) !== quarter(t.x)) extra += opening.otherQuarterCost;
        const s = nav.surfaceAt(t.x, t.y + 0.3, 0.2);
        if (!s || plan.cost[s.id] === Infinity || this.isBad(sim, s.id) || this.wayBlocked(sim, me, plan, s.id, t.x)) continue;
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
          // weapons are few (#95): bare-handed or low, try that one again soon
          const again = (!armed || low) && sim.items().some((e) => e.id === best!.item && isWeaponItem(e.itemType));
          this.skipItems.set(best.item!, sim.tick + (again ? sim.ruleset.tactics.pickup.rearmSkipTicks : sim.ruleset.tactics.pickup.skipTicks));
          this.chase = null;
          return this.chooseGoal(sim, me, target, plan, crossingWall, flank, weapon);
        }
        return best;
      }
      this.chase = null;
      if (stance === "item") stance = close ? "rush" : "distance";
      if (!armed && !hangBack) stance = "rush"; // nothing to grab: scrap with fists
    }

    const tactics = sim.ruleset.tactics.weapons;
    const reach = weapon ? weaponReach(sim.ruleset, me, weapon) : undefined;
    // the held weapon's stand-off (#69): every stance fights at its weapon's range
    const standOff = reach ? clamp(reach.standOff, reach.min, reach.max) : undefined;
    if (sim.tick < this.vantageUntil) return this.vantage(sim, me, target, plan, zonePenalty, fragilePenalty);
    if (this.controller.pressing(sim)) {
      // pressing: get beside the target (at the weapon's range), switching sides now and then (breaks vertical and
      // wall deadlocks)
      const flip = Math.floor(sim.tick / sim.ruleset.tactics.patience.pressFlip) % 2 === 0 ? 1 : -1;
      // no route to the target (#95: one weapon, often a close one): switching sides only paces; the nearest point
      // fists and the bat (#95: fists are common late) press in at their own reach, or they never land one
      const gap = weapon === "fist" || weapon === "bat" ? (standOff ?? 2.2) : Math.max(2.2, standOff ?? 0);
      const gx = stranded ? tp.x : tp.x + flip * gap;
      return this.bestPoint(sim, plan, (px, py, sid) => Math.abs(px - gx) + Math.abs(py + 0.9 - tp.y) * 0.7 + zonePenalty(px) + fragilePenalty(sid));
    }

    // an active avoid rule (the highest target/avoid rule): keep away from that fighter
    const tr = this.controller.rules.targetRule();
    const av = tr && tr.kind === "avoid" && sim.suddenDeath < 0 && !sim.openingPressure && sim.alive().length > 2 ? sim.fighters[tr.subject] : undefined;
    if (av && av.alive && !av.removed) {
      const ap = sim.pos(av);
      return this.bestPoint(sim, plan, (px, py, sid) => Math.abs(Math.hypot(px - ap.x, py + 1 - ap.y) - 12) + zonePenalty(px) + fragilePenalty(sid));
    }

    // rush with a weapon that fights from distance: a spot at its range with a clear line, like distance (#69)
    if (stance === "rush" && (standOff ?? 0) <= 4.5) {
      const side = mp.x < tp.x ? -1 : 1;
      const s = target.surface >= 0 ? nav.surfaces[target.surface] : undefined;
      if (!s || plan.cost[s.id] === Infinity || this.isBad(sim, s.id) || this.wayBlocked(sim, me, plan, s.id, tp.x)) {
        return this.bestPoint(sim, plan, (px, py, sid) => Math.abs(px - tp.x) + Math.abs(py - tp.y) * 0.5 + zonePenalty(px) + fragilePenalty(sid));
      }
      // close to the held weapon's range (#69): a rocket stops at rocket range, a bat at bat range
      const gap = standOff ?? (close || !me.weapons.some((w) => w === "rocket" || w === "grenade" || w === "railgun" || w === "mine") ? tactics.rushGap : 4);
      const x = clamp(tp.x + side * gap, Math.max(s.x0 + 0.3, zl), Math.min(s.x1 - 0.3, zr));
      return { surface: s.id, x: clamp(x, s.x0 + 0.3, s.x1 - 0.3) };
    }

    // a spot closer than this to the target wastes a weapon that fights from range (#69)
    const tooClose = (d: number) => (weapon && isRanged(sim, weapon) && standOff ? Math.max(0, standOff * 0.7 - d) * 3 : 0);
    const ideal = hangBack ? 12 : standOff !== undefined ? standOff : me.weapons.includes("hammer") ? 2.2 : me.weapons[1] === "mine" ? 5 : me.weapons[1] === "flamethrower" ? 2.6 : me.weapons[1] === "shotgun" ? 4.5 : stance === "cover" ? 9 : 12;
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
      if (weapon && isRanged(sim, weapon) && standOff) {
        // a weapon that fights from range does not walk round past the target: a spot at its range on this side, off
        // the straight line, with a clear line of fire (#69)
        const mine = mp.x < tp.x ? -1 : 1;
        return this.bestPoint(sim, plan, (px, py, sid) => {
          const d = length2D(px - tp.x, py - tFeet);
          let s = Math.abs(d - standOff) + tooClose(d) + ((px - tp.x) * mine < 0 ? fl.corridorPenalty : 0);
          if (Math.abs(py - tFeet) < 1.5) s += 2;
          if (!tac.sees(px, py, tp.x, tFeet)) s += tactics.terrainPenalty;
          return s + zonePenalty(px) + fragilePenalty(sid);
        });
      }
      if (f.around) {
        const s = target.surface >= 0 ? nav.surfaces[target.surface] : undefined;
        if (s && plan.cost[s.id] !== Infinity) return { surface: s.id, x: clamp(tp.x + side * Math.max(1.1, standOff ?? 1.1), s.x0 + 0.3, s.x1 - 0.3) };
      }
      const myFeet = sim.feetY(me);
      const lo = Math.min(mp.x, tp.x), hi = Math.max(mp.x, tp.x);
      return this.bestPoint(sim, plan, (px, py, sid) => {
        // the far side at the weapon's range: a long gun goes round wide (#69)
        let s = Math.abs(px - (tp.x + side * Math.max(fl.gap, standOff ?? 0))) + Math.abs(py - (tFeet + 2)) * 0.5;
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
        if (held && nav.surfaces[held.surface] && plan.cost[held.surface] !== Infinity && hides(held) && zonePenalty(held.x) === 0 && tooClose(length2D(held.x - tp.x, held.y - tFeet)) === 0) return { surface: held.surface, x: held.x };
        // candidates: the computed cover spots (a wall or a crate beside them) and every nav point (ledges and
        // platform undersides shelter too); a spot must shelter me from the threat to count
        let best: { surface: number; x: number; y: number; side: 1 | -1 } | null = null, bs = Infinity;
        const consider = (surface: number, x: number, y: number, side: 1 | -1, bonus: number) => {
          const cost = plan.cost[surface]!;
          if (cost === Infinity || this.isBad(sim, surface) || this.wayBlocked(sim, me, plan, surface, x)) return;
          const travel = cost + Math.abs(plan.arriveX[surface]! - x);
          if (travel > cv.spotRange || zonePenalty(x) > 0) return;
          const d = length2D(x - tp.x, y - tFeet);
          // the nearest shelter wins: getting out of the line matters more than the ideal range
          const sc = Math.abs(d - ideal) * cv.rangeWeight + tooClose(d) + fragilePenalty(surface) + travel - bonus;
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
        let s = Math.abs(d - ideal) * cv.rangeWeight + tooClose(d) + length2D(px - mp.x, py - myFeet) + zonePenalty(px) + fragilePenalty(sid);
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

  private bestPoint(sim: Sim, plan: ReturnType<NavGraph["plan"]>, score: (x: number, y: number, s: number, i: number) => number): Goal {
    let best: Goal | null = null;
    let bs = Infinity;
    const live = sim.liveGround.length > 0;
    const me = sim.fighters[this.controller.fighterId]!;
    const points = sim.nav.points;
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      const c = plan.cost[p.surface]!;
      if (c === Infinity || this.wayBlocked(sim, me, plan, p.surface, p.x)) continue;
      let s = score(p.x, p.y, p.surface, i) + (c + Math.abs(plan.arriveX[p.surface]! - p.x)) * 0.12;
      if (live && onLiveGround(sim, p.x, p.y)) s += LIVE_GROUND_COST;
      if (s < bs) {
        bs = s;
        best = { surface: p.surface, x: p.x };
      }
    }
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
    const lastEdge = this.edgeLink;
    this.edgeLink = null;
    if (me.grounded) this.foothold = { x: mp.x, y: sim.feetY(me) };
    if (me.grounded && me.jumpCd === 0) this.jumpTo = null;
    if (surf) {
      let plan = nav.fighterPlan(sim.grid, me.surface, mp.x);
      // the zone is coming and no jump we can make leads into it: a risky jump beats being pushed into the pit
      const [zl, zr] = this.zoneBounds(sim);
      if ((mp.x < zl || mp.x > zr) && !nav.surfaces.some((s) => plan.cost[s.id] !== Infinity && s.x1 > zl && s.x0 < zr)) plan = nav.plan(me.surface, mp.x);
      // a target inside a ranged weapon's reach: look again soon, to back off in time (#69)
      const reach = weapon ? weaponReach(sim.ruleset, me, weapon) : undefined;
      if (reach && isRanged(sim, weapon!) && length2D(tp.x - mp.x, tp.y - mp.y) < reach.standOff * 0.6) this.nextEval = Math.min(this.nextEval, sim.tick + 8);
      if (sim.tick >= this.nextEval || !this.goal || !nav.surfaces[this.goal.surface] || plan.cost[this.goal.surface] === Infinity || this.wayBlocked(sim, me, plan, this.goal.surface, this.goal.x)) {
        let g = this.chooseGoal(sim, me, target, plan, crossingWall, flank, weapon);
        // a spot past a blocked way (#88): the nearest spot to the target this side of it instead
        if (this.wayBlocked(sim, me, plan, g.surface, g.x)) {
          const [zl, zr] = this.zoneBounds(sim);
          g = this.bestPoint(sim, plan, (px, py) => Math.abs(px - tp.x) + Math.abs(py - tp.y) * 0.5 + (px < zl ? 40 + (zl - px) * 6 : px > zr ? 40 + (px - zr) * 6 : 0));
        }
        this.goal = g;
        this.nextEval = sim.tick + 24 + this.controller.fighterId * 3;
      }
      const goal = this.goal!;
      moveTarget = goal.x;
      if (me.grounded && this.activeLink && me.jumpCd === 0) this.activeLink = null;
      // a jump still "in flight" for too long (bouncing on a pad, wedged): drop it
      if (this.activeLink && sim.tick - this.linkSince > sim.ruleset.tactics.patience.linkTicks) this.activeLink = null;
      // stuck watchdog: no progress toward the goal for a while
      const gy = nav.surfaces[goal.surface]?.y ?? sim.feetY(me);
      const gd = Math.abs(mp.x - goal.x) + Math.abs(sim.feetY(me) - gy) * 0.5;
      const pr = this.prog;
      // the same goal is the same place (#88: a nav rebuild renumbers the surfaces, the goal stays where it was)
      if (!pr || Math.abs(pr.y - gy) > 0.3 || Math.abs(pr.x - goal.x) > 1.5) this.prog = { surface: goal.surface, x: goal.x, y: gy, best: gd, since: sim.tick };
      else if (gd < pr.best - 0.3) {
        pr.best = gd;
        pr.since = sim.tick;
      } else if (gd > 1.2 && sim.tick - pr.since > sim.ruleset.tactics.patience.stuckTicks) {
        this.stuckCount++;
        if (goal.surface !== me.surface) this.markBad(sim, goal.surface, sim.ruleset.tactics.patience.avoidTicks);
        this.dig = { until: sim.tick + sim.ruleset.tactics.patience.digTicks, dir: goal.x >= mp.x ? 1 : -1 };
        this.activeLink = null;
        this.prog = null;
        this.nextEval = sim.tick;
      }
      // walked off the edge of a drop link: fly it as planned (#84)
      if (!this.activeLink && !me.grounded && lastEdge?.kind === "drop" && lastEdge.from === me.surface) this.takeLink(sim, nav, lastEdge);
      // a link in flight: its landing (the flight rule is applied below, once landing() has had its say)
      if (this.activeLink) moveTarget = this.activeLink.landX;
      else if (!me.grounded) {
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
              this.takeLink(sim, nav, link);
              moveTarget = link.landX;
            }
          } else if (link.through) {
            // down through the jump-through platform we stand on (#100): hold down over the spot
            moveTarget = link.takeoffX;
            if (Math.abs(mp.x - link.takeoffX) < 0.5) {
              input.down = true;
              this.takeLink(sim, nav, link);
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

    // in the air (#69): only steer where a surface can still catch us; on a link, fly it the planner's way (#84)
    if (!me.grounded) {
      moveTarget = this.landing(sim, me, mp, mv, moveTarget, input);
      if (this.activeLink && nav.surfaces[this.activeLink.to]) moveTarget = nav.flightAim(sim.grid, this.activeLink, mp.x, sim.feetY(me), mv.x, mv.y, moveTarget);
    }
    // standing on something that falls (a broken-off chunk, a dropped platform) over nothing: jump off it (#69)
    else if (mv.y < -2 && nav.fallBelow(sim.grid, mp.x, sim.feetY(me)) === Infinity) {
      input.jump = true;
      moveTarget = this.landing(sim, me, mp, { x: mv.x, y: sim.ruleset.combat.fighter.jumpSpeed }, moveTarget, input);
    }
    // wedged between two corners (not grounded, not moving): push the other way a moment to come free (#69)
    this.wedged = !me.grounded && me.stun === 0 && Math.abs(mv.x) < 0.2 && Math.abs(mv.y) < 0.3 ? this.wedged + 1 : 0;
    if (this.wedged >= 12) {
      this.wedged = 0;
      this.rockDir = moveTarget >= mp.x ? -1 : 1;
      this.rockUntil = sim.tick + 10;
    }
    if (sim.tick < this.rockUntil) moveTarget = mp.x + this.rockDir * 2;
    // escaping a spot that went nowhere (#88): back off the way it came
    if (sim.tick < this.escapeUntil && !this.activeLink) moveTarget = mp.x + this.escapeDir * 2;

    const diff = moveTarget - mp.x;
    // a link is run up to and flown at the base walk speed (#84), as the planner flew it: a Speed power-up would
    // overshoot the planned arc
    const near = me.grounded && this.edgeLink && this.edgeLink.kind !== "walk" && Math.abs(mp.x - this.edgeLink.takeoffX) < 3;
    const onLink = (!me.grounded && this.activeLink) || near;
    const cap = onLink ? Math.min(1, sim.ruleset.combat.fighter.walkSpeed / walkSpeedNow(sim.ruleset, me)) : 1;
    input.move = Math.abs(diff) < 0.15 ? 0 : clamp(diff / 0.7, -1, 1) * cap;
    this.hopped = false;
    if (me.grounded && Math.abs(input.move) > 0.5) {
      const dir = input.move > 0 ? 1 : -1;
      const hit = sim.raycast(mp.x, sim.feetY(me) + 0.35, dir, 0, sim.ruleset.combat.fighter.radius + 0.4, me.entity.collider);
      // hop over what is in the way, unless the goal is right here in front of it (#38: a cover spot against a wall);
      // a hop that would hit a ceiling clears nothing (#88: the going-nowhere watchdog plans around it instead)
      const stopsShort = this.goal?.surface === me.surface && Math.abs(moveTarget - mp.x) < (hit ? hit.dist : 0);
      const F = sim.ruleset.combat.fighter;
      const head = sim.feetY(me) + 2 * (F.halfHeight + F.radius);
      const roof = () => sim.raycast(mp.x + dir * 0.3, head - 0.05, 0, 1, HOP_HEADROOM, me.entity.collider);
      if (hit && hit.entity?.kind !== "fighter" && !stopsShort) {
        if (!roof()) {
          input.jump = true;
          this.hopped = true;
        } else if (hit.dist < 0.5) this.blockWay(sim, me, dir); // up against it under a low roof: no way past here
      }
      if (Math.abs(mv.x) < 0.6) this.stuck++;
      else this.stuck = 0;
      if (this.stuck > 18) {
        if (!roof()) {
          input.jump = true;
          this.hopped = true;
        }
        this.stuck = 0;
      }
    } else this.stuck = 0;
    this.guardLedge(sim, me, mp, mv, input);
    return surf;
  }

  /** Start flying `link` (a jump just pressed, or a drop just walked off), as the planner flew it (#84). */
  private takeLink(sim: Sim, nav: NavGraph, link: Link) {
    this.activeLink = link;
    this.linkSince = sim.tick;
    this.jumpTo = { x: link.landX, y: nav.surfaces[link.to]!.y };
  }

  /**
   * Live ground (#72): standing on it, walk off it the short way; about to step (or hop) onto it, stop at its edge
   * and wait (it lasts seconds). Called with the final input, like guardLedge.
   */
  guardLiveGround(sim: Sim, me: Fighter, mp: { x: number }, input: Input) {
    if (!me.grounded || !sim.liveGround.length) return;
    const feet = sim.feetY(me);
    const under = onLiveGround(sim, mp.x, feet);
    if (under) {
      const first = under.points[0]!, last = under.points[under.points.length - 1]!;
      const left = mp.x - first.x, right = last.x - mp.x;
      // off the near end, unless that end is a ledge with nothing below
      let dir = left <= right ? -1 : 1;
      const end = (d: number) => (d < 0 ? first.x - 0.8 : last.x + 0.8);
      if (sim.nav.fallBelow(sim.grid, end(dir), feet) === Infinity) dir = -dir;
      input.move = dir;
      input.jump = false;
      return;
    }
    if (input.move === 0) return;
    const dir = input.move > 0 ? 1 : -1;
    for (const ahead of [0.45, 0.9, 1.8]) {
      if (onLiveGround(sim, mp.x + dir * ahead, feet)) {
        input.move = 0;
        input.jump = false;
        return;
      }
    }
  }

  /**
   * Liquids (#94), on the final input. Afloat in water: swim strokes (jump) to keep the head up and reach a rim; in
   * lava or acid with feet down: jump out at once. On the ground, its own feet never walk it off an edge into lava or
   * acid unless the link it is taking starts there (a jump across a pool takes off from the rim).
   */
  guardLiquid(sim: Sim, me: Fighter, mp: { x: number; y: number }, mv: { x: number; y: number }, input: Input) {
    const g = sim.grid;
    const feet = sim.feetY(me);
    const atBody = g.liquidAt(mp.x, mp.y);
    const atFeet = g.liquidAt(mp.x, feet + 0.1);
    if (!me.grounded && (atBody === Liquid.Water || atFeet === Liquid.Water)) {
      if (mv.y < 1) input.jump = true;
      return;
    }
    if (me.grounded && (hazardous(atFeet) || hazardous(atBody))) {
      input.jump = true;
      return;
    }
    if (!me.grounded || me.surface < 0 || input.move === 0) return;
    const s = sim.nav.surfaces[me.surface];
    if (!s || s.liquid) return;
    const dir = input.move > 0 ? 1 : -1;
    const edge = dir > 0 ? s.x1 : s.x0;
    if ((edge - mp.x) * dir > 0.6 + Math.max(0, mv.x * dir) * 0.1) return;
    const link = this.edgeLink ?? this.activeLink;
    if (link && link.from === s.id && Math.sign(link.landX - link.takeoffX) === dir && link.kind === "jump") return;
    const below = g.cy(s.y - 0.01);
    for (let cy = below; cy >= Math.max(0, below - 6); cy--) {
      const cx = g.cx(edge + dir * 0.3);
      if (hazardous(g.liqAt(cx, cy))) {
        input.move = 0;
        return;
      }
      if (g.solid(cx, cy)) return;
    }
  }

  /**
   * Ledge safety on the ground (#69): no input walks the fighter off an edge with nothing below, unless the link it
   * is taking starts at that edge. Knockback can still throw it off; its own feet cannot.
   */
  guardLedge(sim: Sim, me: Fighter, mp: { x: number }, mv: { x: number }, input: Input) {
    if (!me.grounded || me.surface < 0 || input.move === 0) return;
    const nav = sim.nav;
    const s = nav.surfaces[me.surface];
    if (!s) return;
    const dir = input.move > 0 ? 1 : -1;
    const edge = dir > 0 ? s.x1 : s.x0;
    const link = this.edgeLink ?? this.activeLink;
    if (link && link.from === s.id && Math.abs(link.takeoffX - edge) < 1.2 && Math.sign(link.landX - link.takeoffX) === dir) return;
    const v = Math.max(0, mv.x * dir);
    const room = (edge - mp.x) * dir - v * v / (2 * sim.ruleset.combat.fighter.groundAccel);
    if (room > 0.35) return;
    if (nav.fallBelow(sim.grid, edge + dir * 0.6, s.y) !== Infinity) return;
    input.move = 0;
    // a hop with no walk is a jump in place (#88)
    if (this.hopped) input.jump = false;
  }

  /**
   * Where the fighter can still land from here (#69): for each surface below the arc, the x span it can reach by the
   * time its feet come down to that surface, from its velocity, air control and gravity.
   */
  private landingSpans(sim: Sim, me: Fighter, mp: { x: number }, mv: { x: number; y: number }) {
    const g = sim.ruleset.combat.gravity;
    const vmax = walkSpeedNow(sim.ruleset, me);
    const acc = sim.ruleset.combat.fighter.airAccel * (me.power.speed > 0 ? SPEED_ACCEL_MUL : 1);
    const feet = sim.feetY(me);
    // distance covered in t seconds when steering hard toward `to` (+1 / -1)
    const travel = (to: number, t: number) => {
      const v1 = to * vmax, t1 = Math.abs(v1 - mv.x) / acc;
      return t <= t1 ? mv.x * t + to * acc * t * t / 2 : (mv.x + v1) / 2 * t1 + v1 * (t - t1);
    };
    const spans: { surface: Surface; lo: number; hi: number }[] = [];
    for (const s of sim.nav.surfaces) {
      // resting on its corner (not falling, feet just under its top): step onto it
      if (feet < s.y && feet > s.y - 0.6 && mp.x > s.x0 - 0.6 && mp.x < s.x1 + 0.6 && Math.abs(mv.y) < 1) {
        spans.push({ surface: s, lo: s.x0 + 0.15, hi: s.x1 - 0.15 });
        continue;
      }
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
