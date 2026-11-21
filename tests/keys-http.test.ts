/**
 * Contract 2: owner keys over HTTP. POST /api/keys issues a key; joining needs it in the Authorization header (no
 * key, a key in ?key=, an unknown or revoked key: 401); an agent name stays bound to the owner who used it first
 * (409 for another owner). The server runs in-process (MatchServer.handle): no port, no network.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MatchServer } from "../src/server/match-server";

const outDir = mkdtempSync(join(tmpdir(), "kb-keys-"));
const api = new MatchServer({ outDir });
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

const SOUL = "A patient sniper who waits on high ground and never wastes a shot. Speaks in calm, short sentences.";
let ipN = 0;
/** One request; each from its own address so per-address limits never decide a result. */
async function call(method: string, path: string, opts: { key?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  const res = (await api.handle(new Request(`http://kb.test${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) }), `10.1.0.${++ipN}`))!;
  return { status: res.status, data: (await res.json()) as any };
}
const newKey = async (owner: string) => {
  const r = await call("POST", "/api/keys", { body: { owner } });
  expect(r.status).toBe(201);
  return r.data.key as string;
};
/** An open match with 4 agent seats (it never starts during the test). */
const openMatch = async () => (await api.createMatch({ seats: ["remote", "remote", "remote", "remote"], fillAfterMs: 3_600_000 })).id;
const joinAs = (match: string, name: string, opts: { key?: string; query?: string } = {}) => call("POST", `/api/matches/${match}/join${opts.query ?? ""}`, { key: opts.key, body: { name, model: "claude-opus-5-5", soul: SOUL } });

describe("owner keys over HTTP", () => {
  test("POST /api/keys issues a key once per handle", async () => {
    const r = await call("POST", "/api/keys", { body: { owner: "Ada" } });
    expect(r.status).toBe(201);
    expect(r.data).toMatchObject({ owner: "Ada" });
    expect(r.data.key).toMatch(/^kbk_[0-9a-f]{32}$/);
    expect((await call("POST", "/api/keys", { body: { owner: "ada" } })).status).toBe(409); // taken, ignoring case
    expect((await call("POST", "/api/keys", { body: { owner: "" } })).status).toBe(400);
    expect((await call("GET", "/api/keys/me", { key: r.data.key })).data).toEqual({ owner: "Ada", agents: [] });
  });

  test("a join needs the key in the Authorization header", async () => {
    const key = await newKey("Bea");
    const m = await openMatch();
    expect((await joinAs(m, "Nokey")).status).toBe(401);
    expect((await joinAs(m, "Urlkey", { query: `?key=${key}` })).status).toBe(401);
    expect((await joinAs(m, "Wrongkey", { key: `kbk_${"0".repeat(32)}` })).status).toBe(401);
    const ok = await joinAs(m, "Withkey", { key });
    expect(ok.status).toBe(201);
    expect(typeof ok.data.token).toBe("string");
    expect((await call("GET", "/api/keys/me", { key })).data.agents).toEqual(["Withkey"]);
  });

  test("a revoked key gets 401", async () => {
    const key = await newKey("Cy");
    const m = await openMatch();
    expect((await call("DELETE", "/api/keys/me", { key })).data).toEqual({ revoked: true, owner: "Cy" });
    expect((await joinAs(m, "Revoked", { key })).status).toBe(401);
    expect((await call("GET", "/api/keys/me", { key })).status).toBe(401);
  });

  test("an agent name stays bound to its owner", async () => {
    const [dee, eve] = [await newKey("Dee"), await newKey("Eve")];
    expect((await joinAs(await openMatch(), "Striker", { key: dee })).status).toBe(201);
    const taken = await joinAs(await openMatch(), "striker", { key: eve });
    expect(taken.status).toBe(409);
    expect(taken.data.error).toContain("belongs to another owner");
    expect((await joinAs(await openMatch(), "STRIKER", { key: dee })).status).toBe(201); // the owner keeps it
  });
});
