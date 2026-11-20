/**
 * AI match evaluation: pure metric functions (#2).
 *
 * Input: a list of EvalMatch (what was decided before each round, by whom,
 * and the facts of each round). Output: a report object. No I/O, no
 * randomness: unit tests feed fixed matches; scripts/ai-eval.ts feeds real
 * ones (evalMatchFrom builds an EvalMatch from a finished Match).
 *
 * Groups: variety, change, rules, follows the stats, facts, reliability,
 * results. Groups for features that do not exist yet (rules, check-ins)
 * report "n/a".
 */
import type { DecisionMeta, Match } from "../sim/match";
import { checkFactsFromStats, checkLine } from "./factcheck";
import type { Strategy, Weapon } from "../sim/sim";

export interface EvalDecision {
  strategy: Strategy;
  line: string;
  meta: DecisionMeta;
  /** what the house bot would have planned in the same situation (AI seats; for comparison) */
  house?: Strategy;
}

/** What happened in a round, as far as the metrics need it. */
export interface EvalRoundFacts {
  winner: number;
  kos: { victim: number; by: number; weapon: string; cause: "ringout" | "hp" }[];
  /** damage[attacker][victim] */
  damage: number[][];
  /** hits from behind: behind[attacker][victim] */
  behind: number[][];
  /** weapons that did damage: weapons[attacker][victim] */
  weapons?: string[][][];
}

export interface EvalRound {
  /** decisions made before this round, per seat */
  decisions: EvalDecision[];
  facts: EvalRoundFacts;
}

export interface EvalMatch {
  seed: number;
  /** fighter names per seat (from the souls) */
  names: string[];
  /** provider name per seat ("house" = house bot) */
  seats: string[];
  rounds: EvalRound[];
  winner: number;
}

export const NA = "n/a" as const;
type NA = typeof NA;

export interface FieldVariety {
  n: number;
  /** value -> count */
  dist: Record<string, number>;
  /** Shannon entropy in bits */
  entropy: number;
  top: string;
  topShare: number;
}

export interface VarietyGroup {
  answers: number;
  stance: FieldVariety;
  target: FieldVariety;
  retaliate: FieldVariety;
  weapon1: FieldVariety;
  weapons: FieldVariety;
}

export interface ChangeStats {
  /** consecutive-round pairs (same seat, same match) */
  transitions: number;
  changed: number;
  changeRate: number;
  /** field -> times it changed */
  fields: Record<string, number>;
}

export interface FollowStats {
  /** decisions after a round (round 2+) judged */
  decisions: number;
  /** knocked out by a rival last round, and targeted that rival by name */
  targetedKiller: { chances: number; hits: number; rate: number };
  /** targeted last round's winner (when it was someone else) */
  targetedWinner: { chances: number; hits: number; rate: number };
  /** targeted the rival who did the most damage to it */
  targetedTopDamager: { chances: number; hits: number; rate: number };
  /** named any rival as target */
  namedTarget: { chances: number; hits: number; rate: number };
  /** knocked out by a pickup weapon it did not want: did that weapon enter the wish list? */
  killerWeaponAdded: { chances: number; hits: number; rate: number };
}

export interface FactCheck {
  /** lines (round 2+) that name a rival together with an event */
  checked: number;
  /** decisions whose meta carries a fact warning (the post-check in decideRound) */
  warnings: number;
  mismatches: { seed: number; round: number; fighter: string; line: string; claim: string; facts: string }[];
}

export interface ProviderReliability {
  calls: number;
  ok: number;
  timeouts: number;
  errors: number;
  invalid: number;
  fallbacks: number;
  ms: { median: number; p90: number; max: number };
}

export interface EvalReport {
  version: 1;
  matches: number;
  /** true when the house columns are the house bot's plans in the AI's place (no house seats in the run) */
  houseInAiPlace: boolean;
  rounds: number;
  seeds: number[];
  lineups: string[];
  variety: { ai: VarietyGroup | NA; house: VarietyGroup | NA };
  change: { ai: ChangeStats | NA; house: ChangeStats | NA; byFighter: Record<string, ChangeStats>; checkinsPerRound: NA };
  rules: { rulesPerPlan: NA; rejected: NA; firingsPerRound: NA; firingsByKind: NA; neverFired: NA };
  follows: { ai: FollowStats | NA; house: FollowStats | NA };
  facts: FactCheck;
  reliability: Record<string, ProviderReliability>;
  results: {
    ai: { seats: number; roundWins: number; roundWinRate: number; matchWins: number; matchWinRate: number } | NA;
    house: { seats: number; roundWins: number; roundWinRate: number; matchWins: number; matchWinRate: number } | NA;
    /** a fair share for one seat: 1 / 4 */
    fairShare: number;
  };
}

