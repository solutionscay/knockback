import { describe, expect, test } from "bun:test";
import { roundPlayback } from "../src/flow/pacing";
import {
  ago,
  clock,
  feedEntries,
  firstPrompt,
  isGalleryMatch,
  joinSnippet,
  joinStatus,
  liveMatch,
  mcpUrlFrom,
  modelOf,
  posAtTime,
  queue,
  queueInfo,
  scoreline,
  timeline,
  timeOfPos,
  upNext,
  visibleFeed,
  type MatchInfo,
  type ReplayInfo,
  type ReportRound,
} from "../src/site/data";
import { route, SITE_PATHS } from "../src/site/route";
import site from "../src/site/index.html";

const seat = (i: number, agent: string | null, kind = "remote") => ({ seat: i, kind, agent, fighter: null, label: null });
const match = (id: string, status: MatchInfo["status"], createdAt: string, agents: (string | null)[], startsInSec?: number): MatchInfo => ({
  id,
  status,
  seed: 1,
  createdAt,
  ...(startsInSec !== undefined ? { startsInSec } : {}),
  seats: agents.map((a, i) => seat(i, a, i === 3 ? "house" : "remote")),
  round: 0,
  wins: null,
  winner: null,
  record: null,
});

describe("site routes", () => {
  test("paths map to pages; bad ids and names are unknown", () => {
    expect(route("/lobby")).toEqual({ page: "lobby", nav: "lobby" });
    expect(route("/lobby/")).toEqual({ page: "lobby", nav: "lobby" });
    expect(route("/watch/m_0123abcd")).toEqual({ page: "watch", nav: "live", id: "m_0123abcd" });
    expect(route("/replay/m_0123abcd")).toEqual({ page: "replay", nav: "replays", id: "m_0123abcd" });
    expect(route("/agent/Brixel%20Two")).toEqual({ page: "agent", nav: "", name: "Brixel Two" });
    expect(route("/replays")).toEqual({ page: "replays", nav: "replays" });
    expect(route("/watch/../etc").page).toBe("unknown");
    expect(route("/agent/%3Cscript%3E").page).toBe("unknown");
    expect(route("/agent/%E0%A4%A").page).toBe("unknown");
  });

  test("Bun serves the site bundle at every site path (as scripts/match-server.ts does)", async () => {
    const server = Bun.serve({ port: 0, routes: Object.fromEntries(SITE_PATHS.map((p) => [p, site])), fetch: () => new Response("nope", { status: 404 }) });
    try {
      for (const p of ["/lobby", "/watch/m_0123abcd", "/replay/m_0123abcd", "/agent/Brixel", "/replays"]) {
        const res = await fetch(`http://localhost:${server.port}${p}`);
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toContain('<main id="page">');
        expect(body).toContain("KNOCKBACK");
      }
      expect((await fetch(`http://localhost:${server.port}/nothing`)).status).toBe(404);
    } finally {
      server.stop(true);
    }
  }, 60_000);
});

