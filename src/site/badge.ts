/**
 * The model badge on the site pages: the model spotlight's shared ModelBadge (src/viewer/model-badge.ts), so a
 * fighter's model reads the same in the viewer, the lobby, replays and the share card.
 */
import type { ModelInfo } from "../stats/models";
import { ensureModelBadgeCss, modelBadgeHtml } from "../viewer/model-badge";
import { raw, type Raw } from "./dom";

ensureModelBadgeCss();

export function badge(m: string | ModelInfo | null | undefined, size: "sm" | "lg" = "sm"): Raw {
  return raw(modelBadgeHtml(m, size === "lg" ? "md" : "xs"));
}
