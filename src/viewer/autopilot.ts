/**
 * Autopilot in the viewer (#22): the server's control events (an agent
 * dropped and the house bot took its fighter, or the agent came back) shown
 * at the moment they happened in the match: the callout fires when the
 * viewer reaches the event's round and fight tick, so a live match and its
 * replay show it at the same place. While a fighter is on autopilot its chip
 * says AUTOPILOT and its visor shows the sleepy "..." face.
 */
import { CLASSIC } from "../sim/ruleset";
import type { Beat } from "../flow/beats";

export interface ControlView {
  seat: number;
  mode: "autopilot" | "agent";
  round: number;
  phase: "plan" | "fight" | "roundEnd" | "checkin";
  tick: number | null;
  line: string;
  fromRound?: number;
}

const PHASES = ["plan", "fight", "roundEnd", "checkin"];

/** Control events from the live stream or a record: checked, trimmed, at most 64. */
export function sanitizeControl(raw: unknown, maxRounds = CLASSIC.round.maxRounds): ControlView[] {
  if (!Array.isArray(raw)) return [];
  const out: ControlView[] = [];
  for (const e of raw.slice(0, 64)) {
    const v = sanitizeOne(e, maxRounds);
    if (v) out.push(v);
  }
  return out;
}

export function sanitizeOne(e: unknown, maxRounds = CLASSIC.round.maxRounds): ControlView | null {
  if (!e || typeof e !== "object") return null;
  const o = e as Record<string, unknown>;
  const int = (v: unknown, lo: number, hi: number) => (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? (v as number) : null);
  const seat = int(o.seat, 0, 3);
  const round = int(o.round, 1, maxRounds);
  if (seat === null || round === null || (o.mode !== "autopilot" && o.mode !== "agent") || !PHASES.includes(o.phase as string)) return null;
  const tick = o.tick === null || o.tick === undefined ? null : int(o.tick, 0, 1e7);
  const from = int(o.fromRound, 1, maxRounds + 1);
  return { seat, mode: o.mode, round, phase: o.phase as ControlView["phase"], tick, line: typeof o.line === "string" ? o.line.slice(0, 140) : "", ...(from !== null ? { fromRound: from } : {}) };
}

const FIGHTING: Beat["kind"][] = ["go", "fight", "roundEnd", "celebrate"];

export class AutopilotTrack {
  private pending: ControlView[] = [];
  /** fighters the house bot drives right now */
  readonly on = [false, false, false, false];
  /** a fighter whose agent is back gets control at this round */
  private backFrom: (number | null)[] = [null, null, null, null];

  reset(events: ControlView[] = []) {
    this.pending = events.slice();
    this.on.fill(false);
    this.backFrom.fill(null);
  }

  push(e: ControlView) {
    this.pending.push(e);
  }

  private due(e: ControlView, round: number, beat: Beat["kind"], tick: number): boolean {
    if (round !== e.round) return round > e.round;
    if (e.phase === "plan") return true;
    if (e.phase === "roundEnd") return beat === "roundEnd" || beat === "celebrate";
    return FIGHTING.includes(beat) && tick >= (e.tick ?? 0);
  }

  /**
   * Each frame: `round` is the round being shown (match.round), `beat` the
   * current beat, `tick` the fight's sim tick. Returns the callouts that
   * became due, in order.
   */
  update(round: number, beat: Beat["kind"], tick: number): ControlView[] {
    const fired: ControlView[] = [];
    while (this.pending.length && this.due(this.pending[0]!, round, beat, tick)) {
      const e = this.pending.shift()!;
      fired.push(e);
      if (e.mode === "autopilot") {
        this.on[e.seat] = true;
        this.backFrom[e.seat] = null;
      } else this.backFrom[e.seat] = e.fromRound ?? e.round + 1;
    }
    for (let i = 0; i < 4; i++) {
      const b = this.backFrom[i];
      if (b !== null && round >= b) {
        this.on[i] = false;
        this.backFrom[i] = null;
      }
    }
    return fired;
  }
}
