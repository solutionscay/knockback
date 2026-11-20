/**
 * Voice limiting: decides which sounds may start, so 20 explosions in one second don't stack into clipping.
 * Pure bookkeeping (no WebAudio), shared by the browser engine and the offline renderer, and tested.
 *
 * Rules, in order, for a sound of group G at time `now`:
 * 1. gap: a start closer than G's `gap` to the last start in G is dropped (a burst becomes one hit).
 * 2. group cap: with G's `max` voices already playing, the oldest of them is stopped for the new one.
 * 3. total cap: with `maxVoices` playing, the oldest of the lowest priority is stopped, if its priority is not
 *    above the new sound's; otherwise the new sound is dropped.
 * 4. stacking: the n-th voice playing in a group gets 1/sqrt(n) gain, so a group's loudness grows slowly.
 */
import { SOUNDS, type SoundDef } from "./recipes";

export interface Voice {
  id: number;
  sound: string;
  group: string;
  priority: number;
  start: number;
  end: number;
}

export type Admit = { ok: true; voice: Voice; gain: number; stop: Voice[] } | { ok: false; reason: "unknown" | "gap" | "full" };

export class VoiceLimiter {
  active: Voice[] = [];
  private lastStart = new Map<string, number>();
  private nextId = 1;
  /** counts of drops by reason, for tests and the debug overlay */
  dropped = { unknown: 0, gap: 0, full: 0 };

  constructor(
    readonly maxVoices = 24,
    private defs: Record<string, SoundDef> = SOUNDS,
  ) {}

  /** Ask to start `sound` (lasting `length` seconds) at `now`. */
  admit(sound: string, now: number, length: number): Admit {
    const def = this.defs[sound];
    if (!def) {
      this.dropped.unknown++;
      return { ok: false, reason: "unknown" };
    }
    this.active = this.active.filter((v) => v.end > now);
    const last = this.lastStart.get(def.group);
    if (last !== undefined && now - last < def.gap) {
      this.dropped.gap++;
      return { ok: false, reason: "gap" };
    }
    const stop: Voice[] = [];
    const inGroup = this.active.filter((v) => v.group === def.group);
    if (inGroup.length >= def.max) stop.push(inGroup.reduce((a, b) => (b.start < a.start ? b : a)));
    if (this.active.length - stop.length >= this.maxVoices) {
      const pool = this.active.filter((v) => !stop.includes(v));
      const low = Math.min(...pool.map((v) => v.priority));
      if (low > def.priority) {
        this.dropped.full++;
        return { ok: false, reason: "full" };
      }
      stop.push(pool.filter((v) => v.priority === low).reduce((a, b) => (b.start < a.start ? b : a)));
    }
    this.active = this.active.filter((v) => !stop.includes(v));
    const voice: Voice = { id: this.nextId++, sound, group: def.group, priority: def.priority, start: now, end: now + length };
    this.active.push(voice);
    this.lastStart.set(def.group, now);
    const n = this.active.filter((v) => v.group === def.group).length;
    return { ok: true, voice, gain: 1 / Math.sqrt(n), stop };
  }

  reset() {
    this.active = [];
    this.lastStart.clear();
  }
}
