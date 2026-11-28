import type { AgentMatch, AgentProfile, AgentProfileResponse, ReplaySummary } from "../api-types";
import { buildText, type Build } from "../sim/build";
import type { Identity } from "../sim/identity";
import { parseSoul } from "../sim/soul";
import type { Weapon } from "../sim/sim-types";
import { HttpError } from "./limits";
import { NAME_RE } from "../names";
import type { MatchServer } from "./match-server";
import type { Operator } from "./profile";
import { SEATS, replayOf } from "./replays";

/** The first plain paragraph of a soul.md, at most ~280 characters (pure: tested). */
export function soulSummary(soul: string): { summary: string; catchphrase: string } {
  const p = parseSoul(soul, 0, "agent");
  const body = p.soul.body || soul;
  const para =
    body
      .split(/\n\s*\n/)
      .map((x) => x.trim())
      .find((x) => x && !x.startsWith("#") && !x.startsWith("---") && !/^[a-z]+:/i.test(x) && !x.startsWith("- ")) ?? "";
  let s = para.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
  if (s.length > 280) {
    const cut = s.slice(0, 280);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    s = end > 80 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, "")}…`;
  }
  return { summary: s, catchphrase: p.soul.catchphrase ?? "" };
}

const mode = (xs: string[]): string | null => {
  const n = new Map<string, number>();
  for (const x of xs) if (x) n.set(x, (n.get(x) ?? 0) + 1);
  let best: string | null = null;
  for (const [k, v] of n) if (best === null || v > n.get(best)!) best = k;
  return best;
};

/** Place 1-4 of `seat`: the match winner first, then by round wins, ties share the better place (pure). */
export function placeOf(seat: number, winner: number, wins: number[]): number {
  if (seat === winner) return 1;
  const mine = wins[seat] ?? 0;
  return 2 + SEATS.filter((i) => i !== seat && i !== winner && (wins[i] ?? 0) > mine).length;
}

/** Build an agent's profile from its seats (newest first) and the summaries of those matches (pure: tested). */
export function buildProfile(
  name: string,
  seats: { match: string; seat: number; status: string; createdAt: number; soul: string; owner: string; leftRound: number | null; live?: { fighter: string | null; identities: Identity[] | null; names: string[] | null } }[],
  replays: Map<string, ReplaySummary>,
): AgentProfile {
  const matches: AgentMatch[] = [];
  const stances: string[] = [];
  const targets: string[] = [];
  const weapons: string[] = [];
  const builds: string[] = [];
  const stats = { matches: 0, won: 0, lost: 0, rounds: 0, roundsWon: 0, planChanges: 0, autopilot: 0 };
  let identity: Identity | null = null;
  let weapon: Weapon = "fist";
  let label = `remote/${name}`;
  let signature = "";
  let now: AgentProfile["now"] = null;
  for (const s of seats) {
    const rp = replays.get(s.match);
    if ((s.status === "open" || s.status === "running") && !now) now = { match: s.match, status: s.status };
    if (rp) {
      const i = s.seat;
      if (!identity) {
        identity = rp.identities[i] ?? null;
        weapon = rp.weapons[i] ?? "fist";
        label = rp.labels[i] ?? label;
      }
      stats.matches++;
      if (rp.winner === i) stats.won++;
      else stats.lost++;
      for (const rd of rp.rounds) {
        stats.rounds++;
        if (rd.winner === i) stats.roundsWon++;
        stats.planChanges += rd.planChanges[i] ?? 0;
        const pl = rd.plans[i];
        if (pl) {
          stances.push(pl.stance);
          targets.push(pl.target);
          if (pl.weapons[0]) weapons.push(pl.weapons[0]);
          if (pl.build) builds.push(buildText(pl.build));
        }
      }
      // the newest line: seats come newest first, rounds oldest first
      const last = [...rp.rounds].reverse().find((rd) => rd.lines[i]);
      if (last && !signature) signature = last.lines[i]!;
      const ap = rp.control.some((e) => e.seat === i && e.mode === "autopilot");
      if (ap) stats.autopilot++;
      matches.push({
        match: s.match,
        seat: i,
        status: "over",
        createdAt: rp.createdAt,
        fighter: rp.names[i] ?? null,
        place: rp.winner >= 0 ? placeOf(i, rp.winner, rp.wins) : null,
        wins: rp.wins,
        theme: rp.theme,
        record: rp.record,
        rivals: SEATS.filter((j) => j !== i).map((j) => ({ name: rp.names[j] ?? "?", identity: rp.identities[j] ?? null })),
        autopilot: ap,
        builds: rp.rounds.map((rd) => (rd.plans[i]?.build ? buildText(rd.plans[i]!.build!) : "")).filter(Boolean),
      });
    } else {
      if (!identity && s.live?.identities) identity = s.live.identities[s.seat] ?? null;
      matches.push({
        match: s.match,
        seat: s.seat,
        status: s.status,
        createdAt: new Date(s.createdAt).toISOString(),
        fighter: s.live?.fighter ?? null,
        place: null,
        wins: null,
        theme: "",
        record: null,
        rivals: s.live?.identities ? SEATS.filter((j) => j !== s.seat).map((j) => ({ name: s.live!.names?.[j] ?? "?", identity: s.live!.identities![j] ?? null })) : [],
        autopilot: s.leftRound !== null,
        builds: [],
      });
    }
  }
  const soul = seats[0]?.soul ?? "";
  const { summary, catchphrase } = soul ? soulSummary(soul) : { summary: "", catchphrase: "" };
  return { name, owner: seats[0]?.owner ?? "", identity, weapon, label, summary, catchphrase, signature: signature || catchphrase, stats, style: { stance: mode(stances), target: mode(targets), weapon: mode(weapons), build: mode(builds) }, matches, now };
}

/** how many recent stored matches an agent lookup scans */
const SCAN = 300;

/** An agent's profile, from the seats in storage (newest SCAN matches) and the matches in memory. */
export async function agentProfile(server: MatchServer, name: string): Promise<AgentProfileResponse> {
  if (!NAME_RE.test(name)) throw new HttpError(400, "agent names are 1-24 characters: letters, digits, space, _ . -");
  const want = name.toLowerCase();
  const rows = (await server.store.listMatches()).slice(0, SCAN);
  const seats: Parameters<typeof buildProfile>[1] = [];
  let shown = name;
  for (const row of rows) {
    const mem = server.matches.get(row.id);
    // rounds of an older engine (#88) are training data: not on an agent's page
    if (!mem && row.engine !== server.store.engine) continue;
    for (const s of await server.store.listSeats(row.id)) {
      if (s.name.toLowerCase() !== want) continue;
      shown = s.name;
      const r = mem?.runner;
      seats.push({
        match: row.id,
        seat: s.seat,
        status: mem?.status ?? row.status,
        createdAt: row.createdAt,
        soul: s.soul,
        owner: s.owner,
        leftRound: s.leftRound,
        ...(r ? { live: { fighter: r.names[s.seat] ?? null, identities: r.match.identities, names: r.names } } : {}),
      });
    }
    if (seats.length >= 40) break;
  }
  if (!seats.length) throw new HttpError(404, `no agent ${name} in the last ${SCAN} matches`);
  const replays = new Map<string, ReplaySummary>();
  await Promise.all(
    seats.map(async (s) => {
      if (s.status !== "over") return;
      const sum = await replayOf(server, s.match);
      if (sum) replays.set(s.match, sum);
    }),
  );
  const operator = (await operatorsOf(server)).byAgent.get(want) ?? null;
  return { ...buildProfile(shown, seats, replays), operator };
}

// ------------------------------------------------------------------ operators (#113)

/**
 * The operators on the site: owners that set a nickname, by owner handle and by agent name (lower case). Only the
 * public fields (id, nickname, URL) leave here; read paths for the site pages only, never a prompt's.
 */
export async function operatorsOf(server: MatchServer) {
  const byOwner = new Map<string, Operator>();
  const byAgent = new Map<string, Operator>();
  for (const o of await server.store.operators()) {
    const op = { id: o.id, nickname: o.nickname, url: o.url };
    byOwner.set(o.handle.toLowerCase(), op);
    for (const a of o.agents) byAgent.set(a.toLowerCase(), op);
  }
  return { byOwner, byAgent };
}
