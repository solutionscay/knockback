/**
 * /replay/:id (#22, #106): a finished match from its record in the real viewer, with a scrubber (round segments, event
 * pins for ring-outs, K.O.s and the win, in the victim's or winner's color) and 1x / 2x; under it the seat row.
 *
 * The timeline comes from the match report (knockout ticks, fight ticks) and the viewer's own beat timing
 * (src/flow/pacing.ts), the same numbers the server paces broadcasts with.
 */
import { cleanIdentity, colorVars } from "./bots";
import { cap, clock, posAtTime, timeOfPos, timeline, type MatchInfo, type ReplayInfo, type ReportRound, type Timeline } from "./data";
import { $, getJson, html, mount, raw } from "./dom";
import { PlanCard } from "./plan-card";
import { when as dateOf } from "./replays";
import { PLAN_SLOT, renderSeats } from "./seats";
import { Stage } from "./stage";
import type { Identity } from "../sim/identity";

export async function replayPage(root: HTMLElement, id: string) {
  mount(root, html`<div class="wrap"><div class="meta">Loading replay ${id}…</div></div>`);
  // one match by id (#22: every finished match is replayable)
  const [one, info] = await Promise.all([getJson<{ replay: ReplayInfo }>(`/api/replays/${encodeURIComponent(id)}`), getJson<MatchInfo>(`/api/matches/${encodeURIComponent(id)}`)]);
  const rp = one.ok ? one.data.replay : undefined;
  if (!info.ok && !rp) return mount(root, html`<div class="wrap"><div class="wbar"><span class="meta">No match ${id}</span></div><a class="btn" href="/replays">All replays</a></div>`);
  const record = rp?.record ?? (info.ok ? info.data.record : null);
  if (!record) return mount(root, html`<div class="wrap"><div class="wbar"><span class="meta">Not finished yet</span></div><a class="btn" href="/watch/${id}">Watch it live</a></div>`);
  const ids: Identity[] = rp ? rp.identities.map((x, i) => cleanIdentity(x, i)) : [];
  const names = rp?.names ?? (info.ok ? info.data.seats.map((s) => s.fighter ?? "?") : []);
  const labels = rp?.labels ?? (info.ok ? info.data.seats.map((s) => s.label ?? "house") : []);
  const w = rp?.winner ?? -1;
  const when = rp ? [dateOf(rp.createdAt), cap(rp.theme)].filter(Boolean).join(" · ") : "";
  const agents = info.ok ? info.data.seats.map((s) => s.agent) : [];

  mount(
    root,
    html`<div class="wrap lobby">
      <div class="main">
        <div class="wbar"><span class="meta">Replay${when ? ` · ${when}` : ""}</span></div>
        <div class="stage" id="r-stage"><div class="seeking" id="r-seek" hidden>Rewinding…</div></div>
        ${html`<div class="scrub" id="r-scrub"><button class="play" id="r-play" type="button" aria-label="Pause">❚❚</button><div class="track" id="r-track" role="slider" aria-label="Replay position" tabindex="0"></div><span class="tm" id="r-tm"></span><div class="speed"><button type="button" data-speed="1" aria-pressed="true">1×</button><button type="button" data-speed="2" aria-pressed="false">2×</button></div></div>`}
        <div class="seatrow" id="r-seats"></div>
        ${raw(PLAN_SLOT)}
      </div>
    </div>`,
  );
  if (rp)
    renderSeats(
      $("#r-seats")!,
      ids.map((x, i) => ({ name: names[i] ?? x.name, id: x, label: labels[i] ?? "house", autopilot: rp.control.some((c) => c.seat === i && c.mode === "autopilot"), agent: agents[i] ?? null })),
      w,
    );
  let tl: Timeline | null = null;
  let speed = 1;
  let shownT = 0;
  let anchor = { t: 0, at: performance.now(), key: "" };
  let plan: PlanCard | null = null;
  const stage = new Stage($("#r-stage")!, {
    seeking: (on) => ($("#r-seek")!.hidden = !on),
    ev: (round, e) => plan?.book.event(round, e),
    pos: (p) => {
      plan?.render();
      if (!tl) return;
      // fight ticks map exactly; between them, run a local clock so the knob moves through the talk and the round end
      const t = timeOfPos(tl, p);
      const key = p ? `${p.round}.${p.phase}.${p.phase === "fight" ? p.tick : ""}` : "";
      if (key !== anchor.key || p?.phase === "fight") anchor = { t, at: performance.now(), key };
    },
  });
  stage.record(record);
  // the plan card (#104): a tapped fighter's plan at the playhead; the record has the plans, updates and firings
  plan = new PlanCard($("#plan-slot")!, stage, $("#r-seats"));
  plan.ids = ids;
  plan.book.names = names;
  plan.book.labels = labels;
  void getJson<unknown>(record).then((r) => {
    if (r.ok) plan!.book.record(r.data);
  });

  const rep = await getJson<{ rounds: ReportRound[] }>(`/api/matches/${encodeURIComponent(id)}/report`);
  if (!rep.ok) {
    $("#r-tm")!.textContent = rep.status === 429 ? "Too many replays loaded at once; reload for the scrubber." : "No timeline for this match.";
    return;
  }
  tl = timeline(rep.data.rounds, names);
  const track = $("#r-track")!;
  let lastLabeled = -1e9;
  const pct = (t: number) => `${((t / tl!.total) * 100).toFixed(3)}%`;
  mount(
    track,
    html`${tl.segments.map((s) => html`<div class="seg" style="left:${pct(s.start)};width:calc(${pct(s.end - s.start)} - 4px)"><i data-seg="${s.round}"></i></div>`)}
      ${tl.pins.map((p, i) => {
        // a label only where it has room: pins closer than 7% of the track to the last labeled one stay bare
        const room = i === 0 || p.t - lastLabeled > tl!.total * 0.07;
        if (room) lastLabeled = p.t;
        return html`<button type="button" class="pin" style="left:${pct(p.t)};${colorVars(ids[p.seat]?.color)}" data-t="${p.t}" ${room ? raw(`data-l="${p.label}"`) : ""} title="${names[p.seat] ?? ""} ${p.label}"></button>`;
      })}
      <div class="knob" id="r-knob"></div>`,
  );
  const seekTo = (t: number) => {
    const to = posAtTime(tl!, Math.max(0, Math.min(tl!.total - 0.01, t)));
    stage.seek(to);
    anchor = { t: timeOfPos(tl!, to), at: performance.now(), key: "seek" };
  };
  const tFromX = (x: number) => {
    const r = track.getBoundingClientRect();
    return ((x - r.left) / r.width) * tl!.total;
  };
  track.addEventListener("click", (e) => {
    const pin = (e.target as HTMLElement).closest<HTMLElement>("[data-t]");
    seekTo(pin ? Number(pin.dataset.t) - 2 : tFromX(e.clientX));
  });
  track.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") seekTo(shownT + 10);
    if (e.key === "ArrowLeft") seekTo(shownT - 10);
  });
  $("#r-scrub")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-speed]");
    if (b) {
      speed = Number(b.dataset.speed);
      stage.speed(speed);
      for (const x of $("#r-scrub")!.querySelectorAll("[data-speed]")) x.setAttribute("aria-pressed", String(x === b));
      playing = true;
      syncPlay();
    }
  });
  let playing = true;
  const syncPlay = () => {
    const b = $("#r-play")!;
    b.textContent = playing ? "❚❚" : "▶";
    b.setAttribute("aria-label", playing ? "Pause" : "Play");
  };
  $("#r-play")!.addEventListener("click", () => {
    playing = !playing;
    stage.speed(playing ? speed : 0);
    anchor = { ...anchor, t: shownT, at: performance.now() };
    syncPlay();
  });

  const tick = () => {
    if (tl && stage.pos) {
      const s = tl.segments.find((x) => x.round === stage.pos!.round);
      let t = anchor.t + (playing && anchor.key !== "seek" ? ((performance.now() - anchor.at) / 1000) * speed : 0);
      // never run past the phase the viewer is in
      if (s && stage.pos.phase === "plan") t = Math.min(t, s.start + s.preFight);
      if (s && stage.pos.phase === "fight") t = Math.min(t, s.start + s.preFight + s.fight);
      if (s && stage.pos.phase === "end" && !stage.pos.done) t = Math.min(t, s.end);
      shownT = Math.max(0, Math.min(tl.total, t));
      $("#r-knob")!.style.left = pct(shownT);
      for (const seg of track.querySelectorAll<HTMLElement>("[data-seg]")) {
        const sg = tl.segments[Number(seg.dataset.seg) - 1]!;
        seg.style.width = `${Math.max(0, Math.min(1, (shownT - sg.start) / (sg.end - sg.start))) * 100}%`;
      }
      $("#r-tm")!.textContent = `${clock(shownT)} / ${clock(tl.total)}`;
      track.setAttribute("aria-valuenow", String(Math.round(shownT)));
    }
    requestAnimationFrame(tick);
  };
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", String(Math.round(tl.total)));
  requestAnimationFrame(tick);
}
