/**
 * Viewer loop: walks the beat sequence (src/flow) and draws each beat.
 * intro x4 (BLAM) -> 3 2 1 FIGHT! -> the brawl -> end callout -> celebrate + tally.
 * The flow is data; this file only decides how each beat looks.
 */
import type { Application } from "pixi.js";
import { FlowRunner, matchBeats, simRuns, type Beat } from "../flow/beats";
import { POINTS, Tally, type FightScore } from "../flow/score";
import { DT, FIGHT_TICKS, TICK_RATE } from "../sim/constants";
import { Match, type MatchResult } from "../sim/match";
import type { SimEvent, Strategy } from "../sim/sim";
import { hex, portraitSvg } from "./portrait";
import { Scene } from "./scene";

const SLOW_TIME = 1.6;
const TALLY_KEY = "knockback.tally.v1";

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
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STANCE: Record<Strategy["stance"], string> = { rush: "RUSH", distance: "KEEP DISTANCE", cover: "TAKE COVER", item: "GRAB ITEMS" };
const TARGET: Record<Strategy["target"], string> = {
  nearest: "NEAREST",
  weakest: "WEAKEST",
  strongest: "STRONGEST",
  rocket: "ROCKET USERS",
  shotgun: "SHOTGUN USERS",
  leader: "THE LEADER",
};

export class Game {
  match!: Match;
  readonly scene: Scene;
  flow!: FlowRunner;
  tally: Tally;
  lastResult: MatchResult | null = null;
  lastScores: FightScore[] = [];
  private acc = 0;
  private hitPause = 0;
  private slow = 0;
  clock = 0;
  moments: Moment[] = [];
  /** Auto-start the next match this many seconds after the celebrate beat ends (null = wait for the button). */
  autoNext: number | null = 6;
  private idleAfter = 0;
  onNeedNewMatch: (() => void) | null = null;

  constructor(
    app: Application,
    private readonly hud: Hud,
  ) {
    this.scene = new Scene(app);
    this.tally = this.loadTally();
  }

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

  resetTally() {
    this.tally = new Tally();
    this.saveTally();
  }

  newMatch(seed: number) {
    this.match = new Match(seed);
    this.match.onEvent = (e) => this.onEvent(e);
    this.scene.load(this.match.sim, this.match.controllers);
    this.acc = 0;
    this.hitPause = 0;
    this.slow = 0;
    this.idleAfter = 0;
    this.lastResult = null;
    for (const el of Object.values(this.hud)) {
      el.className = "";
      el.innerHTML = "";
    }
    this.hud.lineup.innerHTML = this.match.sim.fighters
      .map((f) => `<div class="chip" data-id="${f.id}" style="--c:${hex(f.color)}">${portraitSvg(f.color, f.personality, this.match.strategies[f.id]!.loadout[0])}<span>${esc(f.name)}</span></div>`)
      .join("");
    this.hud.lineup.className = "show";
    this.flow = new FlowRunner(matchBeats(this.match.sim.fighters.length), (b) => this.enter(b));
  }

  // ------------------------------------------------------------- beats

  private enter(b: Beat) {
    const sim = this.match.sim;
    const h = this.hud;
    switch (b.kind) {
      case "level": {
        const lv = sim.level;
        this.scene.overview = true;
        h.intro.innerHTML = `
          <div class="levelcard">
            <div class="kicker">ARENA ${lv.seed}</div>
            <div class="lvname">${esc(lv.name)}</div>
            <div class="lvmeta">${lv.width} m wide · ${lv.platforms} platforms · ${lv.props.length} props · ${lv.pits.length} pit${lv.pits.length === 1 ? "" : "s"} · everything breaks</div>
          </div>`;
        restart(h.intro, "show level");
        break;
      }
      case "intro": {
        this.scene.overview = false;
        const f = sim.fighters[b.fighter]!;
        const s = this.match.strategies[b.fighter]!;
        this.scene.focus = { id: f.id, offsetX: 0.2, heightM: 9 };
        h.intro.innerHTML = `
          <div class="card" style="--c:${hex(f.color)}">
            <div class="portrait">${portraitSvg(f.color, f.personality, s.loadout[0])}</div>
            <div class="info">
              <div class="title">${titleOf(f.personality)}</div>
              <div class="name">${esc(f.name.toUpperCase())}</div>
              <div class="line"><span class="typed"></span><span class="caret"></span></div>
              <div class="tags"><b>${STANCE[s.stance]}</b><b>${s.loadout[0].toUpperCase()} + ${s.loadout[1].toUpperCase()}</b><b>TARGET: ${TARGET[s.target]}</b></div>
            </div>
          </div>`;
        restart(h.intro, "show");
        this.scene.blam(f.id);
        h.lineup.querySelector(`[data-id="${f.id}"]`)?.classList.add("in");
        break;
      }
      case "countdown":
        this.scene.focus = null;
        h.intro.className = "";
        h.count.innerHTML = `<span>${b.value}</span>`;
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
      case "end": {
        h.clock.className = "";
        const r = this.match.result();
        const w = sim.fighters[r.winner]!;
        h.callout.innerHTML = `<span class="small">${r.reason === "time-out" ? "TIME!" : "LAST ONE STANDING"}</span><span style="color:${hex(w.color)}">${esc(w.name.toUpperCase())}!</span>`;
        restart(h.callout, "show");
        break;
      }
      case "celebrate": {
        h.callout.className = "";
        const r = this.match.result();
        this.lastResult = r;
        this.lastScores = this.tally.add(r);
        this.saveTally();
        this.scene.focus = { id: r.winner, offsetX: -0.24, heightM: 8 };
        this.scene.celebrateId = r.winner;
        h.celebrate.innerHTML = this.celebrateHtml(r);
        restart(h.celebrate, "show");
        h.celebrate.querySelector<HTMLButtonElement>(".next")?.addEventListener("click", () => this.onNeedNewMatch?.());
        this.moments.push({ time: this.clock, kind: "celebrate", weight: 0 });
        break;
      }
    }
  }

