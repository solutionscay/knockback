import { beforeAll, describe, expect, test } from "bun:test";
import { CLOSE_QUARTERS, FIGHTER, initPhysics, Match } from "../src/sim";
import { drawFeet, FEET_OVERLAP_PX, FEET_Y, HEAD_TOPS, HEADS, headTopAt } from "../src/viewer/bot";
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
    // Keep the same busy ground-contact scenario as the original test.
    const m = new Match(7, { ruleset: CLOSE_QUARTERS });
    m.prepareRound();
    const sim = m.fight!.sim;
    let checked = 0, found = 0;
    for (let i = 0; i < 2400 && !m.step(); i++) {
      if (i % 20) continue;
      for (const f of sim.fighters) {
        if (!f.alive || f.removed || !f.grounded) continue;
        const p = f.entity.body.translation(), bottom = p.y - FEET_Y;
        checked++;
        const top = groundTop(sim, p.x, bottom, undefined, f.id);
        if (top === null) continue; // e.g. against a steep face
        found++;
        expect(Math.abs(top - bottom)).toBeLessThanOrEqual(0.3); // tilted props and other bots' heads sit within the window
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(found / checked).toBeGreaterThan(0.8); // chunks, tilted props and other bots' heads count as ground now
    expect(groundTop(sim, 0, 300)).toBeNull(); // high in the air: no ground near
  });

  test("groundTop finds the support under Classic floor and ledge spawns", () => {
    const m = new Match(23);
    m.prepareRound();
    const sim = m.fight!.sim;
    for (const fighter of sim.fighters) {
      const p = sim.pos(fighter);
      const spawn = m.level.spawns.find(s => Math.abs(s.x - p.x) < 0.01)!;
      expect(groundTop(sim, p.x, p.y - FEET_Y, undefined, fighter.id)).toBeCloseTo(spawn.y, 3);
    }
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

  test("the drawn head-top table covers every head shape and matches each head's outline", () => {
    for (const shape of Object.keys(HEADS) as (keyof typeof HEADS)[]) {
      const col = HEAD_TOPS[shape];
      expect(col.length).toBe(33);
      const tops = col.filter((v): v is number => v !== null);
      expect(tops.length).toBeGreaterThan(15);
      // near the path's top minus Skiff's 1.5-unit stroke (HEADS.top is a hand-set guide for the marks)
      expect(Math.abs(Math.min(...tops) - (HEADS[shape].top - 1.5))).toBeLessThanOrEqual(1.5);
      expect(headTopAt(shape, 16)).not.toBeNull();
      expect(headTopAt(shape, -1)).toBeNull();
    }
  });

  test("groundTop reads tilted props: a box turned 30 degrees has a sloped top", () => {
    const m = new Match(7);
    m.prepareRound();
    const sim = m.fight!.sim;
    const box = [...sim.entities.values()].find((e) => e.kind === "crate" || e.kind === "steel" || e.kind === "block")!;
    const q = box.body.translation();
    const pose = (e: typeof box) => (e === box ? { x: q.x, y: q.y, a: Math.PI / 6 } : { ...e.body.translation(), a: e.body.rotation() });
    // turned 30 degrees, the top edge runs from corner (-hw, hh) to (hw, hh), its middle shifted left by hh * sin 30
    const mid = q.x - box.hh * Math.sin(Math.PI / 6);
    const top = (dx: number) => groundTop(sim, mid + dx, q.y + box.hh, pose);
    const a = top(-box.hw * 0.25), b = top(box.hw * 0.25);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(b! - a!).toBeCloseTo(Math.tan(Math.PI / 6) * box.hw * 0.5, 2); // rising to the right
  });

  test("feet: overlap in screen pixels, tilt and slide draw clean", () => {
    expect(FEET_OVERLAP_PX).toBeGreaterThanOrEqual(1);
    expect(FEET_OVERLAP_PX).toBeLessThanOrEqual(2);
    const id = { name: "Zapko", shape: "dome", eyes: "tall", mark: "halo", color: 0x4fa8ff } as const;
    const pen = new SvgPen();
    drawFeet(pen, id, { dl: 0.02, dr: -0.1, xl: 0.3, xr: 0, al: 0.8, ar: -0.4 });
    expect(pen.toSvg()).not.toMatch(/NaN|undefined/);
    expect(pen.toSvg()).toContain("matrix(");
  });
});
