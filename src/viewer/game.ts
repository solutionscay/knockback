/**
 * Viewer loop for a best-of-3 match: walks the beats (src/flow) and draws each.
 *   level card -> intro lines -> [3 2 1 FIGHT! -> round -> round result
 *   -> between-round lines]... -> celebrate + tally -> next match
 * The flow is data; this file only decides how each beat looks.
 */
import type { Application } from "pixi.js";
import { betweenBeats, betweenOrder, closingBeats, FlowRunner, introOrder, openingBeats, roundBeats, simRuns, type Beat } from "../flow/beats";
import { Tally, type FightScore } from "../flow/score";
import type { Soul } from "../sim/soul";
import { DT, FIGHT_TICKS, TICK_RATE } from "../sim/constants";
import type { Fight } from "../sim/fight";
import { Match, ROUNDS_TO_WIN, type DecisionMeta, type MatchRecord } from "../sim/match";
import type { SimEvent } from "../sim/sim";
import { VoiceSession, type Decision } from "../sim/voice";
import { hex } from "./portrait";
import { sanitizeDecision } from "./sanitize";
import { Scene, type CamMode } from "./scene";
import { celebrateHtml, dialogueHtml, esc, loadCamera, loadTally, pipsHtml, recapHtml, renderCamBar, restart, saveCamera, saveTally, type Hud } from "./game-hud";
import { GamePlans } from "./game-plans";

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
  get callouts() {
    return this.plans.callouts;
  }
  /** hide the SUDDEN DEATH callout at this clock time */
  private suddenUntil = 0;
  tally: Tally;
  /** points gained this match, per fighter */
  matchPoints = [0, 0, 0, 0];
  matchScores: FightScore[][] = [];
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

  constructor(
    app: Application,
    private readonly hud: Hud,
  ) {
    this.scene = new Scene(app);
    this.tally = loadTally();
    this.scene.camMode = loadCamera();
    this.scene.onFollowLost = () => this.setCamera({ kind: "auto" });
  }

  // ------------------------------------------------------------- persistence + camera

  /** View-only: changes what the camera frames, never the simulation. */
  setCamera(mode: CamMode) {
    this.scene.camMode = mode;
    saveCamera(mode);
    this.renderCamBar();
  }

  toggleFollow(id: number) {
    const m = this.scene.camMode;
    if (m.kind === "follow" && m.id === id) this.setCamera({ kind: "auto" });
    else this.setCamera({ kind: "follow", id });
  }

  renderCamBar() {
    renderCamBar(this.hud.cam, this.scene.camMode, this.shown?.sim);
  }

  resetTally() {
    this.tally = new Tally();
    saveTally(this.tally);
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
  newMatch(seed: number, opts: { recorded?: MatchRecord; live?: boolean; labels?: string[]; souls?: Soul[] } = {}) {
    this.match = new Match(seed, { session: this.session, recorded: opts.recorded, souls: opts.souls });
    this.match.onEvent = (e) => this.onEvent(e);
    this.labels = opts.labels ?? null;
    this.live = !!opts.live;
    this.liveQueue.clear();
    this.waitingRound = 0;
    this.matchPoints = [0, 0, 0, 0];
    this.matchScores = [];
    if (this.live) {
      // show the arena while the fighters think about round 1
      this.waitingRound = 1;
      this.shown = null as unknown as Fight;
      const preview = new Match(seed, { souls: this.match.souls });
      preview.prepareRound();
      this.shown = preview.fight!;
      this.scene.load(this.shown.sim, this.shown.controllers);
      this.resetHud();
      this.flow = new FlowRunner([{ kind: "level", duration: 2.4 }], (b) => this.enter(b));
      this.hud.cam.className = "show";
      this.renderCamBar();
      return;
    }
    this.decisions = this.match.prepareRound();
    this.showFight(this.match.fight!);
    this.resetHud();
    this.plans.startLineup(this.hud.lineup, this.shown, this.decisions);
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

  planLine(i: number): string {
    return this.plans.planLine(i, this.match, this.shown, this.decisions);
  }

  /** Live AI match: the server sends each round's decisions as soon as the fighters have answered. */
  pushDecisions(round: number, decisions: Decision[], meta: DecisionMeta[]) {
    decisions = [0, 1, 2, 3].map((i) => sanitizeDecision(decisions?.[i], i));
    meta = (Array.isArray(meta) ? meta : []).slice(0, 4).map((m) => ({ ...m, provider: String(m?.provider ?? "?").slice(0, 40), ms: Number(m?.ms) || 0 }));
    this.liveQueue.set(round, { decisions, meta });
    if (this.waitingRound === round) this.startLiveRound(round);
  }

  private startLiveRound(round: number) {
    const got = this.liveQueue.get(round)!;
    this.waitingRound = 0;
    this.decisions = this.match.prepareRound(got.decisions, got.meta);
    if (round === 1) {
      this.showFight(this.match.fight!);
      this.plans.startLineup(this.hud.lineup, this.shown, this.decisions);
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
    this.scene.load(f.sim, f.controllers);
    this.scene.morale = this.match.morale.map((m) => m.state);
    this.renderCamBar(); // everyone is back for the new round
  }

  // ------------------------------------------------------------- beats

  private enter(b: Beat) {
    const h = this.hud;
    switch (b.kind) {
      case "level": {
        const lv = this.match.level;
        const thinking = this.live && this.waitingRound === 1 ? `<div class="lvmeta thinking">the fighters are thinking: ${this.labels?.map((l, i) => `${esc(this.match.souls[i]!.name)} (${esc(l)})`).join(" · ") ?? ""}</div>` : "";
        this.scene.overview = true;
        h.intro.innerHTML = `
          <div class="levelcard">
            <div class="kicker">ARENA ${lv.seed} · BEST OF 3</div>
            <div class="lvname">${esc(lv.name)}</div>
            <div class="lvmeta">${lv.width} m wide · ${lv.platforms} platforms · ${lv.props.length} props · ${lv.pits.length} pit${lv.pits.length === 1 ? "" : "s"} · everything breaks</div>
            ${thinking}
          </div>`;
        restart(h.intro, "show level");
        break;
      }
      case "dialogue": {
        if (this.shown !== this.match.fight) this.showFight(this.match.fight!); // fresh arena for the next round
        this.scene.overview = false;
        h.intro.className = "";
        h.callout.className = "";
        h.clock.className = "";
        this.scene.focus = { id: b.fighter, offsetX: 0.22, heightM: 8.5 };
        this.scene.blam(b.fighter);
        h.lineup.querySelector(`[data-id="${b.fighter}"]`)?.classList.add("in");
        h.dialogue.innerHTML = dialogueHtml(this.match, this.decisions[b.fighter]!, this.labels, b);
        restart(h.dialogue, "show");
        h.dialogue.querySelector(".skip")?.addEventListener("click", (e) => {
          e.stopPropagation();
          this.skipDialogue();
        });
        break;
      }
      case "countdown":
        this.scene.focus = null;
        this.scene.overview = false;
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
        this.matchScores.push(scores);
        for (const s of scores) this.matchPoints[s.fighter]! += s.total;
        saveTally(this.tally);
        const w = this.match.souls[facts.winner]!;
        const decided = this.match.over;
        h.callout.innerHTML = `<span class="small">ROUND ${facts.round} · ${res.reason === "time-out" ? "TIME!" : "LAST ONE STANDING"}</span><span style="color:${hex(w.color)}">${esc(w.name.toUpperCase())}!</span>${pipsHtml(this.match, "big")}${decided ? `<span class="small">TAKES THE MATCH</span>` : Math.max(...this.match.wins) === ROUNDS_TO_WIN - 1 && this.match.round === 2 ? `<span class="small">ONE ROUND LEFT · WINNER TAKES ALL</span>` : ""}`;
        h.callout.innerHTML += recapHtml(this.match, facts, this.plans.roundFirings, this.plans.roundKos);
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
        this.scene.focus = { id: wid, offsetX: -0.24, heightM: 8 };
        this.scene.celebrateId = wid;
        h.celebrate.innerHTML = celebrateHtml(this.match, this.tally, this.matchPoints, this.matchesPlayed);
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
    this.plans.onEvent(e, this.match, this.clock);
    if (e.type === "rule" && this.debugRules) {
      const f = this.shown.sim.fighters[e.fighter]!;
      const rule = this.match.decisions[e.fighter]?.strategy.rules?.[e.rule];
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
      this.slow = SLOW_TIME;
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
    if (this.suddenUntil > 0 && (this.clock > this.suddenUntil || beat.kind !== "fight")) {
      this.suddenUntil = 0;
      if (this.hud.callout.classList.contains("sd")) this.hud.callout.className = "";
    }
    const mode = simRuns(beat);
    if (mode !== "frozen") {
      this.acc += simDt;
      let ticks = 0;
      while (this.acc >= DT && ticks < 8) {
        this.acc -= DT;
        ticks++;
        this.scene.capturePrev();
        if (mode === "fight" && !this.shown.over) {
          this.shown.step();
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

    // per-frame HUD bits driven by beat progress (so capture stays in sync)
    if (beat.kind === "dialogue") {
      const line = this.decisions[beat.fighter]!.line;
      const typed = this.hud.dialogue.querySelector<HTMLElement>(".typed");
      const n = Math.floor(line.length * Math.min(1, Math.max(0, (this.flow.t - 0.2) / Math.min(1.6, beat.duration * 0.5))));
      if (typed && typed.textContent!.length !== n) typed.textContent = line.slice(0, n);
    }
    if (beat.kind === "go" || beat.kind === "fight") {
      const left = Math.max(0, (FIGHT_TICKS - this.shown.sim.tick) / TICK_RATE);
      const txt = `<span class="r">ROUND ${this.match.round}</span>${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, "0")}${pipsHtml(this.match, "small")}`;
      if (this.hud.clock.innerHTML !== txt) this.hud.clock.innerHTML = txt;
      this.hud.clock.className = left < 10 ? "show low" : "show";
    }
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
  }
}
