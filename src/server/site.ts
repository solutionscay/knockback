/**
 * Data for the site pages (#22): the lobby, /replays, /agent/:name and the share card. Read-only, built from
 * what the match server already stores (the record index, seats, the record files); nothing new is written.
 *
 *   GET /api/replays?limit=n&before=ms  saved matches, newest first, with their line-up and result; `next` pages back
 *   GET /api/replays/:id            one saved match
 *   GET /api/agents/:name           an agent's bot, owner, soul summary, record and recent matches
 *   GET /share/:matchId.svg         the 1200x630 share card of a finished match
 *
 * Record files never change once written, so their summaries are cached by path.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ENGINE_VERSION, isCurrentEngine } from "../sim/engine-version";
import type { Identity } from "../sim/identity";
import { matchIdentities, type MatchRecord } from "../sim/match";
import { parseSoul } from "../sim/soul";
import type { Weapon } from "../sim/sim";
import { hex, portraitSvg, type Mood } from "../viewer/portrait";
import { modelOf } from "../stats/models";
import { HttpError } from "./limits";
import type { MatchServer } from "./match-server";

/** A saved match as the site pages show it (plain values; names and lines are not escaped). */
export interface ReplaySummary {
  match: string;
  record: string;
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
  plans: { stance: string; target: string; weapons: string[] }[];
  /** mid-round plan changes per seat */
  planChanges: number[];
}

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");
const int = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : d);
const SEATS = [0, 1, 2, 3];

/** Summarize a record's JSON (pure: tested). null unless it is a match record of the current engine. */
export function summarizeReplay(raw: unknown, match: string, record: string, createdAt: number): ReplaySummary | null {
  if (!isCurrentEngine(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!Number.isFinite(r.seed) || !Array.isArray(r.rounds)) return null;
  const seed = Number(r.seed) >>> 0;
  let identities: Identity[];
  try {
    identities = matchIdentities(seed, { recorded: r as unknown as MatchRecord });
  } catch {
    return null;
  }
  const labels = Array.isArray(r.labels) ? r.labels : [];
  const rawRounds = (r.rounds as unknown[]).slice(0, 3).map((x) => (x && typeof x === "object" ? x : {}) as Record<string, unknown>);
  const rounds: RoundSummary[] = rawRounds.map((x) => {
    const strategies = Array.isArray(x.strategies) ? x.strategies : [];
    const lines = Array.isArray(x.lines) ? x.lines : [];
    const updates = Array.isArray(x.planUpdates) ? x.planUpdates : [];
    return {
      winner: int(x.winner, 0, 3, -1),
      lines: SEATS.map((i) => str(lines[i])),
      plans: SEATS.map((i) => {
        const s = (strategies[i] ?? {}) as Record<string, unknown>;
        return { stance: str(s.stance, 20), target: str(s.target, 20), weapons: Array.isArray(s.weapons) ? s.weapons.slice(0, 4).map((w) => str(w, 20)) : [] };
      }),
      planChanges: SEATS.map((i) => updates.filter((u) => (u as { fighter?: unknown })?.fighter === i).length),
    };
  });
  const firstMeta = Array.isArray(rawRounds[0]?.meta) ? (rawRounds[0]!.meta as { provider?: unknown }[]) : [];
  const wins = Array.isArray(r.wins) ? r.wins : [];
  const theme = str(((rawRounds[0]?.fight as Record<string, unknown> | undefined)?.level as Record<string, unknown> | undefined)?.theme, 20);
  const control = (Array.isArray(r.control) ? r.control : [])
    .map((e) => (e && typeof e === "object" ? (e as Record<string, unknown>) : {}))
    .filter((e) => (e.mode === "autopilot" || e.mode === "agent") && int(e.seat, 0, 3, -1) >= 0)
    .map((e) => ({ seat: e.seat as number, mode: e.mode as "autopilot" | "agent", round: int(e.round, 0, 9, 0) }));
  return {
    match,
    record,
    createdAt: new Date(createdAt).toISOString(),
    seed,
    theme,
    names: identities.map((id) => id.name),
    labels: SEATS.map((i) => str(labels[i], 60) || str(firstMeta[i]?.provider, 60) || "house"),
    identities,
    weapons: SEATS.map((i) => {
      for (const rd of [...rounds].reverse()) if (rd.plans[i]?.weapons[0]) return rd.plans[i]!.weapons[0] as Weapon;
      return "fist" as Weapon;
    }),
    winner: int(r.winner, 0, 3, -1),
    wins: SEATS.map((i) => int(wins[i], 0, 9, 0)),
    rounds,
    control,
  };
}

/** Summaries of record files by path; they never change once written. */
export class RecordCache {
  private cache = new Map<string, Promise<unknown | null>>();
  constructor(
    readonly outDir: string,
    readonly max = 500,
  ) {}

  /** the record JSON at /records/<file>.json, or null */
  raw(path: string): Promise<unknown | null> {
    const name = /^\/records\/([\w-][\w.-]*\.json)$/.exec(path)?.[1];
    if (!name) return Promise.resolve(null);
    let p = this.cache.get(name);
    if (!p) {
      p = readFile(join(this.outDir, name), "utf8").then(
        (s) => JSON.parse(s) as unknown,
        () => null,
      );
      this.cache.set(name, p);
      if (this.cache.size > this.max) this.cache.delete(this.cache.keys().next().value!);
    }
    return p;
  }
}

const caches = new WeakMap<MatchServer, RecordCache>();
const cacheOf = (s: MatchServer) => {
  let c = caches.get(s);
  if (!c) caches.set(s, (c = new RecordCache(s.opts.outDir)));
  return c;
};

/** Saved matches, newest first; `before` (ms) pages back through older ones. */
export async function listReplays(server: MatchServer, limit = 30, before?: number): Promise<ReplaySummary[]> {
  return (await pageReplays(server, limit, before)).replays;
}

/** A page of saved matches and the cursor for the next (older) page, null at the end. */
export async function pageReplays(server: MatchServer, limit = 30, before?: number): Promise<{ replays: ReplaySummary[]; next: number | null }> {
  const n = Math.max(1, Math.min(100, limit));
  const rows = await server.store.listRecords(n, before);
  const out = await Promise.all(rows.map(async (row) => summarizeReplay(await cacheOf(server).raw(row.path), row.matchId, row.path, row.createdAt)));
  return { replays: out.filter((x): x is ReplaySummary => x !== null), next: rows.length === n ? rows.at(-1)!.createdAt : null };
}

/** One saved match by id. */
export async function replayOf(server: MatchServer, match: string): Promise<ReplaySummary | null> {
  const rec = await server.store.getRecord(match);
  return rec ? summarizeReplay(await cacheOf(server).raw(rec.path), match, rec.path, rec.createdAt) : null;
}

// ------------------------------------------------------------------ agents

export interface AgentMatch {
  match: string;
  seat: number;
  status: string;
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
  /** most frequent stance, target and first weapon over its plans */
  style: { stance: string | null; target: string | null; weapon: string | null };
  matches: AgentMatch[];
  now: { match: string; status: string } | null;
}

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
      });
    }
  }
  const soul = seats[0]?.soul ?? "";
  const { summary, catchphrase } = soul ? soulSummary(soul) : { summary: "", catchphrase: "" };
  return { name, owner: seats[0]?.owner ?? "", identity, weapon, label, summary, catchphrase, signature: signature || catchphrase, stats, style: { stance: mode(stances), target: mode(targets), weapon: mode(weapons) }, matches, now };
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,23}$/;
/** how many recent stored matches an agent lookup scans */
const SCAN = 300;

