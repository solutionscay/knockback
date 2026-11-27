/**
 * One command from a match to a finished video (docs/video.md):
 *   bun run teaser --record records/<file>.json
 *   bun run teaser --best-of 4          # play 4 real AI matches, keep the one with the most action
 *   bun run teaser --seed 42 --fast     # a quick 720p30 preview of a house-bot match
 * The operator's video rules are built in: View all, every card and every round in full (2x only for quiet
 * stretches), round-end and win screens, a clean screen, start and end captions, no slow motion, the sound track.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureFrames, launch, planCaption, scanTimeline, serveViewer } from "./teaser/capture";
import { cuesOnOutput, encodeAll, stills, writeAudio, writeReadme } from "./teaser/media";
import { OptionError, parseTeaserArgs } from "./teaser/options";
import { cleanup, deliver, teaserPaths } from "./teaser/paths";
import { planVideo } from "./teaser/plan";
import { getRecord, matchFacts } from "./teaser/source";
import { webglRenderer } from "./viewer-browser";

let opts;
try {
  opts = parseTeaserArgs(process.argv.slice(2));
} catch (e) {
  console.error(e instanceof OptionError ? e.message : e);
  process.exit(e instanceof OptionError && e.message.startsWith("bun run teaser") ? 0 : 1);
}
// scratch on the local disk (frames, cues, WAV, encodes); only the finished files go to --out
const paths = teaserPaths(opts.out, opts.work ?? tmpdir(), `${process.pid}-${Date.now()}`, tmpdir());
const out = paths.out;
const work = paths.work;
mkdirSync(paths.staging, { recursive: true });
const timing: Record<string, number> = {};
const t0 = performance.now();
let tPhase = t0;
const phase = (name: string) => {
  const now = performance.now();
  timing[name] = (now - tPhase) / 1000;
  tPhase = now;
  console.log(`  ${name}: ${timing[name]!.toFixed(1)} s`);
};
const log = (s: string) => console.log(s);

log(`teaser -> ${out}\n  scratch: ${work}`);
const got = await getRecord(opts.source, work, log);
writeFileSync(join(paths.staging, "match.json"), JSON.stringify(got.rec));
phase(opts.source.kind === "best-of" ? "AI matches (not counted in the video time)" : "get the record");
const tVideo = performance.now();

const facts = await matchFacts(got.rec);
phase("sim pass (dead stretches, numbers)");

const server = serveViewer(JSON.stringify(got.rec));
const browser = await launch(opts.gpu);
log(`  browser GPU: ${opts.gpu} (WebGL: ${await webglRenderer(browser)})`);
try {
  const timeline = await scanTimeline(browser, server.url);
  const plan = planVideo(timeline, facts.dead, opts.fps);
  writeFileSync(paths.plan, JSON.stringify({ segments: plan.segments, length: plan.length, fps: plan.fps }, null, 1));
  log(`  plan: ${plan.segments.length} segments, ${plan.frames.length} frames, ${plan.length.toFixed(1)} s of video (${plan.segments.filter((s) => s.speed === 2).length} quiet stretches at 2x)`);
  phase("scan and plan");

  const h = opts.sizes[0]!;
  const size = { w: Math.round((h * 16) / 9), h };
  let last = 0;
  const startCaption = planCaption(got.rec.labels ?? []);
  const cap = await captureFrames(browser, server.url, plan, size, opts.workers, paths.frames, startCaption, (n) => {
    if (n - last >= 600 || n === plan.frames.length) {
      last = n;
      process.stdout.write(`\r  capture: ${n}/${plan.frames.length} frames`);
    }
  });
  process.stdout.write("\n");
  phase(`capture (${opts.workers} pages, ${size.w}x${size.h})`);

  const audioFile = paths.audio;
  const audio = writeAudio(audioFile, plan, cuesOnOutput(plan, cap.cues));
  writeFileSync(paths.cues, JSON.stringify(cap.cues));
  phase("audio mix");

  const name = `knockback-${got.rec.seed}`;
  const files = await encodeAll(paths.frames, audioFile, opts.fps, plan.length, opts.sizes, h, paths.staging, name, opts.fast);
  phase(`encode (${opts.sizes.map((s) => `${s}p`).join(" + ")})`);

  const made = await stills(files[0]!.file, plan, paths.staging);
  timing["video total (excluding AI matches)"] = (performance.now() - tVideo) / 1000;
  writeReadme(paths.staging, { rec: got.rec, from: got.from, plan, files, stills: made, counts: facts.counts, candidates: got.candidates, timing, audio, startCaption });
  writeFileSync(join(paths.staging, "timing.json"), JSON.stringify(timing, null, 1));
  phase("stills and README");
  const delivered = deliver(paths);
  phase(`copy ${delivered.length} files to --out`);
  log(`done in ${((performance.now() - t0) / 1000).toFixed(0)} s (video part ${timing["video total (excluding AI matches)"]!.toFixed(0)} s):`);
  for (const f of delivered.filter((d) => d.file.endsWith(".mp4"))) log(`  ${f.file}  ${(f.bytes / 1e6).toFixed(1)} MB`);
} finally {
  await browser.close();
  server.stop();
  if (opts.keepWork) log(`  scratch kept: ${work}`);
  else cleanup(paths);
}
