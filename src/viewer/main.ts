import { Application } from "pixi.js";
import { checkRecordEngine, isOtherEngine, summarizeRecord } from "../sim/engine-version";
import { showOldRecord } from "./old-record";
import { initPhysics } from "../sim/sim";
import { SoundDirector } from "./audio/director";
import { AudioEngine, type LoggedCue } from "./audio/engine";
import { mountSoundControls } from "./audio/ui";
import { Game } from "./game";
import { liveStreamUrl } from "./live-url";
import { enableVideoMode, setVideoCaption, setVideoTag, TimelineLog, type Timeline } from "./video";
import { sanitizeIdentities, sanitizeRecord, sanitizeRuleset, sanitizeSouls } from "./sanitize";

declare global {
  interface Window {
    __kb?: {
      ready: boolean;
      /** step the game; render = false skips drawing (fast-forward) */
      advance: (dt: number, frames?: number, render?: boolean) => void;
      /** video mode: every beat change and the sim tick at every frame since load */
      timeline: () => Timeline;
      /** video mode: the caption box (null hides it) */
      caption: (c: { kind: "start" | "end"; title?: string; text: string } | null) => void;
      /** video mode: the "2×" tag over a sped-up quiet stretch */
      tag: (on: boolean) => void;
      newMatch: (seed: number) => void;
      loadRecord: (url: string) => Promise<void>;
      setCamera: (mode: { kind: "auto" } | { kind: "all" } | { kind: "follow"; id: number }) => void;
      state: () => { beat: string; beatIndex: number; finished: boolean; over: boolean; hash: string; tally: number[]; camera: string; alive: boolean[]; hp: number[]; round: number; wins: number[]; dialoguePhase: string; tick: number; heldSeconds: number; view: { cx: number; cy: number; s: number; shx: number; shy: number } | null; soles: ([number, number] | null)[]; items: { type: string; x: number; y: number }[]; fighters: { x: number; y: number; grounded: boolean; alive: boolean }[] };
      drainMoments: () => { time: number; kind: string; weight: number }[];
      /** sound (#12): the cues since the last call, with game time, pan and gain (scripts/sound-mix.ts renders them) */
      drainSounds: () => LoggedCue[];
      /** callouts over the fight (#10, #11): on screen now, the most ever at once, all shown so far */
      callouts: () => { visible: { kind: string; fighter: number; text: string }[]; peak: number; shown: { kind: string; fighter: number; text: string }[] };
      /** the HUD plan chip lines (plain text) */
      planChips: () => string[];
      /** the feet-contact check: one layer group's alpha as drawn this frame (base64, one byte per pixel) */
      mask: (kind: "surface" | "feet" | "bodies", except?: number) => { width: number; height: number; alpha: string };
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
// Sound (#12): generated sounds, silent until the first click or key press. A private sample pack may replace
// them: ?sounds=<manifest url> (default /sounds/manifest.json; ?sounds=off to never look for one).
const soundParam = params.get("sounds");
const manifestUrl = soundParam === "off" ? null : soundParam && (/^\/[\w./-]+\.json$/.test(soundParam) || /^https:\/\/[\w.-]+(:\d+)?\/[\w./-]+\.json$/.test(soundParam)) ? soundParam : "/sounds/manifest.json";
const audio = new AudioEngine({ capture, manifestUrl });
game.sound = new SoundDirector(audio);
audio.unlockOn(window);
mountSoundControls(audio, document.getElementById("controls"));
// After the celebrate beat the next match starts by itself; ?hold waits for the button.
game.autoNext = params.has("hold") || capture ? null : 6;
// Video mode (bun run teaser, docs/video.md): View all the whole time, no zooms, no slow motion, a clean screen.
const video = capture && params.has("video");
if (video) {
  enableVideoMode();
  game.videoMode = true;
  game.scene.camera.camMode = { kind: "all" }; // not saved: the viewer's own choice stays as it was
}
const timeline = new TimelineLog();

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

const isRecordUrl = (url: unknown): url is string => typeof url === "string" && /^\/records\/[\w.-]+\.json$/.test(url);
const viewerLabels = (labels: unknown) => Array.isArray(labels) ? labels.slice(0, 4).map((label) => String(label).slice(0, 80)) : undefined;

async function fetchRecord(url: string) {
  const raw = await (await fetch(url)).json();
  return { raw, rec: sanitizeRecord(raw) };
}

const seedParam = params.get("seed");
// only same-origin saved records: /records/<file>.json
const recordParam = params.get("record");
const recordUrl = isRecordUrl(recordParam) ? recordParam : null;
let lastRecord: string | null = recordUrl;
if (params.has("live")) {
  // Live AI match: the ai-match server streams each round's decisions.
  game.autoNext = null;
  game.onNeedNewMatch = () => {
    if (lastRecord) location.href = `/?record=${encodeURIComponent(lastRecord)}`;
  };
  const es = new EventSource(liveStreamUrl(params));
  es.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "match") {
      seedEl.textContent = `seed ${msg.seed} · live AI match`;
      const ruleset = sanitizeRuleset(msg.ruleset);
      if (!ruleset) return;
      game.newMatch(Number(msg.seed) >>> 0, { live: true, ruleset, souls: sanitizeSouls(msg.souls), identities: sanitizeIdentities(msg.identities), labels: viewerLabels(msg.labels) });
    } else if (msg.type === "decisions") game.pushDecisions(msg.round, msg.decisions, msg.meta, msg.checkinTicks);
    else if (msg.type === "control") game.pushControl(msg); // an agent dropped or came back (#22)
    else if (msg.type === "checkin") game.pushCheckin(msg.round, msg.tick, msg.leadTicks); // a mid-round check-in opened (#9)
    else if (msg.type === "planUpdate") game.pushPlanUpdate(msg.round, msg.update); // ...and an answer changed a plan (#8)
    else if (msg.type === "checkinEnd") game.pushCheckinEnd(msg.round, msg.tick);
    else if (msg.type === "checkinsDone") game.pushCheckinsDone(msg.round);
    else if (msg.type === "done") {
      lastRecord = isRecordUrl(msg.record) ? msg.record : null;
      seedEl.textContent += ` · replay: ?record=${msg.record}`;
    }
  };
} else if (recordUrl) {
  // Replay a saved match exactly (every decision from the record).
  game.autoNext = null;
  game.onNeedNewMatch = () => location.reload();
  const { raw, rec } = await fetchRecord(recordUrl);
  // a record from another engine version can't replay on this physics: show what it says instead of a divergence
  const summary = isOtherEngine(raw) ? summarizeRecord(raw) : null;
  if (summary) {
    seedEl.textContent = `seed ${summary.seed} · recorded with engine v${summary.engine}`;
    showOldRecord(summary);
  } else if (!rec) {
    // refuse clearly, on screen
    const why = raw && typeof raw === "object" && "version" in raw && raw.version !== 2 && raw.version !== 3 ? `record version ${JSON.stringify(raw.version)}; this viewer replays versions 2 and 3` : "not a Knockback match record";
    seedEl.textContent = `can't replay: ${why}`;
    const box = document.createElement("div");
    box.id = "refused";
    box.textContent = `Can't replay this record: ${why}.`;
    box.style.cssText = "position:absolute;inset:40% 10% auto;text-align:center;font:600 3vh system-ui;color:#ffb347;background:#0b0d14cc;padding:3vh;border-radius:1vh";
    document.body.appendChild(box);
    throw new Error(`can't replay: ${why}`);
  } else {
    const labels = viewerLabels(raw.labels);
    seedEl.textContent = `seed ${rec.seed} · replay`;
    game.newMatch(rec.seed, { recorded: rec, labels, control: raw.control });
  }
} else start(seedParam !== null && seedParam !== "" ? Number(seedParam) >>> 0 : randomSeed());

if (capture) {
  // Deterministic frame stepping for video capture: the page only moves when told to.
  app.ticker.stop();
  window.__kb = {
    ready: true,
    advance(dt, frames = 1, render = true) {
      for (let i = 0; i < frames; i++) {
        game.update(dt);
        if (game.flow && game.shown) timeline.record(game.flow.beat as { kind: string; value?: number; fighter?: number }, game.flow.index, game.match.round, game.shown.sim.tick);
      }
      if (render) app.renderer.render(app.stage);
    },
    timeline: () => timeline,
    caption: (c) => setVideoCaption(c),
    tag: (on) => setVideoTag(on),
    newMatch: (seed) => start(seed),
    loadRecord: async (url: string) => {
      if (!isRecordUrl(url)) throw new Error("records must be /records/<file>.json");
      const { raw, rec } = await fetchRecord(url);
      checkRecordEngine(raw);
      if (!rec) throw new Error("not a Knockback match record");
      game.newMatch(rec.seed, { recorded: rec, labels: viewerLabels(raw.labels) });
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
      camera: JSON.stringify(game.scene.camera.camMode),
      alive: game.shown.sim.fighters.map((f) => f.alive),
      hp: game.shown.sim.fighters.map((f) => f.hp),
      // for screenshot scripts: the shown fight's tick and where each fighter is (world meters, y up)
      tick: game.shown.sim.tick,
      heldSeconds: game.heldSeconds,
      view: game.scene.lastFrame,
      soles: game.scene.soles(),
      // for screenshot scripts: the pickups lying in the arena (world meters, y up)
      items: [...game.shown.sim.entities.values()].filter((e) => e.kind === "item" && !e.dead).map((e) => ({ type: e.itemType ?? "", x: e.body.translation().x, y: e.body.translation().y })),
      fighters: game.shown.sim.fighters.map((f) => (f.removed ? { x: 0, y: -99, grounded: false, alive: false } : { x: f.entity.body.translation().x, y: f.entity.body.translation().y, grounded: f.grounded, alive: f.alive })), // a removed fighter has no body any more
    }),
    callouts: () => ({
      visible: game.callouts.visible.map((c) => ({ kind: c.kind, fighter: c.fighter, text: c.text })),
      peak: game.callouts.peak,
      shown: game.callouts.shownLog.map((c) => ({ kind: c.kind, fighter: c.fighter, text: c.text })),
    }),
    // the feet-contact check: one layer group's alpha as drawn this frame (base64, one byte per pixel)
    mask: (kind: "surface" | "feet" | "bodies", except?: number) => {
      const m = game.scene.maskAlpha(kind, except);
      let s = "";
      for (let i = 0; i < m.alpha.length; i += 0x8000) s += String.fromCharCode(...m.alpha.subarray(i, i + 0x8000));
      return { width: m.width, height: m.height, alpha: btoa(s) };
    },
    planChips: () => [...document.querySelectorAll<HTMLElement>("#lineup .chip .plan")].map((e) => e.textContent ?? ""),
    drainSounds() {
      const out = audio.log!.splice(0);
      return out;
    },
    drainMoments() {
      const m = game.moments;
      game.moments = [];
      return m;
    },
  };
} else {
  app.ticker.add((t) => game.update(Math.min(0.1, t.deltaMS / 1000)));
}
