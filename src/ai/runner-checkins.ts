import { TICK_RATE } from "../sim/constants";
import { formatSeconds } from "../format";
import { tickAtFightSeconds, VIEWER_KO_EXTRA_S } from "../flow/pacing";
import type { Fight, PlanUpdate } from "../sim/fight";
import type { CheckinMeta, Match } from "../sim/match";
import { answeredTickFast, applyTick, buildCheckinPrompt, CHECKIN, checkinStatus, checkinTicks, parseCheckin, type CheckinAsk, type CheckinConfig } from "./checkin";
import { planChangeSummary } from "./checkin-log";
import type { RunnerEvent, RunnerOptions } from "./runner";

export class RunnerCheckins {
  /** check-in settings (null: no check-ins) */
  readonly config: CheckinConfig | null;
  /** a round being fought with check-ins at broadcast pace: when viewers see its tick 0 */
  fighting: { round: number; fightAt: number } | null = null;
  /** each seat's open check-in (round, asked tick) */
  readonly openCheckins = new Map<number, { round: number; tick: number }>();
  /** per seat: how it answers a check-in (null: no check-ins, e.g. the house bot) */
  readonly ask: (CheckinAsk | null)[];
  /** every check-in prompt and answer, for the .checkins.json file */
  readonly prompts: { round: number; tick: number; seat: number; prompt: string; raw: string | null }[] = [];

  constructor(
    private readonly opts: RunnerOptions,
    private readonly match: Match,
    private readonly labels: string[],
    private readonly emit: (event: RunnerEvent) => void,
    private readonly say: (line: string) => void,
  ) {
    this.config = opts.checkins ? { ...CHECKIN, ...(typeof opts.checkins === "object" ? opts.checkins : {}) } : null;
    this.ask = opts.seats.map((s) => s.checkin ?? (s.provider ? (prompt, _st, signal) => s.provider!.ask(prompt, signal) : null));
  }

