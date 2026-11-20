/**
 * A small HTTP client for the match server (#20, #25): joins a match (one
 * call: name + persona -> seat token), long-polls for turns and sends plans.
 * Also the reference for writing an agent.
 *
 *   bun scripts/remote-agent.ts --server http://localhost:5176 --name Rando --mode random
 *   bun scripts/remote-agent.ts --mode fixed  --soul souls/sniper.md
 *   bun scripts/remote-agent.ts --mode silent              # joins, never answers (the house bot plays)
 *   bun scripts/remote-agent.ts --mode cli --cmd "claude -p --model haiku --tools '' --no-session-persistence"
 *        (pipes the turn's prompt to the command on stdin and sends its reply as {"answer": ...})
 *
 * --match <id> joins that match; without it, the first open match.
 * --create remote,house,house,house creates a match first (seats over HTTP: remote or house) and joins it.
 * --insecure accepts a self-signed TLS certificate (a local Caddy on https://localhost).
 * --seed <n> makes the random plans repeatable.
 * --leave-after <round> leaves the match when that round's turn comes (the house bot takes over).
 * --no-token: don't send the seat token (works only against a server started with --open).
 * If the server restarts, the client keeps retrying with the same seat token and plays on.
 *
 * Mid-round check-ins (#9, when the server runs them): GET /turn returns status
 * "checkin" with the fight status; the agent answers with POST /checkin.
 * random: a random stance or target change half the time, else keep; fixed:
 * take cover below 40 health, else keep; cli: the check-in prompt goes to the
 * command; silent: no answer (the plan stays).
 */
import { readFileSync } from "node:fs";
import { Rng } from "../src/sim/rng";

const flags: Record<string, string> = {};
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
    flags[k] = v ?? (argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[++i]! : "true");
  }
}
const server = (flags.server ?? "http://localhost:5176").replace(/\/$/, "");
const mode = flags.mode ?? "random";
const name = flags.name ?? `${mode}-${Math.floor(Math.random() * 1000)}`;
const persona = readFileSync(flags.soul ?? "souls/brawler.md", "utf8");
const rng = new Rng(Number(flags.seed ?? Date.now()) >>> 0);
const log = (s: string) => console.log(`[${name}] ${s}`);

/** One request; while the server is down (a restart), retry every second for up to 2 minutes. */
async function call(method: string, path: string, body?: unknown, key?: string): Promise<{ status: number; data: any }> {
  for (let down = 0; ; down++) {
    try {
      return await request(method, path, body, key);
    } catch (e) {
      if (down >= 120) throw e;
      if (down === 0) log(`server unreachable (${e instanceof Error ? e.message : e}); retrying`);
      await Bun.sleep(1000);
    }
  }
}

