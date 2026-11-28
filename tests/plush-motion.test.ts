// Art trial (#85): the plush marks in motion pick their frames sensibly.
import { expect, test } from "bun:test";
import { markFrame } from "../src/art/plush-motion";

test("flapping marks ping-pong through their frames, faster at a run", () => {
  const seq = Array.from({ length: 8 }, (_, i) => markFrame("cape", 3, i / 5, 0, 0));
  expect(seq).toEqual([0, 1, 2, 1, 0, 1, 2, 1]);
  const still = new Set(Array.from({ length: 10 }, (_, i) => markFrame("headband", 3, i * 0.02, 0, 0))).size;
  const running = new Set(Array.from({ length: 10 }, (_, i) => markFrame("headband", 3, i * 0.02, 6, 0))).size;
  expect(running).toBeGreaterThanOrEqual(still);
});

test("the propeller spins through every frame; the antenna follows its spring; one-frame marks stay put", () => {
  expect(new Set(Array.from({ length: 16 }, (_, i) => markFrame("propeller", 4, i / 16, 0, 0))).size).toBe(4);
  expect(markFrame("antenna", 5, 0, 0, 0)).toBe(2);
  expect(markFrame("antenna", 5, 0, 0, -1)).toBe(0);
  expect(markFrame("antenna", 5, 0, 0, 1)).toBe(4);
  expect(markFrame("crown", 1, 3.3, 5, 0.7)).toBe(0);
});
