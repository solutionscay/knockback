/**
 * Behavior scorecard (#69): does the fighter controller carry out a plan with sense? Reads a match record, or runs a
 * house-bot batch, and prints per stance (the stance played at that tick):
 *   falls      ring-outs with no attacker (no fighter hit them in the last 5 s, or they hit themselves), not counting
 *              falls after the round was already won; zone pushes (outside the safe zone in the 2 s before) apart
 *   long gun   with a long-range weapon in hand (rocket, railgun, rifle, sniper, crossbow) and a live target: the
 *              median distance to the target as a share of the weapon's standOff, and the share of time under 4 m
 *   no gun     overwatch and distance fighters without a long gun: the share of time under 4 m from the target
 *   staring    1.5 s or more still (under 0.6 m/s), target alive, not firing: share of alive time
 * and, for a batch, the seat spread (round wins per seat) and the median round length.
 *
 *   bun scripts/behavior.ts record.json [--rounds]          a recorded match (the record's plans on the current sim)
 *   bun scripts/behavior.ts [count=200] [first=1] [--ruleset classic|close-quarters] [--stances] [--json out.json]
 *     --stances: every fighter plays a rotating stance (all stances show up); default: the house bots' own plans
 */
import { readFileSync, writeFileSync } from "node:fs";
import { houseBrain, initPhysics, Match, RULE_STANCES, TICK_RATE, type Brain, type Input, type Stance, type Weapon } from "../src/sim";
import { CLASSIC, CLOSE_QUARTERS } from "../src/sim/ruleset";

const LONG: readonly Weapon[] = ["rocket", "railgun", "rifle", "sniper", "crossbow"];
const STILL_MS = 0.6;
const STARE_TICKS = Math.round(1.5 * TICK_RATE);
const CLOSE_M = 4;

type Bucket = { alive: number; stare: number; longTicks: number; longClose: number; longRatio: number[]; longDist: number[]; noGunTicks: number; noGunClose: number; falls: number; zoneFalls: number };
const bucket = (): Bucket => ({ alive: 0, stare: 0, longTicks: 0, longClose: 0, longRatio: [], longDist: [], noGunTicks: 0, noGunClose: 0, falls: 0, zoneFalls: 0 });

/** zone: outside the safe zone in the last 2 s before the fall (the zone pushes fighters in, over a pit if one is in the way) */
export type FallNote = { seed: number; round: number; fighter: number; tick: number; stance: string; x: number; y: number; zone: boolean };
export type Scorecard = { byStance: Record<string, Bucket>; rounds: number; fighterRounds: number; roundSeconds: number[]; seatWins: number[]; falls: FallNote[]; rows: string[] };

export function newScorecard(): Scorecard {
  return { byStance: {}, rounds: 0, fighterRounds: 0, roundSeconds: [], seatWins: [0, 0, 0, 0], falls: [], rows: [] };
}

