import { CLASSIC, enabledItems, type Ruleset } from "../sim/ruleset";
/**
 * Mid-round check-ins (#9): every ~10 s of fight each AI seat gets a compact
 * status of the fight and may answer with a plan change. The fight never
 * pauses for it: the change applies at a later tick (the check-in tick plus
 * the answer's latency, in fight time) and is recorded as a plan update
 * (#8), so a replay needs no AI.
 *
 * This file holds the data and the pure parts: the schedule, the status (as
 * data, for remote agents), the short prompt (for CLI providers), the answer
 * parser (a partial plan merged onto the current one) and the apply tick.
 * The loop that asks lives in MatchRunner (runner.ts).
 */
import { FIGHT_TICKS, TICK_RATE } from "../sim/constants";
import { planKey, type Fight } from "../sim/fight";
import type { Strategy } from "../sim/sim";
import type { Soul } from "../sim/soul";
import { cleanLine, cleanWhy, jsonObjects, parseRules, validatePlan } from "./parse";

/** The check-in schedule, limits and latency rules (all times in fight seconds unless noted). */
export interface CheckinConfig {
  /** first check-in at this fight time */
  firstS: number;
  /** then one every this many seconds */
  everyS: number;
  /** no check-in this close to the time-out */
  noneInLastS: number;
  /** at most this many check-ins asked per seat per round (cost cap) */
  maxPerRound: number;
  /**
   * Sanity cap against hung processes, wall clock: a check-in is otherwise
   * open until the answer arrives (or the round ends, or the agent drops).
   * Past the cap it is a miss and the call is aborted (a CLI is killed).
   */
  capMs: number;
  /** an update applies at least this long after its check-in tick */
  minApplyS: number;
  /**
   * broadcast pace: an answer applies this long after the tick the viewers
   * had reached when it arrived, so the update reaches them in time
   */
  leadS: number;
  /** at most this many characters in a check-in line */
  maxLine: number;
}

export const CHECKIN: CheckinConfig = {
  firstS: 10,
  everyS: 10,
  noneInLastS: 5,
  maxPerRound: 8,
  capMs: 60_000,
  minApplyS: 1,
  leadS: 0.75,
  maxLine: 60,
};

/**
 * Check-in settings from command-line flags: --checkins on|off (default:
 * `defaultOn`), --checkin-cap (seconds, the hung-call cap), --checkin-every
 * (seconds), --checkin-max (per seat per round). False when check-ins are off.
 */
export function checkinFlags(flags: Record<string, string | undefined>, defaultOn = false): false | Partial<CheckinConfig> {
  const on = flags.checkins ?? (defaultOn ? "on" : "off");
  if (on === "off" || on === "false") return false;
  if (on !== "on" && on !== "true") throw new Error(`--checkins: on or off (got ${on})`);
  const num = (k: string, lo: number, hi: number) => {
    const v = flags[k];
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`--${k}: a number from ${lo} to ${hi} (got ${v})`);
    return n;
  };
  const c = num("checkin-cap", 1, 600);
  const e = num("checkin-every", 2, 60);
  const m = num("checkin-max", 1, 20);
  return { ...(c !== undefined ? { capMs: Math.round(c * 1000) } : {}), ...(e !== undefined ? { everyS: e, firstS: e } : {}), ...(m !== undefined ? { maxPerRound: Math.floor(m) } : {}) };
}

/** Check-in ticks up to the final quiet period before the round time limit. */
export function checkinTicks(cfg: CheckinConfig = CHECKIN, fightTicks = FIGHT_TICKS): number[] {
  const out: number[] = [];
  const last = fightTicks - cfg.noneInLastS * TICK_RATE;
  for (let t = Math.round(cfg.firstS * TICK_RATE); t <= last; t += Math.round(cfg.everyS * TICK_RATE)) out.push(t);
  return out;
}

/**
 * The tick a check-in answer applies at. `answered` is the fight tick the
 * answer arrived at: at broadcast pace the tick the viewers had reached, in
 * fast mode the check-in tick plus the measured latency in fight ticks. The
 * update applies `lead` ticks later (broadcast only), and at least
 * `minApplyS` after the check-in tick. Pure: the record keeps the result.
 */
export function applyTick(askedTick: number, answeredTick: number, cfg: CheckinConfig = CHECKIN, broadcast = false): number {
  return Math.max(askedTick + Math.round(cfg.minApplyS * TICK_RATE), answeredTick + (broadcast ? Math.round(cfg.leadS * TICK_RATE) : 0));
}

/** Fast mode: the fight tick an answer arrives at, from the check-in tick and its latency (rounded up). */
export function answeredTickFast(askedTick: number, ms: number): number {
  return askedTick + Math.ceil((ms / 1000) * TICK_RATE);
}

