import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { exampleSouls, Fight, FIGHT_TICKS, initPhysics, Match, NO_INPUT, PATIENCE, STALEMATE, type Input, type Strategy } from "../src/sim";
import { flatLevel, idle, sandbox, stepN } from "./helpers";
import { Sim } from "../src/sim";

setDefaultTimeout(240_000);
beforeAll(async () => {
  await initPhysics();
});

const plan = (stance: Strategy["stance"], target: Strategy["target"] = "nearest", grudge?: number): Strategy => ({ target, ...(grudge !== undefined ? { grudge } : {}), stance, weapons: ["shotgun", "rocket"], retaliate: "turn", line: "" });

describe("dead or missing targets", () => {
  test("when the target is knocked out, the fighter picks a new living target on the very next tick", () => {
    for (const seed of [1, 2, 3]) {
      const f = new Fight(seed, [plan("rush", "grudge", 2), plan("cover"), plan("cover"), plan("cover")]);
      for (let i = 0; i < 30; i++) f.step();
      const c = f.controllers[0]!;
      expect(c.targetId).toBe(2);
      f.sim.damageFighter(f.sim.fighters[2]!, 1000, 1, 0, 0, "test", 0, 0);
      f.step();
      expect(c.targetId).not.toBe(2);
      expect(f.sim.fighters[c.targetId]!.alive).toBe(true);
    }
  });
});

describe("the anti-stalemate rule", () => {
  const quietSim = () => {
    const sim = new Sim(5, flatLevel());
    for (const e of [...sim.entities.values()]) if (e.kind === "item") e.body.setTranslation({ x: 0, y: -30 }, true);
    return sim;
  };

  test("no fighter damage for STALEMATE.quietTicks: sudden death, a faster zone and drops between the survivors", () => {
    const sim = quietSim();
    const evs = stepN(sim, STALEMATE.quietTicks + 1);
    const sd = evs.filter((e) => e.type === "suddenDeath");
    expect(sd.length).toBe(1);
    expect(sd[0]!.tick).toBe(STALEMATE.quietTicks);
    const half0 = sim.zone.half;
    const later = stepN(sim, STALEMATE.dropEvery + 1);
    expect(sim.zone.half).toBeLessThan(half0 - STALEMATE.shrinkPerSec * (STALEMATE.dropEvery / 60) * 0.9);
    const drops = later.filter((e) => e.type === "itemSpawn");
    expect(drops.length).toBeGreaterThanOrEqual(1);
    const xs = sim.alive().map((f) => sim.pos(f).x);
    const d = drops[0]! as { x: number };
    expect(d.x).toBeGreaterThanOrEqual(Math.min(...xs) - 0.01);
    expect(d.x).toBeLessThanOrEqual(Math.max(...xs) + 0.01);
    stepN(sim, 30 * 60);
    expect(sim.zone.half).toBe(STALEMATE.endHalf);
  });

  test("fighter-on-fighter damage resets the clock; environment damage does not", () => {
    const sim = quietSim();
    stepN(sim, STALEMATE.quietTicks - 10);
    sim.damageFighter(sim.fighters[0]!, 1, 1, 0, 0, "test", 0, 0); // a fighter hit: clock resets
    expect(stepN(sim, 20).some((e) => e.type === "suddenDeath")).toBe(false);
    sim.damageFighter(sim.fighters[0]!, 1, -1, 0, 0, "zone", 0, 0); // the zone: does not count
    const evs = stepN(sim, STALEMATE.quietTicks);
    expect(evs.filter((e) => e.type === "suddenDeath").length).toBe(1);
  });

  test("it is deterministic and in the state hash", () => {
    const a = quietSim();
    const b = quietSim();
    stepN(a, STALEMATE.quietTicks + 200);
    stepN(b, STALEMATE.quietTicks + 200);
    expect(a.hash()).toBe(b.hash());
    expect(a.suddenDeath).toBe(STALEMATE.quietTicks);
  });

  test("in sudden death everyone goes for the nearest rival, whatever the plan", () => {
    const f = new Fight(4, [plan("cover", "grudge", 3), plan("distance", "strongest"), plan("cover", "weakest"), plan("item", "leader")]);
    f.step();
    f.sim.suddenDeath = f.sim.tick;
    f.sim.tick += 1;
    for (const c of f.controllers) {
      (c as unknown as { nextRetarget: number }).nextRetarget = 0;
      c.think(f.sim);
      const me = f.sim.fighters[c.fighterId]!;
      const p = f.sim.pos(me);
      const near = f.sim.fighters
        .filter((o) => o.alive && o.id !== me.id)
        .sort((x, y) => Math.abs(f.sim.pos(x).x - p.x) + Math.abs(f.sim.pos(x).y - p.y) - (Math.abs(f.sim.pos(y).x - p.x) + Math.abs(f.sim.pos(y).y - p.y)))[0]!;
      expect(c.targetId).toBe(near.id);
      expect(c.stanceNow(f.sim)).toBe("rush");
    }
  });
});