/** Play one round of `m` (prepareRound already called) and score it into `card`. */
export function scoreRound(m: Match, card: Scorecard, seed: number, names?: string[]) {
  const f = m.fight!, sim = f.sim, n = sim.fighters.length;
  const reach = sim.ruleset.tactics.weapons.reach;
  const inputs: (Input | null)[] = Array(n).fill(null);
  const stanceAt: string[] = Array(n).fill("");
  f.controllers.forEach((c, i) => {
    const think = c.think.bind(c);
    c.think = (s) => (inputs[i] = think(s));
  });
  const run = Array(n).fill(0);
  const prev: ({ x: number; y: number } | null)[] = Array(n).fill(null);
  const own = Array.from({ length: n }, bucket);
  const fall: (FallNote | null)[] = Array(n).fill(null);
  const outside = Array(n).fill(-999);
  let aliveBefore = n;
  while (!f.over) {
    aliveBefore = sim.alive().length;
    f.step();
    for (let i = 0; i < n; i++) {
      const fi = sim.fighters[i]!;
      if (!fi.alive || fi.removed) {
        run[i] = 0;
        if (!fall[i] && fi.koTick >= sim.tick - 1 && fi.koCause === "ringout" && (fi.koBy < 0 || fi.koBy === i) && aliveBefore > 1) {
          const p = prev[i] ?? { x: 0, y: 0 };
          fall[i] = { seed, round: m.round, fighter: i, tick: sim.tick, stance: stanceAt[i] || "?", x: p.x, y: p.y, zone: sim.tick - outside[i] <= 2 * TICK_RATE };
        }
        continue;
      }
      if (fi.outsideZone) outside[i] = sim.tick;
      const c = f.controllers[i]!;
      const stance = c.stanceNow(sim);
      stanceAt[i] = stance;
      const b = (card.byStance[stance] ??= bucket());
      b.alive++;
      own[i]!.alive++;
      const p = sim.pos(fi);
      const inp = inputs[i];
      const tg = c.targetId >= 0 ? sim.fighters[c.targetId] : undefined;
      const tp = tg && tg.alive && !tg.removed ? sim.pos(tg) : null;
      const d = tp ? Math.hypot(tp.x - p.x, tp.y - p.y) : null;
      const held = sim.weapon(fi);
      if (d !== null && LONG.includes(held)) {
        b.longTicks++;
        b.longRatio.push(d / reach[held].standOff);
        b.longDist.push(d);
        if (d < CLOSE_M) b.longClose++;
        own[i]!.longTicks++;
        own[i]!.longDist.push(d);
        if (d < CLOSE_M) own[i]!.longClose++;
      }
      if (d !== null && (stance === "overwatch" || stance === "distance") && !fi.weapons.some((w) => LONG.includes(w))) {
        b.noGunTicks++;
        if (d < CLOSE_M) b.noGunClose++;
      }
      const v = prev[i] ? Math.hypot(p.x - prev[i]!.x, p.y - prev[i]!.y) * TICK_RATE : 99;
      prev[i] = { x: p.x, y: p.y };
      if (tp && v < STILL_MS && !inp?.fire) {
        run[i]++;
        const add = run[i] === STARE_TICKS ? STARE_TICKS : run[i] > STARE_TICKS ? 1 : 0;
        b.stare += add;
        own[i]!.stare += add;
      } else run[i] = 0;
    }
  }
  for (const fl of fall) if (fl) {
    card.falls.push(fl);
    const b = (card.byStance[fl.stance] ??= bucket());
    b.falls++;
    if (fl.zone) b.zoneFalls++;
  }
  card.rounds++;
  card.fighterRounds += n;
  card.roundSeconds.push(sim.tick / TICK_RATE);
  if (names) {
    const strategies = m.record.rounds[m.round - 1]!.strategies;
    for (let i = 0; i < n; i++) {
      const o = own[i]!, fi = sim.fighters[i]!;
      const end = fall[i] ? `**fell, no attacker** at ${(fall[i]!.tick / TICK_RATE).toFixed(1)} s` : fi.alive ? "survived" : `${fi.koCause === "ringout" ? "ring-out" : "K.O."} at ${(fi.koTick / TICK_RATE).toFixed(1)} s`;
      const long = o.longTicks ? `${(o.longTicks / TICK_RATE).toFixed(1)} s, median ${median(o.longDist).toFixed(1)} m, ${pct(o.longClose, o.longTicks)} under 4 m` : "-";
      card.rows.push(`| ${m.round} | ${names[i]} | ${strategies[i]!.stance} | ${end} | ${long} | ${(o.stare / TICK_RATE).toFixed(1)} s |`);
    }
  }
}

const median = (xs: number[]) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : NaN);
const pct = (a: number, b: number) => (b > 0 ? `${((100 * a) / b).toFixed(0)}%` : "-");

export function report(card: Scorecard, title: string): string {
  const out = [title, ""];
  out.push("| Stance played | Alive | Falls, no attacker (of them zone pushes) | Long gun: median / standOff | Long gun: under 4 m | No long gun (overwatch, distance): under 4 m | Staring |");
  out.push("|---|---|---|---|---|---|---|");
  const order = [...RULE_STANCES, "rush"].filter((s, i, a) => a.indexOf(s) === i);
  const all = bucket();
  for (const s of [...order, ...Object.keys(card.byStance).filter((k) => !order.includes(k as Stance))]) {
    const b = card.byStance[s];
    if (!b) continue;
    all.alive += b.alive; all.stare += b.stare; all.longTicks += b.longTicks; all.longClose += b.longClose; all.noGunTicks += b.noGunTicks; all.noGunClose += b.noGunClose; all.falls += b.falls; all.zoneFalls += b.zoneFalls;
    for (const r of b.longRatio) all.longRatio.push(r);
    out.push(row(s, b));
  }
  out.push(row("**all**", all));
  if (card.rounds > 1) {
    out.push("");
    out.push(`${card.rounds} rounds, ${card.fighterRounds} fighter-rounds; falls with no attacker: ${card.falls.length} (${card.falls.filter((f) => f.zone).length} zone pushes); median round ${median(card.roundSeconds).toFixed(1)} s; round wins per seat: ${card.seatWins.join(" / ")}`);
  }
  return out.join("\n");
}

