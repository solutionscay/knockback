/**
 * Stances and precision weapons (#38): N best-of-3 house-bot matches where every fighter plays a rotating stance and
 * leads with a rotating weapon (the souls' lines, targets and rules stay). Prints:
 *   - share of time in cover per stance (stance actually played, sampled every 0.5 s)
 *   - long-range knockouts (the knocking-out hit from 12 m or more), by weapon
 *   - weapon win rates: round win rate of the fighters who picked each weapon up (25% = even)
 *   - round length and ring-outs
 *   bun scripts/stance-batch.ts [count=200] [startSeed=1] [--json out.json] [--souls] (--souls: the souls' own plans)
 */
import { optionValue } from "./batch-options";
import { median, percent } from "./batch-stats";
import { writeFileSync } from "node:fs";
import { houseBrain, initPhysics, Match, RULE_STANCES, TICK_RATE, WEAPON_LIST, type Brain, type Stance, type Weapon } from "../src/sim";

await initPhysics();
const args = process.argv.slice(2);
const jsonIdx = args.indexOf("--json");
const jsonOut = optionValue(args, "--json");
const ownPlans = args.includes("--souls");
const pos = args.filter((a, i) => !a.startsWith("--") && (jsonIdx < 0 || i !== jsonIdx + 1));
const N = Number(pos[0] ?? 200);
const start = Number(pos[1] ?? 1);
const LONG_M = 12;

const stanceSeconds: Record<string, number> = {};
const coverSeconds: Record<string, number> = {};
const stanceRounds: Record<string, { n: number; wins: number }> = {};
const weaponRounds: Record<string, { n: number; wins: number; kos: number; damage: number }> = {};
const leadRounds: Record<string, { n: number; wins: number }> = {};
const koRange: Record<string, { all: number; long: number }> = {};
let kos = 0, longKos = 0, ringouts = 0, rounds = 0, roundTicks = 0, timeouts = 0;
const roundLengths: number[] = [];
const t0 = performance.now();

for (let i = 0; i < N; i++) {
  const seed = start + i;
  // stance and lead weapon rotate by seed, seat and round, so every pairing shows up
  const brains: Brain[] = [0, 1, 2, 3].map((seat) => (ctx) => {
    const d = houseBrain(ctx);
    if (ownPlans) return d;
    const k = seed * 7 + seat * 3 + ctx.round * 5;
    const stance = RULE_STANCES[k % RULE_STANCES.length] as Stance;
    const lead = WEAPON_LIST[(seed * 5 + seat * 7 + ctx.round * 3) % WEAPON_LIST.length]!;
    const rest = WEAPON_LIST.filter((w) => w !== lead);
    const second = rest[(seed + seat * 11 + ctx.round) % rest.length]!;
    return { ...d, strategy: { ...d.strategy, stance, weapons: [lead, second] as Weapon[] } };
  });
  const m = new Match(seed, { brains });
  m.onEvent = (e) => {
    if (e.type === "ko" && e.cause === "ringout") ringouts++;
  };
  while (!m.over) {
    const decisions = m.prepareRound();
    while (!m.step()) {
      /* step */
    }
    const f = m.finishRound();
    const st = f.stats;
    rounds++;
    roundTicks += f.seconds * TICK_RATE;
    roundLengths.push(f.seconds);
    if (f.reason === "time-out") timeouts++;
    for (let s = 0; s < 4; s++) {
      for (const [k, v] of Object.entries(st.stanceSeconds[s]!)) stanceSeconds[k] = (stanceSeconds[k] ?? 0) + v;
      for (const [k, v] of Object.entries(st.coverSeconds[s]!)) coverSeconds[k] = (coverSeconds[k] ?? 0) + v;
      const won = f.winner === s ? 1 : 0;
      const plan = decisions[s]!.strategy;
      const sr = (stanceRounds[plan.stance] ??= { n: 0, wins: 0 });
      sr.n++;
      sr.wins += won;
      const lr = (leadRounds[plan.weapons[0]!] ??= { n: 0, wins: 0 });
      lr.n++;
      lr.wins += won;
      for (const w of new Set(st.pickups[s]!.filter((p) => (WEAPON_LIST as readonly string[]).includes(p)))) {
        const wr = (weaponRounds[w] ??= { n: 0, wins: 0, kos: 0, damage: 0 });
        wr.n++;
        wr.wins += won;
      }
      for (let v = 0; v < 4; v++) if (v !== s) for (const [w, d] of Object.entries(st.damage[s]![v]!.byWeapon)) if (weaponRounds[w]) weaponRounds[w]!.damage += d.damage;
    }
    for (const k of st.kos) {
      if (k.by < 0 || k.by === k.victim) continue;
      kos++;
      const r = (koRange[k.weapon] ??= { all: 0, long: 0 });
      r.all++;
      if (weaponRounds[k.weapon]) weaponRounds[k.weapon]!.kos++;
      if ((k.range ?? 0) >= LONG_M) {
        longKos++;
        r.long++;
      }
    }
  }
}

