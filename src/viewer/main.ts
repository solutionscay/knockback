import { Application } from "pixi.js";
import { initPhysics } from "../sim/sim";
import { Game } from "./game";
import { sanitizeRecord, sanitizeSouls } from "./sanitize";

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
// only same-origin saved records: /records/<file>.json
const recordParam = params.get("record");
const recordUrl = recordParam && /^\/records\/[\w.-]+\.json$/.test(recordParam) ? recordParam : null;
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
      game.newMatch(Number(msg.seed) >>> 0, { live: true, souls: sanitizeSouls(msg.souls), labels: Array.isArray(msg.labels) ? msg.labels.slice(0, 4).map((l: unknown) => String(l).slice(0, 40)) : undefined });
    } else if (msg.type === "decisions") game.pushDecisions(msg.round, msg.decisions, msg.meta);
    else if (msg.type === "done") {
      lastRecord = typeof msg.record === "string" && /^\/records\/[\w.-]+\.json$/.test(msg.record) ? msg.record : null;
      seedEl.textContent += ` · replay: ?record=${msg.record}`;
    }
  };
} else if (recordUrl) {
  // Replay a saved match exactly (every decision from the record).
  game.autoNext = null;
  game.onNeedNewMatch = () => location.reload();
  const raw = await (await fetch(recordUrl)).json();
  const rec = sanitizeRecord(raw);
  if (!rec) {
    // refuse clearly, on screen
    const why = raw && typeof raw === "object" && "version" in raw && raw.version !== 2 && raw.version !== 3 ? `record version ${JSON.stringify(raw.version)}; this viewer replays versions 2 and 3` : "not a Knockback match record";
    seedEl.textContent = `can't replay: ${why}`;
    const box = document.createElement("div");
    box.id = "refused";
    box.textContent = `Can't replay this record: ${why}.`;
    box.style.cssText = "position:absolute;inset:40% 10% auto;text-align:center;font:600 3vh system-ui;color:#ffb347;background:#0b0d14cc;padding:3vh;border-radius:1vh";
    document.body.appendChild(box);
    throw new Error(`can't replay: ${why}`);
  }
  const labels = Array.isArray(raw.labels) ? raw.labels.slice(0, 4).map((l: unknown) => String(l).slice(0, 40)) : undefined;
  seedEl.textContent = `seed ${rec.seed} · replay`;
  game.newMatch(rec.seed, { recorded: rec, labels });
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
      if (!/^\/records\/[\w.-]+\.json$/.test(url)) throw new Error("records must be /records/<file>.json");
      const raw = await (await fetch(url)).json();
      const rec = sanitizeRecord(raw);
      if (!rec) throw new Error("not a Knockback match record");
      game.newMatch(rec.seed, { recorded: rec, labels: Array.isArray(raw.labels) ? raw.labels.slice(0, 4).map((l: unknown) => String(l).slice(0, 40)) : undefined });
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
