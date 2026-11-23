/**
 * The plan card's model (#104), pure (tested): what a fighter plays at a fight tick, its last change and why, and
 * which of its rules is on. Its data comes from the live stream (decisions, planUpdate), from a saved record
 * (strategies, planUpdates, firings) and from the viewer's own rule and knockout events (embed.ts), whichever
 * arrive; the same event twice counts once.
 */
import type { PlanEvent } from "../viewer/embed";
import type { PlanUpdate, RuleFiring } from "../sim/fight";
import type { Rule, Strategy } from "../sim/sim-types";

export interface PlanRound {
  round: number;
  strategies: Strategy[];
  whys: (string | undefined)[];
  lines: string[];
  updates: PlanUpdate[];
  firings: RuleFiring[];
  kos: { tick: number; fighter: number }[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown, d = -1) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 200) : undefined);
const isStrategy = (v: unknown): v is Strategy => isObj(v) && typeof v.target === "string" && typeof v.stance === "string" && Array.isArray(v.weapons);

function newRound(round: number): PlanRound {
  return { round, strategies: [], whys: [], lines: [], updates: [], firings: [], kos: [] };
}

const firingKey = (f: { tick: number; fighter: number; rule: number; on: boolean }) => `${f.tick}.${f.fighter}.${f.rule}.${f.on ? 1 : 0}`;

/** Every round's plans, as far as they are known. */
export class PlanBook {
  readonly rounds = new Map<number, PlanRound>();
  names: string[] = [];
  labels: string[] = [];
  private firingKeys = new Map<number, Set<string>>();

  get(round: number): PlanRound {
    let r = this.rounds.get(round);
    if (!r) this.rounds.set(round, (r = newRound(round)));
    return r;
  }

  /** A live stream message (the Arena stream restarts at each round: "match" starts over). */
  live(msg: unknown) {
    if (!isObj(msg)) return;
    const round = num(msg.round, 0);
    switch (msg.type) {
      case "match":
        this.rounds.clear();
        this.firingKeys.clear();
        if (Array.isArray(msg.names)) this.names = msg.names.map(String);
        if (Array.isArray(msg.labels)) this.labels = msg.labels.map(String);
        return;
      case "decisions": {
        if (!Array.isArray(msg.decisions)) return;
        const r = this.get(round);
        r.strategies = msg.decisions.map((d) => (isObj(d) && isStrategy(d.strategy) ? d.strategy : ({ target: "nearest", stance: "rush", weapons: [] } as unknown as Strategy)));
        r.lines = msg.decisions.map((d) => (isObj(d) && typeof d.line === "string" ? d.line : ""));
        r.whys = Array.isArray(msg.meta) ? msg.meta.map((m) => (isObj(m) ? str(m.why) : undefined)) : [];
        return;
      }
      case "planUpdate": {
        const u = msg.update;
        if (!isObj(u) || !isStrategy(u.strategy)) return;
        const r = this.get(round);
        const up: PlanUpdate = { tick: num(u.tick, 0), fighter: num(u.fighter, 0), strategy: u.strategy, ...(str(u.line) ? { line: str(u.line) } : {}), ...(str(u.why) ? { why: str(u.why) } : {}) };
        if (!r.updates.some((x) => x.tick === up.tick && x.fighter === up.fighter)) r.updates = [...r.updates, up].sort((a, b) => a.tick - b.tick || a.fighter - b.fighter);
        return;
      }
      case "round": {
        const r = this.get(round);
        if (Array.isArray(msg.kos)) for (const k of msg.kos) if (isObj(k) && typeof k.tick === "number") this.ko(r, k.tick, num(k.victim));
        return;
      }
    }
  }

  /** A saved record: the plans, the plan updates and (since #104) the rule firings. */
  record(rec: unknown) {
    if (!isObj(rec) || !Array.isArray(rec.rounds)) return;
    if (Array.isArray(rec.labels)) this.labels = rec.labels.map(String);
    rec.rounds.forEach((rd, i) => {
      if (!isObj(rd) || !Array.isArray(rd.strategies)) return;
      const r = this.get(i + 1);
      r.strategies = rd.strategies.filter(isStrategy);
      r.lines = Array.isArray(rd.lines) ? rd.lines.map((l) => (typeof l === "string" ? l : "")) : [];
      r.whys = Array.isArray(rd.meta) ? rd.meta.map((m) => (isObj(m) ? str(m.why) : undefined)) : [];
      r.updates = Array.isArray(rd.planUpdates) ? rd.planUpdates.filter((u): u is PlanUpdate => isObj(u) && isStrategy(u.strategy) && typeof u.tick === "number" && typeof u.fighter === "number") : [];
      // #104: rounds saved before firings were recorded have none; the viewer's events fill them in as it plays
      if (Array.isArray(rd.firings)) for (const f of rd.firings) if (isObj(f)) this.firing(r, { tick: num(f.tick, 0), fighter: num(f.fighter, 0), rule: num(f.rule, 0), on: f.on === true, subject: num(f.subject) });
    });
  }

