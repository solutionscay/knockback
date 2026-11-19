import { Application } from "pixi.js";
import { initPhysics } from "../sim/sim";
import { Game } from "./game";

declare global {
  interface Window {
    __kb?: {
      ready: boolean;
      advance: (dt: number, frames?: number) => void;
      newMatch: (seed: number) => void;
      state: () => { phase: string; round: number; finished: boolean; over: boolean; hash: string; moments: { time: number; kind: string; weight: number }[] };
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

const game = new Game(app, {
  round: document.getElementById("round")!,
  banner: document.getElementById("banner")!,
  recap: document.getElementById("recap")!,
});
game.loop = params.has("loop");

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
window.addEventListener("keydown", (e) => {
  if (e.key === "n" || e.key === "N") start(randomSeed());
});

const seedParam = params.get("seed");
start(seedParam !== null && seedParam !== "" ? Number(seedParam) >>> 0 : randomSeed());

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
    state: () => ({
      phase: game.phase,
      round: game.match.round,
      finished: game.finished,
      over: game.match.over,
      hash: game.match.over ? game.match.record.finalHash : "",
      moments: game.moments,
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
