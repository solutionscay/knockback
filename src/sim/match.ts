/**
 * Match flow (WEGO): each round, every fighter gets an order at the same time,
 * then ROUND_TICKS of physics play out. 7 rounds, shrinking safe zone.
 *
 * A MatchRecord (seed + orders per round) replays to the same state hash.
 */
import { decideOrder } from "./bots";
import { FINISH_TICKS, ROUNDS, ROUND_TICKS } from "./constants";
import { AIM_NOISE, Controller } from "./controller";
import { Rng } from "./rng";
import { Sim, type Order, type SimEvent } from "./sim";

export interface MatchRecord {
  version: 1;
  seed: number;
  rounds: Order[][];
  roundHashes: string[];
  finalHash: string;
}

export interface RoundSummary {
  round: number;
  damage: number[]; // damage dealt this round per fighter
  taken: number[];
  kos: { fighter: number; by: number; cause: string }[];
}

export type Phase = "idle" | "action" | "over";

export class Match {
  readonly sim: Sim;
  readonly controllers: Controller[];
  readonly botRng: Rng;
  readonly record: MatchRecord;
  round = 0;
  phase: Phase = "idle";
  roundTick = 0;
  orders: Order[] = [];
  private finishLeft = -1;
  private roundStartDealt: number[] = [];
  private roundStartTaken: number[] = [];
  private roundKos: RoundSummary["kos"] = [];
  summaries: RoundSummary[] = [];
  /** Optional event sink (the viewer and stats use it). */
  onEvent: ((e: SimEvent) => void) | null = null;

  constructor(
    readonly seed: number,
    private readonly recorded?: Order[][],
  ) {
    this.sim = new Sim(seed);
    this.botRng = new Rng((seed ^ 0x5bd1e995) >>> 0);
    this.controllers = this.sim.fighters.map((f) => new Controller(f.id, AIM_NOISE[f.personality]));
    this.record = { version: 1, seed, rounds: [], roundHashes: [], finalHash: "" };
  }

  get over(): boolean {
    return this.phase === "over";
  }

  /** Planning beat: decide (or load) orders and lock them. */
  startRound(): Order[] {
    if (this.phase === "over") throw new Error("match is over");
    this.round++;
    const sim = this.sim;
    sim.beginRound(this.round);
    let orders: Order[];
    if (this.recorded) {
      const r = this.recorded[this.round - 1];
      if (!r) throw new Error(`record has no orders for round ${this.round}`);
      orders = r.map((o) => ({ ...o }));
    } else {
      orders = sim.fighters.map((f) =>
        f.alive ? decideOrder(sim, f, this.botRng) : { target: f.id, weapon: "rocket" as const, stance: "distance" as const },
      );
    }
    this.orders = orders;
    this.record.rounds.push(orders.map((o) => ({ ...o })));
    orders.forEach((o, i) => this.controllers[i]!.setOrder(o, sim));
    this.roundTick = 0;
    this.finishLeft = -1;
    this.roundStartDealt = sim.fighters.map((f) => f.damageDealt);
    this.roundStartTaken = sim.fighters.map((f) => f.damageTaken);
    this.roundKos = [];
    this.phase = "action";
    this.drain();
    return orders;
  }

  /** One physics tick. Returns true when the round is finished. */
  stepAction(): boolean {
    if (this.phase !== "action") return true;
    const sim = this.sim;
    const inputs = this.controllers.map((c) => c.think(sim));
    sim.step(inputs);
    this.roundTick++;
    this.drain();
    if (this.finishLeft < 0 && sim.alive().length <= 1) this.finishLeft = FINISH_TICKS;
    if (this.finishLeft > 0) this.finishLeft--;
    return this.roundTick >= ROUND_TICKS || this.finishLeft === 0;
  }

  private drain() {
    const evs = this.sim.events;
    if (evs.length === 0) return;
    for (const e of evs) {
      if (e.type === "ko") this.roundKos.push({ fighter: e.fighter, by: e.by, cause: e.cause });
      this.onEvent?.(e);
    }
    this.sim.events = [];
  }

  endRound(): RoundSummary {
    const sim = this.sim;
    const s: RoundSummary = {
      round: this.round,
      damage: sim.fighters.map((f, i) => f.damageDealt - this.roundStartDealt[i]!),
      taken: sim.fighters.map((f, i) => f.damageTaken - this.roundStartTaken[i]!),
      kos: this.roundKos,
    };
    this.summaries.push(s);
    this.record.roundHashes.push(sim.hash());
    if (sim.alive().length <= 1 || this.round >= ROUNDS) {
      this.phase = "over";
      this.record.finalHash = this.record.roundHashes[this.record.roundHashes.length - 1]!;
    } else {
      this.phase = "idle";
    }
    return s;
  }

  /** Last standing; else most damage dealt among survivors; else last to fall. */
  winner(): number {
    const sim = this.sim;
    const alive = sim.alive();
    if (alive.length === 1) return alive[0]!.id;
    if (alive.length > 1) {
      return alive.reduce((a, b) => (b.damageDealt > a.damageDealt ? b : a)).id;
    }
    return sim.fighters.reduce((a, b) => (b.koTick > a.koTick || (b.koTick === a.koTick && b.damageDealt > a.damageDealt) ? b : a)).id;
  }

  /** Run a whole round headless. */
  playRound(): RoundSummary {
    this.startRound();
    while (!this.stepAction()) {
      /* step */
    }
    return this.endRound();
  }

  playToEnd(): void {
    while (!this.over) this.playRound();
  }
}

/** Replay a record and return the final hash plus per-round hashes. */
export function replay(record: MatchRecord): { finalHash: string; roundHashes: string[]; match: Match } {
  const m = new Match(record.seed, record.rounds);
  while (!m.over && m.round < record.rounds.length) m.playRound();
  return { finalHash: m.record.finalHash || m.record.roundHashes.at(-1)!, roundHashes: m.record.roundHashes, match: m };
}
