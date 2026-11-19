import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(120_000);
import {
  BARREL,
  FINISH_TICKS,
  initPhysics,
  Match,
  NO_INPUT,
  replay,
  ROUNDS,
  ROUND_TICKS,
  Sim,
  WEAPONS,
  type Input,
} from "../src/sim";

beforeAll(async () => {
  await initPhysics();
});

function idle(): Input[] {
  return [NO_INPUT, NO_INPUT, NO_INPUT, NO_INPUT];
}

/** A sim with all fighters parked far apart, so tests can stage things. */
function stage(seed = 1): Sim {
  const sim = new Sim(seed);
  sim.beginRound(1);
  const spots = [-27, -18, 18, 27.5];
  sim.fighters.forEach((f, i) => {
    const s = sim.nav.surfaceAt(spots[i]!, 50)!;
    f.entity.body.setTranslation({ x: spots[i]!, y: s.y + 0.9 }, true);
    f.entity.body.setLinvel({ x: 0, y: 0 }, true);
  });
  for (let i = 0; i < 30; i++) sim.step(idle());
  sim.events = [];
  return sim;
}

function place(sim: Sim, id: number, x: number, y: number) {
  const f = sim.fighters[id]!;
  f.entity.body.setTranslation({ x, y }, true);
  f.entity.body.setLinvel({ x: 0, y: 0 }, true);
  // scene queries see the new position only after a step
  sim.step(idle());
  sim.events = [];
  return f;
}

describe("determinism", () => {
  test("same seed gives the same hashes, many seeds", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const a = new Match(seed);
      a.playToEnd();
      const b = new Match(seed);
      b.playToEnd();
      expect(b.record.roundHashes).toEqual(a.record.roundHashes);
      expect(b.record.finalHash).toBe(a.record.finalHash);
    }
  });

  test("a match record replays to the same state hash", () => {
    for (const seed of [3, 77, 1234, 99999, 4000000000]) {
      const m = new Match(seed);
      m.playToEnd();
      const rec = JSON.parse(JSON.stringify(m.record));
      const r = replay(rec);
      expect(r.roundHashes).toEqual(m.record.roundHashes);
      expect(r.finalHash).toBe(m.record.finalHash);
    }
  });

  test("different seeds or different orders give different states", () => {
    const a = new Match(5);
    a.playToEnd();
    const b = new Match(6);
    b.playToEnd();
    expect(a.record.finalHash).not.toBe(b.record.finalHash);
    const rec = JSON.parse(JSON.stringify(a.record));
    rec.rounds[0][0].stance = rec.rounds[0][0].stance === "rush" ? "cover" : "rush";
    rec.rounds[0][1].target = rec.rounds[0][1].target === 0 ? 2 : 0;
    const r = replay(rec);
    expect(r.roundHashes[0]).not.toBe(a.record.roundHashes[0]);
  });

  test("hash is stable across interleaved matches (no hidden global state)", () => {
    const solo = new Match(42);
    solo.playToEnd();
    const x = new Match(42);
    const y = new Match(43);
    while (!x.over) {
      x.playRound();
      if (!y.over) y.playRound();
    }
    expect(x.record.finalHash).toBe(solo.record.finalHash);
  });
});

describe("round flow", () => {
  test("rounds run at most ROUND_TICKS, the match at most ROUNDS rounds", () => {
    for (const seed of [1, 2, 3, 4]) {
      const m = new Match(seed);
      let rounds = 0;
      while (!m.over) {
        m.startRound();
        let ticks = 1;
        while (!m.stepAction()) ticks++;
        expect(ticks).toBeLessThanOrEqual(ROUND_TICKS);
        m.endRound();
        rounds++;
      }
      expect(rounds).toBeLessThanOrEqual(ROUNDS);
      expect(m.summaries.length).toBe(rounds);
      expect(m.record.rounds.length).toBe(rounds);
      expect(() => m.startRound()).toThrow();
      // a match ends early only when at most one fighter is left
      if (rounds < ROUNDS) expect(m.sim.alive().length).toBeLessThanOrEqual(1);
    }
  });

  test("the round ends FINISH_TICKS after the last knockout", () => {
    const m = new Match(9);
    m.startRound();
    m.sim.fighters.slice(1).forEach((f) => m.sim.damageFighter(f, 1000, 0, 0, 0, "test", 0, 0));
    let ticks = 0;
    while (!m.stepAction()) ticks++;
    expect(ticks + 1).toBe(FINISH_TICKS);
    m.endRound();
    expect(m.over).toBe(true);
    expect(m.winner()).toBe(0);
  });

  test("safe zone shrinks every round and hurts fighters outside it", () => {
    const sim = stage();
    const halves: number[] = [];
    for (let r = 1; r <= ROUNDS; r++) {
      sim.beginRound(r);
      for (let i = 0; i < 200; i++) sim.step(idle());
      halves.push(sim.zone.half);
    }
    for (let i = 1; i < halves.length; i++) expect(halves[i]!).toBeLessThan(halves[i - 1]!);
    const outside = sim.fighters.filter((f) => f.alive && f.inZoneDamage);
    expect(sim.fighters.some((f) => f.koCause === "zone") || outside.length > 0).toBe(true);
  });

  test("bots give every living fighter a valid order", () => {
    const m = new Match(11);
    const orders = m.startRound();
    expect(orders.length).toBe(4);
    for (const [i, o] of orders.entries()) {
      expect(o.target).not.toBe(i);
      expect(["rocket", "shotgun", "grenade"]).toContain(o.weapon);
      expect(["rush", "distance", "cover", "item"]).toContain(o.stance);
    }
  });
});

