/**
 * A fight is one round: one continuous brawl. Each fighter has one strategy
 * for it; the controllers play the whole brawl out and the shrinking zone
 * forces contact. Ends with one fighter left, or at time-out.
 * (match.ts runs best of 3 of these.)
 *
 * A FightRecord (seed + strategies + plan updates) replays to the same state hash.
 *
 * Plan updates (#8, mid-round check-ins #9): a fighter's plan can change at a
 * given tick. The update list is part of the record, so a replay applies the
 * same plans at the same ticks and needs no AI.
 */
import { neutralStrategy } from "./bots";
import { TICK_RATE } from "./constants";
import { resolveRuleset, type Ruleset } from "./ruleset";
import { Controller } from "./controller";
import type { LevelDef } from "./levelgen";
import { type FighterRoundFacts, type HumiliationKind, type MoraleState, type RoundFacts } from "./morale";
import { Rng } from "./rng";
import { SAMPLE_TICKS, StatsCollector } from "./roundstats";
import { Sim } from "./sim";
import { type Look } from "./identity";
import { NO_INPUT, SEAT_LOOKS, type SimEvent, type Strategy } from "./sim-types";
import { inCover } from "./tactical";

export interface FightOptions {
  ruleset?: Ruleset;
  /** A containing MatchRecord already holds the snapshot. */
  embedRuleset?: boolean;
  /** Level to fight on (default: generated from the seed). Rounds of a match share one. */
  level?: LevelDef;
  /** Morale at the start of this round, per fighter (nudges aim; see morale.ts). */
  morale?: MoraleState[];
  /** Turn morale's behavior nudges off (for A/B stats). */
  noMoraleEffect?: boolean;
  /** Names/colors from the souls (cosmetic: never affects the fight). */
  looks?: Look[];
}

/**
 * A plan change during a round (#8): from `tick` on, `fighter` plays `strategy`
 * (a whole plan, not a diff). Applied at the start of that tick's step, after
 * `tick` ticks have run, in fighter order when several share a tick.
 */
export interface PlanUpdate {
  tick: number;
  fighter: number;
  strategy: Strategy;
  /** what the fighter says with the change (shown as a thought bubble) */
  line?: string;
  /** the AI's short reason, in game terms (logs and reports) */
  why?: string;
  /** where it came from: a mid-round check-in (#9) */
  source?: "checkin";
}

export interface FightRecord {
  ruleset?: Ruleset;
  /** The seed makes the level too (levelgen.ts); theme/attempt are informational. */
  seed: number;
  level: { theme: string; attempt: number; width: number };
  strategies: Strategy[];
  /** mid-round plan updates, sorted by tick then fighter */
  updates: PlanUpdate[];
  /** State hash every CHECKPOINT_TICKS, for pinpointing a divergence. */
  checkpoints: string[];
  finalHash: string;
  ticks: number;
}

export const CHECKPOINT_TICKS = 10 * TICK_RATE;

/**
 * A plan as the hash sees it: only what changes play (no line, no rule
 * labels), keys sorted, so a plan that went through the viewer's sanitizer
 * hashes like the server's.
 */
export function planKey(s: Strategy): string {
  const sorted = (o: object) => Object.fromEntries(Object.entries(o).filter(([k, v]) => k !== "label" && v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)));
  return JSON.stringify([s.target, s.grudge ?? -1, s.stance, s.weapons ?? [], s.retaliate ?? "turn", (s.rules ?? []).map(sorted)]);
}

export interface FightResult {
  winner: number;
  /** How the winner was decided. */
  reason: "last-standing" | "time-out" | "double-ko";
  ticks: number;
  kos: number[]; // knockouts credited per fighter
  damage: number[];
  survivors: number[];
  /** Knockouts in order. */
  koLog: { fighter: number; by: number; cause: "ringout" | "hp"; weapon: string; tick: number; range?: number }[];
}

export class Fight {
  readonly sim: Sim;
  readonly controllers: Controller[];
  readonly strategies: Strategy[];
  readonly record: FightRecord;
  private finishLeft = -1;
  over = false;
  private koLog: FightResult["koLog"] = [];
  /** the last fighter hit on each fighter and how far away it was (#38: knockout range) */
  private lastHit: { by: number; dist: number }[] = [0, 1, 2, 3].map(() => ({ by: -1, dist: 0 }));
  // facts for morale and dialogue
  private selfHit = [0, 0, 0, 0];
  private crushed = [0, 0, 0, 0];
  private biggest: RoundFacts["biggestHit"] = null;
  private chains = 0;
  readonly stats = new StatsCollector();
  /** Optional event sink (the viewer and stats use it). */
  onEvent: ((e: SimEvent) => void) | null = null;
  /** every plan update, sorted by tick then fighter; `nextUpdate` = the first not applied yet */
  private updates: PlanUpdate[] = [];
  private nextUpdate = 0;
  /** FNV-1a over the applied updates (tick, fighter, plan): mixed into the hashes once one applied */
  private updateHash = 0;
  /** recent hits (for the check-in status, #9): tick, attacker, victim, damage, weapon */
  readonly hitLog: { tick: number; by: number; target: number; damage: number; weapon: string }[] = [];

