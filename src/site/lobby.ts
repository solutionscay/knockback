/**
 * The Lobby (/lobby, #22, #64, #106): the Arena live is the page. The real viewer on the Arena's stream (every round,
 * back to back), one line over it (the round and its clock), the four fighters under it (seats.ts) and the next round in
 * one quiet line. /watch/:id is the same view on one round.
 * Data: the stream; GET /api/queue every 3 s (who plays each seat, the next round); /api/matches/:id for /watch/:id.
 */
import { arenaInfo, clock, feedEntries, nextLineup, reachedPos, type ArenaInfo, type FeedEntry, type MatchInfo } from "./data";
import { cleanIdentity } from "./bots";
import { $, every, getJson, html, mount, raw } from "./dom";
import { PLAN_SLOT, renderSeats } from "./seats";
import { Stage } from "./stage";
import type { Identity } from "../sim/identity";
import { TICK_RATE } from "../sim/constants";

interface Lineup {
  match: string;
  round: number;
  names: string[];
  labels: string[];
  identities: Identity[];
}

/** "Next · Vanta, Brixel + 2 house bots · 1 waiting" (pure). */
export function nextLine(a: ArenaInfo): string {
  const seats = nextLineup(a);
  const agents = seats.flatMap((s) => (s.agent ? [s.agent] : []));
  const house = seats.length - agents.length;
  const who = agents.length ? `${agents.join(", ")}${house ? ` + ${house} house bot${house === 1 ? "" : "s"}` : ""}` : "house bots";
  return `Next · ${who}${a.queue.length ? ` · ${a.queue.length} waiting` : ""}`;
}

export function lobbyPage(root: HTMLElement, id: string | null) {
  mount(
    root,
    html`<div class="wrap lobby">
      <div class="wbar"><span class="meta" id="l-meta">Connecting…</span><span class="sp"></span><a class="btn small ghost" id="l-replay" hidden>Replay</a></div>
      <div class="stage" id="l-stage"></div>
      <div class="seatrow" id="l-seats"></div>
      ${raw(PLAN_SLOT)}
      <div class="nextline" id="l-next"></div>
    </div>`,
  );

  let lineup: Lineup | null = null;
  let entries: FeedEntry[] = [];
  let arena: ArenaInfo | null = null;
  let info: MatchInfo | null = null;

  const stage = new Stage($("#l-stage")!, {
    live: (msg) => {
      const m = msg as { type?: string; matchId?: unknown; arenaRound?: unknown; names?: string[]; labels?: string[]; identities?: unknown[] };
      if (m.type === "match") {
        lineup = {
          match: typeof m.matchId === "string" ? m.matchId : (id ?? ""),
          round: typeof m.arenaRound === "number" ? m.arenaRound : 0,
          names: (m.names ?? []).map(String),
          labels: (m.labels ?? []).map(String),
          identities: [0, 1, 2, 3].map((i) => cleanIdentity(m.identities?.[i], i)),
        };
        entries = [];
      }
      entries.push(...feedEntries(msg));
      render();
    },
    pos: () => render(),
  });
  if (id) stage.live(id);
  else stage.arena();

  function render() {
    const auto = [false, false, false, false];
    let winner = -1;
    for (const e of entries) {
      if (!reachedPos(stage.pos, e.when)) continue;
      if (e.kind === "control") auto[e.seat] = e.mode === "autopilot";
      if (e.kind === "done") winner = e.winner;
    }
    const p = stage.pos;
    const round = lineup?.round || info?.arenaRound;
    const when = winner >= 0 || p?.done ? "Final" : p?.phase === "fight" ? clock(Math.floor(p.tick / TICK_RATE)) : p?.phase === "plan" ? "Plans" : p?.phase === "end" ? "Round over" : "";
    $("#l-meta")!.textContent = !lineup ? "Connecting…" : ["Live", round ? `Round ${round}` : "", when].filter(Boolean).join(" · ");
    const replay = $<HTMLAnchorElement>("#l-replay")!;
    replay.hidden = !(id && winner >= 0);
    if (id) replay.href = `/replay/${id}`;
    $("#l-next")!.textContent = !id && arena ? nextLine(arena) : "";
    if (!lineup) return mount($("#l-seats"), html``);
    // who plays each seat (agents link to their page)
    const playing = id ? info?.seats.map((s) => s.agent) : arena?.round?.match === lineup.match ? arena.round.playing.map((s) => s?.agent ?? null) : null;
    renderSeats(
      $("#l-seats")!,
      lineup.identities.map((x, i) => ({ name: lineup!.names[i] ?? x.name, id: x, label: lineup!.labels[i] ?? "house", autopilot: auto[i]!, agent: playing?.[i] ?? null })),
      winner,
    );
  }

  if (id)
    every(4000, async () => {
      const r = await getJson<MatchInfo>(`/api/matches/${encodeURIComponent(id)}`);
      if (r.ok) info = r.data;
      else if (r.status === 404) return mount($("#l-meta"), html`No round ${id}. <a href="/lobby">Watch the Arena</a>`);
      render();
    });
  else
    every(3000, async () => {
      const q = await getJson<unknown>("/api/queue");
      if (!q.ok) return void ($("#l-meta")!.textContent = "Server unreachable, retrying…");
      arena = arenaInfo(q.data);
      render();
    });
}
