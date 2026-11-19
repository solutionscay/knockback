/**
 * Run N bot matches headless and print stats.
 *   bun scripts/batch.ts [count=200] [startSeed=1] [--json out.json]
 */
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
  rounds: number;
  seconds: number;
  winner: number;
  winnerAliveAtEnd: boolean;
  survivors: number;
  kos: number;
  ringouts: number;
  hpKos: number;
  zoneKos: number;
  blocks: number;
  crates: number;
  barrels: number;
  chainBarrels: number;
  barrelToBarrel: number;
  pickups: number;
  bigHits: number;
  firstKoRound: number;
}

const rows: Row[] = [];
const t0 = performance.now();
for (let i = 0; i < N; i++) {
  const seed = start + i;
  const m = new Match(seed);
  let ticks = 0;
  let ringouts = 0;
  let hpKos = 0;
  let zoneKos = 0;
  let pickups = 0;
  let bigHits = 0;
  let firstKoRound = 0;
  m.onEvent = (e) => {
    if (e.type === "ko") {
      if (e.cause === "ringout") ringouts++;
      else if (e.cause === "zone") zoneKos++;
      else hpKos++;
      if (!firstKoRound) firstKoRound = m.round;
    } else if (e.type === "pickup") pickups++;
    else if (e.type === "hit" && e.kb >= 14) bigHits++;
  };
  while (!m.over) {
    m.startRound();
    while (!m.stepAction()) ticks++;
    ticks++;
    m.endRound();
  }
  const s = m.sim.stats;
  const survivors = m.sim.alive().length;
  rows.push({
    seed,
    rounds: m.round,
    seconds: ticks / TICK_RATE,
    winner: m.winner(),
    winnerAliveAtEnd: survivors > 0,
    survivors,
    kos: ringouts + hpKos + zoneKos,
    ringouts,
    hpKos,
    zoneKos,
    blocks: s.blocksDestroyed,
    crates: s.cratesDestroyed,
    barrels: s.barrelsExploded,
    chainBarrels: s.chainBarrels,
    barrelToBarrel: s.barrelToBarrel,
    pickups,
    bigHits,
    firstKoRound,
  });
}
const ms = performance.now() - t0;

const avg = (f: (r: Row) => number) => rows.reduce((a, r) => a + f(r), 0) / rows.length;
const share = (f: (r: Row) => boolean) => (100 * rows.filter(f).length) / rows.length;
const pct = (v: number) => `${v.toFixed(0)}%`;
const hist = (f: (r: Row) => number) => {
  const h = new Map<number, number>();
  for (const r of rows) h.set(f(r), (h.get(f(r)) ?? 0) + 1);
  return [...h.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join("  ");
};

const out: string[] = [];
out.push(`matches: ${N} (seeds ${start}..${start + N - 1}), ${(ms / 1000).toFixed(1)} s wall, ${(ms / N).toFixed(0)} ms/match`);
out.push(`match length: ${avg((r) => r.rounds).toFixed(2)} rounds avg, ${avg((r) => r.seconds).toFixed(1)} s of physics avg`);
out.push(`  rounds histogram: ${hist((r) => r.rounds)}`);
out.push(`  survivors at end: ${hist((r) => r.survivors)}`);
out.push(`wins by fighter:`);
for (let i = 0; i < FIGHTER_DEFS.length; i++) {
  const d = FIGHTER_DEFS[i]!;
  out.push(`  ${d.name.padEnd(5)} (${d.personality.padEnd(11)}): ${pct(share((r) => r.winner === i))}`);
}
out.push(`knockouts per match: ${avg((r) => r.kos).toFixed(2)} (ring-out ${avg((r) => r.ringouts).toFixed(2)}, hp ${avg((r) => r.hpKos).toFixed(2)}, zone ${avg((r) => r.zoneKos).toFixed(2)})`);
out.push(`first knockout in round: ${avg((r) => r.firstKoRound || 0).toFixed(2)} avg`);
out.push(`blocks destroyed per match: ${avg((r) => r.blocks).toFixed(1)}   crates: ${avg((r) => r.crates).toFixed(1)}`);
out.push(`barrels exploded per match: ${avg((r) => r.barrels).toFixed(2)} of 9`);
out.push(`big hits (knockback >= 14 m/s) per match: ${avg((r) => r.bigHits).toFixed(1)}   item pickups: ${avg((r) => r.pickups).toFixed(2)}`);
out.push(`matches with a chain reaction (barrel set off by any explosion): ${pct(share((r) => r.chainBarrels > 0))}`);
out.push(`matches with a barrel-to-barrel chain: ${pct(share((r) => r.barrelToBarrel > 0))}`);
out.push(`matches with a ring-out: ${pct(share((r) => r.ringouts > 0))}`);
console.log(out.join("\n"));
if (jsonOut) await Bun.write(jsonOut, JSON.stringify({ summary: out, rows }, null, 2));
