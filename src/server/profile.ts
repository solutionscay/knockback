/**
 * Operator profiles (#113): the person behind agents gets a presence on the leaderboard, a nickname and a URL.
 *
 * The profile IS the owner (keys.ts): the owner row gets a stable id, a nickname and a URL. The operator token is the
 * owner key (a random secret shown once, only its sha256 stored), so an edit needs the key, and every agent that joins
 * with the key (MCP or HTTP) already credits that owner, and so the profile. One identity, no second token to keep in
 * step. A later login (GitHub or email) attaches to `owners.id` with a table of its own (provider, subject, owner id):
 * no change to the rows here.
 *
 *   GET   /api/keys/me    (Bearer key) the owner, its agents and its profile
 *   PATCH /api/keys/me    (Bearer key) { nickname?, url? }: set or clear (null or "") the profile fields
 *   POST  /api/keys       { owner, nickname?, url? }: a new owner may set its profile at once
 *
 * Safety: the nickname is free text from an outsider. It is shown on the site (escaped) and NEVER goes into an agent's
 * prompt, briefing or check-in (tests/operator-profiles.test.ts). It never reaches the sim or the records either.
 */
import { randomBytes } from "node:crypto";
import { HttpError } from "./limits";

/** The public face of a profile (only owners that set a nickname have one on the site). */
export interface Operator {
  id: string;
  nickname: string;
  url: string | null;
}

export const newOperatorId = () => `op_${randomBytes(8).toString("hex")}`;

export const NICKNAME_MAX = 32;
/** Letters and digits of any script, then also space, _ . ' -; no control, format (bidi) or symbol characters. */
const NICKNAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.'-]*$/u;
export const NICKNAME_RULES = `1-${NICKNAME_MAX} characters: letters, digits, space, _ . ' - (starting with a letter or digit)`;
export const URL_MAX = 200;
export const URL_RULES = `an http:// or https:// address of at most ${URL_MAX} characters, with no user name or password`;

/** A nickname as stored (NFC, trimmed, single spaces), or null to clear; 400 when it breaks the rules. */
export function checkNickname(v: unknown): string | null {
  if (v === null || v === "") return null;
  if (typeof v !== "string") throw new HttpError(400, `nickname: ${NICKNAME_RULES}`);
  const n = v.normalize("NFC").trim().replace(/ {2,}/g, " ");
  if (n === "") return null;
  if ([...n].length > NICKNAME_MAX || !NICKNAME_RE.test(n)) throw new HttpError(400, `nickname: ${NICKNAME_RULES}`);
  return n;
}

/** A URL as stored (normalized), or null to clear; 400 for anything but plain http(s) (no javascript:, data:, ...). */
export function checkUrl(v: unknown): string | null {
  if (v === null || v === "") return null;
  if (typeof v !== "string") throw new HttpError(400, `url: ${URL_RULES}`);
  const s = v.trim();
  if (s === "") return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new HttpError(400, `url: ${URL_RULES}`);
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || !u.hostname.includes(".") || u.href.length > URL_MAX) throw new HttpError(400, `url: ${URL_RULES}`);
  return u.href;
}

/** The profile fields a request body sets (undefined: leave as is). */
export function profilePatch(body: Record<string, unknown>): { nickname?: string | null; url?: string | null } {
  return {
    ...("nickname" in body ? { nickname: checkNickname(body.nickname) } : {}),
    ...("url" in body ? { url: checkUrl(body.url) } : {}),
  };
}
