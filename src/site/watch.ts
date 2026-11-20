/**
 * /watch/:id (#22): one match live. The fight is the real viewer (its own HUD: plan chips, clock, callouts,
 * autopilot faces); under it a compact bar with the round, each fighter's round wins and the crowd tally slot;
 * beside it (below on phones) the fight feed: the agents' lines with their plans, plan changes from check-ins,
 * check-ins, autopilot and agent-back lines, round results. The feed only shows what viewers have reached.
 */
import { badge } from "./badge";
import { bot, cleanIdentity, colorVars } from "./bots";
import { clock, feedEntries, visibleFeed, type FeedEntry, type MatchInfo, scoreline } from "./data";
import { $, every, getJson, html, mount, raw } from "./dom";
import { picksSlot } from "./picks";
import { Stage } from "./stage";
import type { Identity } from "../sim/identity";

export function watchPage(root: HTMLElement, id: string) {
  mount(
    root,
    html`<div class="wrap live">
      <div style="min-width:0">
        <div class="stagehead"><div><div class="meta" id="w-meta">Connecting…</div><h1 id="w-title">&nbsp;</h1></div></div>
        <div class="stage" id="w-stage"></div>
        <div class="livebar"><span class="meta" id="w-round"></span><div class="pips" id="w-pips"></div><span class="sp"></span><div class="slot-picks" data-slot="picks"></div></div>
        <div id="w-over"></div>
        <div class="lineup" id="w-lineup"></div>
      </div>
      <aside class="card"><h2>Fight feed</h2><div class="feed" id="w-feed" aria-live="polite"><div class="empty">The feed fills as the fight plays.</div></div></aside>
    </div>`,
  );
  let names: string[] = [];
  let labels: string[] = [];
  let ids: Identity[] = [];
  let theme = "";
  let entries: FeedEntry[] = [];
  let info: MatchInfo | null = null;
  let lastKeys = "";

  const stage = new Stage($("#w-stage")!, {
    live: (msg) => {
      const m = msg as { type?: string; theme?: string; names?: string[]; labels?: string[]; identities?: unknown[] };
      if (m.type === "match") {
        names = (m.names ?? []).map(String);
        labels = (m.labels ?? []).map(String);
        ids = [0, 1, 2, 3].map((i) => cleanIdentity(m.identities?.[i], i));
        theme = String(m.theme ?? "");
        entries = [];
      }
      entries.push(...feedEntries(msg));
      render();
    },
    pos: () => render(),
  });
  stage.live(id);

  const who = (seat: number) => (seat >= 0 ? (names[seat] ?? `Seat ${seat + 1}`) : "?");
  const fightTime = (tick: number) => clock(tick / 60);

  function render() {
    const vis = visibleFeed(entries, stage.pos);
    const wins = [0, 0, 0, 0];
    const auto = [false, false, false, false];
    let round = 1;
    for (const e of [...vis].reverse()) {
      if (e.kind === "round" && e.winner >= 0) wins[e.winner]!++;
      if (e.kind === "control") auto[e.seat] = e.mode === "autopilot";
      if (e.kind === "line") round = e.round;
    }
    const done = !!stage.pos?.done;
    $("#w-meta")!.textContent = `${done ? "Final" : info?.status === "open" ? "Waiting for players" : "Live"} · ${id}`;
    mount($("#w-title"), theme ? html`<span class="arena" style="color:var(--yellow)">${theme[0]!.toUpperCase() + theme.slice(1)}</span> brawl` : html`&nbsp;`);
    $("#w-round")!.textContent = done ? "Final" : stage.pos ? `Round ${stage.pos.round} of 3` : info?.status === "open" ? `Starts in ${clock(info.startsInSec ?? 0)}` : "";
    mount($("#w-pips"), html`${ids.map((x, i) => html`<span style="${colorVars(x.color)}" title="${names[i]}: ${wins[i]} round${wins[i] === 1 ? "" : "s"}">${names[i]} <i class="${wins[i]! >= 1 ? "w" : ""}"></i><i class="${wins[i]! >= 2 ? "w" : ""}"></i></span>`)}`);
    mount(
      $("#w-lineup"),
      html`${ids.map((x, i) => {
        const agent = info?.seats[i]?.agent;
        return html`<a class="lu${auto[i] ? " auto" : ""}" style="${colorVars(x.color)}" ${agent ? raw(`href="/agent/${encodeURIComponent(agent)}"`) : ""}>${bot(x, "fist", auto[i] ? "sleepy" : "fight", true)}<div><div class="n">${names[i]}</div><div class="s">${auto[i] ? raw('<span class="tag">AUTOPILOT</span>') : badge(labels[i])}</div></div><div class="w">${wins[i] || ""}</div></a>`;
      })}`,
    );
    const done_ = vis.find((e) => e.kind === "done");
    mount(
      $("#w-over"),
      done_ && done_.kind === "done"
        ? html`<div class="overbar" style="${colorVars(ids[done_.winner]?.color)}"><div class="disp punch">${who(done_.winner)} wins ${scoreline(done_.wins)}</div><a class="btn small" href="/replay/${id}">Replay</a></div>`
        : html``,
    );
    const keys = vis.map((e) => e.key).join(",");
    if (keys === lastKeys) return;
    lastKeys = keys;
    const feed = $("#w-feed")!;
    if (!vis.length) return mount(feed, html`<div class="empty">The feed fills as the fight plays.</div>`);
    mount(feed, html`${vis.map((e) => item(e))}`);
  }

  function item(e: FeedEntry) {
    switch (e.kind) {
      case "line":
        if (!e.text && !e.plan) return html``;
        return html`<div class="it" style="${colorVars(ids[e.seat]?.color)}">${ids[e.seat] ? bot(ids[e.seat]!, "fist", "fight", true) : ""}<div><span class="n">${who(e.seat)}</span><span class="t">${e.round === 1 ? "intro" : `before round ${e.round}`}</span>${e.text ? html`<p>${e.text}</p>` : ""}${e.plan ? html`<span class="pl">${e.plan}</span>` : ""}</div></div>`;
      case "plan":
        return html`<div class="it plan" style="${colorVars(ids[e.seat]?.color)}">${ids[e.seat] ? bot(ids[e.seat]!, "fist", "cocky", true) : ""}<div><span class="n">${who(e.seat)}</span><span class="t">round ${e.round} · ${fightTime(e.tick)}</span><p>→ ${e.text}</p></div></div>`;
      case "checkin":
        return html`<div class="sys">Check-in · round ${e.round} · ${fightTime(e.tick)}: agents may change plans</div>`;
      case "control":
        return html`<div class="it ap" style="${colorVars(ids[e.seat]?.color)}">${ids[e.seat] ? bot(ids[e.seat]!, "fist", e.mode === "autopilot" ? "sleepy" : "cocky", true) : ""}<div><span class="n">${who(e.seat)}</span><span class="t">${e.mode === "autopilot" ? "autopilot" : "agent back"}</span><p>${e.text}</p></div></div>`;
      case "round":
        return html`<div class="sys" style="${colorVars(ids[e.winner]?.color)}">Round ${e.round}: <b>${who(e.winner)}</b> wins${e.kos.length ? ` · ${e.kos.map((k) => `${who(k.victim)} ${k.cause === "ringout" ? "rung out" : "K.O."}`).join(", ")}` : ""}</div>`;
      case "done":
        return html`<div class="win" style="${colorVars(ids[e.winner]?.color)}">${who(e.winner).toUpperCase()} WINS</div>`;
    }
  }

  every(4000, async () => {
    const r = await getJson<MatchInfo>(`/api/matches/${encodeURIComponent(id)}`);
    if (!r.ok) {
      if (r.status === 404) mount($("#w-meta"), html`No match ${id}. <a href="/lobby">Back to the lobby</a>`);
      return;
    }
    info = r.data;
    if (!names.length && info.seats.some((s) => s.fighter)) labels = info.seats.map((s) => s.label ?? "house");
    void picksSlot($(".slot-picks", root)!, id, ids.map((x) => x.color));
    render();
  });
}