describe("damage and knockback", () => {
  test("knockback grows as health drops", () => {
    const sim = stage();
    expect(sim.kbMult(100)).toBe(1);
    expect(sim.kbMult(50)).toBeGreaterThan(sim.kbMult(100));
    expect(sim.kbMult(10)).toBeGreaterThan(sim.kbMult(50));

    const speedAfterBlast = (hp: number) => {
      const s = stage();
      const f = place(s, 0, -20, 0.9);
      f.hp = hp;
      s.explode(-21, 0.6, WEAPONS.rocket, "rocket", 1, 0, null);
      const v = f.entity.body.linvel();
      return Math.hypot(v.x, v.y);
    };
    const fresh = speedAfterBlast(100);
    const hurt = speedAfterBlast(25);
    expect(hurt).toBeGreaterThan(fresh * 1.8);
  });

  test("explosion damage falls off with distance and pushes away from the center", () => {
    const sim = stage();
    const near = place(sim, 0, -20, 0.9);
    const far = place(sim, 1, -22.6, 0.9);
    sim.explode(-20.8, 0.5, WEAPONS.rocket, "rocket", 3, 0, null);
    expect(100 - near.hp).toBeGreaterThan(100 - far.hp);
    expect(100 - far.hp).toBeGreaterThan(0);
    expect(near.entity.body.linvel().x).toBeGreaterThan(0);
    expect(far.entity.body.linvel().x).toBeLessThan(0);
    expect(near.entity.body.linvel().y).toBeGreaterThan(0);
    expect(sim.fighters[3]!.damageDealt).toBeCloseTo(200 - near.hp - far.hp, 5);
  });

  test("shotgun at point blank deals damage and big knockback", () => {
    const sim = stage();
    const shooter = place(sim, 0, -20, 0.9);
    const target = place(sim, 1, -17.8, 0.9);
    for (let i = 0; i < 10; i++) sim.step(idle());
    const inputs = idle();
    inputs[0] = { move: 0, jump: false, aimX: 1, aimY: 0, fire: "shotgun" };
    sim.step(inputs);
    expect(target.hp).toBeLessThan(95);
    expect(target.entity.body.linvel().x).toBeGreaterThan(6);
    expect(shooter.cooldown.shotgun).toBeGreaterThan(0);
    // cooldown blocks a second shot
    const hp = target.hp;
    sim.step(inputs);
    expect(target.hp).toBe(hp);
  });

  test("a fighter at zero health is knocked out and credited", () => {
    const sim = stage();
    const f = place(sim, 0, -20, 0.9);
    f.hp = 3;
    sim.explode(-20.5, 0.6, WEAPONS.rocket, "rocket", 2, 0, null);
    expect(f.alive).toBe(false);
    expect(f.koCause).toBe("hp");
    expect(f.koBy).toBe(2);
    expect(sim.fighters[2]!.kos).toBe(1);
  });
});

