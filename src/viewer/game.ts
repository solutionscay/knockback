import type { Ruleset } from "../sim/ruleset";
/**
 * Viewer loop for a best-of-3 match: walks the beats (src/flow) and draws each.
 *   level card -> intro lines -> [3 2 1 FIGHT! -> round -> round result
 *   -> between-round lines]... -> celebrate + tally -> next match
 * The flow is data; this file only decides how each beat looks.
 */
import type { SoundDirector } from "./audio/director";
import type { Application } from "pixi.js";
import { betweenBeats, betweenOrder, closingBeats, FlowRunner, introOrder, openingBeats, roundBeats, simRuns, type Beat } from "../flow/beats";
import { Tally } from "../flow/score";
import type { Identity } from "../sim/identity";
import type { Soul } from "../sim/soul";
import { DT } from "../sim/constants";
import type { Fight } from "../sim/fight";
import { Match, type DecisionMeta, type MatchRecord, type SuitUpEntry } from "../sim/match";
import type { SimEvent } from "../sim/sim";
import { VoiceSession, type Decision } from "../sim/voice";
import { hex } from "./portrait";
import { sanitizeDecision, sanitizePlanUpdate } from "./sanitize";
import type { PlanUpdate } from "../sim/match";
import { Scene, type CamMode } from "./scene";
import { celebrateHtml, dialogueHtml, esc, loadCamera, loadTally, pipsHtml, recapHtml, renderCamBar, renderDialogueLine, renderRoundClock, restart, saveCamera, saveTally, type Hud } from "./game-hud";
import { GamePlans } from "./game-plans";
import { ensureModelBadgeCss, modelBadgeHtml } from "./model-badge";
import { AutopilotTrack, sanitizeControl, sanitizeOne, type ControlView } from "./autopilot";

const SLOW_TIME = 1.6;

export type { Hud } from "./game-hud";

export interface Moment {
  time: number;
  kind: string;
  weight: number;
}

export class Game {
  match!: Match;
  /** the round currently shown (lags match.fight during a round result) */
  shown!: Fight;
  readonly scene: Scene;
  flow!: FlowRunner;
  private readonly plans = new GamePlans();
  /** autopilot (#22): control changes from the server, shown when the match reaches them */
  private readonly ap = new AutopilotTrack();
  /** spectator picks (#35): the crowd tally during the fight and the split on the win screen */
  crowd: { update(beat: Beat["kind"]): void; celebrate(el: HTMLElement, winner: number): void } | null = null;
  private apUntil = 0;
  get callouts() {
    return this.plans.callouts;
  }
  /** hide the SUDDEN DEATH callout at this clock time */
  private suddenUntil = 0;
  tally: Tally;
  /** points gained this match, per fighter */
  matchPoints = [0, 0, 0, 0];
  readonly session = new VoiceSession();
  private decisions: Decision[] = [];
  private acc = 0;
  private hitPause = 0;
  private slow = 0;
  clock = 0;
  moments: Moment[] = [];
  /** Auto-start the next match this many seconds after the celebrate beat ends (null = wait for the button). */
  autoNext: number | null = 6;
  private idleAfter = 0;
  onNeedNewMatch: (() => void) | null = null;
  /** provider label per fighter ("claude/haiku"), when AI fighters play */
  labels: string[] | null = null;
  /** live AI match: decisions arrive from the server, round by round */
  live = false;
  private liveQueue = new Map<number, { decisions: Decision[]; meta: DecisionMeta[] }>();
  private waitingRound = 0;
  /** live: plan updates (#8) for rounds not prepared yet */
  private liveUpdates = new Map<number, PlanUpdate[]>();
  /**
   * live: each round's check-in state (#9): its schedule, the seats whose
   * check-in is open ("tick:seat"), and the server's last fightTick (the tick
   * its sim has reached; no update applies before it + lead). The fight never
   * runs past the earliest tick an update could still apply at:
   *   - a check-in open: server tick + lead (an answer applies at the tick it
   *     arrived at on the server + lead);
   *   - none open: the next scheduled check-in + 1 s (the minimum delay).
   * Viewers behind the server's pacing estimate (the normal case) never hold;
   * one ahead of it (skipped dialogue, a fast clock) waits there. A slow
   * answer never stalls the fight: the server keeps going and stamps it with
   * the tick it has reached.
   */
  private checkins = new Map<number, { schedule: number[]; open: Set<string>; server: number; lead: number }>();
  /** live: seconds the fight was held waiting for a check-in (diagnostics) */
  heldSeconds = 0;
  /** sound (#12): set by main.ts; reads what the viewer shows, never the sim's state */
  sound: SoundDirector | null = null;
  /** video mode (?capture&video): no zoom on the talking bot or the winner, no K.O. slow motion (docs/video.md) */
  videoMode = false;

