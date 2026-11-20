import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerStubs } from "../src/ai/providers";
import { MatchServer } from "../src/server/match-server";
import { labelText, personaSummary, placeOf, shareCardSvg, summarizeReplay } from "../src/server/site";
import { initPhysics } from "../src/sim";
import { ENGINE_VERSION } from "../src/sim/engine-version";
import { posOfBeat, reached } from "../src/viewer/embed";

setDefaultTimeout(120_000);
beforeAll(async () => {
  await initPhysics();
  registerStubs(5);
});

const SOUL = readFileSync("souls/rat.md", "utf8");
const tmp = () => mkdtempSync(join(tmpdir(), "kb-site-"));
const PLAN = { weapons: ["rocket", "bat"], target: "weakest", stance: "rush", retaliate: "attacker", line: "Coming through!" };

async function get(s: MatchServer, path: string) {
  const res = (await s.handle(new Request(`http://kb.test${path}`), "9.9.9.9"))!;
  return { status: res.status, type: res.headers.get("content-type") ?? "", body: res.headers.get("content-type")?.includes("json") ? ((await res.json()) as any) : await res.text() };
}

/** One finished match with a remote agent "Brixel" in seat 0 and house bots. */
async function playedServer() {
  const s = new MatchServer({ outDir: tmp(), open: true });
  const m = await s.createMatch({ seats: ["remote", "house", "house", "house"], seed: 3, deadlineMs: 5000 });
  const call = (method: string, path: string, body?: unknown) => s.handle(new Request(`http://kb.test${path}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }), "1.2.3.4").then(async (r) => ({ status: r!.status, data: (await r!.json()) as any }));
  expect((await call("POST", `/api/matches/${m.id}/join`, { name: "Brixel", persona: SOUL })).status).toBe(201);
  for (;;) {
    const t = (await call("GET", `/api/matches/${m.id}/turn?seat=0&wait=5`)).data;
    if (t.status === "over") break;
    if (t.status === "turn") expect((await call("POST", `/api/matches/${m.id}/plan?seat=0`, { round: t.round, ...PLAN })).status).toBe(200);
  }
  return { s, m };
}

describe("site data (#22)", () => {
  test("/api/replays, /api/agents/:name, /share/:id.svg and the report's knockout ticks after a real match", async () => {
    const { s, m } = await playedServer();
    const rp = await get(s, "/api/replays");
    expect(rp.status).toBe(200);
    const r = rp.body.replays[0];
    expect(r).toMatchObject({ match: m.id, seed: 3, old: false, labels: ["remote/Brixel", "house", "house", "house"] });
    expect(r.identities).toHaveLength(4);
    expect(r.names).toEqual(r.identities.map((i: any) => i.name));
    expect(r.rounds.length).toBeGreaterThanOrEqual(2);
    expect(r.rounds[0].plans[0]).toEqual({ stance: "rush", target: "weakest", weapons: ["rocket", "bat"] });
    expect(r.rounds[0].lines[0]).toBe("Coming through!");
    expect(r.wins.reduce((a: number, b: number) => a + b, 0)).toBe(r.rounds.length);
    expect(typeof r.theme).toBe("string");

    const ag = await get(s, "/api/agents/brixel"); // case-insensitive
    expect(ag.status).toBe(200);
    expect(ag.body).toMatchObject({ name: "Brixel", label: "remote/Brixel", signature: "Coming through!", style: { stance: "rush", target: "weakest", weapon: "rocket" } });
    expect(ag.body.stats.matches).toBe(1);
    expect(ag.body.stats.won + ag.body.stats.lost).toBe(1);
    expect(ag.body.stats.rounds).toBe(r.rounds.length);
    expect(ag.body.identity.name).toBe(r.names[0]);
    expect(ag.body.summary.length).toBeGreaterThan(20);
    expect(ag.body.matches[0]).toMatchObject({ match: m.id, seat: 0, status: "over", record: r.record });
    expect(ag.body.matches[0].rivals).toHaveLength(3);
    expect((await get(s, "/api/agents/Nobody")).status).toBe(404);
    expect((await get(s, "/api/agents/%21bad")).status).toBe(400);

    const card = await get(s, `/share/${m.id}.svg`);
    expect(card.status).toBe(200);
    expect(card.type).toContain("image/svg+xml");
    expect(card.body).toContain('width="1200" height="630"');
    expect(card.body).toContain(`${r.names[r.winner].toUpperCase()}`);
    expect((await get(s, "/share/m_00000000.svg")).status).toBe(404);

    const rep = await get(s, `/api/matches/${m.id}/report`);
    for (const round of rep.body.rounds) {
      expect(round.result.ticks).toBeGreaterThan(0);
      for (const k of round.result.knockouts) expect(k.tick === null || (k.tick >= 0 && k.tick <= round.result.ticks)).toBe(true);
    }
  });

  test("summarizeReplay reads a version 2 record without simulating it", () => {
    const raw = JSON.parse(readFileSync("tests/fixtures/record-v2-match-1001.json", "utf8"));
    const r = summarizeReplay(raw, "m_00000001", "/records/x.json", 0)!;
    expect(r.old).toBe(r.engine !== ENGINE_VERSION);
    expect(r.names).toHaveLength(4);
    expect(r.rounds.length).toBe(raw.rounds.length);
    expect(summarizeReplay({ nope: 1 }, "m", "/r", 0)).toBeNull();
  });

  test("personaSummary, placeOf and labelText", () => {
    const p = personaSummary(SOUL);
    expect(p.summary.length).toBeGreaterThan(20);
    expect(p.summary.length).toBeLessThanOrEqual(281);
    expect(p.summary).not.toContain("#");
    expect(p.summary).not.toContain("**");
    expect(placeOf(2, 2, [0, 0, 2, 1])).toBe(1);
    expect(placeOf(3, 2, [0, 0, 2, 1])).toBe(2);
    expect(placeOf(0, 2, [0, 0, 2, 1])).toBe(3);
    expect(placeOf(1, 2, [0, 0, 2, 1])).toBe(3); // ties share the better place
    expect(labelText("claude/haiku")).toBe("CLAUDE HAIKU");
    expect(labelText("grok/grok-4.6")).toBe("GROK 4.6");
    expect(labelText("codex/gpt-6-luna")).toBe("GPT 6 LUNA");
    expect(labelText("house")).toBe("HOUSE BOT");
    expect(labelText("remote/Brixel")).toBe("AGENT");
    expect(labelText("remote/Brixel@claude-opus-5-5")).toBe("CLAUDE-OPUS-5-5");
  });

  test("shareCardSvg escapes names", () => {
    const raw = JSON.parse(readFileSync("tests/fixtures/record-v2-match-1001.json", "utf8"));
    const r = summarizeReplay(raw, "m_00000001", "/records/x.json", 0)!;
    r.names[r.winner] = "<b>&";
    expect(shareCardSvg(r)).not.toContain("<b>&");
  });
});

describe("viewer embed bridge positions", () => {
  test("posOfBeat maps beats to round, phase and tick", () => {
    expect(posOfBeat({ kind: "level", duration: 2 }, 0, 0)).toEqual({ round: 1, phase: "plan", tick: 0 });
    expect(posOfBeat({ kind: "dialogue", fighter: 1, phase: "between", round: 2, duration: 2 }, 900, 1)).toEqual({ round: 2, phase: "plan", tick: 0 });
    expect(posOfBeat({ kind: "fight", round: 2, duration: null }, 600, 1)).toEqual({ round: 2, phase: "fight", tick: 600 });
    expect(posOfBeat({ kind: "roundEnd", round: 2, duration: 4 }, 2000, 2)).toEqual({ round: 2, phase: "end", tick: 2000 });
    expect(posOfBeat({ kind: "celebrate", duration: 9 }, 2000, 3)).toEqual({ round: 3, phase: "end", tick: 2000, done: true });
  });
  test("reached orders round, phase, tick; done reaches everything", () => {
    expect(reached({ round: 2, phase: "plan", tick: 0 }, { round: 1, phase: "end", tick: 0 })).toBe(true);
    expect(reached({ round: 1, phase: "fight", tick: 100 }, { round: 1, phase: "fight", tick: 200 })).toBe(false);
    expect(reached({ round: 1, phase: "fight", tick: 200 }, { round: 1, phase: "fight", tick: 200 })).toBe(true);
    expect(reached({ round: 1, phase: "plan", tick: 0 }, { round: 1, phase: "fight", tick: 0 })).toBe(false);
    expect(reached({ round: 1, phase: "plan", tick: 0, done: true }, { round: 3, phase: "end", tick: 0 })).toBe(true);
  });
});
