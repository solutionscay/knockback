/**
 * Owner keys: the person behind an agent enters an owner handle on the JOIN panel and gets an MCP key. Every agent
 * that joins with that key belongs to that owner; an agent name stays bound to its owner, so the same owner's agent
 * keeps its name and stats across sessions. No key, no join. No accounts or passwords (that is #23).
 *
 *   POST   /api/keys { owner }   a new owner handle and its key (the handle is claimed by the first key)
 *   GET    /api/keys/me          (Authorization: Bearer <key>) the key's owner and its agents
 *   DELETE /api/keys/me          (Authorization: Bearer <key>) revoke the key
 *
 * The operator lists owners and revokes or reissues keys with `bun run keys` (scripts/keys.ts).
 * Only the key's sha256 is stored.
 */
import { createHash, randomBytes } from "node:crypto";
import { HttpError } from "./limits";
import type { MatchStore } from "./store";

export const KEY_PREFIX = "kbk_";
const KEY_RE = /^kbk_[0-9a-f]{32}$/;
/** Owner handles follow the agent name rules. */
export const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,23}$/;
export const OWNER_RULES = "1-24 characters: letters, digits, space, _ . - (starting with a letter or digit)";

export const newKey = () => `${KEY_PREFIX}${randomBytes(16).toString("hex")}`;
export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

/**
 * The owner key a request carries: `Authorization: Bearer kbk_...` only (null when there is none). A key in the URL
 * (`?key=`) is ignored: URLs end up in logs, proxies and shell history.
 */
export function keyOf(req: Request): string | null {
  const k = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  return k && KEY_RE.test(k) ? k : null;
}

/** The owner behind a key; throws 401 with where to get one. */
export async function ownerOf(store: MatchStore, key: string | null, where = "the JOIN panel (/lobby#join)"): Promise<string> {
  if (!key) throw new HttpError(401, `an owner key is needed: get one on ${where} and send it as Authorization: Bearer <key>`);
  const owner = await store.ownerOfKey(hashKey(key));
  if (!owner) throw new HttpError(401, `this owner key is unknown or revoked: get a new one on ${where}`);
  return owner;
}

/** Bind an agent name to its owner (first come); 409 when the name belongs to another owner. */
export async function claimName(store: MatchStore, name: string, owner: string): Promise<void> {
  const bound = await store.claimAgent(name, owner);
  if (bound.toLowerCase() !== owner.toLowerCase()) throw new HttpError(409, `the agent name ${name} belongs to another owner: pick another name`);
}

export function checkOwnerHandle(v: unknown): string {
  const h = typeof v === "string" ? v.trim() : "";
  if (!OWNER_RE.test(h)) throw new HttpError(400, `owner: ${OWNER_RULES}`);
  return h;
}
