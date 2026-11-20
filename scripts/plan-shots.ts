/**
 * Screenshots of plan chips, plan-change thoughts and rule tags (#10, #11)
 * from a record, at 1080p and 720p. Needs the dev server (bun run dev).
 *   bun scripts/plan-shots.ts <outdir> [/records/stub-plan-updates.json] [--sizes 1920x1080,1280x720]
 * Prints the most callouts ever on screen at once, and the chip lines.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const out = args[0] ?? "out/plan-shots";
const rec = args.find((a) => a.startsWith("/records/")) ?? "/records/stub-plan-updates.json";
const si = args.indexOf("--sizes");
const sizes = (si >= 0 ? args[si + 1]! : "1920x1080,1280x720").split(",").map((s) => s.split("x").map(Number) as [number, number]);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const report: string[] = [];
for (const [w, h] of sizes) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(String(e.message)));
  await page.goto(`http://localhost:5173/?record=${encodeURIComponent(rec)}&capture`);
  await page.waitForFunction(() => (window as any).__kb?.ready, null, { timeout: 60000 });
  const adv = (sec: number) => page.evaluate((n) => (window as any).__kb.advance(1 / 30, n), Math.round(sec * 30));
  const st = () => page.evaluate(() => (window as any).__kb.state());
  const co = () => page.evaluate(() => (window as any).__kb.callouts());
  const shot = (name: string) => page.screenshot({ path: join(out, `${name}-${h}p.png`) });
  const got = new Set<string>();
  let lastRound = 0;
  let recaps = 0;
  for (let i = 0; i < 4000; i++) {
    await adv(0.1);
    const s = await st();
    const c = await co();
    const kinds = c.visible.map((v: { kind: string }) => v.kind);
    if (s.beat === "fight" && !got.has("thought") && kinds.includes("thought")) {
      await adv(0.25);
      await shot("thought");
      got.add("thought");
      report.push(`${h}p thought: ${JSON.stringify((await co()).visible)} chips ${JSON.stringify(await page.evaluate(() => (window as any).__kb.planChips()))}`);
    }
    if (s.beat === "fight" && !got.has("rule") && kinds.includes("rule")) {
      await adv(0.2);
      await shot("rule-tag");
      got.add("rule");
      report.push(`${h}p rule tag: ${JSON.stringify((await co()).visible)} chips ${JSON.stringify(await page.evaluate(() => (window as any).__kb.planChips()))}`);
    }
    if (s.beat === "fight" && !got.has("two") && c.visible.length === 2) {
      await shot("two-callouts");
      got.add("two");
    }
    if (s.beat === "fight" && !got.has("chips") && s.round === 1 && i > 80 && c.visible.length === 0) {
      await shot("plan-chips");
      got.add("chips");
    }
    if (s.beat === "roundEnd" && s.round !== lastRound) {
      lastRound = s.round;
      await adv(1.5);
      await shot(`round${++recaps}-recap`);
    }
    if (s.beat === "dialogue" && s.dialoguePhase === "between" && !got.has("card")) {
      await adv(2.5);
      await shot("between-card");
      got.add("card");
    }
    if (s.over && s.beat === "celebrate") break;
  }
  const c = await co();
  report.push(`${h}p: peak callouts on screen ${c.peak}; shown ${c.shown.length} (${c.shown.filter((x: { kind: string }) => x.kind === "thought").length} thoughts, ${c.shown.filter((x: { kind: string }) => x.kind === "rule").length} rule tags); page errors: ${errs.length ? errs.join("; ") : "none"}`);
  await page.close();
}
await browser.close();
writeFileSync(join(out, "plan-shots.txt"), report.join("\n") + "\n");
console.log(report.join("\n"));
