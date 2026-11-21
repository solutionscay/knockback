/**
 * Tactical context (#38): where the high ground and the cover are, what the sightlines look like, and who holds
 * long guns. One builder for every way a fighter is briefed: the round prompt (local AIs and remote/MCP seats get
 * the same prompt), the structured turn context (HTTP and MCP turns) and the mid-round check-in status.
 *
 * Before a round it reads the level as generated (the engine's tactical map: grid + nav graph, no physics). During a
 * round it reads the live fight (props, broken terrain, positions).
 */
import { NavGraph } from "../sim/nav";
import type { LevelDef } from "../sim/levelgen";
import type { RoundStats } from "../sim/roundstats";
import { CLASSIC, type Ruleset } from "../sim/ruleset";
import type { Fight } from "../sim/fight";
import { bodyHeights, hasLongGun, inCover, isLongGun, lineClear, onHighGround, TacticalMap } from "../sim/tactical";
import type { Weapon } from "../sim/sim-types";

/** Where along the level an x is, in words. */
export function whereX(x: number, minX: number, width: number): string {
  const f = (x - minX) / width;
  return f < 0.2 ? "far left" : f < 0.4 ? "left" : f <= 0.6 ? "center" : f <= 0.8 ? "right" : "far right";
}

export interface HighGround {
  where: string;
  x: number;
  /** meters above the floor around it */
  height: number;
  /** share (%) of the level's standing spots within range it can see */
  view: number;
}

export interface LevelTactics {
  /** the best perches, best view first (at most 3) */
  highGround: HighGround[];
  /** cover spots: terrain walls beside a standing spot, and crates/blocks/steel boxes to hide behind */
  cover: { walls: number; props: number; where: string[] };
  /** how open the level is: average share (%) of standing spots a fighter on the floor can see */
  openness: number;
  sightlines: string[];
  /** long guns enabled in this match, and the ones that spawn up high */
  longGuns: string[];
  longGunsUpHigh: string[];
}

const cache = new WeakMap<LevelDef, Map<Ruleset, LevelTactics>>();

/** The level's tactical summary, from the engine's tactical map (cached per level and ruleset). */
export function levelTactics(level: LevelDef, ruleset: Ruleset = CLASSIC): LevelTactics {
  let byRules = cache.get(level);
  if (!byRules) cache.set(level, (byRules = new Map()));
  const hit = byRules.get(ruleset);
  if (hit) return hit;
  const nav = NavGraph.fromGrid(level.grid, 2, ruleset);
  const map = new TacticalMap(level.grid, nav, ruleset.tactics.stances.map, bodyHeights(ruleset));
  const where = (x: number) => whereX(x, level.minX, level.width);
  // one perch per surface: its best-view point
  const perSurface = new Map<number, HighGround>();
  nav.points.forEach((p, i) => {
    if (map.rise[i]! < ruleset.tactics.stances.map.highRise) return;
    const v = Math.round(map.view(i) * 100);
    const cur = perSurface.get(p.surface);
    if (!cur || v > cur.view) perSurface.set(p.surface, { where: where(p.x), x: Math.round(p.x), height: Math.round(map.rise[i]!), view: v });
  });
  const highGround = [...perSurface.values()].sort((a, b) => b.view - a.view || b.height - a.height || a.x - b.x).slice(0, 3);
  const floor = nav.points.map((_, i) => i).filter((i) => map.rise[i]! < 1);
  const openness = floor.length ? Math.round((floor.reduce((a, i) => a + map.view(i), 0) / floor.length) * 100) : 0;
  const coverProps = level.props.filter((p) => p.kind === "block" || p.kind === "crate" || p.kind === "steel");
  const regions = new Map<string, number>();
  for (const c of map.cover) regions.set(where(c.x), (regions.get(where(c.x)) ?? 0) + 1);
  for (const p of coverProps) regions.set(where(p.x), (regions.get(where(p.x)) ?? 0) + 1);
  const coverWhere = [...regions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w);
  const sightlines: string[] = [];
  const top = highGround[0];
  if (top) sightlines.push(`the ${top.where} perch (${top.height} m up) sees ${top.view}% of the level's standing spots`);
  sightlines.push(openness >= 55 ? `the floor is open: most of it sees most of the rest` : openness >= 35 ? `the floor is broken up: some lanes are open, others hidden` : `the floor is closed in: walls and platforms block most lines`);
  const enabled = ruleset.weapons.enabled as readonly Weapon[];
  const longGuns = (ruleset.tactics.stances.longGuns as readonly Weapon[]).filter((w) => enabled.includes(w));
  const spread = ruleset.pickups.armory.spread;
  const longGunsUpHigh = spread.enabled ? (spread.powerWeapons as readonly Weapon[]).filter((w) => longGuns.includes(w)) : [];
  const out: LevelTactics = { highGround, cover: { walls: map.cover.length, props: coverProps.length, where: coverWhere }, openness, sightlines, longGuns, longGunsUpHigh };
  byRules.set(ruleset, out);
  return out;
}

