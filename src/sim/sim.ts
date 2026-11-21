/**
 * Knockback simulation core. Pure TypeScript + Rapier (deterministic build).
 * No rendering, no wall clock, no Math.random: same seed + same inputs =
 * same state, in Bun and in the browser.
 *
 * The level is procedurally generated from the seed (levelgen.ts) and almost
 * all of it can be destroyed (terrain.ts). Trig is only done through the
 * polynomial dsin/dcos (dmath.ts), so the JS side does not drift between engines.
 */
import RAPIER from "@dimforge/rapier2d-deterministic-compat";
import { DT, G, groups, type Blast } from "./constants";
import { Mat, type Grid } from "./grid";
import { generateLevel, type LevelDef } from "./levelgen";
import { type PropKind } from "./level-config";
import { NavGraph } from "./nav";
import { CLASSIC, type Ruleset } from "./ruleset";
import { Rng } from "./rng";
import { explode } from "./sim-blast";
import { damageFighter, kbMult, knockOut, removeFighterBody } from "./sim-damage";
import { EntityStore } from "./sim-entities";
import { applyItem, checkPickups, items, randomPower, setPrefs, spawnItem, skyDrop, stockArmory, supplyDrop, tickPowers, wantsWeapon } from "./sim-items";
import { addFighter, applyInput, checkGrounded } from "./sim-movement";
import { addProp, dangers, updateObjects } from "./sim-objects";
import { crumbleUnder, flushTerrain } from "./sim-terrain";
import { buildChains, updateChains, type Chain } from "./sim-chains";
import { updateFire } from "./sim-fire";
import { type CellFire } from "./sim-ignite";
import { ALL_WEAPONS, AMMO_WEAPONS, NO_INPUT, SEAT_LOOKS, type Entity, type ExplosionKind, type Fighter, type Input, type ItemType, type LiveGround, type Mine, type Rocket, type SimEvent, type Weapon } from "./sim-types";
import { type Look } from "./identity";
import { updateLiveGround } from "./sim-lightning";
import { updateMines } from "./sim-mines";
import { updateRockets } from "./sim-weapons";
import { SimZone, zoneHalfAt, zonePush } from "./sim-zone";
import { bodyHeights, TacticalMap } from "./tactical";
import { Terrain } from "./terrain";


let rapierReady: Promise<void> | null = null;
export function initPhysics(): Promise<void> {
  if (!rapierReady) rapierReady = RAPIER.init();
  return rapierReady;
}

const ALL = 0xffff;
const SHOT_FILTER = groups(ALL, G.TERRAIN | G.FIGHTER | G.PROP);

export class Sim {
  readonly level: LevelDef;
  readonly grid: Grid;
  nav: NavGraph;
  /** Cover spots, high ground and sightlines (#38): rebuilt with the nav graph when terrain breaks. */
  tactical: TacticalMap;
  /** Highest walkable surface at the start of the round (#41: soft ceiling and jetpack ceiling are measured from it). */
  readonly topY: number;
  navVersion = 0;
  private lastNavTick = -999;
  readonly rng: Rng;
  /** the sky drops' own stream of the round seed (#16) */
  private readonly skyRng: Rng;
  readonly world: RAPIER.World;
  readonly terrain: Terrain;
  tick = 0;
  fighters: Fighter[] = [];
  readonly entityStore: EntityStore;
  get entities() {
    return this.entityStore.entities;
  }
  rockets: Rocket[] = [];
  mines: Mine[] = [];
  /** platform chains (#34), grid scan order */
  readonly chains: Chain[];
  /** static anchor cell index -> its chain */
  readonly chainByCell = new Map<number, Chain>();
  /** burning static cells (#33): grid index -> fire */
  readonly fires = new Map<number, CellFire>();
  /** live ground (#72): floor strips electrified by lightning bolts, in the order they were made */
  liveGround: LiveGround[] = [];
  events: SimEvent[] = [];
  zone: { center: number; half: number; startHalf: number };
  /** Sandbox switch (tests): when false the zone neither shrinks nor pushes. */
  zoneEnabled = true;
  /** The round is decided (set by the fight once one fighter or none is left): the walls stop, no more supply drops. */
  roundOver = false;
  private supplyCount = 0;
  /** last tick a fighter damaged another fighter (anti-stalemate clock) */
  lastClashTick: number;
  /** tick sudden death started this round, or -1 */
  suddenDeath = -1;
  private readonly zoneBehavior = new SimZone();
  readonly initialCells: number;
  stats = {
    blocksDestroyed: 0,
    cratesDestroyed: 0,
    barrelsExploded: 0,
    tntExploded: 0,
    gasLaunched: 0,
    glassShattered: 0,
    weightsDropped: 0,
    bounces: 0,
    chainBarrels: 0,
    barrelToBarrel: 0,
    explosions: 0,
    propsDropped: 0,
    cellsDestroyed: 0,
    cellsDetached: 0,
    piecesFallen: 0,
    platformsFallen: 0,
    chainsBroken: 0,
    platformsSwung: 0,
    platformsDropped: 0,
    firesStarted: 0,
    cellsIgnited: 0,
    cellsBurnedDown: 0,
    cellsBurnedOut: 0,
    propsIgnited: 0,
    propsBurnedOff: 0,
    fightersIgnited: 0,
    flamePulses: 0,
  };

