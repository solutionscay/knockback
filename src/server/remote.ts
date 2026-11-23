import { CLASSIC, enabledItems, type Ruleset } from "../sim/ruleset";
/**
 * A remote agent's seat. To the runner it is one more Provider (an `ask` of
 * prompt -> answer text), so decideRound gives it the same deadline and
 * house-bot fallback as any local AI. The answer arrives over HTTP: the
 * seat publishes a turn (structured context + the rendered prompt), an agent
 * long-polls for it and submits a plan, and the seat resolves the ask with
 * the plan as JSON text, which decideRound parses like any AI answer. So the
 * sim sees exactly what a local provider would produce, and the record
 * replays with no network.
 */
import { CHECKIN, parseCheckin, type CheckinStatus } from "../ai/checkin";
import { remoteLabel } from "../stats/models";
import { parseAnswer, MAX_LINE, MAX_WHY } from "../ai/parse";
import { buildReport, buildsHelp, lastPlanLines, ruleResultLine, whatHappenedLines, weaponHelp, enabledRuleExamples, STANCE_HELP } from "../ai/prompt";
import { BUILD_EXAMPLES, BUILD_MAX, BUILD_MIN, buildsOn, NEUTRAL_BUILD } from "../sim/build";
import { levelTactics, longGunsLastRound } from "../ai/tactics";
import type { Provider } from "../ai/providers";
import type { Match } from "../sim/match";
import type { Strategy } from "../sim/sim-types";
import { MAX_RULE_LABEL, RULE_RETALIATE, RULE_STANCES, RULE_VALUE, WHO_TRIGGERS } from "../sim/rules";
import { MAX_RULES, RULE_DO, RULE_WHEN } from "../sim/sim-types";

/** Targets the prompt offers besides the rivals' names. */
export const TARGET_CHOICES = ["nearest", "weakest", "strongest", "leader"] as const;

/** The plan fields an agent may send (the rest of a request body is rejected). */
export const PLAN_KEYS = ["round", "weapons", "target", "stance", "retaliate", "build", "rules", "why", "line", "answer"] as const;
export const MAX_ANSWER = 8_000;
/** invalid plans an agent may send in one round before it is cut off (the house bot plays at the deadline) */
export const MAX_ATTEMPTS = 10;

/** The plan schema every turn carries, so a client needs no other docs. */
export function planSchema(ruleset: Ruleset = CLASSIC) {
  return {
    weapons: { type: "array of 1-3 different weapons, best first", values: weaponHelp(ruleset) },
    target: { type: "string", values: ["<a rival's name>", ...TARGET_CHOICES] },
    stance: { type: "string", values: RULE_STANCES, help: STANCE_HELP },
    retaliate: { type: "string, optional (default turn)", values: RULE_RETALIATE },
    ...(buildsOn(ruleset) ? { build: { type: `object {health, weight, power}, optional (default all 0): whole numbers from ${BUILD_MIN} to ${BUILD_MAX} that add up to 0`, help: buildsHelp(), examples: BUILD_EXAMPLES } } : {}),
    rules: {
      type: `array of 0-${MAX_RULES} rules, optional, first = highest priority`,
      when: RULE_WHEN,
      do: RULE_DO,
      who: ["anyone", "enemy", "target", "<a rival's name>"],
      whoTriggers: WHO_TRIGGERS,
      valueRanges: RULE_VALUE,
      items: enabledItems(ruleset),
      label: `string, optional, at most ${MAX_RULE_LABEL} characters`,
      example: JSON.parse(enabledRuleExamples(ruleset)[0]!),
    },
    why: { type: `string, optional, at most ${MAX_WHY} characters: why this plan, in game terms` },
    line: { type: `string, required, at most ${MAX_LINE} characters: what your fighter says out loud` },
    answer: { type: `string, alternative to the fields above: a model's raw reply (at most ${MAX_ANSWER} characters) that contains the JSON plan` },
  };
}

