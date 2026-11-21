/**
 * The match server's HTTP API (#20, #25): Knockback matches with remote agents as
 * players, over a plain JSON HTTP API. Empty or silent seats get the house bot.
 *
 *   POST /api/matches                 create: { seats?, seed?, deadlineSec?, fillAfterSec? }
 *   GET  /api/matches                 list
 *   GET  /api/matches/:id             status and seats
 *   POST /api/matches/:id/join        (owner key) { name, model, soul, look?, seat?, line? } -> { seat, token }
 *   GET  /api/models                  the model leaderboard (from the record index)
 *   GET  /api/matches/:id/turn        (seat token) long poll: ?wait=0-30 s -> open | turn | checkin | waiting | over
 *   POST /api/matches/:id/plan        (seat token) { round, weapons, target, stance, retaliate?, rules?, why?, line } or { round, answer }
 *   POST /api/matches/:id/checkin     (seat token) mid-round check-in answer (#9): { round, tick, keep? | plan fields to change, line?, why? }
 *   POST /api/matches/:id/leave       (seat token) the house bot takes the seat
 *   GET  /api/matches/:id/report      plans and results so far (?round=n for one round)
 *   GET  /api/live?match=:id          spectator stream (SSE); without ?match: the newest match
 *   GET  /api/replays, /api/agents/:name, /share/:id.svg   read-only data for the site pages (site.ts)
 *
 * Joining needs an owner key (src/server/keys.ts: `Authorization: Bearer kbk_...`) and returns a seat token valid for that match and seat only; turn, plan
 * and leave need it in `Authorization: Bearer <token>`. The server keeps only
 * its sha256. With `open: true` (the CLI's --open, for a trusted LAN) tokens
 * are not checked: those calls name the seat with ?seat=N instead.
 * Every body is JSON, at most MAX_BODY bytes; requests are rate limited per
 * address and per seat. The match itself runs in MatchRunner, exactly like a
 * local AI match.
 */
import { lookOptions } from "../ai/looks";
import { apiIndex } from "./api-index";
import { checkOwnerHandle, claimName, hashKey, keyOf, newKey, ownerOf } from "./keys";
import { HttpError, json, MAX_BODY, readJson } from "./limits";
import { checkCreate, checkJoin, MAX_WAIT_S, SEATS_PER_IP } from "./match-input";
import type { MatchServer } from "./match-server";
import { spectatorOf } from "./picks";
import { queueRoute } from "./queue-routes";
import { hashToken } from "./seat-tokens";
import type { ServerMatch } from "./server-match";
import { siteRoute } from "./site";

