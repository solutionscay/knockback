/**
 * What sounds when: sim events, show beats and face moods -> sound cues. Pure functions (tested in
 * tests/sound.test.ts); the sim is only read, never changed, so sound can't touch determinism.
 */
import { ALL_WEAPONS, type SimEvent } from "../../sim/sim-types";
import { hash } from "../hash";

/** One sound to play: a name from the sound book, where (world meters, or none for the show sounds), how. */
export interface Cue {
  sound: string;
  /** world position; undefined = not spatial (countdown, siren, jingle, dialogue) */
  x?: number;
  y?: number;
  /** linear gain before spatial attenuation (1 = as designed) */
  gain: number;
  /** frequency multiplier */
  pitch: number;
  /** variation seed (noise), from the event, so a replay sounds the same */
  seed: number;
}

/** What the mapping may ask the viewer (positions for events that carry none). */
export interface MapContext {
  /** a fighter's position, or null when it is gone */
  fighterPos(id: number): { x: number; y: number } | null;
}

const WEAPON_ITEMS = new Set<string>(ALL_WEAPONS);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const cue = (sound: string, x: number | undefined, y: number | undefined, gain: number, pitch: number, seed: number): Cue => ({ sound, x, y, gain, pitch, seed: seed >>> 0 });

/**
 * Hooks for event types the sim may add later: an event with one of these names sounds right away, with no viewer
 * change. Fields x, y (or fighter) are used when present. (Jetpack and fire events are mapped explicitly below.)
 */
export const EVENT_HOOKS: Record<string, string> = {
  thrust: "jetpack.hiss",
  flame: "flame.whoosh",
  fire_spread: "fire.crackle",
};

/** Explosion size class from its blast radius (meters). */
export function explosionSound(radius: number): string {
  return radius < 2.2 ? "explosion.small" : radius < 3.4 ? "explosion.medium" : "explosion.large";
}

