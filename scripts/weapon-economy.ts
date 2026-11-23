/**
 * Weapon economy stats (#95), with the #88 stuck detector on the same rounds.
 *
 *   bun scripts/weapon-economy.ts sims [count=100] [first=1] --out runs.json   Arena-style rounds: house bots in every
 *                                                                               seat, the souls rotated, one round each
 *     [--ruleset '{"pickups":{...}}']                                           a partial ruleset over Classic (tuning)
 *   bun scripts/weapon-economy.ts report a.json[,a2.json...] [b.json[,b2.json...]] [--md]
 *
 * Per fighter-round: time bare-handed (no weapon carried, 2+ alive), time to the first weapon, weapon pickups, damage
 * and knockouts by what dealt them (a pickup weapon, fists, anything else), stuck episodes. Per round: its length,
 * loose weapons on the floor (mean, peak) and how clustered they are (the nearest other loose weapon).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { exampleSouls, initPhysics, Match } from "../src/sim";
import { CLASSIC, resolveRuleset, type Ruleset } from "../src/sim/ruleset";
import { isPickupWeapon } from "../src/sim/sim-types";
import { StuckDetector } from "../src/stats/stuck";

interface FighterRow {
  aliveTicks: number;
  bareTicks: number;
  /** tick of the first weapon pickup, or -1 */
  firstWeapon: number;
  /** alive ticks before the first weapon (or all of them, when none came) */
  toFirst: number;
  weaponPickups: number;
  empties: number;
  /** #95 events: weapons run empty, dropped on purpose, dropped for another */
  emptied?: number;
  dropped?: number;
  swapped?: number;
  stuckTicks: number;
  episodes: number;
}
interface RoundRow {
  seed: number;
  ticks: number;
  theme: string;
  /** fighter damage to other fighters by cause class */
  dmg: { weapon: number; fist: number; other: number };
  kos: { weapon: number; fist: number; other: number };
  /** loose weapons on the floor, summed over sampled ticks, and the peak */
  looseSum: number;
  looseSamples: number;
  loosePeak: number;
  /** nearest other loose weapon (m), summed over sampled weapons; and how many had one within 3 m */
  nnSum: number;
  nnCount: number;
  nnClose: number;
  /** weapons on the floor at tick 1 */
  startWeapons: number;
  fighters: FighterRow[];
}

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const classOf = (cause: string) => (cause === "fist" ? "fist" : isPickupWeapon(cause) || cause === "flamethrower" ? "weapon" : "other");