  constructor(seed: number, level?: LevelDef, looks: Look[] = SEAT_LOOKS, readonly ruleset: Ruleset = CLASSIC) {
    this.lastClashTick = ruleset.zone.suddenDeath.graceTicks > 0 ? -1 : 0;
    this.level = level ?? generateLevel(seed, undefined, ruleset);
    this.grid = this.level.grid.clone();
    this.rng = new Rng(seed);
    this.skyRng = new Rng((seed ^ 0x2545f491) >>> 0);
    this.world = new RAPIER.World({ x: 0, y: -this.ruleset.combat.gravity });
    this.world.timestep = DT;
    this.entityStore = new EntityStore(this.world);
    this.terrain = new Terrain(this.world, this.grid);
    this.chains = buildChains(this);
    for (const ch of this.chains) this.chainByCell.set(this.grid.idx(ch.cx, ch.cy), ch);
    this.nav = NavGraph.fromGrid(this.grid, 2, this.ruleset);
    this.tactical = new TacticalMap(this.grid, this.nav, this.ruleset.tactics.stances.map, bodyHeights(this.ruleset));
    this.topY = this.nav.surfaces.reduce((top, s) => Math.max(top, s.y), 0);
    this.navVersion = this.terrain.version;
    this.initialCells = this.grid.countSolid() - this.grid.countMat(Mat.Bedrock);
    const startHalf = this.level.width / 2 - this.ruleset.zone.boundary.edgeInset;
    this.zone = { center: this.level.zoneCenter, half: startHalf, startHalf };
    for (const p of this.level.props) this.addProp(p.kind, p.x, p.y, p);
    // two power-ups waiting up high: a reason to climb
    const high = this.nav.surfaces.filter((s) => s.y > 3.5 && s.x1 - s.x0 >= 2 && Math.abs((s.x0 + s.x1) / 2 - this.zone.center) < 18);
    for (let i = 0; i < 2 && high.length; i++) {
      const s = high.splice(this.rng.int(0, high.length - 1), 1)[0]!;
      const power = randomPower(this.rng, this.ruleset);
      if (power) this.spawnItem(power, (s.x0 + s.x1) / 2, s.y + 0.4);
    }
    // seat order is shuffled by seed so no seat owns a spawn
    const spawns = this.rng.shuffle(this.level.spawns.slice());
    for (let i = 0; i < 4; i++) addFighter(this, i, looks[i] ?? SEAT_LOOKS[i]!, spawns[i]!.x, spawns[i]!.y);
    stockArmory(this, spawns);
  }

  addProp(kind: PropKind, x: number, yBottom: number, spec?: { ax?: number; ay?: number; len?: number }): Entity {
    return addProp(this, kind, x, yBottom, spec);
  }

  setPrefs(id: number, prefs: readonly Weapon[]) {
    setPrefs(this, id, prefs);
  }

