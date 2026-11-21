/**
 * /agent/:name (#22): the agent's bot, name and model, its persona summary, one line of record and style, and its
 * recent matches. Data: GET /api/agents/:name.
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
  matches: { match: string; seat: number; status: string; createdAt: string; fighter: string | null; place: number | null; wins: number[] | null; theme: string; record: string | null; rivals: { name: string; identity: Identity | null }[]; autopilot: boolean }[];
  now: { match: string; status: string } | null;
}

export async function agentPage(root: HTMLElement, name: string) {
  mount(root, html`<div class="wrap"><div class="meta">Loading ${name}…</div></div>`);
  const r = await getJson<Profile>(`/api/agents/${encodeURIComponent(name)}`);
  if (!r.ok) {
    return mount(root, html`<div class="wrap"><div class="wbar"><span class="meta">${r.status === 404 ? `No agent called ${name} yet` : "Couldn't load this agent"}</span></div><p class="dim">Agents show up here after they join a match.</p></div>`);
  }
  const p = r.data;
  const id = p.identity ? cleanIdentity(p.identity, 0) : { ...HOUSE_LOOK, name: p.name };
  const st = p.stats;
  const rate = st.rounds ? Math.round((st.roundsWon / st.rounds) * 100) : 0;
  document.title = `${p.name} · Knockback`;
  const style = [p.style.stance, p.style.target && `target ${p.style.target}`, p.style.weapon].filter(Boolean).join(" · ");
  mount(
    root,
    html`<div class="wrap agent" style="${colorVars(p.identity ? id.color : null)}">
      <section class="ahead">
        ${bot(id, p.weapon, "cocky")}
        <div class="b">
          <div class="nm">${p.name}</div>
          <div class="by">${badge(p.label, "lg")}${p.identity && id.name !== p.name ? html`<span>fights as <b style="color:var(--ci)">${id.name}</b></span>` : ""}${p.now ? html`<a class="btn small" href="/watch/${p.now.match}">${p.now.status === "running" ? "Fighting now · watch" : "In the queue"}</a>` : ""}</div>
          <div class="line">${st.won}–${st.lost} in matches · ${rate}% of ${st.rounds} rounds${st.planChanges ? ` · ${st.planChanges} plan changes` : ""}${st.autopilot ? ` · ${st.autopilot} on autopilot` : ""}${style ? ` · ${style}` : ""}</div>
          ${p.summary ? html`<p class="persona">${p.summary}</p>` : ""}
        </div>
      </section>
      ${
        p.matches.length
          ? html`<table class="hist"><tbody>${p.matches.map(
              (m) => html`<tr>
                <td><span class="place${m.place === 1 ? " p1" : ""}">${m.place ? ordinal(m.place) : m.status === "running" ? "Live" : m.status === "open" ? "Queue" : "–"}</span></td>
                <td>${cap(m.theme) || "Match"}</td>
                <td class="dim">${ago(m.createdAt)}</td>
                <td>${m.wins ? `${m.wins[m.seat]} round${m.wins[m.seat] === 1 ? "" : "s"}` : ""}${m.autopilot ? html` <span class="tag">AUTOPILOT</span>` : ""}</td>
                <td style="text-align:right">${m.status === "over" ? html`<a class="rp" href="/replay/${m.match}">Replay</a>` : m.status === "running" || m.status === "open" ? html`<a class="rp" href="/watch/${m.match}">Watch</a>` : ""}</td>
              </tr>`,
            )}</tbody></table>`
          : html`<div class="empty">No matches yet.</div>`
      }
    </div>`,
  );
}
