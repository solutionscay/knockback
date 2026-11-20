import { beforeAll, describe, expect, test } from "bun:test";
import { CHAIN, initPhysics, Match, type Input } from "../src/sim";
import { chainAttach } from "../src/sim/sim-chains";
import { damagePiece } from "../src/sim/sim-terrain";
import { ChainView } from "../src/viewer/chains";
import { idle, place, sandbox, stepN } from "./helpers";

beforeAll(async () => {
  await initPhysics();
});

// The sandbox platform: steel, y 3.5..4, x -6..0, chains at x -5.75 (chain 0) and -0.25 (chain 1), pivots at y 10.
const fire = (weapon: Input["weapon"], aimX = 1, aimY = 0): Input => ({ move: 0, jump: false, aimX, aimY, weapon, fire: true });
const only = (id: number, input: Input): Input[] => idle().map((x, i) => (i === id ? input : x));

describe("breakable chains (#34)", () => {
  test("every anchor cell gets a chain with full hit points and a pivot above it", () => {
    const sim = sandbox();
    expect(sim.chains.length).toBe(2);
    for (const ch of sim.chains) {
      expect(ch.hp).toBe(CHAIN.hp);
      expect(ch.broken).toBe(false);
      expect(ch.piece).toBe(-1);
      expect(ch.py).toBe(4 + CHAIN.length);
    }
    expect(sim.chains[0]!.px).toBe(-5.75);
    expect(sim.chains[1]!.px).toBe(-0.25);
  });

  test("shotgun pellets go through a chain and chip it; enough of them break it and the platform swings", () => {
    const sim = sandbox();
    sim.fighters[0]!.weapons = ["shotgun", "fist"];
    place(sim, 0, -2, 4 + 0.9); // standing on the platform, the left chain 3.75 m away
    const ch = sim.chains[0]!;
    const evs = stepN(sim, 1, only(0, fire("shotgun", -1, 0)));
    expect(evs.some((e) => e.type === "pellet")).toBe(true);
    expect(ch.hp).toBeLessThan(CHAIN.hp);
    expect(ch.lastHitBy).toBe(0);
    let all = evs;
    for (let i = 0; i < 12 && !ch.broken; i++) {
      all = all.concat(stepN(sim, 60, only(0, fire("shotgun", -1, 0))));
    }
    expect(ch.broken).toBe(true);
    expect(all.find((e) => e.type === "chainBreak")).toMatchObject({ chain: 0, cause: "shotgun", by: 0 });
    stepN(sim, 2);
    expect(sim.chains[1]!.piece).toBeGreaterThan(0); // hanging from the other chain now
  });

  test("a bat breaks a chain in a few swings; plain fists don't scratch it, heavy fists do", () => {
    const sim = sandbox();
    const ch = sim.chains[1]!;
    sim.fighters[1]!.weapons = ["bat", "fist"];
    sim.fighters[1]!.slot = 0;
    place(sim, 1, -1.0, 4 + 0.9);
    stepN(sim, 1, only(1, fire("bat", 1, 0.5)));
    expect(ch.hp).toBe(CHAIN.hp - CHAIN.batDamage);
    stepN(sim, 60, only(1, fire("bat", 1, 0.5)));
    expect(ch.broken).toBe(true);
    expect(ch.cause).toBe("bat");

    const sim2 = sandbox();
    const ch2 = sim2.chains[1]!;
    place(sim2, 1, -1.0, 4 + 0.9);
    stepN(sim2, 60, only(1, fire("fist", 1, 0.5)));
    expect(ch2.hp).toBe(CHAIN.hp);
    stepN(sim2, 30); // fist cooldown
    sim2.fighters[1]!.power.heavy = 600;
    stepN(sim2, 1, only(1, fire("fist", 1, 0.5)));
    expect(ch2.hp).toBeLessThan(CHAIN.hp);
  });

  test("an explosion next to a chain breaks it; damage falls off with distance", () => {
    const sim = sandbox();
    const soft = { radius: 3, damage: 0, knockback: 0, blockDamage: 40, terrainDamage: 0 };
    sim.explode(-5.75 + 2.4, 7, soft, "grenade", 2, 0, null); // 2.4 m from chain 0: a scratch
    const ch = sim.chains[0]!;
    expect(ch.hp).toBeCloseTo(CHAIN.hp - 40 * (1 - 2.4 / 3), 6);
    expect(sim.chains[1]!.hp).toBe(CHAIN.hp); // 3.1 m away: untouched
    sim.explode(-5.75, 7, soft, "grenade", 2, 0, null);
    expect(ch.broken).toBe(true);
    expect(ch.breakY).toBeCloseTo(7, 6);
    const evs = stepN(sim, 2);
    expect(evs.some((e) => e.type === "platformSwing")).toBe(true);
  });

  test("a swinging platform stays on its chain, swings, and its pieces keep the chain through splits", () => {
    const sim = sandbox();
    const soft = { radius: 1, damage: 0, knockback: 0, blockDamage: 100, terrainDamage: 0 };
    sim.explode(-5.75, 8, soft, "grenade", 2, 0, null);
    stepN(sim, 2);
    const ch = sim.chains[1]!;
    const piece = sim.entities.get(ch.piece)!;
    expect(piece.kind).toBe("chunk");
    let maxTurn = 0;
    for (let i = 0; i < 90; i++) {
      stepN(sim, 1);
      const a = chainAttach(sim, ch);
      expect(Math.hypot(a.x - ch.px, a.y - ch.py)).toBeLessThan(CHAIN.length + 0.05); // the rope never stretches
      maxTurn = Math.max(maxTurn, Math.abs(piece.body.rotation()));
    }
    expect(maxTurn).toBeGreaterThan(0.6); // the loose end swung down
    // knock a cell off the free end: the part with the chain cell still hangs
    const far = piece.cells!.find((c) => c.chain === undefined && c.lx === 0)!;
    expect(far).toBeDefined();
    const t = piece.body.translation();
    damagePiece(sim, piece, t.x, t.y, 0.01, 1e6); // the cell at the body's origin corner
    stepN(sim, 2);
    expect(ch.broken).toBe(false);
    const holder = sim.entities.get(ch.piece)!;
    expect(holder.dead).toBe(false);
    expect(holder.cells!.some((c) => c.chain === ch.id)).toBe(true);
  });

  test("both chains breaking at once drop the platform: it crushes a fighter below, credited to the breaker", () => {
    const sim = sandbox();
    place(sim, 3, -3, 0.9); // under the middle of the platform
    const hp0 = sim.fighters[3]!.hp;
    const big = { radius: 3, damage: 0, knockback: 0, blockDamage: 1000, terrainDamage: 0 };
    sim.explode(-3, 8, big, "rocket", 0, 0, null); // fighter 0's blast reaches both chains (2.75 m each)
    expect(sim.chains.every((c) => c.broken)).toBe(true);
    const evs = stepN(sim, 60);
    const fall = evs.find((e) => e.type === "platformFall");
    expect(fall).toMatchObject({ by: 0 });
    expect(evs.some((e) => e.type === "platformSwing")).toBe(false);
    const crush = evs.filter((e) => e.type === "hit" && e.target === 3 && e.cause === "crush");
    expect(crush.length).toBeGreaterThan(0);
    expect(crush[0]).toMatchObject({ source: 0 });
    expect(sim.fighters[3]!.hp).toBeLessThan(hp0);
    expect(sim.stats.platformsDropped).toBe(1);
  });

  test("a swinging platform whose last chain snaps falls, credited to whoever broke it", () => {
    const sim = sandbox();
    const soft = { radius: 1, damage: 0, knockback: 0, blockDamage: 100, terrainDamage: 0 };
    sim.explode(-5.75, 8, soft, "grenade", 2, 0, null);
    stepN(sim, 30);
    const ch = sim.chains[1]!;
    const piece = sim.entities.get(ch.piece)!;
    sim.explode(ch.px, ch.py - 1, soft, "grenade", 1, 0, null);
    const evs = stepN(sim, 1);
    expect(evs.find((e) => e.type === "platformFall")).toMatchObject({ entity: piece.id, by: 1 });
    expect(piece.triggeredBy).toBe(1);
    expect(ch.joint).toBeNull();
  });

  test("an anchor cell destroyed under a hanging platform breaks that chain and it falls", () => {
    const sim = sandbox();
    const soft = { radius: 1, damage: 0, knockback: 0, blockDamage: 100, terrainDamage: 0 };
    sim.explode(-0.25, 8, soft, "grenade", 2, 0, null); // chain 1 goes: hangs from chain 0
    stepN(sim, 30);
    const ch = sim.chains[0]!;
    const piece = sim.entities.get(ch.piece)!;
    const cell = piece.cells!.find((c) => c.chain === 0)!;
    const t = piece.body.translation();
    const a = piece.body.rotation();
    const lx = (cell.lx + 0.5) * 0.5, ly = (cell.ly + 0.5) * 0.5;
    damagePiece(sim, piece, t.x + lx * Math.cos(a) - ly * Math.sin(a), t.y + lx * Math.sin(a) + ly * Math.cos(a), 0.01, 1e6);
    const evs = stepN(sim, 2);
    expect(ch.broken).toBe(true);
    expect(evs.find((e) => e.type === "chainBreak")).toMatchObject({ chain: 0, cause: "anchor" });
  });

  test("chains break in real matches, and a match with chain breaks replays to the same hashes", () => {
    const m = new Match(5);
    let breaks = 0;
    m.onEvent = (e) => {
      if (e.type === "chainBreak") breaks++;
    };
    m.playToEnd();
    expect(breaks).toBeGreaterThan(0);
    const again = new Match(5);
    again.playToEnd();
    expect(again.record.rounds.map((r) => r.fight.finalHash)).toEqual(m.record.rounds.map((r) => r.fight.finalHash));
  });

  test("viewer: a chain sprite is laid from its fixed end along the segment (screen y down)", () => {
    const s = { visible: false, rotation: 0, height: 0, position: { x: 0, y: 0, set(x: number, y: number) { this.x = x; this.y = y; } }, tilePosition: { y: 3 } };
    const lay = (x0: number, y0: number, x1: number, y1: number) => ChainView.lay(s as never, x0, y0, x1, y1);
    lay(1, 2, 1, 8); // straight up from (1, 2)
    expect(s.visible).toBe(true);
    expect(s.height).toBeCloseTo(6, 9);
    expect([s.position.x, s.position.y]).toEqual([1, -2]);
    // the sprite's +y axis, (-sin r, cos r), points up the screen
    expect(-Math.sin(s.rotation)).toBeCloseTo(0, 9);
    expect(Math.cos(s.rotation)).toBeCloseTo(-1, 9);
    lay(0, 0, 3, -4); // down and to the right
    expect(s.height).toBeCloseTo(5, 9);
    expect(-Math.sin(s.rotation)).toBeCloseTo(0.6, 9);
    expect(Math.cos(s.rotation)).toBeCloseTo(0.8, 9);
    expect(s.tilePosition.y).toBe(0); // links start at the fixed end
    lay(2, 2, 2, 2);
    expect(s.visible).toBe(false);
  });
});
