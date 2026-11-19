import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  BARREL,
  FIGHT_TICKS,
  FINISH_TICKS,
  GAS,
  initPhysics,
  Mat,
  Match,
  POWER,
  replay,
  SUPPLY,
  SWAP_TICKS,
  TNT,
  WEAPONS,
  ZONE,
  zoneHalfAt,
  type Input,
} from "../src/sim";
import { idle, place, sandbox, stepN } from "./helpers";

setDefaultTimeout(180_000);

beforeAll(async () => {
  await initPhysics();
});

const fire = (weapon: Input["weapon"], aimX = 1, aimY = 0): Input => ({ move: 0, jump: false, aimX, aimY, weapon, fire: true });

describe("determinism and replay", () => {
  test("same seed gives the same hashes, many seeds (each on its own generated level)", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const a = new Match(seed);
      a.playToEnd();
      const b = new Match(seed);
      b.playToEnd();
      expect(b.record.checkpoints).toEqual(a.record.checkpoints);
      expect(b.record.finalHash).toBe(a.record.finalHash);
      expect(b.strategies).toEqual(a.strategies);
    }
  });

  test("a match record (seed + strategies) replays to the same state hash", () => {
    for (const seed of [3, 77, 1234, 99999, 4000000000]) {
      const m = new Match(seed);
      m.playToEnd();
      const rec = JSON.parse(JSON.stringify(m.record));
      const r = replay(rec);
      expect(r.checkpoints).toEqual(m.record.checkpoints);
      expect(r.finalHash).toBe(m.record.finalHash);
      expect(r.match.result()).toEqual(m.result());
      expect(rec.level.theme).toBe(m.sim.level.theme);
    }
  });

  test("different strategies give different states; interleaving matches changes nothing", () => {
    const a = new Match(5);
    a.playToEnd();
    const rec = JSON.parse(JSON.stringify(a.record));
    rec.strategies[0].stance = rec.strategies[0].stance === "rush" ? "cover" : "rush";
    rec.strategies[1].loadout = ["grenade", "bat"];
    expect(replay(rec).checkpoints[0]).not.toBe(a.record.checkpoints[0]);
    const x = new Match(5);
    const y = new Match(6);
    while (!x.over) {
      x.step();
      y.step();
    }
    expect(x.record.finalHash).toBe(a.record.finalHash);
  });
});

