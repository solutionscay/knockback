/**
 * Run N bot fights headless (each on its own generated level) and print stats.
 *   bun scripts/batch.ts [count=200] [startSeed=1] [--json out.json]
 */
import { scoreFight, Tally } from "../src/flow/score";
import { FIGHTER_DEFS, initPhysics, Match, POWER_LIST, TICK_RATE, WEAPON_LIST, type ItemType } from "../src/sim";

await initPhysics();
const args = process.argv.slice(2);
const jsonIdx = args.indexOf("--json");
const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null;
const pos = args.filter((a, i) => !a.startsWith("--") && (jsonIdx < 0 || i !== jsonIdx + 1));
const N = Number(pos[0] ?? 200);
const start = Number(pos[1] ?? 1);

interface Row {
  seed: number;
  theme: string;
  levelAttempt: number;
  width: number;
  seconds: number;
  tps: number;
  firstContact: number;
  firstKo: number;
  winner: number;
  reason: string;
  survivors: number;
  ringouts: number;
  hpKos: number;
  koWeapons: string[];
  fired: Record<string, number>;
  stats: Record<string, number>;
  destroyedShare: number;
  bigHits: number;
  pickups: ItemType[][]; // per fighter
  points: number[];
  strategies: string[];
  maxColliders: number;
  maxBodies: number;
}

const rows: Row[] = [];
const tally = new Tally();
const t0 = performance.now();
for (let i = 0; i < N; i++) {
  const seed = start + i;
  const ts = performance.now();
  const m = new Match(seed);
  let ringouts = 0;
  let hpKos = 0;
  let bigHits = 0;
  let firstContact = -1;
  let firstKo = -1;
  const koWeapons: string[] = [];
  const fired: Record<string, number> = {};
  let maxColliders = 0;
  let maxBodies = 0;
  m.onEvent = (e) => {
    if (e.type === "ko") {
      if (e.cause === "ringout") ringouts++;
      else hpKos++;
      koWeapons.push(e.weapon);
      if (firstKo < 0) firstKo = e.tick / TICK_RATE;
    } else if (e.type === "fire") fired[e.weapon] = (fired[e.weapon] ?? 0) + 1;
    else if (e.type === "hit") {
      if (e.source >= 0 && e.source !== e.target && firstContact < 0) firstContact = e.tick / TICK_RATE;
      if (e.kb >= 14) bigHits++;
    }
  };
  while (!m.step()) {
    if (m.sim.tick % 300 === 0) {
      maxColliders = Math.max(maxColliders, m.sim.world.colliders.len());
      maxBodies = Math.max(maxBodies, m.sim.world.bodies.len());
    }
  }
  const ms = performance.now() - ts;
  const r = m.result();
  tally.add(r);
  rows.push({
    seed,
    theme: m.sim.level.theme,
    levelAttempt: m.sim.level.attempt,
    width: m.sim.level.width,
    seconds: r.ticks / TICK_RATE,
    tps: r.ticks / (ms / 1000),
    firstContact,
    firstKo,
    winner: r.winner,
    reason: r.reason,
    survivors: r.survivors.length,
    ringouts,
    hpKos,
    koWeapons,
    fired,
    stats: { ...m.sim.stats },
    destroyedShare: m.sim.destroyedShare(),
    bigHits,
    pickups: m.sim.fighters.map((f) => f.pickups.slice()),
    points: scoreFight(r).map((p) => p.total),
    strategies: m.strategies.map((x) => `${x.stance}/${x.loadout.join("+")}/${x.target}`),
    maxColliders,
    maxBodies,
  });
}
const ms = performance.now() - t0;

const avg = (f: (r: Row) => number, rs = rows) => rs.reduce((a, r) => a + f(r), 0) / Math.max(1, rs.length);
const share = (f: (r: Row) => boolean, rs = rows) => (100 * rs.filter(f).length) / Math.max(1, rs.length);
const pct = (v: number) => `${v.toFixed(0)}%`;
const sorted = rows.map((r) => r.seconds).sort((a, b) => a - b);
const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
const count = (xs: string[]) => {
  const h: Record<string, number> = {};
  for (const x of xs) h[x] = (h[x] ?? 0) + 1;
  return Object.entries(h).sort((a, b) => b[1] - a[1]);
};
const st = (k: string) => avg((r) => r.stats[k] ?? 0);

