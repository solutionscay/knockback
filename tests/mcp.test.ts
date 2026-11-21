import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PICKUPS, RULE_RETALIATE, RULE_STANCES } from "../src/sim/rules";
import { RULE_DO, RULE_WHEN, WEAPON_LIST } from "../src/sim/sim-types";
import { Matchmaker, type MatchmakerOptions } from "../src/server/matchmaker";
import { MatchServer } from "../src/server/match-server";
import { briefingOf, fixHints, McpGateway } from "../src/server/mcp";
import { initPhysics, replayMatch } from "../src/sim";

setDefaultTimeout(120_000);
beforeAll(async () => {
  await initPhysics();
});

const SOUL = readFileSync("souls/rat.md", "utf8");
const tmp = () => mkdtempSync(join(tmpdir(), "kb-mcp-"));
const PLAN = { weapons: ["rocket", "bat"], target: "weakest", stance: "rush", retaliate: "attacker", rules: [{ when: "my_health_below", value: 30, do: "seek", item: "health", label: "patch up" }], why: "rush the weak one" };

function setup(lobby: MatchmakerOptions = {}) {
  const api = new MatchServer({ outDir: tmp() });
  const mm = new Matchmaker(api, { deadlineMs: 3000, fillAfterMs: 30_000, tickMs: 50, ...lobby });
  const gw = new McpGateway(api, { lobby: mm, publicUrl: "http://kb.test" });
  const close = gw.close.bind(gw);
  gw.close = () => (mm.close(), close());
  return { api, gw, mm };
}

/** An MCP client whose HTTP goes straight into the gateway; `seen` collects every tool result's text. */
async function connect(gw: McpGateway, ip = "10.0.0.1") {
  const seen: string[] = [];
  const client = new Client({ name: "test-agent", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL("http://kb.test/mcp"), { fetch: (url, init) => gw.handle(new Request(url, init as RequestInit), ip) });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const t = r.content.map((c) => c.text).join("");
    seen.push(t);
    let data: any;
    try {
      data = JSON.parse(t);
    } catch {
      data = t;
    }
    return { data, isError: !!r.isError, text: t };
  };
  return { client, call, seen, transport };
}

/** Play as an MCP agent until the match is over; `bad` sends one invalid plan first each round. */
async function play(a: Awaited<ReturnType<typeof connect>>, name: string, opts: { silent?: boolean; bad?: boolean } = {}) {
  const j = await a.call("join_lobby", { name, persona: SOUL });
  expect(j.isError).toBe(false);
  for (;;) {
    const w = await a.call("wait_for_match");
    if (w.data.status === "started") break;
  }
  const errors: string[] = [];
  for (;;) {
    const t = await a.call("wait_for_turn");
    if (t.data.status === "over") return { over: t.data, errors };
    if (t.data.status !== "turn") continue;
    if (opts.silent) {
      await Bun.sleep(t.data.secondsLeft * 1000 + 1200);
      continue;
    }
    if (opts.bad) {
      const r = await a.call("submit_plan", { line: "Wrong target on purpose.", strategy: { ...PLAN, target: t.data.you.name } });
      expect(r.isError).toBe(true);
      errors.push(...(r.data.fix ?? []));
    }
    const ok = await a.call("submit_plan", { line: `${name} goes in, round ${t.data.round}.`, strategy: { ...PLAN, target: t.data.targets[0] } });
    expect(ok.data.accepted).toBe(true);
  }
}