  /** A rule or knockout event from the viewer (embed.ts). */
  event(round: number, e: PlanEvent) {
    const r = this.get(round);
    if (e.type === "rule") this.firing(r, e);
    else this.ko(r, e.tick, e.fighter);
  }

  private firing(r: PlanRound, e: { tick: number; fighter: number; rule: number; on: boolean; subject: number }) {
    let keys = this.firingKeys.get(r.round);
    if (!keys) this.firingKeys.set(r.round, (keys = new Set()));
    const k = firingKey(e);
    if (keys.has(k)) return;
    keys.add(k);
    const f: RuleFiring = { tick: e.tick, fighter: e.fighter, rule: e.rule, subject: e.subject, on: e.on };
    // mostly in order: insert from the end
    let i = r.firings.length;
    while (i > 0 && r.firings[i - 1]!.tick > f.tick) i--;
    r.firings.splice(i, 0, f);
  }

  private ko(r: PlanRound, tick: number, fighter: number) {
    if (fighter < 0 || r.kos.some((k) => k.fighter === fighter)) return;
    r.kos.push({ tick, fighter });
  }
}

// ------------------------------------------------------------------ at a tick

const targetOf = (s: Strategy, names: string[]) => (s.target === "grudge" && s.grudge !== undefined ? (names[s.grudge] ?? "?") : s.target);
const ruleLabels = (s: Strategy) => (s.rules ?? []).map((r) => r.label).join("|");

/** One field that changed: "target weakest → Pickle". */
export interface PlanDiff {
  field: "target" | "stance" | "weapons" | "retaliate" | "rules";
  from: string;
  to: string;
}

/** What changed from one plan to the next (pure). */
export function planDiff(prev: Strategy, next: Strategy, names: string[]): PlanDiff[] {
  const out: PlanDiff[] = [];
  if (targetOf(prev, names) !== targetOf(next, names)) out.push({ field: "target", from: targetOf(prev, names), to: targetOf(next, names) });
  if (prev.stance !== next.stance) out.push({ field: "stance", from: prev.stance, to: next.stance });
  if (prev.weapons.join(">") !== next.weapons.join(">")) out.push({ field: "weapons", from: prev.weapons.join(" › "), to: next.weapons.join(" › ") });
  if ((prev.retaliate ?? "turn") !== (next.retaliate ?? "turn")) out.push({ field: "retaliate", from: prev.retaliate ?? "turn", to: next.retaliate ?? "turn" });
  if (ruleLabels(prev) !== ruleLabels(next)) out.push({ field: "rules", from: String(prev.rules?.length ?? 0), to: String(next.rules?.length ?? 0) });
  return out;
}

export interface PlanNow {
  strategy: Strategy;
  /** the tick this plan took over (0: the round plan) */
  since: number;
  /** the last check-in change up to now, with what it changed */
  change: { tick: number; diff: PlanDiff[]; line?: string; why?: string } | null;
}

/** The plan fighter `seat` plays at `tick` (pure). */
export function planAt(r: PlanRound, seat: number, tick: number, names: string[]): PlanNow | null {
  const base = r.strategies[seat];
  if (!base) return null;
  let cur = base;
  let since = 0;
  let change: PlanNow["change"] = null;
  for (const u of r.updates) {
    if (u.fighter !== seat || u.tick > tick) continue;
    const diff = planDiff(cur, u.strategy, names);
    change = { tick: u.tick, diff, ...(u.line ? { line: u.line } : {}), ...(u.why ? { why: u.why } : {}) };
    cur = u.strategy;
    since = u.tick;
  }
  return { strategy: cur, since, change };
}

export interface RuleState {
  on: boolean;
  /** who made it true (-1: nobody in particular) */
  subject: number;
  /** times it started since this plan took over */
  count: number;
}

/** Each rule of the plan now: on or off, and how often it fired under this plan (pure). */
export function ruleStates(r: PlanRound, seat: number, tick: number, now: PlanNow): RuleState[] {
  const out: RuleState[] = (now.strategy.rules ?? []).map(() => ({ on: false, subject: -1, count: 0 }));
  for (const f of r.firings) {
    if (f.fighter !== seat || f.tick < now.since || f.tick > tick) continue;
    const s = out[f.rule];
    if (!s) continue;
    s.on = f.on;
    if (f.on) {
      s.count++;
      s.subject = f.subject;
    }
  }
  if (r.kos.some((k) => k.fighter === seat && k.tick <= tick)) for (const s of out) s.on = false;
  return out;
}
