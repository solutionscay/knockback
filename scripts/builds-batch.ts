/**
 * Builds balance batch (#82): house-bot matches where every seat plays a seeded random legal build each round, souls
 * rotated across seats as in equal-batch.ts. Reports, for each attribute level, the round-win rate with its 95%
 * interval, knockouts dealt and taken, ring-outs taken and falls with no attacker; each build's win rate, tested
 * against the best neutral-adjacent build; the neutral build; the seat spread, the round length and the #69
 * scorecard (behavior.ts scoreRound).
 *
 *   bun scripts/builds-batch.ts [N=400] [firstSeed=1] [--builds neutral|souls|random:SEED] [--close]
 *       [--ruleset overrides.json] [--workers W (default: cores - 2)] [--json out.json]
 *
 * --builds as in batch-options.ts (default neutral: the reference for round length and the scorecard).
 * --workers splits the seeds over W processes (seed k goes to process k mod W). The report is the same for any W.
 *
 * Statistics:
 *  - A win rate's interval is the 95% Wilson score interval over fighter-rounds.
 *  - A level is "outside noise" when its whole interval lies outside 20%..30% (25% ± 5 points).
 *  - "Wins significantly more": each build against the best neutral-adjacent build (one level +1, one -1) and against
 *    all neutral-adjacent builds pooled, by Fisher's exact test (one-sided), Holm-corrected over every build tested;
 *    significant when the adjusted p is under 0.05.
 *  - A level's win rate also carries the points its build paid or got elsewhere (the levels add up to 0), so a fit
 *    of each level's own effect is singular: only trades are measurable. "Point value" fits the win (0/1) linearly
 *    on the three levels; a point moved from attribute B to attribute A changes the win rate by value(A) - value(B).
 *    The values are shown against the average attribute (they add up to 0), with 95% intervals.
 */
import { BUILD_ATTRIBUTES, BUILD_MAX, BUILD_MIN, LEGAL_BUILDS, type Build } from "../src/sim/build";
import { CLASSIC, CLOSE_QUARTERS, exampleSouls, houseBrain, initPhysics, Match, validateRuleset } from "../src/sim";
import { buildsLabel, buildsOption, mergeOverrides, sampleQuantile, withBuilds } from "./batch-options";
import { fisherGreater, holm, leastSquares, wilson } from "./batch-stats";
import { newScorecard, report, scoreRound, type Scorecard } from "./behavior";

/** One fighter in one round. */
type Row = { seed: number; round: number; seat: number; build: number; won: 0 | 1; kos: number; ko: 0 | 1; ringout: 0 | 1; fall: 0 | 1; damage: number };
type Shard = { rows: Row[]; roundSeconds: number[]; seatWins: number[]; card: Scorecard };

const argv = process.argv.slice(2);
const opt = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const valued = new Set(["--builds", "--ruleset", "--workers", "--json", "--shard"]);
const pos = argv.filter((a, i) => !a.startsWith("--") && !valued.has(argv[i - 1] ?? ""));
const N = Number(pos[0] ?? 400), first = Number(pos[1] ?? 1);
const builds = buildsOption(argv);
const close = argv.includes("--close");
const rulesetFile = opt("--ruleset");
const buildKey = (b: Build) => BUILD_ATTRIBUTES.map((a) => b[a]).join(",");
const buildIndex = new Map(LEGAL_BUILDS.map((b, i) => [buildKey(b), i]));

