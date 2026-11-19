/** Points per fight and the running tally across matches in a session. */
import type { FightResult as MatchResult } from "../sim/fight";

export const POINTS = { win: 3, ko: 1 };

export interface FightScore {
  fighter: number;
  win: number;
  kos: number;
  total: number;
}

export function scoreFight(r: MatchResult, fighters = 4): FightScore[] {
  const out: FightScore[] = [];
  for (let i = 0; i < fighters; i++) {
    const win = r.winner === i ? POINTS.win : 0;
    const kos = (r.kos[i] ?? 0) * POINTS.ko;
    out.push({ fighter: i, win, kos, total: win + kos });
  }
  return out;
}

export class Tally {
  points: number[];
  wins: number[];
  matches = 0;

  constructor(readonly fighters = 4) {
    this.points = new Array(fighters).fill(0);
    this.wins = new Array(fighters).fill(0);
  }

  add(r: MatchResult): FightScore[] {
    const s = scoreFight(r, this.fighters);
    for (const f of s) this.points[f.fighter]! += f.total;
    this.wins[r.winner]!++;
    this.matches++;
    return s;
  }

  /** Fighter ids, best first (points, then wins, then id). */
  ranking(): number[] {
    return [...this.points.keys()].sort((a, b) => this.points[b]! - this.points[a]! || this.wins[b]! - this.wins[a]! || a - b);
  }

  toJSON() {
    return { points: this.points, wins: this.wins, matches: this.matches };
  }

  static from(data: unknown, fighters = 4): Tally {
    const t = new Tally(fighters);
    const d = data as { points?: number[]; wins?: number[]; matches?: number } | null;
    if (d && Array.isArray(d.points) && d.points.length === fighters && Array.isArray(d.wins) && d.wins.length === fighters) {
      t.points = d.points.map(Number);
      t.wins = d.wins.map(Number);
      t.matches = Number(d.matches) || 0;
    }
    return t;
  }
}