  /**
   * The round's fight with check-ins (#9). A check-in stays open until its
   * answer arrives (or the round ends, the agent drops, or the hung-call cap
   * passes); while a seat's check-in is open, that seat's next scheduled
   * check-ins are skipped (no overlap, no queue).
   *
   * The fight never waits for an answer. The server sim follows a "watch
   * tick": at broadcast pace the tick the viewers have reached (pacing.ts),
   * in fast mode each open check-in's tick plus its elapsed wall time in
   * fight ticks (the lowest of them). An answer applies at the watch tick it
   * arrived at (+ the lead at broadcast pace), at least `minApplyS` after its
   * check-in tick: a slow model reacts late. The record keeps every tick.
   */
  async play(round: number, fightAt: number) {
    const cfg = this.config!;
    const match = this.match;
    const fight = match.fight!;
    const broadcast = this.opts.pace === "broadcast";
    const scale = this.opts.paceScale ?? 1;
    if (broadcast) this.fighting = { round, fightAt };
    const schedule = checkinTicks(cfg, match.ruleset.round.fightTicks);
    const asked = this.opts.seats.map(() => 0);
    const open = new Map<number, OpenCheckin>();
    const metas: CheckinMeta[] = [];
    let next = 0;
    let lastTick = -1;
    let wake: (() => void) | null = null;
    // real time: broadcast pace with someone to pace for; otherwise latency becomes fight time
    const realTime = () => broadcast && (this.opts.shouldPace?.() ?? true);
    const viewerTick = () => tickAtFightSeconds(Math.max(0, (Date.now() - fightAt) / 1000 / scale - fight.result().koLog.length * VIEWER_KO_EXTRA_S));
    const watchTick = () => {
      if (realTime()) return viewerTick();
      let t = Infinity;
      for (const o of open.values()) t = Math.min(t, o.askedTick + Math.floor(((performance.now() - o.t0) / 1000) * TICK_RATE));
      return t;
    };
    const ctx: CheckinLoop = {
      round,
      fight,
      open,
      metas,
      leadTicks: () => (realTime() ? Math.round(cfg.leadS * TICK_RATE) : 0),
      answeredTick: (o, ms) => Math.max(fight.sim.tick, realTime() ? viewerTick() : answeredTickFast(o.askedTick, ms)),
      realTime,
      wake: () => wake?.(),
    };
    try {
      for (;;) {
        const target = Math.min(schedule[next] ?? Infinity, watchTick());
        if (target > fight.sim.tick && match.stepUntil(target)) break;
        if (fight.over) break;
        if (next < schedule.length && fight.sim.tick >= schedule[next]!) {
          this.startCheckins(ctx, schedule[next++]!, asked);
          continue;
        }
        if (next >= schedule.length && !open.size) break;
        // tell live viewers how far the server is: no update will apply before this tick + the lead
        if (fight.sim.tick !== lastTick) this.emit({ type: "fightTick", round, tick: (lastTick = fight.sim.tick), leadTicks: ctx.leadTicks() });
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, realTime() ? 100 : 10);
        });
        wake = null;
      }
    } finally {
      for (const o of [...open.values()]) o.end("the round ended before the answer");
      const rec = match.record.rounds[round - 1]!;
      if (metas.length) rec.checkins = [...(rec.checkins ?? []), ...metas.sort((a, b) => a.tick - b.tick || a.fighter - b.fighter)];
      this.fighting = null;
      this.emit({ type: "checkinsDone", round });
    }
  }

  /** A scheduled check-in tick: ask every eligible seat that has no check-in open; the others skip it. */
  private startCheckins(ctx: CheckinLoop, tick: number, asked: number[]) {
    const fight = ctx.fight;
    if (fight.sim.alive().length < 2) return;
    const seats: number[] = [];
    for (let seat = 0; seat < this.opts.seats.length; seat++) {
      if (!this.ask[seat] || !fight.sim.fighters[seat]!.alive || (this.opts.onAutopilot?.(seat) ?? false)) continue;
      const o = ctx.open.get(seat);
      if (o) {
        o.meta.skipped = [...(o.meta.skipped ?? []), tick];
        continue;
      }
      if (asked[seat]! >= this.config!.maxPerRound) continue;
      asked[seat]!++;
      seats.push(seat);
    }
    if (!seats.length) return;
    this.emit({ type: "checkin", round: ctx.round, tick, seats, capMs: this.config!.capMs, leadTicks: ctx.leadTicks() });
    for (const seat of seats) this.openCheckinFor(ctx, tick, seat);
  }

  /** Open one seat's check-in: ask, and handle the answer whenever it arrives. */
  private openCheckinFor(ctx: CheckinLoop, tick: number, seat: number) {
    const cfg = this.config!;
    const match = this.match;
    const fight = ctx.fight;
    const names = match.names;
    const round = ctx.round;
    const st = checkinStatus(fight, seat, names, round);
    const prompt = buildCheckinPrompt(st, this.opts.seats[seat]!.soul, cfg, match.ruleset);
    const provider = this.labels[seat]!;
    const ctl = new AbortController();
    const meta: CheckinMeta = { tick, fighter: seat, provider, ms: 0, outcome: "missed", promptChars: prompt.length };
    let raw: string | null = null;
    let settled = false;
    const t0 = performance.now();
    const finish = () => {
      settled = true;
      clearTimeout(cap);
      ctx.open.delete(seat);
      this.openCheckins.delete(seat);
      ctx.metas.push(meta);
      this.prompts.push({ round, tick, seat, prompt, raw });
      const skipped = meta.skipped?.length ? `, skipped ${meta.skipped.map((t) => `${t / TICK_RATE} s`).join(", ")}` : "";
      if (meta.outcome !== "update") this.say(`  check-in ${(tick / TICK_RATE).toFixed(0)} s: ${names[seat]} [${provider} ${formatSeconds(meta.ms)}] ${meta.outcome.toUpperCase()}${meta.detail ? ` (${meta.detail})` : ""}${skipped}`);
      // how it went (#104): spectators show it once playback reaches answeredTick
      const { outcome, ms, answeredTick, applyTick, line, why, wanted } = meta;
      this.emit({ type: "checkinEnd", round, tick, seat, outcome, ms, ...(answeredTick !== undefined ? { answeredTick } : {}), ...(applyTick !== undefined ? { applyTick } : {}), ...(line ? { line } : {}), ...(why ? { why } : {}), ...(wanted ? { wanted } : {}) });
      ctx.wake();
    };
    const o: OpenCheckin = {
      askedTick: tick,
      t0,
      meta,
      end: (reason) => {
        if (settled) return;
        meta.ms = Math.round(performance.now() - t0);
        Object.assign(meta, { outcome: "missed", detail: reason });
        ctl.abort(); // kills a CLI call; a remote seat's check-in ends
        finish();
      },
    };
    // only against hung processes: otherwise the check-in waits for the answer
    const cap = setTimeout(() => o.end(`no answer in ${cfg.capMs / 1000} s (hung-call cap)`), cfg.capMs);
    ctx.open.set(seat, o);
    this.openCheckins.set(seat, { round, tick });
    this.ask[seat]!(prompt, st, ctl.signal).then(
      (got) => {
        if (settled) return;
        meta.ms = Math.round(performance.now() - t0);
        raw = got;
        meta.answerChars = got.length;
        const current = fight.controllers[seat]!.strategy;
        const a = parseCheckin(got, seat, names, current, cfg, match.ruleset);
        meta.answeredTick = ctx.answeredTick(o, meta.ms);
        const at = applyTick(tick, meta.answeredTick, cfg, ctx.realTime());
        // the line and reason, whatever the outcome (#104); a late answer also keeps what it asked for
        if (a.kind !== "invalid") Object.assign(meta, { ...(a.line ? { line: a.line } : {}), ...(a.why ? { why: a.why.slice(0, 160) } : {}) });
        if (a.kind === "invalid") Object.assign(meta, { outcome: "invalid", detail: a.problems.join(", ").slice(0, 200) });
        else if (a.kind === "keep") Object.assign(meta, { outcome: "keep", ...(a.line ? { detail: `line: ${a.line}` } : {}) });
        else if (fight.over || !fight.sim.fighters[seat]!.alive) Object.assign(meta, { outcome: "late", detail: `would apply at tick ${at}`, wanted: planChangeSummary(current, a.strategy, names) });
        else {
          const u: PlanUpdate = { tick: at, fighter: seat, strategy: a.strategy, ...(a.line ? { line: a.line } : {}), ...(a.why ? { why: a.why } : {}), source: "checkin" };
          match.addUpdate(u);
          Object.assign(meta, { outcome: "update", applyTick: at, changed: a.changed, ...(a.ruleProblems ? { detail: `rules dropped: ${a.ruleProblems.join("; ").slice(0, 160)}` } : {}) });
          this.emit({ type: "planUpdate", round, update: u });
          const skipped = meta.skipped?.length ? `; skipped ${meta.skipped.map((t) => `${t / TICK_RATE} s`).join(", ")}` : "";
          this.say(`  check-in ${(tick / TICK_RATE).toFixed(0)} s: ${names[seat]} [${provider} ${formatSeconds(meta.ms)}] ${planChangeSummary(current, a.strategy, names)}, applies at ${(at / TICK_RATE).toFixed(1)} s${a.line ? ` "${a.line}"` : ""}${a.why ? ` (${a.why})` : ""}${skipped}`);
        }
        finish();
      },
      (e) => {
        if (settled) return;
        meta.ms = Math.round(performance.now() - t0);
        const msg = e instanceof Error ? e.message : String(e);
        Object.assign(meta, { outcome: /autopilot|left the match/.test(msg) ? "autopilot" : "error", detail: msg.slice(0, 200) });
        finish();
      },
    );
  }

  /** Where a seat's open check-in is (round, its tick), for an autopilot takeover stamped at it; null when none is open. */
  at(seat: number): { round: number; phase: "checkin"; tick: number } | null {
    const o = this.openCheckins.get(seat);
    return o ? { round: o.round, phase: "checkin", tick: o.tick } : null;
  }

}

/** One seat's open check-in. */
interface OpenCheckin {
  askedTick: number;
  t0: number;
  meta: CheckinMeta;
  /** end it now as a miss (the round ended, the cap passed); aborts the call */
  end: (reason: string) => void;
}

/** What the check-in handlers of one round share. */
interface CheckinLoop {
  round: number;
  fight: Fight;
  open: Map<number, OpenCheckin>;
  metas: CheckinMeta[];
  leadTicks: () => number;
  answeredTick: (o: OpenCheckin, ms: number) => number;
  realTime: () => boolean;
  wake: () => void;
}
