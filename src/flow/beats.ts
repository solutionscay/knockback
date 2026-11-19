/**
 * The match loop as data: a sequence of beats. Pure (no DOM, no Pixi), so the
 * look can change without touching the flow, and the flow can be tested.
 *
 *   level card -> intro x4 (BLAM) -> 3 2 1 FIGHT! -> fight (open-ended) -> end -> celebrate
 */

export type Beat =
  | { kind: "level"; duration: number } // the generated arena: theme name, camera over the whole map
  | { kind: "intro"; fighter: number; duration: number }
  | { kind: "countdown"; value: 3 | 2 | 1; duration: number }
  | { kind: "go"; duration: number } // "FIGHT!" — the fight is already running
  | { kind: "fight"; duration: null } // until the sim says the fight is over
  | { kind: "end"; duration: number } // final K.O. / time-out callout
  | { kind: "celebrate"; duration: number }; // winner + scores + tally

/** Which beats run the physics. */
export function simRuns(b: Beat): "fight" | "afterglow" | "frozen" {
  if (b.kind === "go" || b.kind === "fight") return "fight";
  if (b.kind === "end" || b.kind === "celebrate") return "afterglow";
  return "frozen";
}

export interface BeatTiming {
  level: number;
  intro: number;
  count: number;
  go: number;
  end: number;
  celebrate: number;
}

export const DEFAULT_TIMING: BeatTiming = { level: 2.4, intro: 2.4, count: 0.75, go: 0.9, end: 2.2, celebrate: 9 };

export function matchBeats(fighters: number, t: BeatTiming = DEFAULT_TIMING): Beat[] {
  const beats: Beat[] = [{ kind: "level", duration: t.level }];
  for (let i = 0; i < fighters; i++) beats.push({ kind: "intro", fighter: i, duration: t.intro });
  beats.push({ kind: "countdown", value: 3, duration: t.count });
  beats.push({ kind: "countdown", value: 2, duration: t.count });
  beats.push({ kind: "countdown", value: 1, duration: t.count });
  beats.push({ kind: "go", duration: t.go });
  beats.push({ kind: "fight", duration: null });
  beats.push({ kind: "end", duration: t.end });
  beats.push({ kind: "celebrate", duration: t.celebrate });
  return beats;
}

/**
 * Walks the beats. `fightOver` closes the open-ended fight beat. The "go" beat
 * also closes early if the fight ends during it. Calls onEnter for each beat.
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

  /** 0..1 through the current beat (0 for the open-ended fight). */
  get progress(): number {
    const d = this.beat.duration;
    return d ? Math.min(1, this.t / d) : 0;
  }

  update(dt: number, fightOver: boolean) {
    if (this.done) return;
    this.t += dt;
    for (let guard = 0; guard < this.beats.length; guard++) {
      const b = this.beat;
      const finished = b.duration === null ? fightOver : this.t >= b.duration || (b.kind === "go" && fightOver);
      if (!finished) return;
      if (this.index === this.beats.length - 1) {
        this.done = true;
        return;
      }
      this.t = b.duration === null ? 0 : Math.max(0, this.t - b.duration);
      this.index++;
      this.onEnter(this.beat, this.index);
    }
  }
}
