/**
 * A small HTTP client for the match server (#20): registers, joins a match,
 * long-polls for turns and sends plans. Also the reference for writing an agent.
 *
 *   bun scripts/remote-agent.ts --server http://localhost:5176 --name Rando --mode random
 *   bun scripts/remote-agent.ts --mode fixed  --soul souls/sniper.md
 *   bun scripts/remote-agent.ts --mode silent              # joins, never answers (the house bot plays)
 *   bun scripts/remote-agent.ts --mode cli --cmd "claude -p --model haiku --tools '' --no-session-persistence"
 *        (pipes the turn's prompt to the command on stdin and sends its reply as {"answer": ...})
 *
 * --match <id> joins that match; without it, the first open match.
 * --seed <n> makes the random plans repeatable.
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

async function call(method: string, path: string, body?: unknown, key?: string): Promise<{ status: number; data: any }> {
  const res = await fetch(server + path, {
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

// ------------------------------------------------------------ register, join, play
const reg = await call("POST", "/api/agents", { name, persona, ...(flags.color ? { look: { color: flags.color } } : {}) });
if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.data)}`);
const key: string = reg.data.key;
log(`registered ${reg.data.id}${reg.data.warnings?.length ? ` (soul warnings: ${reg.data.warnings.join("; ")})` : ""}`);

let matchId = flags.match;
for (let tries = 0; !matchId; tries++) {
  const list = await call("GET", "/api/matches");
  matchId = list.data.matches.find((m: any) => m.status === "open" && m.seats.some((s: any) => s.kind === "remote" && !s.agent))?.id;
  if (!matchId) {
    if (tries > 60) throw new Error("no open match");
    await Bun.sleep(1000);
  }
}
const join = await call("POST", `/api/matches/${matchId}/join`, flags.seat ? { seat: Number(flags.seat) } : {}, key);
if (join.status !== 200) throw new Error(`join failed: ${join.status} ${JSON.stringify(join.data)}`);
log(`joined match ${matchId}, seat ${join.data.seat}, mode ${mode}`);

for (;;) {
  const r = await call("GET", `/api/matches/${matchId}/turn?wait=25`, undefined, key);
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
  if (t.status !== "turn") continue;
  log(`round ${t.round}: I am ${t.context.you.name}; ${Math.round(t.msLeft / 1000)} s to plan`);
  if (mode === "silent") {
    // never answer: wait out the turn
    await Bun.sleep(t.msLeft + 200);
    continue;
  }
  const body = mode === "fixed" ? fixedPlan(t) : mode === "cli" ? { round: t.round, answer: (await cliAnswer(t.prompt, t.msLeft)).slice(0, 8000) } : randomPlan(t);
  const p = await call("POST", `/api/matches/${matchId}/plan`, body, key);
  if (p.status === 200) log(`plan accepted: ${p.data.plan.stance}, ${p.data.plan.weapons.join(">")} -> ${p.data.plan.target}: "${p.data.plan.line}"${p.data.warnings.length ? ` (warnings: ${p.data.warnings.join("; ")})` : ""}`);
  else log(`plan rejected: ${p.status} ${p.data?.error}${p.data?.problems ? `: ${p.data.problems.join("; ")}` : ""}`);
}
