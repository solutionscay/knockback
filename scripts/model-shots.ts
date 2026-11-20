/**
 * Screenshots of the model badges (model spotlight) from a record: the dialogue card, the fight HUD chips,
 * the round end, the win screen and scoreboard. Needs the dev server (bun run dev).
 *   bun scripts/model-shots.ts <outdir> /records/<file>.json [--sizes 1280x720,1920x1080] [--cards 2] [--base http://localhost:5173]
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const out = args[0] ?? "out/model-shots";
const rec = args.find((a) => a.startsWith("/records/"));
if (!rec) throw new Error("usage: bun scripts/model-shots.ts <outdir> /records/<file>.json");
const opt = (k: string) => (args.indexOf(k) >= 0 ? args[args.indexOf(k) + 1] : undefined);
const sizes = (opt("--sizes") ?? "1280x720,1920x1080").split(",").map((s) => s.split("x").map(Number) as [number, number]);
const base = opt("--base") ?? "http://localhost:5173";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
for (const [w, h] of sizes) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(String(e.message)));
  await page.goto(`${base}/?record=${encodeURIComponent(rec)}&capture&thoughts=off`);
  await page.waitForFunction(() => (window as any).__kb?.ready, null, { timeout: 60000 });
  await page.evaluate(() => (window as any).__kb.setCamera({ kind: "all" }));
  const adv = (sec: number) => page.evaluate((n) => (window as any).__kb.advance(1 / 30, n), Math.round(sec * 30));
  const st = () => page.evaluate(() => (window as any).__kb.state());
  // CSS entrance animations run on the wall clock (capture mode only steps the game): let them finish first
  const shot = async (name: string) => {
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(out, `${name}-${h}p.png`) });
  };
  const got = new Set<string>();
  let dialogues = 0;
  let lastBeat = -1;
  for (let i = 0; i < 20000 && !got.has("win"); i++) {
    await adv(0.1);
    const s = await st();
    if (s.beatIndex !== lastBeat) {
      lastBeat = s.beatIndex;
      if (s.beat === "dialogue" && ++dialogues <= (Number(opt("--cards")) || 2)) {
        await adv(1.6); // the line types out
        await shot(`card-${dialogues}`);
      }
      if (s.beat === "roundEnd" && !got.has(`round${s.round}`)) {
        got.add(`round${s.round}`);
        await adv(1.4);
        await shot(`round-end-${got.size}`);
      }
      if (s.beat === "celebrate") {
        await adv(3.2); // the scoreboard slides in and the bars grow
        await shot("win");
        got.add("win");
      }
    }
    if (s.beat === "fight" && !got.has("hud") && i > 0) {
      await adv(6);
      await shot("hud");
      got.add("hud");
    }
  }
  console.log(`${w}x${h}: ${[...got].join(", ")}${errs.length ? `; page errors: ${errs.join(" | ")}` : ""}`);
  await page.close();
}
await browser.close();
