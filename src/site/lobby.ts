/**
 * Lobby home (/lobby, #22, #64): the Arena live on stage (the real viewer on the Arena's stream: every round, back to
 * back) with its seat row (seats.ts: names, models, wins, picks). There is no waiting state: house bots fight when no
 * agent does. Beside it: the next round (the 4 seats, agents and house bots, and the queue) and the recent results.
 * Data: the Arena stream, GET /api/queue (every 3 s), /api/replays (every 20 s).
 */
import { cleanIdentity, colorVars } from "./bots";
import { ago, arenaInfo, cap, featuredFirst, feedEntries, galleryReplays, nextLineup, reachedPos, type ArenaInfo, type FeedEntry, type ReplayInfo } from "./data";
import { $, every, getJson, html, mount } from "./dom";
import { openJoin } from "./join";
import { Picks } from "./picks";
import { renderSeats, wirePicks } from "./seats";
import { Stage } from "./stage";
import type { Identity } from "../sim/identity";

interface LiveLineup {
  match: string;
  round: number;
  names: string[];
  labels: string[];
  identities: Identity[];
}

export function lobbyPage(root: HTMLElement) {
  mount(
    root,
    html`<div class="wrap home">
      <div class="main">
        <div class="wbar"><span class="meta" id="l-meta">Connecting…</span><span class="sp"></span><a class="btn small" id="l-watch" href="/watch">Watch</a></div>
        <div class="stage" id="l-stage"></div>
        <div class="seatrow" id="l-seats"></div>
      </div>
      <aside class="rail">
        <section class="card" id="n-card" hidden><h2>Next round <small id="n-sub"></small></h2><div id="n-body"></div></section>
        <section class="card"><h2>Recent results <a href="/replays">All</a></h2><div id="r-body" class="empty">Loading…</div></section>
      </aside>
    </div>`,
  );

  let lineup: LiveLineup | null = null;
  let entries: FeedEntry[] = [];
  let arena: ArenaInfo | null = null;
  let replays: ReplayInfo[] = [];
  const picks = new Picks(() => renderStage());
  wirePicks($("#l-seats")!, picks);

  // the Arena stream: each round starts with a `match` message that names its match and Arena round
  const stage = new Stage($("#l-stage")!, {
    live: (msg) => {
      const m = msg as { type?: string; matchId?: unknown; arenaRound?: unknown; names?: string[]; labels?: string[]; identities?: unknown[] };
      if (m.type === "match" && typeof m.matchId === "string") {
        lineup = { match: m.matchId, round: typeof m.arenaRound === "number" ? m.arenaRound : 0, names: (m.names ?? []).map(String), labels: (m.labels ?? []).map(String), identities: [0, 1, 2, 3].map((i) => cleanIdentity(m.identities?.[i], i)) };
        entries = [];
        void picks.load(lineup.match);
      }
      entries.push(...feedEntries(msg));
      renderStage();
    },
    pos: () => renderStage(),
  });
  stage.arena();

  function renderStage() {
    const wins = [0, 0, 0, 0];
    const auto = [false, false, false, false];
    let winner = -1;
    for (const e of entries) {
      if (!reachedPos(stage.pos, e.when)) continue;
      if (e.kind === "round" && e.winner >= 0) wins[e.winner]!++;
      if (e.kind === "control") auto[e.seat] = e.mode === "autopilot";
      if (e.kind === "done") winner = e.winner;
    }
    const pickLine = picks.status();
    const round = lineup?.round ? `Arena round ${lineup.round}` : "Arena";
    $("#l-meta")!.textContent = !lineup
      ? "Connecting to the Arena…"
      : winner >= 0
        ? [`${round} · final`, pickLine].filter(Boolean).join(" · ") // the viewer's win screen says who won, once
        : pickLine || `Live · ${round}`;
    if (!lineup) return mount($("#l-seats"), html``);
    // who plays each seat of the round on stage (agents link to their page)
    const playing = arena?.round?.match === lineup.match ? arena.round.playing : null;
    renderSeats(
      $("#l-seats")!,
      lineup.identities.map((id, i) => ({ name: lineup!.names[i] ?? id.name, id, label: lineup!.labels[i] ?? "house", wins: wins[i]!, autopilot: auto[i]!, agent: playing?.[i]?.agent ?? null })),
      picks,
      winner,
    );
  }

  /** The next round: the 4 seats (an agent, and the round it enters, or a house bot) and the queue behind them. */
  function renderNext() {
    const card = $("#n-card")!;
    card.hidden = !arena;
    if (!arena) return;
    const a = arena;
    $("#n-sub")!.textContent = `round ${a.nextRound}${a.queue.length ? ` · ${a.queue.length} waiting` : ""}`;
    const seat = (s: ReturnType<typeof nextLineup>[number]) =>
      s.agent
        ? html`<li><a class="n" href="/agent/${encodeURIComponent(s.agent)}">${s.agent}</a>${s.owner ? html` <span class="ow">· ${s.owner}</span>` : ""}${s.enters ? html` <span class="dim">· enters round ${s.enters}</span>` : ""}${s.soulLine ? html`<div class="sl">${s.soulLine}</div>` : ""}</li>`
        : html`<li><span class="dim">house bot</span> <button class="link" type="button" data-join>take this seat</button></li>`;
    mount(
      $("#n-body"),
      html`<ul class="q">${nextLineup(a).map(seat)}</ul>${a.queue.length
        ? html`<ul class="q">${a.queue.map((w) => html`<li><span class="dim">#${w.position}</span> <a class="n" href="/agent/${encodeURIComponent(w.agent)}">${w.agent}</a>${w.owner ? html` <span class="ow">· ${w.owner}</span>` : ""}</li>`)}</ul>`
        : ""}`,
    );
  }

  function renderResults() {
    const body = $("#r-body")!;
    const rs = featuredFirst(galleryReplays(replays)).slice(0, 6);
    if (!rs.length) {
      body.className = "empty";
      body.textContent = "No finished rounds yet.";
      return;
    }
    body.className = "";
    mount(
      body,
      html`<ul class="results">${rs.map((r) => {
        const w = r.winner >= 0 ? r.winner : 0;
        return html`<li style="${colorVars(cleanIdentity(r.identities[w], w).color)}"><a href="/replay/${r.match}"><b>${r.names[w]}</b> wins</a><span class="dim">${r.tier === "warm-up" ? "Warm-up · " : ""}${cap(r.theme)} · ${ago(r.createdAt)}</span></li>`;
      })}</ul>`,
    );
  }

  every(3000, async () => {
    const q = await getJson<unknown>("/api/queue");
    if (!q.ok) {
      $("#l-meta")!.textContent = "Server unreachable, retrying…";
      return;
    }
    arena = arenaInfo(q.data);
    renderNext();
    renderStage();
    if (lineup) await picks.load(lineup.match); // the picks of the round on stage, so the row's buttons and shares are its own
  });
  every(1000, () => renderStage()); // the lock countdown ticks between polls
  every(20_000, async () => {
    const r = await getJson<{ replays: ReplayInfo[] }>("/api/replays?limit=100");
    if (r.ok) replays = r.data.replays;
    renderResults();
  });
  if (location.hash === "#join") void openJoin();
}
