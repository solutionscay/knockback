import { Application } from "pixi.js";
import { initPhysics } from "../sim/sim";
import { Game } from "./game";

declare global {
  interface Window {
    __kb?: {
      ready: boolean;
      advance: (dt: number, frames?: number) => void;
      newMatch: (seed: number) => void;
      loadRecord: (url: string) => Promise<void>;
      setCamera: (mode: { kind: "auto" } | { kind: "all" } | { kind: "follow"; id: number }) => void;
      state: () => { beat: string; beatIndex: number; finished: boolean; over: boolean; hash: string; tally: number[]; camera: string; alive: boolean[]; hp: number[]; round: number; wins: number[]; dialoguePhase: string };
      drainMoments: () => { time: number; kind: string; weight: number }[];
    };
  }
}

const params = new URLSearchParams(location.search);
const capture = params.has("capture");
const randomSeed = () => (Math.random() * 1e9) >>> 0;

await initPhysics();
const app = new Application();
await app.init({
  background: 0x0f1424,
  resizeTo: window,
  antialias: true,
  resolution: Math.min(2, window.devicePixelRatio || 1),
  autoDensity: true,
  preference: "webgl",
});
document.getElementById("app")!.appendChild(app.canvas);
if (capture) document.body.classList.add("capture");

const el = (id: string) => document.getElementById(id)!;
const game = new Game(app, {
  clock: el("clock"),
  intro: el("intro"),
  lineup: el("lineup"),
  count: el("count"),
  callout: el("callout"),
  celebrate: el("celebrate"),
  cam: el("cam"),
  dialogue: el("dialogue"),
});
el("dialogue").addEventListener("click", () => game.advanceDialogue());
// camera bar + lineup chips: click to switch modes / follow a fighter
document.getElementById("hud")!.addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>("[data-cam],[data-follow]");
  if (!t) return;
  if (t.dataset.cam) game.setCamera({ kind: t.dataset.cam === "all" ? "all" : "auto" });
  else if (t.dataset.follow) game.toggleFollow(Number(t.dataset.follow));
});
// After the celebrate beat the next match starts by itself; ?hold waits for the button.
game.autoNext = params.has("hold") || capture ? null : 6;

const seedEl = document.getElementById("seed")!;
function start(seed: number) {
  const u = new URL(location.href);
  u.searchParams.set("seed", String(seed));
  history.replaceState(null, "", u);
  seedEl.textContent = `seed ${seed}`;
  game.newMatch(seed);
}
game.onNeedNewMatch = () => start(randomSeed());
document.getElementById("new")!.addEventListener("click", () => start(randomSeed()));
document.getElementById("reset")!.addEventListener("click", () => game.resetTally());
window.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === " " || e.key === "Enter") {
    e.preventDefault();
    game.advanceDialogue();
  }
  if (e.key === "s" || e.key === "S" || e.key === "Escape") game.skipDialogue();
  if (e.key === "a" || e.key === "A") game.setCamera({ kind: "auto" });
  if (e.key === "v" || e.key === "V") game.setCamera({ kind: "all" });
  if (e.key >= "1" && e.key <= "4") game.toggleFollow(Number(e.key) - 1);
  if (e.key === "n" || e.key === "N") start(randomSeed());
});

const seedParam = params.get("seed");
const recordUrl = params.get("record");
let lastRecord: string | null = recordUrl;
if (params.has("live")) {
  // Live AI match: the ai-match server streams each round's decisions.
  game.autoNext = null;
  game.onNeedNewMatch = () => {
    if (lastRecord) location.href = `/?record=${encodeURIComponent(lastRecord)}`;
  };
  const es = new EventSource("/api/live");
  es.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "match") {
      seedEl.textContent = `seed ${msg.seed} · live AI match`;
      game.newMatch(msg.seed, { live: true, labels: msg.labels });
    } else if (msg.type === "decisions") game.pushDecisions(msg.round, msg.decisions, msg.meta);
    else if (msg.type === "done") {
      lastRecord = msg.record;
      seedEl.textContent += ` · replay: ?record=${msg.record}`;
    }
  };
} else if (recordUrl) {
  // Replay a saved match exactly (every decision from the record).
  game.autoNext = null;
  game.onNeedNewMatch = () => location.reload();
  const rec = await (await fetch(recordUrl)).json();
  seedEl.textContent = `seed ${rec.seed} · replay`;
  game.newMatch(rec.seed, { recorded: rec, labels: rec.labels });
} else start(seedParam !== null && seedParam !== "" ? Number(seedParam) >>> 0 : randomSeed());

if (capture) {
  // Deterministic frame stepping for video capture: the page only moves when told to.
  app.ticker.stop();
  window.__kb = {
    ready: true,
    advance(dt, frames = 1) {
      for (let i = 0; i < frames; i++) game.update(dt);
      app.renderer.render(app.stage);
    },
    newMatch: (seed) => start(seed),
    loadRecord: async (url: string) => {
      const rec = await (await fetch(url)).json();
      game.newMatch(rec.seed, { recorded: rec, labels: rec.labels });
    },
    setCamera: (mode) => game.setCamera(mode),
    state: () => ({
      beat: game.flow.beat.kind,
      beatIndex: game.flow.index,
      finished: game.flow.done,
      over: game.match.over,
      hash: game.match.over ? game.match.record.rounds.map((r) => r.fight.finalHash).join(",") : "",
      round: game.match.round,
      wins: game.match.wins.slice(),
      dialoguePhase: game.flow.beat.kind === "dialogue" ? (game.flow.beat as { phase: string }).phase : "",
      tally: game.tally.points.slice(),
      camera: JSON.stringify(game.scene.camMode),
      alive: game.shown.sim.fighters.map((f) => f.alive),
      hp: game.shown.sim.fighters.map((f) => f.hp),
    }),
    drainMoments() {
      const m = game.moments;
      game.moments = [];
      return m;
    },
  };
} else {
  app.ticker.add((t) => game.update(Math.min(0.1, t.deltaMS / 1000)));
}