  constructor(
    app: Application,
    private readonly hud: Hud,
  ) {
    this.scene = new Scene(app);
    ensureModelBadgeCss();
    this.tally = loadTally();
    this.scene.camera.camMode = loadCamera();
    this.scene.camera.onFollowLost = () => this.setCamera({ kind: "auto" });
    this.scene.onMood = (id, mood, x, y) => {
      const who = this.match?.identities[id];
      if (who && this.shown) this.sound?.mood(id, mood, x, y, who, this.shown.sim.tick, this.clock);
    };
  }

  // ------------------------------------------------------------- persistence + camera

  /** View-only: changes what the camera frames, never the simulation. */
  setCamera(mode: CamMode) {
    this.scene.camera.camMode = mode;
    saveCamera(mode);
    this.renderCamBar();
  }

  toggleFollow(id: number) {
    const m = this.scene.camera.camMode;
    if (m.kind === "follow" && m.id === id) this.setCamera({ kind: "auto" });
    else this.setCamera({ kind: "follow", id });
  }

  renderCamBar() {
    renderCamBar(this.hud.cam, this.scene.camera.camMode, this.shown?.sim);
  }

  resetTally() {
    this.tally = new Tally();
    saveTally(this.tally);
  }

  /** Who plays each seat (model badge): the match labels, else the first decision meta, else the house bot. */
  seatLabels(): string[] {
    return [0, 1, 2, 3].map((i) => this.labels?.[i] ?? this.match?.record.rounds.find((r) => r.meta?.[i])?.meta?.[i]?.provider ?? "house");
  }

  // ------------------------------------------------------------- dialogue controls

  /** Space / click: finish the current line now. */
  advanceDialogue() {
    if (this.flow?.beat.kind === "dialogue") this.flow.skip();
  }

  /** Skip the rest of this dialogue block. */
  skipDialogue() {
    if (this.flow?.beat.kind === "dialogue") this.flow.skipWhile((b) => b.kind === "dialogue");
  }

  // ------------------------------------------------------------- match setup

