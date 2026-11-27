/**
 * The audio engine: plays cues with WebAudio.
 * - Silent until the first user gesture (browser autoplay policy): the AudioContext is made on the first
 *   pointer, key or touch event.
 * - Generated sounds by default (recipes.ts, rendered once per pitch/variant and cached).
 * - An optional private sample pack replaces sounds by name: a manifest named by ?sounds=<url> (no default: the
 *   pack is never committed and the match server does not serve one). See packManifestUrl and parseManifest.
 * - Pan and volume from the camera (map.ts spatial), voice limiting (mixer.ts), then a compressor and a limiter.
 * - Capture mode: nothing plays; every cue is logged with its game time, pan and gain, so a video render can mix
 *   the audio afterwards with the same synthesis (scripts/sound-mix.ts).
 */
import { spatial, type Cue, type Listener } from "./map";
import { VoiceLimiter } from "./mixer";
import { SOUNDS } from "./recipes";
import { recipeLength, renderRecipe } from "./synth";

export interface SoundSettings {
  muted: boolean;
  /** 0..1 */
  volume: number;
}

const KEY = "knockback.sound";
export const DEFAULT_SETTINGS: SoundSettings = { muted: false, volume: 0.7 };

export function loadSettings(storage: Pick<Storage, "getItem"> | null = typeof localStorage !== "undefined" ? localStorage : null): SoundSettings {
  try {
    const raw = JSON.parse(storage?.getItem(KEY) ?? "null");
    // sound is on by default on every page: only the volume is remembered, a mute lasts for the page
    if (raw && typeof raw === "object") return { muted: false, volume: typeof raw.volume === "number" && raw.volume >= 0 && raw.volume <= 1 ? raw.volume : DEFAULT_SETTINGS.volume };
  } catch {
    /* bad JSON: defaults */
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: SoundSettings, storage: Pick<Storage, "setItem"> | null = typeof localStorage !== "undefined" ? localStorage : null) {
  try {
    storage?.setItem(KEY, JSON.stringify({ volume: s.volume }));
  } catch {
    /* private mode: not remembered */
  }
}

/**
 * The sample pack manifest URL from the ?sounds= parameter, or null (no pack, no request). A same-site path (not
 * "//host/...", which is another site) or an https URL, ending in .json; anything else is ignored.
 */
export function packManifestUrl(param: string | null): string | null {
  if (!param) return null;
  return /^\/(?!\/)[\w./-]+\.json$/.test(param) || /^https:\/\/[\w.-]+(:\d+)?\/[\w./-]+\.json$/.test(param) ? param : null;
}

/** A sample pack entry: one or more files (picked by the cue's seed) and a gain. */
export interface PackSound {
  urls: string[];
  gain: number;
}

/**
 * Read a sample pack manifest:
 *   { "version": 1, "sounds": { "explosion.large": "boom.ogg", "glass.break": ["g1.wav", "g2.wav"],
 *                                "shotgun.fire": { "files": ["sg.mp3"], "gain": 0.8 } } }
 * Names must be sound book names; file paths are relative to the manifest and may not leave its folder.
 */
export function parseManifest(raw: unknown, manifestUrl: string, base = typeof location !== "undefined" ? location.href : "http://localhost/"): Map<string, PackSound> {
  const out = new Map<string, PackSound>();
  const sounds = raw && typeof raw === "object" ? (raw as { sounds?: unknown }).sounds : null;
  if (!sounds || typeof sounds !== "object") return out;
  const dir = new URL(".", new URL(manifestUrl, base));
  for (const [name, v] of Object.entries(sounds as Record<string, unknown>)) {
    if (!SOUNDS[name]) continue;
    const files = typeof v === "string" ? [v] : Array.isArray(v) ? v : v && typeof v === "object" && Array.isArray((v as { files?: unknown }).files) ? (v as { files: unknown[] }).files : [];
    const gain = v && typeof v === "object" && !Array.isArray(v) && typeof (v as { gain?: unknown }).gain === "number" ? Math.max(0, Math.min(2, (v as { gain: number }).gain)) : 1;
    const urls = files
      .filter((f): f is string => typeof f === "string" && /^[\w./ &()-]+\.(ogg|mp3|wav|m4a|flac|webm)$/i.test(f) && !f.split("/").includes(".."))
      .map((f) => new URL(f.split("/").map(encodeURIComponent).join("/"), dir).href)
      .filter((u) => u.startsWith(dir.href));
    if (urls.length) out.set(name, { urls: urls.slice(0, 8), gain });
  }
  return out;
}

/** A cue as the capture log keeps it: game time, after spatial pan and gain. */
export interface LoggedCue {
  t: number;
  sound: string;
  gain: number;
  pan: number;
  pitch: number;
  seed: number;
}

export class AudioEngine {
  settings: SoundSettings;
  /** the camera, for pan and distance (set every frame) */
  listener: Listener | null = null;
  /** capture mode: cues collected here instead of played */
  readonly log: LoggedCue[] | null;
  readonly limiter = new VoiceLimiter();
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private bus: AudioNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private pack = new Map<string, PackSound & { buffers: (AudioBuffer | null)[] }>();
  private sources = new Map<number, AudioBufferSourceNode>();
  onChange: (() => void) | null = null;

  constructor(opts: { capture?: boolean; manifestUrl?: string | null } = {}) {
    this.settings = loadSettings();
    this.log = opts.capture ? [] : null;
    this.manifestUrl = opts.manifestUrl ?? null;
  }

  private manifestUrl: string | null;

  /** audio is playing: the browser let the context run (a gesture on this site, or the site already allowed) */
  get unlocked() {
    return !!this.ctx && this.ctx.state === "running";
  }
  /** when audio was unlocked (ms, Date.now); the click that unlocked it is not also a mute click */
  unlockedAt = 0;
  get samplePack() {
    return this.pack.size;
  }

  /**
   * Start audio at once (browsers allow it once the person has used the site) and again on each gesture until it
   * runs: sound is on by default.
   */
  unlockOn(target: Pick<Window, "addEventListener" | "removeEventListener">) {
    if (this.log) return;
    const go = () => {
      this.unlock();
      if (this.unlocked) for (const ev of ["pointerdown", "keydown", "touchstart"]) target.removeEventListener(ev, go, true);
    };
    for (const ev of ["pointerdown", "keydown", "touchstart"]) target.addEventListener(ev, go, true);
    this.unlock();
  }

  unlock() {
    if (this.log || typeof AudioContext === "undefined") return;
    if (this.ctx) {
      if (this.ctx.state !== "running") void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext({ latencyHint: "interactive" });
    ctx.onstatechange = () => {
      if (ctx.state === "running") this.unlockedAt = Date.now();
      this.onChange?.();
    };
    const master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 10;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    const limit = ctx.createDynamicsCompressor();
    limit.threshold.value = -2;
    limit.knee.value = 0;
    limit.ratio.value = 20;
    limit.attack.value = 0.001;
    limit.release.value = 0.1;
    comp.connect(limit).connect(master).connect(ctx.destination);
    this.ctx = ctx;
    if (ctx.state === "running") this.unlockedAt = Date.now();
    this.master = master;
    this.bus = comp;
    this.applyVolume();
    void ctx.resume();
    void this.loadPack();
    this.onChange?.();
  }

  setSettings(s: Partial<SoundSettings>) {
    this.settings = { ...this.settings, ...s };
    saveSettings(this.settings);
    this.applyVolume();
    this.onChange?.();
  }

  private applyVolume() {
    if (!this.master || !this.ctx) return;
    const v = this.settings.muted ? 0 : this.settings.volume * this.settings.volume; // perceptual curve
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  private async loadPack() {
    if (!this.manifestUrl || !this.ctx) return;
    try {
      const res = await fetch(this.manifestUrl, { cache: "no-cache" });
      if (!res.ok) return; // no pack: generated sounds
      const parsed = parseManifest(await res.json(), this.manifestUrl);
      const ctx = this.ctx;
      await Promise.all(
        [...parsed].map(async ([name, p]) => {
          const buffers = await Promise.all(
            p.urls.map(async (u) => {
              try {
                return await ctx.decodeAudioData(await (await fetch(u)).arrayBuffer());
              } catch {
                return null;
              }
            }),
          );
          if (buffers.some(Boolean)) this.pack.set(name, { ...p, buffers });
        }),
      );
      if (this.pack.size) console.info(`[sound] sample pack: ${this.pack.size} sounds from ${this.manifestUrl}`);
      this.onChange?.();
    } catch {
      /* unreachable or bad manifest: generated sounds */
    }
  }

  /** A generated sound's buffer for this pitch and variant (cached). */
  private synthBuffer(c: Cue): AudioBuffer {
    const pitch = Math.round(c.pitch * 50) / 50;
    const variant = c.seed % 3;
    const key = `${c.sound}|${pitch}|${variant}`;
    let b = this.buffers.get(key);
    if (!b) {
      const ctx = this.ctx!;
      const data = renderRecipe(SOUNDS[c.sound]!.recipe, { pitch, seed: variant + 1, sampleRate: ctx.sampleRate });
      b = ctx.createBuffer(1, data.length, ctx.sampleRate);
      b.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
      if (this.buffers.size > 400) this.buffers.clear();
      this.buffers.set(key, b);
    }
    return b;
  }

  /** Play (or, in capture mode, log) a cue. `clock` = game time in seconds, used by the capture log. */
  play(c: Cue, clock: number) {
    const def = SOUNDS[c.sound];
    if (!def) return;
    const sp = spatial(c.x, c.y, this.listener);
    const gain = c.gain * sp.gain;
    if (gain < 0.02) return; // far off screen: not worth a voice
    if (this.log) {
      this.log.push({ t: +clock.toFixed(4), sound: c.sound, gain: +gain.toFixed(3), pan: +sp.pan.toFixed(3), pitch: +c.pitch.toFixed(3), seed: c.seed });
      return;
    }
    const ctx = this.ctx;
    if (!ctx || !this.bus || this.settings.muted) return;
    const fromPack = this.pack.get(c.sound);
    const packBuf = fromPack ? fromPack.buffers.filter(Boolean)[c.seed % fromPack.buffers.filter(Boolean).length] : null;
    const buf = packBuf ?? this.synthBuffer(c);
    const rate = packBuf ? c.pitch : 1; // a generated buffer already has its pitch
    const a = this.limiter.admit(c.sound, ctx.currentTime, buf.duration / rate);
    if (!a.ok) return;
    for (const v of a.stop) {
      try {
        this.sources.get(v.id)?.stop();
      } catch {
        /* already ended */
      }
      this.sources.delete(v.id);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain * a.gain * (fromPack && packBuf ? fromPack.gain : 1);
    const pan = ctx.createStereoPanner();
    pan.pan.value = sp.pan;
    src.connect(g).connect(pan).connect(this.bus);
    src.onended = () => this.sources.delete(a.voice.id);
    this.sources.set(a.voice.id, src);
    src.start();
  }

  /** Length of a generated sound (seconds; pitch changes its frequencies, not its length). */
  static lengthOf(sound: string): number {
    const def = SOUNDS[sound];
    return def ? recipeLength(def.recipe) : 0;
  }
}
