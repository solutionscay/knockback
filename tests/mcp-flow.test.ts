/**
 * Contract 3: the MCP flow an agent told "play Knockback" goes through in the Arena (#64): with its owner key it
 * calls get_started, join_lobby (it claims a house bot's seat), wait_for_match, then wait_for_turn / submit_plan
 * round after round, reads its rounds' results and reports, and leaves. A bad plan comes back as an error that says
 * what to fix. Its build (#80) is played, the record replays it, and the next briefing reports it. Without the key in the Authorization header there is no session; a closed session leaves the Arena.
 *
 * Everything runs in-process: the MCP client's fetch goes straight into the gateway, rounds run at fast pace (the
 * test drives the Arena's rounds), house bots hold the other seats. Turn deadlines are far away, so no result
 * depends on time.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MatchServer } from "../src/server/match-server";
import { McpGateway } from "../src/server/mcp";
import { CLASSIC, initPhysics, replayMatch, type MatchRecord } from "../src/sim";

const outDir = mkdtempSync(join(tmpdir(), "kb-mcp-"));
const api = new MatchServer({ outDir, pace: "fast", arena: { deadlineMs: 600_000 } });
const gw = new McpGateway(api, { publicUrl: "http://kb.test" });
beforeAll(async () => {
  await initPhysics();
});
afterAll(() => {
  gw.close();
  rmSync(outDir, { recursive: true, force: true });
});

const SOUL = "A cocky bruiser who loves the bat and a good ring-out. Talks in short, loud taunts and never backs down.";
const PLAN = { weapons: ["rocket", "bat"], target: "weakest", stance: "rush", retaliate: "attacker", rules: [{ when: "my_health_below", value: 30, do: "seek", item: "health", label: "patch up" }], why: "rush the weak one" };

async function ownerKey(owner: string): Promise<string> {
  const res = (await api.handle(new Request("http://kb.test/api/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner }) })))!;
  return ((await res.json()) as { key: string }).key;
}

/** An MCP client whose HTTP goes into the gateway in-process. */
async function connect(opts: { key?: string; url?: string }) {
  const client = new Client({ name: "test-agent", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(opts.url ?? "http://kb.test/mcp"), {
    fetch: (url, init) => gw.handle(new Request(url, init as RequestInit), "10.2.0.1"),
    ...(opts.key ? { requestInit: { headers: { authorization: `Bearer ${opts.key}` } } } : {}),
  });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = r.content.map((c) => c.text).join("");
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* plain text */
    }
    return { data, isError: !!r.isError };
  };
  return { client, transport, call };
}