  /**
   * Start a match. Default: house bots decide. `recorded`: replay a saved match
   * exactly (all decisions from the record). `live`: decisions arrive later via
   * pushDecisions() (AI fighters thinking on the server).
   */
  newMatch(seed: number, opts: { recorded?: MatchRecord; live?: boolean; labels?: string[]; souls?: Soul[]; identities?: Identity[]; suitUp?: SuitUpEntry[]; control?: unknown; ruleset?: Ruleset } = {}) {
    this.apUntil = 0;
    document.getElementById("autopilot-callout")?.classList.remove("show");
    // live: the server settled the identities (and how the seats suited up, #19): taken exactly as they are
    this.match = new Match(seed, { session: this.session, recorded: opts.recorded, ruleset: opts.ruleset, souls: opts.souls, ...(opts.identities ? { identities: opts.identities } : {}), ...(opts.suitUp ? { suitUp: opts.suitUp } : {}) });
    this.ap.reset(sanitizeControl(opts.control, this.match.ruleset.round.maxRounds));
    this.match.onEvent = (e) => this.onEvent(e);
    this.labels = opts.labels ?? null;
    this.live = !!opts.live;
    this.liveQueue.clear();
    this.liveUpdates.clear();
    this.checkins.clear();
    this.waitingRound = 0;
    this.matchPoints = [0, 0, 0, 0];
    if (this.live) {
      // show the arena while the fighters think about round 1
      this.waitingRound = 1;
      this.shown = null as unknown as Fight;
      const preview = new Match(seed, { ruleset: this.match.ruleset, souls: this.match.souls, identities: this.match.identities });
      preview.prepareRound();
      this.shown = preview.fight!;
      this.scene.load(this.shown.sim);
      this.resetHud();
      this.flow = new FlowRunner([{ kind: "level", duration: 2.4 }], (b) => this.enter(b));
      this.hud.cam.className = "show";
      this.renderCamBar();
      return;
    }
    this.decisions = this.match.prepareRound();
    this.showFight(this.match.fight!);
    this.resetHud();
    this.plans.startLineup(this.hud.lineup, this.shown, this.decisions, this.seatLabels());
    const order = introOrder(this.match.morale.map((m) => m.score));
    this.flow = new FlowRunner(
      [...openingBeats(order, this.decisions.map((d) => d.line)), ...roundBeats(1)],
      (b) => this.enter(b),
    );
    this.hud.cam.className = "show";
    this.renderCamBar();
  }

  private resetHud() {
    this.acc = 0;
    this.hitPause = 0;
    this.slow = 0;
    this.idleAfter = 0;
    for (const [k, el] of Object.entries(this.hud)) {
      if (k === "cam") continue;
      el.className = "";
      el.innerHTML = "";
    }
  }

  /** Live match: an agent dropped (the house bot took its fighter) or came back (#22). */
  pushControl(raw: unknown) {
    const e = sanitizeOne(raw, this.match.ruleset.round.maxRounds);
    if (e) this.ap.push(e);
  }

  private showControl(e: ControlView) {
    let el = document.getElementById("autopilot-callout");
    if (!el) {
      el = document.createElement("div");
      el.id = "autopilot-callout";
      (document.getElementById("hud") ?? document.body).appendChild(el);
    }
    const c = this.match.identities[e.seat]?.color;
    if (c !== undefined) el.style.setProperty("--c", hex(c));
    el.innerHTML = `<small>${e.mode === "autopilot" ? "AUTOPILOT" : "BACK IN CONTROL"}</small>${esc(e.line)}`;
    restart(el, "show");
    this.apUntil = this.clock + 4.5;
  }

  /** Live AI match: the server sends each round's decisions as soon as the fighters have answered. */
  pushDecisions(round: number, decisions: Decision[], meta: DecisionMeta[], checkinTicks?: unknown) {
    // the round's check-in schedule (#9): hold at each tick until the server has asked
    if (Array.isArray(checkinTicks) && !this.checkins.has(round))
      this.checkins.set(round, { schedule: checkinTicks.filter((t): t is number => Number.isInteger(t) && t > 0 && t < 1e5).slice(0, 20).sort((a, b) => a - b), open: new Set(), server: 0, lead: 0 });
    decisions = [0, 1, 2, 3].map((i) => sanitizeDecision(decisions?.[i], i));
    meta = (Array.isArray(meta) ? meta : []).slice(0, 4).map((m) => ({ ...m, provider: String(m?.provider ?? "?").slice(0, 80), ms: Number(m?.ms) || 0 }));
    this.liveQueue.set(round, { decisions, meta });
    if (this.waitingRound === round) this.startLiveRound(round);
  }

  /** Live: a mid-round check-in opened for these seats (#9). */
  pushCheckin(round: number, tick: number, seats: unknown) {
    const c = this.checkins.get(round);
    if (!c || !Number.isInteger(tick) || !Array.isArray(seats)) return;
    for (const seat of seats.slice(0, 4)) if (Number.isInteger(seat)) c.open.add(`${tick}:${seat}`);
    c.server = Math.max(c.server, tick);
  }