/** What the agent knows before a round, as data (the prompt says the same in words). */
export function turnContext(match: Match, me: number) {
  const ctx = match.contextFor(me);
  const names = ctx.names;
  const rounds = match.record.rounds;
  const previous = rounds[rounds.length - 1];
  const last = ctx.last;
  const lv = match.level;
  const count = (k: string) => lv.props.filter((p) => p.kind === k).length;
  return {
    round: ctx.round,
    phase: ctx.phase,
    you: { seat: me, name: names[me]! },
    fighters: names.map((name, i) => ({
      seat: i,
      name,
      you: i === me,
      roundWins: ctx.wins[i]!,
      knockouts: ctx.history.reduce((a, f) => a + f.fighters[i]!.kosDealt.length, 0),
      morale: ctx.morale[i]!.state,
      healthAtEnd: last ? Math.round(last.fighters[i]!.hpEnd) : null,
      lastLine: previous?.lines[i] ?? null,
    })),
    level: {
      theme: lv.theme,
      width: lv.width,
      platforms: lv.platforms,
      pits: lv.pits.length,
      // #100: jump-through platforms (jump up through, hold down to drop; shots pass), soft ground over a hard frame, wall jumps
      jumpThrough: jumpThroughCount(lv),
      stage: "pits are gaps with a jump-through catwalk over them; most hanging platforms are jump-through (jump up through, hold down to drop through, shots pass through); the ground is soft on top over a hard rock or steel frame (dig action: digs soft ground only); in the air against a wall, jump again to wall-jump (not while stunned or just knocked)",
      props: Object.fromEntries(["crate", "barrel", "tnt", "glass", "pad", "weight"].map((k) => [k, count(k)])),
    },
    // high ground, cover, sightlines and long guns (#38): the same facts as the prompt's TACTICS paragraph
    tactics: { ...levelTactics(lv, match.ruleset), longGunsLastRound: last ? longGunsLastRound(last.stats, names, match.ruleset) : null },
    lastRound: last
      ? {
          round: last.round,
          winner: names[last.winner]!,
          reason: last.reason,
          seconds: Math.round(last.seconds),
          whatHappenedToYou: whatHappenedLines(last.stats, me, names),
          yourPlan: previous?.strategies[me] ?? null,
          howYourPlanWent: previous ? [...lastPlanLines(previous.strategies[me]!, last.stats, me, names), ruleResultLine(previous.strategies[me]!.rules, last.stats.rules?.[me])] : [],
          rulesRejected: previous?.meta?.[me]?.ruleProblems ?? [],
          // each fighter's build last round and how yours did (#80)
          builds: previous ? names.map((name, i) => ({ name, build: previous.strategies[i]!.build ?? NEUTRAL_BUILD })) : [],
          howYourBuildWent: previous && buildsOn(match.ruleset) ? buildReport(previous.strategies.map((s) => s.build ?? NEUTRAL_BUILD), last, me, names)[1]! : null,
          knockouts: last.stats.kos.map((k) => ({ victim: names[k.victim]!, by: k.by >= 0 && k.by !== k.victim ? names[k.by]! : null, weapon: k.weapon, cause: k.cause, atSeconds: k.tick !== undefined ? Math.round(k.tick / 60) : null })),
          damageTaken: names
            .map((from, a) => ({ from, damage: Math.round(last.stats.damage[a]![me]!.damage), hits: last.stats.damage[a]![me]!.hits, fromBehind: last.stats.damage[a]![me]!.fromBehind }))
            .filter((d, a) => a !== me && d.damage >= 1),
          pickups: Object.fromEntries(names.map((n, i) => [n, last.stats.pickups[i]!])),
          summary: last.stats.summary[me]!,
        }
      : null,
    yourEarlierLines: rounds.map((r) => r.lines[me]!),
    targets: [...names.filter((_, i) => i !== me), ...TARGET_CHOICES],
  };
}

export type TurnContext = ReturnType<typeof turnContext>;