describe("fight flow", () => {
  test("one continuous fight that ends with one fighter left or at time-out", () => {
    for (const seed of [1, 2, 3, 4]) {
      const m = new Match(seed);
      let ticks = 1;
      while (!m.step()) ticks++;
      expect(ticks).toBeLessThanOrEqual(FIGHT_TICKS);
      const r = m.result();
      if (ticks < FIGHT_TICKS) expect(m.sim.alive().length).toBeLessThanOrEqual(1);
      expect(r.koLog.length).toBe(4 - r.survivors.length);
    }
  });

  test("the fight ends FINISH_TICKS after the last knockout", () => {
    const m = new Match(9);
    m.step();
    m.sim.fighters.slice(1).forEach((f) => m.sim.damageFighter(f, 1000, 0, 0, 0, "test", 0, 0));
    let ticks = 0;
    while (!m.step()) ticks++;
    expect(ticks + 1).toBe(FINISH_TICKS);
    expect(m.result().winner).toBe(0);
    expect(m.result().kos[0]).toBe(3);
  });

  test("bots give every fighter a strategy with a two-weapon loadout and a line", () => {
    for (const seed of [11, 12, 13, 14]) {
      const m = new Match(seed);
      for (const [i, s] of m.strategies.entries()) {
        expect(s.loadout.length).toBe(2);
        expect(s.loadout[0]).not.toBe(s.loadout[1]);
        expect(s.line.length).toBeGreaterThan(10);
        expect(m.sim.fighters[i]!.weapons).toEqual(s.loadout);
      }
      expect(m.strategies[0]!.stance).toBe("rush");
    }
  });

  test("fighters start close and meet in the first seconds", () => {
    for (const seed of [31, 32, 33]) {
      const m = new Match(seed);
      const xs = m.sim.fighters.map((f) => m.sim.pos(f).x);
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(24.5);
      let first = -1;
      m.onEvent = (e) => {
        if (first < 0 && e.type === "hit" && e.source >= 0 && e.source !== e.target) first = e.tick;
      };
      for (let i = 0; i < 600 && first < 0; i++) m.step();
      expect(first).toBeGreaterThan(0);
    }
  });

  test("the zone shrinks, pushes outsiders in, and flings stuck ones (no slow drain)", () => {
    expect(zoneHalfAt(ZONE.shrinkEndTicks, 30)).toBe(ZONE.endHalf);
    expect(zoneHalfAt(ZONE.holdTicks + 600, 30)).toBeLessThan(30);
    const sim = sandbox();
    sim.zoneEnabled = true;
    sim.zone.center = 0;
    sim.zone.startHalf = 20;
    const f = place(sim, 0, -24, 0.9);
    const hp = f.hp;
    stepN(sim, 6);
    expect(f.outsideZone).toBe(true);
    expect(f.entity.body.linvel().x).toBeGreaterThan(4);
    expect(f.hp).toBe(hp); // pushed, not drained
    // pinned against a wall outside the zone: the zone flings it up and in
    for (let cy = sim.grid.cy(0); cy < sim.grid.cy(4); cy++) sim.grid.set(sim.grid.cx(-22.5), cy, Mat.Bedrock);
    (sim.terrain as any).touch(sim.grid.cx(-22.5), sim.grid.cy(1));
    place(sim, 0, -24, 0.9);
    const evs = stepN(sim, ZONE.shockAfter + 5);
    expect(evs.some((e) => e.type === "zap")).toBe(true);
  });

  test("supply drops bring in barrels/TNT and items during the fight", () => {
    const sim = sandbox();
    const evs = stepN(sim, SUPPLY.firstTick + SUPPLY.interval + 2 - sim.tick);
    expect(evs.filter((e) => e.type === "propDrop").length).toBeGreaterThanOrEqual(1);
    expect(evs.filter((e) => e.type === "itemSpawn").length).toBeGreaterThanOrEqual(2);
  });
});

describe("destructible level", () => {
  test("explosions carve cells; bedrock never breaks", () => {
    const sim = sandbox();
    const before = sim.grid.countSolid();
    sim.explode(-10, 0, TNT, "tnt", 0, 0, null);
    expect(sim.grid.countSolid()).toBeLessThan(before - 20);
    for (let i = 0; i < 30; i++) sim.explode(-10, -6, TNT, "tnt", 0, 0, null);
    for (let cx = 0; cx < sim.grid.cols; cx++) {
      const x = sim.grid.wx(cx) + 0.25;
      if (x < -28 || x > 28 || (x > 10 && x < 14)) continue;
      expect(sim.grid.matAt(cx, 0)).toBe(Mat.Bedrock);
      expect(sim.grid.matAt(cx, 1)).toBe(Mat.Bedrock);
    }
    expect(sim.stats.cellsDestroyed).toBeGreaterThan(50);
  });

  test("a platform falls when both anchors are destroyed, and breaks further when hit", () => {
    const sim = sandbox();
    const g = sim.grid;
    const py = g.cy(4) - 1;
    const pin = { radius: 0.6, damage: 0, knockback: 0, blockDamage: 0, terrainDamage: 500 };
    sim.explode(-5.75, 3.75, pin, "rocket", 0, 0, null);
    const evs1 = stepN(sim, 2);
    expect(evs1.some((e) => e.type === "detach")).toBe(false);
    expect(g.solid(g.cx(-3), py)).toBe(true);
    sim.explode(-0.25, 3.75, pin, "rocket", 0, 0, null);
    const evs2 = stepN(sim, 2);
    expect(evs2.some((e) => e.type === "detach")).toBe(true);
    expect(g.solid(g.cx(-3), py)).toBe(false);
    const piece = [...sim.entities.values()].find((e) => e.kind === "chunk")!;
    expect(piece.cells!.length).toBeGreaterThanOrEqual(6);
    const y0 = piece.body.translation().y;
    stepN(sim, 30);
    expect(piece.body.translation().y).toBeLessThan(y0 - 1);
    expect(sim.stats.platformsFallen).toBe(1);
    const t = piece.body.translation();
    const n0 = piece.cells!.length;
    sim.explode(t.x + piece.hw, t.y + 0.25, { radius: 1.2, damage: 0, knockback: 2, blockDamage: 0, terrainDamage: 400 }, "rocket", 0, 0, null);
    const cellsLeft = [...sim.entities.values()].filter((e) => e.kind === "chunk").reduce((a, c) => a + c.cells!.length, 0);
    expect(cellsLeft).toBeLessThan(n0);
  });

  test("navigation rebuilds after the level changes", () => {
    const sim = sandbox();
    const v0 = sim.navVersion;
    sim.explode(-20, 0, TNT, "tnt", 0, 0, null);
    stepN(sim, 25);
    expect(sim.navVersion).not.toBe(v0);
    expect(sim.nav.surfaces.length).toBeGreaterThan(0);
  });

  test("crumbling cells give way under a fighter", () => {
    const sim = sandbox();
    const g = sim.grid;
    for (let cx = g.cx(-21); cx <= g.cx(-19); cx++) g.set(cx, g.cy(0) - 1, Mat.Crumble);
    place(sim, 0, -20, 0.9);
    const evs = stepN(sim, 150);
    expect(evs.some((e) => e.type === "carve")).toBe(true);
    expect(g.matAt(g.cx(-20), g.cy(0) - 1)).not.toBe(Mat.Crumble);
  });
});