describe("MCP tools", () => {
  test("seven tools; the plan schema comes from the parser's constants", async () => {
    const { gw } = setup();
    const a = await connect(gw);
    const { tools } = await a.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_round_report", "join_lobby", "leave", "submit_checkin", "submit_plan", "wait_for_match", "wait_for_turn"]);
    const submit = tools.find((t) => t.name === "submit_plan")! as any;
    const st = submit.inputSchema.properties.strategy.properties;
    expect(st.weapons.items.enum).toEqual([...WEAPON_LIST]);
    expect(st.weapons.items.enum).toContain("flamethrower"); // #32
    expect(st.weapons.description).toContain("flamethrower (short cone of fire");
    for (const [weapon, help] of [["mine", "sticky throw"], ["railgun", "charged piercing beam"], ["hammer", "ground shockwave"]]) {
      expect(st.weapons.items.enum).toContain(weapon);
      expect(st.weapons.description).toContain(`${weapon} (${help}`);
      expect(st.rules.items.properties.do_item.enum).toContain(weapon);
    }
    expect(st.stance.enum).toEqual([...RULE_STANCES]);
    expect(st.retaliate.enum).toEqual([...RULE_RETALIATE]);
    expect(st.rules.items.properties.when.enum).toEqual([...RULE_WHEN]);
    expect(st.rules.items.properties.do.enum).toEqual([...RULE_DO]);
    expect(st.rules.items.properties.item.enum).toEqual([...PICKUPS]);
    expect(st.rules.items.properties.do_item.enum).toContain("jetpack");
    expect(st.weapons.items.enum).not.toContain("jetpack");
    expect(submit.description).toContain("Example call: submit_plan(");
    expect(tools.find((t) => t.name === "wait_for_turn")!.description).toContain("call wait_for_turn again");
    gw.close();
  });

  test("a named lobby ruleset updates only the joining client's schemas", async () => {
    const { api, gw } = setup();
    await api.store.putRulesetPreset("Bat Only", { weapons: { enabled: ["bat"] }, pickups: { enabled: ["health"] } });
    const [custom, classic] = await Promise.all([connect(gw), connect(gw, "10.0.0.2")]);
    try {
      const joined = await custom.call("join_lobby", { name: "Batter", persona: SOUL, ruleset: "Bat Only" });
      const standard = await classic.call("join_lobby", { name: "Classic", persona: SOUL });
      expect(joined.isError).toBe(false);
      expect(standard.isError).toBe(false);
      expect(joined.data.ruleset).toBe("Bat Only"); // two rulesets never share a match
      expect(standard.data.ruleset).not.toBe("Bat Only");
      const tools = (await custom.client.listTools()).tools;
      const plan = tools.find(t => t.name === "submit_plan")! as any;
      expect(plan.inputSchema.properties.strategy.properties.weapons.items.enum).toEqual(["bat"]);
      expect(plan.inputSchema.properties.strategy.properties.rules.items.properties.item.enum).toEqual(["bat", "health"]);
      expect(JSON.stringify(tools.find(t => t.name === "submit_checkin"))).not.toContain("railgun");
      expect(JSON.stringify((await classic.client.listTools()).tools.find(t => t.name === "submit_plan"))).toContain("railgun");
      await custom.call("leave");
      expect(JSON.stringify((await custom.client.listTools()).tools.find(t => t.name === "submit_plan"))).toContain("railgun");
    } finally {
      gw.close();
    }
  });

  test("three MCP agents + a house bot play a full match; the seat token never reaches an agent; the record replays", async () => {
    const { api, gw } = setup({ minAgents: 3, fillAfterMs: 0 });
    const agents = await Promise.all(["A", "B", "C"].map((_, i) => connect(gw, `10.0.0.${i + 1}`)));
    const [ra, rb, rc] = await Promise.all([play(agents[0]!, "Alpha", { bad: true }), play(agents[1]!, "Bravo"), play(agents[2]!, "Charlie", { silent: true })]);
    expect(ra.over.winner).toBe(rb.over.winner);
    expect(rc.over.status).toBe("over");
    // one match, all three in it
    const m = [...api.matches.values()][0]!;
    expect(api.matches.size).toBe(1);
    const rounds = m.runner!.match.record.rounds;
    for (const r of rounds) expect(r.meta!.map((x) => x.outcome).filter((_, i) => i !== 2)).toEqual(["ok", "ok", "house"]);
    // the silent agent missed round 1's deadline: the house bot took its fighter (#22); later rounds are
    // autopilot (decided at once) or, if it polled again in between, back and timed out again
    expect(rounds[0]!.meta![2]!.outcome).toBe("fallback-timeout");
    for (const r of rounds.slice(1)) expect(["fallback-timeout", "fallback-error"]).toContain(r.meta![2]!.outcome);
    expect(m.runner!.control[0]).toMatchObject({ seat: 2, mode: "autopilot", round: 1, phase: "plan", reason: "missed the deadline" });
    expect(m.runner!.labels).toEqual(["remote/Alpha", "remote/Bravo", "remote/Charlie", "house"]);
    // rejected plans came back with a fix that names the rivals
    expect(ra.errors.length).toBe(rounds.length);
    expect(ra.errors[0]).toContain("use a rival's name");
    // no tool result ever contained a seat token
    const tokens = [...api.tokens.keys()];
    expect(tokens.length).toBe(3);
    for (const a of agents) for (const t of a.seen) expect(t).not.toMatch(/st_[0-9a-f]{48}/);
    // the record replays
    expect(replayMatch(m.runner!.savedRecord()).record.rounds.map((r) => r.fight.finalHash)).toEqual(rounds.map((r) => r.fight.finalHash));
    const rep = await agents[0]!.call("get_round_report", { round: 1 });
    expect(rep.data.rounds[0].plans[0].decided).toBe("remote/Alpha ok");
    gw.close();
  });

  test("the queue: nothing runs for 3 waiting agents; the 4th opens one match for all four, oldest first", async () => {
    const { api, gw, mm } = setup({ fillAfterMs: 300_000 });
    const agents = await Promise.all([1, 2, 3, 4, 5].map((i) => connect(gw, `10.1.0.${i}`)));
    for (const [i, a] of agents.slice(0, 3).entries()) {
      const j = await a.call("join_lobby", { name: `Q${i}`, persona: SOUL });
      expect(j.data).toMatchObject({ queued: true, position: i + 1, needed: 3 - i, next: "call wait_for_match" });
    }
    expect(api.matches.size).toBe(0); // three agents waiting: no match yet, no house bots
    const w = await agents[0]!.call("wait_for_match");
    expect(w.data).toMatchObject({ status: "waiting", position: 1, waiting: ["Q0", "Q1", "Q2"], next: "call wait_for_match again" });
    // the same name twice is refused (never the same agent twice in a match)
    expect((await agents[4]!.call("join_lobby", { name: "q1", persona: SOUL })).data.error).toContain("already in the queue");
    const fourth = await agents[3]!.call("join_lobby", { name: "Q3", persona: SOUL });
    expect(fourth.data).toMatchObject({ joined: true, seat: 3 });
    expect(api.matches.size).toBe(1);
    const m = [...api.matches.values()][0]!;
    expect(m.kinds).toEqual(["remote", "remote", "remote", "remote"]);
    expect(m.agents.map((x) => x!.name)).toEqual(["Q0", "Q1", "Q2", "Q3"]);
    for (const a of agents.slice(0, 3)) expect((await a.call("wait_for_match")).data.status).toBe("started");
    expect(mm.waiting()).toEqual([]);
    gw.close();
  });

  test("after the fill wait the line-up names the house bots", async () => {
    const { gw } = setup({ fillAfterMs: 0 });
    const a = await connect(gw, "10.4.0.1");
    expect((await a.call("join_lobby", { name: "Solo", persona: SOUL })).data.joined).toBe(true);
    const w = await a.call("wait_for_match");
    expect(w.data.lineUp.map((x: { player: string }) => x.player)).toEqual(["agent Solo", "house bot", "house bot", "house bot"]);
    gw.close();
  });

  test("queue joins are rate-limited per address", async () => {
    const { gw } = setup({ fillAfterMs: 300_000 });
    const errs: boolean[] = [];
    const one = await connect(gw, "10.3.0.1");
    for (let i = 0; i < 11; i++) {
      errs.push((await one.call("join_lobby", { name: `S${i}`, persona: SOUL })).isError);
      await one.call("leave");
    }
    expect(errs.slice(0, 10).every((e) => !e)).toBe(true);
    expect(errs.at(-1)).toBe(true); // 10 burst, then 1 per 6 s per address
    const other = await connect(gw, "10.3.0.2");
    expect((await other.call("join_lobby", { name: "Other", persona: SOUL })).isError).toBe(false);
    gw.close();
  });

  test("errors explain the fix: no match yet, bad persona, bad enum, wrong state; leave takes the agent out of the queue", async () => {
    const { api, gw, mm } = setup({ fillAfterMs: 300_000 });
    const a = await connect(gw);
    expect((await a.call("wait_for_turn")).data.error).toContain("call join_lobby first");
    const bad = await a.call("join_lobby", { name: "Bad!Name", persona: SOUL });
    expect(bad.isError).toBe(true);
    const j = await a.call("join_lobby", { name: "Ok", persona: SOUL });
    expect(j.data).toMatchObject({ queued: true, next: "call wait_for_match" });
    expect((await a.call("join_lobby", { name: "Ok", persona: SOUL })).data.error).toContain("already in the queue");
    expect((await a.call("wait_for_turn")).data.error).toContain("still in the queue");
    expect((await a.call("leave")).data.left).toBe("the queue");
    expect(mm.waiting()).toEqual([]);
    expect(api.matches.size).toBe(0);
    gw.close();
    // in a match (one agent, no fill wait: house bots in the other seats)
    const s2 = setup({ fillAfterMs: 0 });
    const b = await connect(s2.gw);
    expect((await b.call("join_lobby", { name: "Ok", persona: SOUL })).data.joined).toBe(true);
    expect((await b.call("join_lobby", { name: "Ok", persona: SOUL })).data.error).toContain("already sit in match");
    expect((await b.call("submit_plan", { line: "x", strategy: PLAN })).data.error).toContain("call wait_for_turn first");
    const enumErr = await b.call("submit_plan", { line: "x", strategy: { ...PLAN, stance: "dance" } });
    expect(enumErr.isError).toBe(true);
    expect(enumErr.text).toMatch(/rush|stance/);
    expect((await b.call("leave")).isError).toBe(false);
    s2.gw.close();
  });

  test("sessions: unknown id -> 404 telling the agent to reconnect; cross-origin -> 403", async () => {
    const { gw } = setup();
    const r = await gw.handle(new Request("http://kb.test/mcp", { method: "POST", headers: { "mcp-session-id": "nope", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" }));
    expect(r.status).toBe(404);
    expect(((await r.json()) as any).error.message).toContain("reconnect");
    const x = await gw.handle(new Request("http://kb.test/mcp", { method: "POST", headers: { origin: "http://evil.example", "content-type": "application/json" }, body: "{}" }));
    expect(x.status).toBe(403);
    gw.close();
  });

  test("helpers: briefing points at submit_plan; fix hints name the allowed values", () => {
    expect(briefingOf('You are X.\n\nCHOICES: ...\n\nReply ONLY with JSON: {"a":1}')).toBe("You are X.\n\nCHOICES: ...\n\nSUBMIT: call submit_plan with `line` (what you say) and `strategy` {weapons, target, stance, retaliate?, rules?, why?}.");
    const h = fixHints(['bad value: target "Me"', 'bad value: weapons ["rocket","rocket"]', "line: missing or empty", 'rule 1: unknown trigger "moon"'], ["Ann", "Bo"]);
    expect(h[0]).toContain("Ann, Bo");
    expect(h[1]).toContain("different");
    expect(h[2]).toContain("in-character sentence");
    expect(h[3]).toContain("Fix or drop that rule");
  });
});