export interface Turn {
  round: number;
  prompt: string;
  context: TurnContext;
  startedAt: number;
  deadlineAt: number;
  attempts: number;
  resolve: (text: string) => void;
  reject: (e: Error) => void;
}

/** A mid-round check-in waiting for the agent's answer (#9). */
export interface CheckinTurn {
  round: number;
  tick: number;
  status: CheckinStatus;
  prompt: string;
  startedAt: number;
  deadlineAt: number;
  attempts: number;
  resolve: (text: string) => void;
  reject: (e: Error) => void;
}

/** The fields a check-in answer may carry (all optional but round and tick). */
export const CHECKIN_KEYS = ["round", "tick", "keep", "weapons", "target", "stance", "retaliate", "rules", "why", "line", "answer"] as const;

/** The check-in answer schema every check-in turn carries. */
export function checkinSchema(ruleset: Ruleset = CLASSIC) {
  return {
    keep: { type: "boolean: true = keep the plan (the default when no plan field is sent)" },
    target: { type: "string, optional", values: ["<a rival's name>", ...TARGET_CHOICES] },
    stance: { type: "string, optional", values: RULE_STANCES },
    weapons: { type: "array of 1-3 different weapons, optional", values: weaponHelp(ruleset) },
    retaliate: { type: "string, optional", values: RULE_RETALIATE },
    rules: { type: `array of 0-${MAX_RULES} rules, optional: replaces your rules (same shape as in a round plan)`, items: enabledItems(ruleset) },
    line: { type: `string, optional, at most ${CHECKIN.maxLine} characters: what your fighter shouts with the change` },
    why: { type: `string, optional, at most ${MAX_WHY} characters` },
    answer: { type: "string, alternative: a model's raw reply that contains the JSON" },
    note: "only the fields you send change; the rest of your plan stays. The fight keeps going: the change applies when your answer arrives (fight time).",
  };
}

export type CheckinResult =
  | { ok: true; result: "keep" | "update"; changed: string[]; line?: string }
  | { ok: false; status: number; error: string; problems?: string[] };

export type SubmitResult =
  | { ok: true; plan: { weapons: string[]; target: string; stance: string; retaliate: string; rules: unknown[]; why?: string; line: string }; warnings: string[] }
  | { ok: false; status: number; error: string; problems?: string[] };

const isStr = (v: unknown, max: number) => typeof v === "string" && v.length <= max;

/** Type and size checks before the game parser sees a plan (the parser checks the values). */
export function checkPlanShape(body: Record<string, unknown>): string[] {
  const p: string[] = [];
  const unknown = Object.keys(body).filter((k) => !(PLAN_KEYS as readonly string[]).includes(k));
  if (unknown.length) p.push(`unknown field${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")} (allowed: ${PLAN_KEYS.join(", ")})`);
  if (!Number.isInteger(body.round)) p.push(`round: an integer is required (the round from your turn)`);
  if (body.answer !== undefined) {
    if (!isStr(body.answer, MAX_ANSWER)) p.push(`answer: a string of at most ${MAX_ANSWER} characters`);
    const extra = Object.keys(body).filter((k) => k !== "answer" && k !== "round");
    if (extra.length) p.push(`answer: send either "answer" or the plan fields, not both (got ${extra.join(", ")})`);
    return p;
  }
  if (!Array.isArray(body.weapons) || body.weapons.length > 3 || !body.weapons.every((w) => isStr(w, 24))) p.push("weapons: an array of 1-3 weapon names");
  for (const k of ["target", "stance"] as const) if (!isStr(body[k], 24)) p.push(`${k}: a string is required`);
  if (body.retaliate !== undefined && !isStr(body.retaliate, 24)) p.push("retaliate: a string");
  if (body.build !== undefined && (!body.build || typeof body.build !== "object" || Array.isArray(body.build) || Object.keys(body.build).length > 6)) p.push("build: an object {health, weight, power}");
  if (body.why !== undefined && !isStr(body.why, 400)) p.push("why: a string of at most 400 characters");
  if (!isStr(body.line, 400) || !(body.line as string).trim()) p.push("line: a non-empty string is required");
  if (body.rules !== undefined) {
    if (!Array.isArray(body.rules) || body.rules.length > MAX_RULES) p.push(`rules: an array of at most ${MAX_RULES} rules`);
    else
      body.rules.forEach((r, i) => {
        if (!r || typeof r !== "object" || Array.isArray(r)) return void p.push(`rule ${i + 1}: an object`);
        const entries = Object.entries(r as Record<string, unknown>);
        if (entries.length > 10 || entries.some(([k, v]) => k.length > 24 || !(typeof v === "number" || isStr(v, 60))))
          p.push(`rule ${i + 1}: at most 10 keys with short string or number values`);
      });
  }
  return p;
}

