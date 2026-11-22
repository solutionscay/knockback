/**
 * Round stats: who damaged whom, how, from which side and range; knockouts;
 * pickups; time near each rival; who each fighter chased. Plus one plain
 * sentence per fighter about its round. Built from sim events (no
 * randomness), so fighters (and AIs) can look back and re-plan.
 */

export type Range = "close" | "mid" | "long";

export interface HitStat {
  /** distinct hits (one per tick: a shotgun blast is one hit) */
  hits: number;
  damage: number;
  fromBehind: number;
  byWeapon: Record<string, { hits: number; damage: number }>;
  byRange: Record<Range, number>;
}

export interface RoundStats {
  /** damage[attacker][victim] */
  damage: HitStat[][];
  /** seconds each pair spent within NEAR_M of each other (symmetric) */
  nearSeconds: number[][];
  /** seconds each fighter spent with each rival as its target: targetSeconds[me][them] */
  targetSeconds: number[][];
  pickups: string[][];
  /** each pickup with the tick it happened */
  pickupTicks: { item: string; tick: number }[][];
  kos: { victim: number; by: number; weapon: string; cause: "ringout" | "hp"; tick?: number; /** meters between them at the knocking-out hit (#38), when a fighter made it */ range?: number }[];
  /** seconds each fighter played each stance with a weapon in hand (sampled; #38) */
  stanceSeconds: Record<string, number>[];
  /** of those, seconds spent in cover (tactical.ts inCover), per stance (#38) */
  coverSeconds: Record<string, number>[];
  /** average distance (m) to whoever the fighter was chasing, sampled; -1 if never sampled */
  targetDistance: number[];
  /** plan rule firings (#6): rules[fighter][rule index] = times started and ticks active */
  rules: { fires: number; activeTicks: number }[][];
  /** back-attack reflex firings per fighter */
  reflexes: { tick: number; attacker: number; mode: "glance" | "fight" | "switch" }[][];
  /** one plain line per fighter, second person */
  summary: string[];
}

export const NEAR_M = 7;
export const SAMPLE_TICKS = 30;

export function rangeOf(d: number): Range {
  return d < 4 ? "close" : d < 12 ? "mid" : "long";
}

const empty = (): HitStat => ({ hits: 0, damage: 0, fromBehind: 0, byWeapon: {}, byRange: { close: 0, mid: 0, long: 0 } });

export class StatsCollector {
  damage: HitStat[][] = [0, 1, 2, 3].map(() => [0, 1, 2, 3].map(empty));
  nearSeconds = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
  targetSeconds = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
  pickups: string[][] = [[], [], [], []];
  pickupTicks: { item: string; tick: number }[][] = [[], [], [], []];
  private ruleAcc: { fires: number; activeTicks: number; since: number }[][] = [[], [], [], []];
  private distSum = [0, 0, 0, 0];
  private distN = [0, 0, 0, 0];
  private lastHitTick = [0, 1, 2, 3].map(() => [-1, -1, -1, -1]);
  stanceSeconds: Record<string, number>[] = [{}, {}, {}, {}];
  coverSeconds: Record<string, number>[] = [{}, {}, {}, {}];

  hit(attacker: number, victim: number, damage: number, weapon: string, distance: number, fromBehind: boolean, tick: number) {
    const s = this.damage[attacker]![victim]!;
    s.damage += damage;
    const w = (s.byWeapon[weapon] ??= { hits: 0, damage: 0 });
    w.damage += damage;
    if (this.lastHitTick[attacker]![victim] === tick) return;
    this.lastHitTick[attacker]![victim] = tick;
    s.hits++;
    w.hits++;
    if (fromBehind) s.fromBehind++;
    s.byRange[rangeOf(distance)]++;
  }

