/**
 * HTTP for the matchmaker's queue (#22) and the JOIN panel's backend (#42):
 *
 *   GET    /api/queue                 who is waiting (names), seats needed, when AI seats fill, the guardrails
 *   GET    /api/queue?name=X          ... plus X's place in the queue
 *   POST   /api/queue                 { name, persona, look?, model?, line?, ruleset? } -> { ticket, position, ... }
 *   GET    /api/queue/:ticket?wait=25 long poll: { status: queued, position } or { status: seated, match, seat, token }
 *   DELETE /api/queue/:ticket         leave the queue
 *   GET    /api/join?name=&persona=&owner=   per-client commands (Claude Code, Codex, Grok, JSON / HTTP) with this
 *                                     server's public URL, a ready first prompt, and the queue (X's place with ?name)
 *
 * The ticket is the agent's secret until it is seated; the seat token then works as with POST /api/matches/:id/join.
 */
import { joinSnippet, type JoinTab } from "../site/data";
import { HttpError, json, MAX_BODY, readJson } from "./limits";
import type { MatchServer } from "./match-server";
import type { Matchmaker } from "./matchmaker";

const WAIT_MAX_S = 25;
const TABS: JoinTab[] = ["claude", "codex", "grok", "json"];

/** The server's public base URL: the configured one, else the request's origin (honouring a proxy's https). */
export function publicBase(req: Request, configured?: string): string {
  if (configured) return configured.replace(/\/$/, "");
  const u = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return `${proto === "https" || proto === "http" ? proto : u.protocol.replace(":", "")}://${u.host}`;
}

function queued(mm: Matchmaker, ticket: string) {
  const s = mm.summary();
  const e = mm.entry(ticket)!;
  return { status: "queued", agent: e.name, position: mm.position(e.name), waiting: s.waiting.length, needed: s.needed, fillsInSec: s.fillsInSec, blocked: s.blocked, poll: `/api/queue/${ticket}?wait=${WAIT_MAX_S}` };
}

function seated(mm: Matchmaker, ticket: string) {
  const e = mm.entry(ticket)!;
  mm.pickedUp(ticket);
  const { match, seat, token } = e.seated!;
  return { status: "seated", agent: e.name, match, seat, token, auth: `Authorization: Bearer ${token}`, turn: `/api/matches/${match}/turn?wait=${WAIT_MAX_S}`, watch: `/watch/${match}` };
}

export async function queueRoute(server: MatchServer, req: Request, path: string, url: URL, ip: string): Promise<Response | null> {
  if (path !== "/api/queue" && path !== "/api/join" && !path.startsWith("/api/queue/")) return null;
  const mm = server.matchmaker;
  if (!mm) throw new HttpError(404, "this server has no lobby queue (started with --no-mcp?)");
  const method = req.method;

  if (path === "/api/join") {
    if (method !== "GET") throw new HttpError(405, "use GET for /api/join", undefined, { allow: "GET" });
    const base = publicBase(req, mm.opts.publicUrl);
    const q = (k: string, max: number) => (url.searchParams.get(k) ?? "").slice(0, max);
    const fields = { name: q("name", 24), persona: q("persona", 600), owner: q("owner", 40) };
    const clients = Object.fromEntries(TABS.map((t) => [t, joinSnippet(t, `${base}/mcp`, fields)]));
    const summary = mm.summary();
    return json({
      publicUrl: base,
      mcp: `${base}/mcp`,
      api: `${base}/api`,
      lobby: `${base}/lobby`,
      prompt: clients.claude!.prompt,
      clients,
      http: { queue: `POST ${base}/api/queue { name, persona, model?, line? } -> { ticket }`, poll: `GET ${base}/api/queue/<ticket>?wait=${WAIT_MAX_S} -> { status: seated, match, seat, token }`, play: `GET /api/matches/<match>/turn, POST /api/matches/<match>/plan (Authorization: Bearer <token>)` },
      queue: { waiting: summary.waiting.length, needed: summary.needed, fillsInSec: summary.fillsInSec, fillAfterSec: summary.fillAfterSec, blocked: summary.blocked },
      ...(fields.name ? { you: { name: fields.name, position: mm.position(fields.name) } } : {}),
    });
  }

  if (path === "/api/queue") {
    if (method === "GET") {
      const name = url.searchParams.get("name");
      return json({ ...mm.summary(), ...(name ? { you: { name: name.slice(0, 24), position: mm.position(name) } } : {}) });
    }
    if (method !== "POST") throw new HttpError(405, "use GET or POST for /api/queue", undefined, { allow: "GET, POST" });
    const body = await readJson(req, MAX_BODY);
    const { ruleset, ...join } = body;
    if (ruleset !== undefined && typeof ruleset !== "string") throw new HttpError(400, "ruleset: a preset name");
    const e = await mm.enqueue(join, ip, ruleset as string | undefined);
    return json({ ticket: e.ticket, ...(e.seated ? seated(mm, e.ticket) : queued(mm, e.ticket)) }, 201);
  }

  const m = /^\/api\/queue\/(qt_[0-9a-f]{24})$/.exec(path);
  if (!m) throw new HttpError(404, "no such queue ticket");
  const ticket = m[1]!;
  if (method === "DELETE") {
    if (!mm.leave(ticket)) throw new HttpError(404, "not in the queue");
    return json({ left: true });
  }
  if (method !== "GET") throw new HttpError(405, "use GET or DELETE", undefined, { allow: "GET, DELETE" });
  if (!mm.entry(ticket)) throw new HttpError(404, "not in the queue (left, dropped after a silence, or the server restarted): POST /api/queue again");
  const wait = Math.max(0, Math.min(WAIT_MAX_S, Number(url.searchParams.get("wait") ?? 0) || 0));
  const until = Date.now() + wait * 1000;
  for (;;) {
    const e = mm.entry(ticket);
    if (!e) throw new HttpError(404, "not in the queue any more: POST /api/queue again");
    if (e.seated) return json(seated(mm, ticket));
    if (Date.now() >= until || req.signal.aborted) return json(queued(mm, ticket));
    await mm.nextChange(until - Date.now(), req.signal);
  }
}
