/**
 * /watch/:id (#22): one match live. The fight is the page: the real viewer (fight and plan chips only), one status
 * line, the seat row under it (name, model, wins, picks; seats.ts) and, once there is something to read, a short
 * feed beside it: the agents' lines, plan changes, autopilot, round results. The feed only shows what viewers have
 * reached.
 */
import { cleanIdentity, colorVars } from "./bots";
import { clock, feedEntries, visibleFeed, type FeedEntry, type MatchInfo, scoreline } from "./data";
import { $, every, getJson, html, mount } from "./dom";
import { Picks } from "./picks";
import { renderSeats, wirePicks } from "./seats";
import { Stage } from "./stage";
import type { Identity } from "../sim/identity";

export function watchPage(root: HTMLElement, id: string) {
  mount(
    root,
    html`<div class="wrap live">
      <div class="main">
        <div class="wbar"><span class="meta" id="w-meta">Connecting…</span><span class="sp"></span><a class="btn small" id="w-replay" href="/replay/${id}" hidden>Replay</a></div>
        <div class="stage" id="w-stage"></div>
        <div class="seatrow" id="w-seats"></div>
      </div>
      <aside class="feed" id="w-feed" aria-live="polite" hidden></aside>
    </div>`,
  );
  let names: string[] = [];
  let labels: string[] = [];
  let ids: Identity[] = [];
  let entries: FeedEntry[] = [];
  let info: MatchInfo | null = null;
  let lastKeys = "";
  const picks = new Picks(() => render());
  wirePicks($("#w-seats")!, picks);

  const stage = new Stage($("#w-stage")!, {
    live: (msg) => {
      const m = msg as { type?: string; names?: string[]; labels?: string[]; identities?: unknown[] };
      if (m.type === "match") {
        names = (m.names ?? []).map(String);
        labels = (m.labels ?? []).map(String);
        ids = [0, 1, 2, 3].map((i) => cleanIdentity(m.identities?.[i], i));
        entries = [];
      }
      entries.push(...feedEntries(msg));
      render();
    },
    pos: () => render(),
  });
  stage.live(id);

  const who = (seat: number) => (seat >= 0 ? (names[seat] ?? `Seat ${seat + 1}`) : "?");

  function render() {
    const vis = visibleFeed(entries, stage.pos);
    const wins = [0, 0, 0, 0];
    const auto = [false, false, false, false];
    for (const e of [...vis].reverse()) {
      if (e.kind === "round" && e.winner >= 0) wins[e.winner]!++;
      if (e.kind === "control") auto[e.seat] = e.mode === "autopilot";
    }
    const done = vis.find((e) => e.kind === "done");
    const winner = done?.kind === "done" ? done.winner : -1;
    const pickLine = picks.status();
    $("#w-meta")!.textContent =
      winner >= 0
        ? [`${who(winner)} wins ${scoreline(done!.kind === "done" ? done!.wins : wins)}`, pickLine].filter(Boolean).join(" · ")
        : info?.status === "open"
          ? `Waiting for players · starts in ${clock(info.startsInSec ?? 0)}`
          : pickLine || (stage.pos ? `Live · round ${stage.pos.round} of 3` : "Live");
    $("#w-replay")!.hidden = winner < 0;
    // before the stream's line-up arrives (an open match), the seats come from the match info, once they have bots
    if (ids.length)
      renderSeats(
        $("#w-seats")!,
        ids.map((x, i) => ({ name: names[i] ?? x.name, id: x, label: labels[i] ?? "house", wins: wins[i]!, autopilot: auto[i]!, agent: info?.seats[i]?.agent ?? null })),
        picks,
        winner,
      );
    const keys = vis.map((e) => e.key).join(",");
    if (keys === lastKeys) return;
    lastKeys = keys;
    const items = vis.map(item).filter((x) => x.s);
    const feed = $("#w-feed")!;
    feed.hidden = !items.length;
    mount(feed, html`${items}`);
  }

  function item(e: FeedEntry) {
    const c = (seat: number) => colorVars(ids[seat]?.color);
    switch (e.kind) {
      case "line":
        return e.text ? html`<p style="${c(e.seat)}"><b>${who(e.seat)}</b> ${e.text}</p>` : html``;
      case "plan":
        return html`<p style="${c(e.seat)}"><b>${who(e.seat)}</b> → ${e.text}</p>`;
      case "control":
        return html`<p class="ap" style="${c(e.seat)}"><b>${who(e.seat)}</b> ${e.mode === "autopilot" ? "on autopilot" : "is back"}${e.text ? html`: ${e.text}` : ""}</p>`;
      case "round":
        return html`<p class="sys" style="${c(e.winner)}">Round ${e.round}: <b>${who(e.winner)}</b>${e.kos.length ? ` · ${e.kos.map((k) => `${who(k.victim)} ${k.cause === "ringout" ? "rung out" : "K.O."}`).join(", ")}` : ""}</p>`;
      default:
        return html``; // check-ins and the final result: the status line says it
    }
  }

  every(1000, () => render()); // the lock countdown and "starts in" tick
  every(4000, async () => {
    const r = await getJson<MatchInfo>(`/api/matches/${encodeURIComponent(id)}`);
    if (!r.ok) {
      if (r.status === 404) mount($("#w-meta"), html`No match ${id}. <a href="/lobby">Back to the lobby</a>`);
      return;
    }
    info = r.data;
    if (!names.length && info.seats.some((s) => s.fighter)) labels = info.seats.map((s) => s.label ?? "house");
    await picks.load(id);
  });
}