describe("lobby data", () => {
  const ms = [
    match("m_00000001", "over", "2026-11-20T10:00:00Z", ["A", "B", null, null]),
    match("m_00000002", "running", "2026-11-20T11:00:00Z", ["C", "D", "E", null]),
    match("m_00000003", "running", "2026-11-20T11:05:00Z", ["F", null, null, null]),
    match("m_00000004", "open", "2026-11-20T11:10:00Z", ["Brixel", "Kettle", null, null], 40),
    match("m_00000005", "open", "2026-11-20T11:11:00Z", ["Tinbit", null, null, null], 110),
  ];
  test("live match is the newest running; up next starts first; queue by start", () => {
    expect(liveMatch(ms)?.id).toBe("m_00000003");
    expect(upNext(ms)?.id).toBe("m_00000004");
    expect(queue(ms).map((q) => [q.agent, q.startsInSec])).toEqual([
      ["Brixel", 40],
      ["Kettle", 40],
      ["Tinbit", 110],
    ]);
    expect(liveMatch([])).toBeNull();
    expect(upNext([])).toBeNull();
  });
  test("the matchmaker's queue (#22): waiting agents first, the oldest four with the fill countdown; joinStatus finds them", () => {
    const q = queueInfo({ waiting: [1, 2, 3, 4, 5].map((i) => ({ position: i, agent: `W${i}`, waitingSec: 60 - i })), needed: 0, fillsInSec: 12, blocked: false, fillAfterSec: 60 })!;
    expect(q.waiting).toHaveLength(5);
    const e = queue(ms, q);
    expect(e.slice(0, 5).map((x) => [x.agent, x.match, x.startsInSec])).toEqual([
      ["W1", null, 12],
      ["W2", null, 12],
      ["W3", null, 12],
      ["W4", null, 12],
      ["W5", null, null],
    ]);
    expect(e.slice(5).map((x) => x.agent)).toEqual(["Brixel", "Kettle", "Tinbit"]); // hand-made open matches after
    expect(joinStatus(ms, "w2", "", q)).toEqual({ state: "queued", startsInSec: 12, position: 2 });
    expect(joinStatus(ms, "w2", "", { ...q, blocked: true })).toEqual({ state: "queued", startsInSec: null, position: 2 });
    expect(queueInfo(null)).toBeNull();
    expect(queueInfo({ waiting: "no" })).toBeNull();
    expect(queueInfo({ waiting: [{ agent: "<b>x</b>".repeat(10) }] })!.waiting[0]!.agent).toHaveLength(24);
  });

  test("joinStatus follows the agent from waiting to the queue to the fight (#42)", () => {
    expect(joinStatus(ms, "")).toEqual({ state: "waiting" });
    expect(joinStatus(ms, "nobody")).toEqual({ state: "waiting" });
    expect(joinStatus(ms, "tinbit")).toEqual({ state: "queued", match: "m_00000005", startsInSec: 110, position: 3 });
    expect(joinStatus(ms, "E")).toEqual({ state: "fighting", match: "m_00000002" });
    expect(joinStatus(ms, "A")).toEqual({ state: "done", match: "m_00000001" });
    expect(joinStatus(ms, "A", "2026-11-20T10:30:00Z")).toEqual({ state: "waiting" }); // an older finished match with that name doesn't count
    expect(joinStatus(ms, "Brixel", "2026-11-20T12:00:00Z")).toMatchObject({ state: "queued", match: "m_00000004" }); // an open match made before the panel opened does
  });
  test("formatting", () => {
    expect(clock(75)).toBe("1:15");
    expect(clock(-3)).toBe("0:00");
    expect(ago("2026-11-20T11:00:00Z", Date.parse("2026-11-20T11:05:00Z"))).toBe("5 min ago");
    expect(ago("2026-11-20T11:00:00Z", Date.parse("2026-11-20T11:00:20Z"))).toBe("just now");
    expect(scoreline([2, 1, 0, 0])).toBe("2–1");
    expect(scoreline([0, 2, 0, 0])).toBe("2–0");
    expect(scoreline([1, 0, 1, 1])).toBe("1–1–1");
  });
  test("modelOf is the model spotlight's", () => {
    expect(modelOf("claude/haiku").name).toBe("CLAUDE HAIKU");
    expect(modelOf("grok/grok-4.6")).toMatchObject({ name: "GROK 4.6", provider: "xai" });
    expect(modelOf("house")).toMatchObject({ name: "HOUSE BOT", provider: "house" });
    expect(modelOf("remote/Brixel")).toMatchObject({ name: "MODEL NOT REPORTED", agent: "Brixel" });
    expect(modelOf("remote/Brixel@claude-opus-5-5")).toMatchObject({ name: "CLAUDE OPUS 5.5", provider: "anthropic", selfReported: true, agent: "Brixel" });
  });
  test("the gallery shows agent and house-bot matches only; server-run models and test providers are training data", () => {
    expect(isGalleryMatch(["remote/Brixel@claude-opus-5-5", "remote/Zap", "house", "house bot"])).toBe(true);
    expect(isGalleryMatch(["house", "house", "house", "house"])).toBe(true);
    expect(isGalleryMatch(["remote/Brixel", "claude/haiku", "house", "house"])).toBe(false);
    expect(isGalleryMatch(["codex/gpt-6-luna", "grok", "house", "house"])).toBe(false);
    expect(isGalleryMatch(["remote/A", "stub", "house", "house"])).toBe(false);
  });
});

