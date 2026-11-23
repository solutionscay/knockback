// #85: the portraits (cards, chips, site, share images) are the plush brawler, self-contained SVG.
import { expect, test } from "bun:test";
import type { Identity } from "../src/sim/identity";
import { portraitSvg } from "../src/viewer/portrait";

const look: Identity = { name: "Zapko", shape: "squircle", eyes: "tall", mark: "crown", minor: "scarf", color: 0x4f8ff7 };

test("a portrait is the plush body (tint through the gradient map, fixed on top), its marks and the LED face", () => {
  const s = portraitSvg(look, "fight");
  expect(s.startsWith("<svg ")).toBe(true);
  expect(s).toContain("<filter id=");
  expect(s).toContain("feComponentTransfer");
  // body (2 layers) + crown (2) + scarf (2)
  expect(s.match(/<image /g)?.length).toBe(6);
  expect(s).toContain("data:image/png;base64,");
  // the LED dots: circles and rects from the SVG pen, inside the visor's matrix
  expect(s).toMatch(/<g transform="matrix\([^)]+\)"><(path|circle|rect)/);
});

test("filter ids are unique per portrait (many portraits share one page), and a bust crops to the head", () => {
  const a = portraitSvg(look, "win"), b = portraitSvg(look, "win");
  const id = (s: string) => /<filter id="([^"]+)"/.exec(s)![1];
  expect(id(a)).not.toBe(id(b));
  const full = /viewBox="([^"]+)"/.exec(a)![1]!.split(" ").map(Number);
  const bust = /viewBox="([^"]+)"/.exec(portraitSvg(look, "fight", "tiny"))![1]!.split(" ").map(Number);
  expect(bust[3]!).toBeLessThan(full[3]!);
});

test("a fighter with no minor mark and the cape behind: the cape comes before the body", () => {
  const s = portraitSvg({ ...look, mark: "cape", minor: "none" }, "ko");
  expect(s.match(/<image /g)?.length).toBe(4);
  const firstG = s.indexOf("<g transform"), body = s.indexOf('filter="url(#');
  expect(firstG).toBeLessThan(body);
});
