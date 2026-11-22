/**
 * A posting montage from several match records (docs/video.md, #74):
 *   bun run montage records/arena/            # a folder of records
 *   bun run montage a.json b.json c.json      # or a list
 *   bun run montage --server http://localhost:5176
 * The sim pass scores every fight's big moments; the best bursts (2-5 s, never the same moment twice, many rounds)
 * are cut in the rhythm mayhem, mayhem, mayhem, an agent's entrance (#66: it drops in and kicks a house bot out),
 * the agents' cards, mayhem, mayhem, mayhem, and the title card.
 * Each cut is captured by the teaser pipeline (real viewer, video mode) with its own game sound, crossfaded at the
 * cuts. Out: a 1080x1920 vertical cut and a 1920x1080 cut, H.264 + AAC, +faststart, under 30 MB, and a README.
 */
import { linkSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { modelOf } from "../src/stats/models";
import { wavBytes } from "../src/viewer/audio/offline";
import type { MatchRecord } from "../src/sim/match";
import { buildChipText, buildProblem, type Build } from "../src/sim/build";
import { crossfade, END_FADE_S, SR, segmentSound, XF_S, type Stereo } from "./montage/audio";
import { bursts, cropLeft, cutFrames, describe, montageOrder, pickCuts, type Burst } from "./montage/cuts";
import { MONTAGE_USAGE, parseMontageArgs, type MontageOptions } from "./montage/options";
import { captureFrames, launch, planCaption, scanTimeline, serveViewer, type CaptureResult, END_TEXT, END_TITLE } from "./teaser/capture";
import { ffmpeg, fitKbps } from "./teaser/media";
import { OptionError } from "./teaser/options";
import { cleanup, deliver, teaserPaths } from "./teaser/paths";
import { beatRanges, cardWindow, type Caption, type Plan } from "./teaser/plan";
import { matchFacts, type MatchFacts } from "./teaser/source";

const FPS = 60;
const TITLE_S = 2.5;
const MAX_BYTES = 29.5e6;
/** the landscape capture; the vertical cut crops it around the action (below the HUD chips) and scales it to 1080 wide */
const L = { w: 1920, h: 1080 };
const V = { w: 1080, h: 1920 };
const CROP = { top: 96, w: 900, h: 820 };
const FG = { w: V.w, h: Math.round((CROP.h * V.w) / CROP.w) };

type Rec = MatchRecord & { labels?: string[] };

let opts: MontageOptions;
try {
  opts = parseMontageArgs(process.argv.slice(2));
} catch (e) {
  console.error(e instanceof OptionError ? e.message : e);
  process.exit(e instanceof OptionError && e.message === MONTAGE_USAGE ? 0 : 1);
}
const paths = teaserPaths(opts.out, opts.work ?? tmpdir(), `montage-${process.pid}-${Date.now()}`, tmpdir());
mkdirSync(paths.staging, { recursive: true });
const t0 = performance.now();
const log = (s: string) => console.log(s);
const secs = () => `${((performance.now() - t0) / 1000).toFixed(0)} s`;
log(`montage -> ${paths.out}\n  scratch: ${paths.work}`);

// ---- records and the sim pass
async function loadRecords(): Promise<{ file: string; rec: Rec }[]> {
  const src = opts.source;
  if (src.kind === "paths") {
    const files = src.paths.flatMap((p) => (statSync(p).isDirectory() ? readdirSync(p).filter((f) => f.endsWith(".json") && !f.endsWith(".prompts.json")).sort().map((f) => join(p, f)) : [p]));
    return Promise.all(files.map(async (f) => ({ file: resolve(f), rec: JSON.parse(await Bun.file(f).text()) as Rec })));
  }
  const res = await fetch(`${src.url}/api/records`);
  if (!res.ok) throw new Error(`${src.url}/api/records: HTTP ${res.status}`);
  const list = (((await res.json()) as { records?: { path: string; createdAt: number }[] }).records ?? []).sort((a, b) => b.createdAt - a.createdAt).slice(0, 40);
  const out: { file: string; rec: Rec }[] = [];
  for (const r of list) {
    if (out.length >= 16) break;
    const got = await fetch(`${src.url}${r.path}`);
    if (!got.ok) continue;
    const rec = (await got.json()) as Rec;
    if ((rec.labels ?? []).some((l) => modelOf(l).provider !== "house")) out.push({ file: `${src.url}${r.path}`, rec });
  }
  return out;
}

const loaded = await loadRecords();
const recs: { file: string; rec: Rec; facts: MatchFacts }[] = [];
for (const r of loaded) {
  try {
    recs.push({ ...r, facts: await matchFacts(r.rec) });
  } catch (e) {
    log(`  skipped ${basename(r.file)}: it does not replay on this sim (${(e as Error).message})`);
  }
}
if (!recs.length) throw new Error("no record replays on this sim");
log(`  sim pass: ${recs.length} records (${secs()})`);

// ---- the cuts, the cards, the title
const cands = recs.flatMap((r, i) => r.facts.moments.flatMap((ms, round) => bursts(i, round, ms, r.facts.endTicks[round]!)));
const picked = pickCuts(cands);
if (picked.length < 2) throw new Error(`only ${picked.length} burst(s) of action in these records: not enough for a montage`);
const order = montageOrder(picked);
// the cards show seats whose own agent planned the round (not a bot line after an agent error or timeout)
const agentSeats = (rec: Rec) => (rec.labels ?? []).map((l, i) => ({ l, i })).filter((s) => modelOf(s.l).provider !== "house" && rec.rounds[0]?.meta?.[s.i]?.outcome === "ok");
const rarity = (label: string) => recs.filter((r) => (r.rec.labels ?? []).includes(label)).length;
const total = (r: (typeof recs)[number]) => r.facts.score;
const cardsRec = recs.map((r, i) => ({ r, i })).sort((a, b) => agentSeats(b.r.rec).length - agentSeats(a.r.rec).length || total(b.r) - total(a.r))[0]!.i;
const cardSeats = agentSeats(recs[cardsRec]!.rec)
  // a card names its model: an agent that reported none ("MODEL NOT REPORTED") comes last
  .sort((a, b) => Number(modelOf(a.l).key === "remote:unreported") - Number(modelOf(b.l).key === "remote:unreported") || rarity(a.l) - rarity(b.l) || a.i - b.i)
  .slice(0, 2)
  .map((s) => s.i)
  .sort((a, b) => a - b);
const titleRec = order.after[order.after.length - 1]!.rec;
// the entrance (#66): the round where the most agents drop in and kick a house bot out (the newest first on a tie)
const kicks = (rec: Rec) => (rec.entrances ?? []).filter((e) => e.evicted).length;
const entranceRec = recs.map((r, i) => ({ i, n: kicks(r.rec) })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n || a.i - b.i)[0]?.i ?? -1;
const caption = planCaption([...new Set(recs.flatMap((r) => r.rec.labels ?? []))]);

// ---- capture, record by record
type Part = { kind: "cut"; burst: Burst } | { kind: "entrance"; seat: number } | { kind: "card"; seat: number } | { kind: "title" };
interface Shot {
  part: Part;
  rec: number;
  from: number;
  to: number;
  /** first output index in the record's landscape and portrait frame folders */
  lAt: number;
  pAt: number;
  /** vertical cut: left edge of the crop */
  cropX?: number;
}
const shots: Shot[] = [];
const captures = new Map<number, CaptureResult>();
const needed = [...new Set([...picked.map((b) => b.rec), cardsRec, titleRec, ...(entranceRec >= 0 ? [entranceRec] : [])])].sort((a, b) => a - b);
const browser = await launch();
try {
  for (const ri of needed) {
    const r = recs[ri]!;
    const server = serveViewer(JSON.stringify(r.rec));
    try {
      const tl = await scanTimeline(browser, server.url);
      const ranges = beatRanges(tl);
      const fights = ranges.filter((b) => b.kind === "fight");
      const mine: Omit<Shot, "lAt" | "pAt">[] = [];
      for (const b of picked.filter((x) => x.rec === ri)) mine.push({ part: { kind: "cut", burst: b }, rec: ri, ...cutFrames(tl.ticks, fights[b.round]!, b) });
      if (ri === cardsRec)
        for (const seat of cardSeats) {
          const beat = ranges.find((b) => b.kind === "dialogue" && b.round === 1 && (b as { fighter?: number }).fighter === seat);
          if (beat) mine.push({ part: { kind: "card", seat }, rec: ri, ...cardWindow(beat.from, beat.to) });
        }
      if (ri === entranceRec) {
        // the first entrance that kicks a house bot out, in full
        const seat = recs[ri]!.rec.entrances!.find((e) => e.evicted)!.seat;
        const beat = ranges.filter((b) => b.kind === "entrance")[recs[ri]!.rec.entrances!.findIndex((e) => e.seat === seat)];
        if (beat) mine.push({ part: { kind: "entrance", seat }, rec: ri, from: beat.from, to: beat.to });
      }
      if (ri === titleRec) {
        const cel = ranges.find((b) => b.kind === "celebrate");
        if (!cel) throw new Error(`${basename(r.file)} has no win screen for the title card`);
        const from = Math.min(cel.from + 20, cel.to);
        mine.push({ part: { kind: "title" }, rec: ri, from, to: Math.min(cel.to, from + Math.round(TITLE_S * FPS) - 1) });
      }
      mine.sort((a, b) => a.from - b.from);
      // one plan per frame size: the landscape one has every shot, the portrait one the cards and the title
      const planOf = (keep: (s: Omit<Shot, "lAt" | "pAt">) => boolean) => {
        const frames: Plan["frames"] = [];
        const at = new Map<Omit<Shot, "lAt" | "pAt">, number>();
        for (const s of mine.filter(keep)) {
          at.set(s, frames.length);
          const cap: Caption = s.part.kind === "card" ? "start" : s.part.kind === "title" ? "end" : null;
          for (let f = s.from; f <= s.to; f++) frames.push({ src: f, out: frames.length, caption: cap, tag: false });
        }
        return { plan: { segments: [], length: frames.length / FPS, fps: FPS, frames } satisfies Plan, at };
      };
      const lp = planOf(() => true);
      const pp = planOf((s) => s.part.kind !== "cut");
      const cap = await captureFrames(browser, server.url, lp.plan, L, opts.workers, join(paths.frames, `l${ri}`), caption);
      if (pp.plan.frames.length) await captureFrames(browser, server.url, pp.plan, V, Math.min(2, opts.workers), join(paths.frames, `p${ri}`), caption);
      captures.set(ri, cap);
      for (const s of mine) {
        const shot: Shot = { ...s, lAt: lp.at.get(s)!, pAt: pp.at.get(s) ?? -1 };
        if (s.part.kind === "cut") {
          // the crop follows the cut's action: each moment's screen x in the frame it happened
          const pts = s.part.burst.moments.map((m) => {
            const f = cutFrames(tl.ticks, { from: s.from, to: s.to }, { from: m.tick, to: m.tick }).from;
            const v = cap.views.get(f);
            return { x: v ? L.w / 2 + (m.x - v.cx - v.shx) * v.s : NaN, weight: m.weight };
          });
          shot.cropX = cropLeft(pts, L.w, CROP.w);
        }
        shots.push(shot);
      }
      log(`  ${basename(r.file)}: ${mine.length} shot(s), ${lp.plan.frames.length} frames (${secs()})`);
    } finally {
      server.stop();
    }
  }
} finally {
  await browser.close();
}

// ---- the montage: order, frames for both cuts, the sound track
const cutShot = (b: Burst) => shots.find((s) => s.part.kind === "cut" && s.part.burst === b)!;
const seq: Shot[] = [
  ...order.before.map(cutShot),
  ...shots.filter((s) => s.part.kind === "entrance"),
  ...shots.filter((s) => s.part.kind === "card").sort((a, b) => a.from - b.from),
  ...order.after.map(cutShot),
  shots.find((s) => s.part.kind === "title")!,
];
const outL = join(paths.work, "montage-l");
const outV = join(paths.work, "montage-v");
mkdirSync(outL, { recursive: true });
mkdirSync(outV, { recursive: true });
const name6 = (n: number) => `${String(n).padStart(6, "0")}.jpg`;
let at = 0;
const starts: number[] = [];
const sounds: Stereo[] = [];
for (const s of seq) {
  const n = s.to - s.from + 1;
  starts.push(at);
  for (let k = 0; k < n; k++) linkSync(join(paths.frames, `l${s.rec}`, name6(s.lAt + k)), join(outL, name6(at + k)));
  if (s.part.kind === "cut") {
    const x = s.cropX!;
    const bx = Math.min(L.w - 608, Math.max(0, x + CROP.w / 2 - 304));
    await ffmpeg([
      "-framerate", String(FPS), "-start_number", String(s.lAt), "-i", join(paths.frames, `l${s.rec}`, "%06d.jpg"), "-frames:v", String(n),
      "-filter_complex", `[0:v]split[a][b];[a]crop=${CROP.w}:${CROP.h}:${x}:${CROP.top},scale=${FG.w}:${FG.h}:flags=lanczos[fg];[b]crop=608:1080:${bx}:0,scale=${V.w}:${V.h},gblur=sigma=28,eq=brightness=-0.14:saturation=0.75[bg];[bg][fg]overlay=0:${Math.round((V.h - FG.h) / 2)}`,
      "-q:v", "2", "-start_number", String(at), join(outV, "%06d.jpg"),
    ]);
  } else for (let k = 0; k < n; k++) linkSync(join(paths.frames, `p${s.rec}`, name6(s.pAt + k)), join(outV, name6(at + k)));
  sounds.push(segmentSound(captures.get(s.rec)!.cues, s.from, s.to, FPS));
  at += n;
}
const frames = at;
const length = frames / FPS;
const track = crossfade(sounds, starts.map((f) => Math.round((f / FPS) * SR)), Math.round(XF_S * SR), Math.round(length * SR), Math.round(END_FADE_S * SR));
let peak = 0;
for (const ch of [track.left, track.right]) for (const v of ch) peak = Math.max(peak, Math.abs(v));
const wav = join(paths.work, "montage.wav");
writeFileSync(wav, wavBytes({ left: track.left, right: track.right, sampleRate: SR, played: 0, dropped: 0, peak }));
log(`  montage: ${seq.length} shots, ${length.toFixed(1)} s (${secs()})`);

// ---- encode both cuts, each under 30 MB
async function encode(dir: string, file: string) {
  const enc = (rate: string[]) =>
    ffmpeg(["-framerate", String(FPS), "-i", join(dir, "%06d.jpg"), "-i", wav, "-c:v", "libx264", "-preset", "medium", ...rate, "-profile:v", "high", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", file]);
  await enc(["-crf", "20"]);
  if (statSync(file).size > MAX_BYTES) {
    const kbps = fitKbps(length, MAX_BYTES);
    await enc(["-b:v", `${kbps}k`, "-maxrate", `${Math.round(kbps * 1.4)}k`, "-bufsize", `${kbps * 2}k`]);
  }
  return { file, bytes: statSync(file).size };
}
const files = [await encode(outV, join(paths.staging, "knockback-montage-1080x1920.mp4")), await encode(outL, join(paths.staging, "knockback-montage-1920x1080.mp4"))];
log(`  encode (${secs()})`);

// ---- README and the cut list
const mmss = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
const rows = seq.map((s, i) => {
  const r = recs[s.rec]!;
  const names = r.rec.identities.map((id) => id.name);
  const t = `${mmss(starts[i]! / FPS)}-${mmss((starts[i]! + s.to - s.from + 1) / FPS)}`;
  const file = basename(r.file);
  if (s.part.kind === "cut") {
    const b = s.part.burst;
    return `| ${i + 1} | ${t} | ${file} | ${b.round + 1} | ${mmss(b.from / 60)}-${mmss(b.to / 60)} | ${describe(b, names)} (score ${b.score.toFixed(1)}) |`;
  }
  if (s.part.kind === "entrance") {
    const e = r.rec.entrances!.find((x) => x.seat === (s.part as { seat: number }).seat)!;
    return `| ${i + 1} | ${t} | ${file} | 1 | before the fight | Entrance: ${names[e.seat]} (${modelOf(r.rec.labels?.[e.seat]).name}) drops in, "${e.line.replace(/\|/g, "/")}", kicks out ${e.evicted?.name ?? "?"} (house bot) |`;
  }
  if (s.part.kind === "card") {
    const seat = s.part.seat;
    // the card's build chip (#81); a record with an illegal build is refused by the viewer before this
    const build = r.rec.rounds[0]?.strategies[seat]?.build;
    const chip = build !== undefined && buildProblem(build) === null ? buildChipText(build as Build) : "BALANCED";
    return `| ${i + 1} | ${t} | ${file} | 1 | before the fight | Card: ${names[seat]} (${modelOf(r.rec.labels?.[seat]).name}): "${(r.rec.rounds[0]?.lines[seat] ?? "").replace(/\|/g, "/")}", build ${chip}, and its plan chips${caption ? `; caption "${caption}"` : ""} |`;
  }
  return `| ${i + 1} | ${t} | ${file} | ${r.rec.rounds.length} | win screen | Title card: "${END_TITLE} · ${END_TEXT}" |`;
});
const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;
writeFileSync(
  join(paths.staging, "README.md"),
  [
    "# Knockback montage",
    "",
    `Made with \`bun run montage\` (docs/video.md) from ${recs.length} records. The cuts are the best bursts of big moments the sim pass found (explosions, chain snaps, platform falls, ring-outs, K.O.s, fire), at most 2 per record and never the same moment twice; then ${entranceRec >= 0 ? "an agent's entrance and " : ""}the agents' cards, the biggest cuts last, and the title card.`,
    "",
    "## Files",
    "",
    "| File | What it is | Size |",
    "|---|---|---|",
    ...files.map((f) => `| \`${basename(f.file)}\` | ${length.toFixed(1)} s, ${FPS} fps, H.264 + AAC stereo, +faststart | ${mb(f.bytes)} |`),
    "",
    "## Cut list",
    "",
    "| # | Montage time | Record | Round | Fight time | What happens |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    `The vertical cut crops each fight shot (${CROP.w} px of the 1920 px frame, below the HUD chips, scaled to 1080 wide) around the action, over a blurred copy; the cards and the title card are captured in a portrait frame. Sound: each shot's own game sound, ${Math.round(XF_S * 1000)} ms crossfades at the cuts, a ${END_FADE_S} s fade-out under the title. Peak ${(20 * Math.log10(peak || 1e-9)).toFixed(1)} dBFS.`,
    "",
    "## Records",
    "",
    "| Record | Who played | Burst candidates |",
    "|---|---|---|",
    ...recs.map((r, i) => `| ${basename(r.file)} | ${r.rec.identities.map((id, k) => `${id.name} (${modelOf(r.rec.labels?.[k]).name})`).join(", ")} | ${cands.filter((c) => c.rec === i).length} |`),
    "",
  ].join("\n"),
);
writeFileSync(join(paths.staging, "cuts.json"), JSON.stringify(seq.map((s, i) => ({ n: i + 1, kind: s.part.kind, record: basename(recs[s.rec]!.file), from: s.from, to: s.to, at: starts[i]! / FPS, ...(s.part.kind === "cut" ? { ticks: [s.part.burst.from, s.part.burst.to], score: s.part.burst.score, cropX: s.cropX } : {}) })), null, 1));
const delivered = deliver(paths);
log(`done in ${secs()}:`);
for (const f of delivered.filter((d) => d.file.endsWith(".mp4"))) log(`  ${f.file}  ${mb(f.bytes)}`);
if (opts.keepWork) log(`  scratch kept: ${paths.work}`);
else cleanup(paths);
