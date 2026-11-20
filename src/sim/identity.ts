/**
 * Fighter identities (#17): before each match every seat gets a generated
 * name, head shape, eye style, mark and color from the match seed. Nothing
 * about a fighter's look or name is fixed in code or in a soul file: a soul
 * is personality only.
 *
 * The identity is display data. The sim carries it on each Fighter but never
 * reads it, and it is not part of the state hash. Drawing it is the viewer's
 * job (src/viewer/bot.ts).
 *
 * Later (#19) a fighter's AI may choose its own identity: pass its wishes to
 * `assignIdentities`. Valid, unclaimed wishes are kept; the rest is generated.
 */
import { Rng } from "./rng";

/** Head shapes: Skiff's 8 Skipper bodies, then new ones. The viewer has one drawing per entry. */
export const SHAPES = [
  "squircle", "dome", "bun", "hex", "lemon", "shield", "keystone", "pebble",
  "tv", "pill", "barrel", "onion", "bell", "octagon", "gem", "cloud", "bucket", "acorn", "mushroom", "egg",
] as const;
/** Resting eye styles on the dot visor (the morale and event faces build on them). */
export const EYES = ["tall", "dots", "big", "wide", "set", "unsure", "ring", "slit", "square", "plus", "diamond", "visor"] as const;
/** Marks and accessories. */
export const MARKS = [
  "headband", "antenna", "crown", "ears", "catears", "horns", "propeller", "mohawk", "halo",
  "bolts", "beanie", "scratch", "bandage", "cape", "scarf", "bow", "sprout", "tophat",
] as const;

export type Shape = (typeof SHAPES)[number];
export type Eyes = (typeof EYES)[number];
/** "none" is only for old records: generated fighters always get a mark. */
export type Mark = (typeof MARKS)[number] | "none";

export interface Identity {
  name: string;
  shape: Shape;
  eyes: Eyes;
  mark: Mark;
  /** 0xrrggbb */
  color: number;
}

export const NAME_MAX = 12;

// ------------------------------------------------------------------ names

/** Whole names: machine and workshop words. */
const NAME_WORDS = [
  "Rivet", "Sprocket", "Widget", "Gasket", "Ratchet", "Gizmo", "Piston", "Servo", "Diode", "Socket", "Dynamo", "Gimbal",
  "Bolt", "Fuse", "Chip", "Byte", "Pixel", "Spark", "Static", "Tinker", "Crank", "Valve", "Torque", "Turbo",
  "Nugget", "Pebble", "Biscuit", "Noodle", "Pickle", "Waffle", "Muffin", "Dumpling", "Gumdrop", "Jellybean",
  "Rascal", "Bandit", "Rumble", "Scrap", "Clank", "Wobble", "Zigzag", "Bramble", "Thistle", "Cobble",
];
/** Syllable names: a start and an end ("Zap" + "ko" = "Zapko"). */
const NAME_START = [
  "Zap", "Kix", "Bop", "Zor", "Gub", "Tik", "Rom", "Vex", "Jun", "Pop", "Wiz", "Dex", "Lug", "Mox", "Nib", "Quo",
  "Rux", "Sko", "Tav", "Yip", "Zub", "Blip", "Brix", "Clod", "Dro", "Flo", "Grub", "Jax", "Klo", "Plu", "Snig", "Tro",
];
const NAME_END = ["", "o", "ko", "ix", "y", "er", "ton", "zo", "bo", "ly", "pop", "tron", "o-9", "-X", "-7", "bit", "nik", "wick"];
/** Words a name must not equal: they mean something else in a plan ("target nearest"). */
const NAME_RESERVED = new Set(["me", "you", "nearest", "weakest", "strongest", "leader", "grudge", "anyone", "enemy", "nobody", "house", "fist"]);