function runSims(count: number, first: number, override: Record<string, unknown> = {}): RoundRow[] {
  const souls = exampleSouls();
  const ruleset: Ruleset = resolveRuleset({ ...override, round: { maxRounds: 1, winsToTake: 1 } });
  const rows: RoundRow[] = [];
  for (let k = 0; k < count; k++) {
    const seed = first + k;
    const order = [0, 1, 2, 3].map((i) => (i + seed) % 4);
    const m = new Match(seed, { souls: order.map((i) => souls[i]!), ruleset });
    m.prepareRound();
    const fight = m.fight!;
    const sim = fight.sim;
    const det = new StuckDetector(fight);
    const row: RoundRow = {
      seed, ticks: 0, theme: sim.level.theme, dmg: { weapon: 0, fist: 0, other: 0 }, kos: { weapon: 0, fist: 0, other: 0 },
      looseSum: 0, looseSamples: 0, loosePeak: 0, nnSum: 0, nnCount: 0, nnClose: 0, startWeapons: -1,
      fighters: [0, 1, 2, 3].map(() => ({ aliveTicks: 0, bareTicks: 0, firstWeapon: -1, toFirst: 0, weaponPickups: 0, empties: 0, stuckTicks: 0, episodes: 0 })),
    };
    const prev = m.onEvent;
    m.onEvent = (e) => {
      det.event(e);
      prev?.(e);
      if (e.type === "hit" && e.source >= 0 && e.source !== e.target) row.dmg[classOf(e.cause)] += e.damage;
      if (e.type === "ko" && e.by >= 0 && e.by !== e.fighter) row.kos[classOf(e.weapon)]++;
      if (e.type === "pickup" && isPickupWeapon(e.item)) {
        const f = row.fighters[e.fighter]!;
        f.weaponPickups++;
        if (f.firstWeapon < 0) f.firstWeapon = e.tick;
      }
      if (e.type === "pickup") picked.add(e.fighter);
      const ev = e as { type: string; fighter: number; reason?: string };
      if (ev.type === "empty") row.fighters[ev.fighter]!.emptied = (row.fighters[ev.fighter]!.emptied ?? 0) + 1;
      if (ev.type === "drop" && ev.reason === "drop") row.fighters[ev.fighter]!.dropped = (row.fighters[ev.fighter]!.dropped ?? 0) + 1;
      if (ev.type === "drop" && ev.reason === "swap") row.fighters[ev.fighter]!.swapped = (row.fighters[ev.fighter]!.swapped ?? 0) + 1;
    };
    // a carried weapon gone without a pickup that tick (and the fighter still in): emptied (or dropped)
    const picked = new Set<number>();
    let carried = sim.fighters.map(() => [] as string[]);
    while (!m.step()) {
      det.tick();
      const now = sim.fighters.map((f) => f.weapons.filter((w) => w !== "fist") as string[]);
      for (const f of sim.fighters) if (f.alive && !picked.has(f.id)) row.fighters[f.id]!.empties += carried[f.id]!.filter((w) => !now[f.id]!.includes(w)).length;
      carried = now;
      picked.clear();
      const alive = sim.fighters.filter((f) => f.alive);
      if (alive.length >= 2) {
        for (const f of alive) {
          const r = row.fighters[f.id]!;
          r.aliveTicks++;
          const armed = f.weapons.some((w) => w !== "fist");
          if (!armed) r.bareTicks++;
          if (r.firstWeapon < 0) r.toFirst++;
        }
      }
      if (sim.tick % 30 === 1) {
        const loose = sim.items().filter((e) => isPickupWeapon(e.itemType)).map((e) => e.body.translation());
        if (row.startWeapons < 0) row.startWeapons = loose.length;
        row.looseSum += loose.length;
        row.looseSamples++;
        row.loosePeak = Math.max(row.loosePeak, loose.length);
        for (const [i, p] of loose.entries()) {
          let nn = Infinity;
          for (const [j, q] of loose.entries()) if (i !== j) nn = Math.min(nn, Math.hypot(p.x - q.x, p.y - q.y));
          if (!Number.isFinite(nn)) continue;
          row.nnSum += nn;
          row.nnCount++;
          if (nn < 3) row.nnClose++;
        }
      }
    }
    det.finish();
    m.onEvent = prev;
    row.ticks = sim.tick;
    for (const e of det.episodes) {
      row.fighters[e.fighter]!.episodes++;
      row.fighters[e.fighter]!.stuckTicks += e.end - e.start;
    }
    m.finishRound();
    rows.push(row);
  }
  return rows;
}

function load(spec: string): RoundRow[] {
  return spec.split(",").flatMap((f) => JSON.parse(readFileSync(f, "utf8")) as RoundRow[]);
}

function summary(rows: RoundRow[]) {
  const fr = rows.flatMap((r) => r.fighters);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const alive = sum(fr.map((f) => f.aliveTicks));
  const median = (xs: number[]) => {
    const s = xs.slice().sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)]! : NaN;
  };
  const dmg = { weapon: sum(rows.map((r) => r.dmg.weapon)), fist: sum(rows.map((r) => r.dmg.fist)), other: sum(rows.map((r) => r.dmg.other)) };
  const kos = { weapon: sum(rows.map((r) => r.kos.weapon)), fist: sum(rows.map((r) => r.kos.fist)), other: sum(rows.map((r) => r.kos.other)) };
  const got = fr.filter((f) => f.firstWeapon >= 0);
  return {
    rounds: rows.length,
    bare: (100 * sum(fr.map((f) => f.bareTicks))) / alive,
    bareBefore: (100 * sum(fr.map((f) => Math.min(f.bareTicks, f.toFirst)))) / alive,
    toFirstMedian: median(got.map((f) => f.firstWeapon)) / 60,
    toFirstMean: sum(got.map((f) => f.firstWeapon)) / Math.max(1, got.length) / 60,
    never: (100 * (fr.length - got.length)) / fr.length,
    pickups: sum(fr.map((f) => f.weaponPickups)) / fr.length,
    empties: sum(fr.map((f) => f.empties)) / fr.length,
    emptied: sum(fr.map((f) => f.emptied ?? 0)) / fr.length,
    dropped: sum(fr.map((f) => f.dropped ?? 0)) / fr.length,
    swapped: sum(fr.map((f) => f.swapped ?? 0)) / fr.length,
    dmgWeapon: (100 * dmg.weapon) / (dmg.weapon + dmg.fist + dmg.other),
    dmgFist: (100 * dmg.fist) / (dmg.weapon + dmg.fist + dmg.other),
    koWeapon: (100 * kos.weapon) / Math.max(1, kos.weapon + kos.fist + kos.other),
    koFist: (100 * kos.fist) / Math.max(1, kos.weapon + kos.fist + kos.other),
    dmgPerMin: (dmg.weapon + dmg.fist + dmg.other) / (alive / 3600),
    lengthMean: sum(rows.map((r) => r.ticks)) / rows.length / 60,
    lengthMedian: median(rows.map((r) => r.ticks)) / 60,
    timeouts: (100 * rows.filter((r) => r.ticks >= CLASSIC.round.fightTicks).length) / rows.length,
    startWeapons: sum(rows.map((r) => r.startWeapons)) / rows.length,
    looseMean: sum(rows.map((r) => r.looseSum)) / Math.max(1, sum(rows.map((r) => r.looseSamples))),
    loosePeak: sum(rows.map((r) => r.loosePeak)) / rows.length,
    loosePeakMax: Math.max(...rows.map((r) => r.loosePeak)),
    nn: sum(rows.map((r) => r.nnSum)) / Math.max(1, sum(rows.map((r) => r.nnCount))),
    nnClose: (100 * sum(rows.map((r) => r.nnClose))) / Math.max(1, sum(rows.map((r) => r.nnCount))),
    stuckPerMin: sum(fr.map((f) => f.episodes)) / (alive / 3600),
    stuckShare: (100 * sum(fr.map((f) => f.stuckTicks))) / alive,
    frStuck: (100 * fr.filter((f) => f.episodes > 0).length) / fr.length,
  };
}

