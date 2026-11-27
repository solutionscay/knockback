/**
 * The Arena, for the operator (#167). Before a deploy stops the server, wait until no round runs, so that no round is
 * cut off and resumed on the new version (docs/deploy.md, Upgrade). Read-only: it only GETs /api/health.
 *
 *   bun run arena status   [--server URL]                              the round on now, the drain, idle or not
 *   bun run arena drainable [--server URL]                             exit 0 if the server has the drain (SIGUSR2), 1 if not
 *   bun run arena wait-idle [--server URL] [--timeout 150] [--interval 1]
 *
 * --server: default KB_SERVER, else http://localhost:5176. wait-idle exits 0 when the Arena is idle, 3 on the timeout
 * (a round still runs: stop anyway, or wait again), 4 when the server never answered, 2 on bad usage.
 *
 * drainable: a server from before #167 has no SIGUSR2 handler, and an unhandled SIGUSR2 ends Bun (the round would be
 * cut off). Send the drain only when this exits 0.
 *
 * The default timeout, 150 s: a bot-only round from its first frame takes about 120 s at broadcast pace (intro ~20 s,
 * countdown 3 s, the fight 90 s at most, the result 5 s). A round with agents seated can add their turn (deadline
 * 75 s) and slow check-ins: use --timeout 300 then. With a drain on (SIGUSR2) the next round is held, so idle stays
 * until the stop; without one, idle is the ~10 s win screen between rounds: stop at once.
 */
import { describeState, hasDrain, healthReader, WAIT_EXIT, waitIdle } from "../src/server/wait-idle";
import { parseFlags } from "./flags";

const argv = process.argv.slice(2);
const flags = parseFlags(argv);
const [cmd] = argv.filter((a, i) => !a.startsWith("--") && !(argv[i - 1]?.startsWith("--") && !argv[i - 1]!.includes("=")));
const server = (flags.server ?? process.env.KB_SERVER ?? "http://localhost:5176").replace(/\/+$/, "");
const num = (name: string, dflt: number) => {
  const v = flags[name] === undefined ? dflt : Number(flags[name]);
  if (!Number.isFinite(v) || v < 0) usage(`--${name} must be a number of seconds`);
  return v;
};
function usage(why?: string): never {
  if (why) console.error(why);
  console.error("usage: bun run arena status | drainable | wait-idle [--server URL] [--timeout 150] [--interval 1]");
  process.exit(WAIT_EXIT.usage);
}
const stamp = () => new Date().toISOString().slice(11, 19);

if (cmd === "status") {
  try {
    const s = await healthReader(server)();
    console.log(`${server}: ${describeState(s)}`);
  } catch (e) {
    console.error(`${server}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(WAIT_EXIT.unreachable);
  }
} else if (cmd === "drainable") {
  try {
    const yes = hasDrain(await (await fetch(`${server}/api/health`, { signal: AbortSignal.timeout(5000) })).json());
    console.log(yes ? `${server}: has the drain (SIGUSR2 holds the next round)` : `${server}: no drain (a server from before #167): do not send SIGUSR2, it would end the server`);
    process.exit(yes ? 0 : 1);
  } catch (e) {
    console.error(`${server}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(WAIT_EXIT.unreachable);
  }
} else if (cmd === "wait-idle") {
  const timeout = num("timeout", 150);
  console.log(`[${stamp()}] waiting up to ${timeout} s for the Arena at ${server} to be idle`);
  const r = await waitIdle({ read: healthReader(server), timeoutMs: timeout * 1000, intervalMs: num("interval", 1) * 1000, log: (s) => console.log(`[${stamp()}] ${s}`) });
  const secs = Math.round(r.waitedMs / 1000);
  if (r.ok) {
    console.log(`[${stamp()}] idle after ${secs} s: ${r.state.drain ? "the next round is held; stop the server now" : "between rounds (about 10 s until the next one); stop the server now"}`);
    process.exit(WAIT_EXIT.idle);
  }
  if (!r.state) {
    console.error(`[${stamp()}] timeout after ${secs} s: the server never answered (${r.error}). If it is down, nothing runs: deploy. Otherwise check the URL.`);
    process.exit(WAIT_EXIT.unreachable);
  }
  console.error(`[${stamp()}] timeout after ${secs} s: ${describeState(r.state)}${r.error ? ` (last read failed: ${r.error})` : ""}.`);
  console.error("The round still runs. Wait again (bun run arena wait-idle), or stop anyway: that round resumes on the new version and fails if the simulation changed.");
  process.exit(WAIT_EXIT.timeout);
} else usage();