// ------------------------------------------------------------------ helpers

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const rate = (hits: number, chances: number) => ({ chances, hits, rate: chances ? r3(hits / chances) : 0 });

export function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
}

export function variety(values: string[]): FieldVariety {
  const dist: Record<string, number> = {};
  for (const v of values) dist[v] = (dist[v] ?? 0) + 1;
  const n = values.length;
  let entropy = 0;
  let top = "";
  let topN = 0;
  for (const [k, c] of Object.entries(dist).sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))) {
    const p = c / n;
    entropy -= p * Math.log2(p);
    if (c > topN) {
      top = k;
      topN = c;
    }
  }
  return { n, dist, entropy: r3(entropy), top, topShare: n ? r3(topN / n) : 0 };
}

/** How a plan's target reads: a rival's name, or the preference. */
export function targetLabel(s: Strategy, names: string[]): string {
  return s.target === "grudge" && s.grudge !== undefined ? (names[s.grudge] ?? `seat ${s.grudge}`) : s.target;
}

const isHouse = (seats: string[], i: number) => seats[i] === "house";
/** The AI's own plan (not a house-bot stand-in after a timeout or error, nor a rejected plan). */
const aiOwnPlan = (d: EvalDecision) => d.meta.outcome === "ok";

type Role = "ai" | "house";
/** No house seats at all: compare with what the house bot would have planned in the AI's place. */
export const hasHouseSeats = (matches: EvalMatch[]) => matches.some((m) => m.seats.includes("house"));
function decisionsOf(matches: EvalMatch[], role: Role) {
  const out: { m: EvalMatch; r: number; seat: number; d: EvalDecision }[] = [];
  const shadow = role === "house" && !hasHouseSeats(matches);
  for (const m of matches)
    m.rounds.forEach((rd, r) =>
      rd.decisions.forEach((d, seat) => {
        if (shadow) {
          if (!isHouse(m.seats, seat) && aiOwnPlan(d) && d.house) out.push({ m, r, seat, d: { ...d, strategy: d.house } });
        } else if (role === "house" ? isHouse(m.seats, seat) : !isHouse(m.seats, seat) && aiOwnPlan(d)) out.push({ m, r, seat, d });
      }),
    );
  return out;
}

// ------------------------------------------------------------------ groups

export function varietyOf(matches: EvalMatch[], role: Role): VarietyGroup | NA {
  const ds = decisionsOf(matches, role);
  if (!ds.length) return NA;
  return {
    answers: ds.length,
    stance: variety(ds.map((x) => x.d.strategy.stance)),
    target: variety(ds.map((x) => targetLabel(x.d.strategy, x.m.names))),
    retaliate: variety(ds.map((x) => x.d.strategy.retaliate ?? "turn")),
    weapon1: variety(ds.map((x) => x.d.strategy.weapons[0] ?? "-")),
    weapons: variety(ds.map((x) => x.d.strategy.weapons.join(">"))),
  };
}

const FIELDS = ["stance", "target", "retaliate", "weapons"] as const;

function planDiff(a: Strategy, b: Strategy, names: string[]): string[] {
  const out: string[] = [];
  if (a.stance !== b.stance) out.push("stance");
  if (targetLabel(a, names) !== targetLabel(b, names)) out.push("target");
  if ((a.retaliate ?? "turn") !== (b.retaliate ?? "turn")) out.push("retaliate");
  if (a.weapons.join(">") !== b.weapons.join(">")) out.push("weapons");
  return out;
}

