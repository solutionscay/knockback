/**
 * Viewer-side match flow: planning beat -> physics -> recap, with hit pause
 * and slow motion. Only changes *when* sim ticks run, never what they do.
 */
import type { Application } from "pixi.js";
import { DT, ROUNDS } from "../sim/constants";
import { Match, type RoundSummary } from "../sim/match";
import type { SimEvent } from "../sim/sim";
import { Scene } from "./scene";

const PLAN_TIME = 2.0;
const FIGHT_FLASH = 0.7;
const RECAP_TIME = 2.6;
const FINAL_TIME = 7;
const SLOW_TIME = 1.6;

export type ViewPhase = "planning" | "action" | "recap" | "final";

export interface Moment {
  time: number;
  kind: string;
  weight: number;
}

export interface Hud {
  round: HTMLElement;
  banner: HTMLElement;
  recap: HTMLElement;
}

const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;

export class Game {
  match!: Match;
  readonly scene: Scene;
  phase: ViewPhase = "planning";
  phaseT = 0;
  private acc = 0;
  private hitPause = 0;
  private slow = 0;
  clock = 0;
  moments: Moment[] = [];
  finished = false;
  loop = false;
  onNeedNewMatch: (() => void) | null = null;

  constructor(
    app: Application,
    private readonly hud: Hud,
  ) {
    this.scene = new Scene(app);
  }

  newMatch(seed: number) {
    this.match = new Match(seed);
    this.match.onEvent = (e) => this.onEvent(e);
    this.scene.load(this.match.sim, this.match.controllers);
    this.finished = false;
    this.acc = 0;
    this.hitPause = 0;
    this.slow = 0;
    this.hud.recap.classList.remove("show");
    this.startPlanning();
  }

  private startPlanning() {
    const orders = this.match.startRound();
    this.scene.orders = orders;
    this.scene.planT = 0;
    this.phase = "planning";
    this.phaseT = 0;
    this.hud.recap.classList.remove("show");
    this.hud.round.innerHTML = `<span class="lbl">ROUND</span> <b>${this.match.round}</b><span class="of">/${ROUNDS}</span>`;
    this.banner(`<span class="small">ROUND ${this.match.round}</span>ORDERS LOCKED`, "plan");
  }

  private banner(html: string, cls: string) {
    const b = this.hud.banner;
    b.className = "";
    void b.offsetWidth; // restart CSS animation
    b.innerHTML = html;
    b.className = `show ${cls}`;
  }

  private hideBanner() {
    this.hud.banner.className = "";
  }

  private onEvent(e: SimEvent) {
    this.scene.onEvent(e);
    if (e.type === "ko") {
      this.hitPause = Math.max(this.hitPause, 0.14);
      this.slow = SLOW_TIME;
      const f = this.match.sim.fighters[e.fighter]!;
      const p = e.cause === "ringout" ? { x: Math.max(-28, Math.min(28, e.x)), y: Math.max(-2, e.y) } : { x: e.x, y: e.y };
      if (!f.removed || e.cause === "ringout") this.scene.koPunch(p.x, p.y);
      this.moments.push({ time: this.clock, kind: e.cause === "ringout" ? "ringout" : "ko", weight: e.cause === "ringout" ? 10 : 8 });
    } else if (e.type === "explosion") {
      if (e.kind === "barrel") {
        this.hitPause = Math.max(this.hitPause, 0.05);
        const chained = e.chainFrom === "barrel";
        this.moments.push({ time: this.clock, kind: chained ? "chain" : "barrel", weight: chained ? 7 : 4 });
      }
    }
  }

  private recapHtml(s: RoundSummary): string {
    const sim = this.match.sim;
    const rows = sim.fighters
      .map((f) => {
        const ko = s.kos.find((k) => k.fighter === f.id);
        const kod = s.kos.filter((k) => k.by === f.id).length;
        const status = ko ? `<span class="out">${ko.cause === "ringout" ? "RING OUT" : ko.cause === "zone" ? "ZONED" : "K.O."}</span>` : !f.alive ? `<span class="gone">out</span>` : "";
        const dmg = Math.round(s.damage[f.id]!);
        return `<div class="row${f.alive || ko ? "" : " dim"}"><i style="background:${hex(f.color)}"></i><span class="name">${f.name}</span><span class="dmg">${dmg > 0 ? `+${dmg}` : "–"}</span><span class="kos">${kod ? "★".repeat(kod) : ""}</span>${status}</div>`;
      })
      .join("");
    return `<div class="title">ROUND ${s.round} <span>damage dealt</span></div>${rows}`;
  }

  private finalHtml(): string {
    const sim = this.match.sim;
    const w = sim.fighters[this.match.winner()]!;
    const alive = sim.alive().length;
    const why = alive === 1 ? "last one standing" : alive > 1 ? "most damage when time ran out" : "outlasted everyone";
    return `<span class="small">${why}</span><span style="color:${hex(w.color)}">${w.name.toUpperCase()} WINS</span>`;
  }

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

    this.phaseT += dt;
    switch (this.phase) {
      case "planning":
        this.scene.planT = this.phaseT / PLAN_TIME;
        if (this.phaseT >= PLAN_TIME) {
          this.phase = "action";
          this.phaseT = 0;
          this.scene.planT = -1;
          this.banner("FIGHT!", "fight");
          this.acc = 0;
        }
        break;
      case "action": {
        if (this.phaseT > FIGHT_FLASH && this.hud.banner.classList.contains("fight")) this.hideBanner();
        this.acc += simDt;
        let ticks = 0;
        while (this.acc >= DT && ticks < 8) {
          this.acc -= DT;
          ticks++;
          this.scene.capturePrev();
          const done = this.match.stepAction();
          const { bigHit } = this.scene.afterTick();
          if (bigHit >= 14) {
            this.hitPause = Math.max(this.hitPause, 0.045 + Math.min(0.08, (bigHit - 14) * 0.006));
            if (bigHit > 20) this.moments.push({ time: this.clock, kind: "bighit", weight: 5 });
          }
          if (done) {
            const s = this.match.endRound();
            this.phase = "recap";
            this.phaseT = 0;
            this.acc = 0;
            this.hud.recap.innerHTML = this.recapHtml(s);
            this.hud.recap.classList.add("show");
            if (this.match.over) {
              this.hud.recap.classList.remove("show");
              this.phase = "final";
              this.banner(this.finalHtml(), "final");
            }
            break;
          }
          if (this.hitPause > 0) break;
        }
        break;
      }
      case "recap":
        if (this.phaseT >= RECAP_TIME) this.startPlanning();
        break;
      case "final":
        if (this.phaseT >= FINAL_TIME && !this.finished) {
          this.finished = true;
          if (this.loop) this.onNeedNewMatch?.();
        }
        break;
    }
    const alpha = this.phase === "action" ? Math.min(1, this.acc / DT) : 1;
    const fxDt = this.phase === "action" ? simDt : dt;
    this.scene.render(dt, alpha, fxDt);
  }
}