  /** Live: a seat's check-in closed; no more updates from it. */
  pushCheckinEnd(round: number, tick: number, seat: number) {
    this.checkins.get(round)?.open.delete(`${tick}:${seat}`);
  }

  /** Live: the server's sim reached `tick`; no update will apply before tick + leadTicks. */
  pushFightTick(round: number, tick: number, leadTicks: number) {
    const c = this.checkins.get(round);
    if (!c || !Number.isInteger(tick)) return;
    c.server = Math.max(c.server, tick);
    c.lead = Number.isInteger(leadTicks) ? Math.max(0, Math.min(600, leadTicks)) : 0;
  }

  /** Live: no more check-ins this round. */
  pushCheckinsDone(round: number) {
    this.checkins.delete(round);
  }

  /** Live: a check-in answer became a plan update (#8); the engine applies it at its tick. */
  pushPlanUpdate(round: number, raw: unknown) {
    const u = sanitizePlanUpdate(raw);
    if (!u || !Number.isInteger(round)) return;
    const m = this.match;
    if (m.round === round && m.phase === "fighting" && m.fight) this.addLiveUpdate(u);
    else if (round > m.round) this.liveUpdates.set(round, [...(this.liveUpdates.get(round) ?? []), u]);
  }

  private addLiveUpdate(u: PlanUpdate) {
    const f = this.match.fight!;
    // the gate makes this rare; if it happens anyway, apply it now (this view may differ from the record)
    if (u.tick < f.sim.tick) {
      console.warn(`plan update for tick ${u.tick} arrived at tick ${f.sim.tick}; applying it now`);
      u = { ...u, tick: f.sim.tick };
    }
    this.match.addUpdate(u);
  }

  /** The last tick the live fight may show now (Infinity when this round has no check-in still to come). */
  private liveGate(): number {
    const c = this.checkins.get(this.match.round);
    if (!c) return Infinity;
    // 10 ticks of margin for the stream
    const afterServer = c.server + c.lead - 10;
    if (c.open.size) return afterServer;
    const next = c.schedule.find((t) => t > c.server);
    return next === undefined ? afterServer : Math.max(afterServer, next + 60 - 10);
  }

  private startLiveRound(round: number) {
    const got = this.liveQueue.get(round)!;
    this.waitingRound = 0;
    this.decisions = this.match.prepareRound(got.decisions, got.meta);
    for (const u of this.liveUpdates.get(round) ?? []) this.addLiveUpdate(u);
    this.liveUpdates.delete(round);
    if (round === 1) {
      this.showFight(this.match.fight!);
      this.plans.startLineup(this.hud.lineup, this.shown, this.decisions, this.seatLabels());
      const order = introOrder(this.match.morale.map((m) => m.score));
      this.flow.append([...openingBeats(order, this.decisions.map((d) => d.line)).slice(1), ...roundBeats(1)]);
    } else {
      const facts = this.match.facts[this.match.facts.length - 1]!;
      const order = betweenOrder(facts.winner, facts.fighters.map((f) => f.outOrder));
      this.hud.callout.querySelector(".thinking")?.remove();
      this.flow.append([...betweenBeats(order, this.decisions.map((d) => d.line), this.match.round), ...roundBeats(this.match.round)]);
    }
  }

  private showFight(f: Fight) {
    this.shown = f;
    this.sound?.reset();
    this.scene.load(f.sim);
    this.scene.morale = this.match.morale.map((m) => m.state);
    this.renderCamBar(); // everyone is back for the new round
  }

  // ------------------------------------------------------------- beats

