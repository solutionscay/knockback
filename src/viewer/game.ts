/**
 * Viewer loop for a best-of-3 match: walks the beats (src/flow) and draws each.
 *   level card -> intro lines -> [3 2 1 FIGHT! -> round -> round result
 *   -> between-round lines]... -> celebrate + tally -> next match
 * The flow is data; this file only decides how each beat looks.
 */
import type { Application } from "pixi.js";
import { betweenBeats, betweenOrder, closingBeats, FlowRunner, introOrder, openingBeats, roundBeats, simRuns, type Beat } from "../flow/beats";
import { POINTS, Tally, type FightScore } from "../flow/score";
import { CHARACTERS } from "../sim/characters";
import { DT, FIGHT_TICKS, TICK_RATE } from "../sim/constants";
import type { Fight } from "../sim/fight";
import { Match, ROUNDS_TO_WIN, type DecisionMeta, type MatchRecord } from "../sim/match";
import type { MoraleState } from "../sim/morale";
import type { SimEvent, Strategy } from "../sim/sim";
import { VoiceSession, type Decision } from "../sim/voice";
import { hex, portraitSvg } from "./portrait";
import { Scene, type CamMode } from "./scene";

const SLOW_TIME = 1.6;
const TALLY_KEY = "knockback.tally.v1";
const CAM_KEY = "knockback.camera.v1";

export interface Moment {
  time: number;
  kind: string;
  weight: number;
}

export interface Hud {
  clock: HTMLElement;
  intro: HTMLElement;
  lineup: HTMLElement;
  count: HTMLElement;
  callout: HTMLElement;
  celebrate: HTMLElement;
  cam: HTMLElement;
  dialogue: HTMLElement;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STANCE: Record<Strategy["stance"], string> = { rush: "RUSH", distance: "KEEP DISTANCE", cover: "TAKE COVER", item: "GRAB ITEMS" };
const MOOD_LABEL: Record<MoraleState, string> = { cocky: "COCKY", confident: "CONFIDENT", rattled: "RATTLED", furious: "FURIOUS", desperate: "DESPERATE" };
const MOOD_COLOR: Record<MoraleState, string> = { cocky: "#ffd84a", confident: "#7dffa0", rattled: "#9fe0ff", furious: "#ff5a6a", desperate: "#d59bff" };

export class Game {
  match!: Match;
  /** the round currently shown (lags match.fight during a round result) */
  shown!: Fight;
  readonly scene: Scene;
  flow!: FlowRunner;
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
    this.tally = this.loadTally();
    this.scene.camMode = this.loadCamera();
    this.scene.onFollowLost = () => this.setCamera({ kind: "auto" });
  }

  // ------------------------------------------------------------- persistence + camera

  private loadTally(): Tally {
    try {
      return Tally.from(JSON.parse(sessionStorage.getItem(TALLY_KEY) ?? "null"));
    } catch {
      return new Tally();
    }
  }

  private saveTally() {
    try {
      sessionStorage.setItem(TALLY_KEY, JSON.stringify(this.tally));
    } catch {
      /* private mode etc: the tally still lives for this page */
    }
  }

  private loadCamera(): CamMode {
    try {
      const v = JSON.parse(sessionStorage.getItem(CAM_KEY) ?? "null");
      if (v?.kind === "auto") return { kind: "auto" };
      if (v?.kind === "follow" && Number.isInteger(v.id) && v.id >= 0 && v.id < 4) return { kind: "follow", id: v.id };
    } catch {
      /* ignore */
    }
    // default: everyone on screen (the operator's preference for watching)
    return { kind: "all" };
  }

  /** View-only: changes what the camera frames, never the simulation. */
  setCamera(mode: CamMode) {
    this.scene.camMode = mode;
    try {
      sessionStorage.setItem(CAM_KEY, JSON.stringify(mode));
    } catch {
      /* private mode: still works for this page */
    }
    this.renderCamBar();
  }

  toggleFollow(id: number) {
    const m = this.scene.camMode;
    if (m.kind === "follow" && m.id === id) this.setCamera({ kind: "auto" });
    else this.setCamera({ kind: "follow", id });
  }

