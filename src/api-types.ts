import type { Build } from "./sim/build";
import type { Identity } from "./sim/identity";
import type { Weapon } from "./sim/sim-types";

/** The public face of a profile (only owners that set a nickname have one on the site). */
export interface Operator {
  id: string;
  nickname: string;
  url: string | null;
}

export type MatchStatus = "open" | "running" | "over" | "failed";
export type RoundTier = "bot-only" | "warm-up" | "featured";
/** The tiers the public sees (#67): a bot-only round is never shown after it is over. */
export type PublicTier = Exclude<RoundTier, "bot-only">;

/** A saved match as the site pages show it (plain values; names and lines are not escaped). */
export interface ReplaySummary {
  match: string;
  record: string;
  /** featured (2+ agents) or warm-up (1 agent and house bots) (#67) */
  tier: PublicTier;
  createdAt: string;
  seed: number;
  theme: string;
  names: string[];
  /** provider label per seat ("claude/haiku", "remote/Brixel", "house") */
  labels: string[];
  identities: Identity[];
  /** a weapon each fighter went for (for portraits) */
  weapons: Weapon[];
  winner: number;
  wins: number[];
  rounds: RoundSummary[];
  /** autopilot changes (#22), in order */
  control: { seat: number; mode: "autopilot" | "agent"; round: number }[];
}

export interface RoundSummary {
  winner: number;
  lines: string[];
  /** each seat's plan; build null when the record has none it can trust (#80) */
  plans: { stance: string; target: string; weapons: string[]; build: Build | null }[];
  /** mid-round plan changes per seat */
  planChanges: number[];
}

export interface AgentMatch {
  match: string;
  seat: number;
  status: MatchStatus;
  createdAt: string;
  fighter: string | null;
  /** 1st..4th by match winner, then round wins (null until over) */
  place: number | null;
  wins: number[] | null;
  theme: string;
  record: string | null;
  /** the other three: name and look */
  rivals: { name: string; identity: Identity | null }[];
  autopilot: boolean;
  /** the build the agent played in each round of the match, in words (#80); empty while it runs */
  builds: string[];
}

export interface AgentProfile {
  name: string;
  /** the owner the agent's name is bound to */
  owner: string;
  /** the bot from the agent's newest match (null before its first match starts) */
  identity: Identity | null;
  weapon: Weapon;
  label: string;
  summary: string;
  catchphrase: string;
  /** the agent's most recent line in a fight */
  signature: string;
  stats: { matches: number; won: number; lost: number; rounds: number; roundsWon: number; planChanges: number; autopilot: number };
  /** most frequent stance, target, first weapon and build over its plans */
  style: { stance: string | null; target: string | null; weapon: string | null; build: string | null };
  matches: AgentMatch[];
  now: { match: string; status: MatchStatus } | null;
}

export type AgentProfileResponse = AgentProfile & { operator: Operator | null };