describe("JOIN panel (#42)", () => {
  test("the prompt names the agent and the tools; fields fill it", () => {
    const p = firstPrompt({ name: "Brixel", persona: "A loud brawler who loves the bat.", owner: "jo" });
    expect(p).toContain("Join the Knockback lobby as Brixel and win.");
    expect(p).toContain('join_lobby with name "Brixel" and model set to the model you run');
    expect(p).toContain("wait_for_match");
    expect(p).toContain("submit_plan");
    expect(p).toContain("A loud brawler who loves the bat. Owner: jo.");
    expect(firstPrompt({ name: "", persona: "", owner: "" })).toContain("Write yourself a short fighting persona");
  });
  test("each tab has the real server URL; the shell command quotes the prompt safely", () => {
    const f = { name: "Brix", persona: "It's loud, it's 'quoted'.", owner: "" };
    for (const tab of ["claude", "codex", "grok", "json"] as const) {
      const s = joinSnippet(tab, "https://kb.example/mcp", f);
      expect(s.setup).toContain("https://kb.example/mcp");
      expect(s.prompt).toContain("Brix");
    }
    expect(joinSnippet("claude", "https://kb.example/mcp", f).setup).toBe("claude mcp add --transport http knockback 'https://kb.example/mcp'");
    const endpoint = mcpUrlFrom({ mcp: "https://kb.example/region&zone/mcp" }, "https://fallback.example");
    expect(joinSnippet("grok", endpoint, f).setup).toBe(`grok mcp add knockback '${endpoint}'`);
    expect(joinSnippet("codex", endpoint, f).run).toContain(`-c 'mcp_servers.knockback.url="${endpoint}"'`);
    expect(JSON.parse(joinSnippet("json", "https://kb.example/mcp", f).setup)).toEqual({ mcpServers: { knockback: { type: "http", url: "https://kb.example/mcp" } } });
    const run = joinSnippet("claude", "https://kb.example/mcp", f).run;
    expect(run).toContain(`'\\''quoted'\\''`);
  });
  test("mcpUrlFrom: GET /api/join's URL when it gives one, else this origin", () => {
    expect(mcpUrlFrom(null, "http://lan:5176")).toBe("http://lan:5176/mcp");
    expect(mcpUrlFrom({ mcp: "https://kb.example/mcp" }, "x")).toBe("https://kb.example/mcp");
    expect(mcpUrlFrom({ publicUrl: "https://kb.example/" }, "x")).toBe("https://kb.example/mcp");
    expect(mcpUrlFrom({ url: "javascript:alert(1)" }, "http://o")).toBe("http://o/mcp");
  });
});

describe("fight feed (/watch)", () => {
  const msgs = [
    { type: "match", seed: 1 },
    { type: "decisions", round: 1, decisions: [0, 1, 2, 3].map((i) => ({ line: `hi ${i}`, strategy: { stance: "rush", target: "nearest", weapons: ["bat"] } })) },
    { type: "checkin", round: 1, tick: 600, seats: [0] },
    { type: "checkin", round: 1, tick: 600, seats: [2] },
    { type: "planUpdate", round: 1, update: { tick: 660, fighter: 2, strategy: { stance: "cover", target: "weakest", weapons: ["rocket"] }, line: "hiding now" } },
    { type: "control", seat: 1, mode: "autopilot", round: 1, phase: "checkin", tick: 700, reason: "connection lost", line: "Zap's brain went to get milk." },
    { type: "round", round: 1, winner: 0, kos: [{ victim: 1, by: 0, cause: "ringout" }] },
    { type: "control", seat: 1, mode: "agent", round: 2, phase: "plan", tick: null, reason: "reconnected", line: "back" },
    { type: "done", winner: 0, wins: [2, 0, 0, 0], record: "/records/x.json" },
  ];
  const entries = msgs.flatMap(feedEntries);
  test("messages become entries with the moment viewers reach them", () => {
    expect(entries.map((e) => e.kind)).toEqual(["line", "line", "line", "line", "checkin", "checkin", "plan", "control", "round", "control", "done"]);
    const line = entries[0]!;
    expect(line.kind === "line" && line.plan).toBe("rush · nearest · bat");
    const ap = entries.find((e) => e.kind === "control")!;
    expect(ap.when).toEqual({ round: 1, phase: "fight", tick: 700 });
    expect(entries.at(-2)!.when).toEqual({ round: 2, phase: "plan", tick: 0 });
    expect(feedEntries({ type: "planUpdate", round: 1, update: { tick: 1, fighter: 9 } })).toEqual([]);
    expect(feedEntries(null)).toEqual([]);
  });
  test("the feed never runs ahead of the fight", () => {
    expect(visibleFeed(entries, null)).toEqual([]);
    expect(visibleFeed(entries, { round: 1, phase: "plan", tick: 0 }).map((e) => e.kind)).toEqual(["line", "line", "line", "line"]);
    expect(visibleFeed(entries, { round: 1, phase: "fight", tick: 650 }).map((e) => e.kind)).toEqual(["checkin", "line", "line", "line", "line"]); // one check-in line for both seats
    expect(visibleFeed(entries, { round: 1, phase: "fight", tick: 9999 }).some((e) => e.kind === "round")).toBe(false); // the result waits for the round end
    expect(visibleFeed(entries, { round: 1, phase: "end", tick: 0 })[0]!.kind).toBe("round");
    expect(visibleFeed(entries, { round: 2, phase: "fight", tick: 10 }).some((e) => e.kind === "done")).toBe(false);
    expect(visibleFeed(entries, { round: 2, phase: "end", tick: 10, done: true })[0]!.kind).toBe("done");
  });
});