const LABELS: [keyof ReturnType<typeof summary>, string, number, string][] = [
  ["rounds", "rounds", 0, ""],
  ["startWeapons", "weapons on the floor at the start", 1, ""],
  ["looseMean", "loose weapons on the floor (mean)", 2, ""],
  ["loosePeak", "loose weapons, peak per round (mean)", 1, ""],
  ["loosePeakMax", "loose weapons, highest peak", 0, ""],
  ["nn", "nearest other loose weapon (mean)", 1, " m"],
  ["nnClose", "loose weapons with another within 3 m", 1, "%"],
  ["bare", "time bare-handed (2+ alive)", 1, "%"],
  ["bareBefore", "  of it before the first weapon", 1, "%"],
  ["toFirstMedian", "time to the first weapon (median)", 1, " s"],
  ["toFirstMean", "time to the first weapon (mean)", 1, " s"],
  ["never", "fighter-rounds with no weapon at all", 1, "%"],
  ["pickups", "weapon pickups per fighter per round", 2, ""],
  ["empties", "weapons emptied or dropped per fighter per round", 2, ""],
  ["emptied", "  run empty (#95 event)", 2, ""],
  ["dropped", "  dropped on purpose (#95 event)", 2, ""],
  ["swapped", "  dropped for another weapon (#95 event)", 2, ""],
  ["dmgWeapon", "weapon share of fighter damage", 1, "%"],
  ["dmgFist", "fist share of fighter damage", 1, "%"],
  ["koWeapon", "weapon share of knockouts", 1, "%"],
  ["koFist", "fist share of knockouts", 1, "%"],
  ["dmgPerMin", "fighter damage per alive minute", 1, ""],
  ["lengthMean", "round length (mean)", 1, " s"],
  ["lengthMedian", "round length (median)", 1, " s"],
  ["timeouts", "rounds that time out", 1, "%"],
  ["stuckPerMin", "stuck episodes per alive minute (#88)", 3, ""],
  ["stuckShare", "stuck time (#88)", 2, "%"],
  ["frStuck", "fighter-rounds with a stuck episode", 1, "%"],
];

function report(specs: string[]) {
  const sums = specs.map((s) => summary(load(s)));
  const lines = [`| | ${specs.length > 1 ? "before | after" : "value"} |`, specs.length > 1 ? "|---|---|---|" : "|---|---|"];
  for (const [k, label, dp, unit] of LABELS) lines.push(`| ${label} | ${sums.map((s) => `${s[k].toFixed(dp)}${unit}`).join(" | ")} |`);
  console.log(lines.join("\n"));
}

const mode = process.argv[2];
if (mode === "sims") {
  await initPhysics();
  const count = Number(process.argv[3] ?? 100);
  const first = Number(process.argv[4] ?? 1);
  const out = arg("--out") ?? "economy.json";
  writeFileSync(out, JSON.stringify(runSims(count, first, JSON.parse(arg("--ruleset") ?? "{}"))));
  console.log(`wrote ${out}`);
} else if (mode === "report") {
  report(process.argv.slice(3).filter((a) => !a.startsWith("--")));
} else {
  console.error("usage: bun scripts/weapon-economy.ts sims [count] [first] --out f.json | report a.json[,a2.json] [b.json[,...]]");
  process.exit(1);
}
