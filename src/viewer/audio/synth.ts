/**
 * sfxr-style sound synthesis as a pure function: a recipe (data) -> mono samples.
 * The same code renders in the browser (into an AudioBuffer) and offline (scripts/sound-mix.ts, for videos),
 * so a sound is identical everywhere. Noise is seeded: a recipe + pitch + seed always gives the same samples.
 */

export type Wave = "square" | "saw" | "triangle" | "sine" | "noise";

/** One oscillator with its envelope, pitch slide and filters. Times in seconds, frequencies in Hz. */
export interface Layer {
  wave: Wave;
  /** start frequency (noise: how fast the noise changes; higher = brighter) */
  freq: number;
  /** frequency at the end of the sound (exponential slide); default: no slide */
  freqEnd?: number;
  /** square wave duty cycle, 0..1 (default 0.5) */
  duty?: number;
  attack: number;
  /** full volume after the attack (default 0) */
  hold?: number;
  decay: number;
  /** extra volume at the start of the decay, 0..1: a sharper hit */
  punch?: number;
  /** [depth in semitones, rate in Hz] */
  vibrato?: [number, number];
  /** pitch steps: [time, frequency multiplier], in order (arpeggios, jingles) */
  arp?: [number, number][];
  /** one-pole low-pass cutoff, sliding to lowpassEnd */
  lowpass?: number;
  lowpassEnd?: number;
  /** one-pole high-pass cutoff */
  highpass?: number;
  gain: number;
  /** start offset */
  delay?: number;
}

export interface Recipe {
  layers: Layer[];
  /** overall gain (default 1) */
  gain?: number;
}

export interface RenderOpts {
  /** frequency multiplier for every layer (default 1) */
  pitch?: number;
  /** noise seed (default 1) */
  seed?: number;
  sampleRate?: number;
}

/** Length of a recipe in seconds. */
export function recipeLength(r: Recipe): number {
  return Math.max(0, ...r.layers.map((l) => (l.delay ?? 0) + l.attack + (l.hold ?? 0) + l.decay));
}

function mulberry32(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAU = Math.PI * 2;

/** Render a recipe to mono samples in -1..1 (a layer may overshoot; the mixer limits the sum). */
export function renderRecipe(r: Recipe, opts: RenderOpts = {}): Float32Array {
  const sr = opts.sampleRate ?? 44100;
  const pitch = opts.pitch ?? 1;
  const len = Math.ceil(recipeLength(r) * sr) + 1;
  const out = new Float32Array(len);
  const rnd = mulberry32((opts.seed ?? 1) * 2654435761);
  for (const l of r.layers) {
    const start = Math.floor((l.delay ?? 0) * sr);
    const hold = l.hold ?? 0;
    const dur = l.attack + hold + l.decay;
    const n = Math.ceil(dur * sr);
    const f0 = l.freq * pitch;
    const f1 = (l.freqEnd ?? l.freq) * pitch;
    const duty = l.duty ?? 0.5;
    let phase = 0;
    let noiseVal = rnd() * 2 - 1;
    let lp = 0;
    let hpIn = 0;
    let hpOut = 0;
    let arpI = 0;
    let arpMul = 1;
    for (let i = 0; i < n && start + i < len; i++) {
      const t = i / sr;
      const u = dur > 0 ? t / dur : 1;
      // envelope: linear attack, hold, decay with an optional punch
      let env: number;
      if (t < l.attack) env = l.attack > 0 ? t / l.attack : 1;
      else if (t < l.attack + hold) env = 1;
      else {
        const d = l.decay > 0 ? (t - l.attack - hold) / l.decay : 1;
        env = (1 - d) * (1 - d) * (1 + (l.punch ?? 0) * (1 - d));
      }
      if (l.arp) while (arpI < l.arp.length && t >= l.arp[arpI]![0]) arpMul = l.arp[arpI++]![1];
      let f = f0 * Math.pow(f1 / f0, u) * arpMul;
      if (l.vibrato) f *= Math.pow(2, (l.vibrato[0] / 12) * Math.sin(TAU * l.vibrato[1] * t));
      const prev = phase;
      phase = (phase + f / sr) % 1;
      let s: number;
      switch (l.wave) {
        case "square":
          s = phase < duty ? 1 : -1;
          break;
        case "saw":
          s = 2 * phase - 1;
          break;
        case "triangle":
          s = phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase;
          break;
        case "sine":
          s = Math.sin(TAU * phase);
          break;
        default:
          // sample-and-hold noise: a new value each time the phase wraps (twice per cycle)
          if (phase < prev || (prev < 0.5 && phase >= 0.5)) noiseVal = rnd() * 2 - 1;
          s = noiseVal;
      }
      if (l.lowpass !== undefined) {
        const fc = l.lowpass * Math.pow((l.lowpassEnd ?? l.lowpass) / l.lowpass, u);
        lp += (1 - Math.exp((-TAU * Math.min(fc, sr * 0.45)) / sr)) * (s - lp);
        s = lp;
      }
      if (l.highpass !== undefined) {
        const a = Math.exp((-TAU * l.highpass) / sr);
        hpOut = a * (hpOut + s - hpIn);
        hpIn = s;
        s = hpOut;
      }
      out[start + i]! += s * env * l.gain;
    }
  }
  const g = r.gain ?? 1;
  if (g !== 1) for (let i = 0; i < len; i++) out[i]! *= g;
  return out;
}
