/** Quick look: bun scripts/shot.ts <seed> <outdir> <t1,t2,...seconds> */
import { chromium } from "playwright";
const [seed = "1", out = ".", times = "1,4,8"] = process.argv.slice(2);
const browser = await chromium.launch({ args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on("console", (m) => console.log("[page]", m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`http://localhost:5173/?seed=${seed}&capture`);
await page.waitForFunction(() => window.__kb?.ready, null, { timeout: 30000 });
let t = 0;
for (const ts of times.split(",").map(Number)) {
  const frames = Math.round((ts - t) * 30);
  const t0 = performance.now();
  await page.evaluate((n) => window.__kb!.advance(1 / 30, n), frames);
  t = ts;
  await page.screenshot({ path: `${out}/shot-${seed}-${ts}.png` });
  console.log(ts, (performance.now() - t0).toFixed(0) + "ms", JSON.stringify(await page.evaluate(() => { const s = window.__kb!.state(); return { phase: s.phase, round: s.round }; })));
}
await browser.close();
