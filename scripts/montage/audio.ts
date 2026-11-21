/**
 * The montage sound track: each cut's own game sound (the capture's cues, mixed by the offline mixer of
 * scripts/sound-mix.ts), joined with short crossfades so a cut never clicks, and a fade-out under the title.
 */
import type { LoggedCue } from "../../src/viewer/audio/engine";
import { mixCues } from "../../src/viewer/audio/offline";

export const SR = 48000;
/** the crossfade at each cut: the outgoing cut's sound runs on XF_S past the cut, fading out, while the next fades in */
export const XF_S = 0.04;
/** sounds that started up to PRE_S before a cut still ring into it */
export const PRE_S = 0.6;
export const END_FADE_S = 0.6;

export interface Stereo {
  left: Float32Array;
  right: Float32Array;
}

/** One segment's sound: the cues of source frames [from - PRE_S, to] on the segment's own clock, plus XF_S of tail. */
export function segmentSound(cues: readonly (LoggedCue & { frame: number })[], from: number, to: number, hz = 60): Stereo {
  const pre = Math.round(PRE_S * hz);
  const mine = cues.filter((c) => c.frame >= from - pre && c.frame <= to).map((c) => ({ t: (c.frame - from) / hz, sound: c.sound, gain: c.gain, pan: c.pan, pitch: c.pitch, seed: c.seed }));
  const length = (to - from + 1) / hz;
  const mix = mixCues(mine, { from: -PRE_S, length: PRE_S + length + XF_S, sampleRate: SR });
  const skip = Math.round(PRE_S * SR);
  return { left: mix.left.subarray(skip), right: mix.right.subarray(skip) };
}

/**
 * Join the segments: part i starts at sample starts[i]; each fades in over its first xf samples and out over its
 * last xf (the tail that overlaps the next part's fade-in). The whole track fades out over its last `endFade` samples.
 */
export function crossfade(parts: readonly Stereo[], starts: readonly number[], xf: number, total: number, endFade = 0): Stereo {
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  parts.forEach((p, i) => {
    const at = starts[i]!;
    const n = p.left.length;
    for (let k = 0; k < n; k++) {
      const o = at + k;
      if (o >= total) break;
      const g = Math.min(1, k / xf, (n - k) / xf);
      left[o]! += p.left[k]! * g;
      right[o]! += p.right[k]! * g;
    }
  });
  for (let k = Math.max(0, total - endFade); k < total; k++) {
    const g = (total - k) / endFade;
    left[k]! *= g;
    right[k]! *= g;
  }
  return { left, right };
}