async function request(method: string, path: string, body?: unknown, key?: string): Promise<{ status: number; data: any }> {
  const res = await fetch(server + path, {
    ...(flags.insecure === "true" ? { tls: { rejectUnauthorized: false } } : {}),
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

function randomPlan(t: any) {
  const weapons = Object.keys(t.schema.weapons.values);
  const pick = <T>(xs: readonly T[]) => xs[rng.int(0, xs.length - 1)]!;
  const ws = [...weapons].sort(() => rng.next() - 0.5).slice(0, rng.int(1, 3));
  const plan: Record<string, unknown> = {
    round: t.round,
    weapons: ws,
    target: pick(t.context.targets as string[]),
    stance: pick(t.schema.stance.values as string[]),
    retaliate: pick(t.schema.retaliate.values as string[]),
    why: `random plan ${t.round}`,
    line: pick(["Dice say: you.", "I rolled for this.", "Chaos is a plan too.", "Random, not harmless."]),
  };
  if (rng.next() < 0.5) plan.rules = [{ when: "my_health_below", value: 30, do: "seek", item: "health", label: "patch up" }];
  return plan;
}

function fixedPlan(t: any) {
  return {
    round: t.round,
    weapons: ["rocket", "grenade"],
    target: "leader",
    stance: "distance",
    retaliate: "turn",
    rules: [{ when: "hit_me", who: "enemy", do: "retaliate", retaliate: "attacker", label: "bite back" }],
    why: "keep range on whoever leads",
    line: t.round === 1 ? "Same plan every round. It works." : `Round ${t.round}. Still the same plan.`,
  };
}

/** A check-in answer by mode: only the fields to change, or keep. */
async function checkinAnswer(t: any): Promise<Record<string, unknown>> {
  const st = t.checkin;
  const base = { round: t.round, tick: t.tick };
  if (mode === "cli") return { ...base, answer: (await cliAnswer(t.prompt, t.msLeft)).slice(0, 8000) };
  if (mode === "fixed") return st.you.health < 40 && st.you.plan.stance !== "cover" ? { ...base, stance: "cover", line: "Time to hide.", why: "low health" } : { ...base, keep: true };
  if (rng.next() < 0.5) return { ...base, keep: true };
  const alive = st.rivals.filter((r: any) => !r.out);
  const weakest = alive.sort((a: any, b: any) => a.health - b.health)[0];
  return rng.next() < 0.5 && weakest && st.you.plan.target !== weakest.name
    ? { ...base, target: weakest.name, line: `${weakest.name}, you're wobbling.`, why: `${weakest.name} has ${weakest.health} health` }
    : { ...base, stance: st.you.plan.stance === "rush" ? "distance" : "rush", line: "Change of plan!", why: "random check-in" };
}

async function cliAnswer(prompt: string, msLeft: number): Promise<string> {
  const cmd = flags.cmd ?? "claude -p --model haiku --tools '' --no-session-persistence";
  const child = Bun.spawn(["sh", "-c", cmd], { stdin: new Blob([prompt]), stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => child.kill("SIGKILL"), Math.max(1000, msLeft - 500));
  try {
    const [text] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------ join, play
let matchId = flags.match;
if (!matchId && flags.create) {
  const c = await call("POST", "/api/matches", { seats: flags.create.split(","), ...(flags.deadline ? { deadlineSec: Number(flags.deadline) } : {}), fillAfterSec: 30 });
  if (c.status !== 201) throw new Error(`create failed: ${c.status} ${JSON.stringify(c.data)}`);
  matchId = c.data.id as string;
  log(`created match ${matchId} (seed ${c.data.seed}): ${flags.create}`);
}
for (let tries = 0; !matchId; tries++) {
  const list = await call("GET", "/api/matches");
  matchId = list.data.matches.find((m: any) => m.status === "open" && m.seats.some((s: any) => s.kind === "remote" && !s.agent))?.id;
  if (!matchId) {
    if (tries > 60) throw new Error("no open match");
    await Bun.sleep(1000);
  }
}
const join = await call("POST", `/api/matches/${matchId}/join`, { name, persona, ...(flags.color ? { look: { color: flags.color } } : {}), ...(flags.seat ? { seat: Number(flags.seat) } : {}) });
if (join.status !== 201) throw new Error(`join failed: ${join.status} ${JSON.stringify(join.data)}`);
const seat: number = join.data.seat;
// the seat token: sent on turn, plan and leave; in --open mode the seat number can stand in for it
const key: string | undefined = flags["no-token"] === "true" ? undefined : join.data.token;
const q = key ? "" : `seat=${seat}&`;
log(`joined match ${matchId}, seat ${seat}, mode ${mode}${key ? "" : " (no token: open mode)"}${join.data.warnings?.length ? ` (soul warnings: ${join.data.warnings.join("; ")})` : ""}`);
const leaveAfter = flags["leave-after"] ? Number(flags["leave-after"]) : Infinity;

for (;;) {
  const r = await call("GET", `/api/matches/${matchId}/turn?${q}wait=25`, undefined, key);
  if (r.status !== 200) {
    log(`turn: ${r.status} ${JSON.stringify(r.data)}`);
    await Bun.sleep(1000);
    continue;
  }
  const t = r.data;
  if (t.status === "over") {
    log(`match over: ${t.winner} wins ${t.wins?.join("-")}${t.youWon ? " (that's me)" : ""}; record ${t.record}`);
    break;
  }
  if (t.status === "left") {
    log(t.message);
    break;
  }
  if (t.status === "checkin") {
    if (mode === "silent") {
      // the check-in stays open (and GET /turn keeps returning it) until its deadline: wait it out
      await Bun.sleep(t.msLeft + 100);
      continue;
    }
    const c = await call("POST", `/api/matches/${matchId}/checkin?${q}`, await checkinAnswer(t), key);
    log(`check-in at ${t.second} s (${t.checkin.you.health} health): ${c.status === 200 ? `${c.data.result}${c.data.changed?.length ? ` (${c.data.changed.join(", ")})` : ""}` : `rejected ${c.status} ${c.data?.error}`}`);
    continue;
  }
  if (t.status !== "turn") continue;
  if (t.round >= leaveAfter) {
    const l = await call("POST", `/api/matches/${matchId}/leave?${q}`, undefined, key);
    log(`left: ${JSON.stringify(l.data)}`);
    break;
  }
  log(`round ${t.round}: I am ${t.context.you.name}; ${Math.round(t.msLeft / 1000)} s to plan`);
  if (mode === "silent") {
    // never answer: wait out the turn
    await Bun.sleep(t.msLeft + 200);
    continue;
  }
  const body = mode === "fixed" ? fixedPlan(t) : mode === "cli" ? { round: t.round, answer: (await cliAnswer(t.prompt, t.msLeft)).slice(0, 8000) } : randomPlan(t);
  const p = await call("POST", `/api/matches/${matchId}/plan?${q}`, body, key);
  if (p.status === 200) log(`plan accepted: ${p.data.plan.stance}, ${p.data.plan.weapons.join(">")} -> ${p.data.plan.target}: "${p.data.plan.line}"${p.data.warnings.length ? ` (warnings: ${p.data.warnings.join("; ")})` : ""}`);
  else log(`plan rejected: ${p.status} ${p.data?.error}${p.data?.problems ? `: ${p.data.problems.join("; ")}` : ""}`);
}
