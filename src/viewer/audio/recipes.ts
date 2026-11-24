/**
 * The sound book: every sound the viewer makes, as synthesis data (no audio files in the repo).
 * Each entry also says how it shares the mix: its voice group, how many may play at once, the shortest gap
 * between two of them, and a priority (a full mix drops lower priorities first).
 *
 * A private sample pack may replace any of these by name (see engine.ts); the names are the contract.
 */
import type { Layer, Recipe } from "./synth";

export interface SoundDef {
  recipe: Recipe;
  /** voices in one group share `max` (e.g. all explosion sizes) */
  group: string;
  /** most voices of this group playing at once */
  max: number;
  /** shortest time between two starts in this group, seconds */
  gap: number;
  /** 0..10; when the mix is full a new sound may take the place of a lower one */
  priority: number;
}

const L = (l: Partial<Layer> & Pick<Layer, "wave" | "freq" | "decay" | "gain">): Layer => ({ attack: 0.002, ...l });

/** A short metallic tinkle: a few high triangle pings at staggered times. */
const tinkles = (fs: number[], gain: number, step = 0.025): Layer[] => fs.map((f, i) => L({ wave: "triangle", freq: f, freqEnd: f * 0.97, decay: 0.12, gain, delay: i * step }));
/** Crackle: short noise pops at fixed offsets (fire, debris). */
const pops = (times: number[], gain: number): Layer[] => times.map((t, i) => L({ wave: "noise", freq: 6000 - i * 500, decay: 0.025, highpass: 1500, gain: gain * (1 - i * 0.08), delay: t }));