  wantsWeapon(f: Fighter, w: Weapon): boolean {
    return wantsWeapon(f, w);
  }

  spawnItem(type: ItemType, x: number, y: number, vx = 0, vy = 0): Entity {
    return spawnItem(this, type, x, y, vx, vy);
  }

  applyItem(f: Fighter, item: ItemType) {
    return applyItem(this, f, item);
  }

  items(): Entity[] {
    return items(this);
  }

  explode(x: number, y: number, spec: Blast, kind: ExplosionKind, owner: number, depth: number, chainFrom: string | null) {
    explode(this, x, y, spec, kind, owner, depth, chainFrom);
  }

  damageFighter(f: Fighter, dmg: number, source: number, kbx: number, kby: number, cause: string, hx: number, hy: number) {
    damageFighter(this, f, dmg, source, kbx, kby, cause, hx, hy);
  }

  kbMult(hp: number): number {
    return kbMult(hp, this.ruleset);
  }

  dangers(): { x: number; y: number; r: number }[] {
    return dangers(this);
  }

  /** Zone half-width `ticks` from now (sudden death included): where to stand. */
  zoneHalfAhead(ticks: number): number {
    return this.zoneBehavior.halfAhead(this, ticks);
  }

  // ----------------------------------------------------------------- queries

  /** After the opening grace and quiet window, push for contact without announcing sudden death. */
  get openingPressure(): boolean {
    const sd = this.ruleset.zone.suddenDeath;
    return this.zoneEnabled && this.lastClashTick < 0 && this.tick >= sd.graceTicks + sd.quietTicks;
  }

  alive(): Fighter[] {
    return this.fighters.filter((f) => f.alive);
  }

  pos(f: Fighter): { x: number; y: number } {
    const t = f.entity.body.translation();
    return { x: t.x, y: t.y };
  }

  vel(f: Fighter): { x: number; y: number } {
    const v = f.entity.body.linvel();
    return { x: v.x, y: v.y };
  }

  feetY(f: Fighter): number {
    return f.entity.body.translation().y - this.ruleset.combat.fighter.halfHeight - this.ruleset.combat.fighter.radius;
  }

  weapon(f: Fighter): Weapon {
    return f.weapons[f.slot];
  }

  entityOf(c: RAPIER.Collider): Entity | undefined {
    return this.entityStore.entityOf(c);
  }

  /** First thing hit by a ray. entity null + terrain true = static level cells. */
  raycast(x: number, y: number, dx: number, dy: number, maxDist: number, exclude?: RAPIER.Collider) {
    const ray = new RAPIER.Ray({ x, y }, { x: dx, y: dy });
    const hit = this.world.castRay(ray, maxDist, true, undefined, SHOT_FILTER, exclude);
    if (!hit) return null;
    const entity = this.entityOf(hit.collider) ?? null;
    return { dist: hit.timeOfImpact, entity, terrain: !entity };
  }

  /** Share of the original destructible cells destroyed or knocked loose. */
  destroyedShare(): number {
    return (this.stats.cellsDestroyed + this.stats.cellsDetached) / Math.max(1, this.initialCells);
  }

  // -------------------------------------------------------------------- step