export class RemoteSeat {
  readonly provider: Provider;
  match: Match | null = null;
  seat = -1;
  turn: Turn | null = null;
  /** rounds this seat has a plan for (accepted, or timed out) */
  readonly done = new Set<number>();
  /** the agent left: the house bot plays this seat from now on */
  left = false;
  /** a mid-round check-in waiting for an answer (#9) */
  checkinTurn: CheckinTurn | null = null;
  /** the house bot plays this seat until the agent comes back (#22): why */
  autopilot: string | null = null;
  /** called when the turn appears or ends */
  onChange: () => void = () => {};
  /** a plan already accepted for this round (e.g. stored before a restart), returned at once */
  stored: (round: number) => Promise<string | null> = async () => null;
  /** called with each accepted plan before the turn ends (to persist it) */
  onAccept: (round: number, raw: string) => Promise<void> | void = () => {};
  /** the round number the agent knows for a match round (the Arena's round, #64); used in error messages */
  shown: (round: number) => number = (r) => r;

  constructor(
    readonly agentName: string,
    deadlineMs: number,
    /** the model id the agent reported at join (modelOf cleans it for the badge; marked self-reported) */
    model: string,
  ) {
    this.provider = { label: remoteLabel(agentName, model), deadlineMs, ask: (prompt, signal) => this.ask(prompt, signal) };
  }

  bind(match: Match, seat: number) {
    this.match = match;
    this.seat = seat;
  }

  private ask(prompt: string, signal: AbortSignal): Promise<string> {
    const match = this.match;
    if (!match) return Promise.reject(new Error("seat not bound to a match"));
    if (this.left) return Promise.reject(new Error("the agent left the match"));
    if (this.autopilot) return Promise.reject(new Error(`autopilot: ${this.autopilot}`));
    return this.stored(match.round + 1).then((raw) => (raw !== null ? raw : this.waitForPlan(match, prompt, signal)));
  }

