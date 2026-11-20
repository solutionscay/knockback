import type { Strategy, Weapon } from "../sim/sim";
import { checkLine } from "./factcheck";
import { NA, type ChangeStats, type EvalDecision, type EvalMatch, type EvalReport, type FactCheck, type FieldVariety, type FollowStats, type ProviderReliability, type RulesStats, type VarietyGroup } from "./eval-types";

export const r3 = (x: number) => Math.round(x * 1000) / 1000;
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

const FIELDS = ["stance", "target", "retaliate", "weapons", "rules"] as const;
/** fields of the base plan: "changed" counts these only, so it compares with runs before rules */
const BASE_FIELDS = ["stance", "target", "retaliate", "weapons"];

function planDiff(a: Strategy, b: Strategy, names: string[]): string[] {
  const out: string[] = [];
  if (a.stance !== b.stance) out.push("stance");
  if (targetLabel(a, names) !== targetLabel(b, names)) out.push("target");
  if ((a.retaliate ?? "turn") !== (b.retaliate ?? "turn")) out.push("retaliate");
  if (a.weapons.join(">") !== b.weapons.join(">")) out.push("weapons");
  if (JSON.stringify((a.rules ?? []).map((r) => [r.when, r.who, r.item, r.value, r.do, r.doItem, r.stance, r.retaliate])) !== JSON.stringify((b.rules ?? []).map((r) => [r.when, r.who, r.item, r.value, r.do, r.doItem, r.stance, r.retaliate]))) out.push("rules");
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
          if (diff.some((x) => BASE_FIELDS.includes(x))) s.changed++;
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

/** The rules group (#7): how many plans carry rules, how many were rejected, how many fired. */
export function rulesOf(matches: EvalMatch[], role: Role): RulesStats | NA {
  let plans = 0;
  let withRules = 0;
  let written = 0;
  let rejected = 0;
  let fired = 0;
  let firings = 0;
  let activeTicks = 0;
  let rounds = 0;
  const byWhen: RulesStats["byWhen"] = {};
  const byDo: RulesStats["byDo"] = {};
  const never: string[] = [];
  for (const m of matches)
    m.rounds.forEach((rd, r) =>
      rd.decisions.forEach((d, seat) => {
        if (isHouse(m.seats, seat) !== (role === "house")) return;
        if (role === "ai") rejected += d.meta.ruleProblems?.length ?? 0;
        if (role === "ai" && !aiOwnPlan(d)) return;
        plans++;
        rounds++;
        const rules = d.strategy.rules ?? [];
        if (rules.length) withRules++;
        rules.forEach((rule, i) => {
          written++;
          const f = rd.facts.rules?.[seat]?.[i] ?? { fires: 0, activeTicks: 0 };
          const w = (byWhen[rule.when] ??= { written: 0, fired: 0, firings: 0 });
          const a = (byDo[rule.do] ??= { written: 0, fired: 0, firings: 0 });
          w.written++;
          a.written++;
          w.firings += f.fires;
          a.firings += f.fires;
          firings += f.fires;
          activeTicks += f.activeTicks;
          if (f.fires > 0) {
            fired++;
            w.fired++;
            a.fired++;
          } else if (never.length < 8) never.push(`${m.names[seat]}, round ${r + 1}: '${rule.label}' (${rule.when} -> ${rule.do})`);
        });
      }),
    );
  if (!plans) return NA;
  return {
    plans,
    plansWithRules: withRules,
    plansWithRulesRate: r3(withRules / plans),
    rulesWritten: written,
    rulesPerPlan: r3(written / plans),
    rejected,
    rejectedRate: written + rejected ? r3(rejected / (written + rejected)) : 0,
    fired,
    firedRate: written ? r3(fired / written) : 0,
    firingsPerRound: r3(firings / Math.max(1, rounds)),
    activeSecondsPerRule: written ? r3(activeTicks / 60 / written) : 0,
    byWhen,
    byDo,
    neverFired: never,
  };
}

export function whyOf(matches: EvalMatch[]): EvalReport["why"] {
  const ds = decisionsOf(matches, "ai");
  if (!ds.length) return NA;
  const w = ds.filter((x) => x.d.meta.why);
  return { answers: ds.length, withWhy: w.length, rate: r3(w.length / ds.length), samples: w.slice(0, 6).map((x) => `${x.m.names[x.seat]}: ${x.d.meta.why}`) };
}

export function reliabilityOf(matches: EvalMatch[]): Record<string, ProviderReliability> {
  const acc: Record<string, { ms: number[]; ok: number; timeouts: number; errors: number; invalid: number; calls: number; hedged: number }> = {};
  for (const m of matches)
    for (const rd of m.rounds)
      rd.decisions.forEach((d, seat) => {
        if (isHouse(m.seats, seat)) return;
        const a = (acc[d.meta.provider] ??= { ms: [], ok: 0, timeouts: 0, errors: 0, invalid: 0, calls: 0, hedged: 0 });
        a.calls++;
        if (d.meta.hedged) a.hedged++;
        a.ms.push(d.meta.ms);
        if (d.meta.outcome === "ok") a.ok++;
        else if (d.meta.outcome === "fallback-timeout") a.timeouts++;
        else if (d.meta.outcome === "fallback-error") a.errors++;
        else if (d.meta.outcome === "fallback-invalid") a.invalid++;
      });
  const out: Record<string, ProviderReliability> = {};
  for (const [k, a] of Object.entries(acc))
    out[k] = { calls: a.calls, hedged: a.hedged, ok: a.ok, timeouts: a.timeouts, errors: a.errors, invalid: a.invalid, fallbacks: a.timeouts + a.errors + a.invalid, ms: { median: quantile(a.ms, 0.5), p90: quantile(a.ms, 0.9), max: Math.max(0, ...a.ms) } };
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
