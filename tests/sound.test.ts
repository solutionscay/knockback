import { beforeAll, describe, expect, test } from "bun:test";
import { initPhysics, Match } from "../src/sim";
import type { SimEvent } from "../src/sim/sim-types";
import { SoundDirector } from "../src/viewer/audio/director";
import { AudioEngine, loadSettings, parseManifest, saveSettings, type LoggedCue } from "../src/viewer/audio/engine";
import { blipsFor, cueForBeat, cueForMood, cuesForEvent, explosionSound, spatial, voiceHz, type MapContext } from "../src/viewer/audio/map";
import { VoiceLimiter } from "../src/viewer/audio/mixer";
import { mixCues } from "../src/viewer/audio/offline";
import { SOUNDS } from "../src/viewer/audio/recipes";
import { recipeLength, renderRecipe } from "../src/viewer/audio/synth";

beforeAll(async () => {
  await initPhysics();
});

const ctx: MapContext = { fighterPos: (id) => ({ x: id * 2, y: 1 }) };
const ev = (e: Record<string, unknown>) => ({ tick: 100, ...e }) as unknown as SimEvent;
const one = (e: Record<string, unknown>) => cuesForEvent(ev(e), ctx).map((c) => c.sound);

describe("sound book", () => {
  test("every sound renders: finite, audible, under 2.5 s, the same every time", () => {
    for (const [name, def] of Object.entries(SOUNDS)) {
      const a = renderRecipe(def.recipe, { sampleRate: 22050, seed: 2 });
      expect(recipeLength(def.recipe)).toBeLessThan(2.5);
      let peak = 0;
      for (const s of a) {
        if (!Number.isFinite(s)) throw new Error(`${name}: not finite`);
        peak = Math.max(peak, Math.abs(s));
      }
      expect(peak, name).toBeGreaterThan(0.02);
      expect(renderRecipe(def.recipe, { sampleRate: 22050, seed: 2 })).toEqual(a);
      expect(def.max).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("event -> sound mapping", () => {
  test("explosions scale with size: small, medium, large; bigger is lower", () => {
    expect(explosionSound(1.5)).toBe("explosion.small");
    expect(explosionSound(3)).toBe("explosion.medium");
    expect(explosionSound(5)).toBe("explosion.large");
    const p = (r: number) => cuesForEvent(ev({ type: "explosion", kind: "barrel", x: 0, y: 0, radius: r, owner: -1, depth: 1, chainFrom: null }), ctx)[0]!;
    expect(p(1.5).pitch).toBeGreaterThan(p(5).pitch);
    expect(p(5).gain).toBeGreaterThanOrEqual(p(1.5).gain);
  });

  test("weapons, hits, props, arena and fighters each have their sound", () => {
    expect(one({ type: "fire", fighter: 0, weapon: "rocket", x: 0, y: 0, dx: 1, dy: 0 })).toEqual(["rocket.launch"]);
    expect(one({ type: "fire", fighter: 0, weapon: "shotgun", x: 0, y: 0, dx: 1, dy: 0 })).toEqual(["shotgun.fire"]);
    expect(one({ type: "fire", fighter: 0, weapon: "bat", x: 0, y: 0, dx: 1, dy: 0 })).toEqual([]); // the swing sounds
    expect(one({ type: "swing", fighter: 0, x: 0, y: 0, dx: 1, dy: 0, hit: true, weapon: "bat" })).toEqual(["bat.hit"]);
    expect(one({ type: "swing", fighter: 0, x: 0, y: 0, dx: 1, dy: 0, hit: false, weapon: "fist" })).toEqual(["fist.swing"]);
    expect(one({ type: "grapple", fighter: 0, x0: 0, y0: 0, x1: 3, y1: 2, hit: "terrain", target: -1 })).toEqual(["grapple.latch", "grapple.reel"]);
    expect(one({ type: "grapple", fighter: 0, x0: 0, y0: 0, x1: 3, y1: 2, hit: "none", target: -1 })).toEqual([]);
    expect(one({ type: "hit", target: 1, source: 0, damage: 20, kb: 10, x: 0, y: 0, cause: "bat", shielded: false })).toEqual(["hit.heavy"]);
    expect(one({ type: "hit", target: 1, source: 0, damage: 5, kb: 4, x: 0, y: 0, cause: "fist", shielded: false })).toEqual(["hit.light"]);
    expect(one({ type: "hit", target: 1, source: 0, damage: 5, kb: 4, x: 0, y: 0, cause: "fist", shielded: true })).toEqual(["hit.shielded"]);
    expect(one({ type: "ko", fighter: 1, cause: "ringout", by: 0, weapon: "bat", x: 40, y: -20 })).toEqual(["ringout.whoosh"]);
    expect(one({ type: "ko", fighter: 1, cause: "hp", by: 0, weapon: "bat", x: 0, y: 0 })).toEqual(["ko"]);
    expect(one({ type: "break", entity: 5, kind: "glass", x: 0, y: 0, hw: 0.5, hh: 0.5 })).toEqual(["glass.break"]);
    expect(one({ type: "break", entity: 5, kind: "crate", x: 0, y: 0, hw: 0.5, hh: 0.5 })).toEqual(["wood.break"]);
    expect(one({ type: "break", entity: 5, kind: "barrel", x: 0, y: 0, hw: 0.4, hh: 0.5 })).toEqual([]); // it explodes
    expect(one({ type: "pickup", fighter: 0, item: "shotgun", x: 0, y: 0 })).toEqual(["pickup.weapon"]);
    expect(one({ type: "pickup", fighter: 0, item: "shield", x: 0, y: 0 })).toEqual(["pickup.power"]);
    expect(one({ type: "shieldPop", fighter: 0, x: 0, y: 0 })).toEqual(["shield.pop"]);
    expect(one({ type: "chainBreak", chain: 2, x: 0, y: 5, cause: "explosion", by: 1 })).toEqual(["chain.snap"]);
    expect(one({ type: "platformSwing", entity: 9, chain: 2, x: 0, y: 5 })).toEqual(["platform.creak"]);
    expect(one({ type: "platformFall", entity: 9, x: 0, y: 5, by: 1 })).toEqual(["platform.creak"]);
    expect(one({ type: "suddenDeath", quietTicks: 600 })).toEqual(["suddenDeath.siren"]);
    expect(one({ type: "rule", fighter: 0, rule: 0, on: true, subject: -1 })).toEqual([]);
  });

  test("hooks for jetpack and fire events that are not in the sim yet", () => {
    expect(one({ type: "jetpack", fighter: 2 })).toEqual(["jetpack.hiss"]);
    expect(cuesForEvent(ev({ type: "jetpack", fighter: 2 }), ctx)[0]!.x).toBe(4);
    expect(one({ type: "flame", x: 1, y: 2 })).toEqual(["flame.whoosh"]);
    expect(one({ type: "burn", x: 1, y: 2 })).toEqual(["fire.crackle"]);
    expect(one({ type: "nothing-like-this" })).toEqual([]);
  });

  test("a whole match: every event maps to known sounds; the main event types all sound", () => {
    const m = new Match(5);
    const sounds = new Set<string>();
    const types = new Set<string>();
    m.onEvent = (e) => {
      types.add(e.type);
      for (const c of cuesForEvent(e, ctx)) {
        expect(SOUNDS[c.sound], c.sound).toBeDefined();
        expect(Number.isFinite(c.gain) && c.gain > 0).toBe(true);
        sounds.add(c.sound);
      }
    };
    m.playToEnd();
    for (const s of ["hit.light", "ko"]) expect(sounds.has(s) || sounds.has("ringout.whoosh"), s).toBe(true);
    expect([...sounds].some((s) => s.startsWith("explosion."))).toBe(true);
    expect(types.size).toBeGreaterThan(8);
  });

  test("show sounds: countdown, FIGHT!, round end, the win; moods beep", () => {
    expect(cueForBeat({ kind: "countdown", value: 3 })!.sound).toBe("countdown.tick");
    expect(cueForBeat({ kind: "countdown", value: 1 })!.pitch).toBeGreaterThan(cueForBeat({ kind: "countdown", value: 3 })!.pitch);
    expect(cueForBeat({ kind: "go" })!.sound).toBe("countdown.go");
    expect(cueForBeat({ kind: "roundEnd" })!.sound).toBe("round.end");
    expect(cueForBeat({ kind: "celebrate" })!.sound).toBe("win.jingle");
    expect(cueForBeat({ kind: "fight" })).toBeNull();
    expect(cueForMood("furious", 0, 0, 440, 1)!.sound).toBe("mood.angry");
    expect(cueForMood("hit", 0, 0, 440, 1)).toBeNull(); // hits have their own sound
  });

  test("dialogue blips: a voice per bot from its identity, every other letter, no spaces", () => {
    const ids = new Match(77).identities;
    const voices = ids.map(voiceHz);
    expect(new Set(voices).size).toBeGreaterThanOrEqual(3);
    expect(voiceHz(ids[0]!)).toBe(voiceHz({ ...ids[0]! })); // stable
    const b = blipsFor("Hi there, snack!", 0, 16, 300);
    expect(b.length).toBeGreaterThan(3);
    expect(b.length).toBeLessThanOrEqual(8);
    expect(b.every((c) => c.sound === "blip")).toBe(true);
    expect(blipsFor("   ", 0, 3, 300)).toEqual([]);
  });

  test("spatial: centered is full and in the middle; across the view pans; far off screen is quieter", () => {
    const l = { cx: 0, cy: 5, s: 40, w: 1920, h: 1080 };
    expect(spatial(0, 5, l)).toEqual({ pan: 0, gain: 1 });
    expect(spatial(24, 5, l).pan).toBeCloseTo(0.75);
    expect(spatial(-24, 5, l).pan).toBeCloseTo(-0.75);
    expect(spatial(10, 5, l).gain).toBe(1);
    expect(spatial(24 + 48, 5, l).gain).toBeLessThan(0.5);
    expect(spatial(undefined, undefined, l)).toEqual({ pan: 0, gain: 1 });
    expect(spatial(3, 3, null)).toEqual({ pan: 0, gain: 1 });
  });
});

describe("director", () => {
  test("mood beeps only for real mood changes: a hit flash in between is not a change", () => {
    const engine = new AudioEngine({ capture: true });
    const d = new SoundDirector(engine);
    const who = { name: "Floko", shape: "dome", color: 0x44d06a };
    const seq = ["confident", "furious", "hit", "white", "furious", "stun", "furious", "hit", "furious", "rattled", "ko"];
    seq.forEach((m, i) => d.mood(0, m, 0, 0, who, i * 20, i * 0.5));
    // confident (first face: silent) -> furious (beep) -> flashes -> furious (silent) -> stun (its beep) -> furious
    // (silent: the same lasting mood) -> rattled (beep) -> ko (silent)
    expect(engine.log!.map((c) => c.sound)).toEqual(["mood.angry", "mood.stun", "mood.down"]);
  });

  test("weapon swaps are silent (AI fighters swap several times a second)", () => {
    expect(one({ type: "swap", fighter: 0, weapon: "bat" })).toEqual([]);
  });

  test("capture mode logs cues with game time, pan and gain instead of playing them", () => {
    const engine = new AudioEngine({ capture: true });
    engine.listener = { cx: 0, cy: 5, s: 40, w: 1920, h: 1080 };
    engine.play({ sound: "shotgun.fire", x: 12, y: 5, gain: 1, pitch: 1, seed: 3 }, 12.5);
    expect(engine.log).toEqual([{ t: 12.5, sound: "shotgun.fire", gain: 1, pan: 0.375, pitch: 1, seed: 3 }]);
  });
});

describe("voice limiting", () => {
  test("20 explosions at once: one plays (the rest are the same boom)", () => {
    const v = new VoiceLimiter();
    const ok = Array.from({ length: 20 }, () => v.admit("explosion.large", 1, 1.6).ok).filter(Boolean).length;
    expect(ok).toBe(1);
    expect(v.dropped.gap).toBe(19);
  });

  test("20 explosions over a second: never more than 4 at once, each later one steals the oldest", () => {
    const v = new VoiceLimiter();
    let most = 0;
    for (let i = 0; i < 20; i++) {
      const a = v.admit(i % 2 ? "explosion.medium" : "explosion.large", i * 0.05, 1.6);
      expect(a.ok).toBe(true);
      most = Math.max(most, v.active.filter((x) => x.group === "explosion").length);
    }
    expect(most).toBe(4);
  });

  test("stacked voices of a group get quieter (1/sqrt(n))", () => {
    const v = new VoiceLimiter();
    const g = [0, 0.1, 0.2].map((t) => (v.admit("explosion.small", t, 1) as { gain: number }).gain);
    expect(g[0]).toBe(1);
    expect(g[2]).toBeCloseTo(1 / Math.sqrt(3));
  });

  test("a full mix keeps the important sounds: low priority is dropped, high takes a low one's place", () => {
    const v = new VoiceLimiter(4);
    for (let i = 0; i < 4; i++) expect(v.admit(["ko", "ringout.whoosh", "countdown.go", "win.jingle"][i]!, i * 0.1, 5).ok).toBe(true);
    expect(v.admit("jump", 0.5, 0.1)).toEqual({ ok: false, reason: "full" });
    const v2 = new VoiceLimiter(3);
    v2.admit("land", 0, 5);
    v2.admit("jump", 0.1, 5);
    v2.admit("swap", 0.2, 5);
    const a = v2.admit("explosion.large", 0.3, 1);
    expect(a.ok && a.stop.length).toBe(1);
  });

  test("unknown sounds are ignored; ended voices free their place", () => {
    const v = new VoiceLimiter(1);
    expect(v.admit("no.such.sound", 0, 1).ok).toBe(false);
    expect(v.admit("ko", 0, 0.5).ok).toBe(true);
    expect(v.admit("ko", 1, 0.5).ok).toBe(true); // the first ended at 0.5
  });
});

describe("offline mix (videos)", () => {
  test("20 explosions in a second plus hits: loud, but never past full scale", () => {
    const cues: LoggedCue[] = [];
    for (let i = 0; i < 20; i++) cues.push({ t: i * 0.05, sound: "explosion.large", gain: 1, pan: (i % 5) / 2.5 - 0.8, pitch: 0.8, seed: i });
    for (let i = 0; i < 30; i++) cues.push({ t: i * 0.033, sound: "hit.heavy", gain: 1, pan: 0, pitch: 1, seed: i });
    for (let i = 0; i < 6; i++) cues.push({ t: 0.5, sound: "explosion.medium", gain: 1, pan: 0, pitch: 1, seed: 40 + i }); // a chain in one tick
    const m = mixCues(cues, { sampleRate: 16000 });
    expect(m.peak).toBeLessThan(0.95);
    expect(m.peak).toBeGreaterThan(0.3);
    expect(m.dropped).toBeGreaterThan(0);
  });

  test("the same log mixes to the same samples", () => {
    const cues: LoggedCue[] = [{ t: 0.1, sound: "shotgun.fire", gain: 1, pan: 0.3, pitch: 1, seed: 4 }];
    expect(mixCues(cues, { sampleRate: 8000 }).left).toEqual(mixCues(cues, { sampleRate: 8000 }).left);
  });
});

describe("sample pack and settings", () => {
  test("manifest: known names only, files inside the manifest's folder, sound files only", () => {
    const m = parseManifest(
      {
        version: 1,
        sounds: {
          "explosion.large": "boom.ogg",
          "glass.break": ["g1.wav", "sub/g2.mp3"],
          "shotgun.fire": { files: ["sg.mp3"], gain: 0.8 },
          "not.a.sound": "x.ogg",
          "ko": "../secret.ogg",
          "zap": "evil.js",
        },
      },
      "/sounds/manifest.json",
      "http://localhost:5173/",
    );
    expect([...m.keys()].sort()).toEqual(["explosion.large", "glass.break", "shotgun.fire"]);
    expect(m.get("glass.break")!.urls).toEqual(["http://localhost:5173/sounds/g1.wav", "http://localhost:5173/sounds/sub/g2.mp3"]);
    expect(m.get("shotgun.fire")!.gain).toBe(0.8);
    expect(parseManifest(null, "/sounds/manifest.json", "http://localhost/").size).toBe(0);
  });

  test("settings are remembered; junk falls back to the defaults", () => {
    const store = new Map<string, string>();
    const s = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(loadSettings(s)).toEqual({ muted: false, volume: 0.7 });
    saveSettings({ muted: true, volume: 0.25 }, s);
    expect(loadSettings(s)).toEqual({ muted: true, volume: 0.25 });
    store.set("knockback.sound", "{not json");
    expect(loadSettings(s)).toEqual({ muted: false, volume: 0.7 });
    store.set("knockback.sound", JSON.stringify({ muted: "yes", volume: 7 }));
    expect(loadSettings(s)).toEqual({ muted: false, volume: 0.7 });
  });
});
