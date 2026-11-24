/**
 * Strategy controller: turns a fighter's round strategy { target preference,
 * stance, weapon preferences, retaliate } into frame-by-frame inputs. The
 * controller does all target picking, pickup hunting, weapon switching, aiming
 * and movement. Every fighter gets the same controller and the same aim.
 */
import { length2D } from "./dmath";
import { CLASSIC, type Ruleset } from "./ruleset";
import { aimAndFire, inReach, railCanReach, sightTarget } from "./controller-aim";
import { JetpackPilot } from "./controller-jetpack";
import { chooseCombatWeapon, playCombatChoice } from "./controller-weapons";
import { ControllerNavigation } from "./controller-navigation";
import { Escape } from "./controller-escape";
import { attackWall, WallPursuit } from "./controller-wall";
import type { Surface } from "./nav";
import { availableRule } from "./rules";
import { RuleEngine } from "./ruleeval";
import { inOpen } from "./tactical";
import { type Sim } from "./sim";
import { NO_INPUT, isPickupWeapon, isPrecision, type Fighter, type Input, type Stance, type Strategy, type Weapon } from "./sim-types";
import { lowOnAmmo } from "./sim-items";

/** Weapons that are for close range anyway: saving their last uses for later means nothing (#95). */
const CLOSE_WEAPONS: readonly Weapon[] = ["bat", "hammer", "flamethrower", "lightning", "shotgun"];


const NO_FIRE: Input = { ...NO_INPUT };


export class Controller {
  strategy: Strategy;
  private readonly navigation = new ControllerNavigation(this);
  /** #100: out of a pocket (a crater, a carved hole): climb, else dig */
  readonly escape: Escape;
  /** All controllers in the match. */
  peers: Controller[] = [];
  private nextRetarget = 0;
  private nextWeapon = 0;
  private wanted: Weapon | null = null;
  /** Ticks without line of sight to the target (stalemate breaker). */
  private noLos = 0;
  /** Effective target this tick. */
  targetId = -1;
  /** tick the current target was chosen (chasing_me rules read it) */
  targetSince = 0;
  private sinceFor = -1;
  /** plan rules of the current strategy (#6) */
  rules = new RuleEngine([]);
  private prefsKey = "";
  /** last ticks this fighter dealt / took fighter damage (cover patience) */
  private lastDealt = 0;
  private lastTaken = 0;
  private unreachable = new Map<number, number>();
  private noReach = 0;
  private readonly wallPursuit = new WallPursuit();
  private wallRoute = 0;
  private readonly jetpack = new JetpackPilot();
  /** the carried weapon (#95) and the last tick it was fired (or picked up): a low one left unused is dropped */
  private held: Weapon = "fist";
  private lastFired = 0;
  /** the last tick this fighter fired anything (fists too) */
  private lastShot = 0;

  get goal() {
    return this.navigation.goal;
  }

  get stuckCount() {
    return this.navigation.stuckCount;
  }

  get dig() {
    return this.navigation.dig;
  }

  /** times the going-nowhere watchdog fired this fight (#88) */
  get nowhereCount() {
    return this.navigation.nowhereCount;
  }

  /** the last tick this fighter dealt or took fighter damage */
  get lastFight() {
    return Math.max(this.lastDealt, this.lastTaken);
  }

  /** Called when this fighter damages another (from Fight, in event order). */
  onDealt(tick: number) {
    this.lastDealt = tick;
  }

  /**
   * The stance actually played now: the strategy's, except that the last two
   * fighters and everyone in sudden death close in, and a cover/distance/item
   * fighter who has been quiet too long goes looking for a fight.
   */
  /** Sudden death or the final duel, and this fighter hasn't hurt anyone for a while. */
  pressing(sim: Sim): boolean {
    return (sim.suddenDeath >= 0 || sim.openingPressure || sim.alive().length === 2) && sim.tick - this.lastDealt > sim.ruleset.tactics.patience.pressAfter;
  }

  /** Did `src` hit me at or after tick `since`? (hit_me rules) */
  hitBy(src: number, since: number): boolean {
    return this.hitLog.some((h) => h.src === src && h.tick >= since);
  }

