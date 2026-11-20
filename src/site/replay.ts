/**
 * /replay/:id (#22): a finished match from its record in the real viewer, with a scrubber (round segments, event
 * pins for ring-outs, K.O.s and the win, in the victim's or winner's color), chapters, 1x / 2x, and the share card
 * with its link. A record from another engine version cannot replay on this physics: the page shows its line-up,
 * result and lines on a card instead (the viewer does the same).
 *
 * The timeline comes from the match report (knockout ticks, fight ticks) and the viewer's own beat timing
 * (src/flow/pacing.ts), the same numbers the server paces broadcasts with.
 */
import { badge } from "./badge";
import { bot, cleanIdentity, colorVars } from "./bots";
import { cap, clock, posAtTime, timeOfPos, timeline, type MatchInfo, type ReplayInfo, type ReportRound, type Timeline, scoreline } from "./data";
import { $, getJson, html, mount, raw } from "./dom";
import { Stage } from "./stage";
import type { Identity } from "../sim/identity";

export async function replayPage(root: HTMLElement, id: string) {
  mount(root, html`<div class="wrap"><div class="meta">Loading replay ${id}…</div></div>`);
  const [list, info] = await Promise.all([getJson<{ replays: ReplayInfo[] }>("/api/replays?limit=100"), getJson<MatchInfo>(`/api/matches/${encodeURIComponent(id)}`)]);
  const rp = list.ok ? list.data.replays.find((r) => r.match === id) : undefined;
  if (!info.ok && !rp) return mount(root, html`<div class="wrap"><div class="pagehead"><div class="meta">Replay</div><h1>No match ${id}</h1></div><a class="btn" href="/replays">All replays</a></div>`);
  const record = rp?.record ?? (info.ok ? info.data.record : null);
  if (!record) return mount(root, html`<div class="wrap"><div class="pagehead"><div class="meta">Replay</div><h1>Not finished yet</h1></div><a class="btn" href="/watch/${id}">Watch it live</a></div>`);
  const ids: Identity[] = rp ? rp.identities.map((x, i) => cleanIdentity(x, i)) : [];
  const names = rp?.names ?? (info.ok ? info.data.seats.map((s) => s.fighter ?? "?") : []);
  const labels = rp?.labels ?? (info.ok ? info.data.seats.map((s) => s.label ?? "house") : []);
  const w = rp?.winner ?? -1;
  const theme = cap(rp?.theme ?? "");
  const score = rp ? scoreline(rp.wins) : "";
  const when = rp ? new Date(rp.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
  const old = rp?.old ?? (info.ok ? !!info.data.recordOld : false);
  const link = `${location.origin}/replay/${id}`;
  const title = w >= 0 ? (score === "2–0" ? html`${names[w]} sweeps the <span class="arena" style="color:var(--yellow)">${theme || "arena"}</span>` : html`${names[w]} wins the <span class="arena" style="color:var(--yellow)">${theme || "arena"}</span>`) : html`Replay`;
  const agents = info.ok ? info.data.seats.map((s) => s.agent) : [];

  mount(
    root,
    html`<div class="wrap replay">
      <div style="min-width:0">
        <div class="stagehead"><div><div class="meta">Replay · ${when}${rp ? ` · engine v${rp.engine}` : ""}</div><h1>${title}</h1></div></div>
        <div class="stage" id="r-stage"><div class="seeking" id="r-seek" hidden>Rewinding…</div></div>
        ${
          old
            ? html`<section class="card oldcard" style="margin-top:12px"><h2>Recorded with an older engine</h2><p class="dim" style="margin:0">This match was played on engine v${rp?.engine ?? "?"}; the physics changed since, so it can't replay exactly. Here is what the record says.</p>
                <div class="lines">${rp?.rounds.map((rd, r) => html`<div class="meta" style="margin-top:6px">${r === 0 ? "Intro" : `Before round ${r + 1}`} · ${names[rd.winner] ?? "?"} won the round</div>${rd.lines.map((l, i) => (l ? html`<div style="${colorVars(ids[i]?.color)}">${ids[i] ? bot(ids[i]!, "fist", "fight", true) : ""}<span><b style="color:var(--ci)">${names[i]}</b> ${l}</span></div>` : ""))}`)}</div></section>`
            : html`<div class="scrub" id="r-scrub"><div class="ctl"><button class="play" id="r-play" type="button" aria-label="Pause">❚❚</button><div class="track" id="r-track" role="slider" aria-label="Replay position" tabindex="0"></div><span class="tm" id="r-tm"></span><div class="speed"><button type="button" data-speed="1" aria-pressed="true">1×</button><button type="button" data-speed="2" aria-pressed="false">2×</button></div></div><div class="chapters" id="r-chap"></div></div>`
        }
        <div class="lineup">${ids.map(
          (x, i) => html`<a class="lu" style="${colorVars(x.color)}" ${agents[i] ? raw(`href="/agent/${encodeURIComponent(agents[i]!)}"`) : ""}>${bot(x, rp?.weapons[i], i === w ? "win" : "fight", true)}<div><div class="n">${names[i]}</div><div class="s">${badge(labels[i])}</div></div><div class="w">${rp?.wins[i] || ""}</div></a>`,
        )}</div>
      </div>
      <aside class="rail">
        <section class="card"><h2>Share this fight</h2>
          ${rp ? html`<img class="sharecard" src="/share/${id}.svg" width="1200" height="630" alt="${w >= 0 ? `${names[w]} wins ${score}` : "Share card"}" />` : html`<div class="empty">The share card is made when the record is saved.</div>`}
          <div class="linkrow"><input id="r-link" readonly value="${link}" aria-label="Replay link" /><button class="btn small" type="button" data-copy="#r-link">Copy link</button></div>
        </section>
        <section class="card"><h2>Result</h2>${
          rp
            ? html`<table class="board"><tbody>${[0, 1, 2, 3]
                .sort((a, b) => (b === w ? 1 : a === w ? -1 : (rp.wins[b] ?? 0) - (rp.wins[a] ?? 0)))
                .map((i) => html`<tr style="${colorVars(ids[i]?.color)}"><td class="rk">${i === w ? "1" : ""}</td><td><b style="color:var(--ci);font-family:var(--display)">${names[i]}</b>${rp.control.some((c) => c.seat === i && c.mode === "autopilot") ? raw(' <span class="tag">AUTOPILOT</span>') : ""}</td><td class="v">${rp.wins[i]} round${rp.wins[i] === 1 ? "" : "s"}</td></tr>`)}</tbody></table>`
            : html`<div class="empty">No summary.</div>`
        }</section>
      </aside>
    </div>`,
  );

  let tl: Timeline | null = null;
  let speed = 1;
  let shownT = 0;
  let anchor = { t: 0, at: performance.now(), key: "" };
  const stage = new Stage($("#r-stage")!, {
    seeking: (on) => ($("#r-seek")!.hidden = !on),
    pos: (p) => {
      if (!tl) return;
      // fight ticks map exactly; between them, run a local clock so the knob moves through the talk and the round end
      const t = timeOfPos(tl, p);
      const key = p ? `${p.round}.${p.phase}.${p.phase === "fight" ? p.tick : ""}` : "";
      if (key !== anchor.key || p?.phase === "fight") anchor = { t, at: performance.now(), key };
    },
  });
  stage.record(record);
  if (old) return;

  const rep = await getJson<{ rounds: ReportRound[] }>(`/api/matches/${encodeURIComponent(id)}/report`);
  if (!rep.ok) {
    $("#r-chap")!.textContent = rep.status === 429 ? "Too many replays loaded at once; the scrubber comes back on reload." : "No timeline for this match.";
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
  mount(
    $("#r-chap"),
    html`${tl.chapters.map((c, i) => html`<button type="button" data-chap="${i}" style="${colorVars(ids[c.seat]?.color ?? null)}">${c.seat >= 0 ? html`<b>${c.label}</b>` : c.label}</button>`)}${
      tl.pins.find((p) => p.kind === "win") ? html`<button type="button" data-t="${tl.pins.find((p) => p.kind === "win")!.t}" style="${colorVars(ids[w]?.color)}"><b>${names[w]} wins</b></button>` : ""
    }`,
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
  $("#r-chap")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button");
    if (!b) return;
    if (b.dataset.chap !== undefined) {
      const c = tl!.chapters[Number(b.dataset.chap)]!;
      stage.seek(c.to);
      anchor = { t: timeOfPos(tl!, c.to), at: performance.now(), key: "seek" };
    } else if (b.dataset.t) seekTo(Number(b.dataset.t) - 2);
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