  private enter(b: Beat) {
    const h = this.hud;
    this.sound?.beat(b as { kind: string; value?: number }, this.clock);
    switch (b.kind) {
      case "level": {
        const lv = this.match.level;
        // the arena name only: the line-up is on the page (and on the pick cards), the arena stats told nobody anything
        const thinking = this.live && this.waitingRound === 1 ? `<div class="lvmeta thinking">the fighters are thinking</div>` : "";
        this.scene.camera.overview = true;
        h.intro.innerHTML = `
          <div class="levelcard">
            <div class="kicker">BEST OF 3</div>
            <div class="lvname">${esc(lv.name)}</div>
            ${thinking}
          </div>`;
        restart(h.intro, "show level");
        break;
      }
      case "dialogue": {
        if (this.shown !== this.match.fight) this.showFight(this.match.fight!); // fresh arena for the next round
        this.scene.camera.overview = false;
        h.intro.className = "";
        h.callout.className = "";
        h.clock.className = "";
        if (!this.videoMode) this.scene.camera.focus = { id: b.fighter, offsetX: 0.22, heightM: 8.5 };
        this.scene.blam(b.fighter);
        h.lineup.querySelector(`[data-id="${b.fighter}"]`)?.classList.add("in");
        h.dialogue.innerHTML = dialogueHtml(this.match, this.decisions[b.fighter]!, this.seatLabels()[b.fighter]!, b);
        restart(h.dialogue, "show");
        h.dialogue.querySelector(".skip")?.addEventListener("click", (e) => {
          e.stopPropagation();
          this.skipDialogue();
        });
        break;
      }
      case "countdown":
        this.scene.camera.focus = null;
        this.scene.camera.overview = false;
        h.intro.className = "";
        h.dialogue.className = "";
        h.callout.className = "";
        h.count.innerHTML = `<span>${b.value}</span>${b.value === 3 ? `<em>ROUND ${b.round}</em>` : ""}`;
        restart(h.count, "show");
        this.scene.addShake(0.25);
        break;
      case "go": {
        h.count.innerHTML = `<span class="go">FIGHT!</span>`;
        restart(h.count, "show go");
        // the lineup chips stay up during the fight as compact plan chips (#10)
        h.lineup.className = "show fight";
        this.plans.startRound(this.match, this.decisions, this.clock);
        this.scene.addShake(0.6);
        this.acc = 0;
        break;
      }
      case "fight":
        h.count.className = "";
        break;
      case "roundEnd": {
        h.clock.className = "";
        h.lineup.className = "show out"; // the plan chips step aside for the recap
        const facts = this.match.finishRound();
        const res = this.match.results[this.match.results.length - 1]!;
        const scores = this.tally.add(res);
        for (const s of scores) this.matchPoints[s.fighter]! += s.total;
        saveTally(this.tally);
        const w = this.match.identities[facts.winner]!;
        const decided = this.match.over;
        h.callout.innerHTML = `<span class="small">ROUND ${facts.round} · ${res.reason === "time-out" ? "TIME!" : "LAST ONE STANDING"}</span><span style="color:${hex(w.color)}">${esc(w.name.toUpperCase())}!</span><span class="rmodel">${modelBadgeHtml(this.seatLabels()[facts.winner]!, "lg")}</span>${pipsHtml(this.match, "big")}${decided ? `<span class="small">TAKES THE MATCH</span>` : Math.max(...this.match.wins) === this.match.ruleset.round.winsToTake - 1 && this.match.round === this.match.ruleset.round.maxRounds - 1 ? `<span class="small">ONE ROUND LEFT · WINNER TAKES ALL</span>` : ""}`;
        h.callout.innerHTML += recapHtml(this.match, facts, this.plans.roundFirings, this.plans.roundKos, this.seatLabels());
        if (this.match.diverged >= 0) h.callout.innerHTML += `<span class="small diverged">REPLAY DIVERGED IN ROUND ${this.match.diverged} · THIS RECORD WAS MADE BY AN OLDER ENGINE</span>`;
        restart(h.callout, "show");
        if (decided) this.flow.append(closingBeats());
        else if (this.live) {
          this.waitingRound = this.match.round + 1;
          if (this.liveQueue.has(this.waitingRound)) this.startLiveRound(this.waitingRound);
          else h.callout.insertAdjacentHTML("beforeend", `<span class="small thinking">the fighters are thinking…</span>`);
        } else {
          this.decisions = this.match.prepareRound();
          const order = betweenOrder(facts.winner, facts.fighters.map((f) => f.outOrder));
          this.flow.append([...betweenBeats(order, this.decisions.map((d) => d.line), this.match.round), ...roundBeats(this.match.round)]);
        }
        break;
      }
      case "celebrate": {
        h.callout.className = "";
        const wid = this.match.winner;
        if (!this.videoMode) this.scene.camera.focus = { id: wid, offsetX: -0.24, heightM: 8 };
        this.scene.celebrateId = wid;
        h.celebrate.innerHTML = celebrateHtml(this.match, this.tally, this.matchPoints, this.matchesPlayed, this.ap.on, this.seatLabels());
        this.crowd?.celebrate(h.celebrate, this.match.winner);
        restart(h.celebrate, "show");
        h.celebrate.querySelector<HTMLButtonElement>(".next")?.addEventListener("click", () => this.onNeedNewMatch?.());
        this.moments.push({ time: this.clock, kind: "celebrate", weight: 0 });
        break;
      }
    }
  }