  stanceNow(sim: Sim): Stance {
    // controller guards first (stalemates), then an active stance rule, then the plan
    if (sim.suddenDeath >= 0 || sim.openingPressure || sim.alive().length === 2) return "rush";
    const s = this.rules.stance() ?? this.strategy.stance;
    const stances = sim.ruleset.tactics.stances;
    const calm = s === "overwatch" ? stances.overwatch.calmTicks : s === "hold" ? stances.hold.calmTicks : sim.ruleset.tactics.patience.calmTicks;
    if (s !== "rush" && sim.tick - Math.max(this.lastDealt, this.lastTaken) > calm) return "rush";
    return s;
  }
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
  onHit(src: number, behind: boolean, _damage: number, tick: number, ruleset: Ruleset = CLASSIC) {
    const reflex = ruleset.tactics.reflex;
    this.lastTaken = tick;
    const log = this.hitLog;
    if (!log.length || log[log.length - 1]!.src !== src || log[log.length - 1]!.tick !== tick) log.push({ src, tick, behind });
    while (log.length && log[0]!.tick < tick - reflex.windowTicks) log.shift();
    if (src === this.targetId) return;
    if (this.reflex && this.reflex.attacker === src && tick < this.reflex.until) return;
    const n = log.filter((h) => h.src === src && h.behind).length;
    if (n < reflex.hits) return;
    const rule = this.rules.retaliate() ?? this.strategy.retaliate ?? "turn";
    const mode = rule === "attacker" ? "switch" : rule === "turn" ? "fight" : "glance";
    const span = mode === "switch" ? reflex.switchTicks : mode === "fight" ? reflex.fightTicks : reflex.glanceTicks;
    this.reflex = { attacker: src, until: tick + span, mode };
    this.reflexLog.push({ tick, attacker: src, mode });
    this.hitLog = log.filter((h) => h.src !== src);
    if (mode !== "glance") this.navigation.replan(0); // re-plan movement toward the attacker now
  }

  constructor(
    readonly fighterId: number,
    readonly aimNoise: number,
  ) {
    this.strategy = { target: "nearest", stance: "rush", weapons: ["shotgun", "rocket", "bat"], line: "" };
    this.escape = new Escape(fighterId);
  }

  setStrategy(s: Strategy, sim: Sim) {
    this.strategy = s;
    this.navigation.replan(sim.tick);
    this.navigation.resetStance();
    this.nextRetarget = sim.tick;
    sim.setPrefs(this.fighterId, s.weapons ?? []);
    this.rules = new RuleEngine((s.rules ?? []).filter(rule => availableRule(rule, sim.ruleset)), sim.ruleset.tactics.ruleEval);
    this.prefsKey = "";
  }

