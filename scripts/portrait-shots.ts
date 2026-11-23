/**
 * #85: a sheet of the plush portraits as the pages show them (dialogue cards, plan chips, the share card's winner),
 * every mark, the moods and a spread of colors; rendered in headless Chromium (software WebGL is not needed: SVG).
 *   bun scripts/portrait-shots.ts <out.png>
 */
import { chromium } from "playwright";
import { hsl, lightnessFloor, MAJOR_MARKS, type Identity, type Mark } from "../src/sim/identity";
import { portraitSvg, type Mood } from "../src/viewer/portrait";

const out = process.argv[2] ?? "portraits.png";
const hue = (h: number) => hsl(h, 0.75, Math.min(0.8, lightnessFloor(h, 0.75) + 0.09));
const id = (i: number, mark: Mark, minor: Mark = "none"): Identity => ({ name: `P${i}`, shape: "squircle", eyes: (["tall", "dots", "big", "wide", "ring", "slit"] as const)[i % 6]!, mark, minor, color: hue((i * 47) % 360) });
const cell = (svg: string, w: number, h: number, label: string) => `<figure style="width:${w}px;margin:6px;display:inline-block;text-align:center"><div style="width:${w}px;height:${h}px">${svg}</div><figcaption>${label}</figcaption></figure>`;
const moods: Mood[] = ["fight", "cocky", "rattled", "hit", "stun", "win", "ko"];
const html = `<!doctype html><html><body style="margin:0;background:#141a2e;color:#b8c2e0;font:600 12px system-ui;padding:12px">
<style>svg{width:100%;height:100%}figcaption{margin-top:2px}</style>
<h3>Dialogue cards (about 120 px) and plan chips (about 40 px), moods</h3>
${moods.map((m, i) => cell(portraitSvg(id(i, "antenna"), m), 110, 118, m)).join("")}
${moods.map((m, i) => cell(portraitSvg(id(i, "antenna"), m, "tiny"), 40, 40, "chip")).join("")}
<h3>Every major mark (minor marks on some), card size</h3>
${MAJOR_MARKS.map((mk, i) => cell(portraitSvg(id(i + 3, mk, (["none", "bolts", "scarf", "scratch", "bandage"] as const)[i % 5]!), "fight"), 96, 104, mk)).join("")}
<h3>Share card winner (340x380) and the KO row (96x104)</h3>
${cell(portraitSvg(id(5, "crown", "scarf"), "win"), 340, 380, "winner")}
${[1, 2, 3].map((i) => cell(portraitSvg(id(i * 4, (["horns", "tophat", "beanie"] as const)[i - 1]!), "ko"), 96, 104, "ko")).join("")}
</body></html>`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
await page.setContent(html);
await page.waitForTimeout(300);
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log(out);