/** The cues for one sim event (most give one cue, some none). */
export function cuesForEvent(e: SimEvent, ctx: MapContext): Cue[] {
  const at = (id: number) => ctx.fighterPos(id) ?? { x: undefined, y: undefined };
  switch (e.type) {
    case "explosion": {
      // bigger blasts: lower and louder; a chain reaction is a little quieter per blast (they stack)
      const pitch = clamp(2.6 / Math.max(0.5, e.radius), 0.7, 1.35);
      const gain = clamp(0.55 + e.radius * 0.12, 0.6, 1) * (e.chainFrom ? 0.85 : 1);
      return [cue(e.kind === "mine" ? "mine.blast" : explosionSound(e.radius), e.x, e.y, gain, pitch, e.tick * 31 + Math.round(e.x * 7))];
    }
    case "fire": {
      const s = { rocket: "rocket.launch", shotgun: "shotgun.fire", grenade: "grenade.throw", grapple: "grapple.shoot", flamethrower: "flame.whoosh", mine: "mine.throw" }[e.weapon as string];
      return s ? [cue(s, e.x, e.y, 1, 1, e.tick + e.fighter)] : []; // bat and fist sound on their swing
    }
    case "mineStick":
    case "mineArm":
      return [cue(e.type === "mineArm" ? "mine.arm" : "mine.stick", e.x, e.y, 1, 1, e.tick + e.entity)];
    case "railCharge":
      return [cue("rail.charge", at(e.fighter).x, at(e.fighter).y, 1, 1, e.tick + e.fighter)];
    case "rail":
      return [cue("rail.fire", e.x0, e.y0, 1, 1, e.tick + e.fighter)];
    // precision weapons (#38) borrow existing recipes, pitched to tell them apart
    case "shot":
      return e.weapon === "sniper" ? [cue("rail.fire", e.x0, e.y0, 1, 0.75, e.tick + e.fighter)]
        : e.weapon === "rifle" ? [cue("shotgun.fire", e.x0, e.y0, 0.6, 1.5, e.tick + e.fighter)]
        : [cue("grapple.shoot", e.x0, e.y0, 0.9, 1.25, e.tick + e.fighter)];
    case "scope":
      return [cue("rail.charge", at(e.fighter).x, at(e.fighter).y, 0.5, 1.5, e.tick + e.fighter)];
    case "pin":
      return [cue("hit.heavy", e.x, e.y, 0.8, 1.3, e.tick + e.fighter)];
    case "shockwave":
      return [cue("hammer.slam", e.x, e.y, 1, 1, e.tick + e.fighter)];
    case "swing":
      return [cue(`${e.weapon}.${e.weapon === "lightning" ? (e.hit ? "hit" : "slash") : e.hit ? "hit" : "swing"}`, e.x, e.y, 1, 1, e.tick + e.fighter)];
    // the lightning sword (#72); the live ground's buzz repeats while it is live (SoundDirector)
    case "bolt":
      return [cue("lightning.bolt", e.x1, e.y1, 1, 1, e.tick + e.fighter)];
    case "shock":
      return [cue("lightning.shock", e.x, e.y, e.stun ? 1 : 0.6, 1, e.tick + e.fighter)];
    case "grapple":
      return e.hit === "none" ? [] : [cue("grapple.latch", e.x1, e.y1, 1, 1, e.tick), cue("grapple.reel", e.x0, e.y0, 0.9, 1, e.tick + 1)];
    case "hit": {
      // explosions are already loud: a blast hit is a small thud on top
      const blast = /explo|blast|barrel|tnt|gas|rocket|grenade|mine/.test(e.cause);
      if (e.shielded) return [cue("hit.shielded", e.x, e.y, 1, 1, e.tick + e.target)];
      const heavy = e.damage >= 14 || e.kb >= 16;
      return [cue(heavy ? "hit.heavy" : "hit.light", e.x, e.y, blast ? 0.45 : clamp(0.6 + e.damage / 40, 0.6, 1), clamp(1.2 - e.damage / 60, 0.8, 1.2), e.tick + e.target * 13)];
    }
    case "ko":
      return e.cause === "ringout" ? [cue("ringout.whoosh", clamp(e.x, -30, 30), Math.max(-4, e.y), 1, 1, e.tick)] : [cue("ko", e.x, e.y, 1, 1, e.tick)];
    case "break": {
      const s = e.kind === "glass" ? "glass.break" : e.kind === "crate" || e.kind === "block" ? "wood.break" : e.kind === "steel" || e.kind === "weight" || e.kind === "pad" ? "steel.clang" : null;
      // barrels, TNT and gas cans explode: the explosion is the sound
      return s ? [cue(s, e.x, e.y, clamp(0.6 + (e.hw + e.hh) * 0.4, 0.6, 1), 1, e.tick + e.entity)] : [];
    }
    case "shatter":
      return [cue("glass.break", e.x, e.y, 0.8, 1.1, e.tick + e.entity)];
    case "pickup":
      return [cue(WEAPON_ITEMS.has(e.item) ? "pickup.weapon" : "pickup.power", e.x, e.y, 1, e.item === "health" ? 0.9 : 1, e.tick + e.fighter)];
    case "power":
      return e.on ? [] : [cue("power.off", at(e.fighter).x, at(e.fighter).y, 1, 1, e.tick)]; // switching on is the pickup sound
    case "shieldPop":
      return [cue("shield.pop", e.x, e.y, 1, 1, e.tick)];
    // the force field (#40); a blast's own boom covers its stop, so that ripple is quieter
    case "fieldUp":
      return [cue("field.up", e.x, e.y, 1, 1, e.tick + e.field)];
    case "fieldHit":
      return [cue("field.hit", e.x, e.y, /explo|barrel|tnt|gas|rocket|grenade|mine/.test(e.cause) ? 0.6 : 1, clamp(1.15 - e.damage / 40, 0.75, 1.15), e.tick + e.field + Math.round(e.y * 5))];
    case "fieldDown":
      return [cue("field.down", e.x, e.y, e.reason === "broken" ? 1 : 0.8, e.reason === "broken" ? 0.9 : 1.1, e.tick + e.field)];
    case "impact":
      return [cue("hit.heavy", e.x, e.y, clamp(0.4 + e.damage / 30, 0.4, 0.9), 0.8, e.tick + e.fighter)];
    case "jump":
      return e.air ? [cue("jump", at(e.fighter).x, at(e.fighter).y, 1, 1.25, e.tick)] : []; // only double jumps: every hop would buzz
    case "land":
      return e.speed > 7 ? [cue("land", at(e.fighter).x, at(e.fighter).y, clamp(e.speed / 16, 0.4, 1), 1, e.tick)] : [];
    case "bounce":
      return [cue("pad.bounce", e.x, e.y, 1, 1, e.tick)];
    case "zap":
      return [cue("zap", e.x, e.y, 1, 1, e.tick)];
    case "lit":
      return [cue("fuse.lit", undefined, undefined, 0.8, 1, e.tick)]; // no position in the event: heard at the center
    case "itemSpawn":
      return [cue("item.spawn", e.x, e.y, 1, 1, e.tick)];
    case "propDrop":
      return [cue("prop.drop", e.x, e.y, 1, 1, e.tick)];
    case "detach":
      return e.cells >= 3 ? [cue("terrain.crumble", e.x, e.y, clamp(e.cells / 12, 0.4, 1), 1, e.tick + e.entity)] : [];
    case "swap":
      return []; // AI fighters swap weapons several times a second: a click each time is clutter ("swap" stays in the book)
    case "suddenDeath":
      return [cue("suddenDeath.siren", undefined, undefined, 1, 1, e.tick)];
    case "chainBreak":
      return [cue("chain.snap", e.x, e.y, 1, 1, e.tick + e.chain)];
    case "snap":
      return [cue("chain.snap", undefined, undefined, 0.7, 0.9, e.tick + e.entity)];
    case "platformSwing":
      return [cue("platform.creak", e.x, e.y, 1, 1, e.tick)];
    case "jetpack":
      return [cue("jetpack.hiss", at(e.fighter).x, at(e.fighter).y, 1, 1, e.tick + e.fighter)]; // kept going while jetting (SoundDirector)
    case "ignite":
      return [cue("fire.crackle", e.x, e.y, e.what === "cell" ? 0.6 : 0.9, 1, e.tick + Math.round(e.x * 3))];
    case "burn":
      return [cue("fire.crackle", at(e.fighter).x, at(e.fighter).y, 1, 1.2, e.tick + e.fighter)];
    case "fuelOut":
      return [cue("fuel.out", at(e.fighter).x, at(e.fighter).y, 1, 1, e.tick + e.fighter)];
    case "platformFall":
      return [cue("platform.creak", e.x, e.y, 1, 0.8, e.tick)]; // the crash comes when it lands (SoundWatch)
    default: {
      const hook = EVENT_HOOKS[(e as { type: string }).type];
      if (!hook) return [];
      const x = e as unknown as { x?: number; y?: number; fighter?: number; tick: number };
      const p = typeof x.x === "number" ? { x: x.x, y: x.y } : typeof x.fighter === "number" ? at(x.fighter) : { x: undefined, y: undefined };
      return [cue(hook, p.x, p.y, 1, 1, x.tick)];
    }
  }
}