  constructor(
    readonly seed: number,
    recorded?: Strategy[],
    readonly opts: FightOptions = {},
    updates: readonly PlanUpdate[] = [],
  ) {
    const botRng = new Rng((seed ^ 0x5bd1e995) >>> 0);
    this.strategies = recorded ? recorded.map((s) => ({ ...s, weapons: (s.weapons ?? []).slice(), ...(s.build ? { build: { ...s.build } } : {}) })) : [0, 1, 2, 3].map(() => neutralStrategy(botRng));
    // the build is the body for the whole round (#79): set here, never by a plan update
    this.sim = new Sim(seed, opts.level, opts.looks ?? SEAT_LOOKS, opts.ruleset, this.strategies.map((s) => s.build));
    this.controllers = this.sim.fighters.map((f) => {
      const m = opts.morale?.[f.id];
      const k = m && !opts.noMoraleEffect ? this.sim.ruleset.morale.aim[m].aim : 1;
      return new Controller(f.id, this.sim.ruleset.tactics.aimNoise * k);
    });
    for (const [i, c] of this.controllers.entries()) {
      c.peers = this.controllers;
      c.setStrategy(this.strategies[i]!, this.sim);
    }
    this.record = { ...(opts.embedRuleset !== false ? { ruleset: this.sim.ruleset } : {}), seed, level: { theme: this.sim.level.theme, attempt: this.sim.level.attempt, width: this.sim.level.width }, strategies: this.strategies.map((s) => ({ ...s, ...(s.build ? { build: { ...s.build } } : {}) })), updates: this.updates, checkpoints: [], finalHash: "", ticks: 0 };
    for (const u of updates) this.addUpdate(u);
  }

  /** The plan updates of this fight, in the order they apply. */
  get planUpdates(): readonly PlanUpdate[] {
    return this.updates;
  }

  /**
   * Schedule a plan update. Its tick must not have passed (a tick equal to
   * the current one applies at the next step). Kept sorted by tick, then
   * fighter; updates with the same tick and fighter apply in the order added.
   */
  addUpdate(u: PlanUpdate) {
    if (!Number.isInteger(u.tick) || u.tick < this.sim.tick) throw new Error(`plan update at tick ${u.tick}: the fight is already at tick ${this.sim.tick}`);
    if (!Number.isInteger(u.fighter) || u.fighter < 0 || u.fighter >= this.controllers.length) throw new Error(`plan update for fighter ${u.fighter}: no such fighter`);
    const copy: PlanUpdate = { ...u, strategy: { ...u.strategy, weapons: (u.strategy.weapons ?? []).slice(), ...(u.strategy.rules ? { rules: u.strategy.rules.map((r) => ({ ...r })) } : {}) } };
    let i = this.updates.length;
    while (i > this.nextUpdate && (this.updates[i - 1]!.tick > u.tick || (this.updates[i - 1]!.tick === u.tick && this.updates[i - 1]!.fighter > u.fighter))) i--;
    this.updates.splice(i, 0, copy);
  }