/** A name from the pools: a word (one in three) or a syllable name. */
export function generateName(rng: Rng): string {
  if (rng.chance(1 / 3)) return rng.pick(NAME_WORDS);
  const n = rng.pick(NAME_START) + rng.pick(NAME_END);
  return n.slice(0, NAME_MAX);
}

/** How many different names the generator can make (for the report and a test). */
export const NAME_POOL_SIZE = new Set([...NAME_WORDS, ...NAME_START.flatMap((s) => NAME_END.map((e) => (s + e).slice(0, NAME_MAX)))]).size;

/** A name an identity may carry: 2-12 letters, digits, spaces or dashes, starting with a letter. */
export function validName(n: unknown): n is string {
  return typeof n === "string" && /^[A-Za-z][A-Za-z0-9 -]{1,11}$/.test(n) && !NAME_RESERVED.has(n.toLowerCase());
}

// ------------------------------------------------------------------ colors

/** HSL (h in degrees, s and l in 0-1) to 0xrrggbb. */
export function hsl(h: number, s: number, l: number): number {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return (f(0) << 16) | (f(8) << 8) | f(4);
}

/** WCAG relative luminance of 0xrrggbb. */
export function luminance(c: number): number {
  const ch = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch((c >> 16) & 255) + 0.7152 * ch((c >> 8) & 255) + 0.0722 * ch(c & 255);
}

/** Hue in degrees (0-360) and lightness (0-1) of 0xrrggbb. */
export function hueLight(c: number): { h: number; l: number; s: number } {
  const r = ((c >> 16) & 255) / 255, g = ((c >> 8) & 255) / 255, b = (c & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, l, s: d ? d / (1 - Math.abs(2 * l - 1)) : 0 };
}

/** Fighter colors stay at least this far apart in hue (degrees) ... */
export const MIN_HUE_GAP = 50;
/** ... and bright enough to read on every (dark) theme background: contrast 3:1 or more against the lightest sky (a test checks it). */
export const MIN_LUMINANCE = 0.27;

/** A random saturated color, bright enough for the dark arenas. */
export function generateColor(rng: Rng): number {
  for (let i = 0; i < 40; i++) {
    const c = hsl(rng.range(0, 360), rng.range(0.6, 0.9), rng.range(0.52, 0.7));
    if (luminance(c) >= MIN_LUMINANCE) return c;
  }
  return 0xffd23f;
}

function hueGap(a: number, b: number): number {
  const d = Math.abs(hueLight(a).h - hueLight(b).h) % 360;
  return Math.min(d, 360 - d);
}

/** Can these colors share a match? Readable, and apart from each other. */
export function colorsApart(c: number, others: readonly number[]): boolean {
  return luminance(c) >= MIN_LUMINANCE && others.every((o) => hueGap(c, o) >= MIN_HUE_GAP);
}

// ------------------------------------------------------------------ identities

/** The identity stream: its own RNG from the match seed, so no other stream (level, lines, plans) moves. */
export function identitySeed(seed: number): number {
  return ((seed >>> 0) ^ 0x1d3e7175) >>> 0;
}

/** A wish for an identity (#19): any field may be missing or invalid. */
export type IdentityWish = Partial<Record<keyof Identity, unknown>>;

/**
 * Four distinct identities for a match. `wishes[i]` (optional) are fields seat
 * i asked for: a valid wish that no earlier seat took is kept; everything else
 * is drawn from the seed. Same seed and wishes, same identities.
 * Distinct: no two fighters share a name, shape or mark, and colors stay apart.
 */
