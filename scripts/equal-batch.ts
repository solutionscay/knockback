/**
 * Balance check for equal fighters: N headless house-bot matches with the
 * example souls rotated across seats (seed s: seat i gets soul (i+s-1) % 4).
 * Reports win spread per seat (with its 95% noise band) and per soul, time to
 * first weapon pickup, how often a rival was near at that pickup, pickups per
 * round, round length and knockouts per weapon.
 *   bun scripts/equal-batch.ts [N=200] [firstSeed=1] [--close] [--ruleset overrides.json] [--builds neutral|souls|random:SEED] [--json out.json]
 * --close starts from Close Quarters instead of Classic; --ruleset applies a
 * partial ruleset (JSON) on top of it; --builds sets the builds (batch-options.ts buildsOption; default: all
 * neutral).
 */
import { CLASSIC, CLOSE_QUARTERS, exampleSouls, houseBrain, initPhysics, Match, validateRuleset, WEAPON_LIST, type Weapon } from "../src/sim";
import { buildsLabel, buildsOption, comparisonBatchOptions, mergeOverrides, sampleQuantile, withBuilds } from "./batch-options";

/** A rival this close at a fighter's first weapon pickup makes that pickup contested (meters, roundstats NEAR_M). */
const CONTEST_RANGE = 7;
/** A start weapon is a fighter's own when its spawn is nearer than this share of the nearest rival spawn's distance. */
const OWN_RATIO = 0.6;

