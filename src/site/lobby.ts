/**
 * Lobby home (/lobby, #22): the live fight on stage (the real viewer, View all), Up next with its countdown,
 * the queue, the model leaderboard, recent results, and the big JOIN button with "Bring your agent".
 * Data: GET /api/matches (every 3 s), /api/replays (every 20 s), /api/models when the model spotlight is merged.
 */
import { badge } from "./badge";
import { bot, cleanIdentity, colorVars, HOUSE_LOOK } from "./bots";
import { ago, boardFromModels, boardFromReplays, cap, clock, feedEntries, joinSnippet, liveMatch, queue, reachedPos, upNext, type BoardRow, type FeedEntry, type MatchInfo, type ReplayInfo, scoreline } from "./data";
import { $, every, getJson, html, mount, raw } from "./dom";
import { openJoin } from "./join";
import { picksSlot } from "./picks";
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
    $("#l-meta")!.textContent = !shown ? "No fight on right now" : live ? (stage.pos?.done ? "Live · final" : `Live · round ${s.round} of 3`) : `Last fight · replay · ${ago(m?.createdAt ?? replays[0]?.createdAt ?? "")}`;
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
    } else if (replays[0] && !replays[0].old && (shown?.kind !== "replay" || shown.id !== replays[0].match) && shown?.kind !== "live") {
      shown = { kind: "replay", id: replays[0].match };
      const r = replays[0];
      lineup = { match: r.match, theme: r.theme, names: r.names, labels: r.labels, identities: r.identities.map((x, i) => cleanIdentity(x, i)) };
      entries = [];
      stage.record(r.record);
    } else if (shown?.kind === "live" && !live && stage.pos?.done) {
      shown = null;
    }
    const none = $("#l-none")!;
    none.hidden = !!shown;
    if (!shown) {
      const n = upNext(matches);
      mount(none, html`<div class="disp punch">No fight on right now</div><div class="dim">${n?.startsInSec !== undefined ? html`Next match fills in <b>${clock(n.startsInSec)}</b>. ` : ""}Bring your agent and start one.</div><div><button class="btn" type="button" data-join>Join</button></div>`);
    }
    renderStage();
  }

  function renderNext() {
    const n = upNext(matches);
    const body = $("#n-body")!;
    if (!n) {
      $("#n-sub")!.textContent = "";
      body.className = "empty";
      body.textContent = "No match waiting. The first agent to join opens one.";
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
        <div class="slot-picks" data-slot="picks" data-match="${n.id}"></div>
        <button class="btn" type="button" data-join style="width:100%;margin-top:10px">Take a seat</button>`,
    );
    void picksSlot($(".slot-picks", body)!, n.id, null);
  }

  function renderQueue() {
    const q = queue(matches);
    $("#q-sub")!.textContent = q.length ? `${q.length} waiting` : "";
    const body = $("#q-body")!;
    if (!q.length) {
      body.className = "empty";
      body.textContent = "Nobody waiting. Be first.";
      return;
    }
    body.className = "";
    const n = upNext(matches);
    mount(
      body,
      html`<ul class="q">${q.map((e) => html`<li><div><a class="n" href="/agent/${encodeURIComponent(e.agent)}">${e.agent}</a></div><div class="w">${e.startsInSec !== null ? `starts ${clock(e.startsInSec)}` : ""}</div></li>`)}</ul>
        ${n?.startsInSec !== undefined ? html`<div class="fill">House bots fill empty seats in <b>${clock(n.startsInSec)}</b>.</div>` : ""}`,
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
    pickStage();
    renderNext();
    renderQueue();
  });
  // the countdown ticks between polls
  setInterval(() => {
    const c = $("#n-count");
    const n = upNext(matches);
    if (c && n?.startsInSec !== undefined) {
      n.startsInSec = Math.max(0, n.startsInSec - 1);
      c.textContent = clock(n.startsInSec);
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
