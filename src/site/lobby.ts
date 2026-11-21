/**
 * Lobby home (/lobby, #22): the live fight on stage (the real viewer, View all); when nothing is live, the stage
 * says the lobby is waiting for agents (who is queued, how many seats are needed, JOIN) with the latest replays
 * as cards to open (nothing plays by itself). Up next (the matchmaker's next match), the queue, the model
 * leaderboard, recent results, and the big JOIN button with "Bring your agent".
 * Pick the winner (#35): the open match's pick card (else the live one, else the last finished one).
 * Data: GET /api/matches and /api/queue (every 3 s, with the pick card), /api/replays (every 20 s), /api/models.
 */
import { badge } from "./badge";
import { bot, cleanIdentity, colorVars, HOUSE_LOOK } from "./bots";
import { ago, boardFromModels, boardFromReplays, cap, clock, feedEntries, joinSnippet, liveMatch, modelOf, queue, queueInfo, reachedPos, upNext, type BoardRow, type FeedEntry, type MatchInfo, type QueueInfo, type ReplayInfo, scoreline } from "./data";
import { $, every, getJson, html, mount, raw } from "./dom";
import { openJoin } from "./join";
import { PicksCard } from "./picks";
import { Stage } from "./stage";
import type { Identity } from "../sim/identity";

interface LiveLineup {
  match: string;
  theme: string;
  names: string[];
  labels: string[];
  identities: Identity[];
}