/** How a seat answers a check-in: a remote seat publishes it to its agent; a local provider gets the prompt. */
export type CheckinAsk = (prompt: string, status: CheckinStatus, signal: AbortSignal) => Promise<string>;

// ------------------------------------------------------------------ status
const r1 = (n: number) => Math.round(n);
const NICE: Record<string, string> = { grapple: "hook", fist: "fists", flamethrower: "flamethrower" };
const wn = (w: string) => NICE[w] ?? w;

export interface CheckinStatus {
  round: number;
  tick: number;
  second: number;
  secondsLeft: number;
  zoneWidth: number;
  you: {
    name: string;
    health: number;
    weapons: string[];
    powerUps: string[];
    burning: boolean;
    jetpackFuel: number | null;
    flamethrowerFuel: number | null;
    plan: { target: string; stance: string; weapons: string[]; retaliate: string; rules: string[] };
    activeRules: string[];
    chasing: string | null;
    chasedBy: string[];
  };
  rivals: {
    name: string;
    out: boolean;
    health: number;
    weapons: string[];
    distance: number;
    direction: string;
    targeting: string | null;
    knockouts: number;
    burning: boolean;
    jetpack: boolean;
  }[];
  last10s: { took: { from: string; damage: number; hits: number; weapon: string }[]; dealt: { to: string; damage: number; hits: number }[] };
  nearest: { item: string; distance: number; direction: string }[];
  fire: string;
}

function dir(dx: number, dy: number): string {
  const h = Math.abs(dx) < 1 ? "" : dx < 0 ? "left" : "right";
  const v = dy > 2 ? "above" : dy < -2 ? "below" : "";
  return [h, v].filter(Boolean).join(", ") || "here";
}

function planOf(s: Strategy, names: string[]) {
  return {
    target: s.target === "grudge" && s.grudge !== undefined ? names[s.grudge]! : s.target,
    stance: s.stance,
    weapons: (s.weapons ?? []).map(wn),
    retaliate: s.retaliate ?? "turn",
    rules: (s.rules ?? []).map((r) => r.label),
  };
}

