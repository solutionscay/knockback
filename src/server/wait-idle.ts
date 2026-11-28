import type { MatchStatus } from "../api-types";
/**
 * Wait until the Arena is idle (#167): the step a deploy runs before it stops the server, so that no round is cut
 * off and resumed on a new version (a sim change makes that resumed round fail). The state comes from
 * GET /api/health (`arena`, Arena.state()); the clock and the reader are injected, so tests need no server and no time.
 *
 * Idle: no round is open or running. With a drain on (SIGUSR2), only once the loop holds the next round. Without a
 * drain the idle window is the win screen between two rounds (about 10 s at broadcast pace): stop at once.
 */

/** The `arena` part of GET /api/health. */
export interface ArenaState {
  round: number | null;
  status: MatchStatus | null;
  drain: { held: boolean; until: string } | null;
  idle: boolean;
}

export interface WaitIdleOptions {
  /** reads the state; throws when the server cannot be reached */
  read: () => Promise<ArenaState>;
  timeoutMs: number;
  /** pause between reads (default 1 s: the gap between rounds is about 10 s) */
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** one line per change of state */
  log?: (s: string) => void;
}

export type WaitIdleResult =
  | { ok: true; state: ArenaState; waitedMs: number }
  /** timeout: the last state read (null: the server never answered) and the last read error */
  | { ok: false; state: ArenaState | null; waitedMs: number; error: string | null };

/** Exit codes of `bun run arena wait-idle`. */
export const WAIT_EXIT = { idle: 0, usage: 2, timeout: 3, unreachable: 4 } as const;

export function describeState(s: ArenaState): string {
  const round = s.round === null ? "no round yet" : `round ${s.round} ${s.status}`;
  const drain = s.drain ? (s.drain.held ? "; drain on, next round held" : "; drain on, waiting for the round to end") : "";
  return `${round}${drain}${s.idle ? " (idle)" : ""}`;
}

export async function waitIdle(o: WaitIdleOptions): Promise<WaitIdleResult> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
  const interval = o.intervalMs ?? 1000;
  const log = o.log ?? (() => {});
  const start = now();
  let state: ArenaState | null = null;
  let error: string | null = null;
  let said = "";
  for (;;) {
    try {
      state = await o.read();
      error = null;
      const line = describeState(state);
      if (line !== said) log(line);
      said = line;
      if (state.idle) return { ok: true, state, waitedMs: now() - start };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== error) log(`cannot read the state: ${msg}`);
      error = msg;
      said = "";
    }
    const left = start + o.timeoutMs - now();
    if (left <= 0) return { ok: false, state, waitedMs: now() - start, error };
    await sleep(Math.min(interval, left));
  }
}

/** Reads `arena` from <server>/api/health (one request, `timeoutMs` at most). */
export function healthReader(server: string, timeoutMs = 5000): () => Promise<ArenaState> {
  const url = `${server.replace(/\/+$/, "")}/api/health`;
  return async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return stateOfHealth(await res.json());
  };
}

/** Does this /api/health body come from a server with the drain (#167: it carries `arena`)? */
export function hasDrain(body: unknown): boolean {
  const a = (body as { arena?: ArenaState } | null)?.arena;
  return !!a && typeof a.idle === "boolean";
}

/**
 * The Arena state in a /api/health body. A server from before #167 (the one a first deploy of this replaces) has no
 * `arena`: its state comes from `arenaRound` and `matches` (no drain there, so idle = no round open or running).
 */
export function stateOfHealth(body: unknown): ArenaState {
  const b = body as { arena?: ArenaState; arenaRound?: number | null; matches?: { open: number; running: number } };
  if (hasDrain(b)) return b.arena!;
  if (!b?.matches || typeof b.matches.running !== "number") throw new Error("the health answer has no Arena state");
  const status = b.matches.running ? "running" : b.matches.open ? "open" : b.arenaRound != null ? "over" : null;
  return { round: b.arenaRound ?? null, status, drain: null, idle: b.matches.running + b.matches.open === 0 };
}
