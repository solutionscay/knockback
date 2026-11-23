/**
 * Stills of a local match at the game's own size (1920x1080, View all), plus 1:1 crops around each fighter (#85:
 * the plush fighters). The dev server (or the match server) must be running.
 *   bun scripts/plush-shots.ts <base url> <out dir> [seed] [fight frames, comma list]
 * Capture mode: the page steps the fight frames, waiting for the art each round loads.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchViewerBrowser } from "./viewer-browser";

const [base = "http://localhost:5291", out = "shots", seedArg = "56", momentsArg = "200,410,856,1230,1410,2600"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await launchViewerBrowser();
type Kb = NonNullable<Window["__kb"]>;
const W = 1920, H = 1080, CROP = 220;
const info: Record<string, unknown> = {};
for (const art of ["plush"]) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/?seed=${seedArg}&capture&video&sounds=off`);
  await page.waitForFunction(() => window.__kb?.ready, null, { timeout: 60000 });
  let at = 0;
  for (const m of momentsArg.split(",").map(Number)) {
    const st = await page.evaluate(async ([n, from]) => {
      const kb = window.__kb as Kb;
      let g = 0;
      if (from === 0) while (kb.state().beat !== "fight" && g++ < 20000) kb.advance(1 / 60, 1, false);
      kb.advance(1 / 60, n - from, false);
      kb.advance(1 / 60, 1, true);
      await kb.settle();
      return kb.state();
    }, [m, at] as const);
    at = m + 1;
    if (errors.length) throw new Error(errors[0]);
    const name = `f${String(m).padStart(4, "0")}`;
    await page.screenshot({ path: join(out, `${art}-${name}.png`) });
    const v = st.view!;
    const crops = st.fighters.map((f, i) => {
      const x = Math.round(W / 2 + (f.x - v.cx - v.shx) * v.s - CROP / 2);
      const y = Math.round(H / 2 - (f.y - v.cy - v.shy) * v.s - CROP / 2 - 0.3 * v.s);
      return { i, x: Math.max(0, Math.min(W - CROP, x)), y: Math.max(0, Math.min(H - CROP, y)), alive: f.alive };
    });
    for (const c of crops) if (c.alive) await page.screenshot({ path: join(out, `${art}-${name}-p${c.i}.png`), clip: { x: c.x, y: c.y, width: CROP, height: CROP } });
    info[`${art}-${name}`] = { s: v.s, tick: st.tick, crops };
  }
  await page.close();
}
writeFileSync(join(out, "shots.json"), JSON.stringify(info, null, 1));
await browser.close();
console.log("shots ->", out);