describe("objects", () => {
  test("barrels explode when hit and set off nearby barrels", () => {
    const sim = sandbox([
      { kind: "barrel", x: -8, y: 0 },
      { kind: "barrel", x: -6.5, y: 0 },
    ]);
    sim.explode(-8.6, 0.5, WEAPONS.rocket, "rocket", 1, 0, null);
    const evs = stepN(sim, BARREL.fuseMax * 3 + 10);
    const kinds = evs.filter((e) => e.type === "explosion").map((e) => `${(e as any).kind}:${(e as any).chainFrom}`);
    expect(kinds).toContain("barrel:rocket");
    expect(kinds).toContain("barrel:barrel");
  });

  test("TNT lights on a hit, burns a visible fuse, then leaves a big crater", () => {
    const sim = sandbox([{ kind: "tnt", x: -8, y: 0 }]);
    const tnt = [...sim.entities.values()].find((e) => e.kind === "tnt")!;
    sim.fighters[0]!.weapons = ["shotgun", "bat"];
    place(sim, 0, -12, 0.9);
    sim.fighters[0]!.cooldown.shotgun = 0;
    const inputs = idle();
    inputs[0] = fire("shotgun", 1, -0.17);
    const evs = stepN(sim, 1, inputs);
    expect(evs.some((e) => e.type === "lit")).toBe(true);
    expect(tnt.fuse).toBeGreaterThan(TNT.fuse - 5);
    const cells0 = sim.grid.countSolid();
    const evs2 = stepN(sim, TNT.fuse + 5);
    expect(evs2.some((e) => e.type === "explosion" && e.kind === "tnt")).toBe(true);
    expect(cells0 - sim.grid.countSolid()).toBeGreaterThan(25);
  });

  test("gas canisters rocket away when hit, then burst", () => {
    const sim = sandbox([{ kind: "gas", x: -8, y: 0 }]);
    const gas = [...sim.entities.values()].find((e) => e.kind === "gas")!;
    sim.explode(-9, 0.4, { radius: 2, damage: 0, knockback: 1, blockDamage: 100, terrainDamage: 0 }, "rocket", 0, 0, null);
    expect(gas.thrust).toBe(GAS.thrustTicks);
    let maxSpeed = 0;
    let burst = false;
    for (let i = 0; i < GAS.thrustTicks + 5 && !burst; i++) {
      sim.step(idle());
      if (!gas.dead) maxSpeed = Math.max(maxSpeed, Math.hypot(gas.body.linvel().x, gas.body.linvel().y));
      burst ||= sim.events.some((e) => e.type === "explosion" && e.kind === "gas");
      sim.events = [];
    }
    expect(maxSpeed).toBeGreaterThan(6);
    expect(burst).toBe(true);
  });

  test("steel crates shrug off explosions and crush", () => {
    const sim = sandbox([{ kind: "steel", x: -8, y: 0 }]);
    const steel = [...sim.entities.values()].find((e) => e.kind === "steel")!;
    expect(steel.body.mass()).toBeGreaterThan(5);
    sim.explode(-8, 0.5, TNT, "tnt", 0, 0, null);
    expect(steel.dead).toBe(false);
    const f = place(sim, 1, -16, 0.9);
    steel.body.setTranslation({ x: -16, y: 5 }, true);
    steel.body.setLinvel({ x: 0, y: -14 }, true);
    stepN(sim, 30);
    expect(f.hp).toBeLessThan(100);
  });

  test("glass shatters from a pellet or a fast body", () => {
    const sim = sandbox([
      { kind: "glass", x: -17, y: 0 },
      { kind: "glass", x: -23, y: 0 },
    ]);
    sim.fighters[0]!.weapons = ["shotgun", "bat"];
    place(sim, 0, -19, 0.9);
    sim.fighters[0]!.cooldown.shotgun = 0;
    const inputs = idle();
    inputs[0] = fire("shotgun");
    const evs = stepN(sim, 1, inputs);
    expect(evs.filter((e) => e.type === "shatter").length).toBe(1);
    const f = place(sim, 1, -21.5, 0.9);
    f.entity.body.setLinvel({ x: -14, y: 1 }, true);
    const evs2 = stepN(sim, 20);
    expect(evs2.filter((e) => e.type === "shatter").length).toBe(1);
  });

  test("bounce pads launch fighters", () => {
    const sim = sandbox([{ kind: "pad", x: -8, y: 0 }]);
    stepN(sim, 20);
    const f = place(sim, 0, -8, 1.4);
    let maxVy = 0;
    for (let i = 0; i < 30; i++) {
      sim.step(idle());
      maxVy = Math.max(maxVy, f.entity.body.linvel().y);
    }
    expect(maxVy).toBeGreaterThan(14);
    expect(sim.stats.bounces).toBeGreaterThanOrEqual(1);
  });

  test("hanging weights drop when their anchor is blown away", () => {
    const sim = sandbox([{ kind: "weight", x: -3.25, y: 0.5, ax: -3.25, ay: 3.5, len: 1.5 }]);
    const w = [...sim.entities.values()].find((e) => e.kind === "weight")!;
    stepN(sim, 60);
    const yHang = w.body.translation().y;
    expect(yHang).toBeGreaterThan(1);
    sim.explode(-3.25, 3.75, { radius: 0.4, damage: 0, knockback: 0, blockDamage: 0, terrainDamage: 600 }, "rocket", 0, 0, null);
    const evs = stepN(sim, 60);
    expect(evs.some((e) => e.type === "snap")).toBe(true);
    expect(w.body.translation().y).toBeLessThan(yHang - 0.5);
  });
});