  private applyUpdates() {
    const sim = this.sim;
    while (this.nextUpdate < this.updates.length && this.updates[this.nextUpdate]!.tick <= sim.tick) {
      const u = this.updates[this.nextUpdate++]!;
      this.controllers[u.fighter]!.setStrategy(u.strategy, sim);
      let h = this.updateHash || 0x811c9dc5;
      for (const ch of `${u.tick}:${u.fighter}:${planKey(u.strategy)};`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
      this.updateHash = h || 1;
      this.onEvent?.({ type: "plan", tick: u.tick, fighter: u.fighter });
    }
  }

  /** The state hash: the sim's, plus the applied plan updates once there are any (no updates: exactly the sim's). */
  hash(): string {
    const h = this.sim.hash();
    if (!this.updateHash) return h;
    let x = this.updateHash;
    for (const ch of h) x = Math.imul(x ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    return x.toString(16).padStart(8, "0");
  }

  /** One physics tick of the fight. Returns true once the fight is over. */
  step(): boolean {
    if (this.over) return true;
    const sim = this.sim;
    if (this.nextUpdate < this.updates.length) this.applyUpdates();
    const inputs = this.controllers.map((c) => c.think(sim));
    sim.step(inputs);
    this.drain();
    if (sim.tick % CHECKPOINT_TICKS === 0) this.record.checkpoints.push(this.hash());
    if (sim.tick % SAMPLE_TICKS === 0)
      this.stats.sample(
        sim.fighters.map((f) => (f.alive && !f.removed ? sim.pos(f) : null)),
        this.controllers.map((c, i) => (sim.fighters[i]!.alive ? c.targetId : -1)),
        // stance time counts while armed (an unarmed fighter of any stance is out hunting a weapon)
        this.controllers.map((c, i) => (sim.fighters[i]!.alive && !sim.fighters[i]!.removed && sim.fighters[i]!.weapons.some((w) => w !== "fist") ? c.stanceNow(sim) : "")),
        sim.fighters.map((f) => inCover(sim, f)),
      );
    if (this.finishLeft < 0 && sim.alive().length <= 1) {
      this.finishLeft = sim.ruleset.round.finishTicks;
      sim.roundOver = true; // the walls stop and nothing more drops: the winner celebrates
    }
    if (this.finishLeft > 0) this.finishLeft--;
    if (this.finishLeft === 0 || sim.tick >= sim.ruleset.round.fightTicks) {
      this.over = true;
      this.record.ticks = sim.tick;
      this.record.finalHash = this.hash();
    }
    return this.over;
  }

  /**
   * After the fight: keep the world moving with no inputs, for the viewer's
   * celebrate screen. Does not touch the record.
   */
  stepAfterglow() {
    this.sim.step([NO_INPUT, NO_INPUT, NO_INPUT, NO_INPUT]);
    this.sim.events = [];
  }

  private drain() {
    const evs = this.sim.events;
    if (evs.length === 0) return;
    for (const e of evs) {
      // events that can change a rule trigger: re-evaluate rules on the next tick
      if (e.type === "pickup" || e.type === "hit" || e.type === "ko") for (const c of this.controllers) c.rules.dirty = true;
      if (e.type === "ko") this.koLog.push({ fighter: e.fighter, by: e.by, cause: e.cause, weapon: e.weapon, tick: e.tick, ...(e.by >= 0 && e.by !== e.fighter && this.lastHit[e.fighter]!.by === e.by ? { range: Math.round(this.lastHit[e.fighter]!.dist * 10) / 10 } : {}) });
      else if (e.type === "pickup") this.stats.pickup(e.fighter, e.item, e.tick);
      else if (e.type === "rule") this.stats.rule(e.fighter, e.rule, e.on, e.tick);
      else if (e.type === "hit") {
        if (e.source >= 0 && e.source !== e.target) {
          const a = this.sim.fighters[e.source]!;
          const v = this.sim.fighters[e.target]!;
          if (!a.removed && !v.removed) {
            const ap = this.sim.pos(a);
            const vp = this.sim.pos(v);
            const behind = v.facing * (ap.x - vp.x) < 0;
            const dist = Math.sqrt((ap.x - vp.x) * (ap.x - vp.x) + (ap.y - vp.y) * (ap.y - vp.y));
            this.stats.hit(e.source, e.target, e.damage, e.cause, dist, behind, e.tick);
            this.lastHit[e.target] = { by: e.source, dist };
            this.hitLog.push({ tick: e.tick, by: e.source, target: e.target, damage: e.damage, weapon: e.cause });
            this.controllers[e.target]!.onHit(e.source, behind, e.damage, e.tick, this.sim.ruleset);
            this.controllers[e.source]!.onDealt(e.tick);
          }
        }
        if (e.source === e.target && (e.cause === "rocket" || e.cause === "grenade")) this.selfHit[e.target]! += e.damage;
        if (e.cause === "crush") this.crushed[e.target]! += e.damage;
        if (e.source >= 0 && e.source !== e.target && (!this.biggest || e.kb > this.biggest.kb)) this.biggest = { by: e.source, target: e.target, kb: e.kb, weapon: e.cause };
      } else if (e.type === "explosion" && e.depth >= 1) this.chains++;
      this.onEvent?.(e);
    }
    this.sim.events = [];
  }

  /** What happened this round, for morale and dialogue. */
  facts(round: number): RoundFacts {
    const r = this.result();
    const sim = this.sim;
    const fighters: FighterRoundFacts[] = sim.fighters.map((f) => {
      const ko = this.koLog.find((k) => k.fighter === f.id) ?? null;
      const humiliations: { kind: HumiliationKind; by: number }[] = [];
      if (this.selfHit[f.id]! >= 6) humiliations.push({ kind: "own-explosive", by: f.id });
      if (ko && ko.cause === "ringout" && ko.weapon === "bat") humiliations.push({ kind: "bat-ringout", by: ko.by });
      if (ko && ko.cause === "ringout" && ko.weapon === "grapple") humiliations.push({ kind: "hook-ringout", by: ko.by });
      if ((ko && ko.weapon === "crush") || this.crushed[f.id]! >= 8) humiliations.push({ kind: "crushed", by: ko?.by ?? -1 });
      if (ko && (ko.weapon === "barrel" || ko.weapon === "tnt" || ko.weapon === "gas")) humiliations.push({ kind: "barrel", by: ko.by });
      return {
        id: f.id,
        won: r.winner === f.id,
        survived: f.alive,
        hpEnd: f.alive ? f.hp : 0,
        outOrder: ko ? this.koLog.indexOf(ko) + 1 : 0,
        kosDealt: this.koLog.filter((k) => k.by === f.id && k.fighter !== f.id).map((k) => ({ victim: k.fighter, weapon: k.weapon, cause: k.cause })),
        koBy: ko ? { by: ko.by, weapon: ko.weapon, cause: ko.cause } : null,
        damageDealt: f.damageDealt,
        damageTaken: f.damageTaken,
        humiliations,
      };
    });
    return {
      round,
      winner: r.winner,
      reason: r.reason,
      seconds: r.ticks / TICK_RATE,
      fighters,
      chainReactions: this.chains,
      platformsFallen: sim.stats.platformsFallen,
      biggestHit: this.biggest,
      stats: this.stats.finish(
        this.koLog.map((k) => ({ victim: k.fighter, by: k.by, weapon: k.weapon, cause: k.cause, tick: k.tick, ...(k.range !== undefined ? { range: k.range } : {}) })),
        this.sim.fighters.map((f) => f.name),
        this.controllers.map((c) => c.reflexLog.map((x) => ({ ...x }))),
        this.strategies.map((s) => s.rules?.length ?? 0),
        this.sim.tick,
      ),
    };
  }

  playToEnd(): void {
    while (!this.step()) {
      /* step */
    }
  }

  result(): FightResult {
    const sim = this.sim;
    const alive = sim.alive();
    let winner: number;
    let reason: FightResult["reason"];
    if (alive.length === 1) {
      winner = alive[0]!.id;
      reason = "last-standing";
    } else if (alive.length > 1) {
      // time-out: most health, then most damage dealt
      winner = alive.reduce((a, b) => (b.hp > a.hp + 1e-9 || (Math.abs(b.hp - a.hp) <= 1e-9 && b.damageDealt > a.damageDealt) ? b : a)).id;
      reason = "time-out";
    } else {
      winner = sim.fighters.reduce((a, b) => (b.koTick > a.koTick || (b.koTick === a.koTick && b.damageDealt > a.damageDealt) ? b : a)).id;
      reason = "double-ko";
    }
    return {
      winner,
      reason,
      ticks: sim.tick,
      kos: sim.fighters.map((f) => f.kos),
      damage: sim.fighters.map((f) => f.damageDealt),
      survivors: alive.map((f) => f.id),
      koLog: this.koLog.slice(),
    };
  }
}

/**
 * Replay a record from its seed, strategies and plan updates. A replay that does not reach the recorded final hash
 * throws FightDivergedError: a different hash is never returned as if it were the record's.
 */
export function replayFight(record: FightRecord): { finalHash: string; checkpoints: string[]; match: Fight } {
  const m = new Fight(record.seed, record.strategies, { ruleset: resolveRuleset(record.ruleset) }, record.updates);
  m.playToEnd();
  if (record.finalHash && m.record.finalHash !== record.finalHash) {
    const at = record.checkpoints.findIndex((h, i) => m.record.checkpoints[i] !== h);
    // checkpoint i is taken at tick (i + 1) * CHECKPOINT_TICKS: the state went wrong after the one before it
    throw new FightDivergedError(at < 0 ? null : [at * CHECKPOINT_TICKS, (at + 1) * CHECKPOINT_TICKS]);
  }
  return { finalHash: m.record.finalHash, checkpoints: m.record.checkpoints, match: m };
}

/** A fight record that does not replay to its recorded final hash (a changed sim, or a damaged record). */
export class FightDivergedError extends Error {
  /** the ticks between which the state first differs (null: only the final state differs) */
  constructor(readonly ticks: [number, number] | null) {
    super(`this fight record does not replay: ${ticks === null ? "the final state differs" : `the state first differs between ticks ${ticks[0]} and ${ticks[1]}`} (made before a sim change, or damaged)`);
  }
}