await initPhysics();
const argv = process.argv;
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const valueFlags = new Set(["--ruleset", "--json", "--builds"]);
const builds = buildsOption(argv);
const { count: N, first, houseRules } = comparisonBatchOptions(argv.filter((a, i) => !valueFlags.has(a) && !valueFlags.has(argv[i - 1]!)));
const rulesetFile = flag("--ruleset");
const jsonOut = flag("--json");
const base = argv.includes("--close") ? CLOSE_QUARTERS : CLASSIC;
const ruleset = rulesetFile ? validateRuleset(mergeOverrides(base, await Bun.file(rulesetFile).json())) : base;
const souls = exampleSouls();
const seatRounds = [0, 0, 0, 0];
const seatMatches = [0, 0, 0, 0];
const soulRounds = [0, 0, 0, 0];
const soulMatches = [0, 0, 0, 0];
const firstWeapon: number[] = [];
let contested = 0;
/** first pickups of a start weapon, and of those the ones far nearer the picker's spawn than any rival's (its own) */
let startFirst = 0;
let ownFirst = 0;
let neverArmed = 0;
/** never-armed fighters knocked out while unarmed, and when (s) */
const unarmedKos: number[] = [];
let fighterRounds = 0;
const pickupsPerRound: number[] = [];
const weaponPickups: number[] = [];
const kills: Record<string, number> = {};
const roundSecs: number[] = [];
const wishes: Record<string, Record<string, number>> = {};
const t0 = performance.now();
for (let k = 0; k < N; k++) {
  const seed = first + k;
  const rot = (seed - 1) % 4;
  const order = [0, 1, 2, 3].map((i) => (i + rot) % 4);
  const brains = withBuilds(order.map(() => houseBrain), builds, seed);
  const m = new Match(seed, { souls: order.map((i) => souls[i]!), houseRules, ruleset, brains });
  while (!m.over) {
    m.prepareRound();
    const fw = [-1, -1, -1, -1];
    let picks = 0;
    let wpicks = 0;
    const sim0 = m.fight!.sim;
    const spawnAt = sim0.fighters.map((f) => sim0.pos(f));
    const startItems = sim0.items().filter((i) => WEAPON_LIST.includes(i.itemType as Weapon)).map((i) => ({ type: i.itemType, ...i.body.translation() }));
    m.onEvent = (e) => {
      if (e.type === "pickup") {
        picks++;
        if (WEAPON_LIST.includes(e.item as Weapon)) {
          wpicks++;
          if (fw[e.fighter]! < 0) {
            fw[e.fighter] = e.tick / 60;
            const sim = m.fight!.sim;
            if (sim.alive().some((f) => f.id !== e.fighter && Math.hypot(sim.pos(f).x - e.x, sim.pos(f).y - e.y) < CONTEST_RANGE)) contested++;
            const start = startItems.find((it) => it.type === e.item && Math.hypot(it.x - e.x, it.y - e.y) < 2);
            if (start) {
              startFirst++;
              const d = spawnAt.map((p) => Math.hypot(p.x - start.x, p.y - start.y));
              if (d[e.fighter]! < OWN_RATIO * Math.min(...d.filter((_, i) => i !== e.fighter))) ownFirst++;
            }
          }
        }
      }
      if (e.type === "ko") {
        kills[e.weapon] = (kills[e.weapon] ?? 0) + 1;
        if (fw[e.fighter]! < 0) unarmedKos.push(e.tick / 60);
      }
    };
    for (const [i, d] of m.decisions.entries()) {
      const name = m.souls[i]!.id;
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
const R = sum(seatRounds);
// 95% band for one seat's round-win share around the even 25%
const band = 1.96 * Math.sqrt((0.25 * 0.75) / R);
const seatShare = seatRounds.map((w) => w / R);
const seatDev = Math.max(...seatShare.map((s) => Math.abs(s - 0.25)));
const K = sum(Object.values(kills));
const metrics = {
  matches: N,
  firstSeed: first,
  rounds: R,
  firstWeapon: { median: sampleQuantile(firstWeapon, 0.5), p75: sampleQuantile(firstWeapon, 0.75), p90: sampleQuantile(firstWeapon, 0.9) },
  armedWithin1s: firstWeapon.filter((t) => t <= 1).length / fighterRounds,
  contestedFirstPickup: contested / Math.max(1, firstWeapon.length),
  firstFromStart: startFirst / Math.max(1, firstWeapon.length),
  ownStartFirst: ownFirst / Math.max(1, firstWeapon.length),
  neverArmed: neverArmed / fighterRounds,
  neverArmedKnockedOut: unarmedKos.length / fighterRounds,
  unarmedKoMedianSeconds: unarmedKos.length ? sampleQuantile(unarmedKos, 0.5) : 0,
  roundSeconds: { median: sampleQuantile(roundSecs, 0.5), mean: sum(roundSecs) / R },
  seatRoundShare: seatShare,
  seatBand: band,
  seatMaxDeviation: seatDev,
  seatWithinNoise: seatDev <= band,
  kosByWeapon: Object.fromEntries(Object.entries(kills).sort((a, b) => b[1] - a[1]).map(([w, n]) => [w, n / K])),
  knockouts: K,
};
const out: string[] = [];
out.push(`${N} matches (seeds ${first}..${first + N - 1}), ${R} rounds, ${((performance.now() - t0) / 1000).toFixed(0)} s (souls rotated across seats every match)${rulesetFile ? `, ruleset ${rulesetFile}` : ""}${base === CLOSE_QUARTERS ? ", Close Quarters" : ""}, ${buildsLabel(builds)}`);
out.push(`round wins per seat:  ${seatRounds.map((w, i) => `seat ${i + 1} ${pct(w, R)}`).join(", ")}  (95% noise band 25% ± ${(100 * band).toFixed(1)}%; largest gap ${(100 * seatDev).toFixed(1)}%: ${seatDev <= band ? "within noise" : "OUTSIDE noise"})`);
out.push(`match wins per seat:  ${seatMatches.map((w, i) => `seat ${i + 1} ${pct(w, N)}`).join(", ")}`);
out.push(`round wins per soul:  ${soulRounds.map((w, i) => `${souls[i]!.id} ${pct(w, R)}`).join(", ")}`);
out.push(`match wins per soul:  ${soulMatches.map((w, i) => `${souls[i]!.id} ${pct(w, N)}`).join(", ")}`);
out.push(`time to first weapon: median ${metrics.firstWeapon.median.toFixed(1)} s, 75% within ${metrics.firstWeapon.p75.toFixed(1)} s, 90% within ${metrics.firstWeapon.p90.toFixed(1)} s; armed within 1 s ${pct(metrics.armedWithin1s, 1)}; never armed in ${pct(neverArmed, fighterRounds)} of fighter-rounds (${pct(unarmedKos.length, fighterRounds)} knocked out unarmed, median at ${metrics.unarmedKoMedianSeconds.toFixed(0)} s; the rest unarmed at the round end)`);
out.push(`first pickup contested (a rival within ${CONTEST_RANGE} m): ${pct(metrics.contestedFirstPickup, 1)}; first weapon was a start weapon ${pct(metrics.firstFromStart, 1)}, the fighter's own (spawn under ${OWN_RATIO}x the nearest rival's distance) ${pct(metrics.ownStartFirst, 1)}`);
out.push(`pickups per round: mean ${(sum(pickupsPerRound) / R).toFixed(1)} (weapons ${(sum(weaponPickups) / R).toFixed(1)}), round length median ${metrics.roundSeconds.median.toFixed(0)} s, mean ${metrics.roundSeconds.mean.toFixed(1)} s`);
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
if (jsonOut) await Bun.write(jsonOut, JSON.stringify(metrics, null, 2));
