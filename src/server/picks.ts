/**
 * Spectator picks (#35): humans pick who they think wins a match. Only for
 * engagement: picks are kept apart from the match (their own table), never
 * reach agents, prompts, tool results or the record, and touch no hash.
 *
 * A pick window runs from the match's creation until the lock, which happens
 * right before round 1's decisions are broadcast (and before round 1 is
 * simulated): from the decisions anyone could re-run the deterministic sim,
 * so the result must not be knowable while picks are open. The server enforces
 * the lock; the viewer only shows it.
 */
import { createHash, randomBytes } from "node:crypto";
import { HttpError } from "./limits";

/** with broadcast pacing, the window stays open at least this long after the match starts (all seats filled) */
export const PICK_MIN_WINDOW_MS = 30_000;
/** "picks" stream events at most this often */
export const PICK_THROTTLE_MS = 2_000;
/** different spectators one address may add to one match's tally */
export const PICKS_PER_ADDRESS = 8;

const COOKIE = "kb_spectator";

/** The spectator's anonymous id from the cookie, or a new one (then `setCookie` must be sent back). */
export function spectatorOf(req: Request): { id: string; hash: string; setCookie: string | null } {
  const m = /(?:^|;\s*)kb_spectator=([0-9a-f]{32})(?:;|$)/.exec(req.headers.get("cookie") ?? "");
  const id = m?.[1] ?? randomBytes(16).toString("hex");
  const secure = req.headers.get("x-forwarded-proto") === "https" || new URL(req.url).protocol === "https:";
  return {
    id,
    hash: createHash("sha256").update(id).digest("hex"),
    setCookie: m ? null : `${COOKIE}=${id}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${secure ? "; Secure" : ""}`,
  };
}

export interface Tally {
  counts: number[];
  total: number;
}

export class PickBook {
  private bySpectator = new Map<string, { seat: number; ip: string }>();
  lockedAt: number | null = null;

  /** Load stored picks (resume, or a finished match loaded for its report). */
  load(rows: { spectator: string; seat: number; ip: string }[]) {
    for (const r of rows) this.bySpectator.set(r.spectator, { seat: r.seat, ip: r.ip });
  }

  get locked(): boolean {
    return this.lockedAt !== null;
  }

  /**
   * One pick per spectator, changeable until the lock. A new spectator counts
   * against the address's cap. Returns whether the tally changed.
   */
  pick(spectator: string, seat: number, ip: string, perAddress = PICKS_PER_ADDRESS): boolean {
    if (this.lockedAt !== null) throw new HttpError(409, "picks are locked: round 1 has started");
    const had = this.bySpectator.get(spectator);
    if (!had) {
      let n = 0;
      for (const p of this.bySpectator.values()) if (p.ip === ip) n++;
      if (n >= perAddress) throw new HttpError(429, `at most ${perAddress} picks per address for one match`);
    }
    this.bySpectator.set(spectator, { seat, ip: had?.ip ?? ip });
    return had?.seat !== seat;
  }

  yours(spectator: string): number | null {
    return this.bySpectator.get(spectator)?.seat ?? null;
  }

  tally(): Tally {
    const counts = [0, 0, 0, 0];
    for (const p of this.bySpectator.values()) counts[p.seat]!++;
    return { counts, total: counts.reduce((a, b) => a + b, 0) };
  }

  /** The final split and the share who called the winner. */
  split(winner: number): Tally & { winner: number; calledIt: number } {
    const t = this.tally();
    return { ...t, winner, calledIt: t.total ? t.counts[winner]! / t.total : 0 };
  }
}

/**
 * A house bot's opening line from its soul, without touching the match's
 * random streams: an "intro" line that needs no context but the fighter's
 * own name, chosen by the seed. Falls back to the catchphrase.
 */
export function soulOpeningLine(lines: [string, unknown, string][], catchphrase: string | undefined, name: string, seed: number): string | null {
  const usable = lines.filter(([k, , t]) => k === "intro" && !/\{(?!me\}|ME\})[^}]*\}/.test(t));
  if (usable.length) return usable[seed % usable.length]![2].replaceAll("{me}", name).replaceAll("{ME}", name.toUpperCase());
  return catchphrase ?? null;
}
