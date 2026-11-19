/**
 * Browser performance: run the viewer in real time (not capture mode) for a
 * while during the fight and report frames per second and frame times.
 *   bun scripts/fps.ts [seed] [seconds=20]   (dev server must be running)
 */
import { chromium } from "playwright";
const [seed = "4", secs = "20"] = process.argv.slice(2);
const browser = await chromium.launch({ args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(`http://localhost:5173/?seed=${seed}&hold`);
await page.waitForTimeout(16000); // level card + intros + countdown, into the fight
const r = await page.evaluate(async (ms) => {
  const times: number[] = [];
  let last = performance.now();
  const t0 = last;
  await new Promise<void>((done) => {
    const f = (t: number) => {
      times.push(t - last);
      last = t;
      if (t - t0 < ms) requestAnimationFrame(f);
      else done();
    };
    requestAnimationFrame(f);
  });
  times.sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  return { frames: times.length, fps: 1000 / avg, p50: times[Math.floor(times.length / 2)], p95: times[Math.floor(times.length * 0.95)], max: times[times.length - 1] };
}, Number(secs) * 1000);
console.log(JSON.stringify(r));
await browser.close();
