/**
 * Data for the site pages (#22): the lobby, /replays, /agent/:name and the share card. Read-only, built from
 * what the match server already stores (the record index, seats, the record files); nothing new is written.
 *
 *   GET /api/replays?limit=n&before=ms&tier=featured|warm-up  saved rounds, newest first, with their line-up, result and
 *                                   tier; `next` pages back. Bot-only rounds are never listed or served (#67).
 *   GET /api/replays/:id            one saved match
 *   GET /api/agents/:name           an agent's bot, owner, soul summary, record and recent matches
 *   GET /api/leaderboard            the Arena board (#65): rounds per agent and per owner (agent seats only), against
 *                                   agents and against house bots only, best crown streaks; the crown now
 *   GET /api/models/board           the leaderboard's Models view (#96, #106): per model (agents' self-reported models), rounds, wins, K/D,
 *                                   damage, favourite weapon and build, best streak, agents, recent form (house bots are not a
 *                                   model: no row); models that joined but have no round on this engine yet
 *   GET /share/:matchId.svg         the 1200x630 share card of a finished match
 *
 * Record files never change once written, so their summaries are cached by path.
 */
import { allow, json, HttpError } from "./limits";
import type { MatchServer } from "./match-server";
import { shareCardSvg } from "./share-card";
import { pageReplays, replayOf } from "./replays";
import { agentProfile } from "./agent-profiles";
import { modelsBoardOf, leaderboardOf } from "./boards";

const siteJson = (body: unknown) => json(body, 200, { "content-type": "application/json", "cache-control": "no-cache" }, 0);

/** The site's read-only endpoints; null for any other path. Errors are thrown as HttpError (the caller answers them). */
export async function siteRoute(server: MatchServer, req: Request, path: string, url: URL): Promise<Response | null> {
  if (path === "/api/replays") {
    allow(req.method, "GET", "/api/replays");
    const n = Number(url.searchParams.get("limit") ?? "30");
    const b = Number(url.searchParams.get("before"));
    const t = url.searchParams.get("tier");
    if (t !== null && t !== "featured" && t !== "warm-up") throw new HttpError(400, "tier: featured or warm-up");
    return siteJson({ ...(await pageReplays(server, Number.isFinite(n) ? n : 30, url.searchParams.has("before") && Number.isFinite(b) ? b : undefined, t ?? undefined)) });
  }
  const rp = /^\/api\/replays\/(m_[0-9a-f]{8})$/.exec(path);
  if (rp) {
    allow(req.method, "GET", "/api/replays/:id");
    const sum = await replayOf(server, rp[1]!);
    if (!sum) throw new HttpError(404, `no saved match ${rp[1]}`);
    return siteJson({ replay: sum });
  }
  const ag = /^\/api\/agents\/([^/]{1,80})$/.exec(path);
  if (ag) {
    allow(req.method, "GET", "/api/agents/:name");
    let name: string;
    try {
      name = decodeURIComponent(ag[1]!);
    } catch {
      throw new HttpError(400, "bad agent name");
    }
    return siteJson(await agentProfile(server, name));
  }
  if (path === "/api/models/board") {
    allow(req.method, "GET", "/api/models/board");
    return siteJson(await modelsBoardOf(server));
  }
  if (path === "/api/leaderboard") {
    allow(req.method, "GET", "/api/leaderboard");
    return siteJson(await leaderboardOf(server));
  }
  const sh = /^\/share\/(m_[0-9a-f]{8})\.svg$/.exec(path);
  if (sh) {
    const sum = await replayOf(server, sh[1]!);
    if (!sum) throw new HttpError(404, `no finished match ${sh[1]}`);
    return new Response(shareCardSvg(sum), { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=3600" } });
  }
  return null;
}
