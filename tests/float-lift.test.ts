// #177: the floating-number overlap lift ended in an endless loop on one frame of a real replay (LAN Arena round
// 5800, rooftop, frame 3465 at 1920x1080). These are that frame's exact numbers: on the old code an exact push
// landed a rounding error short, the next push was too small to change lift, and the loop never ended.
import { expect, test } from "bun:test";
import { SceneEffects } from "../src/viewer/scene-effects";
import type { CameraFrame } from "../src/viewer/scene-camera";

const fakeText = () => ({ destroy() {}, alpha: 1, scale: { set() {} }, position: { set() {} } });
const W = 1920, H = 1080, ui = 1;
const frame = { cx: 3.489800855967854, cy: 5.616274759017963, s: 72.61259744236533 } as CameraFrame;
const size = { w: 29.677734375, h: 44.486328125 };
const young = (x: number, y: number, scale: number, lift: number) => ({ t: fakeText(), x, y, life: 0.666666666666666, max: 0.9, vy: 2.2, scale, ...size, lift });

test("the float lift ends on the round 5800 frame and clears the floats below", () => {
  const below = [young(-3.4199180603027344, 2.8529775269826247, 0.9, 0), young(-3.4199986457824707, 3.0531917460759477, 1.25, 37.89295291496803)];
  // the new float counts its lift writes: one per push; the old code wrote it forever, so stop it at 1000
  let lift: number | null = null;
  let writes = 0;
  const ft = { t: fakeText(), x: -3.419975757598877, y: 2.5764592758814495, life: 0.8833333333333333, max: 0.9, vy: 2.2, scale: 1.25, ...size } as Record<string, unknown>;
  Object.defineProperty(ft, "lift", {
    enumerable: true,
    get: () => lift,
    set: (v: number | null) => {
      if (++writes > 1000) throw new Error(`the lift loop did not end (${writes} writes, lift ${lift})`);
      lift = v;
    },
  });
  const fx = new SceneEffects();
  (fx as unknown as { floats: unknown[] }).floats = [...below, ft];
  fx.render(frame, W, H, 0, ui); // dt 0: the numbers stay exactly as they were on that frame

  // 1 write to start at 0, 1 push per float below, then a pass that moves nothing (not stopped by the 32-pass cap)
  expect(writes).toBeLessThanOrEqual(3);
  // the new float sits clear of both: its gap to each is at least half their two heights
  const sy = (f: { y: number; lift: number | null }) => H / 2 - (f.y - frame.cy) * frame.s - (f.lift ?? 0) * ui;
  const me = ft as unknown as { y: number; lift: number; scale: number };
  for (const o of below) {
    const need = (size.h * me.scale + size.h * o.scale) * ui * 1.1 / 2;
    expect(Math.abs(sy(o) - sy(me))).toBeGreaterThanOrEqual(need);
  }
});