describe("power-ups", () => {
  const hitWithRocket = (sim: ReturnType<typeof sandbox>, id: number) => {
    const f = sim.fighters[id]!;
    const p = sim.pos(f);
    f.entity.body.setLinvel({ x: 0, y: 0 }, true);
    sim.explode(p.x - 1, p.y - 0.3, WEAPONS.rocket, "rocket", 3, 0, null);
    return { hp: f.hp, speed: Math.hypot(f.entity.body.linvel().x, f.entity.body.linvel().y) };
  };

  test("shield blocks most damage and knockback, then pops after 3 hits", () => {
    const a = sandbox();
    place(a, 0, -20, 0.9);
    const plain = hitWithRocket(a, 0);
    const b = sandbox();
    place(b, 0, -20, 0.9);
    b.applyItem(b.fighters[0]!, "shield");
    const shielded = hitWithRocket(b, 0);
    expect(100 - shielded.hp).toBeLessThan((100 - plain.hp) * 0.3);
    expect(shielded.speed).toBeLessThan(plain.speed * 0.4);
    b.step(idle());
    hitWithRocket(b, 0);
    b.step(idle());
    b.events = [];
    hitWithRocket(b, 0);
    expect(b.events.some((e) => e.type === "shieldPop")).toBe(true);
    expect(b.fighters[0]!.power.shield).toBe(0);
  });

  test("heavy cuts knockback; double damage doubles damage", () => {
    const a = sandbox();
    place(a, 0, -20, 0.9);
    const plain = hitWithRocket(a, 0);
    const b = sandbox();
    place(b, 0, -20, 0.9);
    b.applyItem(b.fighters[0]!, "heavy");
    expect(hitWithRocket(b, 0).speed).toBeLessThan(plain.speed * 0.65);
    const c = sandbox();
    place(c, 0, -20, 0.9);
    c.applyItem(c.fighters[3]!, "damage");
    expect(100 - hitWithRocket(c, 0).hp).toBeCloseTo((100 - plain.hp) * POWER.damage.mul, 5);
  });

  test("speed boost makes you faster; jump power gives a double jump; health heals", () => {
    const run = (boost: boolean) => {
      const s = sandbox();
      place(s, 0, -20, 0.9);
      if (boost) s.applyItem(s.fighters[0]!, "speed");
      const inputs = idle();
      inputs[0] = { move: 1, jump: false, aimX: 1, aimY: 0, weapon: null, fire: false };
      stepN(s, 40, inputs);
      return s.pos(s.fighters[0]!).x;
    };
    expect(run(true) + 20).toBeGreaterThan((run(false) + 20) * 1.2);
    const s = sandbox();
    const f = place(s, 0, -20, 0.9);
    s.applyItem(f, "jump");
    const jump = idle();
    jump[0] = { move: 0, jump: true, aimX: 1, aimY: 0, weapon: null, fire: false };
    const evs = stepN(s, 40, jump);
    expect(evs.filter((e) => e.type === "jump" && e.air).length).toBeGreaterThanOrEqual(1);
    f.hp = 40;
    s.applyItem(f, "health");
    expect(f.hp).toBe(75);
  });

  test("a weapon pickup replaces the slot not in hand", () => {
    const s = sandbox();
    const f = s.fighters[0]!;
    f.weapons = ["rocket", "shotgun"];
    f.slot = 0;
    s.applyItem(f, "bat");
    expect(f.weapons).toEqual(["rocket", "bat"]);
    expect(s.weapon(f)).toBe("bat");
    s.applyItem(f, "bat");
    expect(f.weapons).toEqual(["rocket", "bat"]);
  });
});

