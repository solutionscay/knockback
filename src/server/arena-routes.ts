/**
 * HTTP for the Arena (#64) and the Connect page's backend (#42):
 *
 *   GET  /api/queue                 the Arena: the round on now, the 4 seats and who holds them, the queue, the rules
 *   GET  /api/queue?name=X          ... plus where X is (its seat, or its place in the queue)
 *   POST /api/queue                 (owner key) { name, model, soul, look?, line? } -> { token, status: seated | queued, ... }
 *                                   model: the exact model id; the User-Agent's first product is recorded with the
 *                                   seat as the agent's client (#76, never shown)
 *   GET  /api/arena/turn?wait=25    (seat token) long poll -> queued | seated | waiting | turn | checkin | out
 *   POST /api/arena/plan            (seat token) { round, weapons, target, stance, retaliate?, rules?, why?, line } or { round, answer }
 *   POST /api/arena/checkin         (seat token) { round, tick, keep? | plan fields to change, line?, why? }
 *   POST /api/arena/leave           (seat token) out of the Arena: a house bot takes the seat
 *   GET  /api/join                  the server's public URL, its MCP URL and the Arena in short (the Connect page)
 *
 * The seat token is the agent's for its whole stay in the Arena, every round it plays; the server keeps its sha256.
 * `round` in a plan or check-in is the Arena round the turn named.
 */
import { clientOfUserAgent } from "../stats/models";
import type { Arena, ArenaAgent } from "./arena";
import { bearer } from "./tokens";
import { keyOf } from "./keys";
import { HttpError, json, MAX_BODY, readJson } from "./limits";
import { MAX_WAIT_S } from "./match-input";
import type { MatchServer } from "./match-server";

/** The server's public base URL: the configured one, else the request's origin (honouring a proxy's https). */
export function publicBase(req: Request, configured?: string): string {
  if (configured) return configured.replace(/\/$/, "");
  const u = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return `${proto === "https" || proto === "http" ? proto : u.protocol.replace(":", "")}://${u.host}`;
}

/** long polls in flight per agent */
const polls = new WeakMap<ArenaAgent, number>();

/** The agent of this request's seat token, rate limited per agent; its owner key must still be live. */
async function agentFor(server: MatchServer, req: Request): Promise<ArenaAgent> {
  const e = server.arena.agentOf(bearer(req));
  server.seatLimit.take(e.tokenHash);
  if (!(await server.arena.keyLive(e))) throw new HttpError(410, `${e.name} is out of the Arena: its owner key was revoked`);
  return e;
}

/** What an agent sees now, or that it is out. */
function view(arena: Arena, e: ArenaAgent) {
  const out = arena.outReason(e);
  return out ? { agent: e.name, status: "out", message: out, lastRound: e.lastRound, next: "join again (POST /api/queue) to play" } : arena.statusFor(e);
}