describe("MCP flow", () => {
  test("no session without the owner key in the Authorization header", async () => {
    const key = await ownerKey("Nokey");
    await expect(connect({})).rejects.toThrow(/owner key is needed/);
    await expect(connect({ url: `http://kb.test/mcp?key=${key}` })).rejects.toThrow(/owner key is needed/);
  });

  test("a revoked key ends its session", async () => {
    const key = await ownerKey("Cy");
    const a = await connect({ key });
    expect((await a.call("get_started")).isError).toBe(false);
    await api.handle(new Request("http://kb.test/api/keys/me", { method: "DELETE", headers: { authorization: `Bearer ${key}` } }));
    await expect(a.call("get_started")).rejects.toThrow(/revoked/);
    await expect(connect({ key })).rejects.toThrow(/unknown or revoked/);
  });

  test("an agent plays round after round in the Arena; a bad plan is refused with what to fix", async () => {
    const a = await connect({ key: await ownerKey("Ada") });
    const start = await a.call("get_started");
    expect(start.isError).toBe(false);
    expect(start.data).toMatchObject({ owner: "Ada", next: "call join_lobby" });
    expect(start.data.arena.rules.join(" ")).toContain("2 rounds in a row");
    expect(start.data.build).toContain('tank {"health":2,"weight":0,"power":-2}');

    const joined = await a.call("join_lobby", { name: "Basher", model: "claude-opus-5-5", soul: SOUL });
    expect(joined.isError).toBe(false);
    expect(joined.data).toMatchObject({ joined: true, status: "seated", seat: 0, entersRound: 1 });

    // the Arena plays its rounds meanwhile (each one waits for Basher's plan)
    let stop = false;
    const rounds = (async () => {
      while (!stop) await api.arena.playRound();
    })();

    let w = await a.call("wait_for_match");
    while (w.data.status !== "started") w = await a.call("wait_for_match");
    expect(w.data).toMatchObject({ status: "started", round: 1, you: { seat: 0 } });
    const me: string = w.data.you.fighter;
    expect(w.data.lineUp.map((s: { player: string }) => s.player)).toEqual(["agent Basher", "house bot", "house bot", "house bot"]);

    const fixes: string[][] = [];
    const planned: number[] = [];
    const BUILDS = [{ health: 2, weight: -1, power: -1 }, { health: -1, weight: 0, power: 1 }];
    const briefings: string[] = [];
    while (planned.length < 2) {
      const t = await a.call("wait_for_turn");
      expect(t.isError).toBe(false);
      if (t.data.status !== "turn") continue;
      expect(t.data.targets).not.toContain(me);
      expect(t.data.arena.length).toBeGreaterThan(0); // the briefing carries the Arena rules
      briefings.push(t.data.briefing);
      // one bad plan per round: itself as the target, the same weapon twice, a build that does not add up to 0
      const bad = await a.call("submit_plan", { line: "Wrong on purpose.", strategy: { ...PLAN, target: me, weapons: ["bat", "bat"], build: { health: 1, weight: 1, power: 0 } } });
      expect(bad.isError).toBe(true);
      expect(bad.data.rejected).toBe(true);
      fixes.push(bad.data.fix);
      const build = BUILDS[planned.length]!;
      const ok = await a.call("submit_plan", { line: `Round ${t.data.round}, here I come.`, strategy: { ...PLAN, target: t.data.targets[0], build } });
      expect(ok.isError).toBe(false);
      expect(ok.data).toMatchObject({ accepted: true, round: t.data.round, plan: { stance: "rush", weapons: ["rocket", "bat"], build } });
      planned.push(t.data.round);
    }
    expect(planned).toEqual([1, 2]);
    for (const fix of fixes) {
      expect(fix.find((f) => f.startsWith("target"))).toContain("never your own name");
      expect(fix.find((f) => f.startsWith("weapons"))).toContain("different");
      expect(fix.find((f) => f.startsWith("build"))).toContain("the levels add up to +2; they must add up to 0");
    }
    // the briefing explains builds; round 2's briefing reports round 1's builds and how Basher's did
    expect(briefings[0]).toContain("BUILD: your fighter's body for the round.");
    expect(briefings[0]).not.toContain("BUILDS LAST ROUND");
    expect(briefings[1]).toStartWith("Round 1: BUILDS LAST ROUND: ");
    expect(briefings[1]).toContain("YOUR BUILD (health +2, weight -1, power -1): place ");

    // round 2's result comes with the next answer; its record replays to the same fight
    let t = await a.call("wait_for_turn");
    while (t.data.lastRound?.round !== 2) t = await a.call("wait_for_turn");
    expect(t.data.lastRound).toMatchObject({ round: 2, youPlanned: true });
    const report = await a.call("get_round_report", { round: 2 });
    expect(report.data.plans[0].line).toBe("Round 2, here I come.");
    const path = new URL(t.data.lastRound.replay).searchParams.get("record")!.replace(/^\/records\//, "");
    const rec = JSON.parse(readFileSync(join(outDir, path), "utf8")) as MatchRecord;
    expect(rec.rounds).toHaveLength(1);
    expect(rec.rounds[0]!.strategies[0]!.build).toEqual(BUILDS[1]);
    const replay = replayMatch(rec);
    expect(replay.record.rounds[0]!.fight.finalHash).toBe(rec.rounds[0]!.fight.finalHash);
    // played: Basher's body in the replayed fight is its build's (health -1: 8 HP under the base)
    expect(replay.fight!.sim.fighters[0]!.maxHp).toBe(CLASSIC.combat.fighter.maxHp + CLASSIC.builds.health.hpBonus[1]!);
    expect(replay.names[replay.winner]).toBe(report.data.winner);

    stop = true;
    expect((await a.call("leave")).data).toMatchObject({ left: true, agent: "Basher" });
    expect((await a.call("wait_for_turn")).data.error).toContain("not in the Arena");
    await rounds;
    expect(api.arena.seats[0]).toBeNull();
    await a.client.close();
  });

  test("a closed MCP session leaves the Arena: a house bot takes its seat", async () => {
    const b = await connect({ key: await ownerKey("Bo") });
    expect((await b.call("join_lobby", { name: "Ghost", model: "claude-opus-5-5", soul: SOUL })).data).toMatchObject({ status: "seated" });
    expect(api.arena.seats.some((e) => e?.name === "Ghost")).toBe(true);
    await b.transport.terminateSession(); // DELETE /mcp: the session is over
    await b.client.close();
    expect(api.arena.seats.some((e) => e?.name === "Ghost")).toBe(false);
  });
});
