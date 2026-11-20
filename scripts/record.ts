/**
 * Record full match loops (intros, countdown, fight, celebrate + tally) to a
 * 1080p WebM with a headless browser, plus screenshots of the key beats and
 * the best fight moments. The viewer runs in capture mode: it only
 * advances when told to, so every frame is exactly 1/30 s of game time no
 * matter how slow headless rendering is.
 *
 * Demos are filmed in the "View all" camera mode by default (the whole fight
 * on screen); --camera picks another mode: auto | all | follow:1..4.
 *
 *   bun run dev &                      # the viewer must be served
 *   bun scripts/record.ts <outdir> [seed1 seed2 ...] [--camera all] [--url http://localhost:5173]
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { initPhysics, Match, replayMatch } from "../src/sim";

// flags: --url <base>, --camera <auto|all|follow:N> (also --flag=value)
const flags: Record<string, string> = {};
const rest: string[] = [];
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
      flags[k] = v ?? argv[++i] ?? "";
    } else rest.push(a);
  }
}
const base = flags.url || "http://localhost:5173";
type CamMode = { kind: "auto" } | { kind: "all" } | { kind: "follow"; id: number };
function parseCamera(v: string): CamMode {
  if (v === "auto") return { kind: "auto" };
  if (v === "all" || v === "view-all") return { kind: "all" };
  const m = /^follow:([1-4])$/.exec(v);
  if (m) return { kind: "follow", id: Number(m[1]) - 1 };
  throw new Error(`--camera must be auto, all or follow:1..4 (got "${v}")`);
}
const camera = parseCamera(flags.camera || "all");
// --record /records/<file>.json : film an exact replay of a saved (e.g. AI) match
const recordPath = flags.record || "";
const recordJson = recordPath ? JSON.parse(await Bun.file(join("records", recordPath.replace(/^\/records\//, ""))).text()) : null;
if (recordJson) {
  rest.splice(1);
  rest.push(String(recordJson.seed));
}
const outDir = rest[0] ?? "out";
const seeds = rest.slice(1).map(Number);
if (seeds.length === 0) seeds.push(7, 42);

const FPS = 30;
const TAIL_SECONDS = 0.6; // keep filming after the celebrate beat ends
const framesDir = join(outDir, "frames");
const shotsDir = join(outDir, "screenshots");
rmSync(framesDir, { recursive: true, force: true });
mkdirSync(framesDir, { recursive: true });
mkdirSync(shotsDir, { recursive: true });

await initPhysics();
const browser = await chromium.launch({ args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("[pageerror]", e.message));

await page.goto(recordPath ? `${base}/?record=${encodeURIComponent(recordPath)}&capture` : `${base}/?seed=${seeds[0]}&capture`);
await page.waitForFunction(() => window.__kb?.ready, null, { timeout: 60000 });

await page.evaluate((c) => window.__kb!.setCamera(c), camera);
console.log(`camera: ${JSON.stringify(camera)}`);

// Drive CSS animations from game time too.
await page.evaluate(() => {
  const seen = new WeakSet<Animation>();
  (window as any).__stepAnims = (ms: number) => {
    for (const a of document.getAnimations()) {
      if (!seen.has(a)) {
        seen.add(a);
        a.pause();
        a.currentTime = 0;
      }
      a.currentTime = ((a.currentTime as number) ?? 0) + ms;
    }
  };
});

let frame = 0;
const report: string[] = [];
const pendingShots: { at: number; name: string }[] = [];
const moments: { frame: number; kind: string; weight: number; seed: number }[] = [];

for (const [mi, seed] of seeds.entries()) {
  if (mi > 0) await page.evaluate((s) => window.__kb!.newMatch(s), seed);
  // a followed fighter that goes down hands the camera back to auto: restore the demo mode each match
  await page.evaluate((c) => window.__kb!.setCamera(c), camera);
  let tail = -1;
  let lastBeat = -1;
  let checked = false;
  let dialogueN = 0;
  const countdownShot = new Set<number>();
  const t0 = performance.now();
  const tag = `m${mi + 1}-seed${seed}`;
  for (;;) {
    await page.evaluate((dt) => {
      window.__kb!.advance(dt);
      (window as any).__stepAnims(dt * 1000);
    }, 1 / FPS);
    const st = await page.evaluate(() => ({ ...window.__kb!.state(), moments: window.__kb!.drainMoments() }));
    await page.screenshot({ path: join(framesDir, `${String(frame).padStart(6, "0")}.jpg`), type: "jpeg", quality: 92 });
    for (const m of st.moments) if (m.weight > 0) moments.push({ frame, kind: m.kind, weight: m.weight, seed });
    if (st.beatIndex !== lastBeat) {
      lastBeat = st.beatIndex;
      // beat screenshots, timed to when each beat's animation has settled
      if (st.beat === "level") pendingShots.push({ at: frame + 40, name: `${tag}-level-card` });
      if (st.beat === "dialogue") pendingShots.push({ at: frame + 60, name: `${tag}-${st.dialoguePhase === "intro" ? "intro" : `between-r${st.round - 1}-r${st.round}`}-${++dialogueN}` });
      if (st.beat === "countdown" && !countdownShot.has(st.round)) {
        countdownShot.add(st.round);
        pendingShots.push({ at: frame + 6, name: `${tag}-round${st.round}-countdown` });
      }
      if (st.beat === "go") pendingShots.push({ at: frame + 5, name: `${tag}-round${st.round}-fight` });
      if (st.beat === "roundEnd") pendingShots.push({ at: frame + 20, name: `${tag}-round${st.wins.reduce((a, b) => a + b, 0)}-result` });
      if (st.beat === "celebrate") pendingShots.push({ at: frame + 85, name: `${tag}-celebrate` });
    }
    for (const p of pendingShots.filter((p) => p.at === frame)) await page.screenshot({ path: join(shotsDir, `${p.name}.png`) });
    if (st.over && !checked) {
      checked = true;
      // cross-engine determinism check: Bun replays the same seed headless
      const m = recordJson ? replayMatch(recordJson) : new Match(seed);
      if (!recordJson) m.playToEnd();
      const same = m.record.rounds.map((r) => r.fight.finalHash).join(",") === st.hash;
      report.push(
        `seed ${seed} (${m.level.theme}): browser round hashes ${st.hash}, bun ${m.record.rounds.map((r) => r.fight.finalHash).join(",")} -> ${same ? "MATCH" : "MISMATCH"}; ` +
          `${m.round} rounds (${m.results.map((r) => (r.ticks / 60).toFixed(0) + " s").join(", ")}), round winners ${m.results.map((r) => m.names[r.winner]).join(", ")}, match winner ${m.names[m.winner]} (${m.decidedBy()})`,
      );
      m.record.rounds.forEach((r, i) => report.push(`  round ${i + 1} lines: ${r.lines.map((l, j) => `${m.names[j]}: "${l}"`).join(" | ")}`));
    }
    if (st.finished && tail < 0) tail = Math.round(TAIL_SECONDS * FPS);
    frame++;
    if (tail >= 0 && --tail <= 0) {
      const fin = await page.evaluate(() => window.__kb!.state().tally);
      report.push(`  tally after match ${mi + 1}: ${fin.join(",")}`);
      break;
    }
    if (frame % 300 === 0) console.log(`frame ${frame} (match ${mi + 1}, ${st.beat}) ${((performance.now() - t0) / 1000).toFixed(0)}s`);
  }
}
await browser.close();

// best moments: highest weight, at least 2.5 s apart; screenshot a few frames after the event
const delay: Record<string, number> = { ringout: 10, ko: 8, chain: 4, barrel: 3, bighit: 2 };
const picked: typeof moments = [];
for (const m of [...moments].sort((a, b) => b.weight - a.weight || a.frame - b.frame)) {
  if (picked.length >= 8) break;
  if (picked.some((p) => Math.abs(p.frame - m.frame) < FPS * 2.5)) continue;
  picked.push(m);
}
picked.sort((a, b) => a.frame - b.frame);
for (const [i, m] of picked.entries()) {
  const f = Math.min(frame - 1, m.frame + (delay[m.kind] ?? 3));
  const src = join(framesDir, `${String(f).padStart(6, "0")}.jpg`);
  const dst = join(shotsDir, `moment-${String(i + 1).padStart(2, "0")}-seed${m.seed}-${m.kind}.png`);
  Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", "-i", src, dst]);
}

const video = join(outDir, `knockback-${seeds.join("-")}.webm`);
console.log(`encoding ${frame} frames -> ${video}`);
const enc = Bun.spawnSync([
  "ffmpeg", "-y", "-loglevel", "error",
  "-framerate", String(FPS), "-i", join(framesDir, "%06d.jpg"),
  "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "28", "-row-mt", "1", "-deadline", "good", "-cpu-used", "3",
  "-pix_fmt", "yuv420p", video,
]);
if (enc.exitCode !== 0) console.error(enc.stderr.toString());
console.log(report.join("\n"));
console.log(`moments: ${picked.map((m) => `${m.kind}@${(m.frame / FPS).toFixed(1)}s`).join(", ")}`);
await Bun.write(join(outDir, "record-report.txt"), [`camera: ${JSON.stringify(camera)}`, ...report, `frames: ${frame} at ${FPS} fps`, ...picked.map((m) => `moment ${m.kind} frame ${m.frame}`)].join("\n") + "\n");
