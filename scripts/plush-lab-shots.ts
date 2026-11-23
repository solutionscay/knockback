/**
 * (#85) a 1:1 screenshot of the plush lab page (scripts/plush-lab.ts must be running). Software WebGL
 * (no GPU flags).
 *   bun scripts/plush-lab-shots.ts <lab url> <out.png> [s=45] [extra query, e.g. &plushtex=webp]
 */
import { chromium } from "playwright";

const [base = "http://localhost:5293", out = "plush-lab.png", s = "45", extra = ""] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 2400, height: 1700 }, deviceScaleFactor: 1 });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(`${base}/?s=${s}${extra}`);
await page.waitForFunction(() => (window as unknown as { __labReady?: boolean }).__labReady, null, { timeout: 60000 });
await page.waitForTimeout(500);
if (errors.length) console.error(errors.join("\n"));
console.log("plush atlases:", JSON.stringify(await page.evaluate(() => (window as unknown as { __plushMem?: { format: string; sheets: string[]; bytes: number } }).__plushMem && { ...(window as unknown as { __plushMem: { format: string; sheets: string[]; bytes: number } }).__plushMem, sheets: (window as unknown as { __plushMem: { sheets: string[] } }).__plushMem.sheets.length })));
const canvas = await page.$("canvas");
await canvas!.screenshot({ path: out });
await browser.close();
console.log(out);
