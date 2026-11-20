/**
 * Offline mix of a capture-mode cue log (videos): the same synthesis and voice limiting as the browser, then a
 * compressor and a soft limiter like the live chain. Pure (no WebAudio, no files): scripts/sound-mix.ts writes
 * the result to a WAV; tests check that a pile of explosions stays below full scale.
 */
import type { LoggedCue } from "./engine";
import { VoiceLimiter } from "./mixer";
import { SOUNDS } from "./recipes";
import { renderRecipe } from "./synth";

export interface MixOpts {
  sampleRate?: number;
  /** seconds of game time that map to t = 0 in the output */
  from?: number;
  /** output length in seconds (default: until the last sound ends) */
  length?: number;
  /** master volume, 0..1 (default 0.8) */
  volume?: number;
}

export interface Mix {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
  /** voices that played / were dropped by the limiter */
  played: number;
  dropped: number;
  /** highest absolute sample after the limiter */
  peak: number;
}

const dbToLin = (db: number) => Math.pow(10, db / 20);

export function mixCues(cues: LoggedCue[], opts: MixOpts = {}): Mix {
  const sr = opts.sampleRate ?? 48000;
  const from = opts.from ?? 0;
  const vol = opts.volume ?? 0.8;
  const sorted = cues.filter((c) => SOUNDS[c.sound] && c.t >= from).sort((a, b) => a.t - b.t);
  const cache = new Map<string, Float32Array>();
  const limiter = new VoiceLimiter();
  type Placed = { id: number; at: number; buf: Float32Array; gl: number; gr: number; stopAt: number };
  const placed: Placed[] = [];
  let dropped = 0;
  for (const c of sorted) {
    const pitch = Math.round(c.pitch * 50) / 50;
    const variant = c.seed % 3;
    const key = `${c.sound}|${pitch}|${variant}`;
    let buf = cache.get(key);
    if (!buf) cache.set(key, (buf = renderRecipe(SOUNDS[c.sound]!.recipe, { pitch, seed: variant + 1, sampleRate: sr })));
    const t = c.t - from;
    const a = limiter.admit(c.sound, t, buf.length / sr);
    if (!a.ok) {
      dropped++;
      continue;
    }
    for (const v of a.stop) {
      const p = placed.find((q) => q.id === v.id);
      if (p) p.stopAt = Math.round(t * sr);
    }
    // equal-power pan
    const th = ((c.pan + 1) / 2) * (Math.PI / 2);
    const g = c.gain * a.gain;
    placed.push({ id: a.voice.id, at: Math.round(t * sr), buf, gl: Math.cos(th) * g, gr: Math.sin(th) * g, stopAt: Infinity });
  }
  const end = opts.length !== undefined ? Math.ceil(opts.length * sr) : Math.max(0, ...placed.map((p) => p.at + p.buf.length));
  const left = new Float32Array(end);
  const right = new Float32Array(end);
  const fade = Math.round(0.01 * sr); // a stolen voice fades out over 10 ms
  for (const p of placed) {
    for (let i = 0; i < p.buf.length; i++) {
      const o = p.at + i;
      if (o >= end) break;
      let s = p.buf[i]!;
      if (o >= p.stopAt) {
        const k = 1 - (o - p.stopAt) / fade;
        if (k <= 0) break;
        s *= k;
      }
      left[o]! += s * p.gl;
      right[o]! += s * p.gr;
    }
  }
  // compressor (like the live chain: -16 dB, 6:1, 3 ms attack, 250 ms release), then volume and a soft limiter
  const thr = dbToLin(-16);
  const att = Math.exp(-1 / (0.003 * sr));
  const rel = Math.exp(-1 / (0.25 * sr));
  let env = 0;
  let peak = 0;
  const ceiling = dbToLin(-1);
  for (let i = 0; i < end; i++) {
    const x = Math.max(Math.abs(left[i]!), Math.abs(right[i]!));
    env = x > env ? att * env + (1 - att) * x : rel * env + (1 - rel) * x;
    const g = env > thr ? Math.pow(env / thr, 1 / 6 - 1) : 1;
    for (const ch of [left, right]) {
      const y = ch[i]! * g * vol * 1.6;
      // soft knee above the ceiling: never past full scale
      const z = Math.abs(y) <= ceiling * 0.8 ? y : Math.sign(y) * (ceiling * 0.8 + ceiling * 0.2 * Math.tanh((Math.abs(y) - ceiling * 0.8) / (ceiling * 0.2)));
      ch[i] = z;
      if (Math.abs(z) > peak) peak = Math.abs(z);
    }
  }
  return { left, right, sampleRate: sr, played: placed.length, dropped, peak };
}

/** 16-bit stereo PCM WAV bytes. */
export function wavBytes(m: Mix): Uint8Array {
  const n = m.left.length;
  const data = new DataView(new ArrayBuffer(44 + n * 4));
  const str = (o: number, s: string) => [...s].forEach((ch, i) => data.setUint8(o + i, ch.charCodeAt(0)));
  str(0, "RIFF");
  data.setUint32(4, 36 + n * 4, true);
  str(8, "WAVE");
  str(12, "fmt ");
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 2, true);
  data.setUint32(24, m.sampleRate, true);
  data.setUint32(28, m.sampleRate * 4, true);
  data.setUint16(32, 4, true);
  data.setUint16(34, 16, true);
  str(36, "data");
  data.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    data.setInt16(44 + i * 4, Math.round(Math.max(-1, Math.min(1, m.left[i]!)) * 32767), true);
    data.setInt16(46 + i * 4, Math.round(Math.max(-1, Math.min(1, m.right[i]!)) * 32767), true);
  }
  return new Uint8Array(data.buffer);
}
