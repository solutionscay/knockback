/**
 * Callouts over the fight (#10, #11): plan-change thoughts and rule tags.
 * Pure (no DOM, no Pixi) so the clutter limits can be tested.
 *
 *   - at most MAX_VISIBLE on screen at once
 *   - a thought (plan change) outranks a rule tag; a newer callout for the
 *     same fighter replaces the one it has on screen
 *   - callouts that waited too long are dropped (rule tags quickly)
 *   - nothing shows while suppressed (knockout slow motion, round end);
 *     rule tags queued meanwhile are dropped, thoughts wait
 */
import type { Rule, Strategy } from "../sim/sim-types";

export const CALLOUT = {
  maxVisible: 2,
  thoughtSeconds: 2.5,
  ruleSeconds: 2,
  /** the line from a rule tag to its subject */
  ruleLineSeconds: 1,
  thoughtMaxWait: 3,
  ruleMaxWait: 0.8,
  maxQueue: 6,
  /** the same rule of the same fighter shows its tag again only after this long (in practice: its first firing in a round) */
  ruleRepeatSeconds: 20,
  /** and rule tags (any fighter) come at least this far apart: few callouts on a LAN screen */
  ruleGapSeconds: 3,
};

export type CalloutKind = "thought" | "rule";

export interface Callout {
  kind: CalloutKind;
  fighter: number;
  text: string;
  /** a spoken line that came with a plan update (thoughts) */
  line?: string;
  /** rule tags: the fighter that made the rule fire (-1 = none) */
  subject?: number;
  /** clock time it was added and (once shown) when it appeared */
  at: number;
  shownAt?: number;
}

const prio = (c: Callout) => (c.kind === "thought" ? 2 : 1);
const life = (c: Callout) => (c.kind === "thought" ? CALLOUT.thoughtSeconds : CALLOUT.ruleSeconds);
const maxWait = (c: Callout) => (c.kind === "thought" ? CALLOUT.thoughtMaxWait : CALLOUT.ruleMaxWait);

export class CalloutManager {
  visible: Callout[] = [];
  queue: Callout[] = [];
  /** everything that was ever on screen (tests, debug) */
  shownLog: Callout[] = [];
  /** the most callouts on screen at once (tests) */
  peak = 0;

  constructor(readonly enabled = true) {}

  add(c: Omit<Callout, "shownAt">) {
    if (!this.enabled) return;
    this.queue.push({ ...c });
    // keep the queue short: drop the oldest lowest-priority entries
    while (this.queue.length > CALLOUT.maxQueue) {
      let drop = 0;
      for (let i = 1; i < this.queue.length; i++) if (prio(this.queue[i]!) < prio(this.queue[drop]!) || (prio(this.queue[i]!) === prio(this.queue[drop]!) && this.queue[i]!.at < this.queue[drop]!.at)) drop = i;
      this.queue.splice(drop, 1);
    }
  }

  clear() {
    this.visible = [];
    this.queue = [];
  }

  /** Advance to clock time `now`; returns what is on screen. */
  update(now: number, suppressed: boolean): Callout[] {
    this.visible = this.visible.filter((c) => now - c.shownAt! < life(c));
    if (suppressed) {
      this.visible = [];
      this.queue = this.queue.filter((c) => c.kind === "thought");
      // thoughts wait, but not forever
      this.queue = this.queue.filter((c) => now - c.at < maxWait(c) + 2);
      return this.visible;
    }
    this.queue = this.queue.filter((c) => now - c.at < maxWait(c));
    // highest priority first, then oldest
    this.queue.sort((a, b) => prio(b) - prio(a) || a.at - b.at);
    const rest: Callout[] = [];
    for (const c of this.queue) {
      const same = this.visible.findIndex((v) => v.fighter === c.fighter);
      if (same >= 0) {
        // same fighter: a newer callout of at least the same priority replaces it
        if (prio(c) >= prio(this.visible[same]!)) this.visible[same] = this.show(c, now);
        else rest.push(c);
        continue;
      }
      if (this.visible.length < CALLOUT.maxVisible) {
        this.visible.push(this.show(c, now));
        continue;
      }
      // full: a thought pushes out the oldest rule tag
      const ruleIdx = this.visible.findIndex((v) => prio(v) < prio(c));
      if (ruleIdx >= 0) this.visible[ruleIdx] = this.show(c, now);
      else rest.push(c);
    }
    this.queue = rest;
    this.peak = Math.max(this.peak, this.visible.length);
    return this.visible;
  }