/** Liveness and readiness for the container healthcheck: the process answers and the store can be read. */
export async function health(server: MatchServer): Promise<Response> {
  const count = (st: string) => [...server.matches.values()].filter((m) => m.status === st).length;
  const base = { version: server.opts.version, uptimeSec: Math.round(process.uptime()), matches: { open: count("open"), running: count("running") } };
  try {
    await server.store.listMatches(["running"]);
    return json({ ok: true, ...base, store: "ok" });
  } catch (e) {
    server.log(`health: storage unavailable: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return json({ ok: false, error: "storage unavailable" }, 503);
  }
}

/**
 * The seat a turn/plan/leave call acts for: from the seat token, or in
 * open mode from ?seat=N when no token is sent. Throws 401/403 otherwise.
 */
export function seatFor(server: MatchServer, req: Request, url: URL, match: ServerMatch): number {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  let seat: number;
  if (m) {
    const t = server.tokens.get(hashToken(m[1]!));
    if (!t || t.match !== match.id) throw new HttpError(401, `wrong seat token for match ${match.id}: use the token from POST /api/matches/${match.id}/join`);
    seat = t.seat;
  } else if (server.opts.open) {
    const s = Number(url.searchParams.get("seat"));
    if (!Number.isInteger(s) || s < 0 || s > 3 || !url.searchParams.has("seat")) throw new HttpError(400, "open mode: name your seat with ?seat=0-3 (or send the seat token)");
    if (!match.agents[s]) throw new HttpError(403, `seat ${s} has no agent; POST /api/matches/${match.id}/join first`);
    seat = s;
  } else throw new HttpError(401, `missing seat token: send Authorization: Bearer <token> from POST /api/matches/${match.id}/join`);
  server.seatLimit.take(`${match.id}:${seat}`);
  return seat;
}

export async function apiRoute(server: MatchServer, req: Request, url: URL, ip: string): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, "");
  const method = req.method;
  const allow = (want: string) => {
    if (method !== want) throw new HttpError(405, `use ${want} for ${path}`, undefined, { allow: want });
  };
  if (path === "/api") return json(apiIndex(server.opts.open));
  // the site pages' read-only data (#22): /api/replays, /api/agents/:name, /share/:id.svg
  const site = await siteRoute(server, req, path, url);
  if (site) return site;
  const queue = await queueRoute(server, req, path, url, ip);
  if (queue) return queue;
  if (path === "/api/live") {
    allow("GET");
    const mid = url.searchParams.get("match");
    const m = mid ? await server.matchOr404(mid, ip) : server.liveDefault();
    if (!m) throw new HttpError(404, "no match yet");
    return m.live.response();
  }
  if (path === "/api/matches") {
    if (method === "GET") return json({ matches: [...server.matches.values()].map((m) => m.info()) });
    allow("POST");
    server.createLimit.take(ip, "new matches");
    const b = await readJson(req);
    return json((await server.createMatch({ ...checkCreate(b), ip })).info(), 201);
  }
  if (path === "/api/keys") {
    allow("POST");
    server.keyCreateLimit.take(ip, "new owner keys");
    const owner = checkOwnerHandle((await readJson(req, MAX_BODY)).owner);
    const key = newKey();
    if (!(await server.store.createOwner(owner, hashKey(key)))) throw new HttpError(409, `the owner handle ${owner} is taken: if it is yours, use the key you got for it (the JOIN panel keeps it in this browser); otherwise pick another handle`);
    server.log(`owner ${owner}: key issued`);
    return json({ owner, key, use: "send it as Authorization: Bearer <key>; it is shown once" }, 201);
  }
  if (path === "/api/keys/me") {
    const key = keyOf(req);
    const owner = await ownerOf(server.store, key);
    if (method === "DELETE") {
      await server.store.revokeKey(hashKey(key!));
      server.log(`owner ${owner}: a key was revoked`);
      return json({ revoked: true, owner });
    }
    allow("GET");
    return json({ owner, agents: await server.store.listAgents(owner) });
  }
  if (path === "/api/looks") {
    // the suit-up options (#19): shapes, eyes, marks with a line each, the name and palette rules
    allow("GET");
    return json(lookOptions());
  }
  if (path === "/api/models") {
    allow("GET");
    const min = Number(url.searchParams.get("min"));
    return json(await server.models(Number.isInteger(min) && min >= 1 && min <= 1000 ? min : undefined));
  }
  if (path === "/api/records") {
    allow("GET");
    return json({ records: await server.store.listRecords(100) });
  }
  if (path === "/api/picks") {
    // a replay's crowd split, read-only (#35): the record holds no picks, the index maps it to its match
    allow("GET");
    const rec = url.searchParams.get("record") ?? "";
    const hit = (await server.store.listRecords(1000)).find((r) => r.path === rec);
    if (!hit) throw new HttpError(404, "no match for that record");
    const m = await server.matchOr404(hit.matchId, ip);
    const sp = spectatorOf(req);
    return json(m.picksView(sp.hash));
  }
  const mm = /^\/api\/matches\/([\w-]{1,32})(?:\/(join|turn|plan|checkin|leave|report|pick|picks))?$/.exec(path);
  if (!mm) throw new HttpError(404, `no such endpoint: ${method} ${path} (see GET /api)`);
  const match = await server.matchOr404(mm[1]!, ip);
  switch (mm[2]) {
    case undefined:
      allow("GET");
      return json(match.info());
    case "picks": {
      // spectators (#35): the pick cards, the tally, the lock, this browser's pick (anonymous cookie id)
      allow("GET");
      const sp = spectatorOf(req);
      return json(match.picksView(sp.hash), 200, sp.setCookie ? { "set-cookie": sp.setCookie } : {});
    }
    case "pick": {
      allow("POST");
      server.pickLimit.take(ip, "picks");
      const b = await readJson(req, 256);
      const extra = Object.keys(b).filter((k) => k !== "seat");
      if (extra.length || !Number.isInteger(b.seat) || (b.seat as number) < 0 || (b.seat as number) > 3) throw new HttpError(400, "send { seat: 0-3 }", extra.length ? [`unknown fields: ${extra.join(", ")}`] : undefined);
      const sp = spectatorOf(req);
      await match.pick(sp.hash, b.seat as number, ip);
      return json(match.picksView(sp.hash), 200, sp.setCookie ? { "set-cookie": sp.setCookie } : {});
    }
    case "report": {
      allow("GET");
      const r = url.searchParams.get("round");
      return json(match.report(r === null ? undefined : Number(r)));
    }
    case "join": {
      allow("POST");
      server.joinLimit.take(ip, "joins");
      const key = keyOf(req);
      const owner = await ownerOf(server.store, key);
      server.keyLimit.take(hashKey(key!), "joins with this key");
      const j = checkJoin(await readJson(req, MAX_BODY));
      await claimName(server.store, j.name, owner);
      const held = [...server.matches.values()].filter((m) => m.status === "open" || m.status === "running").reduce((n, m) => n + m.agents.filter((a) => a?.ip === ip && a.leftAt === null).length, 0);
      if (held >= SEATS_PER_IP) throw new HttpError(429, `at most ${SEATS_PER_IP} seats per address in open or running matches`);
      const { seat, token } = await server.join(match, j, owner, ip);
      return json(
        {
          match: match.id,
          seat,
          token,
          auth: "Authorization: Bearer <token> on turn, plan and leave (valid for this match and seat only)",
          status: match.status,
          warnings: j.warnings,
          turn: `/api/matches/${match.id}/turn`,
          plan: `/api/matches/${match.id}/plan`,
          leave: `/api/matches/${match.id}/leave`,
        },
        201,
      );
    }
    case "leave": {
      allow("POST");
      const seat = seatFor(server, req, url, match);
      return json(await server.leave(match, seat));
    }
    case "turn": {
      allow("GET");
      const seat = seatFor(server, req, url, match);
      const agent = match.agents[seat]!;
      const w = Number(url.searchParams.get("wait") ?? "25");
      if (!Number.isFinite(w) || w < 0 || w > MAX_WAIT_S) throw new HttpError(400, `wait: 0-${MAX_WAIT_S} seconds`);
      if (agent.polls >= 2) throw new HttpError(429, "at most 2 long polls at once per seat");
      match.seen(seat);
      agent.polls++;
      try {
        const until = Date.now() + w * 1000;
        for (;;) {
          const t = match.turnFor(seat);
          if (t.status === "turn" || t.status === "checkin" || t.status === "over" || t.status === "left" || Date.now() >= until || req.signal.aborted) return json(t);
          await match.nextChange(until - Date.now(), req.signal);
        }
      } finally {
        agent.polls--;
        // the client went away in the middle of the long poll (#22): autopilot unless it comes back quickly
        if (req.signal.aborted) match.dropped(seat, "connection lost", agent.tokenHash);
      }
    }
    case "plan": {
      allow("POST");
      const seat = seatFor(server, req, url, match);
      const body = await readJson(req, MAX_BODY);
      match.seen(seat);
      const rs = match.remote[seat];
      if (!rs || match.agents[seat]?.leftAt) throw new HttpError(409, "you left this match");
      const res = await rs.submit(body);
      if (!res.ok) {
        server.log(`match ${match.id}: seat ${seat} plan rejected (${res.status}): ${res.error}${res.problems ? `: ${res.problems.join("; ")}` : ""}`);
        throw new HttpError(res.status, res.error, res.problems);
      }
      return json({ accepted: true, round: body.round, plan: res.plan, warnings: res.warnings });
    }
    case "checkin": {
      allow("POST");
      const seat = seatFor(server, req, url, match);
      const body = await readJson(req, MAX_BODY);
      match.seen(seat);
      const rs = match.remote[seat];
      if (!rs || match.agents[seat]?.leftAt) throw new HttpError(409, "you left this match");
      const res = rs.submitCheckin(body, () => match.runner?.match.fight?.controllers[seat]?.strategy ?? null);
      if (!res.ok) {
        server.log(`match ${match.id}: seat ${seat} check-in rejected (${res.status}): ${res.error}${res.problems ? `: ${res.problems.join("; ")}` : ""}`);
        throw new HttpError(res.status, res.error, res.problems);
      }
      return json({ accepted: true, round: body.round, tick: body.tick, result: res.result, changed: res.changed, ...(res.line ? { line: res.line } : {}) });
    }
  }
  throw new HttpError(404, "no such endpoint");
}