async function runShard(shard: number, of: number): Promise<Shard> {
  await initPhysics();
  const base = close ? CLOSE_QUARTERS : CLASSIC;
  const ruleset = rulesetFile ? validateRuleset(mergeOverrides(base, await Bun.file(rulesetFile).json())) : base;
  const souls = exampleSouls();
  const out: Shard = { rows: [], roundSeconds: [], seatWins: [0, 0, 0, 0], card: newScorecard() };
  for (let k = shard; k < N; k += of) {
    const seed = first + k;
    const rot = (seed - 1) % 4;
    const order = [0, 1, 2, 3].map((i) => (i + rot) % 4);
    const m = new Match(seed, { souls: order.map((i) => souls[i]!), ruleset, brains: withBuilds(order.map(() => houseBrain), builds, seed) });
    while (!m.over) {
      m.prepareRound();
      const falls = out.card.falls.length;
      scoreRound(m, out.card, seed);
      const fell = new Set(out.card.falls.slice(falls).map((f) => f.fighter));
      const sim = m.fight!.sim;
      const res = m.fight!.result();
      m.finishRound();
      out.roundSeconds.push(res.ticks / 60);
      out.seatWins[res.winner]!++;
      out.card.seatWins[res.winner]!++;
      for (const f of sim.fighters)
        out.rows.push({ seed, round: m.round, seat: f.id, build: buildIndex.get(buildKey(f.build))!, won: res.winner === f.id ? 1 : 0, kos: f.kos, ko: f.alive ? 0 : 1, ringout: !f.alive && f.koCause === "ringout" ? 1 : 0, fall: fell.has(f.id) ? 1 : 0, damage: f.damageDealt });
    }
  }
  return out;
}

function mergeCards(cards: Scorecard[]): Scorecard {
  const all = newScorecard();
  for (const c of cards) {
    for (const [s, b] of Object.entries(c.byStance)) {
      const a = (all.byStance[s] ??= { alive: 0, stare: 0, longTicks: 0, longClose: 0, longRatio: [], longDist: [], noGunTicks: 0, noGunClose: 0, falls: 0, zoneFalls: 0 });
      a.alive += b.alive; a.stare += b.stare; a.longTicks += b.longTicks; a.longClose += b.longClose; a.noGunTicks += b.noGunTicks; a.noGunClose += b.noGunClose; a.falls += b.falls; a.zoneFalls += b.zoneFalls;
      for (const r of b.longRatio) a.longRatio.push(r);
      for (const d of b.longDist) a.longDist.push(d);
    }
    all.rounds += c.rounds;
    all.fighterRounds += c.fighterRounds;
    all.roundSeconds.push(...c.roundSeconds);
    all.falls.push(...c.falls);
    c.seatWins.forEach((w, i) => (all.seatWins[i]! += w));
  }
  return all;
}

const shardArg = opt("--shard");
if (shardArg) {
  const [i, n] = shardArg.split("/").map(Number) as [number, number];
  await Bun.write(Bun.stdout, JSON.stringify(await runShard(i, n)));
  process.exit(0);
}

const t0 = performance.now();
const W = Math.max(1, Math.min(N, Number(opt("--workers") ?? Math.max(1, navigator.hardwareConcurrency - 2))));
const passOn = argv.filter((a, i) => !["--workers", "--json"].includes(a) && !["--workers", "--json"].includes(argv[i - 1] ?? ""));
const shards: Shard[] = await Promise.all(
  Array.from({ length: W }, async (_, i) => {
    const p = Bun.spawn(["bun", import.meta.path, ...passOn, "--shard", `${i}/${W}`], { stdout: "pipe", stderr: "inherit" });
    const text = await new Response(p.stdout).text();
    if ((await p.exited) !== 0) throw new Error(`worker ${i} failed`);
    return JSON.parse(text) as Shard;
  }),
);
const secs = (performance.now() - t0) / 1000;
const rows = shards.flatMap((s) => s.rows).sort((a, b) => a.seed - b.seed || a.round - b.round || a.seat - b.seat);
const roundSeconds = shards.flatMap((s) => s.roundSeconds);
const seatWins = [0, 1, 2, 3].map((i) => shards.reduce((s, x) => s + x.seatWins[i]!, 0));
const card = mergeCards(shards.map((s) => s.card));
const R = roundSeconds.length;