/** Show sounds for the flow beats (countdown, FIGHT!, round end, the win). */
export function cueForBeat(b: { kind: string; value?: number }): Cue | null {
  switch (b.kind) {
    case "countdown":
      return cue("countdown.tick", undefined, undefined, 1, b.value === 1 ? 1.12 : 1, b.value ?? 0);
    case "go":
      return cue("countdown.go", undefined, undefined, 1, 1, 7);
    case "roundEnd":
      return cue("round.end", undefined, undefined, 1, 1, 8);
    case "celebrate":
      return cue("win.jingle", undefined, undefined, 1, 1, 9);
    default:
      return null;
  }
}

/**
 * The entrance (#66): the sounds of its steps (scene-entrance.ts ENTRANCE_AT), at the landing spot. The drop whistles
 * down, the landing slams, the shout is an angry beep in the agent's voice, the kick lands hard and the bot whooshes
 * off, the twinkle dings. `kick` says which step the kick is ("land": the agent lands on the bot).
 */
export function cuesForEntrance(step: string, at: { x: number; y: number }, voice: number, o: { kick: string; evicted: boolean }): Cue[] {
  const out: Cue[] = [];
  if (step === "drop") out.push(cue("ringout.whoosh", at.x, at.y, 0.9, 1.35, 661));
  if (step === "land") out.push(cue("hammer.slam", at.x, at.y, 1, 0.9, 662), cue("land", at.x, at.y, 1, 0.85, 663));
  if (step === "shout") out.push(cue("mood.angry", undefined, undefined, 1, voice / 440, 664), cue("countdown.go", undefined, undefined, 0.55, 0.8, 665));
  if (o.evicted && step === o.kick) out.push(cue("bat.hit", at.x, at.y, 1, 0.9, 666), cue("hit.heavy", at.x, at.y, 1, 0.85, 667), cue("ringout.whoosh", at.x, at.y, 1, 0.9, 668));
  if (o.evicted && step === "twinkle") out.push(cue("pickup.weapon", undefined, undefined, 0.8, 1.9, 669));
  return out;
}

