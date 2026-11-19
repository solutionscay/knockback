/**
 * Run N bot fights headless and print stats.
 *   bun scripts/batch.ts [count=200] [startSeed=1] [--json out.json]
 */
import { scoreFight, Tally } from "../src/flow/score";
import { FIGHTER_DEFS, initPhysics, Match, TICK_RATE } from "../src/sim";

await initPhysics();
const args = process.argv.slice(2);
const jsonIdx = args.indexOf("--json");
const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null;
const pos = args.filter((a, i) => !a.startsWith("--") && (jsonIdx < 0 || i !== jsonIdx + 1));
const N = Number(pos[0] ?? 200);
const start = Number(pos[1] ?? 1);

interface Row {
  seed: number;
  seconds: number;
  firstContact: number; // seconds until the first fighter-on-fighter damage
  firstKo: number; // seconds, -1 if none
  winner: number;
  reason: string;
  survivors: number;
  kos: number;
  ringouts: number;
  hpKos: number;
  blocks: number;
  barrels: number;
  barrelsDropped: number;
  chainBarrels: number;
  barrelToBarrel: number;
  bigHits: number;
  shotgunHits: number;
  pickups: number;
  points: number[];
  strategies: string[];
}

const rows: Row[] = [];
const tally = new Tally();
const t0 = performance.now();
for (let i = 0; i < N; i++) {
  const seed = start + i;
  const m = new Match(seed);
  let ringouts = 0;
  let hpKos = 0;
  let pickups = 0;
  let bigHits = 0;
  let shotgunHits = 0;
  let firstContact = -1;
  let firstKo = -1;
  m.onEvent = (e) => {
    if (e.type === "ko") {
      if (e.cause === "ringout") ringouts++;
      else hpKos++;
      if (firstKo < 0) firstKo = e.tick / TICK_RATE;
    } else if (e.type === "pickup") pickups++;
    else if (e.type === "hit") {
      if (e.source >= 0 && e.source !== e.target && firstContact < 0) firstContact = e.tick / TICK_RATE;
      if (e.kb >= 14) bigHits++;
      if (e.cause === "shotgun") shotgunHits++;
    }
  };
  m.playToEnd();
  const r = m.result();
  tally.add(r);
  const s = m.sim.stats;
  rows.push({
    seed,
    seconds: r.ticks / TICK_RATE,
    firstContact,
    firstKo,
    winner: r.winner,
    reason: r.reason,
    survivors: r.survivors.length,
    kos: ringouts + hpKos,
    ringouts,
    hpKos,
    blocks: s.blocksDestroyed,
    barrels: s.barrelsExploded,
    barrelsDropped: s.barrelsDropped,
    chainBarrels: s.chainBarrels,
    barrelToBarrel: s.barrelToBarrel,
    bigHits,
    shotgunHits,
    pickups,
    points: scoreFight(r).map((p) => p.total),
    strategies: m.strategies.map((x) => `${x.stance}/${x.weapon}/${x.target}`),
  });
}
const ms = performance.now() - t0;

const avg = (f: (r: Row) => number) => rows.reduce((a, r) => a + f(r), 0) / rows.length;
const share = (f: (r: Row) => boolean) => (100 * rows.filter(f).length) / rows.length;
const pct = (v: number) => `${v.toFixed(0)}%`;
const sorted = rows.map((r) => r.seconds).sort((a, b) => a - b);
const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
const hist = (f: (r: Row) => number | string) => {
  const h = new Map<number | string, number>();
  for (const r of rows) h.set(f(r), (h.get(f(r)) ?? 0) + 1);
  return [...h.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}:${v}`).join("  ");
};

const out: string[] = [];
out.push(`fights: ${N} (seeds ${start}..${start + N - 1}), ${(ms / 1000).toFixed(1)} s wall, ${(ms / N).toFixed(0)} ms/fight`);
out.push(`fight length: ${avg((r) => r.seconds).toFixed(1)} s avg (p10 ${q(0.1).toFixed(0)} s, median ${q(0.5).toFixed(0)} s, p90 ${q(0.9).toFixed(0)} s)`);
out.push(`  share in the 45-90 s target: ${pct(share((r) => r.seconds >= 45 && r.seconds <= 90))}, shorter: ${pct(share((r) => r.seconds < 45))}`);
out.push(`  first fighter-vs-fighter hit: ${avg((r) => r.firstContact).toFixed(1)} s avg; first knockout: ${avg((r) => r.firstKo).toFixed(1)} s avg`);
out.push(`  how it ended: ${hist((r) => r.reason)}`);
out.push(`wins by fighter (points over all ${N} fights, win 3 / knockout 1):`);
for (let i = 0; i < FIGHTER_DEFS.length; i++) {
  const d = FIGHTER_DEFS[i]!;
  out.push(`  ${d.name.padEnd(5)} (${d.personality.padEnd(11)}): ${pct(share((r) => r.winner === i)).padStart(4)} wins, ${String(tally.points[i]).padStart(4)} pts`);
}
const rushWins = rows.filter((r) => r.strategies[r.winner]!.startsWith("rush")).length;
const rushPicks = rows.reduce((a, r) => a + r.strategies.filter((s) => s.startsWith("rush")).length, 0);
out.push(`  rush strategies: ${((100 * rushPicks) / (rows.length * 4)).toFixed(0)}% of picks, ${pct((100 * rushWins) / rows.length)} of wins`);
out.push(`knockouts per fight: ${avg((r) => r.kos).toFixed(2)} (ring-out ${avg((r) => r.ringouts).toFixed(2)}, health ${avg((r) => r.hpKos).toFixed(2)})`);
out.push(`shotgun hits per fight: ${avg((r) => r.shotgunHits).toFixed(1)}   big hits (knockback >= 14 m/s): ${avg((r) => r.bigHits).toFixed(1)}`);
out.push(`blocks destroyed: ${avg((r) => r.blocks).toFixed(1)}   barrels exploded: ${avg((r) => r.barrels).toFixed(2)} (map has 9, ${avg((r) => r.barrelsDropped).toFixed(1)} more dropped in)`);
out.push(`item pickups: ${avg((r) => r.pickups).toFixed(2)}`);
out.push(`fights with a chain reaction (barrel set off by any explosion): ${pct(share((r) => r.chainBarrels > 0))}`);
out.push(`fights with a barrel-to-barrel chain: ${pct(share((r) => r.barrelToBarrel > 0))}`);
out.push(`fights with a ring-out: ${pct(share((r) => r.ringouts > 0))}`);
console.log(out.join("\n"));
if (jsonOut) await Bun.write(jsonOut, JSON.stringify({ summary: out, tally: tally.toJSON(), rows }, null, 2));