  /** Pick a target from the preference; sticky for a second so it does not flicker. */
  private resolveTarget(sim: Sim, me: Fighter): Fighter | null {
    const cur = this.targetId >= 0 ? sim.fighters[this.targetId] : undefined;
    const skip = (o: Fighter) => (this.unreachable.get(o.id) ?? -1) > sim.tick;
    const avoided = this.rules.avoided();
    // an active target rule wins over the plan (not over the stalemate guards)
    const tr = this.rules.targetRule();
    if (tr && tr.kind === "target" && sim.suddenDeath < 0 && !sim.openingPressure) {
      const f = sim.fighters[tr.subject];
      if (f && f.alive && !f.removed && f.id !== me.id && !skip(f)) {
        this.nextRetarget = sim.tick; // back to the plan as soon as the rule stops
        return f;
      }
    }
    // a knocked-out (or skipped, or avoided) target is replaced at once, never waited on
    if (cur && cur.alive && !cur.removed && cur.id !== me.id && sim.tick < this.nextRetarget && !skip(cur) && !avoided.includes(cur.id)) return cur;
    this.nextRetarget = sim.tick + 60;
    const p = sim.pos(me);
    const alive = sim.fighters.filter((o) => o.alive && o.id !== me.id);
    const available = alive.filter((o) => !skip(o));
    const foes = available.length ? available : alive;
    if (foes.length === 0) return null;
    const dist = (o: Fighter) => {
      const q = sim.pos(o);
      return Math.abs(q.x - p.x) + Math.abs(q.y - p.y);
    };
    // sudden death: everyone goes for the nearest rival (with two left, that is the duel)
    const pref = sim.suddenDeath >= 0 || sim.openingPressure ? "nearest" : this.strategy.target;
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
    // a rival with no route to it comes after the ones we can get to (#69: no waiting at a ledge)
    const plan = me.surface >= 0 && foes.length > 1 ? sim.nav.fighterPlan(sim.grid, me.surface, p.x) : null;
    const noRoute = (o: Fighter) => !!plan && o.surface >= 0 && plan.cost[o.surface] === Infinity;
    const scored = (o: Fighter) => score(o) + (skip(o) && foes.length > 1 ? 60 : 0) + (noRoute(o) ? 30 : 0) + (avoided.includes(o.id) && foes.length > 1 ? 1000 : 0);
    let best = foes[0]!;
    let bs = scored(best);
    for (const o of foes) {
      const v = scored(o);
      if (v < bs) {
        bs = v;
        best = o;
      }
    }
    return best;
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
  private chooseWeapon(sim: Sim, me: Fighter, target: Fighter, sight: ReturnType<typeof sightTarget>): Weapon {
    const { dist, los, dy0 } = sight;
    const has = (w: Weapon) => me.weapons.includes(w);
    const ready = (w: Weapon) => has(w) && me.cooldown[w] < 15;
    const mp = sim.pos(me);
    // an active use rule: that weapon, when it is carried and can reach
    // a swap rule (#95) holds its weapon (or fists); a use rule prefers its weapon
    const swap = this.rules.swap();
    if (swap === "fist") return "fist";
    const u = swap ?? this.rules.use();
    const railLine = () => dist >= sim.ruleset.weapons.table.railgun.minRange && railCanReach(sim, mp, sight);
    if (u && u !== "jetpack" && has(u) && (u === "railgun" ? railLine() : inReach(u, dist, los, sim.ruleset, me.ammo.lightning))) return u;
    if (ready("hammer") && me.grounded && Math.abs(dy0) < 1.2 && dist < sim.ruleset.weapons.table.hammer.range) return "hammer";
    if (ready("railgun") && railLine()) return "railgun";
    if (ready("sniper") && los && dist >= sim.ruleset.weapons.table.sniper.minRange && dist < sim.ruleset.weapons.table.sniper.range - 0.5) return "sniper";
    if (this.blocked(dist)) {
      // a wall between us: lob over it, or break through it
      if (has("grenade")) return "grenade";
      if (has("rocket")) return "rocket";
      if (has("bat") && dist < 3) return "bat";
      if (has("shotgun")) return "shotgun";
    }
    if (has("bat") && dist < 2.4) return "bat";
    // the lightning sword (#72): the slash up close, a bolt at middle range with a clear line
    if (has("lightning") && inReach("lightning", dist, los, sim.ruleset, me.ammo.lightning)) return "lightning";
    // flamethrower (#32): up close with a clear line, it outdamages everything else
    if (has("flamethrower") && los && dist < sim.ruleset.weapons.table.flamethrower.range - 0.4) return "flamethrower";
    if (dist < 1.5 && !has("shotgun")) return "fist";
    if (ready("grapple") && los && dist > 3.5 && dist < 14 && (this.onLedge(sim, target, mp.x, mp.y) || has("bat") || has("shotgun"))) return "grapple";
    if (has("shotgun") && dist < 6.5) return "shotgun";
    if (has("crossbow") && los && dist < sim.ruleset.weapons.table.crossbow.range - 0.5) return "crossbow";
    if (has("rifle") && los && dist < sim.ruleset.weapons.table.rifle.range - 0.5) return "rifle";
    if (has("grenade") && !los && dist > 2.5 && dist < 14) return "grenade";
    if (ready("mine") && dist > 2.8 && dist <= sim.ruleset.weapons.table.mine.range) return "mine";
    if (has("rocket") && dist >= 3) return "rocket";
    if (has("grenade") && dist > 2.5 && dist < 14) return "grenade";
    if (has("grapple") && dist > 3.5 && dist < 14) return "grapple";
    // prefer what the strategy likes among what we carry; fists if nothing else
    const carried = me.prefs.filter((w) => has(w));
    return carried[0] ?? "fist";
  }

  /** Rival in the open to shoot instead of a hidden target (overwatch, hold, cover), re-checked every 6 ticks. */
  private spot: { id: number; until: number } | null = null;
  private spotted(sim: Sim, me: Fighter, target: Fighter): Fighter | null {
    const stance = this.stanceNow(sim);
    if (stance !== "overwatch" && stance !== "hold" && stance !== "cover") return null;
    const ranged = me.weapons.some((w) => isPrecision(w) || w === "railgun" || w === "rocket");
    if (!ranged) return null;
    if (this.spot && sim.tick < this.spot.until) {
      const f = this.spot.id >= 0 ? sim.fighters[this.spot.id] : undefined;
      return f && f.alive && !f.removed ? f : null;
    }
    let pick: Fighter | null = null;
    if (!inOpen(sim, me, target)) {
      const p = sim.pos(me);
      let bd = Infinity;
      for (const o of sim.fighters) {
        if (o.id === me.id || o.id === target.id || !o.alive || o.removed || this.rules.avoided().includes(o.id)) continue;
        if (!inOpen(sim, me, o)) continue;
        const q = sim.pos(o);
        const d = Math.abs(q.x - p.x) + Math.abs(q.y - p.y);
        if (d < bd) {
          bd = d;
          pick = o;
        }
      }
    }
    this.spot = { id: pick ? pick.id : -1, until: sim.tick + 6 };
    return pick;
  }

  private blocked(dist: number) {
    return this.noLos > 60 && dist < 12;
  }

  think(sim: Sim): Input {
    const input = this.decide(sim);
    // ledge safety (#69) on the final input: combat moves come after steering
    const me = sim.fighters[this.fighterId]!;
    if (me.alive && !me.removed && input !== NO_FIRE) {
      this.dropIfDone(sim, me, input);
      this.navigation.guardLiveGround(sim, me, sim.pos(me), input);
      this.navigation.guardLedge(sim, me, sim.pos(me), sim.vel(me), input);
      this.navigation.guardLiquid(sim, me, sim.pos(me), sim.vel(me), input);
      this.escape.intoZone(sim, me, input);
      const tf = this.targetId >= 0 ? sim.fighters[this.targetId] : undefined;
      // hopping in place on the way somewhere (#109): that way is blocked; with a plan around it, no walk-and-dig
      if (this.escape.breakHops(sim, me, input, tf && tf.alive && !tf.removed ? sim.pos(tf).x : null) && this.navigation.hopsBlocked(sim, me)) this.escape.endBreak(sim);
      // no idle gaps (#69): a target we can neither reach nor shoot is left for one we can
      const target = this.targetId >= 0 ? sim.fighters[this.targetId]! : null;
      if (this.navigation.watchIdle(sim, me, input, target) && target && sim.alive().length > 2 && me.surface >= 0 && target.surface >= 0 &&
        sim.nav.fighterPlan(sim.grid, me.surface, sim.pos(me).x).cost[target.surface] === Infinity) {
        this.unreachable.set(target.id, sim.tick + sim.ruleset.tactics.patience.skipTicks);
        this.nextRetarget = 0;
      }
      // going nowhere (#88): back off and plan around the spot; a target with no route is left for another
      if (this.navigation.watchNowhere(sim, me, input, target) && target && sim.alive().length > 2 && me.surface >= 0 && target.surface >= 0 &&
        sim.nav.fighterPlan(sim.grid, me.surface, sim.pos(me).x).cost[target.surface] === Infinity) {
        this.unreachable.set(target.id, sim.tick + sim.ruleset.tactics.patience.skipTicks);
        this.nextRetarget = 0;
      }
    }
    return input;
  }

  /**
   * Drop the carried weapon (#95): an active drop rule (once per activation), or - every fighter - a weapon low on
   * ammo that has not been fired for a while, out of a fight, with another weapon on the floor to go for.
   */
  private dropIfDone(sim: Sim, me: Fighter, input: Input) {
    const held = me.weapons[1];
    if (held !== this.held) {
      this.held = held;
      this.lastFired = sim.tick;
    }
    if (input.fire) this.lastShot = sim.tick;
    if (held === "fist") return;
    if (input.fire && (input.weapon ?? sim.weapon(me)) === held) this.lastFired = sim.tick;
    const tuning = sim.ruleset.tactics.pickup;
    const idle = lowOnAmmo(sim.ruleset, me) && sim.tick - this.lastFired >= tuning.dropIdleTicks && sim.tick - this.lastFight >= tuning.dropIdleTicks / 2 &&
      sim.items().some((e) => isPickupWeapon(e.itemType) && e.owner !== me.id);
    if (this.rules.takeDrop(held) || idle) {
      input.drop = true;
      input.fire = false;
    }
  }

  private reachCheck = { at: -1e9, weapons: [] as Weapon[] };
  /**
   * Weapons that reach the target, longest first, when this fighter has no route to it and nothing carried reaches
   * (#95: one slot; checked twice a second). Empty otherwise.
   */
  private needsReach(sim: Sim, me: Fighter): Weapon[] {
    if (sim.tick - this.reachCheck.at < 30) return this.reachCheck.weapons;
    this.reachCheck.at = sim.tick;
    this.reachCheck.weapons = [];
    const target = this.targetId >= 0 ? sim.fighters[this.targetId] : undefined;
    if (!target || !target.alive || target.removed || me.surface < 0 || target.surface < 0) return [];
    const mp = sim.pos(me), tp = sim.pos(target);
    if (sim.nav.fighterPlan(sim.grid, me.surface, mp.x).cost[target.surface] !== Infinity) return [];
    const dist = length2D(tp.x - mp.x, tp.y - mp.y);
    const reach = (w: Weapon) => sim.ruleset.tactics.weapons.reach[w].max;
    if (reach(me.weapons[1]) >= dist) return [];
    this.reachCheck.weapons = sim.ruleset.weapons.enabled.filter((w) => reach(w) >= dist).sort((a, b) => reach(b) - reach(a));
    return this.reachCheck.weapons;
  }

  private decide(sim: Sim): Input {
    const me = sim.fighters[this.fighterId]!;
    if (!me.alive) return NO_FIRE;
    if (this.rules.any) this.rules.evaluate(sim, this, me);
    // an active seek rule for a weapon puts it first in the wish list (so it gets picked up); cut off from the target
    // with nothing that reaches it (#95: one slot), weapons that reach go first
    const seekW = this.rules.any ? this.rules.seeking().filter(isPickupWeapon) : [];
    const reachW = this.needsReach(sim, me);
    const key = `${seekW.join(">")}|${reachW.join(">")}`;
    if (key !== this.prefsKey) {
      this.prefsKey = key;
      sim.setPrefs(this.fighterId, [...seekW, ...reachW, ...this.strategy.weapons]);
    }
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
    // overwatch, hold and cover (#38): shoot whoever is in the open when the target is hidden
    if (target && aimTarget === target && !(rf && sim.tick < rf.until)) {
      const spot = this.spotted(sim, me, target);
      if (spot) aimTarget = spot;
    }
    const mp = sim.pos(me);
    const mv = sim.vel(me);
    const input: Input = { move: 0, jump: false, aimX: me.aimX, aimY: me.aimY, weapon: null, fire: false };
    if (!target) return input;
    if (target.id !== this.sinceFor) {
      this.sinceFor = target.id;
      this.targetSince = sim.tick;
    }
    this.targetId = target.id;
    // cover, overwatch and hold keep walls between them and the target on purpose (#38): no wall pursuit unless pressed
    const stanceNow = this.stanceNow(sim);
    const defensive = (stanceNow === "cover" || stanceNow === "overwatch" || stanceNow === "hold") && !this.pressing(sim);
    const wall = defensive ? null : this.wallPursuit.observe(sim, me, target, mp);
    const wallTicks = wall?.ticks ?? 0;
    const flankTick = wallTicks - sim.ruleset.tactics.wall.flankTicks;
    const flank = flankTick >= 0 && flankTick % sim.ruleset.tactics.wall.flankPeriod < sim.ruleset.tactics.wall.flankFor
      ? ((Math.floor(flankTick / sim.ruleset.tactics.wall.flankPeriod) + me.id) % 2 === 0 ? -1 : 1)
      : 0;
    const wallRoute = flank || (wallTicks >= sim.ruleset.tactics.wall.routeTicks ? 2 : 0);
    if (this.wallRoute !== wallRoute) {
      this.wallRoute = wallRoute;
      this.navigation.replan(sim.tick);
    }
    if (wallTicks >= sim.ruleset.tactics.wall.retargetTicks && sim.alive().length > 2) {
      this.unreachable.set(target.id, sim.tick + sim.ruleset.tactics.patience.skipTicks);
      this.nextRetarget = 0;
      this.reflex = null;
    }
    const tacticalSight = sim.ruleset.tactics.weapons.enabled ? sightTarget(sim, me, aimTarget, mp) : null;
    // a swap rule (#95) holds its weapon or fists; low on ammo with a rival in fist reach, fists keep the last shots
    const swap = tacticalSight ? this.rules.swap() : null;
    const ruleWeapon = tacticalSight ? (swap && swap !== "fist" ? swap : this.rules.use()) : undefined;
    const held = me.weapons[1];
    const pickup = sim.ruleset.tactics.pickup;
    const saveShots = !!tacticalSight && held !== "fist" && !CLOSE_WEAPONS.includes(held) && lowOnAmmo(sim.ruleset, me) &&
      tacticalSight.dist <= pickup.saveShotsReach && tacticalSight.los;
    // one slot (#95): no shot for a while with the rival right here (too close for a rocket, a level off for fists):
    // fists, which close in
    const quietClose = !!tacticalSight && held !== "fist" && sim.tick - this.lastShot > pickup.noShotTicks && tacticalSight.dist <= pickup.noShotReach;
    const level = !!tacticalSight && Math.abs(tacticalSight.dy0) <= sim.ruleset.tactics.weapons.reach.fist.maxDy;
    const noShot = quietClose && level;
    // ...and standing on top of the target (a level too high for fists): step off it sideways
    const stepOff = quietClose && !level && tacticalSight!.dy0 < 0 && Math.abs(tacticalSight!.dx0) < 1.2;
    const choice = tacticalSight ? chooseCombatWeapon(sim, me, mp, tacticalSight, ruleWeapon === "jetpack" ? undefined : ruleWeapon ?? undefined,
      this.onLedge(sim, aimTarget, mp.x, mp.y),
      this.navigation.dig && sim.tick < this.navigation.dig.until ? this.navigation.dig.dir : undefined, swap === "fist" || saveShots || noShot) : null;
    const surf = this.navigation.steer(sim, me, target, mp, mv, input, wallTicks >= sim.ruleset.tactics.wall.routeTicks, flank, choice?.weapon);
    if (stepOff) {
      input.move = mp.x >= sim.zone.center ? -1 : 1; // toward the middle of the zone
      input.jump = true;
    }
    const flying = this.jetpack.steer(sim, me, target, mp, mv, input, this.stanceNow(sim) === "rush", this.rules.use() === "jetpack");
    if (!choice && !me.railCharge && !flying && wall && wallTicks >= sim.ruleset.tactics.wall.attackTicks && !flank && attackWall(sim, me, mp, wall, input)) return input;

    const sight = tacticalSight ?? sightTarget(sim, me, aimTarget, mp);
    const { dx0, dy0, dist, los } = sight;
    if (!choice && me.railCharge > 0) return aimAndFire(sim, me, mp, input, "railgun", sight, false, this.aimNoise);
    if (!choice && me.scope > 0 && me.weapons.includes("sniper")) {
      if (me.grounded) input.move = 0;
      return aimAndFire(sim, me, mp, input, "sniper", sight, false, this.aimNoise);
    }
    this.noLos = los ? 0 : this.noLos + 1;
    // a target with no path and no line of sight for long: pick someone else for a while
    const tSurf = target.surface;
    const reachable = surf && tSurf >= 0 ? sim.nav.fighterPlan(sim.grid, me.surface, mp.x).cost[tSurf] !== Infinity : true;
    // no route and nothing to hit it with from here (#69: a target in sight across a gap counts too)
    this.noReach = !reachable && !choice?.shot && !(los && !choice) ? this.noReach + 1 : 0;
    if (this.noReach > sim.ruleset.tactics.patience.unreachTicks && sim.alive().length > 2) {
      this.unreachable.set(target.id, sim.tick + sim.ruleset.tactics.patience.skipTicks);
      this.nextRetarget = 0;
      this.noReach = 0;
    }
    // trapped in a pocket (#100): climb or dig out toward open floor, unless there is a shot to take from here
    if (!flying && !choice?.shot && this.escape.act(sim, me, input)) return input;
    // stranded (#88): no route and nothing that reaches - dig toward the target through what is in the way
    // ...unless bare-handed with a weapon to go for (#109): the weapon first
    const forWeapon = me.weapons[1] === "fist" && this.navigation.goal?.item !== undefined;
    const dig = !flying && !choice?.shot && !forWeapon ? this.navigation.tunnel(sim, me, target) : null;
    if (dig) {
      // a dig rule (#100): digging punches through soft ground; else the heaviest swing carried
      const digRule = this.rules.digs();
      const w: Weapon = digRule ? "fist" : me.weapons.includes("hammer") ? "hammer" : me.weapons.includes("bat") ? "bat" : "fist";
      input.dig = digRule;
      input.weapon = w;
      input.move = 0;
      input.jump = false;
      input.aimX = dig.x;
      input.aimY = dig.y;
      input.fire = (sim.weapon(me) === w || w === "fist") && me.swap === 0 && me.cooldown[w] === 0;
      return input;
    }
    if (choice) {
      if (!choice.shot && dist > 0) {
        input.aimX = dx0 / dist;
        input.aimY = dy0 / dist;
      }
      // steady shots (#38): stop for precision shots once at the stance's spot (rush and flank shoot on the move)
      const stance = this.stanceNow(sim);
      const goal = this.navigation.goal;
      const atGoal = !goal || (goal.surface === me.surface && Math.abs(goal.x - mp.x) < 1);
      return playCombatChoice(sim, me, input, choice, this.aimNoise, !flying && !flank, stance === "rush" || stance === "flank" ? "move" : atGoal ? "steady" : "transit");
    }

    // Close Quarters retains the original weapon and obstruction handling.
    // digging out: hit the wall between us and the goal
    if (!flying && this.navigation.dig && sim.tick < this.navigation.dig.until) {
      const dir = this.navigation.dig.dir;
      const wall = sim.raycast(mp.x, mp.y + 0.1, dir, 0, 1.6, me.entity.collider);
      if (wall && (wall.terrain || (wall.entity && wall.entity.kind !== "fighter" && wall.entity.kind !== "item"))) {
        const order: Weapon[] = me.grounded ? ["hammer", "bat", "shotgun", "fist"] : ["bat", "shotgun", "fist"];
        const w = order.find((x) => x === "fist" || me.weapons.includes(x))!;
        input.weapon = w;
        if (w === "hammer") input.jump = false;
        input.move = dir * 0.6;
        input.aimX = dir;
        input.aimY = w === "grenade" ? 0.35 : 0.04;
        input.fire = (sim.weapon(me) === w || w === "fist") && me.swap === 0 && me.cooldown[w] === 0 && me.stun === 0;
        return input;
      }
      this.navigation.dig = null;
    } else if (this.navigation.dig) this.navigation.dig = null;
    // breach: parked with a wall or floor between us and the target - go through it
    const breach = this.noLos > sim.ruleset.tactics.patience.breachAfter && Math.abs(mv.x) < 0.8;
    const useNewWeapon = (me.weapons.includes("hammer") && me.grounded && dist < sim.ruleset.weapons.table.hammer.range && Math.abs(dy0) < 1.2) ||
      (me.weapons.includes("railgun") && me.cooldown.railgun < 15 && railCanReach(sim, mp, sight)) ||
      (me.weapons.includes("mine") && me.cooldown.mine < 15 && dist > 2.8 && dist <= sim.ruleset.weapons.table.mine.range);
    if (!useNewWeapon && !flying && !flank && (breach || this.pressing(sim)) && dist < sim.ruleset.tactics.patience.breachRange && dist > 0.3 && me.stun === 0) {
      const has = (w: Weapon) => me.weapons.includes(w);
      const w: Weapon = dist < 1.3 && !has("bat") && !has("shotgun") ? "fist" : has("bat") && dist < 2.8 ? "bat" : has("shotgun") && dist < 7 ? "shotgun" : has("rocket") && dist >= 2 ? "rocket" : has("grenade") ? "grenade" : has("bat") ? "bat" : "fist";
      input.weapon = w;
      input.aimX = dx0 / dist;
      input.aimY = (dy0 + (w === "grenade" ? 0.6 : 0)) / dist;
      const al = length2D(input.aimX, input.aimY);
      input.aimX /= al;
      input.aimY /= al;
      input.fire = (sim.weapon(me) === w || w === "fist") && me.swap === 0 && me.cooldown[w] === 0;
      return input;
    }
    const blocked = this.blocked(dist);
    if (sim.tick >= this.nextWeapon || !this.wanted || !me.weapons.includes(this.wanted)) {
      this.wanted = this.chooseWeapon(sim, me, aimTarget, sight);
      this.nextWeapon = sim.tick + 12;
    }
    return aimAndFire(sim, me, mp, input, this.wanted, sight, blocked, this.aimNoise);
  }
}