export const SOUNDS: Record<string, SoundDef> = {
  // --------------------------------------------------------------- explosions (size-scaled by the mapping)
  "explosion.small": {
    recipe: { layers: [L({ wave: "noise", freq: 3000, freqEnd: 600, decay: 0.45, punch: 0.6, lowpass: 3200, lowpassEnd: 400, gain: 0.9 }), L({ wave: "sine", freq: 120, freqEnd: 40, decay: 0.25, gain: 0.7 })] },
    group: "explosion", max: 4, gap: 0.03, priority: 8,
  },
  "explosion.medium": {
    recipe: { layers: [L({ wave: "noise", freq: 2500, freqEnd: 300, decay: 0.8, punch: 0.8, lowpass: 2600, lowpassEnd: 250, gain: 1 }), L({ wave: "sine", freq: 90, freqEnd: 30, decay: 0.45, gain: 0.85 }), L({ wave: "noise", freq: 5000, decay: 0.3, highpass: 2000, gain: 0.25, delay: 0.05 })] },
    group: "explosion", max: 4, gap: 0.03, priority: 9,
  },
  "explosion.large": {
    recipe: { layers: [L({ wave: "noise", freq: 2000, freqEnd: 200, decay: 1.4, punch: 1, lowpass: 2200, lowpassEnd: 150, gain: 1 }), L({ wave: "sine", freq: 70, freqEnd: 25, decay: 0.8, gain: 1 }), L({ wave: "noise", freq: 300, decay: 1.6, lowpass: 140, gain: 0.6 }), ...pops([0.12, 0.2, 0.31, 0.45], 0.18)] },
    group: "explosion", max: 4, gap: 0.03, priority: 10,
  },
  // --------------------------------------------------------------- weapons
  "rocket.launch": {
    recipe: { layers: [L({ wave: "noise", freq: 1200, freqEnd: 3500, attack: 0.01, decay: 0.5, lowpass: 4000, highpass: 300, gain: 0.55 }), L({ wave: "saw", freq: 180, freqEnd: 520, decay: 0.35, lowpass: 1500, gain: 0.18 })] },
    group: "weapon", max: 6, gap: 0.02, priority: 7,
  },
  "shotgun.fire": {
    recipe: { layers: [L({ wave: "noise", freq: 4000, freqEnd: 800, attack: 0.001, decay: 0.22, punch: 1, lowpass: 6000, lowpassEnd: 900, gain: 0.9 }), L({ wave: "sine", freq: 160, freqEnd: 50, decay: 0.12, gain: 0.6 }), L({ wave: "noise", freq: 1200, decay: 0.3, lowpass: 1200, gain: 0.2, delay: 0.06 })] },
    group: "weapon", max: 6, gap: 0.02, priority: 7,
  },
  "bat.swing": {
    recipe: { layers: [L({ wave: "noise", freq: 600, freqEnd: 1800, attack: 0.05, decay: 0.12, highpass: 400, lowpass: 2500, gain: 0.3 })] },
    group: "swing", max: 4, gap: 0.04, priority: 3,
  },
  "bat.hit": {
    recipe: { layers: [L({ wave: "sine", freq: 220, freqEnd: 90, decay: 0.1, gain: 0.8 }), L({ wave: "noise", freq: 2500, freqEnd: 700, decay: 0.07, punch: 1, lowpass: 3500, gain: 0.6 }), L({ wave: "triangle", freq: 620, freqEnd: 300, decay: 0.06, gain: 0.35 })] },
    group: "melee", max: 4, gap: 0.03, priority: 7,
  },
  "fist.swing": {
    recipe: { layers: [L({ wave: "noise", freq: 800, freqEnd: 1600, attack: 0.02, decay: 0.08, highpass: 600, gain: 0.18 })] },
    group: "swing", max: 4, gap: 0.04, priority: 2,
  },
  "fist.hit": {
    recipe: { layers: [L({ wave: "sine", freq: 180, freqEnd: 70, decay: 0.09, gain: 0.7 }), L({ wave: "noise", freq: 1500, freqEnd: 500, decay: 0.05, lowpass: 2000, gain: 0.45 })] },
    group: "melee", max: 4, gap: 0.03, priority: 6,
  },
  "grenade.throw": {
    recipe: { layers: [L({ wave: "noise", freq: 700, freqEnd: 1500, attack: 0.02, decay: 0.1, highpass: 500, gain: 0.16 }), L({ wave: "square", freq: 1400, decay: 0.02, gain: 0.08 })] },
    group: "weapon", max: 6, gap: 0.02, priority: 4,
  },
  "grenade.bounce": {
    recipe: { layers: [L({ wave: "triangle", freq: 520, freqEnd: 380, decay: 0.07, gain: 0.35 }), L({ wave: "noise", freq: 6000, decay: 0.015, lowpass: 4000, gain: 0.2 }), L({ wave: "square", freq: 1300, decay: 0.04, gain: 0.07 })] },
    group: "bounce", max: 3, gap: 0.05, priority: 3,
  },
  "grapple.shoot": {
    recipe: { layers: [L({ wave: "saw", freq: 900, freqEnd: 300, decay: 0.12, lowpass: 3000, gain: 0.25 }), L({ wave: "noise", freq: 3000, decay: 0.05, highpass: 1500, gain: 0.2 })] },
    group: "weapon", max: 6, gap: 0.02, priority: 5,
  },
  "grapple.latch": {
    recipe: { layers: [L({ wave: "square", freq: 300, freqEnd: 250, decay: 0.04, gain: 0.22 }), L({ wave: "noise", freq: 5000, decay: 0.02, gain: 0.2 })] },
    group: "grapple", max: 3, gap: 0.03, priority: 5,
  },
  "grapple.reel": {
    recipe: { layers: [L({ wave: "square", freq: 180, freqEnd: 420, duty: 0.3, attack: 0.01, decay: 0.35, vibrato: [1, 30], lowpass: 1800, gain: 0.13 })] },
    group: "reel", max: 3, gap: 0.05, priority: 4,
  },
  "mine.throw": {
    recipe: { layers: [L({ wave: "noise", freq: 900, freqEnd: 410, decay: 0.11, lowpass: 1500, gain: 0.32 }), L({ wave: "triangle", freq: 700, freqEnd: 500, decay: 0.035, gain: 0.22 })] },
    group: "weapon", max: 6, gap: 0.02, priority: 5,
  },
  "mine.stick": {
    recipe: { layers: [L({ wave: "noise", freq: 2750, decay: 0.045, highpass: 900, gain: 0.45 }), L({ wave: "triangle", freq: 185, decay: 0.07, gain: 0.3 })] },
    group: "mine", max: 3, gap: 0.03, priority: 5,
  },
  "mine.arm": {
    recipe: { layers: tinkles([960, 1440], 0.3, 0.09) },
    group: "mine", max: 3, gap: 0.03, priority: 6,
  },
  "mine.blast": {
    recipe: { layers: [L({ wave: "square", freq: 1150, freqEnd: 250, decay: 0.14, gain: 0.26 }), L({ wave: "noise", freq: 2100, lowpass: 3400, lowpassEnd: 310, decay: 0.49, gain: 0.75 }), L({ wave: "sine", freq: 98, freqEnd: 46, decay: 0.31, gain: 0.66 })] },
    group: "explosion", max: 4, gap: 0.03, priority: 9,
  },
  "rail.charge": {
    recipe: { layers: [L({ wave: "triangle", freq: 185, freqEnd: 1000, attack: 0.08, hold: 0.26, decay: 0.1, gain: 0.36 }), L({ wave: "saw", freq: 95, freqEnd: 440, attack: 0.12, hold: 0.22, decay: 0.09, lowpass: 1000, gain: 0.16 })] },
    group: "rail", max: 3, gap: 0.06, priority: 6,
  },
  "rail.fire": {
    recipe: { layers: [L({ wave: "saw", freq: 910, freqEnd: 140, decay: 0.31, punch: 0.65, lowpass: 3000, gain: 0.47 }), L({ wave: "noise", freq: 6000, decay: 0.11, highpass: 1400, gain: 0.52 }), L({ wave: "sine", freq: 130, freqEnd: 45, decay: 0.2, gain: 0.45 })] },
    group: "weapon", max: 6, gap: 0.02, priority: 8,
  },
  "hammer.slam": {
    recipe: { layers: [L({ wave: "sine", freq: 100, freqEnd: 34, decay: 0.42, punch: 0.75, gain: 0.8 }), L({ wave: "noise", freq: 400, lowpass: 800, decay: 0.39, gain: 0.7 }), L({ wave: "triangle", freq: 480, freqEnd: 245, decay: 0.18, gain: 0.25 })] },
    group: "melee", max: 4, gap: 0.03, priority: 8,
  },
  // the lightning sword (#72): a ringing slash, a bolt's crack, the live ground's buzz, a shock
  "lightning.slash": {
    recipe: { layers: [L({ wave: "noise", freq: 2400, freqEnd: 5000, attack: 0.02, decay: 0.12, highpass: 1200, gain: 0.22 }), L({ wave: "saw", freq: 1600, freqEnd: 700, decay: 0.14, vibrato: [3, 50], lowpass: 4000, gain: 0.12 })] },
    group: "swing", max: 4, gap: 0.04, priority: 4,
  },
  "lightning.hit": {
    recipe: { layers: [L({ wave: "sine", freq: 240, freqEnd: 90, decay: 0.1, gain: 0.7 }), L({ wave: "saw", freq: 2200, freqEnd: 400, decay: 0.12, vibrato: [5, 70], lowpass: 5000, gain: 0.25 }), L({ wave: "noise", freq: 6000, decay: 0.06, highpass: 2500, gain: 0.35 })] },
    group: "melee", max: 4, gap: 0.03, priority: 7,
  },
  "lightning.bolt": {
    recipe: { layers: [L({ wave: "noise", freq: 8000, decay: 0.09, punch: 1, highpass: 2000, gain: 0.55 }), L({ wave: "saw", freq: 2600, freqEnd: 120, decay: 0.32, vibrato: [6, 90], lowpass: 6000, gain: 0.3 }), L({ wave: "sine", freq: 110, freqEnd: 38, decay: 0.35, gain: 0.5 })] },
    group: "weapon", max: 6, gap: 0.02, priority: 8,
  },
  "lightning.ground": {
    recipe: { layers: [L({ wave: "saw", freq: 120, attack: 0.03, hold: 0.22, decay: 0.12, vibrato: [8, 30], lowpass: 900, gain: 0.12 }), L({ wave: "noise", freq: 5000, attack: 0.02, hold: 0.2, decay: 0.1, highpass: 3000, gain: 0.08 }), ...pops([0.04, 0.13, 0.22, 0.29], 0.12)] },
    group: "zap", max: 3, gap: 0.1, priority: 2,
  },
  "lightning.shock": {
    recipe: { layers: [L({ wave: "square", freq: 1400, freqEnd: 900, duty: 0.3, decay: 0.12, vibrato: [8, 45], gain: 0.12 }), L({ wave: "noise", freq: 7000, decay: 0.1, highpass: 3000, gain: 0.22 })] },
    group: "zap", max: 3, gap: 0.05, priority: 5,
  },
  // --------------------------------------------------------------- jetpack and fire
  "jetpack.hiss": {
    recipe: { layers: [L({ wave: "noise", freq: 5000, attack: 0.03, hold: 0.25, decay: 0.2, highpass: 1500, lowpass: 6000, gain: 0.25 }), L({ wave: "saw", freq: 90, attack: 0.03, hold: 0.25, decay: 0.2, vibrato: [0.5, 20], lowpass: 400, gain: 0.08 })] },
    group: "jetpack", max: 4, gap: 0.12, priority: 3,
  },
  "flame.whoosh": {
    recipe: { layers: [L({ wave: "noise", freq: 1800, attack: 0.05, hold: 0.3, decay: 0.3, lowpass: 1500, lowpassEnd: 900, gain: 0.35 }), ...pops([0.08, 0.2, 0.33], 0.12)] },
    group: "flame", max: 3, gap: 0.18, priority: 5,
  },
  "fire.crackle": {
    recipe: { layers: [L({ wave: "noise", freq: 900, attack: 0.05, hold: 0.2, decay: 0.2, lowpass: 900, gain: 0.12 }), ...pops([0.02, 0.09, 0.15, 0.24, 0.31, 0.4], 0.2)] },
    group: "fire", max: 4, gap: 0.12, priority: 2,
  },
  "fuel.out": {
    recipe: { layers: [L({ wave: "noise", freq: 1200, decay: 0.06, lowpass: 1500, gain: 0.25 }), L({ wave: "noise", freq: 1000, decay: 0.05, lowpass: 1200, gain: 0.2, delay: 0.1 }), L({ wave: "square", freq: 220, freqEnd: 110, duty: 0.3, decay: 0.2, gain: 0.08, delay: 0.16 })] },
    group: "flame", max: 3, gap: 0.05, priority: 4,
  },
  // --------------------------------------------------------------- arena: chains, platforms, props
  "chain.snap": {
    recipe: { layers: [L({ wave: "square", freq: 2200, freqEnd: 900, decay: 0.05, gain: 0.2 }), L({ wave: "noise", freq: 6000, decay: 0.04, highpass: 3000, gain: 0.35 }), L({ wave: "triangle", freq: 1600, decay: 0.25, vibrato: [0.3, 18], gain: 0.12, delay: 0.02 })] },
    group: "chain", max: 3, gap: 0.04, priority: 6,
  },
  "platform.creak": {
    recipe: { layers: [L({ wave: "saw", freq: 140, freqEnd: 105, attack: 0.05, decay: 0.5, vibrato: [3, 9], lowpass: 900, gain: 0.2 }), L({ wave: "square", freq: 70, duty: 0.15, attack: 0.05, decay: 0.4, lowpass: 600, gain: 0.07 })] },
    group: "platform", max: 2, gap: 0.15, priority: 5,
  },
  "platform.crash": {
    recipe: { layers: [L({ wave: "noise", freq: 1800, freqEnd: 200, decay: 0.7, punch: 0.8, lowpass: 2500, lowpassEnd: 300, gain: 0.8 }), L({ wave: "sine", freq: 80, freqEnd: 35, decay: 0.4, gain: 0.75 }), L({ wave: "triangle", freq: 420, decay: 0.25, vibrato: [0.4, 12], gain: 0.15, delay: 0.03 })] },
    group: "platform", max: 2, gap: 0.1, priority: 8,
  },
  "glass.break": {
    recipe: { layers: [L({ wave: "noise", freq: 8000, decay: 0.35, highpass: 3000, gain: 0.4 }), ...tinkles([2600, 3300, 2900, 4100, 3600], 0.12)] },
    group: "break", max: 4, gap: 0.04, priority: 5,
  },
  "wood.break": {
    recipe: { layers: [L({ wave: "noise", freq: 1800, freqEnd: 500, decay: 0.25, punch: 0.6, lowpass: 2500, gain: 0.6 }), L({ wave: "triangle", freq: 300, freqEnd: 180, decay: 0.08, gain: 0.35 }), L({ wave: "noise", freq: 4000, decay: 0.08, highpass: 1200, gain: 0.3, delay: 0.04 })] },
    group: "break", max: 4, gap: 0.04, priority: 5,
  },
  "steel.clang": {
    recipe: { layers: [L({ wave: "triangle", freq: 700, decay: 0.4, vibrato: [0.2, 7], gain: 0.3 }), L({ wave: "square", freq: 1050, decay: 0.25, gain: 0.07 }), L({ wave: "noise", freq: 5000, decay: 0.02, gain: 0.2 })] },
    group: "break", max: 4, gap: 0.04, priority: 4,
  },
  "terrain.crumble": {
    recipe: { layers: [L({ wave: "noise", freq: 400, attack: 0.02, decay: 0.45, lowpass: 600, gain: 0.35 }), ...pops([0.05, 0.12, 0.22], 0.08)] },
    group: "terrain", max: 2, gap: 0.12, priority: 2,
  },
  "pad.bounce": {
    recipe: { layers: [L({ wave: "sine", freq: 200, freqEnd: 800, decay: 0.3, vibrato: [1.5, 14], gain: 0.3 })] },
    group: "bounce", max: 3, gap: 0.05, priority: 4,
  },
  "zap": {
    recipe: { layers: [L({ wave: "saw", freq: 1800, freqEnd: 200, decay: 0.2, vibrato: [4, 60], gain: 0.2 }), L({ wave: "noise", freq: 7000, decay: 0.15, highpass: 2500, gain: 0.2 })] },
    group: "zap", max: 3, gap: 0.05, priority: 5,
  },
  "fuse.lit": {
    recipe: { layers: [L({ wave: "noise", freq: 6000, attack: 0.02, hold: 0.35, decay: 0.2, highpass: 3000, gain: 0.12 })] },
    group: "fuse", max: 3, gap: 0.1, priority: 3,
  },
  "item.spawn": {
    recipe: { layers: [L({ wave: "triangle", freq: 880, decay: 0.2, arp: [[0, 1], [0.07, 1.5]], gain: 0.12 })] },
    group: "item", max: 3, gap: 0.08, priority: 2,
  },
  "prop.drop": {
    recipe: { layers: [L({ wave: "sine", freq: 1400, freqEnd: 500, attack: 0.05, decay: 0.6, gain: 0.08 })] },
    group: "drop", max: 3, gap: 0.08, priority: 1,
  },
  // --------------------------------------------------------------- fighters
  "pickup.weapon": {
    recipe: { layers: [L({ wave: "noise", freq: 3000, decay: 0.03, lowpass: 3000, gain: 0.25 }), L({ wave: "square", freq: 440, decay: 0.22, arp: [[0, 1], [0.06, 1.5], [0.12, 2]], gain: 0.16 })] },
    group: "pickup", max: 3, gap: 0.05, priority: 6,
  },
  "pickup.power": {
    recipe: { layers: [L({ wave: "square", freq: 660, decay: 0.3, arp: [[0, 1], [0.05, 1.25], [0.1, 1.5], [0.15, 2]], gain: 0.14 }), L({ wave: "sine", freq: 1320, decay: 0.35, vibrato: [0.4, 9], gain: 0.08, delay: 0.1 })] },
    group: "pickup", max: 3, gap: 0.05, priority: 6,
  },
  "power.off": {
    recipe: { layers: [L({ wave: "square", freq: 660, freqEnd: 330, decay: 0.18, gain: 0.09 })] },
    group: "pickup", max: 3, gap: 0.05, priority: 2,
  },
  "shield.pop": {
    recipe: { layers: [L({ wave: "sine", freq: 900, freqEnd: 200, decay: 0.15, gain: 0.35 }), L({ wave: "noise", freq: 4000, decay: 0.08, highpass: 2000, gain: 0.25 })] },
    group: "shield", max: 3, gap: 0.05, priority: 6,
  },
  "hit.light": {
    recipe: { layers: [L({ wave: "noise", freq: 2000, freqEnd: 600, decay: 0.05, lowpass: 3000, gain: 0.4 }), L({ wave: "sine", freq: 200, freqEnd: 90, decay: 0.06, gain: 0.5 })] },
    group: "hit", max: 5, gap: 0.025, priority: 5,
  },
  "hit.heavy": {
    recipe: { layers: [L({ wave: "noise", freq: 1500, freqEnd: 300, decay: 0.14, punch: 1, gain: 0.6 }), L({ wave: "sine", freq: 140, freqEnd: 45, decay: 0.18, gain: 0.9 }), L({ wave: "square", freq: 90, duty: 0.3, decay: 0.08, gain: 0.14 })] },
    group: "hit", max: 5, gap: 0.025, priority: 7,
  },
  "hit.shielded": {
    recipe: { layers: [L({ wave: "triangle", freq: 1200, freqEnd: 900, decay: 0.12, gain: 0.25 })] },
    group: "hit", max: 5, gap: 0.025, priority: 4,
  },
  "land": {
    recipe: { layers: [L({ wave: "sine", freq: 120, freqEnd: 60, decay: 0.07, gain: 0.25 }), L({ wave: "noise", freq: 900, decay: 0.04, lowpass: 900, gain: 0.12 })] },
    group: "move", max: 3, gap: 0.05, priority: 1,
  },
  "jump": {
    recipe: { layers: [L({ wave: "square", freq: 300, freqEnd: 620, duty: 0.25, decay: 0.08, gain: 0.05 })] },
    group: "move", max: 3, gap: 0.05, priority: 1,
  },
  "swap": {
    recipe: { layers: [L({ wave: "square", freq: 1200, decay: 0.02, gain: 0.07 }), L({ wave: "square", freq: 900, decay: 0.02, gain: 0.07, delay: 0.04 })] },
    group: "move", max: 3, gap: 0.05, priority: 1,
  },
  "ko": {
    recipe: { layers: [L({ wave: "square", freq: 520, freqEnd: 60, decay: 0.55, gain: 0.2 }), L({ wave: "sine", freq: 100, freqEnd: 30, decay: 0.4, gain: 0.6 }), L({ wave: "noise", freq: 3000, freqEnd: 400, decay: 0.2, lowpass: 3000, gain: 0.35 })] },
    group: "ko", max: 2, gap: 0.05, priority: 10,
  },
  "ringout.whoosh": {
    recipe: { layers: [L({ wave: "noise", freq: 500, freqEnd: 2600, attack: 0.15, decay: 0.5, lowpass: 1500, lowpassEnd: 5000, highpass: 200, gain: 0.5 }), L({ wave: "sine", freq: 300, freqEnd: 80, attack: 0.1, decay: 0.7, gain: 0.2 })] },
    group: "ko", max: 2, gap: 0.05, priority: 10,
  },
  // --------------------------------------------------------------- the dot faces
  "mood.up": {
    recipe: { layers: [L({ wave: "square", freq: 1000, duty: 0.25, decay: 0.1, arp: [[0, 1], [0.05, 1.335]], gain: 0.07 })] },
    group: "mood", max: 2, gap: 0.12, priority: 1,
  },
  "mood.down": {
    recipe: { layers: [L({ wave: "square", freq: 900, duty: 0.25, decay: 0.12, arp: [[0, 1], [0.06, 0.75]], gain: 0.07 })] },
    group: "mood", max: 2, gap: 0.12, priority: 1,
  },
  "mood.angry": {
    recipe: { layers: [L({ wave: "saw", freq: 220, decay: 0.16, vibrato: [2, 35], lowpass: 1600, gain: 0.08 })] },
    group: "mood", max: 2, gap: 0.12, priority: 1,
  },
  "mood.stun": {
    recipe: { layers: [L({ wave: "sine", freq: 1200, decay: 0.3, vibrato: [3, 8], gain: 0.07 })] },
    group: "mood", max: 2, gap: 0.12, priority: 1,
  },
  "mood.sleepy": {
    recipe: { layers: [L({ wave: "sine", freq: 600, freqEnd: 300, attack: 0.05, decay: 0.35, gain: 0.07 })] },
    group: "mood", max: 2, gap: 0.12, priority: 1,
  },
  // --------------------------------------------------------------- show: countdown, dialogue, sudden death, the win
  "countdown.tick": {
    recipe: { layers: [L({ wave: "square", freq: 880, decay: 0.14, gain: 0.2 }), L({ wave: "sine", freq: 880, decay: 0.25, gain: 0.12 })] },
    group: "ui", max: 3, gap: 0.05, priority: 9,
  },
  "countdown.go": {
    recipe: { layers: [L({ wave: "square", freq: 880, hold: 0.2, decay: 0.4, arp: [[0, 1], [0.08, 1.5]], gain: 0.2 }), L({ wave: "noise", freq: 5000, decay: 0.5, lowpass: 5000, gain: 0.2 }), L({ wave: "saw", freq: 220, hold: 0.15, decay: 0.45, lowpass: 1200, gain: 0.12 })] },
    group: "ui", max: 3, gap: 0.05, priority: 9,
  },
  "blip": {
    recipe: { layers: [L({ wave: "square", freq: 440, duty: 0.25, attack: 0.001, decay: 0.035, gain: 0.08 })] },
    group: "blip", max: 2, gap: 0.035, priority: 2,
  },
  "suddenDeath.siren": {
    recipe: { layers: [L({ wave: "saw", freq: 550, attack: 0.05, hold: 1.4, decay: 0.3, vibrato: [5, 2.5], lowpass: 2200, gain: 0.16 }), L({ wave: "saw", freq: 556, attack: 0.05, hold: 1.4, decay: 0.3, vibrato: [5, 2.5], lowpass: 2200, gain: 0.12 })] },
    group: "ui", max: 3, gap: 0.05, priority: 9,
  },
  "round.end": {
    recipe: { layers: [L({ wave: "square", freq: 784, decay: 0.18, arp: [[0, 1], [0.12, 4 / 3]], gain: 0.14 }), L({ wave: "triangle", freq: 196, decay: 0.4, gain: 0.2 })] },
    group: "ui", max: 3, gap: 0.05, priority: 9,
  },
  "win.jingle": {
    recipe: {
      layers: [
        L({ wave: "square", freq: 523.25, hold: 0.42, decay: 0.5, arp: [[0, 1], [0.12, 1.26], [0.24, 1.5], [0.36, 2]], duty: 0.4, gain: 0.14 }),
        L({ wave: "triangle", freq: 261.63, hold: 0.3, decay: 0.6, arp: [[0, 1], [0.24, 1.5]], gain: 0.22 }),
        L({ wave: "noise", freq: 7000, decay: 0.6, highpass: 4000, gain: 0.05, delay: 0.36 }),
      ],
    },
    group: "ui", max: 3, gap: 0.05, priority: 9,
  },
};