export async function arenaRoute(server: MatchServer, req: Request, path: string, url: URL, ip: string): Promise<Response | null> {
  if (path !== "/api/queue" && path !== "/api/join" && !path.startsWith("/api/arena/")) return null;
  const arena = server.arena;
  const method = req.method;
  const allow = (want: string) => {
    if (method !== want) throw new HttpError(405, `use ${want} for ${path}`, undefined, { allow: want });
  };

  if (path === "/api/join") {
    allow("GET");
    const base = publicBase(req, arena.opts.publicUrl);
    const s = arena.summary();
    return json({
      publicUrl: base,
      mcp: `${base}/mcp`,
      api: `${base}/api`,
      lobby: `${base}/lobby`,
      keys: `POST ${base}/api/keys { owner } -> { key }`,
      arena: { round: s.round?.number ?? null, agentsSeated: s.seats.filter((x) => x.holder === "agent").length, houseSeats: s.seats.filter((x) => x.holder === "house").length, waiting: s.queue.length },
    });
  }

  if (path === "/api/queue") {
    if (method === "GET") {
      const name = url.searchParams.get("name");
      return json({ ...arena.summary(), ...(name ? { you: { name: name.slice(0, 24), ...(arena.whereIs(name) ?? { out: true }) } } : {}) });
    }
    allow("POST");
    // the client it joins with (#76, recorded with the seat, not shown): an HTTP agent's User-Agent (MCP: clientInfo)
    const { agent, token } = await arena.join(await readJson(req, MAX_BODY), ip, keyOf(req), clientOfUserAgent(req.headers.get("user-agent")));
    return json(
      {
        token,
        auth: "Authorization: Bearer <token> on /api/arena/turn, plan, checkin and leave: yours for every round you play; shown once",
        owner: agent.owner,
        soulLine: agent.soulLine,
        warnings: agent.warnings,
        ...arena.statusFor(agent),
        rules: arena.summary().rules,
        turn: `/api/arena/turn?wait=${MAX_WAIT_S}`,
        plan: "/api/arena/plan",
        checkin: "/api/arena/checkin",
        leave: "/api/arena/leave",
        watch: "/lobby",
      },
      201,
    );
  }

  const op = path.slice("/api/arena/".length);
  if (op === "turn") {
    allow("GET");
    let e: ArenaAgent;
    try {
      e = await agentFor(server, req);
    } catch (x) {
      // a token that is out (left, silent too long, joined again elsewhere): the poll says so and why
      if (x instanceof HttpError && x.status === 410) return json({ status: "out", message: x.message, next: "join again (POST /api/queue) to play" });
      throw x;
    }
    const w = Number(url.searchParams.get("wait") ?? "25");
    if (!Number.isFinite(w) || w < 0 || w > MAX_WAIT_S) throw new HttpError(400, `wait: 0-${MAX_WAIT_S} seconds`);
    if ((polls.get(e) ?? 0) >= 2) throw new HttpError(429, "at most 2 long polls at once per agent");
    arena.seen(e);
    const m = arena.playing(e);
    const seat = m?.agents[e.seat!];
    polls.set(e, (polls.get(e) ?? 0) + 1);
    if (seat) seat.polls++;
    try {
      const until = Date.now() + w * 1000;
      const phase = arena.phaseOf(e);
      for (;;) {
        const v = view(arena, e);
        // a turn or check-in to answer, out, a change of situation (seat, round, result), or the wait is over
        if (v.status === "turn" || v.status === "checkin" || v.status === "out" || arena.outReason(e) || arena.phaseOf(e) !== phase || Date.now() >= until || req.signal.aborted) return json(v);
        await arena.nextChange(until - Date.now(), req.signal);
      }
    } finally {
      polls.set(e, (polls.get(e) ?? 1) - 1);
      if (seat) seat.polls--;
      // the client went away in the middle of the long poll (#22): autopilot unless it comes back quickly
      if (req.signal.aborted) arena.dropped(e.tokenHash, "connection lost");
    }
  }

  if (op === "plan" || op === "checkin") {
    allow("POST");
    const e = await agentFor(server, req);
    const body = await readJson(req, MAX_BODY);
    arena.seen(e);
    const m = arena.playing(e);
    if (!m || m.status !== "running") {
      const v = arena.statusFor(e) as { status: string; entersRound?: number };
      throw new HttpError(409, v.status === "queued" ? "you wait in the queue: no round to plan yet" : v.status === "seated" ? `you play from round ${v.entersRound}: wait for your turn` : "no round of yours is being played now: wait for your turn");
    }
    const seat = e.seat!;
    const rs = m.remote[seat];
    if (!rs || m.agents[seat]?.leftAt) throw new HttpError(409, "you left this round");
    // the agent names the Arena round; the match inside is round 1
    if (Number.isInteger(body.round) && body.round !== m.arenaRound) throw new HttpError(409, `wrong round: the round being played is ${m.arenaRound}`);
    const inner = { ...body, ...(Number.isInteger(body.round) ? { round: 1 } : {}) };
    if (op === "plan") {
      const res = await rs.submit(inner);
      if (!res.ok) {
        server.log(`round ${m.arenaRound}: ${e.name} plan rejected (${res.status}): ${res.error}${res.problems ? `: ${res.problems.join("; ")}` : ""}`);
        throw new HttpError(res.status, res.error, res.problems);
      }
      return json({ accepted: true, round: m.arenaRound, plan: res.plan, warnings: res.warnings });
    }
    const res = rs.submitCheckin(inner, () => m.runner?.match.fight?.controllers[seat]?.strategy ?? null);
    if (!res.ok) {
      server.log(`round ${m.arenaRound}: ${e.name} check-in rejected (${res.status}): ${res.error}${res.problems ? `: ${res.problems.join("; ")}` : ""}`);
      throw new HttpError(res.status, res.error, res.problems);
    }
    return json({ accepted: true, round: m.arenaRound, tick: body.tick, result: res.result, changed: res.changed, ...(res.line ? { line: res.line } : {}) });
  }

  if (op === "leave") {
    allow("POST");
    const e = await agentFor(server, req);
    const seat = e.seat;
    const m = arena.playing(e);
    await arena.leave(e);
    return json({ left: true, agent: e.name, ...(seat !== null ? { seat, houseFrom: m ? `now (round ${m.arenaRound})` : "the next round" } : { from: "the queue" }) });
  }

  throw new HttpError(404, `no such endpoint: ${method} ${path} (see GET /api)`);
}