  step(inputs: readonly Input[]) {
    const tick = this.tick;
    const z = this.zone;
    if (this.zoneEnabled && !this.roundOver) {
      z.half = zoneHalfAt(tick, z.startHalf, this.ruleset);
      this.zoneBehavior.checkStalemate(this, tick);
    }
    const opening = this.ruleset.pickups.armory.spread;
    if (!this.roundOver && opening.enabled && opening.skyDrops > 0 && tick === opening.skyDropTicks) skyDrop(this, this.skyRng);
    if (!this.roundOver && tick >= this.ruleset.pickups.supply.firstTick && (tick - this.ruleset.pickups.supply.firstTick) % this.ruleset.pickups.supply.interval === 0) supplyDrop(this, this.supplyCount++);

    for (const f of this.fighters) {
      if (!f.alive) continue;
      tickPowers(this, f);
      applyInput(this, f, inputs[f.id] ?? NO_INPUT);
      if (!this.roundOver) zonePush(this, f);
      else {
        // the walls stopped: nobody is outside any more (a winner caught outside at the decision included)
        f.outsideZone = false;
        f.outsideTicks = 0;
      }
    }
    this.softCeiling();
    updateRockets(this);
    updateMines(this);
    updateObjects(this);
    updateChains(this);
    updateFire(this);
    updateLiveGround(this);
    flushTerrain(this);

    const pre: { x: number; y: number }[] = this.fighters.map((f) => (f.removed ? { x: 0, y: 0 } : this.vel(f)));
    this.world.step();

    for (const f of this.fighters) {
      if (f.removed) continue;
      const p = this.pos(f);
      if (!f.alive) {
        if (p.y < this.ruleset.combat.fighter.ringOutY - 6 || tick - f.koTick > 150) removeFighterBody(this, f);
        continue;
      }
      const v = this.vel(f);
      const wasGrounded = f.grounded;
      f.grounded = checkGrounded(this, f);
      if (f.grounded) {
        f.airJumped = false;
        const s = this.nav.surfaceAt(p.x, this.feetY(f));
        if (s) f.surface = s.id;
        if (!wasGrounded && pre[f.id]!.y < -4) this.events.push({ type: "land", tick, fighter: f.id, speed: -pre[f.id]!.y });
        crumbleUnder(this, f, p.x);
      }
      const ex = pre[f.id]!.x;
      const ey = pre[f.id]!.y - this.ruleset.combat.gravity * DT;
      const dv = Math.sqrt((v.x - ex) * (v.x - ex) + (v.y - ey) * (v.y - ey));
      if (dv > this.ruleset.combat.fighter.impactThreshold) {
        const dmg = (dv - this.ruleset.combat.fighter.impactThreshold) * this.ruleset.combat.fighter.impactDamagePerMs;
        const src = tick - f.lastHitTick < this.ruleset.combat.attributionTicks ? f.lastHitBy : -1;
        this.events.push({ type: "impact", tick, fighter: f.id, damage: dmg, x: p.x, y: p.y });
        this.damageFighter(f, dmg, src, 0, 0, "impact", p.x, p.y);
        if (!f.alive) continue;
      }
      const ringX = this.level.width / 2 + this.ruleset.combat.fighter.ringOutMargin;
      if (p.y < this.ruleset.combat.fighter.ringOutY || p.x < -ringX || p.x > ringX) {
        knockOut(this, f, "ringout", p.x, p.y);
        continue;
      }
      checkPickups(this, f, p.x, p.y);
    }
    // world-out and debris cleanup
    for (const e of [...this.entities.values()]) {
      if (e.dead || e.kind === "fighter") continue;
      const t = e.body.translation();
      if (t.y < -25 || t.x < -70 || t.x > 70) {
        this.entityStore.remove(e);
        continue;
      }
      if (e.kind === "chunk" && e.cells!.length <= this.ruleset.arena.terrain.debris.smallCells && tick - e.born > this.ruleset.arena.terrain.debris.smallTicks) {
        this.events.push({ type: "break", tick, entity: e.id, kind: "chunk", x: t.x, y: t.y, hw: e.hw, hh: e.hh });
        this.entityStore.remove(e);
      }
    }
    if (this.terrain.version !== this.navVersion && tick - this.lastNavTick >= 20) this.rebuildNav();
    this.tick++;
  }

  /** #41: above the soft ceiling, upward speed decays (air drag) instead of hitting a wall. */
  private softCeiling() {
    const launch = this.ruleset.combat.launch;
    if (launch.ceilingDrag <= 0) return;
    const keep = Math.max(0, 1 - launch.ceilingDrag * DT);
    const ceiling = this.topY + launch.ceilingAbove;
    for (const f of this.fighters) {
      if (f.removed) continue;
      const v = f.entity.body.linvel();
      if (v.y > 0 && this.feetY(f) > ceiling) f.entity.body.setLinvel({ x: v.x, y: v.y * keep }, true);
    }
  }