/** The scorecard's "all" row: falls with no attacker (zone pushes), long gun median / standOff and under 4 m, no long gun under 4 m, staring. */
function scoreSummary(c: Scorecard) {
  const b = Object.values(c.byStance);
  const t = (k: "alive" | "stare" | "longTicks" | "longClose" | "noGunTicks" | "noGunClose") => sum(b.map((x) => x[k]));
  const ratios = b.flatMap((x) => x.longRatio);
  return { falls: c.falls.length, zoneFalls: c.falls.filter((f) => f.zone).length, longGunMedianStandOff: sampleQuantile(ratios, 0.5), longGunUnder4m: t("longClose") / t("longTicks"), noGunUnder4m: t("noGunClose") / t("noGunTicks"), staring: t("stare") / t("alive"), fighterRounds: c.fighterRounds };
}

const pct = (x: number, d = 1) => `${(100 * x).toFixed(d)}%`;
const ci = (w: number, n: number) => {
  const [lo, hi] = wilson(w, n);
  return `${pct(w / Math.max(1, n))} (${pct(lo)}–${pct(hi)})`;
};
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const out: string[] = [];
out.push(`# Builds batch (#82): ${N} matches, seeds ${first}..${first + N - 1}, ${close ? "Close Quarters" : "Classic"}${rulesetFile ? `, ruleset ${rulesetFile}` : ""}, ${buildsLabel(builds)}`);
out.push("");
out.push(`${R} rounds, ${rows.length} fighter-rounds, ${W} workers, ${secs.toFixed(0)} s`);
out.push("");

