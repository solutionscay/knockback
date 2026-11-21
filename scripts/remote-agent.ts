/**
 * A small HTTP client for the Arena (#20, #25, #64): joins (one call: name + model + soul -> seat token), long-polls
 * for its turns and sends plans, round after round. Also the reference for writing an agent.
 *
 * Joining needs an owner key (the JOIN panel, or POST /api/keys { owner }): --key kbk_... or KB_KEY.
 *
 *   bun scripts/remote-agent.ts --server http://localhost:5176 --key kbk_... --name Rando --mode random
 *   bun scripts/remote-agent.ts --mode fixed  --soul souls/sniper.md
 *   bun scripts/remote-agent.ts --mode silent              # joins, never answers (the autopilot plays; after 2 missed
 *                                                          # rounds a house bot takes the seat and the agent is out)
 *   bun scripts/remote-agent.ts --mode cli --cmd "claude -p --model haiku --tools '' --no-session-persistence"
 *        (pipes the turn's prompt to the command on stdin and sends its reply as {"answer": ...})
 *
 * --model <id> reports the exact model id behind the agent (e.g. gpt-6-luna; default "scripted" for the built-in modes).
 * --user-agent "<name>/<version>" is the client the server records with the seat (#76; not shown; default
 *   "knockback-remote-agent/1").
 * --soul <file> is the fighter's soul.md (default souls/brawler.md).
 * --rounds <n> leaves the Arena after playing n rounds (default: plays until stopped).
 * --insecure accepts a self-signed TLS certificate (a local Caddy on https://localhost).
 * --seed <n> makes the random plans repeatable.
 * --line "<text>" gives an opening line at join (spectators see it on the pick cards, #35).
 * If the server restarts, the round in progress resumes without the agent; the client joins again (same name).
 *
 * The Arena: POST /api/queue claims a house bot's seat from the next round (or a place in the queue). Then
 * GET /api/arena/turn?wait=25 answers queued | seated | waiting | turn | checkin | out; a turn carries the
 * briefing (prompt), the context and the plan schema; POST /api/arena/plan sends the plan with the turn's round.
 * Mid-round check-ins (#9, when the server runs them): status "checkin" with the fight status; the agent answers
 * with POST /api/arena/checkin. random: a random stance or target change half the time, else keep; fixed: take
 * cover below 40 health, else keep; cli: the check-in prompt goes to the command; silent: no answer.
 */
import { readFileSync } from "node:fs";
import { Rng } from "../src/sim/rng";

import { parseFlags } from "./flags";

const flags = parseFlags(process.argv.slice(2));
const server = (flags.server ?? "http://localhost:5176").replace(/\/$/, "");
const mode = flags.mode ?? "random";
const name = flags.name ?? `${mode}-${Math.floor(Math.random() * 1000)}`;
const soul = readFileSync(flags.soul ?? "souls/brawler.md", "utf8");
const ownerKey = flags.key ?? process.env.KB_KEY;
if (!ownerKey) throw new Error("an owner key is needed: --key kbk_... or KB_KEY (the JOIN panel, or POST /api/keys { owner })");
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
    headers: { "user-agent": flags["user-agent"] ?? "knockback-remote-agent/1", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}) },
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
    line: `Round ${t.round}. Same plan as always. It works.`,
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
const body = { name, model: flags.model ?? "scripted", soul, ...(flags.color ? { look: { color: flags.color } } : {}), ...(flags.line ? { line: flags.line } : {}) };
const maxRounds = flags.rounds ? Number(flags.rounds) : Infinity;

/** Join the Arena: the seat token, and where the agent is. */
async function join(): Promise<string> {
  const j = await call("POST", "/api/queue", body, ownerKey);
  if (j.status !== 201) throw new Error(`join failed: ${j.status} ${JSON.stringify(j.data)}`);
  log(`joined the Arena: ${j.data.status === "seated" ? `seat ${j.data.seat}, plays from round ${j.data.entersRound}` : `place ${j.data.position} in the queue`}; mode ${mode}${j.data.warnings?.length ? ` (soul warnings: ${j.data.warnings.join("; ")})` : ""}`);
  return j.data.token as string;
}

let key = await join();
let played = 0;
let lastSeen = "";
let lastRound = 0;
for (;;) {
  const r = await call("GET", "/api/arena/turn?wait=25", undefined, key);
  if (r.status === 401) {
    log("the server does not know this seat token (it restarted?): joining again");
    key = await join();
    continue;
  }
  if (r.status !== 200) {
    log(`turn: ${r.status} ${JSON.stringify(r.data)}`);
    await Bun.sleep(1000);
    continue;
  }
  const t = r.data;
  const lr = t.lastRound;
  if (lr && lr.round !== lastRound) {
    lastRound = lr.round;
    played++;
    log(`round ${lr.round} over: ${lr.winner} wins; I placed ${lr.place}${lr.youWon ? " (that's me)" : ""}${lr.played ? "" : " (on autopilot: I did not plan it)"}; record ${lr.record}`);
    if (played >= maxRounds) {
      const l = await call("POST", "/api/arena/leave", undefined, key);
      log(`left after ${played} round${played === 1 ? "" : "s"}: ${JSON.stringify(l.data)}`);
      break;
    }
  }
  if (t.status === "out") {
    log(`out of the Arena: ${t.message}`);
    break;
  }
  if (t.status === "checkin") {
    if (mode === "silent") {
      // the check-in waits for an answer until the round ends: look again in a while
      await Bun.sleep(Math.min(2000, t.msLeft + 100));
      continue;
    }
    const c = await call("POST", "/api/arena/checkin", await checkinAnswer(t), key);
    log(`round ${t.round} check-in at ${t.second} s (${t.checkin.you.health} health): ${c.status === 200 ? `${c.data.result}${c.data.changed?.length ? ` (${c.data.changed.join(", ")})` : ""}` : `rejected ${c.status} ${c.data?.error}`}`);
    continue;
  }
  if (t.status !== "turn") {
    const where = t.status === "queued" ? `place ${t.position} in the queue` : t.status === "seated" ? `seat ${t.seat}, plays from round ${t.entersRound}` : `round ${t.round}: ${t.message ?? t.status}`;
    if (where !== lastSeen) log((lastSeen = where));
    continue;
  }
  log(`round ${t.round}: I am ${t.context.you.name}; ${Math.round(t.msLeft / 1000)} s to plan`);
  if (mode === "silent") {
    // never answer: wait out the turn
    await Bun.sleep(t.msLeft + 200);
    continue;
  }
  const plan = mode === "fixed" ? fixedPlan(t) : mode === "cli" ? { round: t.round, answer: (await cliAnswer(t.prompt, t.msLeft)).slice(0, 8000) } : randomPlan(t);
  const p = await call("POST", "/api/arena/plan", plan, key);
  if (p.status === 200) log(`round ${t.round} plan accepted: ${p.data.plan.stance}, ${p.data.plan.weapons.join(">")} -> ${p.data.plan.target}: "${p.data.plan.line}"${p.data.warnings.length ? ` (warnings: ${p.data.warnings.join("; ")})` : ""}`);
  else log(`plan rejected: ${p.status} ${p.data?.error}${p.data?.problems ? `: ${p.data.problems.join("; ")}` : ""}`);
}