  private matchesPlayed = 0;

  // ------------------------------------------------------------- events

  /** ?debug=rules: log every plan rule start/stop and float its label over the fighter (#6) */
  debugRules = typeof location !== "undefined" && new URLSearchParams(location.search).get("debug") === "rules";

  private onEvent(e: SimEvent) {
    this.scene.onEvent(e);
    if (this.shown) this.sound?.event(e, this.shown.sim, this.clock);
    this.plans.onEvent(e, this.match, this.clock);
    if (e.type === "rule" && this.debugRules) {
      const f = this.shown.sim.fighters[e.fighter]!;
      const rule = (this.shown.controllers[e.fighter]?.strategy ?? this.match.decisions[e.fighter]?.strategy)?.rules?.[e.rule];
      const who = e.subject >= 0 ? ` -> ${this.match.names[e.subject]}` : "";
      console.info(`[rule] ${(e.tick / 60).toFixed(1)} s ${f.name} rule ${e.rule + 1} '${rule?.label ?? "?"}' ${e.on ? "ON" : "off"}${who}`);
      if (e.on && !f.removed) {
        const p = this.shown.sim.pos(f);
        this.scene.float(`${rule?.label ?? "rule"}${who}`, p.x, p.y + 2.4, f.color, 0.7);
      }
    }
    if (e.type === "suddenDeath") {
      const h = this.hud;
      h.callout.innerHTML = `<span>SUDDEN DEATH</span><span class="small">NOBODY'S FIGHTING · THE ZONE IS CLOSING</span>`;
      restart(h.callout, "show sd");
      this.suddenUntil = this.clock + 2.4;
      this.scene.addShake(0.5);
      this.moments.push({ time: this.clock, kind: "sudden", weight: 6 });
    }
    if (e.type === "ko") {
      queueMicrotask(() => this.renderCamBar());
      this.hitPause = Math.max(this.hitPause, 0.14);
      if (!this.videoMode) this.slow = SLOW_TIME;
      const f = this.shown.sim.fighters[e.fighter]!;
      const p = e.cause === "ringout" ? { x: Math.max(-28, Math.min(28, e.x)), y: Math.max(-2, e.y) } : { x: e.x, y: e.y };
      if (!f.removed || e.cause === "ringout") this.scene.koPunch(p.x, p.y);
      this.moments.push({ time: this.clock, kind: e.cause === "ringout" ? "ringout" : "ko", weight: e.cause === "ringout" ? 10 : 8 });
    } else if (e.type === "explosion" && e.kind === "barrel") {
      this.hitPause = Math.max(this.hitPause, 0.05);
      const chained = e.chainFrom === "barrel";
      this.moments.push({ time: this.clock, kind: chained ? "chain" : "barrel", weight: chained ? 7 : 4 });
    }
  }

  // ------------------------------------------------------------- frame

