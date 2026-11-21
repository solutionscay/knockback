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
 * A fighter's AI may choose its own identity (#19, the "suit up" step in
 * src/ai/suitup.ts): its wishes go to `assignIdentities`. Valid, unclaimed
 * wishes are kept (a clashing color is nudged to the nearest free one); the
 * rest is generated. Without wishes the draws are exactly as before.
 */
import { fromOklch, luminance, oklabDistance, oklch } from "./color";
import { Rng } from "./rng";

/** Head shapes: Skiff's 8 Skipper bodies, then new ones. The viewer has one drawing per entry. */
export const SHAPES = [
  "squircle", "dome", "bun", "hex", "lemon", "shield", "keystone", "pebble",
  "tv", "pill", "barrel", "onion", "bell", "octagon", "gem", "cloud", "bucket", "acorn", "mushroom", "egg",
] as const;
/**
 * Silhouette families: shapes that read alike at game size (the visor fills
 * most of the head at 720p). A match never has two shapes of one family.
 * Shapes not listed are a family of their own.
 */
export const SHAPE_FAMILY: Partial<Record<(typeof SHAPES)[number], string>> = {
  squircle: "round", dome: "round", pill: "round", egg: "round", barrel: "round", octagon: "round",
  mushroom: "capped", acorn: "capped",
  keystone: "trapezoid", bucket: "trapezoid",
  bell: "peaked", onion: "peaked",
};
export const familyOf = (s: string) => SHAPE_FAMILY[s as (typeof SHAPES)[number]] ?? s;
/** Resting eye styles on the dot visor (the morale and event faces build on them). */
export const EYES = ["tall", "dots", "big", "wide", "set", "unsure", "ring", "slit", "square", "plus", "diamond", "visor"] as const;
/** Major marks: silhouettes that still read at 720p. Every fighter has one, and no two fighters in a match share it. */
export const MAJOR_MARKS = ["headband", "antenna", "crown", "ears", "catears", "horns", "propeller", "mohawk", "halo", "beanie", "cape", "bow", "sprout", "tophat"] as const;
/** Minor marks: details for close-ups (portraits, follow camera). Half the fighters get one, on top of their major mark; none of them touches the head's top. */
export const MINOR_MARKS = ["bolts", "scratch", "bandage", "scarf"] as const;
/** Every mark the bot renderer draws. */
export const MARKS = [...MAJOR_MARKS, ...MINOR_MARKS] as const;
/** Chance that a generated fighter gets a minor mark. */
export const MINOR_CHANCE = 0.5;

export type Shape = (typeof SHAPES)[number];
export type Eyes = (typeof EYES)[number];
/** A mark; "none" only as a minor mark (no second mark). */
export type Mark = (typeof MARKS)[number] | "none";
export type MajorMark = (typeof MAJOR_MARKS)[number];
export type MinorMark = (typeof MINOR_MARKS)[number];

export interface Identity {
  name: string;
  shape: Shape;
  eyes: Eyes;
  /** the major mark (one of MAJOR_MARKS) */
  mark: Mark;
  /** an optional minor mark; missing or "none" means no second mark */
  minor?: Mark;
  /** 0xrrggbb */
  color: number;
}

export const NAME_MAX = 12;

// ------------------------------------------------------------------ names

/** Whole names: machine and workshop words. */
const NAME_WORDS = [
  "Rivet", "Sprocket", "Widget", "Gasket", "Ratchet", "Gizmo", "Piston", "Servo", "Diode", "Socket", "Dynamo", "Gimbal",
  "Bolt", "Fuse", "Chip", "Byte", "Pixel", "Spark", "Static", "Tinker", "Crank", "Valve", "Torque", "Turbo",
  "Nugget", "Biscuit", "Noodle", "Pickle", "Waffle", "Muffin", "Dumpling", "Gumdrop", "Jellybean",
  "Rascal", "Bandit", "Rumble", "Scrap", "Clank", "Wobble", "Zigzag", "Bramble", "Thistle", "Cobble",
];
/** Syllable names: a start and an end ("Zap" + "ko" = "Zapko"). */
const NAME_START = [
  "Zap", "Kix", "Bop", "Zor", "Gub", "Tik", "Rom", "Vex", "Jun", "Pop", "Wiz", "Dex", "Lug", "Mox", "Nib", "Quo",
  "Rux", "Sko", "Tav", "Yip", "Zub", "Blip", "Brix", "Clod", "Dro", "Flo", "Grub", "Jax", "Klo", "Plu", "Snig", "Tro",
];
const NAME_END = ["", "o", "ko", "ix", "y", "er", "ton", "zo", "bo", "ly", "pop", "tron", "o-9", "-X", "-7", "bit", "nik", "wick"];
/**
 * Words a name must not equal: plan words ("target nearest"), and the pool's
 * own shape, eye and mark words (a fighter called "Pebble" on a tv head reads
 * like a label). Singular and plural both count.
 */
