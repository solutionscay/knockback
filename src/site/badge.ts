/**
 * Model badge, minimal local version. The model spotlight branch (feat/model-spotlight) adds the shared
 * ModelBadge (src/viewer/model-badge.ts) and GET /api/models.
 * TODO(model-spotlight): once merged, replace this file's body with modelBadgeHtml(label, size).
 */
import { modelOf } from "./data";
import { html, type Raw } from "./dom";

const COLOR = { anthropic: "#e0896a", openai: "#5fd0a8", xai: "#c9ced9", house: "#ffd23f", other: "#b0b6c6" } as const;

export function badge(label: string | null | undefined, size: "sm" | "lg" = "sm"): Raw {
  const m = modelOf(label);
  const cls = `mb ${size}${m.provider === "house" ? " house" : ""}${m.name === "MODEL NOT REPORTED" ? " unreported" : ""}`;
  return html`<span class="${cls}" style="--mp:${COLOR[m.provider]}" title="${m.agent ? `agent ${m.agent} · ` : ""}${m.name}"><i aria-hidden="true"></i>${m.name}</span>`;
}

/** A badge for a model name that is already display text ("CLAUDE HAIKU", from GET /api/models or a board row). */
export function nameBadge(name: string): Raw {
  const provider = name === "HOUSE BOT" ? "house" : /CLAUDE|HAIKU|SONNET|OPUS|FABLE/.test(name) ? "anthropic" : /GPT|CODEX/.test(name) ? "openai" : /GROK/.test(name) ? "xai" : "other";
  return html`<span class="mb sm${provider === "house" ? " house" : ""}" style="--mp:${COLOR[provider]}"><i aria-hidden="true"></i>${name}</span>`;
}