describe("cover is not standing still", () => {
  test("a cover (or distance) fighter who neither hits nor gets hit for PATIENCE.calmTicks closes in", () => {
    const f = new Fight(6, [plan("cover"), plan("distance"), plan("item"), plan("rush")]);
    f.step();
    const [cover, dist, item, rush] = f.controllers;
    expect(cover!.stanceNow(f.sim)).toBe("cover");
    expect(dist!.stanceNow(f.sim)).toBe("distance");
    f.sim.tick = PATIENCE.calmTicks + 5;
    expect(cover!.stanceNow(f.sim)).toBe("rush");
    expect(dist!.stanceNow(f.sim)).toBe("rush");
    expect(item!.stanceNow(f.sim)).toBe("rush");
    expect(rush!.stanceNow(f.sim)).toBe("rush");
    cover!.onDealt(f.sim.tick - 10); // just hit someone: back to cover
    expect(cover!.stanceNow(f.sim)).toBe("cover");
  });

  test("in real fights, armed cover fighters keep shooting (peeking out), and an all-cover lobby still ends", () => {
    let checked = 0;
    for (const seed of [11, 12, 13, 14, 15, 16]) {
      const f = new Fight(seed, [plan("cover"), plan("cover"), plan("cover"), plan("cover")]);
      const fires = [0, 0, 0, 0];
      const armed = [0, 0, 0, 0];
      f.onEvent = (e) => {
        if (e.type === "fire" && e.weapon !== "fist") fires[e.fighter]!++;
      };
      while (!f.step()) {
        for (const fi of f.sim.fighters) if (fi.alive && fi.weapons.some((w) => w !== "fist")) armed[fi.id]!++;
      }
      // judged: fighters who held a real weapon for at least 10 s (an unarmed one has nothing to shoot)
      for (const fi of f.sim.fighters) {
        if (armed[fi.id]! >= 10 * 60) {
          checked++;
          expect(fires[fi.id]!).toBeGreaterThan(3);
        }
      }
      expect(f.sim.tick).toBeLessThan(FIGHT_TICKS); // an all-cover lobby still ends
    }
    expect(checked).toBeGreaterThan(5);
  });
});

describe("the final duel", () => {
  test("with two fighters left, both target each other and close in, regardless of strategy", () => {
    for (const seed of [2, 3, 4]) {
      const f = new Fight(seed, [plan("cover", "grudge", 2), plan("distance", "grudge", 2), plan("cover", "grudge", 0), plan("item", "grudge", 0)]);
      for (let i = 0; i < 20; i++) f.step();
      f.sim.damageFighter(f.sim.fighters[2]!, 1000, 1, 0, 0, "test", 0, 0);
      f.sim.damageFighter(f.sim.fighters[3]!, 1000, 1, 0, 0, "test", 0, 0);
      f.step();
      const [a, b] = f.controllers;
      expect(a!.targetId).toBe(1);
      expect(b!.targetId).toBe(0);
      expect(a!.stanceNow(f.sim)).toBe("rush");
      expect(b!.stanceNow(f.sim)).toBe("rush");
      // and they actually meet: someone gets hurt within 12 s
      const hp0 = f.sim.fighters[0]!.hp + f.sim.fighters[1]!.hp;
      for (let i = 0; i < 12 * 60 && !f.over; i++) f.step();
      expect(f.sim.fighters[0]!.hp + f.sim.fighters[1]!.hp).toBeLessThan(hp0);
    }
  });

  test("fists are always there: a jab works with two weapons in hand", () => {
    const s = sandbox();
    const a = s.fighters[0]!;
    a.weapons = ["rocket", "grenade"];
    a.cooldown.fist = 0;
    const inputs: Input[] = idle();
    inputs[0] = { ...NO_INPUT, weapon: "fist", fire: true, aimX: 1, aimY: 0 };
    const evs = stepN(s, 1, inputs);
    expect(evs.some((e) => e.type === "swing" && e.weapon === "fist")).toBe(true);
    expect(a.weapons).toEqual(["rocket", "grenade"]);
  });
});

describe("the operator's stalled match", () => {
  test("seed 880446006 with house bots: no time-outs and no long silences", () => {
    const m = new Match(880446006, { souls: exampleSouls() });
    while (!m.over) {
      m.prepareRound();
      let last = 0;
      let gap = 0;
      m.onEvent = (e) => {
        if (e.type === "hit" && e.source >= 0 && e.source !== e.target) {
          gap = Math.max(gap, e.tick - last);
          last = e.tick;
        }
      };
      while (!m.step()) {
        /* round */
      }
      expect(m.fight!.sim.tick).toBeLessThan(FIGHT_TICKS);
      expect(gap / 60).toBeLessThan(STALEMATE.quietTicks / 60 + 12);
      m.finishRound();
    }
  });
});