const NAME_RESERVED = new Set(
  ["me", "you", "nearest", "weakest", "strongest", "leader", "grudge", "anyone", "enemy", "nobody", "house", "fist", "none", ...SHAPES, ...EYES, ...MARKS].flatMap((w) => [w, w.replace(/s$/, ""), `${w}s`]),
);
/** Share of whole-word names; the rest are syllable names, which have far more variety. */
export const WORD_NAME_SHARE = 1 / 8;

/** A name from the pools: a word (one in eight) or a syllable name. */
export function generateName(rng: Rng): string {
  if (rng.chance(WORD_NAME_SHARE)) return rng.pick(NAME_WORDS);
  const n = rng.pick(NAME_START) + rng.pick(NAME_END);
  return n.slice(0, NAME_MAX);
}

/** How many different names the generator can make (for the report and a test). */
export const NAME_POOL_SIZE = new Set([...NAME_WORDS, ...NAME_START.flatMap((s) => NAME_END.map((e) => (s + e).slice(0, NAME_MAX)))].filter((n) => validName(n))).size;

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


/** Hue in degrees (0-360) and lightness (0-1) of 0xrrggbb. */
export function hueLight(c: number): { h: number; l: number; s: number } {
  const r = ((c >> 16) & 255) / 255, g = ((c >> 8) & 255) / 255, b = (c & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, l, s: d ? d / (1 - Math.abs(2 * l - 1)) : 0 };
}

/** Fighter colors in a match are at least this far apart in OKLab (perceptual, so yellow next to chartreuse counts as close) ... */
export const MIN_COLOR_DISTANCE = 0.11;
/** ... and bright enough to read on every (dark) theme background: contrast 3:1 or more against the lightest sky (a test checks it). */
export const MIN_LUMINANCE = 0.27;
const SAT: [number, number] = [0.6, 0.9];
const LIGHT_MIN = 0.52;
const LIGHT_SPAN = 0.18;
const LIGHT_CAP = 0.86;

/**
 * The lowest HSL lightness at which hue `h` and saturation `s` reach
 * MIN_LUMINANCE. Blues need a much lighter color than yellows do: a fixed
 * lightness range (the old 0.52-0.70) threw almost every blue away.
 */
export function lightnessFloor(h: number, s: number): number {
  let lo = 0, hi = 1;
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    if (luminance(hsl(h, s, mid)) >= MIN_LUMINANCE) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** A random saturated color of hue `h`: lightness from the hue's own floor up by LIGHT_SPAN. */
export function colorAtHue(rng: Rng, h: number): number {
  const s = rng.range(SAT[0], SAT[1]);
  const lo = Math.min(LIGHT_CAP - 0.04, Math.max(LIGHT_MIN, lightnessFloor(h, s) + 0.005));
  return hsl(h, s, rng.range(lo, Math.min(LIGHT_CAP, lo + LIGHT_SPAN)));
}

/** A random fighter color (any hue), bright enough for the dark arenas. */
export function generateColor(rng: Rng): number {
  return colorAtHue(rng, rng.range(0, 360));
}

/** Can this color join these colors in a match? Readable, and perceptually apart from each one. */
export function colorsApart(c: number, others: readonly number[]): boolean {
  return luminance(c) >= MIN_LUMINANCE && others.every((o) => oklabDistance(c, o) >= MIN_COLOR_DISTANCE);
}

/**
 * `count` colors for the seats that did not keep a wished color: the hues are
 * drawn together (a random start, even spacing, some jitter) and then shuffled,
 * so no seat leans toward the hues the others left over. Every color is apart
 * from the others and from the kept ones.
 */
export function drawMatchColors(rng: Rng, count: number, kept: readonly number[] = [], n = 4): number[] {
  for (let attempt = 0; attempt < 120; attempt++) {
    const start = rng.range(0, 360), step = 360 / n;
    const cand = Array.from({ length: n }, (_, i) => colorAtHue(rng, (start + i * step + rng.range(-0.22, 0.22) * step + 360) % 360));
    rng.shuffle(cand);
    const out: number[] = [];
    for (const c of cand) if (out.length < count && colorsApart(c, [...kept, ...out])) out.push(c);
    if (out.length === count) return out;
  }
  // practically never reached: one color at a time, as apart as the draws allow
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    let best = generateColor(rng), bestD = -1;
    for (let k = 0; k < 400; k++) {
      const c = generateColor(rng);
      const d = Math.min(9, ...[...kept, ...out].map((o) => oklabDistance(c, o)));
      if (d > bestD) (best = c), (bestD = d);
      if (d >= MIN_COLOR_DISTANCE) break;
    }
    out.push(best);
  }
  return out;
}

