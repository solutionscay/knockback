/**
 * A fight is one round: one continuous brawl. Each fighter has one strategy
 * for it; the controllers play the whole brawl out and the shrinking zone
 * forces contact. Ends with one fighter left, or at time-out.
 * (match.ts runs best of 3 of these.)
 *
 * A FightRecord (seed + strategies) replays to the same state hash.
 */
import { neutralStrategy } from "./bots";
import { FIGHT_TICKS, FINISH_TICKS, TICK_RATE } from "./constants";
import { AIM_NOISE, Controller } from "./controller";
import type { LevelDef } from "./levelgen";
import { MORALE_EFFECT, type FighterRoundFacts, type HumiliationKind, type MoraleState, type RoundFacts } from "./morale";
import { Rng } from "./rng";
import { SAMPLE_TICKS, StatsCollector } from "./roundstats";
import { NO_INPUT, SEAT_LOOKS, Sim, type Look, type SimEvent, type Strategy } from "./sim";

export interface FightOptions {
  /** Level to fight on (default: generated from the seed). Rounds of a match share one. */
  level?: LevelDef;
  /** Morale at the start of this round, per fighter (nudges aim; see morale.ts). */
  morale?: MoraleState[];
  /** Turn morale's behavior nudges off (for A/B stats). */
  noMoraleEffect?: boolean;
  /** Names/colors from the souls (cosmetic: never affects the fight). */
  looks?: Look[];
}

export interface FightRecord {
  version: 4;
  /** The seed makes the level too (levelgen.ts); theme/attempt are informational. */
  seed: number;
  level: { theme: string; attempt: number; width: number };
  strategies: Strategy[];
  /** State hash every CHECKPOINT_TICKS, for pinpointing a divergence. */
  checkpoints: string[];
  finalHash: string;
  ticks: number;
}

export const CHECKPOINT_TICKS = 10 * TICK_RATE;

export interface FightResult {
  winner: number;
  /** How the winner was decided. */
  reason: "last-standing" | "time-out" | "double-ko";
  ticks: number;
  kos: number[]; // knockouts credited per fighter
  damage: number[];
  survivors: number[];
  /** Knockouts in order. */
  koLog: { fighter: number; by: number; cause: "ringout" | "hp"; weapon: string; tick: number }[];
}

export class Fight {
  readonly sim: Sim;
  readonly controllers: Controller[];
  readonly strategies: Strategy[];
  readonly record: FightRecord;
  private finishLeft = -1;
  over = false;
  private koLog: FightResult["koLog"] = [];
  // facts for morale and dialogue
  private selfHit = [0, 0, 0, 0];
  private crushed = [0, 0, 0, 0];
  private biggest: RoundFacts["biggestHit"] = null;
  private chains = 0;
  readonly stats = new StatsCollector();
  /** Optional event sink (the viewer and stats use it). */
  onEvent: ((e: SimEvent) => void) | null = null;

  constructor(
    readonly seed: number,
    recorded?: Strategy[],
    readonly opts: FightOptions = {},
  ) {
    this.sim = new Sim(seed, opts.level, opts.looks ?? SEAT_LOOKS);
    const botRng = new Rng((seed ^ 0x5bd1e995) >>> 0);
    this.strategies = recorded ? recorded.map((s) => ({ ...s, weapons: (s.weapons ?? []).slice() })) : this.sim.fighters.map(() => neutralStrategy(botRng));
    this.controllers = this.sim.fighters.map((f) => {
      const m = opts.morale?.[f.id];
      const k = m && !opts.noMoraleEffect ? MORALE_EFFECT[m].aim : 1;
      return new Controller(f.id, AIM_NOISE * k);
    });
    for (const [i, c] of this.controllers.entries()) {
      c.peers = this.controllers;
      c.setStrategy(this.strategies[i]!, this.sim);
    }
    this.record = { version: 4, seed, level: { theme: this.sim.level.theme, attempt: this.sim.level.attempt, width: this.sim.level.width }, strategies: this.strategies.map((s) => ({ ...s })), checkpoints: [], finalHash: "", ticks: 0 };
  }

  /** One physics tick of the fight. Returns true once the fight is over. */
  step(): boolean {
    if (this.over) return true;
    const sim = this.sim;
    const inputs = this.controllers.map((c) => c.think(sim));
    sim.step(inputs);
    this.drain();
    if (sim.tick % CHECKPOINT_TICKS === 0) this.record.checkpoints.push(sim.hash());
    if (sim.tick % SAMPLE_TICKS === 0)
      this.stats.sample(
        sim.fighters.map((f) => (f.alive && !f.removed ? sim.pos(f) : null)),
        this.controllers.map((c, i) => (sim.fighters[i]!.alive ? c.targetId : -1)),
      );
    if (this.finishLeft < 0 && sim.alive().length <= 1) this.finishLeft = FINISH_TICKS;
    if (this.finishLeft > 0) this.finishLeft--;
    if (this.finishLeft === 0 || sim.tick >= FIGHT_TICKS) {
      this.over = true;
      this.record.ticks = sim.tick;
      this.record.finalHash = sim.hash();
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
      if (e.type === "ko") this.koLog.push({ fighter: e.fighter, by: e.by, cause: e.cause, weapon: e.weapon, tick: e.tick });
      else if (e.type === "pickup") this.stats.pickups[e.fighter]!.push(e.item);
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
            this.controllers[e.target]!.onHit(e.source, behind, e.damage, e.tick);
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
      stats: this.stats.finish(this.koLog.map((k) => ({ victim: k.fighter, by: k.by, weapon: k.weapon, cause: k.cause })), this.sim.fighters.map((f) => f.name)),
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

/** Replay a record from its seed and strategies. */
export function replayFight(record: FightRecord): { finalHash: string; checkpoints: string[]; match: Fight } {
  const m = new Fight(record.seed, record.strategies);
  m.playToEnd();
  return { finalHash: m.record.finalHash, checkpoints: m.record.checkpoints, match: m };
}