  private rebuildNav() {
    this.nav = NavGraph.fromGrid(this.grid, 2, this.ruleset);
    this.tactical = new TacticalMap(this.grid, this.nav, this.ruleset.tactics.stances.map, bodyHeights(this.ruleset));
    this.navVersion = this.terrain.version;
    this.lastNavTick = this.tick;
    for (const f of this.fighters) {
      if (!f.alive) continue;
      const p = this.pos(f);
      const s = this.nav.surfaceAt(p.x, this.feetY(f), 1);
      f.surface = s ? s.id : -1;
    }
  }

  // -------------------------------------------------------------------- hash

  /** FNV-1a over the Rapier snapshot, the grid, and all game state. */
  hash(): string {
    let h = 0x811c9dc5;
    const mix = (b: number) => {
      h ^= b & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    };
    const snap = this.world.takeSnapshot();
    for (let i = 0; i < snap.length; i++) mix(snap[i]!);
    const g = this.grid;
    for (let i = 0; i < g.mat.length; i++) mix(g.mat[i]!);
    const hb = new Uint8Array(g.hp.buffer);
    for (let i = 0; i < hb.length; i += 8) for (let k = 0; k < 8; k++) mix(hb[i + k]!);
    const buf = new DataView(new ArrayBuffer(8));
    const num = (n: number) => {
      buf.setFloat64(0, n);
      for (let i = 0; i < 8; i++) mix(buf.getUint8(i));
    };
    num(this.tick);
    num(this.suddenDeath);
    num(this.lastClashTick);
    for (const f of this.fighters) {
      num(f.hp);
      num(f.alive ? 1 : 0);
      num(f.stun);
      num(f.slot);
      num(ALL_WEAPONS.indexOf(f.weapons[0]) * 10 + ALL_WEAPONS.indexOf(f.weapons[1]));
      for (const w of ALL_WEAPONS) num(f.cooldown[w]);
      num(f.power.shield + f.power.speed * 1e3 + f.power.heavy * 1e6 + f.power.damage * 1e9 + f.power.jump * 1e12);
      num(f.power.jetpack);
      num(f.jetting ? 1 : 0);
      num(f.aimX);
      num(f.aimY);
      num(f.burning);
      num(f.burnBy);
      num(f.fuel);
      num(f.railCharge);
      num(f.scope);
      num(f.pinned);
      num(f.shockCd);
      for (const weapon of AMMO_WEAPONS) num(f.ammo[weapon]);
    }
    for (const r of this.rockets) {
      num(r.x);
      num(r.y);
      num(r.vx);
      num(r.vy);
    }
    for (const m of this.mines) {
      for (const value of [m.id, m.owner, m.x, m.y, m.vx, m.vy, m.born, m.armedAt]) num(value);
      if (m.mount?.kind === "terrain") {
        num(1); num(m.mount.cx); num(m.mount.cy);
      } else if (m.mount?.kind === "entity") {
        num(2); num(m.mount.id); num(m.mount.x); num(m.mount.y);
      } else num(0);
    }
    for (const e of this.entities.values()) {
      num(e.id);
      num(e.ammo ?? -1);
      num(e.hp);
      num(e.fuse ?? -1);
      num(e.thrust ?? -1);
      num(e.burn ?? 0);
      if (e.cells) for (const c of e.cells) num(c.hp + (c.burn ?? 0) * 1e3 + (c.charred ? 1e6 : 0));
    }
    for (const [i, fire] of [...this.fires.entries()].sort((a, b) => a[0] - b[0])) {
      num(i);
      num(fire.burn);
      num(fire.by);
    }
    for (const strip of this.liveGround) {
      for (const value of [strip.id, strip.owner, strip.born, strip.ticks, strip.points.length]) num(value);
      for (const p of strip.points) {
        num(p.x);
        num(p.y);
      }
    }
    for (let i = 0; i < g.flags.length; i++) if (g.flags[i]) num(i * 8 + g.flags[i]!);
    for (const ch of this.chains) {
      num(ch.hp);
      num(ch.piece);
    }
    for (const s of this.rng.state()) num(s);
    for (const s of this.skyRng.state()) num(s);
    return h.toString(16).padStart(8, "0");
  }
}
