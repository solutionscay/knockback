/**
 * Balance check for equal fighters: N headless house-bot matches with the
 * example souls rotated across seats (match k: seat i gets soul (i+k) % 4).
 * Reports win spread per seat and per soul, time to first weapon pickup,
 * pickups per round, and knockouts per weapon.
 *   bun scripts/equal-batch.ts [N=200] [firstSeed=1]
 */
import { exampleSouls, initPhysics, Match, WEAPON_LIST, type Weapon } from "../src/sim";

await initPhysics();
const N = Number(process.argv[2] ?? 200);
const first = Number(process.argv[3] ?? 1);
const souls = exampleSouls();
const seatRounds = [0, 0, 0, 0];
const seatMatches = [0, 0, 0, 0];
const soulRounds = [0, 0, 0, 0];
const soulMatches = [0, 0, 0, 0];
const firstWeapon: number[] = [];
let neverArmed = 0;
let fighterRounds = 0;
const pickupsPerRound: number[] = [];
const weaponPickups: number[] = [];
const kills: Record<string, number> = {};
const roundSecs: number[] = [];
const wishes: Record<string, Record<string, number>> = {};
const t0 = performance.now();
for (let k = 0; k < N; k++) {
  const seed = first + k;
  const rot = k % 4;
  const order = [0, 1, 2, 3].map((i) => (i + rot) % 4);
  const m = new Match(seed, { souls: order.map((i) => souls[i]!) });
  while (!m.over) {
    m.prepareRound();
    const fw = [-1, -1, -1, -1];
    let picks = 0;
    let wpicks = 0;
    m.onEvent = (e) => {
      if (e.type === "pickup") {
        picks++;
        if (WEAPON_LIST.includes(e.item as Weapon)) {
          wpicks++;
          if (fw[e.fighter]! < 0) fw[e.fighter] = e.tick / 60;
        }
      }
      if (e.type === "ko") kills[e.weapon] = (kills[e.weapon] ?? 0) + 1;
    };
    for (const [i, d] of m.decisions.entries()) {
      const name = m.souls[i]!.name;
      wishes[name] ??= {};
      const key = d.strategy.weapons.join(">");
      wishes[name]![key] = (wishes[name]![key] ?? 0) + 1;
    }
    while (!m.step()) {
      /* round */
    }
    const f = m.finishRound();
    roundSecs.push(f.seconds);
    pickupsPerRound.push(picks);
    weaponPickups.push(wpicks);
    for (const t of fw) {
      fighterRounds++;
      if (t >= 0) firstWeapon.push(t);
      else neverArmed++;
    }
    seatRounds[f.winner]!++;
    soulRounds[order[f.winner]!]!++;
  }
  seatMatches[m.winner]!++;
  soulMatches[order[m.winner]!]!++;
}
const pct = (a: number, b: number) => `${((100 * a) / b).toFixed(1)}%`;
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const q = (a: number[], p: number) => {
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const R = sum(seatRounds);
const out: string[] = [];
out.push(`${N} matches, ${R} rounds, ${((performance.now() - t0) / 1000).toFixed(0)} s (souls rotated across seats every match)`);
out.push(`round wins per seat:  ${seatRounds.map((w, i) => `seat ${i + 1} ${pct(w, R)}`).join(", ")}`);
out.push(`match wins per seat:  ${seatMatches.map((w, i) => `seat ${i + 1} ${pct(w, N)}`).join(", ")}`);
out.push(`round wins per soul:  ${soulRounds.map((w, i) => `${souls[i]!.name} ${pct(w, R)}`).join(", ")}`);
out.push(`match wins per soul:  ${soulMatches.map((w, i) => `${souls[i]!.name} ${pct(w, N)}`).join(", ")}`);
out.push(`time to first weapon: median ${q(firstWeapon, 0.5).toFixed(1)} s, 75% within ${q(firstWeapon, 0.75).toFixed(1)} s, 90% within ${q(firstWeapon, 0.9).toFixed(1)} s; never armed in ${pct(neverArmed, fighterRounds)} of fighter-rounds`);
out.push(`pickups per round: mean ${(sum(pickupsPerRound) / R).toFixed(1)} (weapons ${(sum(weaponPickups) / R).toFixed(1)}), round length median ${q(roundSecs, 0.5).toFixed(0)} s`);
const K = sum(Object.values(kills));
out.push(`knockouts by weapon (${K}): ${Object.entries(kills)
  .sort((a, b) => b[1] - a[1])
  .map(([w, n]) => `${w} ${pct(n, K)}`)
  .join(", ")}`);
out.push(`house-bot weapon wishes per soul (rounds):`);
for (const [n, w] of Object.entries(wishes))
  out.push(`  ${n}: ${Object.entries(w)
    .sort((a, b) => b[1] - a[1])
    .map(([k, c]) => `${k} ${c}`)
    .join(", ")}`);
console.log(out.join("\n"));