function row(s: string, b: Bucket) {
  const ratio = b.longRatio.length ? `${(median(b.longRatio) * 100).toFixed(0)}% (${(b.longTicks / TICK_RATE).toFixed(0)} s)` : "-";
  return `| ${s} | ${(b.alive / TICK_RATE).toFixed(0)} s | ${b.falls} (${b.zoneFalls}) | ${ratio} | ${pct(b.longClose, b.longTicks)} | ${b.noGunTicks ? `${pct(b.noGunClose, b.noGunTicks)} (${(b.noGunTicks / TICK_RATE).toFixed(0)} s)` : "-"} | ${pct(b.stare, b.alive)} |`;
}

if (import.meta.main) {
  await initPhysics();
  const args = process.argv.slice(2);
  const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const valued = new Set(["--ruleset", "--json"]);
  const pos = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1] ?? ""));
  const card = newScorecard();
  const t0 = performance.now();
  if (pos[0]?.endsWith(".json")) {
    const rec = JSON.parse(readFileSync(pos[0], "utf8"));
    const m = new Match(rec.seed, { recorded: rec });
    const names = rec.identities.map((i: { name: string }) => i.name);
    for (let r = 0; r < rec.rounds.length; r++) {
      m.prepareRound();
      scoreRound(m, card, rec.seed, names);
      m.finishRound();
    }
    console.log("| Round | Fighter | Planned stance | End | Long-range weapon in hand | Staring |\n|---|---|---|---|---|---|\n" + card.rows.join("\n"));
    console.log("\n" + report(card, `${pos[0]} (plans replayed on the current controller${m.diverged >= 0 ? `; the fight differs from the record from round ${m.diverged}` : ""})`));
    for (const fl of card.falls) console.log(`fell: round ${fl.round} ${names[fl.fighter]} tick ${fl.tick} (${fl.stance}) last at x ${fl.x.toFixed(1)} y ${fl.y.toFixed(1)}`);
  } else {
    const count = Number(pos[0] ?? 200), first = Number(pos[1] ?? 1);
    const rulesetName = opt("--ruleset") ?? "classic";
    const ruleset = rulesetName === "close-quarters" ? CLOSE_QUARTERS : CLASSIC;
    const rotate = args.includes("--stances");
    for (let seed = first; seed < first + count; seed++) {
      const brains: Brain[] | undefined = rotate ? [0, 1, 2, 3].map((seat) => (ctx) => {
        const d = houseBrain(ctx);
        const stance = RULE_STANCES[(seed * 7 + seat * 3 + ctx.round * 5) % RULE_STANCES.length] as Stance;
        return { ...d, strategy: { ...d.strategy, stance } };
      }) : undefined;
      const m = new Match(seed, { ruleset, brains });
      while (!m.over) {
        m.prepareRound();
        scoreRound(m, card, seed);
        const facts = m.finishRound();
        if (m.results[m.results.length - 1]!.winner >= 0) card.seatWins[m.results[m.results.length - 1]!.winner]!++;
        void facts;
      }
    }
    console.log(report(card, `behavior (#69): ${count} house-bot matches, seeds ${first}..${first + count - 1}, ${rulesetName}${rotate ? ", rotating stances" : ", the house bots' own plans"} (${((performance.now() - t0) / 1000).toFixed(0)} s)`));
    const json = opt("--json");
    if (json) writeFileSync(json, JSON.stringify({ ...card, byStance: Object.fromEntries(Object.entries(card.byStance).map(([k, b]) => [k, { ...b, longRatio: median(b.longRatio), longDist: median(b.longDist) }])) }, null, 2));
    if (card.falls.length) console.log("\nfalls with no attacker:\n" + card.falls.map((f) => `  seed ${f.seed} round ${f.round} seat ${f.fighter} tick ${f.tick} (${f.stance}${f.zone ? ", zone" : ""}) at x ${f.x.toFixed(1)} y ${f.y.toFixed(1)}`).join("\n"));
  }
}
