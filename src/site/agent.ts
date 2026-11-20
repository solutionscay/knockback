/**
 * /agent/:name (#22): the agent's bot ID card with its mood strip (fighting, won, K.O., autopilot), its persona
 * summary and newest line, its record, how it fights, and its recent matches. Data: GET /api/agents/:name.
 */
import { badge } from "./badge";
import { bot, cleanIdentity, colorVars, HOUSE_LOOK } from "./bots";
import { ago, cap, ordinal } from "./data";
import { getJson, html, mount } from "./dom";
import type { Identity } from "../sim/identity";

interface Profile {
  name: string;
  identity: Identity | null;
  weapon: string;
  label: string;
  summary: string;
  catchphrase: string;
  signature: string;
  stats: { matches: number; won: number; lost: number; rounds: number; roundsWon: number; planChanges: number; autopilot: number };
  style: { stance: string | null; target: string | null; weapon: string | null };
  matches: { match: string; seat: number; status: string; createdAt: string; fighter: string | null; place: number | null; wins: number[] | null; theme: string; record: string | null; old: boolean; rivals: { name: string; identity: Identity | null }[]; autopilot: boolean }[];
  now: { match: string; status: string } | null;
}

export async function agentPage(root: HTMLElement, name: string) {
  mount(root, html`<div class="wrap"><div class="meta">Loading ${name}…</div></div>`);
  const r = await getJson<Profile>(`/api/agents/${encodeURIComponent(name)}`);
  if (!r.ok) {
    return mount(root, html`<div class="wrap"><div class="pagehead"><div class="meta">Agent</div><h1>${r.status === 404 ? `No agent called ${name} yet` : "Couldn't load this agent"}</h1></div><p class="dim">Agents show up here after they join a match.</p><button class="btn" type="button" data-join>Bring yours</button></div>`);
  }
  const p = r.data;
  const id = p.identity ? cleanIdentity(p.identity, 0) : { ...HOUSE_LOOK, name: p.name };
  const st = p.stats;
  const rate = st.rounds ? Math.round((st.roundsWon / st.rounds) * 100) : 0;
  document.title = `${p.name} · Knockback`;
  mount(
    root,
    html`<div class="wrap agent" style="${colorVars(p.identity ? id.color : null)}">
      <section class="idcard">
        <div class="art">${bot(id, p.weapon, "cocky")}</div>
        <div class="b">
          <div class="nm">${p.name}</div>
          <div class="by">${badge(p.label, "lg")}${p.identity && id.name !== p.name ? html`<span>fights as <b style="color:var(--ci)">${id.name}</b></span>` : ""}</div>
          <div class="moods">
            <figure>${bot(id, p.weapon, "fight")}<figcaption>fighting</figcaption></figure>
            <figure>${bot(id, p.weapon, "win")}<figcaption>won</figcaption></figure>
            <figure>${bot(id, p.weapon, "ko")}<figcaption>K.O.</figcaption></figure>
            <figure>${bot(id, p.weapon, "sleepy")}<figcaption>autopilot</figcaption></figure>
          </div>
        </div>
      </section>
      <div style="min-width:0">
        ${p.now ? html`<div class="nowbar"><span>${p.name} is ${p.now.status === "running" ? "fighting now" : "in the queue"}</span><a class="btn small" href="/watch/${p.now.match}">${p.now.status === "running" ? "Watch" : "See the match"}</a></div>` : ""}
        ${p.summary ? html`<p class="persona">${p.summary}</p>` : ""}
        ${p.signature ? html`<p class="persona-q">“${p.signature}”</p>` : ""}
        <div class="stats">
          <div class="stat"><div class="v">${st.won}–${st.lost}</div><div class="k">matches won–lost</div></div>
          <div class="stat"><div class="v">${rate}%</div><div class="k">round win rate · ${st.roundsWon} of ${st.rounds}</div></div>
          <div class="stat"><div class="v">${st.planChanges}</div><div class="k">mid-round plan changes${st.autopilot ? ` · ${st.autopilot} on autopilot` : ""}</div></div>
        </div>
        ${
          p.style.stance || p.style.target || p.style.weapon
            ? html`<section class="card" style="margin-bottom:18px"><h2>How it fights</h2><div class="weap">${p.style.stance ? html`<span>stance <b>${p.style.stance}</b></span>` : ""}${p.style.target ? html`<span>target <b>${p.style.target}</b></span>` : ""}${p.style.weapon ? html`<span>weapon <b>${p.style.weapon}</b></span>` : ""}</div></section>`
            : ""
        }
        <section class="card"><h2>Recent matches</h2>${
          p.matches.length
            ? html`<table class="hist"><tbody>${p.matches.map(
                (m) => html`<tr>
                  <td><span class="place${m.place === 1 ? " p1" : ""}">${m.place ? ordinal(m.place) : m.status === "running" ? "Live" : m.status === "open" ? "Queue" : "–"}</span></td>
                  <td>${cap(m.theme) || "Match"}<div class="dim">${ago(m.createdAt)}</div></td>
                  <td class="heads hide-s">${m.rivals.map((x, i) => (x.identity ? bot(cleanIdentity(x.identity, i), "fist", "fight", true) : ""))}</td>
                  <td>${m.wins ? `${m.wins[m.seat]} round${m.wins[m.seat] === 1 ? "" : "s"}` : ""}${m.autopilot ? html` <span class="tag">AUTOPILOT</span>` : ""}</td>
                  <td style="text-align:right">${m.status === "over" ? html`<a class="rp${m.old ? " old" : ""}" href="/replay/${m.match}">${m.old ? "Summary" : "Replay"}</a>` : m.status === "running" || m.status === "open" ? html`<a class="rp" href="/watch/${m.match}">Watch</a>` : ""}</td>
                </tr>`,
              )}</tbody></table>`
            : html`<div class="empty">No matches yet.</div>`
        }</section>
      </div>
    </div>`,
  );
}
