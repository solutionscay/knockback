/**
 * Camera modes: screenshots of each mode, and proof that the camera is view-only
 * (a browser match with the camera switching every 2 s ends on the same state
 * hash as Bun playing the same seed headless).
 *   bun scripts/cammodes.ts <outdir> [seed=95]   (dev server must be running)
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchViewerBrowser } from "./viewer-browser";
import { initPhysics, Match } from "../src/sim";

const [out = "out", seedArg = "95"] = process.argv.slice(2);
const seed = Number(seedArg);
mkdirSync(out, { recursive: true });
await initPhysics();
const browser = await launchViewerBrowser();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on("pageerror", (e) => console.error("[pageerror]", e.message));
await page.goto(`http://localhost:5173/?seed=${seed}&capture`);
await page.waitForFunction(() => window.__kb?.ready, null, { timeout: 30000 });
type Mode = { kind: "auto" } | { kind: "all" } | { kind: "follow"; id: number };
const adv = (sec: number) => page.evaluate((n) => window.__kb!.advance(1 / 30, n), Math.round(sec * 30));
const cam = (m: Mode) => page.evaluate((mm) => window.__kb!.setCamera(mm), m);
const state = () => page.evaluate(() => window.__kb!.state());
const shot = async (name: string) => {
  await page.waitForTimeout(300); // let the bar's CSS settle
  await page.screenshot({ path: join(out, name) });
  console.log("shot", name, (await state()).camera);
};

// ---- screenshots of each mode, same moment of the same fight
await cam({ kind: "auto" });
await adv(22); // level card, intros, countdown, into the fight
await cam({ kind: "auto" });
await adv(1.5);
await shot("1-auto.png");
await cam({ kind: "all" });
await adv(2.5);
await shot("2-view-all.png");
const alive = (await state()).alive;
const pick = alive.findIndex((a) => a);
await cam({ kind: "follow", id: pick });
await adv(1.5);
await shot(`3-follow-fighter-${pick + 1}.png`);
// follow someone until they are knocked out, then show the hand-back to auto
let victim = -1;
for (let t = 0; t < 120 && victim < 0; t++) {
  const st = await state();
  if (st.over) break;
  const living = st.alive.map((a, i) => (a ? i : -1)).filter((i) => i >= 0);
  // follow whoever is weakest: most likely to be knocked out next
  const weakest = living.reduce((a, b) => (st.hp[b]! < st.hp[a]! ? b : a));
  const cur = JSON.parse(st.camera);
  if (cur.kind !== "follow" || !st.alive[cur.id] || cur.id !== weakest) await cam({ kind: "follow", id: weakest });
  const before = st.alive;
  await adv(0.5);
  const after = (await state()).alive;
  const f = JSON.parse((await state()).camera);
  if (f.kind === "follow" && before[f.id] && !after[f.id]) victim = f.id;
}
if (victim >= 0) {
  await adv(0.6);
  await shot(`4-follow-knocked-out-fighter-${victim + 1}.png`);
  await adv(2.0);
  await shot("5-follow-lost-back-to-auto.png");
}

// ---- view-only proof: whole match with the camera changing every 2 s
await page.evaluate((s) => window.__kb!.newMatch(s), seed);
const modes: Mode[] = [{ kind: "auto" }, { kind: "all" }, { kind: "follow", id: 0 }, { kind: "follow", id: 1 }, { kind: "follow", id: 2 }, { kind: "follow", id: 3 }];
let i = 0;
let switches = 0;
for (let k = 0; k < 400; k++) {
  const st = await state();
  if (st.over) break;
  await cam(modes[i++ % modes.length]!);
  switches++;
  await adv(2);
}
const hash = (await state()).hash;
const m = new Match(seed);
m.playToEnd();
const line = `seed ${seed}: browser hash with ${switches} camera switches ${hash}, Bun headless hash ${m.record.rounds.map((r) => r.fight.finalHash).join(",")} -> ${hash === m.record.rounds.map((r) => r.fight.finalHash).join(",") ? "MATCH (camera is view-only)" : "MISMATCH"}`;
console.log(line);
await Bun.write(join(out, "view-only-check.txt"), line + "\n");
await browser.close();