/** An agent's profile, from the seats in storage (newest SCAN matches) and the matches in memory. */
export async function agentProfile(server: MatchServer, name: string): Promise<AgentProfile> {
  if (!NAME_RE.test(name)) throw new HttpError(400, "agent names are 1-24 characters: letters, digits, space, _ . -");
  const want = name.toLowerCase();
  const rows = (await server.store.listMatches()).slice(0, SCAN);
  const seats: Parameters<typeof buildProfile>[1] = [];
  let shown = name;
  for (const row of rows) {
    const mem = server.matches.get(row.id);
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
      const rec = await server.store.getRecord(s.match);
      if (!rec) return;
      const sum = summarizeReplay(await cacheOf(server).raw(rec.path), s.match, rec.path, rec.createdAt);
      if (sum) replays.set(s.match, sum);
    }),
  );
  return buildProfile(shown, seats, replays);
}

// ------------------------------------------------------------------ share card

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** place a portrait SVG at x,y with size w,h inside another SVG */
const placeSvg = (svg: string, x: number, y: number, w: number, h: number) => svg.replace("<svg ", `<svg x="${x}" y="${y}" width="${w}" height="${h}" `);

/** Model name of a seat label for the card: the model spotlight's name, "AGENT" when a remote agent did not say (pure). */
export function labelText(label: string): string {
  const m = modelOf(label);
  return m.key === "remote:unreported" ? "AGENT" : m.name;
}

