/**
 * ModelBadge: the model behind a fighter, big and readable ("CLAUDE HAIKU", "GPT-6 LUNA (CODEX)", "GROK 4.6",
 * "HOUSE BOT"). One component for every place a fighter appears: dialogue cards, HUD chips, round end, win screen,
 * scoreboard, the lobby and the /models page (and spectator pick cards, when they adopt it).
 *
 * The badge is neutral (dark, white text) so it never fights the bot's identity colour; only the small provider
 * mark on its left is tinted. A remote agent's model is what the agent said at join: it gets a small
 * "self-reported" mark.
 *
 *   modelBadgeHtml(label | ModelInfo, "lg")      -> HTML string (values escaped)
 *   modelBadgeEl(label | ModelInfo, "sm")        -> an element built with textContent (for untrusted pages)
 *   ensureModelBadgeCss()                         -> adds MODEL_BADGE_CSS to the page once (browser only)
 *
 * Sizes follow the viewer (vh with a px floor, readable at 720p); a page can set --mb-fs on the badge instead.
 */
import { modelOf, PROVIDER_COLOR, PROVIDER_MARK, type ModelInfo } from "../stats/models";

export type ModelBadgeSize = "xs" | "sm" | "md" | "lg" | "xl";

export const MODEL_BADGE_CSS = `
.kb-mb { --mb-fs: max(1.6vh, 11px); display: inline-flex; align-items: center; gap: 0.45em; max-width: 100%; vertical-align: middle;
  font: 800 var(--mb-fs)/1.15 system-ui, -apple-system, "Segoe UI", sans-serif; letter-spacing: 0.06em; text-transform: uppercase;
  color: #f4f6fb; background: #0b0d14; border: 1px solid rgba(255, 255, 255, 0.22); border-radius: 3px; padding: 0.22em 0.5em 0.22em 0.28em;
  white-space: nowrap; box-shadow: 0 0.12em 0 rgba(0, 0, 0, 0.55); text-shadow: none; -webkit-text-stroke: 0; font-style: normal; }
.kb-mb .mk { flex: none; display: inline-grid; place-items: center; width: 1.3em; height: 1.3em; border-radius: 2px; font-size: 0.9em; font-weight: 900;
  color: #0b0d14; background: var(--mp, #b0b6c6); letter-spacing: 0; }
.kb-mb .mn { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.kb-mb .sr { flex: none; font-size: 0.58em; font-weight: 700; letter-spacing: 0.1em; color: #c7ccd8; border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 2px; padding: 0.1em 0.35em; }
.kb-mb.test { opacity: 0.75; }
.kb-mb.xs { --mb-fs: max(1.25vh, 10px); }
.kb-mb.sm { --mb-fs: max(1.6vh, 11px); }
.kb-mb.md { --mb-fs: max(2vh, 13px); }
.kb-mb.lg { --mb-fs: max(2.6vh, 16px); }
.kb-mb.xl { --mb-fs: max(3.4vh, 20px); }
`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const info = (m: ModelInfo | string | null | undefined): ModelInfo => (m && typeof m === "object" ? m : modelOf(m ?? null));

/** The badge's text for screen readers and titles: "CLAUDE HAIKU (self-reported)". */
export function modelBadgeTitle(m: ModelInfo | string | null | undefined): string {
  const x = info(m);
  return `${x.name}${x.selfReported ? " (self-reported by the agent)" : ""}${x.agent ? ` · agent ${x.agent}` : ""}`;
}

/** The badge as HTML (every value escaped). A house bot gets none: its name and color are enough. */
export function modelBadgeHtml(m: ModelInfo | string | null | undefined, size: ModelBadgeSize = "sm"): string {
  const x = info(m);
  if (x.provider === "house") return "";
  const cls = `kb-mb ${size}${x.test ? " test" : ""}`;
  return `<span class="${cls}" data-provider="${esc(x.provider)}" title="${esc(modelBadgeTitle(x))}" style="--mp:${PROVIDER_COLOR[x.provider]}"><i class="mk" aria-hidden="true">${PROVIDER_MARK[x.provider]}</i><b class="mn">${esc(x.name)}</b>${x.selfReported ? `<em class="sr">SELF-REPORTED</em>` : ""}</span>`;
}

/** The badge as an element built with textContent (for pages that never use innerHTML on data). */
export function modelBadgeEl(m: ModelInfo | string | null | undefined, size: ModelBadgeSize = "sm", doc: Document = document): HTMLElement {
  const x = info(m);
  const root = doc.createElement("span");
  if (x.provider === "house") {
    root.hidden = true; // a house bot gets no badge
    return root;
  }
  root.className = `kb-mb ${size}${x.test ? " test" : ""}`;
  root.dataset.provider = x.provider;
  root.title = modelBadgeTitle(x);
  root.style.setProperty("--mp", PROVIDER_COLOR[x.provider]);
  const mk = doc.createElement("i");
  mk.className = "mk";
  mk.setAttribute("aria-hidden", "true");
  mk.textContent = PROVIDER_MARK[x.provider];
  const mn = doc.createElement("b");
  mn.className = "mn";
  mn.textContent = x.name;
  root.append(mk, mn);
  if (x.selfReported) {
    const sr = doc.createElement("em");
    sr.className = "sr";
    sr.textContent = "SELF-REPORTED";
    root.append(sr);
  }
  return root;
}

/** Add the badge styles to the page once (browser only). */
export function ensureModelBadgeCss(doc: Document | undefined = typeof document === "undefined" ? undefined : document) {
  if (!doc || doc.getElementById("kb-model-badge-css")) return;
  const st = doc.createElement("style");
  st.id = "kb-model-badge-css";
  st.textContent = MODEL_BADGE_CSS;
  doc.head.appendChild(st);
}