  private show(c: Callout, now: number): Callout {
    const s = { ...c, shownAt: now };
    this.shownLog.push(s);
    return s;
  }
}

// ------------------------------------------------------------------ texts

export function targetText(s: Strategy, names: string[]): string {
  return s.target === "grudge" && s.grudge !== undefined ? (names[s.grudge] ?? "?") : s.target;
}

/**
 * The headline of a plan change, 3-5 words ("→ target Zapko"), or null if
 * nothing that matters changed. Target first, then stance, weapons,
 * retaliate, rules.
 */
export function planChangeText(prev: Strategy, next: Strategy, names: string[]): string | null {
  if (targetText(prev, names) !== targetText(next, names)) return `→ target ${targetText(next, names)}`;
  if (prev.stance !== next.stance) return `→ ${stanceText(next.stance)}`;
  if ((prev.weapons[0] ?? "") !== (next.weapons[0] ?? "")) return `→ go for the ${itemWord(next.weapons[0], "")}`;
  if ((prev.retaliate ?? "turn") !== (next.retaliate ?? "turn")) return `→ retaliate: ${next.retaliate ?? "turn"}`;
  const pr = (prev.rules ?? []).map((r) => r.label).join("|");
  const nr = (next.rules ?? []).map((r) => r.label).join("|");
  if (pr !== nr && next.rules?.length) return `→ new rule: ${next.rules[0]!.label}`;
  return null;
}

/** "RULE: chase the rocket holder" (clipped for the screen). */
export function ruleTagText(rule: Rule | undefined): string {
  const label = rule?.label ?? "rule";
  return `RULE: ${label.length > 28 ? `${label.slice(0, 27).trim()}…` : label}`;
}

// ------------------------------------------------------------------ plain words (#104)

const ITEM_WORD: Partial<Record<string, string>> = { grapple: "hook", flamethrower: "flamer", lightning: "sword" };
const itemWord = (x?: string, fallback = "a pickup") => (x ? (ITEM_WORD[x] ?? x) : fallback);
/** a/an + item ("a rocket", "an ice ...") */
const an = (x?: string) => {
  const w = itemWord(x);
  return /^[aeiou]/.test(w) ? `an ${w}` : `a ${w}`;
};

/** A stance in plain words: "rush in", "keep distance", ... */
export function stanceText(stance: string): string {
  const t: Record<string, string> = { rush: "rush in", distance: "keep distance", cover: "take cover", item: "grab pickups", overwatch: "hold high ground", flank: "flank", hold: "hold position" };
  return t[stance] ?? stance;
}

/** What `retaliate` does, in plain words. */
export function retaliateText(r: string | undefined): string {
  return r === "attacker" ? "chase the attacker" : r === "ignore" ? "ignore it" : "turn and fight";
}

/**
 * A rule in plain words for spectators (#104): "Anyone hits me → take cover", "Health under 35% → go get health".
 * `names`: the fighters' names, for a rule about one rival.
 */
