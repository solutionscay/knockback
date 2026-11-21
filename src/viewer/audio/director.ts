/**
 * The sound director: the viewer's one entry point for sound. It turns what the viewer sees into cues
 * (map.ts) and hands them to the engine. It also hears two things the sim has no event for, by watching
 * velocities after each tick (read only): a grenade bouncing, and a falling platform crashing down.
 */
import type { Sim } from "../../sim/sim";
import type { SimEvent } from "../../sim/sim-types";
import type { AudioEngine } from "./engine";
import { blipsFor, cueForBeat, cueForMood, cuesForEvent, voiceHz, type Cue, type Listener } from "./map";

interface Body {
  linvel(): { x: number; y: number };
  translation(): { x: number; y: number };
}
interface Watched {
  vy: number;
  until: number;
}

export class SoundDirector {
  private grenades = new Map<number, Watched>();
  private falling = new Map<number, Watched>();
  private typed = -1;
  /** jetting fighters: when the next hiss starts (a long burn keeps hissing) */
  private jets = new Map<number, number>();
  /** each fighter's last lasting mood: a hit flash or the K.O. face in between is not a change of mood */
  private moods = new Map<number, string>();
  private typedFighter = -1;
  /** every cue handed to the engine (tests and the debug overlay read it); capped */
  readonly recent: Cue[] = [];

  constructor(readonly engine: AudioEngine) {}

  private play(c: Cue | null, clock: number) {
    if (!c) return;
    this.recent.push(c);
    if (this.recent.length > 200) this.recent.splice(0, 100);
    this.engine.play(c, clock);
  }

  /** A new round's arena: forget what was watched. */
  reset() {
    this.moods.clear();
    this.jets.clear();
    this.grenades.clear();
    this.falling.clear();
    this.engine.limiter.reset();
  }

  event(e: SimEvent, sim: Sim, clock: number) {
    const ctx = {
      fighterPos: (id: number) => {
        const f = sim.fighters[id];
        if (!f || f.removed) return null;
        const p = f.entity.body.translation();
        return { x: p.x, y: p.y };
      },
    };
    for (const c of cuesForEvent(e, ctx)) this.play(c, clock);
    if (e.type === "platformFall") this.falling.set(e.entity, { vy: 0, until: e.tick + 8 * 60 });
    if (e.type === "jetpack") this.jets.set(e.fighter, e.tick + 24);
  }

  beat(b: { kind: string; value?: number }, clock: number) {
    if (b.kind !== "dialogue") this.typed = -1;
    this.play(cueForBeat(b), clock);
  }

  /** Each frame of a dialogue card: blips for the letters typed since the last frame. */
  dialogue(fighter: number, identity: { name: string; shape: string; color: number }, line: string, typedNow: number, clock: number) {
    if (fighter !== this.typedFighter) {
      this.typedFighter = fighter;
      this.typed = 0;
    }
    if (typedNow > this.typed) for (const c of blipsFor(line, this.typed, typedNow, voiceHz(identity))) this.play(c, clock);
    this.typed = typedNow;
  }

  /** A dot face changed mood. */
  mood(id: number, mood: string, x: number, y: number, identity: { name: string; shape: string; color: number }, tick: number, clock: number) {
    if (mood === "hit" || mood === "white" || mood === "ko") return; // flashes, not moods (hits and K.O. sound on their own)
    if (mood === "stun") return this.play(cueForMood(mood, x, y, voiceHz(identity), tick + id), clock); // a beep, but not a new lasting mood
    const last = this.moods.get(id);
    this.moods.set(id, mood);
    if (last === undefined || last === mood) return; // the first face of a round, or back to the same mood after a flash
    this.play(cueForMood(mood, x, y, voiceHz(identity), tick + id), clock);
  }

  /** After each sim tick: grenade bounces and platform crashes, from velocity changes; jetpack hiss while jetting; live ground's buzz. */
  tick(sim: Sim, clock: number) {
    // live ground (#72): a buzz from each strip every 18 ticks while it is live
    for (const strip of sim.liveGround) {
      if ((sim.tick - strip.born) % 18 !== 0 || !strip.points.length) continue;
      const mid = strip.points[Math.floor(strip.points.length / 2)]!;
      this.play({ sound: "lightning.ground", x: mid.x, y: mid.y, gain: Math.min(1, strip.ticks / 40), pitch: 1, seed: sim.tick + strip.id }, clock);
    }
    for (const [id, next] of this.jets) {
      const f = sim.fighters[id];
      if (!f || f.removed || !f.alive || !f.jetting) {
        this.jets.delete(id);
        continue;
      }
      if (sim.tick >= next) {
        const p = f.entity.body.translation();
        this.play({ sound: "jetpack.hiss", x: p.x, y: p.y, gain: 0.9, pitch: 1, seed: sim.tick + id }, clock);
        this.jets.set(id, sim.tick + 24);
      }
    }
    const seen = new Set<number>();
    for (const e of sim.entities.values()) {
      if (e.kind !== "grenade" || e.dead) continue;
      seen.add(e.id);
      const v = (e.body as unknown as Body).linvel();
      const w = this.grenades.get(e.id);
      // falling, then suddenly going up (or stopping hard): it hit something
      if (w && w.vy < -2.5 && v.y > w.vy + 3) {
        const p = (e.body as unknown as Body).translation();
        this.play({ sound: "grenade.bounce", x: p.x, y: p.y, gain: Math.min(1, -w.vy / 9), pitch: 1, seed: sim.tick + e.id }, clock);
      }
      this.grenades.set(e.id, { vy: v.y, until: 0 });
    }
    for (const id of this.grenades.keys()) if (!seen.has(id)) this.grenades.delete(id);
    for (const [id, w] of this.falling) {
      const e = sim.entities.get(id);
      if (!e || e.dead || sim.tick > w.until) {
        this.falling.delete(id);
        continue;
      }
      const v = (e.body as unknown as Body).linvel();
      if (w.vy < -4 && v.y > w.vy + 4) {
        const p = (e.body as unknown as Body).translation();
        this.play({ sound: "platform.crash", x: p.x, y: p.y, gain: Math.min(1, -w.vy / 12), pitch: 1, seed: sim.tick + id }, clock);
        this.falling.delete(id);
        continue;
      }
      w.vy = v.y;
    }
  }

  /** The camera, for pan and distance. */
  listen(l: Listener | null) {
    this.engine.listener = l;
  }
}
