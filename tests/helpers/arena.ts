/**
 * Shared test helpers for the Arena data tests (#65, #67, #76): an in-process match server at fast pace with
 * temporary storage, agents that join and plan over the HTTP API, and a round driver. No port, no real time decides
 * a result (turn deadlines are far away; long polls return on every change).
 */
import { expect } from "bun:test";
import type { ArenaOptions } from "../../src/server/arena";
import { MatchServer } from "../../src/server/match-server";
import type { ServerMatch } from "../../src/server/server-match";
import type { SqliteStore } from "../../src/server/store";

export const SOUL = "A cocky bruiser who loves the bat and a good ring-out. Talks in short, loud taunts and never backs down.";

export const arenaServer = (outDir: string, arena: ArenaOptions = {}, store?: SqliteStore) =>
  new MatchServer({ outDir, pace: "fast", ...(store ? { store } : {}), arena: { deadlineMs: 600_000, seed: (r) => 7000 + r, ...arena } });

let ipN = 0;
/** One request, each from its own address so per-address limits never decide a result. */
export async function call(api: MatchServer, method: string, path: string, opts: { auth?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...opts.headers };
  if (opts.auth) headers.authorization = `Bearer ${opts.auth}`;
  const res = (await api.handle(new Request(`http://kb.test${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) }), `10.7.${Math.floor(++ipN / 250)}.${ipN % 250}`))!;
  const text = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, headers: res.headers, data };
}

const keys = new WeakMap<object, Map<string, string>>();
/** The owner's key (one per owner per store). */
export async function ownerKey(api: MatchServer, owner: string) {
  const mine = keys.get(api.store) ?? new Map<string, string>();
  keys.set(api.store, mine);
  if (!mine.has(owner)) mine.set(owner, (await call(api, "POST", "/api/keys", { body: { owner } })).data.key);
  return mine.get(owner)!;
}

export interface Agent {
  name: string;
  token: string;
}

/** An agent joins the Arena over HTTP (optionally with a User-Agent, #76). */
export async function enter(api: MatchServer, name: string, owner = `${name}-owner`, opts: { model?: string; userAgent?: string } = {}): Promise<Agent & Record<string, any>> {
  const r = await call(api, "POST", "/api/queue", { auth: await ownerKey(api, owner), body: { name, model: opts.model ?? "claude-opus-5-5", soul: SOUL }, ...(opts.userAgent ? { headers: { "user-agent": opts.userAgent } } : {}) });
  expect(r.status).toBe(201);
  return { name, token: r.data.token as string, ...r.data };
}

export const turn = async (api: MatchServer, token: string, wait = 0) => (await call(api, "GET", `/api/arena/turn?wait=${wait}`, { auth: token })).data;

async function untilTurn(api: MatchServer, token: string) {
  for (;;) {
    const t = await turn(api, token, 30);
    if (t.status === "turn" || t.status === "out") return t;
  }
}

/** Play one Arena round: every agent seated in it plans when its turn comes. */
export async function round(api: MatchServer, agents: Agent[] = []): Promise<ServerMatch> {
  const seated = agents.filter((a) => api.arena.seats.some((e) => e?.name === a.name));
  const p = api.arena.playRound();
  await Promise.all(
    seated.map(async (a) => {
      const t = await untilTurn(api, a.token);
      if (t.status !== "turn") return;
      const r = await call(api, "POST", "/api/arena/plan", { auth: a.token, body: { round: t.round, weapons: ["rocket", "bat"], target: "weakest", stance: "rush", line: `${a.name} in round ${t.round}.` } });
      expect(r.status).toBe(200);
    }),
  );
  return p;
}
