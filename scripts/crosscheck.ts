/**
 * Cross-engine determinism: play matches in headless Chromium (V8) and in Bun
 * (JavaScriptCore) and compare final state hashes. Needs the dev server.
 *   bun scripts/crosscheck.ts [seeds...]
 *   bun scripts/crosscheck.ts --port 5199 --record records/stub-plan-updates.json [--record ...]
 * --record replays a saved record (served by the dev server from records/) in
 * both engines, e.g. one with mid-round plan updates (#8).
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { chromium } from "playwright";
import { initPhysics, Match, replayMatch } from "../src/sim";

const argv = process.argv.slice(2);
const seeds: number[] = [];
const records: string[] = [];
let port = 5173;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--port") port = Number(argv[++i]);
  else if (a === "--record") records.push(argv[++i]!);
  else seeds.push(Number(a));
}
if (!seeds.length && !records.length) seeds.push(1, 2, 3, 7, 42);
await initPhysics();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
await page.goto(`http://localhost:${port}/?seed=${seeds[0] ?? 1}&capture`);
await page.waitForFunction(() => window.__kb?.ready, null, { timeout: 60000 });
const playOut = () =>
  page.evaluate(() => {
    for (let i = 0; i < 20000 && !window.__kb!.state().over; i++) window.__kb!.advance(1 / 30, 10, false);
    return window.__kb!.state().hash;
  });
let ok = 0;
for (const seed of seeds) {
  await page.evaluate((s) => window.__kb!.newMatch(s), seed);
  const hash = await playOut();
  const m = new Match(seed);
  m.playToEnd();
  const bun = m.record.rounds.map((r) => r.fight.finalHash).join(",");
  const same = hash === bun;
  if (same) ok++;
  console.log(`seed ${seed}: chromium ${hash}  bun ${bun}  ${same ? "MATCH" : "MISMATCH"}`);
}
for (const file of records) {
  const rec = JSON.parse(readFileSync(file, "utf8"));
  await page.evaluate((url) => window.__kb!.loadRecord(url), `/records/${basename(file)}`);
  const hash = await playOut();
  const bun = replayMatch(rec).record.rounds.map((r) => r.fight.finalHash).join(",");
  const saved = rec.rounds.map((r: { fight: { finalHash: string } }) => r.fight.finalHash).join(",");
  const ups = rec.rounds.reduce((n: number, r: { planUpdates?: unknown[] }) => n + (r.planUpdates?.length ?? 0), 0);
  const same = hash === bun && bun === saved;
  if (same) ok++;
  console.log(`record ${basename(file)} (${ups} plan updates): chromium ${hash}  bun ${bun}  saved ${saved}  ${same ? "MATCH" : "MISMATCH"}`);
}
const n = seeds.length + records.length;
console.log(`${ok}/${n} match`);
await browser.close();
process.exit(ok === n ? 0 : 1);