export function changeOf(matches: EvalMatch[], role: Role): { all: ChangeStats | NA; byFighter: Record<string, ChangeStats> } {
  const empty = (): ChangeStats => ({ transitions: 0, changed: 0, changeRate: 0, fields: Object.fromEntries(FIELDS.map((f) => [f, 0])) });
  const all = empty();
  const byFighter: Record<string, ChangeStats> = {};
  for (const m of matches) {
    for (let seat = 0; seat < 4; seat++) {
      if (isHouse(m.seats, seat) !== (role === "house")) continue;
      for (let r = 1; r < m.rounds.length; r++) {
        const a = m.rounds[r - 1]!.decisions[seat]!;
        const b = m.rounds[r]!.decisions[seat]!;
        if (role === "ai" && (!aiOwnPlan(a) || !aiOwnPlan(b))) continue;
        const key = `${m.names[seat]} (${m.seats[seat]})`;
        const f = (byFighter[key] ??= empty());
        const diff = planDiff(a.strategy, b.strategy, m.names);
        for (const s of [all, f]) {
          s.transitions++;
          if (diff.length) s.changed++;
          for (const d of diff) s.fields[d]!++;
        }
      }
    }
  }
  for (const s of [all, ...Object.values(byFighter)]) s.changeRate = s.transitions ? r3(s.changed / s.transitions) : 0;
  return { all: all.transitions ? all : NA, byFighter };
}

const PICKUP: readonly string[] = ["rocket", "shotgun", "bat", "grenade", "grapple"];

export function followsOf(matches: EvalMatch[], role: Role): FollowStats | NA {
  const c = { killer: [0, 0], winner: [0, 0], top: [0, 0], named: [0, 0], weapon: [0, 0] };
  let decisions = 0;
  for (const { m, r, seat, d } of decisionsOf(matches, role)) {
    if (r === 0) continue;
    const prev = m.rounds[r - 1]!;
    const f = prev.facts;
    const s = d.strategy;
    const named = s.target === "grudge" && s.grudge !== undefined ? s.grudge : -1;
    decisions++;
    c.named[0]++;
    if (named >= 0) c.named[1]++;
    const ko = f.kos.find((k) => k.victim === seat && k.by >= 0 && k.by !== seat);
    if (ko) {
      c.killer[0]++;
      if (named === ko.by) c.killer[1]++;
      const before = (role === "house" && !hasHouseSeats(matches) ? prev.decisions[seat]!.house : undefined)?.weapons ?? prev.decisions[seat]!.strategy.weapons;
      if (PICKUP.includes(ko.weapon) && !before.includes(ko.weapon as Weapon)) {
        c.weapon[0]++;
        if (s.weapons.includes(ko.weapon as Weapon)) c.weapon[1]++;
      }
    }
    if (f.winner >= 0 && f.winner !== seat) {
      c.winner[0]++;
      if (named === f.winner) c.winner[1]++;
    }
    let top = -1;
    for (let a = 0; a < 4; a++) if (a !== seat && (f.damage[a]?.[seat] ?? 0) > (top >= 0 ? f.damage[top]![seat]! : 0)) top = a;
    if (top >= 0) {
      c.top[0]++;
      if (named === top) c.top[1]++;
    }
  }
  if (!decisions) return NA;
  return {
    decisions,
    targetedKiller: rate(c.killer[1]!, c.killer[0]!),
    targetedWinner: rate(c.winner[1]!, c.winner[0]!),
    targetedTopDamager: rate(c.top[1]!, c.top[0]!),
    namedTarget: rate(c.named[1]!, c.named[0]!),
    killerWeaponAdded: rate(c.weapon[1]!, c.weapon[0]!),
  };
}

/** The facts metric: every line spoken before round 2+ that names a rival with a claim, checked (see factcheck.ts). */
export function factsOf(matches: EvalMatch[]): FactCheck {
  const out: FactCheck = { checked: 0, mismatches: [], warnings: 0 };
  for (const m of matches) {
    for (let r = 1; r < m.rounds.length; r++) {
      const f = m.rounds[r - 1]!.facts;
      m.rounds[r]!.decisions.forEach((d, me) => {
        if (d.meta.factWarnings?.length) out.warnings++;
        const res = checkLine(d.line, me, m.names, f);
        if (!res.checked) return;
        out.checked++;
        for (const x of res.mismatches) out.mismatches.push({ seed: m.seed, round: r + 1, fighter: m.names[me]!, line: d.line, claim: x.claim, facts: x.facts });
      });
    }
  }
  return out;
}