const pct = (a: number, b: number) => (b > 0 ? percent(a, b, 1) : "-");
const out: string[] = [];
out.push(`stance batch (#38): ${N} best-of-3 matches (seeds ${start}..${start + N - 1}), ${rounds} rounds, ${((performance.now() - t0) / 1000).toFixed(1)} s wall${ownPlans ? ", the souls' own plans" : ", rotating stances and lead weapons"}`);
out.push(`round length: ${(roundTicks / rounds / TICK_RATE).toFixed(1)} s avg, median ${median(roundLengths).toFixed(1)} s, time-outs ${pct(timeouts, rounds)}`);
out.push(`ring-outs: ${(ringouts / N).toFixed(2)} per match, ${(ringouts / rounds).toFixed(2)} per round`);
out.push(`knockouts by a fighter: ${kos}; long-range (knocking-out hit from ${LONG_M} m or more): ${longKos} (${pct(longKos, kos)})`);
out.push(`  long-range KOs by weapon: ${Object.entries(koRange).filter(([, r]) => r.long).sort((a, b) => b[1].long - a[1].long).map(([w, r]) => `${w} ${r.long}/${r.all}`).join(", ") || "none"}`);
out.push(`time in cover, by stance played while armed (sampled every 0.5 s; in cover = terrain or a crate within 2.5 m blocks the nearest rival's line):`);
for (const st of Object.keys(stanceSeconds).sort((a, b) => (coverSeconds[b] ?? 0) / stanceSeconds[b]! - (coverSeconds[a] ?? 0) / stanceSeconds[a]!)) out.push(`  ${st.padEnd(9)} ${pct(coverSeconds[st] ?? 0, stanceSeconds[st]!).padStart(6)} of ${Math.round(stanceSeconds[st]!)} s`);
out.push(`round win rate by planned stance (25% = even):`);
for (const [st, r] of Object.entries(stanceRounds).sort((a, b) => b[1].wins / b[1].n - a[1].wins / a[1].n)) out.push(`  ${st.padEnd(9)} ${pct(r.wins, r.n).padStart(6)} (n=${r.n})`);
out.push(`weapon win rates: round win rate of fighters who picked the weapon up (25% = even); knockouts; damage per pickup-round:`);
for (const [w, r] of Object.entries(weaponRounds).sort((a, b) => b[1].wins / b[1].n - a[1].wins / a[1].n)) out.push(`  ${w.padEnd(12)} ${pct(r.wins, r.n).padStart(6)} (n=${r.n})  KOs ${String(r.kos).padStart(4)}  dmg/round ${(r.damage / r.n).toFixed(1)}`);
if (!ownPlans) {
  out.push(`round win rate by lead weapon in the plan:`);
  for (const [w, r] of Object.entries(leadRounds).sort((a, b) => b[1].wins / b[1].n - a[1].wins / a[1].n)) out.push(`  ${w.padEnd(12)} ${pct(r.wins, r.n).padStart(6)} (n=${r.n})`);
}
console.log(out.join("\n"));
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ N, start, rounds, roundSeconds: roundTicks / rounds / TICK_RATE, timeouts, ringouts, kos, longKos, koRange, stanceSeconds, coverSeconds, stanceRounds, weaponRounds, leadRounds }, null, 2));
