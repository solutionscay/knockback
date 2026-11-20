/** Contact sheet for quick visual review: bun scripts/sheet.ts <seed> <out.jpg> <start> <step> [count=12] */
import { launchViewerBrowser } from "./viewer-browser";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const [seed = "1", out = "sheet.jpg", start = "2", step = "2", count = "12"] = process.argv.slice(2);
const dir = mkdtempSync(join(process.env.SHEET_TMP ?? tmpdir(), "sheet-"));
const browser = await launchViewerBrowser();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`http://localhost:5173/?seed=${seed}&capture`);
await page.waitForFunction(() => window.__kb?.ready, null, { timeout: 30000 });
let t = 0;
for (let i = 0; i < Number(count); i++) {
  const ts = Number(start) + i * Number(step);
  await page.evaluate((n) => window.__kb!.advance(1 / 30, n), Math.round((ts - t) * 30));
  t = ts;
  await page.screenshot({ path: join(dir, `${String(i).padStart(3, "0")}.png`) });
}
await browser.close();
Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", "-i", join(dir, "%03d.png"), "-vf", "scale=640:-1,tile=3x4:padding=4", "-frames:v", "1", "-q:v", "3", out]);
console.log(out);
