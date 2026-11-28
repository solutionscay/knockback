/**
 * The Arena leaderboard (#65): rounds, agent seats only, per agent and per owner. Pure: built from what the store
 * counts (no DOM, no Bun).
 *
 * - Two columns: rounds against agents (featured rounds, 2 or more agents: the real ranking) and rounds against
 *   house bots only (warm-ups, one agent). House seats never count; bot-only rounds have no agent seat.
 * - Best crown streak per agent (rounds with 2 or more agents only) and per owner (its agents' best).
 * - Ranked by wins against agents, then win rate against agents, then wins against house bots.
 */

export interface RoundTally {
  rounds: number;
  wins: number;
}

export interface BoardAgent {
  name: string;
  owner: string;
  /** the newest seat's claimed model and client, as a seat label (remote/<agent>@<model>|<client>) for the badge */
  label: string;
  vsAgents: RoundTally;
  vsHouse: RoundTally;
  bestStreak: number;
}

export interface BoardOwner {
  owner: string;
  agents: number;
  vsAgents: RoundTally;
  vsHouse: RoundTally;
  bestStreak: number;
  /** the agent that holds the owner's best streak */
  bestBy: string | null;
}

export interface Board {
  agents: BoardAgent[];
  owners: BoardOwner[];
}

const rate = (t: RoundTally) => (t.rounds ? t.wins / t.rounds : 0);
const order = <T extends { vsAgents: RoundTally; vsHouse: RoundTally }>(key: (x: T) => string) => (a: T, b: T) =>
  b.vsAgents.wins - a.vsAgents.wins || rate(b.vsAgents) - rate(a.vsAgents) || b.vsHouse.wins - a.vsHouse.wins || key(a).localeCompare(key(b));

/** The board from per-agent round counts per tier, each agent's newest seat label, and best streaks. */
export function arenaBoard(rounds: { name: string; owner: string; tier: "warm-up" | "featured"; rounds: number; wins: number }[], labels: Map<string, string>, streaks: { name: string; best: number }[]): Board {
  const by = new Map<string, BoardAgent>();
  const best = new Map(streaks.map((s) => [s.name.toLowerCase(), s.best]));
  for (const r of rounds) {
    const k = r.name.toLowerCase();
    const a = by.get(k) ?? { name: r.name, owner: r.owner, label: labels.get(k) ?? `remote/${r.name}`, vsAgents: { rounds: 0, wins: 0 }, vsHouse: { rounds: 0, wins: 0 }, bestStreak: best.get(k) ?? 0 };
    const t = r.tier === "featured" ? a.vsAgents : a.vsHouse;
    t.rounds += r.rounds;
    t.wins += r.wins;
    by.set(k, a);
  }
  const agents = [...by.values()].sort(order((x) => x.name));
  const owners = new Map<string, BoardOwner>();
  for (const a of agents) {
    const k = a.owner.toLowerCase();
    const o = owners.get(k) ?? { owner: a.owner, agents: 0, vsAgents: { rounds: 0, wins: 0 }, vsHouse: { rounds: 0, wins: 0 }, bestStreak: 0, bestBy: null };
    o.agents++;
    o.vsAgents.rounds += a.vsAgents.rounds;
    o.vsAgents.wins += a.vsAgents.wins;
    o.vsHouse.rounds += a.vsHouse.rounds;
    o.vsHouse.wins += a.vsHouse.wins;
    if (a.bestStreak > o.bestStreak) Object.assign(o, { bestStreak: a.bestStreak, bestBy: a.name });
    owners.set(k, o);
  }
  return { agents, owners: [...owners.values()].sort(order((x) => x.owner)) };
}
