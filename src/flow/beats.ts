/**
 * The match loop as data: beats. Pure (no DOM, no Pixi), so the look can
 * change without touching the flow, and the flow can be tested.
 *
 *   level card -> intro lines (one fighter at a time) -> round 1
 *   round = 3 2 1 FIGHT! -> fight (open-ended) -> round result
 *   after a round: between-round lines -> next round ... or -> celebrate
 *
 * The beat list grows as the match unfolds: after each round result the game
 * appends either betweenBeats() + roundBeats() or closingBeats().
 */

export type Beat =
  | { kind: "level"; duration: number } // the generated arena, seen whole
  | { kind: "dialogue"; fighter: number; phase: "intro" | "between"; round: number; duration: number } // one fighter speaks
  | { kind: "countdown"; value: 3 | 2 | 1; round: number; duration: number }
  | { kind: "go"; round: number; duration: number } // "FIGHT!" — the fight is already running
  | { kind: "fight"; round: number; duration: null } // until the sim says the round is over
  | { kind: "roundEnd"; round: number; duration: number } // round result callout
  | { kind: "celebrate"; duration: number }; // match winner + scores + tally

/** Which beats run the physics. */
export function simRuns(b: Beat): "fight" | "afterglow" | "frozen" {
  if (b.kind === "go" || b.kind === "fight") return "fight";
  if (b.kind === "roundEnd" || b.kind === "celebrate") return "afterglow";
  return "frozen";
}

export interface BeatTiming {
  level: number;
  count: number;
  go: number;
  roundEnd: number;
  celebrate: number;
  /** dialogue read time: base + per character, never below min */
  readBase: number;
  readPerChar: number;
  readMin: number;
}

export const DEFAULT_TIMING: BeatTiming = { level: 2.4, count: 0.75, go: 0.9, roundEnd: 4.5, celebrate: 9, readBase: 1.1, readPerChar: 0.045, readMin: 2.6 };

export function readTime(line: string, t: BeatTiming = DEFAULT_TIMING): number {
  return Math.max(t.readMin, t.readBase + line.length * t.readPerChar);
}

/** Level card, then each fighter's intro line in the given order. */
export function openingBeats(order: number[], lines: string[], t: BeatTiming = DEFAULT_TIMING): Beat[] {
  return [{ kind: "level", duration: t.level }, ...order.map((f) => ({ kind: "dialogue" as const, fighter: f, phase: "intro" as const, round: 1, duration: readTime(lines[f]!, t) }))];
}

/** Between rounds: each fighter speaks, in the given order. */
export function betweenBeats(order: number[], lines: string[], round: number, t: BeatTiming = DEFAULT_TIMING): Beat[] {
  return order.map((f) => ({ kind: "dialogue" as const, fighter: f, phase: "between" as const, round, duration: readTime(lines[f]!, t) }));
}

/** One round: countdown, FIGHT!, the fight, the result. */
export function roundBeats(round: number, t: BeatTiming = DEFAULT_TIMING): Beat[] {
  return [
    { kind: "countdown", value: 3, round, duration: t.count },
    { kind: "countdown", value: 2, round, duration: t.count },
    { kind: "countdown", value: 1, round, duration: t.count },
    { kind: "go", round, duration: t.go },
    { kind: "fight", round, duration: null },
    { kind: "roundEnd", round, duration: t.roundEnd },
  ];
}

export function closingBeats(t: BeatTiming = DEFAULT_TIMING): Beat[] {
  return [{ kind: "celebrate", duration: t.celebrate }];
}

/**
 * Speaking order between rounds, building to the winner: whoever went out
 * first speaks first, then the other knocked-out fighters in the order they
 * fell, then survivors who did not win, and the round winner gets the last word.
 */
export function betweenOrder(winner: number, outOrder: number[]): number[] {
  const ids = outOrder.map((_, i) => i).filter((i) => i !== winner);
  ids.sort((a, b) => {
    const oa = outOrder[a]! || 99;
    const ob = outOrder[b]! || 99;
    return oa - ob || a - b;
  });
  return [...ids, winner];
}

/** Intro order: the most nervous first, the cockiest last (by morale score). */
export function introOrder(scores: number[]): number[] {
  return scores.map((_, i) => i).sort((a, b) => scores[a]! - scores[b]! || a - b);
}

/**
 * Walks the beats. `fightOver` closes the open-ended fight beat (and the
 * FIGHT! beat if the round ends during it). onEnter fires for each beat;
 * append() extends the list while running; skip() ends the current beat.
 */
export class FlowRunner {
  index = 0;
  t = 0;
  done = false;

  constructor(
    readonly beats: Beat[],
    private readonly onEnter: (b: Beat, index: number) => void = () => {},
  ) {
    onEnter(beats[0]!, 0);
  }

  get beat(): Beat {
    return this.beats[this.index]!;
  }

  get progress(): number {
    const d = this.beat.duration;
    return d ? Math.min(1, this.t / d) : 0;
  }

  append(more: Beat[]) {
    this.beats.push(...more);
    if (this.done && more.length) {
      this.done = false;
      this.advance();
    }
  }

  /** End the current beat now (tap/space on a dialogue frame). */
  skip() {
    if (this.done || this.beat.duration === null) return;
    this.t = this.beat.duration;
  }

  /** Skip every following beat that matches (e.g. "skip all dialogue"). */
  skipWhile(pred: (b: Beat) => boolean) {
    while (!this.done && pred(this.beat)) {
      if (this.index === this.beats.length - 1) {
        this.done = true;
        return;
      }
      this.t = 0;
      this.index++;
      this.onEnter(this.beat, this.index);
    }
  }

  private advance() {
    this.t = 0;
    this.index++;
    this.onEnter(this.beat, this.index);
  }

  update(dt: number, fightOver: boolean) {
    if (this.done) return;
    this.t += dt;
    for (let guard = 0; guard < this.beats.length + 1; guard++) {
      const b = this.beat;
      const finished = b.duration === null ? fightOver : this.t >= b.duration || (b.kind === "go" && fightOver);
      if (!finished) return;
      if (this.index === this.beats.length - 1) {
        this.done = true;
        return;
      }
      const carry = b.duration === null ? 0 : Math.max(0, this.t - b.duration);
      this.advance();
      this.t = carry;
    }
  }
}