  /** `stances` (the stance each fighter plays now) and `cover` (in cover now) feed the per-stance cover time (#38). */
  sample(positions: ({ x: number; y: number } | null)[], targets: number[], stances?: string[], cover?: boolean[]) {
    const dt = SAMPLE_TICKS / 60;
    for (let i = 0; i < 4; i++) {
      const a = positions[i];
      if (!a) continue;
      const st = stances?.[i];
      if (st) {
        this.stanceSeconds[i]![st] = (this.stanceSeconds[i]![st] ?? 0) + dt;
        if (cover?.[i]) this.coverSeconds[i]![st] = (this.coverSeconds[i]![st] ?? 0) + dt;
      }
      const t = targets[i]!;
      if (t >= 0 && t !== i) {
        this.targetSeconds[i]![t]! += dt;
        const b = positions[t];
        if (b) {
          this.distSum[i]! += Math.hypot(a.x - b.x, a.y - b.y);
          this.distN[i]!++;
        }
      }
      for (let j = i + 1; j < 4; j++) {
        const b = positions[j];
        if (!b) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) < NEAR_M) {
          this.nearSeconds[i]![j]! += dt;
          this.nearSeconds[j]![i]! += dt;
        }
      }
    }
  }

  /** A rule event (#6). Rules still active when the round ends count until then. */
  rule(fighter: number, rule: number, on: boolean, tick: number) {
    const acc = this.ruleAcc[fighter]!;
    while (acc.length <= rule) acc.push({ fires: 0, activeTicks: 0, since: -1 });
    const r = acc[rule]!;
    if (on) {
      r.fires++;
      r.since = tick;
    } else if (r.since >= 0) {
      r.activeTicks += tick - r.since;
      r.since = -1;
    }
  }

  pickup(fighter: number, item: string, tick: number) {
    this.pickups[fighter]!.push(item);
    this.pickupTicks[fighter]!.push({ item, tick });
  }

  /**
   * `ruleCounts[fighter]` = how many rules its plan had (so rules that never fired show up);
   * `endTick` closes rules still active at the end of the round.
   */
  finish(kos: RoundStats["kos"], names: string[] = ["Red", "Blue", "Green", "Gold"], reflexes: RoundStats["reflexes"] = [[], [], [], []], ruleCounts: number[] = [0, 0, 0, 0], endTick = 0): RoundStats {
    const rules = [0, 1, 2, 3].map((f) => {
      const acc = this.ruleAcc[f]!;
      return Array.from({ length: Math.max(ruleCounts[f] ?? 0, acc.length) }, (_, i) => {
        const r = acc[i];
        if (!r) return { fires: 0, activeTicks: 0 };
        return { fires: r.fires, activeTicks: r.activeTicks + (r.since >= 0 ? Math.max(0, endTick - r.since) : 0) };
      });
    });
    const st: RoundStats = {
      damage: this.damage,
      nearSeconds: this.nearSeconds,
      targetSeconds: this.targetSeconds,
      pickups: this.pickups,
      pickupTicks: this.pickupTicks,
      kos,
      targetDistance: this.distN.map((n, i) => (n ? Math.round((this.distSum[i]! / n) * 10) / 10 : -1)),
      reflexes,
      rules,
      stanceSeconds: this.stanceSeconds,
      coverSeconds: this.coverSeconds,
      summary: [],
    };
    st.summary = [0, 1, 2, 3].map((i) => summarize(st, i, names));
    return st;
  }
}

const WEAPON_WORD: Record<string, string> = {
  rocket: "the rocket",
  shotgun: "the shotgun",
  bat: "the bat",
  grenade: "grenades",
  grapple: "the hook",
  flamethrower: "the flamethrower",
  lightning: "the lightning sword",
  fire: "fire",
  fist: "fists",
  barrel: "barrels",
  tnt: "TNT",
  gas: "a gas can",
  impact: "walls",
  crush: "falling junk",
};

function mainKey<T extends string>(rec: Record<T, number>): T | null {
  let best: T | null = null;
  for (const k of Object.keys(rec) as T[]) if (rec[k]! > 0 && (best === null || rec[k]! > rec[best]!)) best = k;
  return best;
}

/** Seat of the rival who did the most damage, with ties going to the first seat. */
export function topDamager(st: RoundStats, me: number): number {
  let worst = -1;
  for (let a = 0; a < 4; a++) if (a !== me && st.damage[a]![me]!.damage > (worst >= 0 ? st.damage[worst]![me]!.damage : 0)) worst = a;
  return worst;
}

