// Art trial (#85, phase 2 memory): the packed plush sheets' layout is self-consistent (tools/art/plush_pack.py).
import { expect, test } from "bun:test";
import { PLUSH_LAYOUT, PLUSH_URLS } from "../src/viewer/art/plush/layout";
import { WEAPON_LIST } from "../src/sim/sim-types";

type Sheet = { n: number; size: [number, number]; frames: { trim: number[]; at: number[][] }[] };
const sheets = PLUSH_LAYOUT.sheets as unknown as Record<string, Sheet>;
// every weapon in the game (src/sim/constants.ts, fist aside) is a rendered plush weapon
const WEAPONS = ["rocket", "bat", "rifle", "shotgun", "sniper", "crossbow", "railgun", "hammer", "flamethrower", "lightning", "grenade", "mine", "grapple"];

test("every frame's trim lies in the cell, even-aligned, and its five tiles lie in the atlas", () => {
  const cell = PLUSH_LAYOUT.cell;
  for (const [name, s] of Object.entries(sheets)) {
    expect(s.size[0] % 4, name).toBe(0); // block-compressed textures need multiples of 4
    expect(s.size[1] % 4, name).toBe(0);
    expect(s.size[0]).toBeLessThanOrEqual(2048);
    expect(s.frames.length).toBe(s.n);
    for (const f of s.frames) {
      const [x, y, w, h] = f.trim as [number, number, number, number];
      expect(x % 2 + y % 2 + w % 2 + h % 2, name).toBe(0); // the half-size silhouette lines up
      expect(x >= 0 && y >= 0 && x + w <= cell && y + h <= cell, name).toBe(true);
      f.at.forEach(([ax, ay], i) => {
        const [tw, th] = i === 4 ? [w / 2, h / 2] : [w, h];
        expect(ax! + tw <= s.size[0] && ay! + th <= s.size[1], `${name} layer ${i}`).toBe(true);
      });
    }
  }
});

test("each sheet has a KTX2 and a WebP atlas, and every build has every loop's body and fist and every weapon's sleeve", () => {
  for (const name of Object.keys(sheets)) {
    const u = PLUSH_URLS[name as keyof typeof PLUSH_URLS];
    expect(String(u.ktx2)).toContain(".ktx2");
    expect(String(u.webp)).toContain(".webp");
  }
  for (const b of ["balanced", "tank", "anchor", "glass"]) {
    for (const l of ["idle", "run", "punch", "launched", "jump", "flinch", "ko", "celebrate"]) {
      expect(sheets[`${b}-body-${l}`], `${b}-body-${l}`).toBeDefined();
      expect(sheets[`${b}-fist-${l}`], `${b}-fist-${l}`).toBeDefined();
      expect(sheets[`${b}-body-${l}`]!.n).toBe(sheets[`${b}-fist-${l}`]!.n);
    }
    for (const w of WEAPONS) {
      const sl = sheets[`${b}-sleeve-${w}`];
      expect(sl, `${b}-sleeve-${w}`).toBeDefined();
      expect(sl!.n).toBe(sheets[`weapon-${w}`]!.n); // the sleeve and the weapon play the same frames
    }
  }
});

test("the weapon arm is split: one shared weapon layer per weapon (pinned at the wrist), no per-build arms", () => {
  for (const w of WEAPONS) {
    const s = sheets[`weapon-${w}`] as unknown as { frames: { wrist?: number[]; muzzle?: number[] }[] };
    expect(s, `weapon-${w}`).toBeDefined();
    for (const f of s.frames) expect(f.wrist, `weapon-${w} wrist`).toBeDefined();
    if (w !== "bat" && w !== "hammer") expect(s.frames[0]!.muzzle, `weapon-${w} muzzle`).toBeDefined();
  }
  expect(Object.keys(sheets).some((n) => n.includes("-arm-"))).toBe(false);
});

test("every weapon in the game has a plush weapon layer (all 13 are rendered)", () => {
  const game = (WEAPON_LIST as readonly string[]).filter((w) => w !== "fist");
  expect(game.length).toBe(13);
  for (const w of game) expect(sheets[`weapon-${w}`], `weapon-${w}`).toBeDefined();
  expect([...WEAPONS].sort()).toEqual([...game].sort());
});

test("the ground loops have per-foot boot sheets with sole points; minor marks and marks in motion are there", () => {
  for (const b of ["balanced", "tank", "anchor", "glass"]) {
    for (const l of ["idle", "run", "punch", "flinch"]) {
      for (const side of ["bootl", "bootr"]) {
        const s = sheets[`${b}-${side}-${l}`] as unknown as { n: number; frames: { sole?: number[] }[] };
        expect(s, `${b}-${side}-${l}`).toBeDefined();
        expect(s.n).toBe(sheets[`${b}-body-${l}`]!.n);
        for (const f of s.frames) expect(f.sole, `${b}-${side}-${l} sole`).toBeDefined();
      }
    }
  }
  for (const m of ["bolts", "scarf"]) expect(sheets[`mark-${m}`], `mark-${m}`).toBeDefined();
  for (const [m, n] of [["headband", 3], ["cape", 3], ["scarf", 3], ["propeller", 4], ["antenna", 5]] as const) expect(sheets[`mark-${m}`]!.n).toBe(n);
});