describe("weapons and switching", () => {
  test("the bat launches hard (the ring-out tool) and is credited", () => {
    const s = sandbox();
    s.fighters[0]!.weapons = ["bat", "rocket"];
    place(s, 0, -20, 0.9);
    const t = place(s, 1, -18.8, 0.9);
    s.fighters[0]!.cooldown.bat = 0;
    t.hp = 30;
    const inputs = idle();
    inputs[0] = fire("bat");
    stepN(s, 1, inputs);
    const v = t.entity.body.linvel();
    expect(v.x).toBeGreaterThan(12);
    expect(v.y).toBeGreaterThan(5);
    expect(t.lastHitCause).toBe("bat");
  });

  test("the grappling hook yanks a fighter toward the shooter", () => {
    const s = sandbox();
    s.fighters[0]!.weapons = ["grapple", "bat"];
    place(s, 0, -20, 0.9);
    const t = place(s, 1, -12, 0.9);
    s.fighters[0]!.cooldown.grapple = 0;
    const inputs = idle();
    inputs[0] = fire("grapple", 1, -0.03);
    const evs = stepN(s, 1, inputs);
    expect(evs.some((e) => e.type === "grapple" && e.hit === "fighter")).toBe(true);
    expect(t.entity.body.linvel().x).toBeLessThan(-8);
    stepN(s, 25);
    expect(s.pos(t).x).toBeLessThan(-15);
  });

  test("grenades bounce and explode after their fuse", () => {
    const s = sandbox();
    s.fighters[0]!.weapons = ["grenade", "bat"];
    place(s, 0, -20, 0.9);
    s.fighters[0]!.cooldown.grenade = 0;
    const inputs = idle();
    inputs[0] = fire("grenade", 0.7, 0.7);
    stepN(s, 1, inputs);
    expect([...s.entities.values()].some((e) => e.kind === "grenade")).toBe(true);
    const evs = stepN(s, WEAPONS.grenade.fuse + 2);
    expect(evs.some((e) => e.type === "explosion" && e.kind === "grenade")).toBe(true);
  });

  test("switching weapons takes a moment (no firing during the swap)", () => {
    const s = sandbox();
    const f = s.fighters[0]!;
    f.weapons = ["rocket", "shotgun"];
    f.slot = 0;
    f.cooldown.shotgun = 0;
    const inputs = idle();
    inputs[0] = fire("shotgun");
    const evs = stepN(s, 1, inputs);
    expect(evs.some((e) => e.type === "swap" && e.weapon === "shotgun")).toBe(true);
    expect(evs.some((e) => e.type === "fire")).toBe(false);
    const evs2 = stepN(s, SWAP_TICKS + 1, inputs);
    expect(evs2.some((e) => e.type === "fire" && e.weapon === "shotgun")).toBe(true);
  });

  test("the controller picks the bat up close, rockets at range and the hook for a target on a ledge", () => {
    const m = new Match(1, [
      { target: "nearest", stance: "rush", loadout: ["bat", "rocket"], line: "x" },
      { target: "nearest", stance: "cover", loadout: ["rocket", "shotgun"], line: "x" },
      { target: "nearest", stance: "cover", loadout: ["grapple", "rocket"], line: "x" },
      { target: "nearest", stance: "cover", loadout: ["rocket", "shotgun"], line: "x" },
    ]);
    const sim = m.sim;
    const c = m.controllers[0]! as any;
    const t = sim.fighters[1]!;
    expect(c.chooseWeapon(sim, sim.fighters[0], t, 1.5, true)).toBe("bat");
    expect(c.chooseWeapon(sim, sim.fighters[0], t, 12, true)).toBe("rocket");
    const hooker = m.controllers[2]! as any;
    hooker.onLedge = () => true;
    sim.fighters[2]!.cooldown.grapple = 0;
    expect(hooker.chooseWeapon(sim, sim.fighters[2], t, 8, true)).toBe("grapple");
    hooker.noLos = 120; // a wall in the way for a while: lob or blast through it
    expect(hooker.chooseWeapon(sim, sim.fighters[2], t, 5, false)).toBe("rocket");
  });
});

describe("ring-out", () => {
  test("falling into a pit is a ring-out credited to the last hitter's weapon", () => {
    const s = sandbox();
    const f = place(s, 2, 12, 0.5);
    f.lastHitBy = 3;
    f.lastHitTick = s.tick;
    f.lastHitCause = "grapple";
    const evs = stepN(s, 120);
    const ko = evs.find((e) => e.type === "ko") as any;
    expect(ko).toBeTruthy();
    expect(ko.cause).toBe("ringout");
    expect(ko.by).toBe(3);
    expect(ko.weapon).toBe("grapple");
  });

  test("knockback grows as health drops", () => {
    const speed = (hp: number) => {
      const s = sandbox();
      const f = place(s, 0, -20, 0.9);
      f.hp = hp;
      s.explode(-21, 0.6, WEAPONS.rocket, "rocket", 1, 0, null);
      return Math.hypot(f.entity.body.linvel().x, f.entity.body.linvel().y);
    };
    expect(speed(25)).toBeGreaterThan(speed(100) * 1.8);
  });
});