export function reliabilityOf(matches: EvalMatch[]): Record<string, ProviderReliability> {
  const acc: Record<string, { ms: number[]; ok: number; timeouts: number; errors: number; invalid: number; calls: number }> = {};
  for (const m of matches)
    for (const rd of m.rounds)
      rd.decisions.forEach((d, seat) => {
        if (isHouse(m.seats, seat)) return;
        const a = (acc[d.meta.provider] ??= { ms: [], ok: 0, timeouts: 0, errors: 0, invalid: 0, calls: 0 });
        a.calls++;
        a.ms.push(d.meta.ms);
        if (d.meta.outcome === "ok") a.ok++;
        else if (d.meta.outcome === "fallback-timeout") a.timeouts++;
        else if (d.meta.outcome === "fallback-error") a.errors++;
        else if (d.meta.outcome === "fallback-invalid") a.invalid++;
      });
  const out: Record<string, ProviderReliability> = {};
  for (const [k, a] of Object.entries(acc))
    out[k] = { calls: a.calls, ok: a.ok, timeouts: a.timeouts, errors: a.errors, invalid: a.invalid, fallbacks: a.timeouts + a.errors + a.invalid, ms: { median: quantile(a.ms, 0.5), p90: quantile(a.ms, 0.9), max: Math.max(0, ...a.ms) } };
  return out;
}

export function resultsOf(matches: EvalMatch[]): EvalReport["results"] {
  const side = (role: Role) => {
    let seats = 0;
    let seatRounds = 0;
    let roundWins = 0;
    let matchWins = 0;
    for (const m of matches) {
      const mine = m.seats.map((_, i) => i).filter((i) => isHouse(m.seats, i) === (role === "house"));
      seats += mine.length;
      seatRounds += mine.length * m.rounds.length;
      roundWins += m.rounds.filter((rd) => mine.includes(rd.facts.winner)).length;
      if (mine.includes(m.winner)) matchWins++;
    }
    if (!seats) return NA;
    // win rate per seat: a fair seat wins 1/4 of rounds and matches
    return { seats, roundWins, roundWinRate: r3(roundWins / seatRounds), matchWins, matchWinRate: r3(matchWins / seats) };
  };
  return { ai: side("ai"), house: side("house"), fairShare: 0.25 };
}

/** The whole report. Pure. */
export function computeReport(matches: EvalMatch[]): EvalReport {
  const ai = changeOf(matches, "ai");
  const house = changeOf(matches, "house");
  return {
    version: 1,
    matches: matches.length,
    houseInAiPlace: !hasHouseSeats(matches),
    rounds: matches.reduce((a, m) => a + m.rounds.length, 0),
    seeds: matches.map((m) => m.seed),
    lineups: [...new Set(matches.map((m) => m.seats.join(",")))],
    variety: { ai: varietyOf(matches, "ai"), house: varietyOf(matches, "house") },
    change: { ai: ai.all, house: house.all, byFighter: { ...ai.byFighter, ...house.byFighter }, checkinsPerRound: NA },
    rules: { rulesPerPlan: NA, rejected: NA, firingsPerRound: NA, firingsByKind: NA, neverFired: NA },
    follows: { ai: followsOf(matches, "ai"), house: followsOf(matches, "house") },
    facts: factsOf(matches),
    reliability: reliabilityOf(matches),
    results: resultsOf(matches),
  };
}

// ------------------------------------------------------------------ from a real match

/**
 * Build the eval input from a finished Match (its record meta and round
 * facts). `housePlans[round][seat]`: what the house bot would have planned.
 */
export function evalMatchFrom(match: Match, seats: string[], housePlans?: (Strategy | undefined)[][]): EvalMatch {
  return {
    seed: match.seed,
    names: match.names,
    seats: seats.slice(),
    winner: match.winner,
    rounds: match.record.rounds.map((rd, r) => {
      const f = match.facts[r]!;
      return {
        decisions: rd.strategies.map((s, i) => ({ strategy: s, line: rd.lines[i]!, meta: rd.meta?.[i] ?? { provider: "house", ms: 0, outcome: "house" as const }, ...(housePlans?.[r]?.[i] ? { house: housePlans[r]![i]! } : {}) })),
        facts: { winner: f.winner, ...checkFactsFromStats(f.stats), kos: f.stats.kos.map((k) => ({ victim: k.victim, by: k.by, weapon: k.weapon, cause: k.cause })) },
      };
    }),
  };
}

