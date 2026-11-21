/**
 * Embed mount point (#22): the site pages (/lobby, /watch/:id, /replay/:id) show this viewer in a same-origin
 * iframe with `?embed`. The fight code is untouched; this bridge only reports where playback is and, for
 * replays, lets the page seek and change speed:
 *
 *   viewer -> page   { kb: "pos", pos: PlaybackPos | null, speed }       every 250 ms
 *                    { kb: "live", msg }                                  every live stream message (the page's fight feed)
 *                    { kb: "seeking", on }
 *   page -> viewer   { kb: "seek", to: PlaybackPos }                      fast-forward (or restart and fast-forward) to a point
 *                    { kb: "speed", speed }                               0 = pause, 1, 2
 *
 * Messages are only exchanged with the same origin.
 */
import type { Beat } from "../flow/beats";

/** Where playback is: the round on screen, its phase, and the fight tick (fight phase only). */
export interface PlaybackPos {
  round: number;
  phase: "plan" | "fight" | "end";
  tick: number;
  /** the match is over and its celebrate screen shows */
  done?: boolean;
}

/** The playback position of a beat (pure: tested). `lastRound` is the number of rounds played, for the celebrate beat. */
export function posOfBeat(beat: Beat, tick: number, lastRound: number): PlaybackPos {
  switch (beat.kind) {
    case "level":
    case "entrance":
      return { round: 1, phase: "plan", tick: 0 };
    case "dialogue":
    case "countdown":
      return { round: beat.round, phase: "plan", tick: 0 };
    case "go":
    case "fight":
      return { round: beat.round, phase: "fight", tick };
    case "roundEnd":
      return { round: beat.round, phase: "end", tick };
    case "celebrate":
      return { round: Math.max(1, lastRound), phase: "end", tick, done: true };
  }
}

const PHASE = { plan: 0, fight: 1, end: 2 } as const;
/** a reached b (pure: tested): round, then phase, then tick. */
export function reached(a: PlaybackPos, b: PlaybackPos): boolean {
  if (a.done) return true;
  if (a.round !== b.round) return a.round > b.round;
  if (a.phase !== b.phase) return PHASE[a.phase] > PHASE[b.phase];
  return a.phase !== "fight" || a.tick >= b.tick;
}

export interface EmbedHost {
  /** current position (null before the match is built) */
  pos(): PlaybackPos | null;
  /** advance the game by dt seconds */
  step(dt: number): void;
  /** restart the replay from the beginning (null when this is not a replay) */
  restart: (() => void) | null;
  /** turn the game's sound off and on while seeking */
  mute(on: boolean): void;
}

export class EmbedBridge {
  speed = 1;
  seeking = false;
  private target: PlaybackPos | null = null;
  private readonly origin = location.origin;

  constructor(private host: EmbedHost) {
    addEventListener("message", (ev) => {
      if (ev.origin !== this.origin || !ev.data || typeof ev.data !== "object") return;
      const d = ev.data as { kb?: string; to?: PlaybackPos; speed?: number };
      if (d.kb === "speed" && typeof d.speed === "number") this.speed = Math.max(0, Math.min(4, d.speed));
      if (d.kb === "seek" && d.to && typeof d.to.round === "number") this.seek(d.to);
    });
    setInterval(() => this.post({ kb: "pos", pos: this.host.pos(), speed: this.speed }), 250);
  }

  post(msg: unknown) {
    if (parent !== window) parent.postMessage(msg, this.origin);
  }

  /** the live stream message, for the page's fight feed */
  live(msg: unknown) {
    this.post({ kb: "live", msg });
  }

  /** The frame's game time to advance (0 while seeking or paused). */
  frame(dt: number): number {
    return this.seeking ? 0 : dt * this.speed;
  }

  private seek(to: PlaybackPos) {
    if (!this.host.restart) return; // live: no seeking
    const now = this.host.pos();
    if (!now || reached(now, to)) this.host.restart();
    this.target = to;
    if (this.seeking) return;
    this.seeking = true;
    this.host.mute(true);
    this.post({ kb: "seeking", on: true });
    const run = () => {
      const until = performance.now() + 24;
      // fast-forward in fixed sim steps, a slice of wall time per frame so the page stays responsive
      while (performance.now() < until) {
        const p = this.host.pos();
        if (p && this.target && reached(p, this.target)) return this.endSeek();
        this.host.step(1 / 60);
      }
      requestAnimationFrame(run);
    };
    requestAnimationFrame(run);
  }

  private endSeek() {
    this.seeking = false;
    this.target = null;
    this.host.mute(false);
    this.post({ kb: "seeking", on: false });
  }
}