let buildsJson: Record<string, unknown> = {};
if (builds.kind === "random") {
  // per attribute level
  type Agg = { n: number; w: number; kos: number; ko: number; ringout: number; fall: number; damage: number };
  const agg = (rs: Row[]): Agg => ({ n: rs.length, w: sum(rs.map((r) => r.won)), kos: sum(rs.map((r) => r.kos)), ko: sum(rs.map((r) => r.ko)), ringout: sum(rs.map((r) => r.ringout)), fall: sum(rs.map((r) => r.fall)), damage: sum(rs.map((r) => r.damage)) });
  const levels = Array.from({ length: BUILD_MAX - BUILD_MIN + 1 }, (_, i) => BUILD_MIN + i);
  const levelJson: Record<string, Record<string, Agg & { lo: number; hi: number; outside: boolean }>> = {};
  let outsideCount = 0;
  out.push("## Per attribute level");
  out.push("");
  out.push("Win rate: round wins per fighter-round, 95% Wilson interval. KOs dealt per round; KO'd, ring-outs and falls (no attacker) as a share of fighter-rounds.");
  out.push("");
  out.push("| Attribute | Level | Fighter-rounds | Win rate (95%) | Outside 25±5? | KOs dealt | KO'd | Ring-outs taken | Falls, no attacker | Damage dealt |");
  out.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const a of BUILD_ATTRIBUTES) {
    levelJson[a] = {};
    for (const l of levels) {
      const g = agg(rows.filter((r) => LEGAL_BUILDS[r.build]![a] === l));
      const [lo, hi] = wilson(g.w, g.n);
      const outside = hi < 0.2 || lo > 0.3;
      if (outside) outsideCount++;
      levelJson[a]![l] = { ...g, lo, hi, outside };
      const point = g.w / g.n;
      out.push(`| ${a} | ${l > 0 ? "+" : ""}${l} | ${g.n} | ${ci(g.w, g.n)} | ${outside ? "**OUTSIDE**" : point < 0.2 || point > 0.3 ? "point outside, interval reaches the band" : "no"} | ${(g.kos / g.n).toFixed(3)} | ${pct(g.ko / g.n)} | ${pct(g.ringout / g.n)} | ${pct(g.fall / g.n)} | ${(g.damage / g.n).toFixed(1)} |`);
    }
  }
  out.push("");
  out.push(`Levels outside noise: ${outsideCount}.`);
  out.push("");

  // point value: win ~ c + sum over the first two attributes of g_a * level (the third is minus their sum)
  const free = BUILD_ATTRIBUTES.slice(0, -1);
  const pv = leastSquares(rows.map((r) => [1, ...free.map((a) => LEGAL_BUILDS[r.build]![a])]), rows.map((r) => r.won));
  const g = [...free.map((_, i) => pv.b[i + 1]!), 0];
  const mean = sum(g) / g.length;
  const pointValue = BUILD_ATTRIBUTES.map((a, k) => {
    // value(a) = g_a - mean(g): a linear combination c of the fitted coefficients
    const c = [0, ...free.map((_, i) => (i === k ? 1 : 0) - 1 / BUILD_ATTRIBUTES.length)];
    const v = c.reduce((s2, ci, i) => s2 + ci * c.reduce((s3, cj, j) => s3 + cj * pv.cov[i]![j]!, 0), 0);
    return { attribute: a, value: g[k]! - mean, half: 1.96 * Math.sqrt(v) };
  });
  out.push("Point value (win-rate points per level, against the average attribute; a point moved from B to A changes the win rate by A − B):");
  out.push("");
  out.push(`| ${BUILD_ATTRIBUTES.join(" | ")} |`);
  out.push(`|${BUILD_ATTRIBUTES.map(() => "---").join("|")}|`);
  out.push(`| ${pointValue.map((p) => `${p.value >= 0 ? "+" : ""}${(100 * p.value).toFixed(1)} ± ${(100 * p.half).toFixed(1)}`).join(" | ")} |`);
  out.push("");
  
  // per build
  const byBuild = LEGAL_BUILDS.map((b, i) => ({ b, i, ...agg(rows.filter((r) => r.build === i)) }));
  const show = (b: Build) => BUILD_ATTRIBUTES.map((a) => `${a[0]!.toUpperCase()}${b[a] > 0 ? "+" : ""}${b[a]}`).join(" ");
  const isNeutral = (b: Build) => BUILD_ATTRIBUTES.every((a) => b[a] === 0);
  const adjacent = byBuild.filter((x) => sum(BUILD_ATTRIBUTES.map((a) => Math.abs(x.b[a]))) === 2);
  const best = adjacent.reduce((p, q) => (q.w / q.n > p.w / p.n ? q : p));
  const pool = { n: sum(adjacent.map((x) => x.n)), w: sum(adjacent.map((x) => x.w)) };
  const others = byBuild.filter((x) => x.i !== best.i && x.n > 0);
  const pBest = holm(others.map((x) => fisherGreater(x.w, x.n, best.w, best.n)));
  const pPool = holm(others.map((x) => fisherGreater(x.w, x.n, pool.w, pool.n)));
  const test = new Map(others.map((x, k) => [x.i, { best: pBest[k]!, pool: pPool[k]! }]));
  const ranked = byBuild.filter((x) => x.n > 0).sort((p, q) => q.w / q.n - p.w / p.n || q.n - p.n);
  const rank = (i: number) => ranked.findIndex((x) => x.i === i) + 1;
  const buildRow = (x: (typeof byBuild)[number]) => {
    const t = test.get(x.i);
    return `| ${show(x.b)}${isNeutral(x.b) ? " (neutral)" : ""}${x.i === best.i ? " (best adjacent)" : ""} | ${x.n} | ${ci(x.w, x.n)} | ${x.n ? `${rank(x.i)} of ${ranked.length}` : "not played"} | ${t ? t.best.toFixed(3) : "-"} | ${t ? t.pool.toFixed(3) : "-"} |`;
  };
  const head = ["| Build (H W P) | Fighter-rounds | Win rate (95%) | Rank | Holm p vs best adjacent | Holm p vs adjacent pool |", "|---|---|---|---|---|---|"];
  out.push("## Builds");
  out.push("");
  out.push(`${ranked.length} of ${LEGAL_BUILDS.length} legal builds played. Neutral-adjacent: one level +1 and one -1 (${adjacent.length} builds, pooled win rate ${ci(pool.w, pool.n)}); the best of them: ${show(best.b)} at ${ci(best.w, best.n)}. A build "wins significantly more" when its Holm-adjusted one-sided Fisher p is under 0.05 (${others.length} comparisons).`);
  out.push("");
  const sigBest = others.filter((x) => test.get(x.i)!.best < 0.05);
  const sigPool = others.filter((x) => test.get(x.i)!.pool < 0.05);
  out.push(`Builds that win significantly more than the best neutral-adjacent build: ${sigBest.length ? sigBest.map((x) => show(x.b)).join("; ") : "none"}. Than the adjacent pool: ${sigPool.length ? sigPool.map((x) => show(x.b)).join("; ") : "none"}.`);
  out.push("");
  out.push("### Every build by win rate");
  out.push("");
  out.push(...head, ...ranked.map(buildRow));
  out.push("");
  const neutral = byBuild.find((x) => isNeutral(x.b))!;
  out.push("### Neutral and the neutral-adjacent builds");
  out.push("");
  out.push(...head, buildRow(neutral), ...adjacent.map(buildRow));
  out.push("");
  buildsJson = {
    levels: levelJson, outsideCount, pointValue,
    builds: byBuild.map((x) => ({ build: x.b, n: x.n, w: x.w, rank: x.n ? rank(x.i) : null, holmBest: test.get(x.i)?.best ?? null, holmPool: test.get(x.i)?.pool ?? null })),
    bestAdjacent: { build: best.b, n: best.n, w: best.w }, adjacentPool: pool, significantVsBest: sigBest.map((x) => x.b), significantVsPool: sigPool.map((x) => x.b),
    neutral: { n: neutral.n, w: neutral.w, rank: neutral.n ? rank(neutral.i) : null, of: ranked.length },
  };
}