/** What fighter `me` gets to see at a check-in: the fight at this tick, from its point of view. */
export function checkinStatus(fight: Fight, me: number, names: string[], round: number): CheckinStatus {
  const sim = fight.sim;
  const tick = sim.tick;
  const f = sim.fighters[me]!;
  const ctl = fight.controllers[me]!;
  const pos = (i: number) => {
    const x = sim.fighters[i]!;
    return x.removed ? null : sim.pos(x);
  };
  const p = pos(me) ?? { x: 0, y: 0 };
  const held = (x: (typeof sim.fighters)[number]) => x.weapons.filter((w) => w !== "fist").map(wn);
  const pw = f.power;
  const powerUps = [pw.shield > 0 ? "shield" : "", pw.speed > 0 ? "speed" : "", pw.heavy > 0 ? "heavy" : "", pw.damage > 0 ? "damage" : "", pw.jump > 0 ? "jump" : ""].filter(Boolean);
  const targetOf = (i: number) => {
    const c = fight.controllers[i]!;
    return sim.fighters[i]!.alive && c.targetId >= 0 ? names[c.targetId]! : null;
  };
  const since = tick - 10 * TICK_RATE;
  const recent = fight.hitLog.filter((h) => h.tick > since);
  const took = new Map<number, { damage: number; hits: number; byW: Map<string, number> }>();
  const dealt = new Map<number, { damage: number; hits: number }>();
  for (const h of recent) {
    if (h.target === me && h.by !== me) {
      const t = took.get(h.by) ?? { damage: 0, hits: 0, byW: new Map() };
      t.damage += h.damage;
      t.hits++;
      t.byW.set(h.weapon, (t.byW.get(h.weapon) ?? 0) + h.damage);
      took.set(h.by, t);
    } else if (h.by === me && h.target !== me) {
      const d = dealt.get(h.target) ?? { damage: 0, hits: 0 };
      d.damage += h.damage;
      d.hits++;
      dealt.set(h.target, d);
    }
  }
  const items = sim
    .items()
    .map((e) => {
      const q = e.body.translation();
      return { item: wn(e.itemType ?? "?"), dx: q.x - p.x, dy: q.y - p.y };
    })
    .map((o) => ({ ...o, d: Math.hypot(o.dx, o.dy) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map((o) => ({ item: o.item, distance: r1(o.d), direction: dir(o.dx, o.dy) }));
  const burningNames = sim.fighters.filter((x) => x.alive && x.burning > 0).map((x) => (x.id === me ? "you" : names[x.id]!));
  const fires = sim.fires.size;
  const fire = [burningNames.length ? `on fire: ${burningNames.join(", ")}` : "", fires ? `${fires} burning spots in the level` : "", !burningNames.length && !fires ? "no fire" : ""].filter(Boolean).join("; ");
  return {
    round,
    tick,
    second: r1(tick / TICK_RATE),
    secondsLeft: Math.max(0, r1((sim.ruleset.round.fightTicks - tick) / TICK_RATE)),
    zoneWidth: r1(sim.zone.half * 2),
    you: {
      name: names[me]!,
      health: r1(f.hp),
      weapons: held(f),
      powerUps,
      burning: f.burning > 0,
      jetpackFuel: pw.jetpack > 0 ? r1((pw.jetpack / TICK_RATE) * 10) / 10 : null,
      flamethrowerFuel: f.weapons.includes("flamethrower") ? f.fuel : null,
      plan: planOf(ctl.strategy, names),
      activeRules: ctl.rules.rules.filter((_, i) => ctl.rules.state[i]!.active).map((r) => r.label),
      chasing: targetOf(me),
      chasedBy: sim.fighters.filter((x) => x.id !== me && x.alive && fight.controllers[x.id]!.targetId === me).map((x) => names[x.id]!),
    },
    rivals: sim.fighters
      .filter((x) => x.id !== me)
      .map((x) => {
        const q = pos(x.id);
        return {
          name: names[x.id]!,
          out: !x.alive,
          health: x.alive ? r1(x.hp) : 0,
          weapons: x.alive ? held(x) : [],
          distance: q && x.alive ? r1(Math.hypot(q.x - p.x, q.y - p.y)) : 0,
          direction: q && x.alive ? dir(q.x - p.x, q.y - p.y) : "",
          targeting: targetOf(x.id),
          knockouts: x.kos,
          burning: x.alive && x.burning > 0,
          jetpack: x.alive && x.power.jetpack > 0,
        };
      }),
    last10s: {
      took: [...took].map(([by, t]) => ({ from: names[by]!, damage: r1(t.damage), hits: t.hits, weapon: wn([...t.byW].sort((a, b) => b[1] - a[1])[0]![0]) })),
      dealt: [...dealt].map(([to, d]) => ({ to: names[to]!, damage: r1(d.damage), hits: d.hits })),
    },
    nearest: items,
    fire,
  };
}

/**
 * The check-in prompt for CLI providers: short (target under 1,500
 * characters), facts first, the answer format last.
 */
export function buildCheckinPrompt(st: CheckinStatus, soul?: Soul, cfg: CheckinConfig = CHECKIN, ruleset: Ruleset = CLASSIC): string {
  const y = st.you;
  // the soul's first sentence (not its Markdown headings): enough to stay in character
  const persona = soul ? (soul.body.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).join(" ").replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0] ?? "").slice(0, 140) : "";
  const rivals = st.rivals
    .map((r) => (r.out ? `${r.name} OUT` : `${r.name} ${r.health}hp ${r.weapons.join("+") || "fists"} ${r.distance}m ${r.direction}${r.targeting ? ` ->${r.targeting === y.name ? "YOU" : r.targeting}` : ""}${r.knockouts ? ` ${r.knockouts}KO` : ""}${r.burning ? " burning" : ""}${r.jetpack ? " jetpack" : ""}`))
    .join("; ");
  const took = st.last10s.took.map((t) => `${t.from} ${t.damage} (${t.hits} hits, ${t.weapon})`).join(", ") || "nothing";
  const dealt = st.last10s.dealt.map((d) => `${d.to} ${d.damage}`).join(", ") || "nothing";
  const near = st.nearest.map((n) => `${n.item} ${n.distance}m ${n.direction}`).join(", ") || "none";
  const me = [`${y.health}hp`, y.weapons.join("+") || "fists", ...y.powerUps, y.burning ? "BURNING" : "", y.jetpackFuel !== null ? `jetpack ${y.jetpackFuel}s` : "", y.flamethrowerFuel !== null ? `flame fuel ${y.flamethrowerFuel}` : ""].filter(Boolean).join(", ");
  const plan = `target ${y.plan.target}, ${y.plan.stance}, wants ${y.plan.weapons.join(">")}, retaliate ${y.plan.retaliate}${y.plan.rules.length ? `, rules: ${y.plan.rules.join("; ")}` : ""}${y.activeRules.length ? ` (active now: ${y.activeRules.join("; ")})` : ""}`;
  return [
    `Knockback check-in, round ${st.round}, ${st.second}s in (${st.secondsLeft}s left, zone ${st.zoneWidth}m wide). You are ${y.name}. ${persona}`,
    `YOU: ${me}. Chasing ${y.chasing ?? "nobody"}; chased by ${y.chasedBy.join(", ") || "nobody"}.`,
    `PLAN: ${plan}.`,
    `RIVALS: ${rivals}.`,
    `LAST 10s: took ${took}; dealt ${dealt}.`,
    `NEAREST PICKUPS: ${near}. FIRE: ${st.fire}.${ruleset.weapons.enabled.length !== CLASSIC.weapons.enabled.length || ruleset.pickups.enabled.length !== CLASSIC.pickups.enabled.length ? ` Enabled items: ${enabledItems(ruleset).join(", ")}.` : ""}`,
    `The fight keeps going while you think. Keep the plan, or change only what matters. Fields: target (a name or nearest|weakest|strongest|leader), stance (rush|distance|cover|item), weapons (1-3 weapons to go for: ${ruleset.weapons.enabled.join("|")}; power-ups like shield or jetpack are not weapons), retaliate (attacker|turn|ignore), rules (replaces yours, e.g. [{"when":"my_health_below","value":30,"do":"stance","stance":"cover"}]). line = what you shout (under ${cfg.maxLine} chars), why = reason.`,
    `Reply ONLY with JSON: {"keep":true} or e.g. {"target":"weakest","stance":"cover","line":"...","why":"..."}`,
  ].join("\n");
}

// ------------------------------------------------------------------ the answer
export type CheckinAnswer =
  | { kind: "keep"; line?: string; why?: string }
  | { kind: "update"; strategy: Strategy; changed: string[]; line?: string; why?: string; ruleProblems?: string[] }
  | { kind: "invalid"; problems: string[] };

const PLAN_FIELDS = ["target", "stance", "weapons", "retaliate", "rules"] as const;

/**
 * Parse a check-in answer: {"keep":true}, or a partial plan merged onto the
 * current plan (only the fields given change; `rules` replaces the rules).
 * The merged plan is validated like a round plan; anything invalid = keep.
 * A merge that changes nothing is a keep too.
 */
export function parseCheckin(text: string, me: number, names: string[], current: Strategy, cfg: CheckinConfig = CHECKIN, ruleset: Ruleset = CLASSIC): CheckinAnswer {
  const objs = jsonObjects(text).filter((o): o is Record<string, unknown> => !!o && typeof o === "object" && !Array.isArray(o));
  if (!objs.length) return { kind: "invalid", problems: ["no JSON object"] };
  const o = objs.find((x) => PLAN_FIELDS.some((k) => x[k] !== undefined)) ?? objs[0]!;
  const lineRaw = cleanLine(o.line ?? o.say);
  const line = lineRaw ? (lineRaw.length > cfg.maxLine ? lineRaw.slice(0, cfg.maxLine - 1).replace(/\s+\S*$/, "") + "…" : lineRaw) : undefined;
  const why = cleanWhy(o.why ?? o.reason) ?? undefined;
  const extra = { ...(line ? { line } : {}), ...(why ? { why } : {}) };
  const given = PLAN_FIELDS.filter((k) => o[k] !== undefined);
  if (o.keep === true && !given.length) return { kind: "keep", ...extra };
  if (!given.length) return o.keep === undefined && !line ? { kind: "invalid", problems: ["neither keep nor plan fields"] } : { kind: "keep", ...extra };
  const cur = planOf(current, names);
  // models often list power-ups (shield, jetpack) as weapons: drop those, keep the weapons (none left: weapons unchanged)
  const ws = Array.isArray(o.weapons) ? o.weapons.filter((w) => typeof w === "string" && validatePlan({ weapons: [w], target: "nearest", stance: "rush" }, me, names).strategy) : o.weapons;
  const merged = {
    weapons: Array.isArray(ws) && !ws.length ? current.weapons : (ws ?? current.weapons),
    target: o.target ?? cur.target,
    stance: o.stance ?? current.stance,
    retaliate: o.retaliate ?? current.retaliate ?? "turn",
  };
  const v = validatePlan(merged, me, names, ruleset);
  if (!v.strategy) return { kind: "invalid", problems: v.problems };
  const s: Strategy = { ...v.strategy, line: current.line ?? "" };
  let ruleProblems: string[] | undefined;
  if (o.rules !== undefined) {
    const pr = parseRules(o.rules, me, names, ruleset);
    if (pr.rules.length) s.rules = pr.rules;
    if (pr.problems.length) ruleProblems = pr.problems;
  } else if (current.rules?.length) s.rules = current.rules.map((r) => ({ ...r }));
  const before = planOf(current, names);
  const after = planOf(s, names);
  const changed = PLAN_FIELDS.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  if (planKey(s) === planKey(current) || !changed.length) return { kind: "keep", ...extra };
  return { kind: "update", strategy: s, changed, ...extra, ...(ruleProblems ? { ruleProblems } : {}) };
}
