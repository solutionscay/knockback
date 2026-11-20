/**
 * The waiting queue behind the MCP join_lobby / wait_for_match tools (#21):
 * an agent that asks to play is seated in the oldest lobby match that still
 * has a free remote seat; when there is none, a new lobby match is created.
 * A lobby match starts when its remote seats are full, or after `fillAfterMs`
 * with house bots in the empty seats (the match server's normal fill timer).
 * Full pairing (ratings, a browser lobby) is #22.
 *
 * Seating goes through the HTTP join endpoint in-process, so it gets the same
 * validation, rate limits and seat tokens as any HTTP agent.
 */
import { HttpError } from "./limits";
import type { MatchServer, ServerMatch } from "./match-server";

export interface LobbyOptions {
  /** seat kinds of a new lobby match (default: 3 remote seats + 1 house bot) */
  seats?: string[];
  /** turn deadline of lobby matches: agents that think with a full model need more than a CLI call (default 75 s) */
  deadlineMs?: number;
  /** a lobby match starts after this long with house bots in the empty seats (default 120 s) */
  fillAfterMs?: number;
}

export interface Seated {
  match: ServerMatch;
  seat: number;
  token: string;
  created: boolean;
}

export class LobbyQueue {
  readonly seats: string[];
  readonly deadlineMs: number;
  readonly fillAfterMs: number;
  /** lobby matches, oldest first */
  private ids: string[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    readonly api: MatchServer,
    opts: LobbyOptions = {},
  ) {
    this.seats = opts.seats ?? ["remote", "remote", "remote", "house"];
    this.deadlineMs = opts.deadlineMs ?? 75_000;
    this.fillAfterMs = opts.fillAfterMs ?? 120_000;
    if (!this.seats.includes("remote")) throw new Error("lobby seats need at least one remote seat");
  }

  /** Lobby matches that are still open, oldest first. */
  open(): ServerMatch[] {
    this.ids = this.ids.filter((id) => this.api.matches.get(id)?.status === "open");
    return this.ids.map((id) => this.api.matches.get(id)!);
  }

  /**
   * Seat an agent (body: name, persona, look?) in the next lobby match with a
   * free seat, or in a new one. Serialized, so two agents arriving together
   * share a match instead of opening two.
   */
  seat(body: Record<string, unknown>, ip: string): Promise<Seated> {
    const run = this.chain.then(() => this.seatNow(body, ip));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async seatNow(body: Record<string, unknown>, ip: string): Promise<Seated> {
    for (const m of this.open()) {
      if (!m.kinds.some((k, i) => k === "remote" && !m.agents[i])) continue;
      const r = await this.join(m, body, ip);
      if (r) return { ...r, match: m, created: false };
    }
    const m = await this.api.createMatch({ seats: this.seats, deadlineMs: this.deadlineMs, fillAfterMs: this.fillAfterMs });
    this.ids.push(m.id);
    this.api.log(`lobby: new match ${m.id} (${this.seats.join(",")}, deadline ${this.deadlineMs / 1000} s, fills after ${this.fillAfterMs / 1000} s)`);
    const r = await this.join(m, body, ip);
    if (!r) throw new HttpError(503, "could not take a seat in the new lobby match; try again");
    return { ...r, match: m, created: true };
  }

  /** POST /api/matches/:id/join in-process; null when the seat went away meanwhile (409). */
  private async join(m: ServerMatch, body: Record<string, unknown>, ip: string): Promise<{ seat: number; token: string } | null> {
    const res = (await this.api.handle(new Request(`http://lobby.internal/api/matches/${m.id}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), ip))!;
    const data = (await res.json()) as { seat?: number; token?: string; error?: string; problems?: string[] };
    if (res.status === 201) return { seat: data.seat!, token: data.token! };
    if (res.status === 409) return null;
    throw new HttpError(res.status, data.error ?? "join failed", data.problems);
  }
}
