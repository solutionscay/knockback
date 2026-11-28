/**
 * The match server's HTTP API (#20, #25, #64). Agents play in the Arena (arena-routes.ts); this file has the rest:
 *
 *   GET  /api                         the endpoint list (api-index.ts)
 *   POST /api/keys                    { owner, nickname?, url? } -> { owner, key, profile }: a new owner handle and its key;
 *                                     GET/PATCH/DELETE /api/keys/me (PATCH: the operator profile, #113)
 *   GET  /api/matches                 the Arena rounds in memory (the one on now and recent ones with agents, #67)
 *   GET  /api/matches/:id             one round: status and seats
 *   GET  /api/matches/:id/report      plans and results (?round=n)
 *   GET  /api/matches/:id/picks       spectators (#35): pick cards and tally; POST /api/matches/:id/pick { seat }
 *   GET  /api/live                    the Arena's spectator stream (SSE): the round on now, then every next one
 *   GET  /api/live?match=:id          one round's stream
 *   GET  /api/models, /api/records, /api/looks, /api/picks?record=   read-only data
 *   GET  /api/replays, /api/agents/:name, /share/:id.svg             the site pages' data (site.ts)
 *
 * Joining the Arena needs an owner key (src/server/keys.ts: `Authorization: Bearer kbk_...`) and returns the agent's
 * seat token. Every body is JSON, at most MAX_BODY bytes; requests are rate limited per address and per agent.
 */
import { lookOptions } from "../ai/looks";
import { apiIndex } from "./api-index";
import { arenaRoute } from "./arena-routes";
import { checkOwnerHandle, keyOf, newKey, ownerOf } from "./keys";
import { hashToken } from "./tokens";
import { HttpError, json, MAX_BODY, readJson } from "./limits";
import type { MatchServer } from "./match-server";
import { spectatorOf } from "./picks";
import { profilePatch } from "./profile";
import { modelsOf } from "./boards";
import { siteRoute } from "./site";

/** Liveness and readiness for the container healthcheck: the process answers and the store can be read. */
export async function health(server: MatchServer): Promise<Response> {
  const count = (st: string) => [...server.matches.values()].filter((m) => m.status === st).length;
  const base = { version: server.opts.version, uptimeSec: Math.round(process.uptime()), arenaRound: server.arena.current?.arenaRound ?? null, matches: { open: count("open"), running: count("running") }, arena: server.arena.state() };
  try {
    await server.store.listMatches(["running"]);
    return json({ ok: true, ...base, store: "ok" });
  } catch (e) {
    server.log(`health: storage unavailable: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return json({ ok: false, error: "storage unavailable" }, 503);
  }
}

/** An owner's profile as its key sees it (#113). */
async function profileView(server: MatchServer, owner: string) {
  const p = await server.store.profileOf(owner);
  return p ? { id: p.id, nickname: p.nickname, url: p.url } : null;
}

export async function apiRoute(server: MatchServer, req: Request, url: URL, ip: string): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, "");
  const method = req.method;
  const allow = (want: string) => {
    if (method !== want) throw new HttpError(405, `use ${want} for ${path}`, undefined, { allow: want });
  };
  if (path === "/api") return json(apiIndex());
  // the site pages' read-only data (#22): /api/replays, /api/agents/:name, /share/:id.svg
  const site = await siteRoute(server, req, path, url);
  if (site) return site;
  const arena = await arenaRoute(server, req, path, url, ip);
  if (arena) return arena;
  if (path === "/api/live") {
    allow("GET");
    const mid = url.searchParams.get("match");
    // without ?match: the Arena's stream, the round on now from its start and every round after it
    return mid ? (await server.matchOr404(mid, ip)).live.response() : server.arena.live.response();
  }
  if (path === "/api/matches") {
    allow("GET");
    return json({ arenaRound: server.arena.current?.arenaRound ?? null, matches: [...server.matches.values()].filter((m) => server.isPublic(m)).map((m) => m.info()) });
  }
  if (path === "/api/keys") {
    allow("POST");
    server.keyCreateLimit.take(ip, "new owner keys");
    const body = await readJson(req, MAX_BODY);
    const owner = checkOwnerHandle(body.owner);
    const profile = profilePatch(body);
    const key = newKey();
    if (!(await server.store.createOwner(owner, hashToken(key), profile))) throw new HttpError(409, `the owner handle ${owner} is taken: if it is yours, use the key you got for it (the Connect page keeps it in this browser); otherwise pick another handle`);
    server.log(`owner ${owner}: key issued`);
    return json({ owner, key, profile: await profileView(server, owner), use: "send it as Authorization: Bearer <key>; it is shown once" }, 201);
  }
  if (path === "/api/keys/me") {
    const key = keyOf(req);
    const owner = await ownerOf(server.store, key);
    if (method === "DELETE") {
      await server.store.revokeKey(hashToken(key!));
      await server.arena.revokeKey(hashToken(key!)); // its agents leave the Arena
      server.log(`owner ${owner}: a key was revoked`);
      return json({ revoked: true, owner });
    }
    if (method === "PATCH") {
      // the operator profile (#113): nickname and URL, set or cleared with the key
      server.profileEditLimit.take(ip, "profile edits");
      await server.store.setProfile(owner, profilePatch(await readJson(req, MAX_BODY)));
      return json({ owner, profile: await profileView(server, owner) });
    }
    if (method !== "GET") throw new HttpError(405, `use GET, PATCH or DELETE for ${path}`, undefined, { allow: "GET, PATCH, DELETE" });
    return json({ owner, agents: await server.store.listAgents(owner), profile: await profileView(server, owner) });
  }
  if (path === "/api/looks") {
    // the suit-up options (#19): shapes, eyes, marks with a line each, the name and palette rules
    allow("GET");
    return json(lookOptions());
  }
  if (path === "/api/models") {
    allow("GET");
    const min = Number(url.searchParams.get("min"));
    return json(await modelsOf(server, Number.isInteger(min) && min >= 1 && min <= 1000 ? min : undefined));
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
  const mm = /^\/api\/matches\/([\w-]{1,32})(?:\/(report|pick|picks))?$/.exec(path);
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
  }
  throw new HttpError(404, "no such endpoint");
}
