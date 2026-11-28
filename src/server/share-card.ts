import { esc, hex } from "../html";
import { portraitSvg, type Mood } from "../art/portrait";
import { modelOf } from "../stats/models";
import { type ReplaySummary } from "./replays";

/** place a portrait SVG at x,y with size w,h inside another SVG */
const placeSvg = (svg: string, x: number, y: number, w: number, h: number) => svg.replace("<svg ", `<svg x="${x}" y="${y}" width="${w}" height="${h}" `);

/** Model name of a seat label for the card: the model spotlight's name, "AGENT" when a remote agent did not say (pure). */
export function labelText(label: string): string {
  const m = modelOf(label);
  return m.key === "remote:unreported" ? "AGENT" : m.name;
}

/** The 1200x630 share card of a finished match, as SVG (pure: tested). */
export function shareCardSvg(r: ReplaySummary): string {
  const W = 1200;
  const H = 630;
  const w = r.winner >= 0 ? r.winner : 0;
  const win = r.identities[w]!;
  const col = hex(win.color);
  const name = (r.names[w] ?? "?").toUpperCase();
  const big = name.length > 8 ? 108 : 140;
  const theme = (r.theme || "arena").toUpperCase();
  const sorted = [...r.wins].sort((a, b) => b - a);
  const score = sorted.filter((x, i) => i < 2 || x > 0).join("–");
  const models = [...new Set(r.labels.map(labelText))].slice(0, 4).join(" vs ");
  const stack = (x: number, y: number, size: number, text: string, fill: string, depth: number) =>
    [...Array(depth)].map((_, k) => `<text x="${x + (depth - k)}" y="${y + (depth - k) * 1.4}" font-size="${size}" fill="#05070c">${esc(text)}</text>`).join("") + `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}">${esc(text)}</text>`;
  const losers = [0, 1, 2, 3].filter((i) => i !== w);
  const loserSvgs = losers
    .map((i, k) => {
      const id = r.identities[i]!;
      return placeSvg(portraitSvg(id, "ko" as Mood), 640 + k * 92, 384, 96, 104) + `<text x="${688 + k * 92}" y="${508}" font-size="15" fill="${hex(id.color)}" text-anchor="middle">${esc(r.names[i] ?? "")}</text>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'Arial Black', Arial, sans-serif" font-weight="900">
<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1d2233"/><stop offset="1" stop-color="#0f1424"/></linearGradient>
<radialGradient id="glow" cx="0.5" cy="0.55" r="0.5"><stop offset="0" stop-color="${col}" stop-opacity="0.35"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></radialGradient></defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<rect x="0" y="520" width="${W}" height="110" fill="#5a4630"/><rect x="0" y="520" width="${W}" height="10" fill="#6fae3e"/>
${[...Array(12)].map((_, k) => `<rect x="${k * 100 + 30}" y="${548 + (k % 3) * 18}" width="26" height="14" fill="#4a3a28"/>`).join("")}
${stack(60, 185, big, name, col, 6)}
${stack(60, 185 + big * 0.95, big, "WINS", col, 6)}
<text x="64" y="${185 + big * 0.95 + 58}" font-size="26" fill="#f4f6fb" letter-spacing="5">${esc(`${score} · ${theme} · AI VS AI`)}</text>
<text x="64" y="${185 + big * 0.95 + 96}" font-size="20" fill="#c7ccd8" font-family="Arial, sans-serif" font-weight="700">${esc(models)}</text>
<circle cx="1000" cy="330" r="230" fill="url(#glow)"/>
${placeSvg(portraitSvg(win, "win"), 830, 120, 340, 380)}
${loserSvgs}
<text x="60" y="598" font-size="34" fill="#ffd23f">KNOCKBACK</text>
<text x="318" y="596" font-size="20" fill="#f4f6fb" font-family="Arial, sans-serif" font-weight="700">AI agents plan. Physics decides.</text>
</svg>`;
}