const MOOD_SOUND: Record<string, string> = {
  confident: "mood.up",
  cocky: "mood.up",
  win: "mood.up",
  rattled: "mood.down",
  desperate: "mood.down",
  furious: "mood.angry",
  stun: "mood.stun",
  sleepy: "mood.sleepy",
};

/** A robot beep when a dot face changes mood (hit flashes and K.O. have their own sounds). */
export function cueForMood(mood: string, x: number, y: number, voice: number, seed: number): Cue | null {
  const s = MOOD_SOUND[mood];
  return s ? cue(s, x, y, 1, voice / 440, seed) : null;
}

/** Each bot's voice pitch (Hz) for its dialogue blips and mood beeps, from its identity: stable and distinct-ish. */
export function voiceHz(id: { name: string; shape: string; color: number }): number {
  // 13 steps of a whole tone apart over ~2 octaves, nudged by shape so two similar names still differ
  const steps = (hash(id.name) + hash(id.shape) * 7 + (id.color & 0xff)) % 13;
  return 220 * Math.pow(2, (steps * 2) / 12);
}

/** Dialogue blips: one per typed letter or digit, at most every other character, in the speaker's voice. */
export function blipsFor(line: string, from: number, to: number, voice: number): Cue[] {
  const out: Cue[] = [];
  for (let i = Math.max(0, from); i < Math.min(line.length, to); i++) {
    if (i % 2 || !/[\p{L}\p{N}]/u.test(line[i]!)) continue;
    // a little melody: vowels a step up, end of a sentence a step down
    const up = /[aeiouAEIOU]/.test(line[i]!) ? 1.12 : 1;
    out.push(cue("blip", undefined, undefined, 1, (voice / 440) * up, i));
  }
  return out;
}

/** The camera as the mix hears it: world center, pixels per meter, screen size. */
export interface Listener {
  cx: number;
  cy: number;
  s: number;
  w: number;
  h: number;
}

/**
 * Stereo pan and volume from where a sound is in the camera view: full volume on screen, quieter with distance
 * off screen (half volume about one view width away), panned left/right by its place across the view.
 */
export function spatial(x: number | undefined, y: number | undefined, l: Listener | null): { pan: number; gain: number } {
  if (x === undefined || y === undefined || !l || !(l.s > 0)) return { pan: 0, gain: 1 };
  const hw = l.w / 2 / l.s;
  const hh = l.h / 2 / l.s;
  const dx = x - l.cx;
  const dy = y - l.cy;
  const pan = clamp(dx / hw, -1, 1) * 0.75;
  const outX = Math.max(0, Math.abs(dx) - hw);
  const outY = Math.max(0, Math.abs(dy) - hh);
  const off = Math.hypot(outX, outY) / (2 * hw);
  return { pan, gain: 1 / (1 + off * 2) };
}