// ------------------------------------------------------------------ compare

/** Every numeric leaf of a report, by path ("variety.ai.stance.entropy"). Distributions are skipped. */
export function flatten(o: unknown, prefix = "", out: Record<string, number> = {}): Record<string, number> {
  if (typeof o === "number") out[prefix] = o;
  else if (o && typeof o === "object" && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) if (k !== "dist" && k !== "seeds") flatten(v, prefix ? `${prefix}.${k}` : k, out);
  return out;
}

export interface MetricDelta {
  metric: string;
  old: number | NA;
  new: number | NA;
  delta: number | NA;
}

/** The change for each metric (old report -> new report). */
export function compareReports(oldR: EvalReport, newR: EvalReport): MetricDelta[] {
  const fl = (r: EvalReport) => ({ checked: r.facts.checked, mismatches: r.facts.mismatches.length, mismatchRate: r.facts.checked ? r3(r.facts.mismatches.length / r.facts.checked) : 0, warnings: r.facts.warnings ?? 0 });
  const a = flatten({ ...oldR, facts: fl(oldR) });
  const b = flatten({ ...newR, facts: fl(newR) });
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => k !== "version").sort();
  return keys.map((k) => ({ metric: k, old: a[k] ?? NA, new: b[k] ?? NA, delta: a[k] !== undefined && b[k] !== undefined ? r3(b[k]! - a[k]!) : NA }));
}

// ------------------------------------------------------------------ markdown

const pct = (x: number) => `${Math.round(x * 100)}%`;
const fr = (x: { hits: number; chances: number; rate: number }) => (x.chances ? `${x.hits}/${x.chances} (${pct(x.rate)})` : "no chances");