const out: string[] = [];
out.push(`fights: ${N} (seeds ${start}..${start + N - 1}), ${(ms / 1000).toFixed(1)} s wall, ${(ms / N).toFixed(0)} ms/fight, ${avg((r) => r.tps).toFixed(0)} ticks/s headless (${(avg((r) => r.tps) / TICK_RATE).toFixed(0)}x real time)`);
out.push(`levels: ${count(rows.map((r) => r.theme)).map(([k, v]) => `${k} ${v}`).join(", ")}; generator attempts avg ${avg((r) => r.levelAttempt + 1).toFixed(2)}, max ${Math.max(...rows.map((r) => r.levelAttempt + 1))}; width ${Math.min(...rows.map((r) => r.width))}-${Math.max(...rows.map((r) => r.width))} m`);
out.push(`physics load: peak ${avg((r) => r.maxColliders).toFixed(0)} colliders / ${avg((r) => r.maxBodies).toFixed(0)} bodies per fight on average (max ${Math.max(...rows.map((r) => r.maxColliders))} / ${Math.max(...rows.map((r) => r.maxBodies))})`);
out.push(`fight length: ${avg((r) => r.seconds).toFixed(1)} s avg (p10 ${q(0.1).toFixed(0)} s, median ${q(0.5).toFixed(0)} s, p90 ${q(0.9).toFixed(0)} s); in 45-90 s: ${pct(share((r) => r.seconds >= 45 && r.seconds <= 90))}`);
for (const th of ["warehouse", "rooftop", "junkyard", "construction"]) {
  const rs = rows.filter((r) => r.theme === th);
  if (rs.length) out.push(`  ${th.padEnd(12)} ${avg((r) => r.seconds, rs).toFixed(1)} s, ${avg((r) => r.ringouts, rs).toFixed(2)} ring-outs, ${(100 * avg((r) => r.destroyedShare, rs)).toFixed(1)}% of level destroyed`);
}
out.push(`  first fighter-vs-fighter hit ${avg((r) => r.firstContact).toFixed(1)} s, first knockout ${avg((r) => r.firstKo).toFixed(1)} s; endings: ${count(rows.map((r) => r.reason)).map(([k, v]) => `${k} ${v}`).join(", ")}`);
out.push(`wins by fighter (win 3 / knockout 1 points):`);
for (let i = 0; i < FIGHTER_DEFS.length; i++) {
  const d = FIGHTER_DEFS[i]!;
  out.push(`  ${d.name.padEnd(5)} (${d.personality.padEnd(11)}): ${pct(share((r) => r.winner === i)).padStart(4)} wins, ${String(tally.points[i]).padStart(4)} pts`);
}
out.push(`knockouts per fight: ${avg((r) => r.ringouts + r.hpKos).toFixed(2)} (ring-out ${avg((r) => r.ringouts).toFixed(2)}, health ${avg((r) => r.hpKos).toFixed(2)}); fights with a ring-out: ${pct(share((r) => r.ringouts > 0))}`);
const allKo = rows.flatMap((r) => r.koWeapons);
out.push(`knockouts by cause (last hit): ${count(allKo).map(([k, v]) => `${k} ${v} (${((100 * v) / allKo.length).toFixed(0)}%)`).join(", ")}`);
const firedTot: Record<string, number> = {};
for (const r of rows) for (const [k, v] of Object.entries(r.fired)) firedTot[k] = (firedTot[k] ?? 0) + v;
out.push(`weapon use per fight: ${WEAPON_LIST.map((w) => `${w} ${((firedTot[w] ?? 0) / N).toFixed(1)}`).join(", ")}`);
out.push(`kills per 100 uses: ${WEAPON_LIST.map((w) => `${w} ${((100 * allKo.filter((k) => k === w).length) / Math.max(1, firedTot[w] ?? 0)).toFixed(1)}`).join(", ")}`);
out.push(`destruction per fight: ${st("cellsDestroyed").toFixed(0)} cells destroyed + ${st("cellsDetached").toFixed(0)} knocked loose = ${(100 * avg((r) => r.destroyedShare)).toFixed(1)}% of the level (max ${(100 * Math.max(...rows.map((r) => r.destroyedShare))).toFixed(0)}%); ${st("piecesFallen").toFixed(1)} pieces fell, ${st("platformsFallen").toFixed(1)} of them platform-sized (4+ cells); ${st("blocksDestroyed").toFixed(1)} cover blocks broken`);
out.push(`objects per fight: barrels ${st("barrelsExploded").toFixed(1)}, TNT ${st("tntExploded").toFixed(2)}, gas launched ${st("gasLaunched").toFixed(2)}, glass shattered ${st("glassShattered").toFixed(2)}, weights dropped ${st("weightsDropped").toFixed(2)}, pad bounces ${st("bounces").toFixed(2)}, crates ${st("cratesDestroyed").toFixed(1)}, props dropped in ${st("propsDropped").toFixed(1)}`);
out.push(`fights with a chain reaction (barrel/TNT/gas set off by an explosion): ${pct(share((r) => (r.stats.chainBarrels ?? 0) > 0))}; barrel-to-barrel/TNT chain: ${pct(share((r) => (r.stats.barrelToBarrel ?? 0) > 0))}`);
out.push(`big hits (knockback >= 14 m/s) per fight: ${avg((r) => r.bigHits).toFixed(1)}`);
const fighterRows = rows.flatMap((r) => r.pickups.map((p, i) => ({ p, win: r.winner === i })));
out.push(`pickups per fight: ${avg((r) => r.pickups.reduce((a, p) => a + p.length, 0)).toFixed(2)}; win rate of fighters who picked up...`);
for (const it of [...POWER_LIST, ...WEAPON_LIST] as ItemType[]) {
  const got = fighterRows.filter((x) => x.p.includes(it));
  if (got.length < 3) continue;
  out.push(`  ${it.padEnd(8)} ${String(got.length).padStart(4)} times, won ${pct((100 * got.filter((x) => x.win).length) / got.length)}`);
}
const none = fighterRows.filter((x) => x.p.length === 0);
out.push(`  nothing   ${String(none.length).padStart(4)} fighters, won ${pct((100 * none.filter((x) => x.win).length) / Math.max(1, none.length))} (baseline 25%)`);
const loadWins = count(rows.map((r) => r.strategies[r.winner]!.split("/")[1]!)).slice(0, 6);
out.push(`winning loadouts (top): ${loadWins.map(([k, v]) => `${k} ${v}`).join(", ")}`);
console.log(out.join("\n"));
if (jsonOut) await Bun.write(jsonOut, JSON.stringify({ summary: out, tally: tally.toJSON(), rows }, null, 2));
