/**
 * Lobby home (/lobby, #22): the live fight on stage (the real viewer) with its seat row (seats.ts: names, models,
 * wins, picks); when nothing is live, the stage says who is waiting and how a match starts, with JOIN. Beside it:
 * up next (while a match fills) and the recent results. Data: GET /api/matches and /api/queue (every 3 s),
 * /api/replays (every 20 s).
 */
import { cleanIdentity, colorVars } from "./bots";
import { ago, cap, clock, feedEntries, galleryReplays, liveMatch, queueInfo, reachedPos, upNext, type FeedEntry, type MatchInfo, type QueueInfo, type ReplayInfo, scoreline } from "./data";
import { $, every, getJson, html, mount } from "./dom";
import { openJoin } from "./join";
import { Picks } from "./picks";
import { renderSeats, wirePicks } from "./seats";
import { Stage } from "./stage";
import type { Identity } from "../sim/identity";

interface LiveLineup {
  match: string;
  names: string[];
  labels: string[];
  identities: Identity[];
}

export function lobbyPage(root: HTMLElement) {
  mount(
    root,
    html`<div class="wrap home">
      <div class="main">
        <div class="wbar"><span class="meta" id="l-meta">Connecting…</span><span class="sp"></span><a class="btn small" id="l-watch" hidden>Watch</a></div>
        <div class="stage" id="l-stage"><div class="none" id="l-none" hidden></div></div>
        <div class="seatrow" id="l-seats"></div>
      </div>
      <aside class="rail">
        <section class="card" id="n-card" hidden><h2>Up next <small id="n-sub"></small></h2><div id="n-body"></div></section>
        <section class="card"><h2>Recent results <a href="/replays">All</a></h2><div id="r-body" class="empty">Loading…</div></section>
      </aside>
    </div>`,
  );

  let lineup: LiveLineup | null = null;
  let entries: FeedEntry[] = [];
  let matches: MatchInfo[] = [];
  let lobbyQueue: QueueInfo | null = null;
  let replays: ReplayInfo[] = [];
  let shown: string | null = null;
  const picks = new Picks(() => renderStage());
  wirePicks($("#l-seats")!, picks);

  const stage = new Stage($("#l-stage")!, {
    live: (msg) => {
      const m = msg as { type?: string; names?: string[]; labels?: string[]; identities?: unknown[] };
      if (m.type === "match" && shown) {
        lineup = { match: shown, names: (m.names ?? []).map(String), labels: (m.labels ?? []).map(String), identities: [0, 1, 2, 3].map((i) => cleanIdentity(m.identities?.[i], i)) };
        entries = [];
      }
      entries.push(...feedEntries(msg));
      renderStage();
    },
    pos: () => renderStage(),
  });

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
    const m = matches.find((x) => x.id === shown);
    const pickLine = picks.status();
    $("#l-meta")!.textContent = !shown
      ? "Waiting for agents"
      : winner >= 0
        ? ["Final", pickLine].filter(Boolean).join(" · ") // the viewer's win screen says who won, once
        : pickLine || (stage.pos ? `Live · round ${stage.pos.round} of 3` : "Live");
    const w = $<HTMLAnchorElement>("#l-watch")!;
    w.hidden = !shown;
    if (shown) w.href = `/watch/${shown}`;
    if (!lineup) return mount($("#l-seats"), html``);
    renderSeats(
      $("#l-seats")!,
      lineup.identities.map((id, i) => ({ name: lineup!.names[i] ?? id.name, id, label: lineup!.labels[i] ?? "house", wins: wins[i]!, autopilot: auto[i]!, agent: m?.seats[i]?.agent ?? null })),
      picks,
      winner,
    );
  }

  function pickStage() {
    const live = liveMatch(matches);
    // keep watching a finished live match until its win screen has played, then move on
    if (shown && shown !== live?.id && !stage.pos?.done && matches.some((m) => m.id === shown)) return;
    if (live) {
      if (shown !== live.id) {
        shown = live.id;
        lineup = null;
        entries = [];
        stage.live(live.id);
      }
    } else if (shown && stage.pos?.done) {
      // the win screen has played: back to the waiting lobby (no replay plays by itself)
      shown = null;
      lineup = null;
      stage.stop();
    }
    const none = $("#l-none")!;
    none.hidden = !!shown;
    $("#l-stage")!.classList.toggle("idle", !shown);
    if (!shown) renderIdle(none);
    renderStage();
  }

  /** The stage while nothing is live: who waits, how a match starts, JOIN. */
  function renderIdle(none: HTMLElement) {
    const q = lobbyQueue;
    const n = q?.waiting.length ?? 0;
    mount(
      none,
      n
        ? html`<div class="disp">${n} agent${n === 1 ? "" : "s"} waiting</div>
            <div class="dim">${q!.blocked ? "A match is finishing first." : q!.needed > 0 && q!.fillsInSec !== null ? html`${q!.needed} more for a full match, or it starts in <b>${clock(q!.fillsInSec)}</b> with house bots in the empty seats.` : q!.needed > 0 ? `${q!.needed} more to start the match.` : "The match is starting."}</div>
            <div><button class="btn" type="button" data-join>Join</button></div>`
        : html`<div class="disp">Waiting for agents</div>
            <div class="dim">A match starts when 4 agents join${q && q.fillAfterSec !== null ? `, or ${q.fillAfterSec < 90 ? `${q.fillAfterSec} s` : clock(q.fillAfterSec)} after the first one` : ""}.</div>
            <div><button class="btn" type="button" data-join>Join</button></div>`,
    );
  }

  /** Up next: the match that is filling (seats and countdown), or the queue before it; hidden when neither. */
  function renderNext() {
    const n = upNext(matches);
    const q = lobbyQueue;
    const card = $("#n-card")!;
    const names = n ? n.seats.map((s) => s.agent ?? (s.kind === "remote" ? null : "house bot")) : (q?.waiting.slice(0, 4).map((w) => w.agent) ?? []);
    const left = n ? (n.startsInSec ?? null) : q && !q.blocked ? q.fillsInSec : null;
    card.hidden = !n && !names.length;
    if (card.hidden) return;
    $("#n-sub")!.textContent = left !== null ? `starts in ${clock(left)}` : q?.blocked ? "after this fight" : "";
    mount(
      $("#n-body"),
      html`<ul class="q">${[0, 1, 2, 3].map((i) => {
        const a = names[i];
        return html`<li>${a && a !== "house bot" ? html`<a class="n" href="/agent/${encodeURIComponent(a)}">${a}</a>` : html`<span class="dim">${a ?? "open seat"}</span>`}</li>`;
      })}</ul>`,
    );
  }

  function renderResults() {
    const body = $("#r-body")!;
    const rs = galleryReplays(replays).slice(0, 6);
    if (!rs.length) {
      body.className = "empty";
      body.textContent = "No finished matches yet.";
      return;
    }
    body.className = "";
    mount(
      body,
      html`<ul class="results">${rs.map((r) => {
        const w = r.winner >= 0 ? r.winner : 0;
        return html`<li style="${colorVars(cleanIdentity(r.identities[w], w).color)}"><a href="/replay/${r.match}"><b>${r.names[w]}</b> wins ${scoreline(r.wins)}</a><span class="dim">${cap(r.theme)} · ${ago(r.createdAt)}</span></li>`;
      })}</ul>`,
    );
  }

  every(3000, async () => {
    const r = await getJson<{ matches: MatchInfo[] }>("/api/matches");
    if (!r.ok) {
      $("#l-meta")!.textContent = "Server unreachable, retrying…";
      return;
    }
    matches = r.data.matches;
    const q = await getJson<unknown>("/api/queue");
    lobbyQueue = q.ok ? queueInfo(q.data) : null;
    pickStage();
    renderNext();
    await picks.load(shown); // the picks of the match on stage, so the row's buttons and shares are its own
  });
  every(1000, () => renderStage()); // the lock countdown ticks between polls
  every(20_000, async () => {
    const r = await getJson<{ replays: ReplayInfo[] }>("/api/replays?limit=100");
    if (r.ok) replays = r.data.replays;
    renderResults();
  });
  if (location.hash === "#join") void openJoin();
}
