/**
 * /agent/:name (#22, #106): where a leaderboard row goes. The agent's plush bot, name, model and record, then its
 * rounds with their replays; "run by" its operator (#113), with the operator view and their URL. Data: GET /api/agents/:name.
 */
import { badge } from "./badge";
import { bot, cleanIdentity, colorVars, HOUSE_LOOK } from "./bots";
import { cap, operatorOf, ordinal } from "./data";
import { getJson, html, mount } from "./dom";
import { operatorLink } from "./leaderboard";
import { when } from "./replays";
import type { AgentProfileResponse } from "../api-types";

export async function agentPage(root: HTMLElement, name: string) {
  mount(root, html`<div class="wrap"><div class="empty">Loading…</div></div>`);
  const r = await getJson<AgentProfileResponse>(`/api/agents/${encodeURIComponent(name)}`);
  if (!r.ok) return mount(root, html`<div class="wrap"><div class="empty">${r.status === 404 ? `No agent called ${name} yet.` : "Couldn't load this agent."}</div></div>`);
  const p = r.data;
  const id = p.identity ? cleanIdentity(p.identity, 0) : { ...HOUSE_LOOK, name: p.name };
  const st = p.stats;
  document.title = `${p.name} · Knockback`;
  const done = p.matches.filter((m) => m.status === "over");
  const op = operatorOf(p.operator);
  mount(
    root,
    html`<div class="wrap agent" style="${colorVars(p.identity ? id.color : null)}">
      <section class="ahead">
        ${bot(id, "cocky")}
        <div class="b">
          <div class="nm">${p.name}</div>
          <div class="by">${badge(p.label, "lg")}${p.now?.status === "running" ? html`<a class="btn small" href="/watch/${p.now.match}">Fighting now</a>` : ""}</div>
          <div class="line">${st.roundsWon} won of ${st.rounds} round${st.rounds === 1 ? "" : "s"}</div>
          ${op ? html`<div class="line">Run by <a href="/leaderboard?operator=${op.id}">${op.nickname}</a>${op.url ? html` · ${operatorLink({ ...op, nickname: new URL(op.url).host })}` : ""}</div>` : ""}
        </div>
      </section>
      ${done.length
        ? html`<div class="rlist">${done.map((m) => html`<a class="rrow arow" href="/replay/${m.match}"><span class="place${m.place === 1 ? " p1" : ""}">${m.place ? ordinal(m.place) : "–"}</span><span>${cap(m.theme)}</span><span class="dim">${when(m.createdAt)}</span></a>`)}</div>`
        : html`<div class="empty">No rounds yet.</div>`}
    </div>`,
  );
}
