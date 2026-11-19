/**
 * Contact sheet of generated levels at the start of a fight (the level card
 * overview): bun scripts/levels.ts <out.jpg> [seeds...]   (dev server must be running)
 * With no seeds, picks two seeds per theme.
 */
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { THEMES, themeFor } from "../src/sim/levelgen";

const [out = "levels.jpg", ...rest] = process.argv.slice(2);
let seeds = rest.map(Number);
if (seeds.length === 0) {
  for (const t of THEMES) {
    let n = 0;
    for (let s = 1; n < 2; s++) if (themeFor(s) === t) (seeds.push(s), n++);
  }
}
const dir = mkdtempSync(join(process.env.SHEET_TMP ?? tmpdir(), "levels-"));
const browser = await chromium.launch({ args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(`http://localhost:5173/?seed=${seeds[0]}&capture`);
await page.waitForFunction(() => window.__kb?.ready, null, { timeout: 30000 });
for (const [i, seed] of seeds.entries()) {
  await page.evaluate((s) => window.__kb!.newMatch(s), seed);
  await page.evaluate(() => window.__kb!.advance(1 / 30, 45)); // into the level card, camera settled
  await page.waitForTimeout(700); // let the card slam-in animation finish
  await page.screenshot({ path: join(dir, `${String(i).padStart(3, "0")}.png`) });
  console.log(seed, themeFor(seed));
}
await browser.close();
const cols = 4;
const rows = Math.ceil(seeds.length / cols);
Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", "-i", join(dir, "%03d.png"), "-vf", `scale=960:-1,tile=${cols}x${rows}:padding=6:color=0x0b0d14`, "-frames:v", "1", "-q:v", "2", out]);
console.log(out, dir);