  renderCamBar() {
    const m = this.scene.camMode;
    const sim = this.shown?.sim;
    const chips = (sim?.fighters ?? [])
      .map((f) => {
        const on = m.kind === "follow" && m.id === f.id;
        return `<button type="button" class="f${on ? " on" : ""}${f.alive ? "" : " out"}" data-follow="${f.id}" style="--c:${hex(f.color)}" title="Follow ${esc(f.name)} (${f.id + 1})"><i></i>${esc(f.name)}</button>`;
      })
      .join("");
    this.hud.cam.innerHTML = `<span class="lbl">CAMERA</span>
      <button type="button" data-cam="auto" class="${m.kind === "auto" ? "on" : ""}" title="Auto: frame the action (A)">Auto</button>
      <button type="button" data-cam="all" class="${m.kind === "all" ? "on" : ""}" title="View all fighters (V)">View all</button>
      <span class="sep"></span>${chips}`;
  }

  resetTally() {
    this.tally = new Tally();
    this.saveTally();
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
  newMatch(seed: number, opts: { recorded?: MatchRecord; live?: boolean; labels?: string[] } = {}) {
    this.match = new Match(seed, { session: this.session, recorded: opts.recorded });
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
      const preview = new Match(seed);
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
    this.startLineup();
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

  private startLineup() {
    this.hud.lineup.innerHTML = this.shown.sim.fighters
      .map((f) => `<div class="chip" data-id="${f.id}" data-follow="${f.id}" style="--c:${hex(f.color)}">${portraitSvg(f.color, f.personality, this.decisions[f.id]!.strategy.loadout[0])}<span>${esc(f.name)}</span></div>`)
      .join("");
    this.hud.lineup.className = "show";
  }

  /** Live AI match: the server sends each round's decisions as soon as the fighters have answered. */
  pushDecisions(round: number, decisions: Decision[], meta: DecisionMeta[]) {
    this.liveQueue.set(round, { decisions, meta });
    if (this.waitingRound === round) this.startLiveRound(round);
  }

  private startLiveRound(round: number) {
    const got = this.liveQueue.get(round)!;
    this.waitingRound = 0;
    this.decisions = this.match.prepareRound(got.decisions, got.meta);
    if (round === 1) {
      this.showFight(this.match.fight!);
      this.startLineup();
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
        const thinking = this.live && this.waitingRound === 1 ? `<div class="lvmeta thinking">the fighters are thinking: ${this.labels?.map((l, i) => `${esc(CHARACTERS[i]!.name)} (${esc(l)})`).join(" · ") ?? ""}</div>` : "";
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
        h.dialogue.innerHTML = this.dialogueHtml(b);
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
      case "go":
        h.count.innerHTML = `<span class="go">FIGHT!</span>`;
        restart(h.count, "show go");
        h.lineup.className = "show out";
        this.scene.addShake(0.6);
        this.acc = 0;
        break;
      case "fight":
        h.count.className = "";
        break;
      case "roundEnd": {
        h.clock.className = "";
        const facts = this.match.finishRound();
        const res = this.match.results[this.match.results.length - 1]!;
        const scores = this.tally.add(res);
        this.matchScores.push(scores);
        for (const s of scores) this.matchPoints[s.fighter]! += s.total;
        this.saveTally();
        const w = CHARACTERS[facts.winner]!;
        const decided = this.match.over;
        h.callout.innerHTML = `<span class="small">ROUND ${facts.round} · ${res.reason === "time-out" ? "TIME!" : "LAST ONE STANDING"}</span><span style="color:${hex(w.color)}">${esc(w.name.toUpperCase())}!</span>${this.pipsHtml("big")}${decided ? `<span class="small">TAKES THE MATCH</span>` : Math.max(...this.match.wins) === ROUNDS_TO_WIN - 1 && this.match.round === 2 ? `<span class="small">ONE ROUND LEFT · WINNER TAKES ALL</span>` : ""}`;
        h.callout.innerHTML += this.recapHtml(facts);
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
        h.celebrate.innerHTML = this.celebrateHtml();
        restart(h.celebrate, "show");
        h.celebrate.querySelector<HTMLButtonElement>(".next")?.addEventListener("click", () => this.onNeedNewMatch?.());
        this.moments.push({ time: this.clock, kind: "celebrate", weight: 0 });
        break;
      }
    }
  }

  private pipsHtml(size: "small" | "big"): string {
    const pips = CHARACTERS.map((c, i) => {
      const w = this.match.wins[i]!;
      const dots = Array.from({ length: ROUNDS_TO_WIN }, (_, k) => `<b class="${k < w ? "on" : ""}"></b>`).join("");
      return `<span class="pip" style="--c:${hex(c.color)}"><i></i>${size === "big" ? esc(c.name) : ""}${dots}</span>`;
    }).join("");
    return `<span class="pips pips-${size}">${pips}</span>`;
  }

  /** Short round recap: damage dealt/taken and who hurt each fighter most (from round stats). */
  private recapHtml(facts: import("../sim/morale").RoundFacts): string {
    const st = facts.stats;
    const rows = CHARACTERS.map((c, i) => {
      const dealt = st.damage[i]!.reduce((a, s, j) => a + (j === i ? 0 : s.damage), 0);
      const took = st.damage.reduce((a, row, j) => a + (j === i ? 0 : row[i]!.damage), 0);
      let worst = -1;
      for (let a = 0; a < 4; a++) if (a !== i && st.damage[a]![i]!.damage > (worst >= 0 ? st.damage[worst]![i]!.damage : 0)) worst = a;
      const w = worst >= 0 ? st.damage[worst]![i]! : null;
      const hurt = w && w.damage >= 8 ? `${esc(CHARACTERS[worst]!.name)} ${Math.round(w.damage)}${w.fromBehind * 2 >= w.hits && w.hits > 1 ? " from behind" : ""}` : "";
      return `<div class="rr" style="--c:${hex(c.color)}"><i></i><b>${esc(c.name)}</b><span>dealt ${Math.round(dealt)}</span><span>took ${Math.round(took)}</span><em>${hurt ? `hurt most by ${hurt}` : ""}</em></div>`;
    }).join("");
    return `<div class="recap">${rows}</div>`;
  }

  private dialogueHtml(b: Extract<Beat, { kind: "dialogue" }>): string {
    const c = CHARACTERS[b.fighter]!;
    const d = this.decisions[b.fighter]!;
    const m = this.match.morale[b.fighter]!;
    const s = d.strategy;
    const tgt = s.target === "grudge" && s.grudge !== undefined ? `AFTER ${CHARACTERS[s.grudge]!.name.toUpperCase()}` : `TARGET: ${s.target.toUpperCase()}`;
    const head = b.phase === "intro" ? "BEFORE ROUND 1" : `AFTER ROUND ${b.round - 1} · NEXT: ROUND ${b.round}`;
    const meta = this.match.record.rounds[b.round - 1]?.meta?.[b.fighter];
    const who = meta
      ? meta.outcome === "ok"
        ? `<span class="ai">${esc(meta.provider)} · ${(meta.ms / 1000).toFixed(1)} s</span>`
        : meta.outcome === "house"
          ? `<span class="ai">house bot</span>`
          : `<span class="ai bot">${esc(meta.provider)} · ${meta.outcome === "fallback-timeout" ? "timed out" : meta.outcome === "fallback-error" ? "error" : "bad answer"} · ${meta.aiLine ? "bot plan" : "bot line"}</span>`
      : this.labels
        ? `<span class="ai">${esc(this.labels[b.fighter]!)}</span>`
        : "";
    const lastStats = b.phase === "between" ? this.match.facts[b.round - 2]?.stats.summary[b.fighter] : undefined;
    const rt = s.retaliate === "attacker" ? "TURN ON ATTACKERS" : s.retaliate === "ignore" ? "IGNORE BACKSTABS" : "FIGHT BACK";
    return `
      <div class="panel" style="--c:${hex(c.color)}">
        <div class="portrait">${portraitSvg(c.color, c.personality, s.loadout[0], m.state)}</div>
        <div class="body">
          <div class="who"><span class="name">${esc(c.name.toUpperCase())}</span><span class="title">${esc(c.title.toUpperCase())}</span><span class="mood" style="--m:${MOOD_COLOR[m.state]}">${MOOD_LABEL[m.state]}</span>${who}</div>
          ${lastStats ? `<div class="stat">LAST ROUND · ${esc(lastStats)}</div>` : ""}
          <div class="line"><span class="typed"></span><span class="caret"></span></div>
          <div class="plan"><span class="k">${head}</span><b>${STANCE[s.stance]}</b><b>${s.loadout[0].toUpperCase()} + ${s.loadout[1].toUpperCase()}</b><b>${tgt}</b><b>${rt}</b></div>
        </div>
        <button type="button" class="skip" title="Skip the dialogue">SKIP ▸▸</button>
        <div class="hint">SPACE ▸</div>
      </div>`;
  }

  private celebrateHtml(): string {
    const m = this.match;
    const w = CHARACTERS[m.winner]!;
    const why = m.decidedBy() === "two-wins" ? `${m.wins[m.winner]} rounds to ${Math.max(...m.wins.filter((_, i) => i !== m.winner))}` : "won the deciding round";
    const best = Math.max(1, ...this.tally.points);
    const rows = this.tally
      .ranking()
      .map((id, rank) => {
        const c = CHARACTERS[id]!;
        const gained = this.matchPoints[id]!;
        const wins = m.wins[id]!;
        const kos = m.kos[id]!;
        const parts = [wins ? `${wins} ROUND${wins > 1 ? "S" : ""} +${wins * POINTS.win}` : "", kos ? `${kos} KO +${kos * POINTS.ko}` : ""].filter(Boolean).join(" · ");
        return `<div class="row${id === m.winner ? " champ" : ""}" style="--c:${hex(c.color)};--w:${(100 * this.tally.points[id]!) / best}%">
          <span class="rank">${rank + 1}</span><i></i><span class="name">${esc(c.name)}</span>
          <span class="bar"><span></span></span><span class="pts">${this.tally.points[id]}</span>${gained ? `<em>+${gained}</em>` : `<em class="zero">+0</em>`}<span class="why">${parts}</span></div>`;
      })
      .join("");
    return `
      <div class="winner" style="--c:${hex(w.color)}">
        <div class="big">${esc(w.name.toUpperCase())} WINS</div>
        <div class="why">${why} · ${m.round} rounds</div>
        ${this.pipsHtml("big")}
      </div>
      <div class="board">
        <div class="head">SCOREBOARD <span>${this.matchCount()} · round win ${POINTS.win} · knockout ${POINTS.ko}</span></div>
        ${rows}
        <button class="next" type="button">NEXT MATCH <span class="auto"></span></button>
      </div>`;
  }

  private matchesPlayed = 0;
  private matchCount(): string {
    return `${this.matchesPlayed + 1} match${this.matchesPlayed === 0 ? "" : "es"} this session`;
  }

  // ------------------------------------------------------------- events

  private onEvent(e: SimEvent) {
    this.scene.onEvent(e);
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

    // per-frame HUD bits driven by beat progress (so capture stays in sync)
    if (beat.kind === "dialogue") {
      const line = this.decisions[beat.fighter]!.line;
      const typed = this.hud.dialogue.querySelector<HTMLElement>(".typed");
      const n = Math.floor(line.length * Math.min(1, Math.max(0, (this.flow.t - 0.2) / Math.min(1.6, beat.duration * 0.5))));
      if (typed && typed.textContent!.length !== n) typed.textContent = line.slice(0, n);
    }
    if (beat.kind === "go" || beat.kind === "fight") {
      const left = Math.max(0, (FIGHT_TICKS - this.shown.sim.tick) / TICK_RATE);
      const txt = `<span class="r">ROUND ${this.match.round}</span>${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, "0")}${this.pipsHtml("small")}`;
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

/** Re-trigger CSS entrance animations. */
function restart(el: HTMLElement, cls: string) {
  el.className = "";
  void el.offsetWidth;
  el.className = cls;
}