  update(dt: number) {
    // live mode: the ticker runs before the server's first message has built a match
    if (!this.flow || !this.shown) return;
    this.clock += dt;
    let simDt = 0;
    if (this.hitPause > 0) {
      this.hitPause -= dt;
    } else {
      let scale = 1;
      if (this.slow > 0) {
        const u = 1 - this.slow / SLOW_TIME;
        scale = 0.16 + 0.84 * u * u * u;
        this.slow -= dt;
      }
      simDt = dt * scale;
    }

    this.flow.update(dt, this.shown.over);
    const beat = this.flow.beat;
    // the round on screen: during a round end the next round may already be prepared (match.round is one ahead)
    const onScreen = beat.kind === "roundEnd" || beat.kind === "celebrate" ? this.match.results.length : this.match.round;
    for (const e of this.ap.update(onScreen, beat.kind, this.shown.sim.tick)) this.showControl(e);
    if (this.apUntil && this.clock > this.apUntil) {
      this.apUntil = 0;
      document.getElementById("autopilot-callout")?.classList.remove("show");
    }
    this.scene.autopilot = this.ap.on;
    this.plans.autopilot = this.ap.on;
    this.crowd?.update(beat.kind);
    if (this.suddenUntil > 0 && (this.clock > this.suddenUntil || beat.kind !== "fight")) {
      this.suddenUntil = 0;
      if (this.hud.callout.classList.contains("sd")) this.hud.callout.className = "";
    }
    const mode = simRuns(beat);
    if (mode !== "frozen") {
      this.acc += simDt;
      let ticks = 0;
      const gate = this.live && mode === "fight" ? this.liveGate() : Infinity;
      while (this.acc >= DT && ticks < 8) {
        // live: hold the fight while a check-in answer could still land on the next tick
        if (mode === "fight" && !this.shown.over && this.shown.sim.tick >= gate) {
          this.heldSeconds += dt;
          this.acc = Math.min(this.acc, DT);
          break;
        }
        this.acc -= DT;
        ticks++;
        this.scene.capturePrev();
        if (mode === "fight" && !this.shown.over) {
          this.shown.step();
          this.sound?.tick(this.shown.sim, this.clock);
          this.plans.applyUpdates(this.match, this.shown, this.decisions, this.clock);
          const { bigHit } = this.scene.afterTick();
          if (bigHit >= 14) {
            this.hitPause = Math.max(this.hitPause, 0.045 + Math.min(0.08, (bigHit - 14) * 0.006));
            if (bigHit > 20) this.moments.push({ time: this.clock, kind: "bighit", weight: 5 });
          }
          if (this.hitPause > 0) break;
        } else {
          this.shown.stepAfterglow();
          this.scene.afterTick();
        }
      }
    }
    this.scene.setCallouts(this.plans.update(this.clock, beat.kind !== "fight" || this.slow > 0), this.clock);
    if (beat.kind === "go" || beat.kind === "fight") this.plans.renderChips(this.hud.lineup, this.match, this.shown, this.decisions);

    if (beat.kind === "dialogue") {
      const line = this.decisions[beat.fighter]!.line;
      const typed = renderDialogueLine(this.hud.dialogue, line, this.flow.t, beat.duration);
      this.sound?.dialogue(beat.fighter, this.match.identities[beat.fighter]!, line, typed, this.clock);
    }
    if (beat.kind === "go" || beat.kind === "fight") renderRoundClock(this.hud.clock, this.match, this.shown.sim.tick);
    if (this.flow.done && this.match.over && this.autoNext !== null) {
      this.idleAfter += dt;
      const btn = this.hud.celebrate.querySelector<HTMLElement>(".auto");
      const left = Math.ceil(this.autoNext - this.idleAfter);
      if (btn) btn.textContent = left > 0 ? `in ${left}` : "";
      if (this.idleAfter >= this.autoNext) {
        this.idleAfter = -1e9;
        this.matchesPlayed++;
        this.onNeedNewMatch?.();
      }
    }

    const alpha = mode === "frozen" ? 1 : Math.min(1, this.acc / DT);
    const fxDt = mode === "frozen" ? dt : simDt;
    this.scene.render(dt, alpha, fxDt);
    this.sound?.listen(this.scene.listener());
  }
}
