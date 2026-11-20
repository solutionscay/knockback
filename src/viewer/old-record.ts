/**
 * The card for a record made by another engine version: it can't replay on the current physics, so instead of a
 * replay that diverges the viewer shows what the record says without any simulation: line-up, result and lines.
 * Built with textContent only (record text is untrusted); its styles live here so the card stays in its own file.
 */
import { ENGINE_VERSION, type RecordSummary } from "../sim/engine-version";

const CSS = `
#old-record { position: absolute; inset: 0; display: flex; padding: 3vh; z-index: 5; overflow: auto; }
#old-record .card { margin: auto; /* centered, and scrolls from the top when taller than the screen */ max-width: min(96vw, 120vh); background: rgba(11, 13, 20, 0.94); border: 0.3vh solid #ffb347; border-radius: 2vh; padding: 3vh 3.6vh; box-shadow: 0 1.6vh 0 #07080d; }
#old-record h1 { margin: 0; font-size: max(3.2vh, 20px); color: #ffd27a; letter-spacing: 0.02em; }
#old-record .why { margin: 0.8vh 0 2.4vh; font-size: max(1.9vh, 13px); color: #e6e9f2; opacity: 0.85; font-weight: 600; }
#old-record .meta { font-size: max(1.5vh, 11px); letter-spacing: 0.18em; text-transform: uppercase; opacity: 0.6; margin-bottom: 1vh; }
#old-record .seats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1.2vh; margin-bottom: 2.2vh; }
@media (max-aspect-ratio: 1/1) { #old-record .seats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
#old-record .nm, #old-record .lb { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#old-record .seat { border: 0.25vh solid var(--c); border-radius: 1.2vh; padding: 1vh 1.4vh; background: rgba(7, 8, 13, 0.6); }
#old-record .seat.won { box-shadow: 0 0 0 0.3vh #ffd27a; }
#old-record .nm { color: var(--c); font-size: max(2.2vh, 15px); }
#old-record .lb { font-size: max(1.4vh, 11px); opacity: 0.7; }
#old-record .w { font-size: max(1.5vh, 11px); color: #ffd27a; margin-top: 0.4vh; }
#old-record .round { margin: 1.4vh 0 0.6vh; font-size: max(1.5vh, 11px); letter-spacing: 0.18em; text-transform: uppercase; opacity: 0.6; }
#old-record .line { font-size: max(1.8vh, 13px); font-weight: 600; margin: 0.4vh 0; color: #e6e9f2; }
#old-record .line b { color: var(--c); margin-right: 0.8vh; }
#old-record .hint { margin-top: 2.2vh; font-size: max(1.4vh, 11px); opacity: 0.6; font-weight: 600; }
`;

const hex = (c: number | null) => (c === null ? "#9aa0aa" : `#${c.toString(16).padStart(6, "0")}`);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Show the card (replaces any earlier one). Returns the element, for tests and screenshots. */
export function showOldRecord(s: RecordSummary, parent: HTMLElement = document.body): HTMLElement {
  document.getElementById("old-record")?.remove();
  if (!document.getElementById("old-record-css")) {
    const st = document.createElement("style");
    st.id = "old-record-css";
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  const root = el("div", "");
  root.id = "old-record";
  const card = el("div", "card");
  const older = s.engine < ENGINE_VERSION;
  card.append(
    el("h1", "", `Recorded with ${older ? "an older" : "another"} engine (v${s.engine}).`),
    el("div", "why", "This replay can't be shown on the current physics."),
    el("div", "meta", `seed ${s.seed} · engine v${s.engine} · this viewer v${ENGINE_VERSION}`),
  );
  const seats = el("div", "seats");
  s.names.forEach((name, i) => {
    const d = el("div", `seat${i === s.winner ? " won" : ""}`);
    d.style.setProperty("--c", hex(s.colors[i] ?? null));
    d.append(el("div", "nm", name));
    if (s.labels[i]) d.append(el("div", "lb", s.labels[i]!));
    d.append(el("div", "w", i === s.winner ? `WINNER · ${s.wins[i]} round${s.wins[i] === 1 ? "" : "s"}` : `${s.wins[i]} round${s.wins[i] === 1 ? "" : "s"}`));
    seats.append(d);
  });
  card.append(seats);
  s.rounds.forEach((r, ri) => {
    if (!r.lines.some(Boolean)) return;
    card.append(el("div", "round", `Before round ${ri + 1}${r.winner >= 0 ? ` · won by ${s.names[r.winner]}` : ""}`));
    r.lines.forEach((line, i) => {
      if (!line) return;
      const p = el("div", "line");
      p.style.setProperty("--c", hex(s.colors[i] ?? null));
      p.append(el("b", "", s.names[i]!), document.createTextNode(`“${line}”`));
      card.append(p);
    });
  });
  card.append(el("div", "hint", s.engine === 0 ? "To watch it, replay it from the Knockback commit that made it (from before engine versions)." : `To watch it, replay it from a Knockback commit with ENGINE_VERSION = ${s.engine}.`));
  root.append(card);
  parent.append(root);
  return root;
}