  private celebrateHtml(r: MatchResult): string {
    const sim = this.match.sim;
    const w = sim.fighters[r.winner]!;
    const why = r.reason === "last-standing" ? "last one standing" : r.reason === "time-out" ? "most health at time-out" : "outlasted everyone";
    const best = Math.max(1, ...this.tally.points);
    const rows = this.tally
      .ranking()
      .map((id, rank) => {
        const f = sim.fighters[id]!;
        const sc = this.lastScores[id]!;
        const gained = sc.total ? `<em>+${sc.total}</em>` : `<em class="zero">+0</em>`;
        const parts = [sc.win ? `WIN +${POINTS.win}` : "", sc.kos ? `${sc.kos / POINTS.ko} KO +${sc.kos}` : ""].filter(Boolean).join(" · ");
        return `<div class="row${id === r.winner ? " champ" : ""}" style="--c:${hex(f.color)};--w:${(100 * this.tally.points[id]!) / best}%">
          <span class="rank">${rank + 1}</span><i></i><span class="name">${esc(f.name)}</span>
          <span class="bar"><span></span></span><span class="pts">${this.tally.points[id]}</span>${gained}<span class="why">${parts}</span></div>`;
      })
      .join("");
    return `
      <div class="winner" style="--c:${hex(w.color)}">
        <div class="portrait">${portraitSvg(w.color, w.personality, this.match.strategies[w.id]!.loadout[0], "win")}</div>
        <div class="big">${esc(w.name.toUpperCase())} WINS</div>
        <div class="why">${why} · ${(r.ticks / TICK_RATE).toFixed(0)} s</div>
      </div>
      <div class="board">
        <div class="head">SCOREBOARD <span>after ${this.tally.matches} match${this.tally.matches === 1 ? "" : "es"} · win ${POINTS.win} · knockout ${POINTS.ko}</span></div>
        ${rows}
        <button class="next" type="button">NEXT MATCH <span class="auto"></span></button>
      </div>`;
  }

  // ------------------------------------------------------------- events

  private onEvent(e: SimEvent) {
    this.scene.onEvent(e);
    if (e.type === "ko") {
      this.hitPause = Math.max(this.hitPause, 0.14);
      this.slow = SLOW_TIME;
      const f = this.match.sim.fighters[e.fighter]!;
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

    this.flow.update(dt, this.match.over);
    const beat = this.flow.beat;
    const mode = simRuns(beat);
    if (mode !== "frozen") {
      this.acc += simDt;
      let ticks = 0;
      while (this.acc >= DT && ticks < 8) {
        this.acc -= DT;
        ticks++;
        this.scene.capturePrev();
        if (mode === "fight" && !this.match.over) {
          this.match.step();
          const { bigHit } = this.scene.afterTick();
          if (bigHit >= 14) {
            this.hitPause = Math.max(this.hitPause, 0.045 + Math.min(0.08, (bigHit - 14) * 0.006));
            if (bigHit > 20) this.moments.push({ time: this.clock, kind: "bighit", weight: 5 });
          }
          if (this.hitPause > 0) break;
        } else {
          this.match.stepAfterglow();
          this.scene.afterTick();
        }
      }
    }

    // per-frame HUD bits driven by beat progress (so capture stays in sync)
    if (beat.kind === "intro") {
      const s = this.match.strategies[beat.fighter]!;
      const typed = this.hud.intro.querySelector<HTMLElement>(".typed");
      const n = Math.floor(s.line.length * Math.min(1, Math.max(0, (this.flow.t - 0.25) / (beat.duration * 0.55))));
      if (typed && typed.textContent!.length !== n) typed.textContent = s.line.slice(0, n);
    }
    if (beat.kind === "go" || beat.kind === "fight") {
      const left = Math.max(0, (FIGHT_TICKS - this.match.sim.tick) / TICK_RATE);
      const txt = `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, "0")}`;
      if (this.hud.clock.textContent !== txt) this.hud.clock.textContent = txt;
      this.hud.clock.className = left < 10 ? "show low" : "show";
    }
    if (this.flow.done && this.autoNext !== null) {
      this.idleAfter += dt;
      const btn = this.hud.celebrate.querySelector<HTMLElement>(".auto");
      const left = Math.ceil(this.autoNext - this.idleAfter);
      if (btn) btn.textContent = left > 0 ? `in ${left}` : "";
      if (this.idleAfter >= this.autoNext) {
        this.idleAfter = -1e9;
        this.onNeedNewMatch?.();
      }
    }

    const alpha = mode === "frozen" ? 1 : Math.min(1, this.acc / DT);
    const fxDt = mode === "frozen" ? dt : simDt;
    this.scene.render(dt, alpha, fxDt);
  }
}

function titleOf(p: string): string {
  return p === "aggressive" ? "THE BRAWLER" : p === "sniper" ? "THE SNIPER" : p === "coward" ? "THE RAT" : "THE VULTURE";
}

/** Re-trigger CSS entrance animations. */
function restart(el: HTMLElement, cls: string) {
  el.className = "";
  void el.offsetWidth;
  el.className = cls;
}