export function assignIdentities(seed: number, wishes: readonly (IdentityWish | undefined)[] = [], n = 4): Identity[] {
  const rng = new Rng(identitySeed(seed));
  const out: Identity[] = [];
  // names must not even start alike ("Junko" and "Junwick" are hard to tell apart in a callout)
  const taken = <K extends keyof Identity>(k: K, v: Identity[K]) => out.some((o) => (k === "name" ? String(o[k]).slice(0, 3).toLowerCase() === String(v).slice(0, 3).toLowerCase() : o[k] === v));
  const draw = <T>(make: () => T, ok: (v: T) => boolean): T => {
    let v = make();
    for (let i = 0; i < 200 && !ok(v); i++) v = make();
    return v;
  };
  for (let seat = 0; seat < n; seat++) {
    const w = wishes[seat] ?? {};
    // draw every field (even wished ones), so one seat's wish never shifts the other seats' draws
    const name = draw(() => generateName(rng), (v) => validName(v) && !taken("name", v));
    const shape = draw(() => rng.pick(SHAPES), (v) => !taken("shape", v));
    const eyes = rng.pick(EYES);
    const mark = draw(() => rng.pick(MARKS), (v) => !taken("mark", v));
    const color = draw(() => generateColor(rng), (v) => colorsApart(v, out.map((o) => o.color)));
    const id: Identity = { name, shape, eyes, mark, color };
    if (validName(w.name) && !taken("name", w.name.trim())) id.name = w.name.trim();
    if ((SHAPES as readonly unknown[]).includes(w.shape) && !taken("shape", w.shape as Shape)) id.shape = w.shape as Shape;
    if ((EYES as readonly unknown[]).includes(w.eyes)) id.eyes = w.eyes as Eyes;
    if ((MARKS as readonly unknown[]).includes(w.mark) && !taken("mark", w.mark as Mark)) id.mark = w.mark as Mark;
    if (validColor(w.color) && colorsApart(w.color, out.map((o) => o.color))) id.color = w.color;
    out.push(id);
  }
  return out;
}

/** The generated identities for a match seed (no wishes). */
export function generateIdentities(seed: number): Identity[] {
  return assignIdentities(seed);
}

function validColor(c: unknown): c is number {
  return Number.isInteger(c) && (c as number) >= 0 && (c as number) <= 0xffffff;
}

/** An identity from untrusted input (a record file, the live stream): known values only. */
export function sanitizeIdentity(v: unknown, seat: number, fallback: Identity): Identity {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.replace(/[^A-Za-z0-9 '-]/g, "").trim().slice(0, 16) : "";
  return {
    name: name || fallback.name || `Fighter ${seat + 1}`,
    shape: (SHAPES as readonly unknown[]).includes(o.shape) ? (o.shape as Shape) : fallback.shape,
    eyes: (EYES as readonly unknown[]).includes(o.eyes) ? (o.eyes as Eyes) : fallback.eyes,
    mark: o.mark === "none" || (MARKS as readonly unknown[]).includes(o.mark) ? (o.mark as Mark) : fallback.mark,
    color: validColor(o.color) ? o.color : fallback.color,
  };
}

/** Head shapes for the four marks of old (version 2 and 3) records, so old matches keep a familiar look. */
const LEGACY_SHAPE: Record<string, Shape> = { headband: "keystone", antenna: "dome", ears: "bun", crown: "shield", none: "squircle" };

/**
 * Identities for an old record: its souls carried a name, a color and a mark.
 * What is missing comes from the seed.
 */
export function legacyIdentities(seed: number, souls: readonly unknown[]): Identity[] {
  const gen = generateIdentities(seed);
  const out: Identity[] = [];
  gen.forEach((g, i) => {
    const s = (souls[i] && typeof souls[i] === "object" ? souls[i] : {}) as Record<string, unknown>;
    const mark = typeof s.mark === "string" ? s.mark : undefined;
    const want = mark && LEGACY_SHAPE[mark] ? LEGACY_SHAPE[mark] : g.shape;
    const shape = out.some((o) => o.shape === want) ? g.shape : want;
    out.push(sanitizeIdentity({ name: s.name, color: s.color, mark: mark ?? g.mark, shape, eyes: "tall" }, i, g));
  });
  return out;
}

/** Cosmetic look of a seat, as the sim stores it on each Fighter. */
export type Look = Identity;
