/**
 * The media side of bun run teaser: the audio track (the capture's sound cues on the output timeline, mixed by
 * the same offline mixer as scripts/sound-mix.ts), the encodes, the stills and the README.
 */
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateLevel } from "../../src/sim/levelgen";
import { summarizeRecord } from "../../src/sim/engine-version";
import type { LoggedCue } from "../../src/viewer/audio/engine";
import { mixCues, wavBytes } from "../../src/viewer/audio/offline";
import { outTime, type Plan } from "./plan";

/** The cues of the kept frames, moved to output time (cut frames' cues are dropped). */
export function cuesOnOutput(plan: Plan, cues: (LoggedCue & { frame: number })[]): LoggedCue[] {
  const out: LoggedCue[] = [];
  for (const c of cues) {
    const t = outTime(plan, c.frame);
    if (t !== null) out.push({ t, sound: c.sound, gain: c.gain, pan: c.pan, pitch: c.pitch, seed: c.seed });
  }
  return out;
}

export function writeAudio(file: string, plan: Plan, cues: LoggedCue[]) {
  const mix = mixCues(cues, { from: 0, length: plan.length });
  writeFileSync(file, wavBytes(mix));
  return { played: mix.played, dropped: mix.dropped, peakDb: 20 * Math.log10(mix.peak || 1e-9) };
}

async function ffmpeg(args: string[]) {
  const p = Bun.spawn(["ffmpeg", "-y", "-loglevel", "error", ...args], { stdout: "ignore", stderr: "pipe" });
  const code = await p.exited;
  if (code !== 0) throw new Error(`ffmpeg failed: ${(await new Response(p.stderr).text()).slice(-800)}`);
}

export const MAX_720_BYTES = 29.5e6;

/**
 * Encode the frames + audio at each height (in parallel). The capture is at the largest height; smaller ones
 * are scaled. The 720p copy is kept under 30 MB: if the quality-based encode is too big, it is redone at the
 * bitrate that fits.
 */