describe("explosions and props", () => {
  test("an explosion breaks blocks near its center and shoves the rest", () => {
    const sim = stage();
    const blocks = [...sim.entities.values()].filter((e) => e.kind === "block");
    // the 2x3 wall at x = -12
    const wall = blocks.filter((b) => Math.abs(b.body.translation().x + 12) < 1);
    expect(wall.length).toBe(6);
    const before = wall.map((b) => ({ ...b.body.translation() }));
    sim.explode(-12.9, 0.5, WEAPONS.rocket, "rocket", 0, 0, null);
    for (let i = 0; i < 30; i++) sim.step(idle());
    const broken = wall.filter((b) => b.dead).length;
    expect(broken).toBeGreaterThan(0);
    expect(sim.stats.blocksDestroyed).toBe(broken);
    const moved = wall.filter((b, i) => !b.dead && Math.hypot(b.body.translation().x - before[i]!.x, b.body.translation().y - before[i]!.y) > 0.05);
    expect(moved.length).toBeGreaterThan(0);
  });

  test("barrels explode when hit and set off nearby barrels (chain reaction)", () => {
    const sim = stage();
    const barrels = [...sim.entities.values()].filter((e) => e.kind === "barrel");
    const a = barrels.find((b) => Math.abs(b.body.translation().x + 4) < 0.3)!;
    expect(a).toBeDefined();
    sim.explode(a.body.translation().x + 0.5, 0.5, WEAPONS.rocket, "rocket", 1, 0, null);
    expect(a.fuse).toBeDefined();
    const evs: string[] = [];
    for (let i = 0; i < BARREL.fuseMax * 3 + 10; i++) {
      sim.step(idle());
      for (const e of sim.events) if (e.type === "explosion") evs.push(`${e.kind}:${e.chainFrom}`);
      sim.events = [];
    }
    expect(sim.stats.barrelsExploded).toBeGreaterThanOrEqual(2);
    expect(sim.stats.barrelToBarrel).toBeGreaterThanOrEqual(1);
    expect(evs).toContain("barrel:rocket");
    expect(evs).toContain("barrel:barrel");
  });

  test("breaking a bridge plank breaks the bridge path", () => {
    const sim = stage();
    expect(sim.bridgeIntact()).toBe(true);
    sim.explode(0, -0.1, WEAPONS.rocket, "rocket", 0, 0, null);
    expect(sim.bridgeIntact()).toBe(false);
    const left = sim.nav.surfaceAt(-10, 0.1)!;
    const right = sim.nav.surfaceAt(10, 0.1)!;
    const withBridge = sim.nav.plan(left.id, -4, true);
    const without = sim.nav.plan(left.id, -4, false);
    expect(withBridge.cost[right.id]!).toBeLessThan(without.cost[right.id]!);
    expect(without.cost[right.id]!).toBeLessThan(Infinity);
  });
});

describe("ring-out", () => {
  test("falling into the pit is a ring-out credited to the last hitter", () => {
    const sim = stage();
    sim.explode(0, -0.1, WEAPONS.rocket, "rocket", 0, 0, null); // break the bridge
    for (let i = 0; i < 20; i++) sim.step(idle());
    const f = place(sim, 2, 0, -2);
    f.lastHitBy = 3;
    f.lastHitTick = sim.tick;
    let ko = null as null | { cause: string; by: number };
    for (let i = 0; i < 120 && !ko; i++) {
      sim.step(idle());
      for (const e of sim.events) if (e.type === "ko") ko = e;
      sim.events = [];
    }
    expect(ko).not.toBeNull();
    expect(ko!.cause).toBe("ringout");
    expect(ko!.by).toBe(3);
    expect(f.alive).toBe(false);
    expect(f.removed).toBe(true);
  });

  test("a big hit near the edge launches a hurt fighter off the map", () => {
    const sim = stage();
    const f = place(sim, 0, -27, 2.4);
    f.hp = 20;
    sim.explode(-25.8, 1.9, { radius: 3.7, damage: 1, knockback: 14, blockDamage: 0 }, "barrel", 1, 0, null);
    for (let i = 0; i < 240 && f.alive; i++) sim.step(idle());
    expect(f.alive).toBe(false);
    expect(f.koCause).toBe("ringout");
  });
});

describe("navigation and controllers", () => {
  test("every surface can reach every other surface", () => {
    const sim = stage();
    const n = sim.nav.surfaces.length;
    expect(n).toBeGreaterThanOrEqual(8);
    for (let a = 0; a < n; a++) {
      const s = sim.nav.surfaces[a]!;
      const plan = sim.nav.plan(a, (s.x0 + s.x1) / 2, true);
      for (let b = 0; b < n; b++) expect(plan.cost[b]!).toBeLessThan(Infinity);
    }
  });

  test("a rush order closes the distance to the target", () => {
    const m = new Match(21);
    m.startRound();
    const sim = m.sim;
    const me = sim.fighters[0]!;
    const target = sim.fighters.reduce((a, b) => (b.id !== 0 && Math.abs(sim.pos(b).x - sim.pos(me).x) > Math.abs(sim.pos(a).x - sim.pos(me).x) ? b : a));
    m.controllers.forEach((c, i) =>
      c.setOrder(i === 0 ? { target: target.id, weapon: "shotgun", stance: "rush" } : { target: 0, weapon: "shotgun", stance: "cover" }, sim),
    );
    const d0 = Math.abs(sim.pos(me).x - sim.pos(target).x);
    for (let i = 0; i < 240; i++) m.stepAction();
    if (me.alive && target.alive) {
      const d1 = Math.abs(sim.pos(me).x - sim.pos(target).x);
      expect(d1).toBeLessThan(d0 * 0.6);
    }
  });
});
