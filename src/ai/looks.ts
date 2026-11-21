/**
 * The look options a fighter can choose from (#19 "suit up"): every head shape, eye style and mark the bot
 * renderer draws (src/sim/identity.ts), each with one line on how it reads, plus the name and palette rules.
 * One source for the AI prompt (src/ai/suitup.ts), GET /api/looks and the MCP join_lobby description.
 */
import { EYES, MAJOR_MARKS, MIN_COLOR_DISTANCE, MIN_LUMINANCE, MINOR_MARKS, NAME_MAX, SHAPES, familyOf } from "../sim/identity";

export const SHAPE_INFO: Record<(typeof SHAPES)[number], string> = {
  squircle: "a soft rounded square: friendly, classic robot",
  dome: "a tall rounded dome: calm, a bit dopey",
  bun: "a wide flat bun: squat and sturdy",
  hex: "a hexagon: hard edges, engineered, serious",
  lemon: "a lemon with two points: sour, twitchy",
  shield: "a shield, flat top and pointed chin: a knight, a guard",
  keystone: "a keystone, wide top and narrow jaw: top-heavy, bossy",
  pebble: "a lumpy pebble: humble, scrappy",
  tv: "an old box TV with a screen face: retro, a show-off",
  pill: "a tall capsule: sleek, clinical",
  barrel: "a barrel: chunky, heavy, a bruiser",
  onion: "an onion dome with a tip: fancy, theatrical",
  bell: "a bell: loud, top-narrow, rings when hit",
  octagon: "an octagon: a stop sign, stubborn",
  gem: "a cut gem: sharp, vain, precious",
  cloud: "a puffy cloud: dreamy, soft, hard to pin down",
  bucket: "an upside-down bucket: scrappy junkyard look",
  acorn: "an acorn with a cap: small but tough",
  mushroom: "a mushroom with a big cap: odd, sneaky",
  egg: "an egg: fragile-looking, innocent",
};

export const EYES_INFO: Record<(typeof EYES)[number], string> = {
  tall: "two tall bars: alert, neutral",
  dots: "two small dots: cute, simple",
  big: "big round eyes: eager, naive",
  wide: "wide ovals: surprised, open",
  set: "narrow, set low: determined",
  unsure: "uneven, one higher: nervous, quirky",
  ring: "two rings: staring, uncanny",
  slit: "thin slits: sly, cold",
  square: "square pixels: robotic, deadpan",
  plus: "two plus signs: cheerful, glitchy",
  diamond: "diamonds: sharp, flashy",
  visor: "one bar across: a soldier's visor",
};

export const MAJOR_MARK_INFO: Record<(typeof MAJOR_MARKS)[number], string> = {
  headband: "a fighter's headband with tails",
  antenna: "a single antenna with a light",
  crown: "a small crown: royalty, ego",
  ears: "round bear ears",
  catears: "pointed cat ears",
  horns: "two horns: menace",
  propeller: "a propeller cap: playful",
  mohawk: "a spiky mohawk: punk",
  halo: "a floating halo: saintly, or pretending",
  beanie: "a knit beanie: chill",
  cape: "a hero's cape",
  bow: "a big bow",
  sprout: "a sprout with two leaves: newbie, growing",
  tophat: "a top hat: a gentleman, a showman",
};

export const MINOR_MARK_INFO: Record<(typeof MINOR_MARKS)[number] | "none", string> = {
  bolts: "neck bolts",
  scratch: "a scratch across the face: a veteran",
  bandage: "a bandage: has been hit before",
  scarf: "a scarf",
  none: "no second mark",
};

export const NAME_RULES = `2-${NAME_MAX} characters: letters, digits, spaces or dashes, starting with a letter; not a plan word (nearest, weakest, leader, ...) nor a shape, eye or mark word; not close to another fighter's name (same first 3 letters, or one or two letters different)`;
export const PALETTE_RULES = `any #rrggbb that reads on a dark arena (relative luminance >= ${MIN_LUMINANCE}: bright or mid-tone, saturated colors work; dark navy, brown or grey do not) and stands apart from the other fighters' colors (OKLab distance >= ${MIN_COLOR_DISTANCE}); a clash is nudged to the nearest free color`;

/** The options as data (GET /api/looks, the MCP description). */
export function lookOptions() {
  return {
    name: NAME_RULES,
    color: PALETTE_RULES,
    shape: Object.fromEntries(SHAPES.map((s) => [s, SHAPE_INFO[s]])),
    shapeFamilies: "shapes that read alike share a family; two fighters in a match never share one: " + [...new Set(SHAPES.map(familyOf))].filter((f) => SHAPES.filter((s) => familyOf(s) === f).length > 1).map((f) => `${f} (${SHAPES.filter((s) => familyOf(s) === f).join(", ")})`).join("; "),
    eyes: Object.fromEntries(EYES.map((e) => [e, EYES_INFO[e]])),
    mark: Object.fromEntries(MAJOR_MARKS.map((m) => [m, MAJOR_MARK_INFO[m]])),
    minor: Object.fromEntries([...MINOR_MARKS, "none" as const].map((m) => [m, MINOR_MARK_INFO[m]])),
    rules: "every field is optional; an unknown id, or one another fighter took first (seat order), falls back to a random one",
  };
}

/** The options as compact text for a prompt. */
export function lookOptionsText(): string {
  const list = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `  ${k}: ${v}`).join("\n");
  return [
    `NAME: ${NAME_RULES}.`,
    `COLOR: ${PALETTE_RULES}.`,
    `SHAPE (your head):\n${list(SHAPE_INFO)}`,
    `EYES (your resting face):\n${list(EYES_INFO)}`,
    `MARK (a big silhouette on top; no two fighters share one):\n${list(MAJOR_MARK_INFO)}`,
    `MINOR (a small detail):\n${list(MINOR_MARK_INFO)}`,
  ].join("\n\n");
}