export async function encodeAll(framesDir: string, audio: string, fps: number, length: number, sizes: number[], captureH: number, outDir: string, name: string, fast: boolean) {
  const preset = fast ? "veryfast" : "medium";
  const enc = (h: number, rate: string[]) => {
    const file = join(outDir, `${name}-${h}p${fps}.mp4`);
    const scale = h === captureH ? [] : ["-vf", `scale=-2:${h}:flags=lanczos`];
    return ffmpeg(["-framerate", String(fps), "-i", join(framesDir, "%06d.jpg"), "-i", audio, ...scale, "-c:v", "libx264", "-preset", preset, ...rate, "-profile:v", "high", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", file]).then(() => file);
  };
  const files = await Promise.all(sizes.map((h) => enc(h, ["-crf", h >= 1080 ? "21" : "23"])));
  const i720 = sizes.indexOf(720);
  if (i720 >= 0 && statSync(files[i720]!).size > MAX_720_BYTES) {
    const kbps = Math.floor(((MAX_720_BYTES * 0.97 * 8) / length - 160e3) / 1000);
    files[i720] = await enc(720, ["-b:v", `${kbps}k`, "-maxrate", `${Math.round(kbps * 1.4)}k`, "-bufsize", `${kbps * 2}k`]);
  }
  return files.map((f) => ({ file: f, bytes: statSync(f).size }));
}

/** Stills at the plan's landmarks: a card, round 1 in action, the last round in action, the scoreboard. */
export async function stills(video: string, plan: Plan, outDir: string) {
  const seg = (pred: (s: Plan["segments"][number]) => boolean, at: number) => {
    const s = plan.segments.filter(pred);
    if (!s.length) return null;
    const pick = s[Math.floor(s.length / 2)]!;
    return pick.outStart + pick.outLength * at;
  };
  const fights = plan.segments.filter((s) => s.kind === "fight");
  const lastRound = Math.max(0, ...fights.map((s) => s.round ?? 0));
  const want: [string, number | null][] = [
    ["still-trash-talk.jpg", seg((s) => s.kind === "dialogue", 0.8)],
    ["still-round-1.jpg", seg((s) => s.kind === "fight" && s.round === 1 && s.speed === 1, 0.45)],
    [`still-round-${lastRound}.jpg`, seg((s) => s.kind === "fight" && s.round === lastRound && s.speed === 1, 0.6)],
    ["still-scoreboard.jpg", seg((s) => s.kind === "celebrate", 0.6)],
  ];
  const made: string[] = [];
  for (const [name, t] of want) {
    if (t === null || made.includes(name)) continue;
    await ffmpeg(["-ss", t.toFixed(2), "-i", video, "-frames:v", "1", "-q:v", "2", join(outDir, name)]);
    made.push(name);
  }
  return made;
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** Merge the plan into a readable scene list: consecutive cards become one line, a round's parts one line. */
export function sceneList(plan: Plan, names: string[]): string[] {
  const rows: { from: number; to: number; text: string }[] = [];
  for (const s of plan.segments) {
    const text =
      s.kind === "dialogue" ? `${s.label.replace("trash-talk card", "Trash-talk cards: all 4 fighters, fully typed")}`
      : s.kind === "fight" ? `Round ${s.round} in full, no cuts`
      : s.kind === "countdown" || s.kind === "go" ? "3, 2, 1, FIGHT!"
      : s.kind === "roundEnd" ? `Round ${s.round} end screen`
      : s.kind === "celebrate" ? `${names.length ? "Win screen with the scoreboard" : "Win screen"}`
      : s.kind === "level" ? "Arena card"
      : s.label;
    const last = rows[rows.length - 1];
    if (last && last.text === text) last.to = s.outStart + s.outLength;
    else rows.push({ from: s.outStart, to: s.outStart + s.outLength, text });
  }
  const quiet = plan.segments.filter((s) => s.speed === 2);
  return rows.map((r) => {
    const q = quiet.filter((s) => s.outStart >= r.from && s.outStart < r.to);
    return `| ${mmss(r.from)}-${mmss(r.to)} | ${r.text}${q.length ? ` (${q.length} quiet stretch${q.length > 1 ? "es" : ""} at 2x, tagged)` : ""} |`;
  });
}

export interface ReadmeInput {
  rec: unknown;
  from: string;
  plan: Plan;
  files: { file: string; bytes: number }[];
  stills: string[];
  counts: Record<string, number>;
  candidates?: { file: string; score: number; seconds: number }[];
  timing: Record<string, number>;
  audio: { played: number; dropped: number; peakDb: number };
}

export function writeReadme(dir: string, x: ReadmeInput) {
  const s = summarizeRecord(x.rec)!;
  const level = generateLevel(s.seed);
  const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;
  const winner = s.winner >= 0 ? s.names[s.winner] : "?";
  const others = s.names.map((n, i) => ({ n, w: s.wins[i] ?? 0, i })).filter((x) => x.i !== s.winner && x.w > 0);
  const result = `${winner} won ${s.wins[s.winner] ?? 0} round${s.wins[s.winner] === 1 ? "" : "s"}${others.length ? `; ${others.map((x) => `${x.n} won ${x.w}`).join(", ")}` : ""}`;
  const lines = [
    `# Knockback match video: seed ${s.seed}`,
    "",
    `Made with \`bun run teaser\` (docs/video.md) from ${x.from}. Engine v${s.engine}, arena ${level.name}. **${result}.**`,
    "",
    "## Files",
    "",
    "| File | What it is | Size |",
    "|---|---|---|",
    ...x.files.map((f) => `| \`${f.file.split("/").pop()}\` | ${mmss(x.plan.length)}, ${x.plan.fps} fps, H.264 + AAC stereo | ${mb(f.bytes)} |`),
    ...x.stills.map((f) => `| \`${f}\` | still | |`),
    "",
    "## Who played",
    "",
    "| Bot | AI | Before round 1 |",
    "|---|---|---|",
    ...s.names.map((n, i) => `| ${n}${i === s.winner ? " (winner)" : ""} | ${s.labels[i] ?? "house bot"} | "${(s.rounds[0]?.lines[i] ?? "").replace(/\|/g, "/")}" |`),
    "",
    ...s.rounds.slice(1).flatMap((r, ri) => [`**Before round ${ri + 2}:**`, "", ...s.names.map((n, i) => `- ${n}: "${r.lines[i] ?? ""}"`), ""]),
    "## Scene list",
    "",
    "| Time | Scene |",
    "|---|---|",
    ...sceneList(x.plan, s.names),
    "",
    `Captions: "Claude, Codex and Grok plan the fight" over the round 1 cards; "KNOCKBACK · AI agents plan. Physics decides." over the last 3 s.`,
    "",
    "## The match in numbers",
    "",
    `Explosions ${x.counts.explosion ?? 0}, chains broken ${x.counts.chainBreak ?? 0}, platforms fallen ${x.counts.platformFall ?? 0}, ring-outs ${x.counts["ko.ringout"] ?? 0}, K.O.s ${x.counts["ko.hp"] ?? 0}, sudden deaths ${x.counts.suddenDeath ?? 0}, fires ${x.counts.ignite ?? 0}.`,
    "",
    `Audio: ${x.audio.played} sounds mixed (${x.audio.dropped} dropped by the voice limiter), peak ${x.audio.peakDb.toFixed(1)} dBFS.`,
    "",
    ...(x.candidates ? ["## Candidates (--best-of)", "", "| Record | Action per second | Fight time |", "|---|---|---|", ...x.candidates.map((c) => `| ${c.file} | ${c.score} | ${c.seconds} s |`), ""] : []),
    "## How long it took",
    "",
    "| Step | Seconds |",
    "|---|---|",
    ...Object.entries(x.timing).map(([k, v]) => `| ${k} | ${v.toFixed(1)} |`),
    "",
  ];
  writeFileSync(join(dir, "README.md"), lines.join("\n"));
}