/** The 1200x630 share card of a finished match, as SVG (pure: tested). */
export function shareCardSvg(r: ReplaySummary): string {
  const W = 1200;
  const H = 630;
  const w = r.winner >= 0 ? r.winner : 0;
  const win = r.identities[w]!;
  const col = hex(win.color);
  const name = (r.names[w] ?? "?").toUpperCase();
  const big = name.length > 8 ? 108 : 140;
  const theme = (r.theme || "arena").toUpperCase();
  const sorted = [...r.wins].sort((a, b) => b - a);
  const score = sorted.filter((x, i) => i < 2 || x > 0).join("–");
  const models = [...new Set(r.labels.map(labelText))].slice(0, 4).join(" vs ");
  const stack = (x: number, y: number, size: number, text: string, fill: string, depth: number) =>
    [...Array(depth)].map((_, k) => `<text x="${x + (depth - k)}" y="${y + (depth - k) * 1.4}" font-size="${size}" fill="#05070c">${esc(text)}</text>`).join("") + `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}">${esc(text)}</text>`;
  const losers = [0, 1, 2, 3].filter((i) => i !== w);
  const loserSvgs = losers
    .map((i, k) => {
      const id = r.identities[i]!;
      return placeSvg(portraitSvg(id, r.weapons[i] ?? "fist", "ko" as Mood), 640 + k * 92, 384, 96, 104) + `<text x="${688 + k * 92}" y="${508}" font-size="15" fill="${hex(id.color)}" text-anchor="middle">${esc(r.names[i] ?? "")}</text>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'Arial Black', Arial, sans-serif" font-weight="900">
<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1d2233"/><stop offset="1" stop-color="#0f1424"/></linearGradient>
<radialGradient id="glow" cx="0.5" cy="0.55" r="0.5"><stop offset="0" stop-color="${col}" stop-opacity="0.35"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></radialGradient></defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<rect x="0" y="520" width="${W}" height="110" fill="#5a4630"/><rect x="0" y="520" width="${W}" height="10" fill="#6fae3e"/>
${[...Array(12)].map((_, k) => `<rect x="${k * 100 + 30}" y="${548 + (k % 3) * 18}" width="26" height="14" fill="#4a3a28"/>`).join("")}
${stack(60, 185, big, name, col, 6)}
${stack(60, 185 + big * 0.95, big, "WINS", col, 6)}
<text x="64" y="${185 + big * 0.95 + 58}" font-size="26" fill="#f4f6fb" letter-spacing="5">${esc(`${score} · ${theme} · AI VS AI`)}</text>
<text x="64" y="${185 + big * 0.95 + 96}" font-size="20" fill="#c7ccd8" font-family="Arial, sans-serif" font-weight="700">${esc(models)}</text>
<circle cx="1000" cy="330" r="230" fill="url(#glow)"/>
${placeSvg(portraitSvg(win, r.weapons[w] ?? "fist", "win"), 830, 120, 340, 380)}
${loserSvgs}
<text x="60" y="598" font-size="34" fill="#ffd23f">KNOCKBACK</text>
<text x="318" y="596" font-size="20" fill="#f4f6fb" font-family="Arial, sans-serif" font-weight="700">AI agents plan. Physics decides.</text>
</svg>`;
}

// ------------------------------------------------------------------ routes

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-cache" } });

/** The site's read-only endpoints; null for any other path. Errors are thrown as HttpError (the caller answers them). */
export async function siteRoute(server: MatchServer, req: Request, path: string, url: URL): Promise<Response | null> {
  if (path === "/api/replays") {
    if (req.method !== "GET") throw new HttpError(405, "use GET for /api/replays", undefined, { allow: "GET" });
    const n = Number(url.searchParams.get("limit") ?? "30");
    const b = Number(url.searchParams.get("before"));
    return json({ engine: ENGINE_VERSION, ...(await pageReplays(server, Number.isFinite(n) ? n : 30, url.searchParams.has("before") && Number.isFinite(b) ? b : undefined)) });
  }
  const rp = /^\/api\/replays\/(m_[0-9a-f]{8})$/.exec(path);
  if (rp) {
    if (req.method !== "GET") throw new HttpError(405, "use GET for /api/replays/:id", undefined, { allow: "GET" });
    const sum = await replayOf(server, rp[1]!);
    if (!sum) throw new HttpError(404, `no saved match ${rp[1]}`);
    return json({ engine: ENGINE_VERSION, replay: sum });
  }
  const ag = /^\/api\/agents\/([^/]{1,80})$/.exec(path);
  if (ag) {
    if (req.method !== "GET") throw new HttpError(405, "use GET for /api/agents/:name", undefined, { allow: "GET" });
    let name: string;
    try {
      name = decodeURIComponent(ag[1]!);
    } catch {
      throw new HttpError(400, "bad agent name");
    }
    return json(await agentProfile(server, name));
  }
  const sh = /^\/share\/(m_[0-9a-f]{8})\.svg$/.exec(path);
  if (sh) {
    const rec = await server.store.getRecord(sh[1]!);
    const sum = rec ? summarizeReplay(await cacheOf(server).raw(rec.path), sh[1]!, rec.path, rec.createdAt) : null;
    if (!sum) throw new HttpError(404, `no finished match ${sh[1]}`);
    return new Response(shareCardSvg(sum), { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=3600" } });
  }
  return null;
}
