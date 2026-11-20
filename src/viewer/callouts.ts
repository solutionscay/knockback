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
import type { Rule, Strategy } from "../sim/sim";

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

const ITEM: Record<string, string> = { grapple: "hook" };
const it = (w?: string) => (w ? (ITEM[w] ?? w) : "");

export function targetText(s: Strategy, names: string[]): string {
  return s.target === "grudge" && s.grudge !== undefined ? (names[s.grudge] ?? "?") : s.target;
}

/**
 * The headline of a plan change, 3-5 words ("→ target Pike"), or null if
 * nothing that matters changed. Target first, then stance, weapons,
 * retaliate, rules.
 */
export function planChangeText(prev: Strategy, next: Strategy, names: string[]): string | null {
  if (targetText(prev, names) !== targetText(next, names)) return `→ target ${targetText(next, names)}`;
  if (prev.stance !== next.stance) return `→ ${next.stance === "item" ? "grab pickups" : next.stance === "distance" ? "keep distance" : next.stance === "cover" ? "take cover" : "rush in"}`;
  if ((prev.weapons[0] ?? "") !== (next.weapons[0] ?? "")) return `→ go for the ${it(next.weapons[0])}`;
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

// ------------------------------------------------------------------ best rule

export interface RuleFiring {
  tick: number;
  fighter: number;
  rule: number;
}
export interface KoEvent {
  tick: number;
  by: number;
  victim: number;
}

/**
 * "Best rule" of a round (#11): a rule firing followed by a knockout by the
 * same fighter within `windowTicks` (5 s). The closest such pair wins
 * (ties: the earlier knockout). Null if none.
 */
export function bestRule(firings: RuleFiring[], kos: KoEvent[], windowTicks = 300): { fighter: number; rule: number; victim: number; gap: number } | null {
  let best: { fighter: number; rule: number; victim: number; gap: number; tick: number } | null = null;
  for (const k of kos) {
    if (k.by < 0 || k.by === k.victim) continue;
    for (const f of firings) {
      if (f.fighter !== k.by) continue;
      const gap = k.tick - f.tick;
      if (gap < 0 || gap > windowTicks) continue;
      if (!best || gap < best.gap || (gap === best.gap && k.tick < best.tick)) best = { fighter: f.fighter, rule: f.rule, victim: k.victim, gap, tick: k.tick };
    }
  }
  return best ? { fighter: best.fighter, rule: best.rule, victim: best.victim, gap: best.gap } : null;
}