export function ruleText(rule: Rule, names: string[] = []): string {
  const who = (cap: boolean) => {
    const w = rule.who;
    const s = typeof w === "number" ? (names[w] ?? `seat ${w + 1}`) : w === "enemy" ? "an enemy" : w === "target" ? "my target" : "anyone";
    return cap && typeof w !== "number" ? s[0]!.toUpperCase() + s.slice(1) : s;
  };
  const v = rule.value ?? 0;
  const when: Record<Rule["when"], string> = {
    holds: `${who(true)} holds ${rule.item === "jetpack" ? "a jetpack" : an(rule.item)}`,
    my_health_below: `Health under ${v}%`,
    health_below: `${who(true)} under ${v}% health`,
    near_ledge: `${who(true)} near a ledge`,
    near_tank: `${who(true)} near a liquid tank`,
    near_barrel: `${who(true)} near a barrel`,
    on_streak: `${who(true)} has ${v} KO${v === 1 ? "" : "s"}`,
    chasing_me: `${who(true)} chases me`,
    hit_me: `${who(true)} hits me`,
    item_near: `${an(rule.item)[0]!.toUpperCase()}${an(rule.item).slice(1)} nearby`,
    alone_with: "Last two standing",
    in_open: `${who(true)} in the open`,
    has_long_gun: `${who(true)} has a long gun`,
    in_cover: "I'm in cover",
    my_ammo_below: `Ammo under ${v}%`,
  };
  const subj = ["holds", "health_below", "near_ledge", "near_barrel", "on_streak", "chasing_me", "hit_me", "in_open", "has_long_gun", "alone_with"].includes(rule.when) ? "them" : "it";
  const act: Record<Rule["do"], string> = {
    target: `go after ${subj === "them" ? "them" : "my target"}`,
    avoid: subj === "them" ? "keep away from them" : "keep away",
    seek: rule.doItem === "health" ? "go get health" : `go get ${an(rule.doItem)}`,
    use: rule.doItem === "bat" || rule.doItem === "hammer" ? `swing the ${itemWord(rule.doItem)}` : `use the ${itemWord(rule.doItem)}`,
    stance: stanceText(rule.stance ?? "hold"),
    retaliate: retaliateText(rule.retaliate),
    drop: rule.doItem ? `drop the ${itemWord(rule.doItem)}` : "drop my weapon",
    swap: rule.doItem === "fist" || !rule.doItem ? "switch to fists" : `switch to the ${itemWord(rule.doItem)}`,
    dig: "dig through",
  };
  return `${when[rule.when]} → ${act[rule.do]}`;
}

// ------------------------------------------------------------------ best rule

export interface RuleFiring {
  tick: number;
  fighter: number;
  rule: number;
  /** the fighter that made the rule fire (-1 = none) */
  subject?: number;
  /** the rule's action */
  action?: Rule["do"];
}
export interface KoEvent {
  tick: number;
  by: number;
  victim: number;
}

/**
 * "Best rule" of a round (#11): a rule firing followed by a knockout by the
 * same fighter within `windowTicks` (5 s). A rule about the fighter who got
 * knocked out beats a fighting rule (target, use, avoid, retaliate); a seek
 * or stance rule about someone else never counts ("patch up" before a
 * knockout did not win it). Then the closest pair wins (ties: the earlier
 * knockout). Null if none.
 */
export function bestRule(firings: RuleFiring[], kos: KoEvent[], windowTicks = 300): { fighter: number; rule: number; victim: number; gap: number } | null {
  const FIGHTING = ["target", "use", "avoid", "retaliate"];
  let best: { fighter: number; rule: number; victim: number; gap: number; tick: number; cls: number } | null = null;
  for (const k of kos) {
    if (k.by < 0 || k.by === k.victim) continue;
    for (const f of firings) {
      if (f.fighter !== k.by) continue;
      const gap = k.tick - f.tick;
      if (gap < 0 || gap > windowTicks) continue;
      const cls = f.subject === k.victim ? 0 : f.action === undefined || FIGHTING.includes(f.action) ? 1 : 2;
      if (cls === 2) continue;
      if (!best || cls < best.cls || (cls === best.cls && (gap < best.gap || (gap === best.gap && k.tick < best.tick)))) best = { fighter: f.fighter, rule: f.rule, victim: k.victim, gap, tick: k.tick, cls };
    }
  }
  return best ? { fighter: best.fighter, rule: best.rule, victim: best.victim, gap: best.gap } : null;
}