// ------------------------------------------------------------------ identities

/** The identity stream: its own RNG from the match seed, so no other stream (level, lines, plans) moves. */
export function identitySeed(seed: number): number {
  return ((seed >>> 0) ^ 0x1d3e7175) >>> 0;
}

/** A wish for an identity (#19): any field may be missing or invalid. */
export type IdentityWish = Partial<Record<keyof Identity, unknown>>;

/** What happened to one seat's wishes (#19): the fields kept, the ones replaced and why, a nudged color. */
export interface WishNote {
  kept: (keyof Identity)[];
  dropped: { field: keyof Identity; why: "invalid" | "taken" | "near-duplicate" | "unreadable" }[];
  /** the wished color clashed (or was too dark): the nearest free color was used instead */
  nudged?: { from: number; to: number };
}

/** Edit distance (names only: short strings). */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]!;
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = d[j]!;
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return d[b.length]!;
}

/**
 * Names too alike to share a match: the same first three letters (the callout rule), or a small edit
 * distance ("Gasket" / "Basket", "Rivet" / "Rivets"), case-insensitive.
 */
export function nearDuplicateName(a: string, b: string): boolean {
  const x = a.trim().toLowerCase(), y = b.trim().toLowerCase();
  if (x.slice(0, 3) === y.slice(0, 3)) return true;
  return editDistance(x, y) <= (Math.min(x.length, y.length) >= 6 ? 2 : 1);
}

/**
 * The free color nearest to a wished one (#19): readable on the dark arenas and perceptually apart from
 * `others`, searched around the wish in OKLCH (hue first, then lightness). Deterministic; null if none fits.
 */
export function nudgeColor(c: number, others: readonly number[]): number | null {
  if (colorsApart(c, others)) return c;
  const p = oklch(c);
  const C = Math.max(p.C, 0.12); // a grey wish gets some color so it can be told apart
  let best: number | null = null;
  let bestD = Infinity;
  for (let dh = 0; dh <= 180; dh += 6) {
    for (const sh of dh ? [1, -1] : [1]) {
      for (let dl = 0; dl <= 0.4; dl += 0.02) {
        for (const sl of dl ? [1, -1] : [1]) {
          const L = p.L + sl * dl;
          if (L <= 0.2 || L >= 0.97) continue;
          const cand = fromOklch({ L, C, h: p.h + (sh * dh * Math.PI) / 180 });
          if (!colorsApart(cand, others)) continue;
          const d = oklabDistance(c, cand);
          if (d < bestD) (best = cand), (bestD = d);
        }
      }
    }
    if (best !== null && bestD < (dh * Math.PI) / 180 / 4) break; // nothing nearer is left further round the circle
  }
  return best;
}

/**
 * Four distinct identities for a match. `wishes[i]` (optional) are fields seat
 * i asked for: a valid wish that no earlier seat took is kept; everything else
 * is drawn from the seed. Same seed and wishes, same identities.
 * Distinct: no two fighters share a name start, a silhouette family or a major
 * mark, and their colors are perceptually apart.
 */
export function assignIdentities(seed: number, wishes: readonly (IdentityWish | undefined)[] = [], n = 4): Identity[] {
  return assignIdentitiesDetailed(seed, wishes, n).identities;
}

