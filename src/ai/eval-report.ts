import { formatSeconds } from "../format";
import { r3 } from "./eval-metrics";
import { NA, type ChangeStats, type EvalReport, type RulesStats } from "./eval-types";

/** Every numeric leaf of a report, by path ("variety.ai.stance.entropy"). Distributions are skipped. */
export function flatten(o: unknown, prefix = "", out: Record<string, number> = {}): Record<string, number> {
  if (typeof o === "number") out[prefix] = o;
  else if (o && typeof o === "object" && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) if (k !== "dist" && k !== "seeds" && k !== "samples") flatten(v, prefix ? `${prefix}.${k}` : k, out);
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
  L.push("Changed counts the base plan (stance, target, retaliate, weapons); the rules column shows rule-set changes separately.", "");
  L.push("| Who | Transitions | Changed | stance | target | retaliate | weapons | rules |", "|---|---|---|---|---|---|---|---|");
  const row = (name: string, s: ChangeStats | NA) =>
    s === NA ? `| ${name} | ${NA} | | | | | | |` : `| ${name} | ${s.transitions} | ${s.changed} (${pct(s.changeRate)}) | ${s.fields.stance} | ${s.fields.target} | ${s.fields.retaliate} | ${s.fields.weapons} | ${s.fields.rules ?? 0} |`;
  L.push(row("all AI", rep.change.ai), row("all house", rep.change.house));
  for (const [k, s] of Object.entries(rep.change.byFighter).sort()) L.push(row(k, s));
  L.push("", `Check-in plan updates per round: ${rep.change.checkinsPerRound}${rep.change.checkinsPerRound === NA ? " (check-ins were off)" : ""}.`, "");
  if (rep.checkins && rep.checkins !== NA) {
    L.push("## Check-ins", "", "Mid-round check-ins (#9): asked, answered (miss rate), plan updates, keeps, invalid answers and errors; latency of the answers; prompt size and estimated tokens (about 4 characters a token).", "");
    L.push("| Provider | Asked | Answered (miss) | Updates | Keeps | Invalid | Errors | Latency avg / median / max | Prompt chars | Tokens in / out |", "|---|---|---|---|---|---|---|---|---|---|");
    for (const c of rep.checkins)
      L.push(`| ${c.provider} | ${c.asked} | ${c.answered} (${pct(c.missRate)}) | ${c.updates} | ${c.keeps} | ${c.invalid} | ${c.errors} | ${(c.avgMs / 1000).toFixed(1)} / ${(c.p50Ms / 1000).toFixed(1)} / ${(c.maxMs / 1000).toFixed(1)} s | ${c.avgPromptChars} | ~${c.tokensIn} / ~${c.tokensOut} |`);
    L.push("");
  }

  L.push("## Rules", "", "Plan rules (#5-#7). Rejected = dropped by the parser; fired = started at least once in its round.", "");
  L.push("| Measure | AI | House |", "|---|---|---|");
  const ra = rep.rules.ai;
  const rh = rep.rules.house;
  const rr = (s: RulesStats | NA, f: (x: RulesStats) => string) => (s === NA ? NA : f(s));
  for (const [label, f] of [
    ["plans with 1+ rules", (x: RulesStats) => `${x.plansWithRules}/${x.plans} (${pct(x.plansWithRulesRate)})`],
    ["rules per plan", (x: RulesStats) => String(x.rulesPerPlan)],
    ["rules rejected", (x: RulesStats) => `${x.rejected} (${pct(x.rejectedRate)} of rules sent)`],
    ["rules that fired at least once", (x: RulesStats) => `${x.fired}/${x.rulesWritten} (${pct(x.firedRate)})`],
    ["firings per fighter-round", (x: RulesStats) => String(x.firingsPerRound)],
    ["active seconds per rule", (x: RulesStats) => String(x.activeSecondsPerRule)],
  ] as const)
    L.push(`| ${label} | ${rr(ra, f)} | ${rr(rh, f)} |`);
  L.push("");
  for (const [k, s] of [["AI", ra], ["House", rh]] as const) {
    if (s === NA || !s.rulesWritten) continue;
    L.push(`${k} by trigger (written / fired / firings): ${Object.entries(s.byWhen).sort((a, b) => b[1].written - a[1].written).map(([w, v]) => `${w} ${v.written}/${v.fired}/${v.firings}`).join(", ")}.`);
    L.push(`${k} by action: ${Object.entries(s.byDo).sort((a, b) => b[1].written - a[1].written).map(([w, v]) => `${w} ${v.written}/${v.fired}/${v.firings}`).join(", ")}.`);
    if (s.neverFired.length) L.push(`${k} rules that never fired (first ${s.neverFired.length}): ${s.neverFired.join("; ")}.`);
    L.push("");
  }

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

  L.push("## Why", "");
  if (rep.why === NA) L.push(`${NA}: no AI answers.`, "");
  else {
    L.push(`${rep.why.withWhy} of ${rep.why.answers} AI plans gave a reason (${pct(rep.why.rate)}).`);
    for (const s of rep.why.samples) L.push(`- ${s}`);
    L.push("");
  }

  L.push("## Reliability", "");
  const rel = Object.entries(rep.reliability);
  if (!rel.length) L.push(`${NA}: no AI seats.`, "");
  else {
    L.push("| Provider | Calls | OK | Hedged | Timeouts | Errors | Invalid | Fallbacks | Median | p90 | Max |", "|---|---|---|---|---|---|---|---|---|---|---|");
    for (const [k, r] of rel) L.push(`| ${k} | ${r.calls} | ${r.ok} | ${r.hedged ?? 0} | ${r.timeouts} | ${r.errors} | ${r.invalid} | ${r.fallbacks} | ${formatSeconds(r.ms.median)} | ${formatSeconds(r.ms.p90)} | ${formatSeconds(r.ms.max)} |`);
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