// seats, round length, scorecard
const band = 1.96 * Math.sqrt((0.25 * 0.75) / R);
const seatDev = Math.max(...seatWins.map((w) => Math.abs(w / R - 0.25)));
out.push("## Seats, round length, scorecard");
out.push("");
out.push(`Round wins per seat: ${seatWins.map((w, i) => `seat ${i + 1} ${pct(w / R)}`).join(", ")} (95% band 25% ± ${pct(band)}; largest gap ${pct(seatDev)}: ${seatDev <= band ? "within noise" : "OUTSIDE noise"}).`);
out.push(`Round length: median ${sampleQuantile(roundSeconds, 0.5).toFixed(1)} s, mean ${(sum(roundSeconds) / R).toFixed(1)} s.`);
out.push("");
out.push(report(card, "### Scorecard (#69)"));
const sc = scoreSummary(card);
out.push("");
out.push(`Scorecard summary: falls with no attacker ${sc.falls} (${sc.zoneFalls} zone pushes) in ${sc.fighterRounds} fighter-rounds; long gun median ${pct(sc.longGunMedianStandOff, 0)} of standOff, ${pct(sc.longGunUnder4m, 0)} under 4 m; no long gun ${pct(sc.noGunUnder4m, 0)} under 4 m; staring ${pct(sc.staring, 1)}.`);
console.log(out.join("\n"));

const jsonOut = opt("--json");
if (jsonOut)
  await Bun.write(jsonOut, JSON.stringify({
    matches: N, firstSeed: first, builds, close, ruleset: rulesetFile ?? null, workers: W, seconds: secs, rounds: R, fighterRounds: rows.length,
    ...buildsJson,
    seatWins, seatBand: band, seatMaxDeviation: seatDev, roundSeconds: { median: sampleQuantile(roundSeconds, 0.5), mean: sum(roundSeconds) / R, all: roundSeconds },
    scorecard: scoreSummary(card),
  }, null, 2));
