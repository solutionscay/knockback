import { beforeAll, describe, expect, test } from "bun:test";
import { FIGHTER, initPhysics, Match } from "../src/sim";
import { drawFeet, FEET_Y } from "../src/viewer/bot";
import { ChainView } from "../src/viewer/chains";
import { groundTop } from "../src/viewer/scene-fighters";
import { SvgPen } from "../src/viewer/svgPen";

beforeAll(async () => {
  await initPhysics();
});

describe("feet on the ground and chains to the top (viewer only)", () => {
  test("the feet end at the capsule's bottom, and each foot can move on its own", () => {
    expect(FEET_Y).toBe(FIGHTER.halfHeight + FIGHTER.radius);
    const id = { name: "Zapko", shape: "squircle", eyes: "tall", mark: "halo", color: 0x4fa8ff } as const;
    const flat = new SvgPen(), step = new SvgPen();
    drawFeet(flat, id);
    drawFeet(step, id, { dl: -0.2, dr: 0.1 });
    expect(flat.toSvg()).not.toBe(step.toSvg());
    expect(flat.toSvg()).not.toMatch(/NaN/);
  });

  test("groundTop finds the floor under a standing fighter, and nothing over a gap", () => {
    const m = new Match(7);
    m.prepareRound();
    const sim = m.fight!.sim;
    let checked = 0, found = 0;
    for (let i = 0; i < 2400 && !m.step(); i++) {
      if (i % 20) continue;
      for (const f of sim.fighters) {
        if (!f.alive || f.removed || !f.grounded) continue;
        const p = f.entity.body.translation(), bottom = p.y - FEET_Y;
        checked++;
        const top = groundTop(sim, p.x, bottom);
        if (top === null) continue; // e.g. on another fighter
        found++;
        expect(Math.abs(top - bottom)).toBeLessThan(0.15); // a round capsule on a step edge sits up to ~0.13 m low
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(found / checked).toBeGreaterThan(0.6); // the rest stand on loose chunks or other fighters: their feet stay at the capsule bottom
    expect(groundTop(sim, 0, 300)).toBeNull(); // high in the air: no ground near
  });

  test("the chains' top is above the view at every zoom, with the shake's offset", () => {
    for (const s of [20, 40, 71, 144])
      for (const shy of [0, 0.9, -0.9]) {
        const frame = { cx: 0, cy: 30, s, shx: 0.5, shy };
        const top = ChainView.viewTop(frame, 1920, 1080);
        // the highest world y on screen: the top edge, plus the shake, plus a rotated corner
        expect(top).toBeGreaterThan(frame.cy + shy + 540 / s + 1);
      }
  });
});