describe("replay timeline", () => {
  const rounds: ReportRound[] = [
    { round: 1, plans: ["a", "b", "c", "d"].map((l, i) => ({ fighter: `F${i}`, line: `line ${l}`, strategy: {} })), result: { winner: "F0", reason: "last-standing", seconds: 30, ticks: 1800, knockouts: [{ victim: "F1", by: "F0", weapon: "bat", cause: "ringout", tick: 600 }, { victim: "F2", by: null, weapon: "fist", cause: "hp", tick: 1200 }, { victim: "F3", by: "F0", weapon: "bat", cause: "hp", tick: 1800 }] } },
    { round: 2, plans: ["e", "f", "g", "h"].map((l, i) => ({ fighter: `F${i}`, line: `line ${l}`, strategy: {} })), result: { winner: "F0", reason: "time-out", seconds: 60, ticks: 3600, knockouts: [] } },
    { round: 3, plans: [], result: null },
  ];
  const names = ["F0", "F1", "F2", "F3"];
  const tl = timeline(rounds, names);
  test("segments follow the viewer's beat timing; pins sit on their fight ticks", () => {
    expect(tl.segments.map((s) => s.round)).toEqual([1, 2]);
    const p1 = roundPlayback({ round: 1, lines: rounds[0]!.plans.map((p) => p.line), fightTicks: 1800, kos: 3, endsWithKo: true });
    expect(tl.segments[0]!.end).toBeCloseTo(p1.total);
    expect(tl.segments[1]!.start).toBeCloseTo(p1.total);
    expect(tl.pins.map((p) => [p.kind, p.seat])).toEqual([
      ["ringout", 1],
      ["ko", 2],
      ["ko", 3],
      ["win", 0],
    ]);
    expect(tl.pins[0]!.t).toBeGreaterThan(p1.preFight);
    expect(tl.pins[1]!.t).toBeGreaterThan(tl.pins[0]!.t);
    expect(tl.chapters.map((c) => c.label)).toEqual(["Trash talk", "F1 ring out", "F2 K.O.", "F3 K.O.", "Round 2"]);
    expect(tl.total).toBeGreaterThan(tl.segments[1]!.end);
  });
  test("time and playback position map both ways", () => {
    const s = tl.segments[0]!;
    expect(posAtTime(tl, 0)).toEqual({ round: 1, phase: "plan", tick: 0 });
    const mid = posAtTime(tl, s.start + s.preFight + s.fight / 2);
    expect(mid.phase).toBe("fight");
    expect(mid.tick).toBeGreaterThan(700);
    expect(mid.tick).toBeLessThan(1100);
    expect(posAtTime(tl, s.end - 0.1)).toEqual({ round: 1, phase: "end", tick: 1800 });
    expect(posAtTime(tl, 1e9).round).toBe(2);
    expect(timeOfPos(tl, { round: 2, phase: "plan", tick: 0 })).toBeCloseTo(tl.segments[1]!.start);
    expect(timeOfPos(tl, { round: 1, phase: "fight", tick: 600 })).toBeCloseTo(tl.pins[0]!.t, 3);
    expect(timeOfPos(tl, { round: 1, phase: "end", tick: 0, done: true })).toBe(tl.total);
    expect(timeOfPos(tl, null)).toBe(0);
    expect(timeline([], names)).toEqual({ segments: [], pins: [], chapters: [], total: 0 });
  });
});
