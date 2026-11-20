/**
 * #27 acceptance: kill the match server (SIGKILL) in the middle of a match,
 * start it again on the same database, and the match continues with the same
 * seat tokens and finishes with the same hashes as an uninterrupted run.
 */
import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initPhysics, replayMatch } from "../src/sim";

setDefaultTimeout(180_000);
beforeAll(async () => {
  await initPhysics();
});

const SOUL = readFileSync("souls/rat.md", "utf8");
const PLAN = { weapons: ["rocket", "bat"], target: "weakest", stance: "rush", retaliate: "attacker", rules: [{ when: "my_health_below", value: 30, do: "seek", item: "health", label: "patch up" }], why: "rush the weak one", line: "Coming through!" };
const SEED = 4711;

interface Server {
  proc: ReturnType<typeof Bun.spawn>;
  base: string;
  out: string[];
  match: string;
}

/** Start the CLI server and wait until it prints its port and its match. */
async function startServer(dir: string): Promise<Server> {
  const proc = Bun.spawn(
    ["bun", "scripts/match-server.ts", "--port", "0", "--out", dir, "--seats", "remote,remote,house,house", "--seed", String(SEED), "--deadline", "2", "--fill-after", "60"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out: string[] = [];
  const reader = proc.stdout.getReader();
  let buf = "";
  let base = "";
  let match = "";
  while (!base || !match) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`server exited: ${buf}${await new Response(proc.stderr).text()}`);
    buf += new TextDecoder().decode(value);
    base ||= /(http:\/\/localhost:\d+)\/api/.exec(buf)?.[1] ?? "";
    match ||= /(?:open match(?: \(restored\))?|resumed match): (m_[0-9a-f]+)/.exec(buf)?.[1] ?? "";
  }
  out.push(buf);
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      out.push(new TextDecoder().decode(value));
    }
  })();
  return { proc, base, out, match };
}

/** One agent: plays every turn with PLAN (or stays silent), surviving the server going away. */
function agent(server: () => Server, token: string, silent: boolean) {
  return (async () => {
    for (;;) {
      const s = server();
      try {
        const r = await fetch(`${s.base}/api/matches/${s.match}/turn?wait=5`, { headers: { authorization: `Bearer ${token}` } });
        const t = (await r.json()) as any;
        if (r.status !== 200) throw new Error(`turn ${r.status}: ${JSON.stringify(t)}`);
        if (t.status === "over") return t;
        if (t.status !== "turn") continue;
        // "slow" (was silent): answers just before the deadline, so round 2 is still being asked when the server
        // is killed; a seat that missed a deadline would go on autopilot (#22) and be decided at once
        if (silent) await Bun.sleep(Math.max(0, t.msLeft - 600));
        await fetch(`${s.base}/api/matches/${s.match}/plan`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ round: t.round, ...PLAN }) });
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("turn ")) throw e;
        await Bun.sleep(100); // the server is down: try again
      }
    }
  })();
}

async function joinSeat(s: Server, name: string): Promise<string> {
  const r = await fetch(`${s.base}/api/matches/${s.match}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, persona: SOUL }) });
  expect(r.status).toBe(201);
  return ((await r.json()) as any).token;
}

async function info(s: Server) {
  return (await (await fetch(`${s.base}/api/matches/${s.match}`)).json()) as any;
}

async function play(dir: string, killAfterRound: number | null) {
  let server = await startServer(dir);
  const first = server;
  const planner = await joinSeat(server, "Planner");
  const silent = await joinSeat(server, "Silent");
  const done = Promise.all([agent(() => server, planner, false), agent(() => server, silent, true)]);
  let killedAt: any = null;
  if (killAfterRound !== null) {
    // wait until that round is played and the next one is being asked (the silent seat holds it for 2 s)
    for (;;) {
      const i = await info(server);
      if (i.wins && i.wins.reduce((a: number, b: number) => a + b, 0) >= killAfterRound) {
        killedAt = i;
        break;
      }
      await Bun.sleep(50);
    }
    await Bun.sleep(400);
    server.proc.kill("SIGKILL");
    await server.proc.exited;
    server = await startServer(dir);
    expect(server.match).toBe(first.match); // resumed, no new match
  }
  const [result] = await Promise.all([done]);
  const final = await info(server);
  const rec = JSON.parse(readFileSync(join(dir, final.record.replace("/records/", "")), "utf8"));
  server.proc.kill();
  return { result: result[0], final, rec, killedAt, log: [...first.out, ...(server !== first ? server.out : [])].join("") };
}

describe("restart mid-match (#27)", () => {
  test("SIGKILL after round 1, restart on the same database: same tokens, same hashes as an uninterrupted run", async () => {
    const ref = await play(mkdtempSync(join(tmpdir(), "kb-ref-")), null);
    const dir = mkdtempSync(join(tmpdir(), "kb-kill-"));
    const cut = await play(dir, 1);
    const hashes = (rec: any) => rec.rounds.map((r: any) => r.fight.finalHash);
    expect(cut.killedAt.wins.reduce((a: number, b: number) => a + b, 0)).toBe(1);
    expect(cut.log).toContain("resumed after 1 stored round");
    expect(hashes(cut.rec)).toEqual(hashes(ref.rec));
    expect(cut.rec.rounds.map((r: any) => r.strategies)).toEqual(ref.rec.rounds.map((r: any) => r.strategies));
    expect(cut.final.winner).toBe(ref.final.winner);
    expect(cut.result.status).toBe("over");
    // the record of the resumed match replays with no network
    expect(hashes(replayMatch(cut.rec).record)).toEqual(hashes(cut.rec));
    // and the record index in the database has it
    const { Database } = await import("bun:sqlite");
    const db = new Database(join(dir, "match-server.db"), { readonly: true });
    const row = db.query("SELECT hashes FROM records WHERE match_id = ?").get(cut.final.id) as { hashes: string };
    expect(JSON.parse(row.hashes)).toEqual(hashes(ref.rec));
    db.close();
  });
});