/** assignIdentities, plus what happened to each seat's wishes (#19: the suit-up report). */
export function assignIdentitiesDetailed(seed: number, wishes: readonly (IdentityWish | undefined)[] = [], n = 4): { identities: Identity[]; notes: WishNote[] } {
  const rng = new Rng(identitySeed(seed));
  const out: Identity[] = [];
  const notes: WishNote[] = [];
  // names must not even start alike ("Junko" and "Junwick" are hard to tell apart in a callout)
  const nameTaken = (v: string) => out.some((o) => o.name.slice(0, 3).toLowerCase() === v.slice(0, 3).toLowerCase());
  const shapeTaken = (v: string) => out.some((o) => familyOf(o.shape) === familyOf(v));
  const markTaken = (v: string) => out.some((o) => o.mark === v);
  const draw = <T>(make: () => T, ok: (v: T) => boolean): T => {
    let v = make();
    for (let i = 0; i < 200 && !ok(v); i++) v = make();
    return v;
  };
  const is = <T extends readonly unknown[]>(list: T, v: unknown): v is T[number] => list.includes(v);
  for (let seat = 0; seat < n; seat++) {
    const w = wishes[seat] ?? {};
    const note: WishNote = { kept: [], dropped: [] };
    const keep = (field: keyof Identity, ok: boolean, why: WishNote["dropped"][number]["why"]) => {
      if (w[field] === undefined) return false;
      if (ok) note.kept.push(field);
      else note.dropped.push({ field, why });
      return ok;
    };
    // draw every field (even wished ones), so one seat's wish never shifts the other seats' draws
    const name = draw(() => generateName(rng), (v) => validName(v) && !nameTaken(v));
    const shape = draw(() => rng.pick(SHAPES), (v) => !shapeTaken(v));
    const eyes = rng.pick(EYES);
    const mark: Mark = draw(() => rng.pick(MAJOR_MARKS), (v) => !markTaken(v));
    const hasMinor = rng.chance(MINOR_CHANCE);
    const minorPick = rng.pick(MINOR_MARKS);
    const id: Identity = { name, shape, eyes, mark, minor: hasMinor ? minorPick : "none", color: 0 };
    const wn = typeof w.name === "string" ? w.name.trim() : w.name;
    if (keep("name", validName(wn) && !out.some((o) => nearDuplicateName(o.name, wn as string)), !validName(wn) ? "invalid" : nameTaken(wn as string) ? "taken" : "near-duplicate")) id.name = wn as string;
    if (keep("shape", is(SHAPES, w.shape) && !shapeTaken(w.shape as string), is(SHAPES, w.shape) ? "taken" : "invalid")) id.shape = w.shape as Shape;
    if (keep("eyes", is(EYES, w.eyes), "invalid")) id.eyes = w.eyes as Eyes;
    if (keep("mark", is(MAJOR_MARKS, w.mark) && !markTaken(w.mark as string), is(MAJOR_MARKS, w.mark) ? "taken" : "invalid")) id.mark = w.mark as Mark;
    if (keep("minor", is(MINOR_MARKS, w.minor) || w.minor === "none", "invalid")) id.minor = w.minor as Mark;
    out.push(id);
    notes.push(note);
  }
  // colors last, for the whole match at once: kept wishes first (in seat order, a clash nudged to the
  // nearest free color), then the rest together
  const kept: number[] = [];
  const keepColor = out.map((_, seat) => {
    const c = wishes[seat]?.color;
    if (c === undefined) return false;
    const note = notes[seat]!;
    if (!validColor(c)) return void note.dropped.push({ field: "color", why: "invalid" }), false;
    const to = nudgeColor(c, kept);
    if (to === null) return void note.dropped.push({ field: "color", why: luminance(c) < MIN_LUMINANCE ? "unreadable" : "taken" }), false;
    if (to !== c) note.nudged = { from: c, to };
    note.kept.push("color");
    kept.push(to);
    return true;
  });
  const drawn = drawMatchColors(rng, keepColor.filter((k) => !k).length, kept, n);
  let ki = 0, di = 0;
  out.forEach((id, seat) => (id.color = keepColor[seat] ? kept[ki++]! : drawn[di++]!));
  return { identities: out, notes };
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
    mark: (MAJOR_MARKS as readonly unknown[]).includes(o.mark) ? (o.mark as Mark) : fallback.mark,
    minor: (MINOR_MARKS as readonly unknown[]).includes(o.minor) ? (o.minor as Mark) : "none",
    color: validColor(o.color) ? o.color : fallback.color,
  };
}

/** Cosmetic look of a seat, as the sim stores it on each Fighter. */
export type Look = Identity;