export function behindHitText(stat: HitStat, moreThan: number): string {
  return stat.hits > moreThan && stat.fromBehind === stat.hits ? " from behind" : stat.fromBehind >= 2 ? ` (${stat.fromBehind} from behind)` : "";
}

/** The headline about the fighter who hurt `me` most. */
export function attackerLine(st: RoundStats, me: number, names: string[]): string | null {
  const worst = topDamager(st, me);
  if (worst < 0) return null;
  const s = st.damage[worst]![me]!;
  if (s.damage < 8) return null;
  const weapons: Record<string, number> = {};
  for (const [w, v] of Object.entries(s.byWeapon)) weapons[w] = v.damage;
  const w = mainKey(weapons);
  const r = mainKey(s.byRange);
  // precise: "from behind" only if every hit was; otherwise say how many
  const behind = behindHitText(s, 0);
  const chased = st.targetSeconds[me]![worst]!;
  const total = st.targetSeconds[me]!.reduce((a, b) => a + b, 0);
  const ignored = total > 4 && chased / total < 0.2 ? `, and you never turned on ${names[worst]}` : "";
  return `${names[worst]} hit you ${s.hits} time${s.hits === 1 ? "" : "s"}${behind}${w ? ` with ${WEAPON_WORD[w] ?? w}` : ""}${r ? ` at ${r} range` : ""}, ${Math.round(s.damage)} damage${ignored}.`;
}

export function summarize(st: RoundStats, me: number, names: string[]): string {
  const parts: string[] = [];
  const tgt = st.targetSeconds[me]!;
  const total = tgt.reduce((a, b) => a + b, 0);
  let main = -1;
  for (let j = 0; j < 4; j++) if (j !== me && (main < 0 || tgt[j]! > tgt[main]!)) main = j;
  if (main >= 0 && total > 3) {
    const dealt = st.damage[me]![main]!.damage;
    const share = tgt[main]! / total;
    const how = share > 0.7 ? "all round" : share > 0.45 ? "most of the round" : "for a while";
    parts.push(dealt < 1 ? `You chased ${names[main]} ${how} and never landed a hit.` : `You went after ${names[main]} ${how} and dealt ${Math.round(dealt)} damage.`);
  }
  const hurt = attackerLine(st, me, names);
  if (hurt) parts.push(hurt);
  const ko = st.kos.find((k) => k.victim === me);
  if (ko) {
    const how = ko.cause === "ringout" ? "rung out" : "knocked out";
    const by = ko.by >= 0 && ko.by !== me ? ` by ${names[ko.by]}${ko.weapon && WEAPON_WORD[ko.weapon] ? ` with ${WEAPON_WORD[ko.weapon]}` : ""}` : ko.weapon === "fall" ? " (you fell)" : "";
    parts.push(`You were ${how}${by}.`);
  }
  const mine = st.kos.filter((k) => k.by === me && k.victim !== me);
  if (mine.length) parts.push(`You knocked out ${mine.map((k) => names[k.victim]).join(" and ")}.`);
  if (st.pickups[me]!.length) parts.push(`You picked up ${st.pickups[me]!.join(", ")}.`);
  return parts.join(" ") || "A quiet round for you.";
}

/**
 * The seats of a played round from first to last place (#64): the winner first, then the fighters still standing at
 * the bell by health left, then the knocked-out ones, the last to go first. Rotation sends the last one to the back
 * of the queue.
 */
export function placing(f: { winner: number; fighters: { hpEnd: number }[]; stats: { kos: { victim: number; tick?: number }[] } }): number[] {
  const seats = f.fighters.map((_, i) => i);
  const koAt = new Map<number, number>();
  f.stats.kos.forEach((k, i) => koAt.set(k.victim, k.tick ?? i));
  const standing = seats.filter((s) => s !== f.winner && !koAt.has(s)).sort((a, b) => f.fighters[b]!.hpEnd - f.fighters[a]!.hpEnd || a - b);
  const out = seats.filter((s) => s !== f.winner && koAt.has(s)).sort((a, b) => koAt.get(b)! - koAt.get(a)! || a - b);
  return [f.winner, ...standing, ...out];
}