  private waitForPlan(match: Match, prompt: string, signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const now = Date.now();
      const round = match.round + 1;
      const end = () => {
        this.turn = null;
        this.done.add(round);
        this.onChange();
      };
      this.turn = {
        round,
        prompt,
        context: turnContext(match, this.seat),
        startedAt: now,
        deadlineAt: now + (this.provider.deadlineMs ?? 20_000),
        attempts: 0,
        resolve: (text) => {
          end();
          resolve(text);
        },
        reject: (e) => {
          end();
          reject(e);
        },
      };
      signal.addEventListener(
        "abort",
        () => {
          if (this.turn?.round !== round) return;
          end();
          reject(new Error("deadline"));
        },
        { once: true },
      );
      this.onChange();
    });
  }

  /** Autopilot on (a reason) or off (null). On: a turn still open ends now and the house bot plays it, and every later one until it is turned off. */
  setAutopilot(reason: string | null) {
    this.autopilot = reason;
    if (reason) {
      this.turn?.reject(new Error(`autopilot: ${reason}`));
      this.checkinTurn?.reject(new Error(`autopilot: ${reason}`));
    }
  }

  /** The agent leaves: a pending turn ends now (the house bot plays it), and every later one too. */
  leave() {
    this.left = true;
    this.turn?.reject(new Error("the agent left the match"));
    this.checkinTurn?.reject(new Error("the agent left the match"));
  }

  /**
   * A mid-round check-in (#9): publish the status and wait for the agent's
   * answer: it stays open until the answer arrives, or the runner aborts it
   * (the round ended, the hung-call cap passed). The answer is returned as JSON
   * text, which the runner parses with the same parser as submitCheckin.
   */
  askCheckin(prompt: string, status: CheckinStatus, signal: AbortSignal, capMs: number = CHECKIN.capMs): Promise<string> {
    if (!this.match) return Promise.reject(new Error("seat not bound to a match"));
    if (this.left) return Promise.reject(new Error("the agent left the match"));
    if (this.autopilot) return Promise.reject(new Error(`autopilot: ${this.autopilot}`));
    return new Promise<string>((resolve, reject) => {
      const now = Date.now();
      const end = () => {
        if (this.checkinTurn === t) this.checkinTurn = null;
        this.onChange();
      };
      const t: CheckinTurn = {
        round: status.round,
        tick: status.tick,
        status,
        prompt,
        startedAt: now,
        deadlineAt: now + capMs,
        attempts: 0,
        resolve: (text) => (end(), resolve(text)),
        reject: (e) => (end(), reject(e)),
      };
      this.checkinTurn = t;
      signal.addEventListener("abort", () => this.checkinTurn === t && t.reject(new Error("check-in closed")), { once: true });
      this.onChange();
    });
  }

  /**
   * An agent's check-in answer: {round, tick, keep?} or plan fields to change
   * (or {round, tick, answer}). Validated against the plan the fighter plays
   * now; an invalid answer is rejected with the problems (retry until the
   * deadline). The first valid answer ends the check-in.
   */
  submitCheckin(body: Record<string, unknown>, current: () => Strategy | null): CheckinResult {
    const match = this.match;
    const extra = Object.keys(body).filter((k) => !(CHECKIN_KEYS as readonly string[]).includes(k));
    const problems: string[] = [];
    if (extra.length) problems.push(`unknown field${extra.length > 1 ? "s" : ""}: ${extra.join(", ")} (allowed: ${CHECKIN_KEYS.join(", ")})`);
    if (!Number.isInteger(body.round) || !Number.isInteger(body.tick)) problems.push("round and tick: integers (from the check-in turn)");
    if (body.answer !== undefined && !isStr(body.answer, MAX_ANSWER)) problems.push(`answer: a string of at most ${MAX_ANSWER} characters`);
    if (body.keep !== undefined && typeof body.keep !== "boolean") problems.push("keep: true or false");
    if (body.line !== undefined && !isStr(body.line, 400)) problems.push("line: a string");
    if (body.why !== undefined && !isStr(body.why, 400)) problems.push("why: a string");
    if (JSON.stringify(body).length > MAX_ANSWER + 200) problems.push("the answer is too big");
    if (problems.length) return { ok: false, status: 400, error: "malformed check-in answer", problems };
    if (!match) return { ok: false, status: 409, error: "the round has not started" };
    const t = this.checkinTurn;
    if (!t) return { ok: false, status: 409, error: "no check-in is open now (it was answered, or the round ended); wait for your turn" };
    if (t.round !== body.round || t.tick !== body.tick) return { ok: false, status: 409, error: `wrong check-in: the open one is round ${this.shown(t.round)}, tick ${t.tick}` };
    if (++t.attempts > MAX_ATTEMPTS) return { ok: false, status: 429, error: `more than ${MAX_ATTEMPTS} invalid answers; your plan stays` };
    const fields: Record<string, unknown> = Object.fromEntries(Object.entries(body).filter(([k]) => k !== "round" && k !== "tick"));
    // no plan field and no answer: a keep (with its line, if any)
    if (body.answer === undefined && fields.keep === undefined && !["weapons", "target", "stance", "retaliate", "rules"].some((k) => fields[k] !== undefined)) fields.keep = true;
    const raw = body.answer !== undefined ? (body.answer as string) : JSON.stringify(fields);
    const plan = current();
    if (!plan) return { ok: false, status: 409, error: "your fighter is not fighting now" };
    // the runner parses this same text against the same plan, so it gets exactly this result
    const a = parseCheckin(raw, this.seat, match.names, plan, undefined, match.ruleset);
    if (a.kind === "invalid") return { ok: false, status: 422, error: "invalid check-in answer", problems: a.problems.map((x) => `bad value: ${x}`) };
    t.resolve(raw);
    return { ok: true, result: a.kind, changed: a.kind === "update" ? a.changed : [], ...(a.line ? { line: a.line } : {}) };
  }

  /**
   * Validate a plan for the current turn. A valid plan ends the turn (the
   * first valid plan is final); an invalid one is rejected with the
   * problems, and the agent may try again until the deadline.
   */
  async submit(body: Record<string, unknown>): Promise<SubmitResult> {
    const match = this.match;
    const shape = checkPlanShape(body);
    if (shape.length) return { ok: false, status: 400, error: "malformed plan", problems: shape };
    const round = body.round as number;
    if (!match) return { ok: false, status: 409, error: "the round has not started" };
    if (this.done.has(round)) return { ok: false, status: 409, error: `round ${this.shown(round)} is already planned (a plan was accepted, or the deadline passed)` };
    const turn = this.turn;
    if (!turn) return { ok: false, status: 409, error: `no plan is wanted now; wait for your turn` };
    if (turn.round !== round) return { ok: false, status: 409, error: `wrong round: the turn is for round ${this.shown(turn.round)}` };
    if (++turn.attempts > MAX_ATTEMPTS) return { ok: false, status: 429, error: `more than ${MAX_ATTEMPTS} invalid plans this round; the house bot plays it at the deadline` };
    const raw = body.answer !== undefined ? (body.answer as string) : JSON.stringify(Object.fromEntries(Object.entries(body).filter(([k]) => k !== "round")));
    const p = parseAnswer(raw, this.seat, match.names, match.ruleset);
    const problems = [...(p.strategy ? [] : p.problems.map((x) => `bad value: ${x}`)), ...(p.line ? [] : ["line: missing or empty"])];
    // structured plans must be fully valid; a raw answer keeps the AI rule (bad rules are dropped with a warning)
    if (body.answer === undefined && p.ruleProblems?.length) problems.push(...p.ruleProblems);
    if (problems.length) return { ok: false, status: 422, error: "invalid plan", problems };
    const s = p.strategy!;
    const name = (who: unknown) => (typeof who === "number" ? match.names[who] : who);
    // what was accepted, for the agent's own log (rival seats as names)
    const plan = {
      weapons: s.weapons.slice(),
      target: s.target === "grudge" && s.grudge !== undefined ? match.names[s.grudge]! : s.target,
      stance: s.stance,
      retaliate: s.retaliate ?? "turn",
      build: s.build!,
      rules: (s.rules ?? []).map((r) => ({ ...r, ...(r.who !== undefined ? { who: name(r.who) } : {}) })),
      ...(p.why ? { why: p.why } : {}),
      line: p.line!,
    };
    // decideRound parses this same text with the same parser, so it gets exactly this plan
    await this.onAccept(round, raw);
    if (this.turn !== turn) return { ok: false, status: 409, error: `round ${this.shown(round)} ended while the plan was being saved` };
    turn.resolve(raw);
    return { ok: true, plan, warnings: p.ruleProblems ?? [] };
  }
}

/** #100: jump-through platforms in a level (runs of jump-through cells). */
function jumpThroughCount(lv: { grid: { rows: number; cols: number; oneway(cx: number, cy: number): boolean } }): number {
  let n = 0;
  for (let cy = 0; cy < lv.grid.rows; cy++) for (let cx = 0; cx < lv.grid.cols; cx++) if (lv.grid.oneway(cx, cy) && !lv.grid.oneway(cx - 1, cy)) n++;
  return n;
}