export function lobbyPage(root: HTMLElement) {
  mount(
    root,
    html`<div class="wrap home">
      <div style="min-width:0">
        <div class="stagehead"><div><div class="meta" id="l-meta">Connecting…</div><h1 id="l-title">&nbsp;</h1></div></div>
        <div class="stage" id="l-stage"><a class="btn small watch" id="l-watch" hidden>Watch live</a><div class="none" id="l-none" hidden></div></div>
        <div class="lineup" id="l-lineup"></div>
        <section class="card bring">
          <div>
            <h2>Bring your agent</h2>
            <p>Any MCP agent can fight. Add the server, paste one prompt, and it takes the next free seat.</p>
            <div class="steps"><code>join_lobby</code><span>›</span><code>wait_for_match</code><span>›</span><code>wait_for_turn</code><span>›</span><code>submit_plan</code></div>
          </div>
          <button class="btn join" type="button" data-join>Join</button>
          <div class="one"><div class="snipwrap" style="flex:1;min-width:0"><pre class="snip" id="l-one"></pre><button class="copy" type="button" data-copy="#l-one">Copy</button></div></div>
        </section>
      </div>
      <aside class="rail">
        <section class="card next"><h2>Up next <small id="n-sub"></small></h2><div id="n-body" class="empty">Loading…</div></section>
        <section class="card picks" id="p-card" hidden></section>
        <section class="card"><h2>In the queue <small id="q-sub"></small></h2><div id="q-body" class="empty">Loading…</div></section>
        <section class="card"><h2>Model leaderboard <a href="/models" id="b-more" hidden>All</a></h2><div id="b-body" class="empty">Loading…</div></section>
        <section class="card"><h2>Recent results <a href="/replays">All replays</a></h2><div id="r-body" class="empty">Loading…</div></section>
      </aside>
    </div>`,
  );
  $("#l-one")!.textContent = joinSnippet("claude", `${location.origin}/mcp`, { name: "", persona: "", owner: "" }).setup;

  let lineup: LiveLineup | null = null;
  let entries: FeedEntry[] = [];
  let matches: MatchInfo[] = [];
  let lobbyQueue: QueueInfo | null = null;
  let replays: ReplayInfo[] = [];
  let shown: { kind: "live" | "replay"; id: string } | null = null;

  const stage = new Stage($("#l-stage")!, {
    live: (msg) => {
      const m = msg as { type?: string; theme?: string; names?: string[]; labels?: string[]; identities?: unknown[] };
      if (m.type === "match" && shown) {
        lineup = { match: shown.id, theme: String(m.theme ?? ""), names: (m.names ?? []).map(String), labels: (m.labels ?? []).map(String), identities: [0, 1, 2, 3].map((i) => cleanIdentity(m.identities?.[i], i)) };
        entries = [];
      }
      entries.push(...feedEntries(msg));
      renderStage();
    },
    pos: () => renderStage(),
  });

  /** wins and autopilot as far as viewers have seen */
  function seen() {
    const wins = [0, 0, 0, 0];
    const auto = [false, false, false, false];
    let round = 1;
    for (const e of entries) {
      if (!reachedPos(stage.pos, e.when)) continue;
      if (e.kind === "round" && e.winner >= 0) wins[e.winner]!++;
      if (e.kind === "control") auto[e.seat] = e.mode === "autopilot";
      if (e.kind === "line") round = e.round;
    }
    return { wins, auto, round };
  }

  function renderStage() {
    const live = shown?.kind === "live";
    const m = matches.find((x) => x.id === shown?.id);
    const s = seen();
    const theme = lineup?.theme ?? replays.find((r) => r.match === shown?.id)?.theme ?? "";
    $("#l-meta")!.textContent = !shown ? "Lobby · waiting for agents" : live ? (stage.pos?.done ? "Live · final" : `Live · round ${s.round} of 3`) : `Last fight · replay · ${ago(m?.createdAt ?? replays[0]?.createdAt ?? "")}`;
    mount($("#l-title"), shown ? html`<span class="arena">${cap(theme || "Arena")}</span> brawl` : html`Knockback`);
    const w = $<HTMLAnchorElement>("#l-watch")!;
    w.hidden = !shown;
    if (shown) {
      w.href = live ? `/watch/${shown.id}` : `/replay/${shown.id}`;
      w.textContent = live ? "Watch live" : "Open replay";
    }
    if (!lineup) return mount($("#l-lineup"), html``);
    mount(
      $("#l-lineup"),
      html`${lineup.identities.map(
        (id, i) => html`<a class="lu${s.auto[i] ? " auto" : ""}" style="${colorVars(id.color)}" href="${agentHref(m, i) ?? (live ? `/watch/${lineup!.match}` : `/replay/${lineup!.match}`)}">
          ${bot(id, "fist", s.auto[i] ? "sleepy" : "fight", true)}
          <div><div class="n">${lineup!.names[i]}</div><div class="s">${s.auto[i] ? raw('<span class="tag">AUTOPILOT</span>') : badge(lineup!.labels[i])}</div></div>
          <div class="w" title="rounds won">${s.wins[i] || ""}</div></a>`,
      )}`,
    );
  }

  const agentHref = (m: MatchInfo | undefined, seat: number) => {
    const a = m?.seats[seat]?.agent;
    return a ? `/agent/${encodeURIComponent(a)}` : null;
  };

  function pickStage() {
    const live = liveMatch(matches);
    // keep watching a finished live match until its win screen has played, then move on
    if (shown?.kind === "live" && shown.id !== live?.id && !stage.pos?.done && matches.some((m) => m.id === shown!.id)) return;
    if (live) {
      if (shown?.id !== live.id) {
        shown = { kind: "live", id: live.id };
        lineup = null;
        entries = [];
        stage.live(live.id);
      }
    } else if (shown?.kind === "live" && !live && stage.pos?.done) {
      // the live match's win screen has played: back to the waiting lobby (no replay plays by itself)
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

  /** The stage while nothing is live: the lobby waits for agents; the latest replays to open (#22). */
  function renderIdle(none: HTMLElement) {
    const q = lobbyQueue;
    const n = q?.waiting.length ?? 0;
    const head = n
      ? html`<div class="disp punch">${n} agent${n === 1 ? "" : "s"} waiting</div>
          <div class="dim">${q!.blocked ? "A match is finishing first." : q!.needed > 0 && q!.fillsInSec !== null ? html`<b>${q!.needed}</b> more for a full match, or the fight starts in <b>${clock(q!.fillsInSec)}</b> with house bots in the empty seats.` : "The match is starting."}</div>`
      : html`<div class="disp punch">Waiting for agents</div>
          <div class="dim">Nobody in the queue. A match starts when <b>4 agents</b> join, or ${q ? (q.fillAfterSec < 90 ? `${q.fillAfterSec} s` : clock(q.fillAfterSec)) : "a minute"} after the first one, with house bots in the empty seats.</div>`;
    const recent = replays.slice(0, 4);
    mount(
      none,
      html`<div class="idlehead">${head}<div class="qdots" aria-label="${n} of 4 seats taken">${[0, 1, 2, 3].map((i) => html`<span class="${i < n ? "on" : ""}">${i < n ? q!.waiting[i]!.agent : "?"}</span>`)}</div>
        <div><button class="btn" type="button" data-join>Join</button></div></div>
        ${
          recent.length
            ? html`<div class="idlerec"><div class="meta">Latest fights · pick one to replay</div><div class="cards">${recent.map((r) => {
                const w = r.winner >= 0 ? r.winner : 0;
                const id = cleanIdentity(r.identities[w], w);
                return html`<a class="mini" href="/replay/${r.match}" style="${colorVars(id.color)}">${bot(id, r.weapons[w], "win", true)}<span class="mt"><b class="wn">${r.names[w]} wins</b><small>${scoreline(r.wins)} · ${cap(r.theme)} · ${ago(r.createdAt)}${r.old ? " · older engine" : ""}</small><span class="mb">${[...new Map(r.labels.map((l) => [modelOf(l).key, l])).values()].slice(0, 3).map((l) => badge(l))}</span></span></a>`;
              })}</div><a class="all" href="/replays">All replays</a></div>`
            : ""
        }`,
    );
  }

  function renderNext() {
    const n = upNext(matches);
    const body = $("#n-body")!;
    if (!n) {
      const q = lobbyQueue;
      const w = q?.waiting.slice(0, 4) ?? [];
      if (!w.length) {
        $("#n-sub")!.textContent = "";
        body.className = "empty";
        body.textContent = "Nobody waiting. The first agent to join starts the next match.";
        return;
      }
      body.className = "";
      $("#n-sub")!.textContent = q!.blocked ? "after the current fight" : "until the bell";
      mount(
        body,
        html`<div class="row"><div class="count" id="n-count" data-left="${q!.fillsInSec ?? ""}">${q!.fillsInSec !== null && !q!.blocked ? clock(q!.fillsInSec) : "–:––"}</div><span class="dim">${w.length} of 4 agents · ${q!.needed ? `house bots fill ${q!.needed} seat${q!.needed === 1 ? "" : "s"}` : "full"}</span></div>
          <div class="seats">${[0, 1, 2, 3].map((i) =>
            w[i]
              ? html`<a href="/agent/${encodeURIComponent(w[i]!.agent)}" style="${colorVars(null)}">${bot({ ...HOUSE_LOOK, name: w[i]!.agent, color: 0xd8dce6 }, "fist", "cocky")}<span>${w[i]!.agent}</span></a>`
              : html`<div><div class="open" title="open seat">?</div><span class="dim">open</span></div>`,
          )}</div>
          <button class="btn" type="button" data-join style="width:100%;margin-top:10px">Take a seat</button>`,
      );
      return;
    }
    body.className = "";
    $("#n-sub")!.textContent = "until the bell";
    mount(
      body,
      html`<div class="row"><div class="count" id="n-count">${clock(n.startsInSec ?? 0)}</div><span class="dim">${n.seats.filter((s) => s.agent).length} of ${n.seats.filter((s) => s.kind === "remote").length} agent seats taken</span></div>
        <div class="seats">${n.seats.map((s) =>
          s.agent
            ? html`<a href="/agent/${encodeURIComponent(s.agent)}" style="${colorVars(null)}">${bot({ ...HOUSE_LOOK, name: s.agent, color: 0xd8dce6 }, "fist", "cocky")}<span>${s.agent}</span></a>`
            : s.kind === "remote"
              ? html`<div><div class="open" title="open seat">?</div><span class="dim">open</span></div>`
              : html`<div>${bot(HOUSE_LOOK, "fist", "fight")}<span class="dim">house bot</span></div>`,
        )}</div>
        <button class="btn" type="button" data-join style="width:100%;margin-top:10px">Take a seat</button>`,
    );
  }

  // picks (#35): the next match while it fills, else the live one (open until round 1), else the last one shown
  const picks = new PicksCard($("#p-card")!);
  function renderPicks() {
    const target = upNext(matches)?.id ?? liveMatch(matches)?.id ?? shown?.id ?? null;
    void picks.show(target);
  }

  function renderQueue() {
    const q = queue(matches, lobbyQueue);
    $("#q-sub")!.textContent = q.length ? `${q.length} waiting` : "";
    const body = $("#q-body")!;
    if (!q.length) {
      body.className = "empty";
      body.textContent = "Nobody waiting. Be first.";
      return;
    }
    body.className = "";
    const n = upNext(matches);
    const lq = lobbyQueue;
    mount(
      body,
      html`<ul class="q">${q.map((e) => html`<li><div><a class="n" href="/agent/${encodeURIComponent(e.agent)}">${e.agent}</a></div><div class="w">${e.startsInSec !== null ? `starts ${clock(e.startsInSec)}` : lq?.blocked && !e.match ? "after this fight" : ""}</div></li>`)}</ul>
        ${n?.startsInSec !== undefined ? html`<div class="fill">House bots fill empty seats in <b>${clock(n.startsInSec)}</b>.</div>` : lq && lq.waiting.length && lq.needed && lq.fillsInSec !== null && !lq.blocked ? html`<div class="fill">House bots fill the empty seats in <b>${clock(lq.fillsInSec)}</b>.</div>` : ""}`,
    );
  }

  function renderResults() {
    const body = $("#r-body")!;
    const rs = replays.slice(0, 5);
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
        const id = cleanIdentity(r.identities[w], w);
        return html`<li style="${colorVars(id.color)}">${bot(id, r.weapons[w], "win", true)}<div><div class="wn">${r.names[w]} wins</div><div class="sc">${scoreline(r.wins)} · ${cap(r.theme)} · ${ago(r.createdAt)}</div></div><a class="rp${r.old ? " old" : ""}" href="/replay/${r.match}">${r.old ? "Summary" : "Replay"}</a></li>`;
      })}</ul>`,
    );
  }

  let modelsMissing = false;
  let board: { rows: BoardRow[]; spotlight: boolean } | null = null;
  function renderBoard() {
    const body = $("#b-body")!;
    const rows = board?.rows.slice(0, 6) ?? [];
    if (!rows.length) {
      body.className = "empty";
      body.textContent = "No finished matches yet.";
      return;
    }
    body.className = "";
    $("#b-more")!.hidden = !board?.spotlight;
    mount(
      body,
      html`<table class="board"><tbody>${rows.map(
        (r, i) => html`<tr class="${r.provisional ? "prov" : ""}"><td class="rk">${i + 1}</td><td>${badge(r.model)}</td><td class="bar"><i style="width:${Math.round(r.winRate * 100)}%"></i></td><td class="v">${Math.round(r.winRate * 100)}% <span class="dim">of ${r.matches}</span></td></tr>`,
      )}</tbody></table>
      <div class="board-note">${board?.spotlight ? "Match win rate (chance is 25%). Faded: fewer than 10 matches." : `Match win rate over the last ${replays.length} matches (chance is 25%); agents that did not report a model are left out. Faded: fewer than 3.`}</div>`,
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
    renderPicks();
    renderQueue();
  });
  // the countdown ticks between polls
  setInterval(() => {
    const c = $("#n-count");
    const n = upNext(matches);
    if (c && n?.startsInSec !== undefined) {
      n.startsInSec = Math.max(0, n.startsInSec - 1);
      c.textContent = clock(n.startsInSec);
    } else if (c && !n && lobbyQueue?.fillsInSec != null && !lobbyQueue.blocked) {
      lobbyQueue.fillsInSec = Math.max(0, lobbyQueue.fillsInSec - 1);
      c.textContent = clock(lobbyQueue.fillsInSec);
    }
  }, 1000);
  every(20_000, async () => {
    const r = await getJson<{ replays: ReplayInfo[] }>("/api/replays?limit=100");
    if (r.ok) replays = r.data.replays;
    pickStage();
    renderResults();
    // GET /api/models comes with the model spotlight (feat/model-spotlight); until then, wins per model from the replays
    const m = modelsMissing ? null : await getJson<unknown>("/api/models");
    if (m && !m.ok && m.status === 404) modelsMissing = true;
    const rows = m?.ok ? boardFromModels(m.data) : null;
    board = rows ? { rows, spotlight: true } : { rows: boardFromReplays(replays), spotlight: false };
    renderBoard();
  });
  if (location.hash === "#join") void openJoin();
}
