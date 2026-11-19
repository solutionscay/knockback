/**
 * A match is one continuous fight. Before it starts, each fighter picks one
 * strategy (house bots now). Then the controllers play the whole brawl out;
 * the shrinking zone forces contact. Ends with one fighter left, or at time-out.
 *
 * A MatchRecord (seed + strategies) replays to the same state hash.
 */
import { chooseStrategy } from "./bots";
import { FIGHT_TICKS, FINISH_TICKS, TICK_RATE } from "./constants";
import { AIM_NOISE, Controller } from "./controller";
import { Rng } from "./rng";
import { NO_INPUT, Sim, type SimEvent, type Strategy } from "./sim";

export interface MatchRecord {
  version: 2;
  seed: number;
  strategies: Strategy[];
  /** State hash every CHECKPOINT_TICKS, for pinpointing a divergence. */
  checkpoints: string[];
  finalHash: string;
  ticks: number;
}

export const CHECKPOINT_TICKS = 10 * TICK_RATE;

export interface MatchResult {
  winner: number;
  /** How the winner was decided. */
  reason: "last-standing" | "time-out" | "double-ko";
  ticks: number;
  kos: number[]; // knockouts credited per fighter
  damage: number[];
  survivors: number[];
  /** Knockouts in order. */
  koLog: { fighter: number; by: number; cause: "ringout" | "hp"; tick: number }[];
}

export class Match {
  readonly sim: Sim;
  readonly controllers: Controller[];
  readonly strategies: Strategy[];
  readonly record: MatchRecord;
  private finishLeft = -1;
  over = false;
  private koLog: MatchResult["koLog"] = [];
  /** Optional event sink (the viewer and stats use it). */
  onEvent: ((e: SimEvent) => void) | null = null;

  constructor(
    readonly seed: number,
    recorded?: Strategy[],
  ) {
    this.sim = new Sim(seed);
    const botRng = new Rng((seed ^ 0x5bd1e995) >>> 0);
    this.strategies = recorded ? recorded.map((s) => ({ ...s })) : this.sim.fighters.map((f) => chooseStrategy(f, botRng));
    this.controllers = this.sim.fighters.map((f) => new Controller(f.id, AIM_NOISE[f.personality]));
    for (const [i, c] of this.controllers.entries()) {
      c.peers = this.controllers;
      c.setStrategy(this.strategies[i]!, this.sim);
    }
    this.record = { version: 2, seed, strategies: this.strategies.map((s) => ({ ...s })), checkpoints: [], finalHash: "", ticks: 0 };
  }

  /** One physics tick of the fight. Returns true once the fight is over. */
  step(): boolean {
    if (this.over) return true;
    const sim = this.sim;
    const inputs = this.controllers.map((c) => c.think(sim));
    sim.step(inputs);
    this.drain();
    if (sim.tick % CHECKPOINT_TICKS === 0) this.record.checkpoints.push(sim.hash());
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
      if (e.type === "ko") this.koLog.push({ fighter: e.fighter, by: e.by, cause: e.cause, tick: e.tick });
      this.onEvent?.(e);
    }
    this.sim.events = [];
  }

  playToEnd(): void {
    while (!this.step()) {
      /* step */
    }
  }

  result(): MatchResult {
    const sim = this.sim;
    const alive = sim.alive();
    let winner: number;
    let reason: MatchResult["reason"];
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
export function replay(record: MatchRecord): { finalHash: string; checkpoints: string[]; match: Match } {
  const m = new Match(record.seed, record.strategies);
  m.playToEnd();
  return { finalHash: m.record.finalHash, checkpoints: m.record.checkpoints, match: m };
}