/** Who picked up long guns last round, and the knockouts long guns made. */
export function longGunsLastRound(st: RoundStats, names: string[], ruleset: Ruleset = CLASSIC): { held: { name: string; guns: string[] }[]; knockouts: number } {
  const held = names
    .map((name, i) => ({ name, guns: [...new Set(st.pickups[i]!.filter((p) => isLongGun(ruleset, p as Weapon)))] }))
    .filter((h) => h.guns.length);
  return { held, knockouts: st.kos.filter((k) => isLongGun(ruleset, k.weapon as Weapon)).length };
}

/** The TACTICS paragraph of the round prompt (kept short: the prompt has a size budget). */
export function tacticsLines(t: LevelTactics, last: ReturnType<typeof longGunsLastRound> | null): string {
  const hg = t.highGround.length ? `high ground ${t.highGround.map((h) => `${h.where} ${h.height} m (sees ${h.view}%)`).join(", ")}` : "no real high ground";
  const cover = `cover ${t.cover.walls + t.cover.props} spots${t.cover.where.length ? `, most ${t.cover.where.slice(0, 2).join(" and ")}` : ""}`;
  const floor = t.openness >= 55 ? "open floor" : t.openness >= 35 ? "floor half open" : "floor closed in";
  const guns = t.longGuns.length ? `long guns ${t.longGuns.join(", ")}${t.longGunsUpHigh.length ? ` (${t.longGunsUpHigh.join(", ")} up high)` : ""}` : "no long guns";
  const lastGuns = last ? ` Last round: ${last.held.length ? last.held.map((h) => `${h.name} had ${h.guns.join("+")}`).join(", ") : "no long guns picked up"}, ${last.knockouts} long-gun KO${last.knockouts === 1 ? "" : "s"}.` : "";
  return `TACTICS: ${hg}; ${cover}; ${floor}; ${guns}. Still or in cover = accurate, moving or airborne = spread.${lastGuns}`;
}

// ------------------------------------------------------------------ during the round (check-ins)

export interface FightTactics {
  you: { inCover: boolean; highGround: boolean; longGun: boolean; canSee: string[]; seenBy: string[] };
  rivals: Record<string, { inCover: boolean; highGround: boolean; longGun: boolean }>;
  /** who holds which long gun now */
  longGuns: { name: string; guns: string[] }[];
}

/** The tactical part of a check-in: cover, high ground, long guns and who can see whom, live. */
export function fightTactics(fight: Fight, me: number, names: string[]): FightTactics {
  const sim = fight.sim;
  const f = sim.fighters[me]!;
  const rivals = sim.fighters.filter((x) => x.id !== me && x.alive && !x.removed);
  const alive = f.alive && !f.removed;
  return {
    you: {
      inCover: alive && inCover(sim, f),
      highGround: alive && onHighGround(sim, f),
      longGun: alive && hasLongGun(sim, f),
      canSee: alive ? rivals.filter((r) => lineClear(sim, f, r)).map((r) => names[r.id]!) : [],
      seenBy: alive ? rivals.filter((r) => lineClear(sim, r, f)).map((r) => names[r.id]!) : [],
    },
    rivals: Object.fromEntries(rivals.map((r) => [names[r.id]!, { inCover: inCover(sim, r), highGround: onHighGround(sim, r), longGun: hasLongGun(sim, r) }])),
    longGuns: sim.fighters
      .filter((x) => x.alive && !x.removed)
      .map((x) => ({ name: x.id === me ? "you" : names[x.id]!, guns: x.weapons.filter((w) => isLongGun(sim.ruleset, w)) }))
      .filter((x) => x.guns.length),
  };
}

/** One line for the check-in prompt. */
export function fightTacticsLine(t: FightTactics): string {
  const me = [t.you.inCover ? "in cover" : "in the open", t.you.highGround ? "on high ground" : ""].filter(Boolean).join(", ");
  const guns = t.longGuns.length ? t.longGuns.map((g) => `${g.name} ${g.guns.join("+")}`).join(", ") : "nobody";
  const covered = Object.entries(t.rivals).filter(([, r]) => r.inCover).map(([n]) => n);
  const high = Object.entries(t.rivals).filter(([, r]) => r.highGround).map(([n]) => n);
  return `TACTICS: you are ${me}. Long guns: ${guns}. You can see ${t.you.canSee.join(", ") || "nobody"}; seen by ${t.you.seenBy.join(", ") || "nobody"}.${covered.length ? ` In cover: ${covered.join(", ")}.` : ""}${high.length ? ` On high ground: ${high.join(", ")}.` : ""}`;
}