export function reportMarkdown(rep: EvalReport, opts: { title?: string; compare?: MetricDelta[]; meta?: string[] } = {}): string {
  const L: string[] = [];
  L.push(`# ${opts.title ?? "AI eval report"}`, "");
  L.push(`${rep.matches} matches, ${rep.rounds} rounds. Seeds: ${rep.seeds.join(", ")}. Lineups (by seat): ${rep.lineups.join(" | ")}.`);
  for (const m of opts.meta ?? []) L.push(m);
  L.push("");

  const houseWhat = rep.houseInAiPlace ? "house: what the house bot would have planned in the same spots (no house seats in this run)" : "house: house-bot seats";
  L.push("## Variety", "", `Share of the most common value, entropy in bits, and the distribution, over all answers (AI: the AI's own valid plans; ${houseWhat}).`, "");
  L.push("| Field | AI top share | AI entropy | AI distribution | House top share | House entropy |", "|---|---|---|---|---|---|");
  for (const f of ["stance", "target", "retaliate", "weapon1", "weapons"] as const) {
    const a = rep.variety.ai === NA ? null : rep.variety.ai[f];
    const h = rep.variety.house === NA ? null : rep.variety.house[f];
    const dist = a ? Object.entries(a.dist).sort((x, y) => y[1] - x[1]).map(([k, c]) => `${k} ${c}`).join(", ") : NA;
    L.push(`| ${f === "weapon1" ? "weapons[0]" : f === "weapons" ? "weapon list" : f} | ${a ? `${pct(a.topShare)} (${a.top})` : NA} | ${a ? a.entropy : NA} | ${dist} | ${h ? `${pct(h.topShare)} (${h.top})` : NA} | ${h ? h.entropy : NA} |`);
  }
  L.push("");

  L.push("## Change", "", "How often a fighter's plan changed between rounds, and which fields.", "");
  L.push("| Who | Transitions | Changed | stance | target | retaliate | weapons |", "|---|---|---|---|---|---|---|");
  const row = (name: string, s: ChangeStats | NA) =>
    s === NA ? `| ${name} | ${NA} | | | | | |` : `| ${name} | ${s.transitions} | ${s.changed} (${pct(s.changeRate)}) | ${s.fields.stance} | ${s.fields.target} | ${s.fields.retaliate} | ${s.fields.weapons} |`;
  L.push(row("all AI", rep.change.ai), row("all house", rep.change.house));
  for (const [k, s] of Object.entries(rep.change.byFighter).sort()) L.push(row(k, s));
  L.push("", `Check-in updates per round: ${rep.change.checkinsPerRound} (check-ins don't exist yet).`, "");

  L.push("## Rules", "", `${NA}: conditional plans don't exist yet (rules per plan, rejected, firings per round, by kind, never fired).`, "");

  L.push("## Follows the stats", "", `Decisions after a round (round 2 on). Targeting counts only a rival named as the target. ${rep.houseInAiPlace ? "House column: the house bot's plan in the same spots." : "House column: house-bot seats."}`, "");
  L.push("| Measure | AI | House |", "|---|---|---|");
  const fa = rep.follows.ai;
  const fh = rep.follows.house;
  for (const [k, label] of [
    ["targetedKiller", "targeted the fighter who knocked it out"],
    ["targetedWinner", "targeted last round's winner"],
    ["targetedTopDamager", "targeted the fighter who hurt it most"],
    ["namedTarget", "named any rival as target"],
    ["killerWeaponAdded", "the weapon that knocked it out entered its wish list"],
  ] as const)
    L.push(`| ${label} | ${fa === NA ? NA : fr(fa[k])} | ${fh === NA ? NA : fr(fh[k])} |`);
  L.push("");

  L.push("## Facts", "", `Heuristic, not a judge: ${rep.facts.checked} lines named a rival together with an event; ${rep.facts.mismatches.length} possible mismatches (${rep.facts.checked ? pct(rep.facts.mismatches.length / rep.facts.checked) : "n/a"} of checked lines). Fact warnings logged in the decision meta: ${rep.facts.warnings}.`, "");
  for (const x of rep.facts.mismatches) L.push(`- seed ${x.seed}, before round ${x.round}, ${x.fighter}: "${x.line}" (claims ${x.claim}; facts: ${x.facts})`);
  if (rep.facts.mismatches.length) L.push("");

  L.push("## Reliability", "");
  const rel = Object.entries(rep.reliability);
  if (!rel.length) L.push(`${NA}: no AI seats.`, "");
  else {
    L.push("| Provider | Calls | OK | Timeouts | Errors | Invalid | Fallbacks | Median | p90 | Max |", "|---|---|---|---|---|---|---|---|---|---|");
    for (const [k, r] of rel) L.push(`| ${k} | ${r.calls} | ${r.ok} | ${r.timeouts} | ${r.errors} | ${r.invalid} | ${r.fallbacks} | ${(r.ms.median / 1000).toFixed(1)} s | ${(r.ms.p90 / 1000).toFixed(1)} s | ${(r.ms.max / 1000).toFixed(1)} s |`);
    L.push("");
  }

  L.push("## Results", "", `Win rate per seat (a fair seat wins ${pct(rep.results.fairShare)}). Souls rotate across seats every match.`, "");
  L.push("| Side | Seats | Round wins | Round win rate | Match wins | Match win rate |", "|---|---|---|---|---|---|");
  for (const [k, s] of [["AI", rep.results.ai], ["House", rep.results.house]] as const)
    L.push(s === NA ? `| ${k} | ${NA} | | | | |` : `| ${k} | ${s.seats} | ${s.roundWins} | ${pct(s.roundWinRate)} | ${s.matchWins} | ${pct(s.matchWinRate)} |`);
  L.push("");

  if (opts.compare) {
    L.push("## Compared with the old report", "", "| Metric | Old | New | Change |", "|---|---|---|---|");
    for (const d of opts.compare) if (d.delta === NA || d.delta !== 0) L.push(`| ${d.metric} | ${d.old} | ${d.new} | ${d.delta === NA ? NA : d.delta > 0 ? `+${d.delta}` : d.delta} |`);
    L.push("", `Unchanged metrics are left out (${opts.compare.filter((d) => d.delta === 0).length}).`, "");
  }
  return L.join("\n");
}
