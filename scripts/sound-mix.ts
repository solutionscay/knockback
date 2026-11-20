/**
 * Render a capture-mode sound log to a WAV (#12), for videos made in capture mode (no real-time audio there).
 *   bun scripts/sound-mix.ts <cues.json> <out.wav> [--from <game s>] [--length <s>] [--volume 0.8] [--rate 48000]
 * cues.json: the concatenated results of window.__kb.drainSounds() (game time, sound, gain, pan, pitch, seed).
 * --from: the game time of the video's first frame. Then mux: ffmpeg -i video.mp4 -i out.wav -c:v copy -c:a aac ...
 * Uses the generated sounds (the same synthesis as the browser), so a video's audio is reproducible.
 */
import { mixCues, wavBytes } from "../src/viewer/audio/offline";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const [inFile, outFile] = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!inFile || !outFile) {
  console.error("usage: bun scripts/sound-mix.ts <cues.json> <out.wav> [--from s] [--length s] [--volume v] [--rate hz]");
  process.exit(1);
}
const cues = JSON.parse(await Bun.file(inFile).text());
const mix = mixCues(cues, {
  from: flag("from") !== undefined ? Number(flag("from")) : 0,
  length: flag("length") !== undefined ? Number(flag("length")) : undefined,
  volume: flag("volume") !== undefined ? Number(flag("volume")) : undefined,
  sampleRate: flag("rate") !== undefined ? Number(flag("rate")) : undefined,
});
await Bun.write(outFile, wavBytes(mix));
console.log(`${outFile}: ${(mix.left.length / mix.sampleRate).toFixed(2)} s, ${mix.played} sounds (${mix.dropped} dropped by the voice limiter), peak ${(20 * Math.log10(mix.peak || 1e-9)).toFixed(1)} dBFS`);
