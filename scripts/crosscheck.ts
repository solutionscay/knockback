/**
 * Cross-engine determinism: play matches in headless Chromium (V8) and in Bun
 * (JavaScriptCore) and compare final state hashes. Needs the dev server.
 *   bun scripts/crosscheck.ts [seeds...]
 */
import { chromium } from "playwright";
import { initPhysics, Match } from "../src/sim";
const seeds = process.argv.slice(2).map(Number);
if (!seeds.length) seeds.push(1, 2, 3, 7, 42);
await initPhysics();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
await page.goto(`http://localhost:5173/?seed=${seeds[0]}&capture`);
await page.waitForFunction(() => window.__kb?.ready, null, { timeout: 60000 });
let ok = 0;
for (const seed of seeds) {
  await page.evaluate((s) => window.__kb!.newMatch(s), seed);
  const hash = await page.evaluate(() => {
    for (let i = 0; i < 20000 && !window.__kb!.state().over; i++) window.__kb!.advance(1 / 30, 10);
    return window.__kb!.state().hash;
  });
  const m = new Match(seed);
  m.playToEnd();
  const same = hash === m.record.finalHash;
  if (same) ok++;
  console.log(`seed ${seed}: chromium ${hash}  bun ${m.record.finalHash}  ${same ? "MATCH" : "MISMATCH"}`);
}
console.log(`${ok}/${seeds.length} match`);
await browser.close();
process.exit(ok === seeds.length ? 0 : 1);
