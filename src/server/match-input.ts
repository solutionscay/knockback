/**
 * What the match server accepts from a request body (#20, #19, #35): the join (name, model, soul, look, seat, line)
 * and the create call, and the per-address caps the HTTP API enforces.
 */
import { cleanLine } from "../ai/parse";
import type { IdentityWish } from "../sim/identity";
import { EYES, luminance, MAJOR_MARKS, MIN_LUMINANCE, MINOR_MARKS, SHAPES, validName } from "../sim/identity";
import { parseSoul } from "../sim/soul";
import { MODEL_RE } from "../stats/models";
import { HttpError } from "./limits";
import type { CreateMatch } from "./match-server";
import { cleanSoul, MAX_SOUL, MIN_SOUL } from "./soul-guard";

export const MAX_WAIT_S = 30;
/** per address: seats held in open or running matches, and open or running matches created over HTTP */
export const SEATS_PER_IP = 8;
export const MATCHES_PER_IP = 2;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,23}$/;
const LOOK_KEYS = ["name", "shape", "eyes", "mark", "minor", "color"] as const;
const JOIN_KEYS = ["name", "model", "soul", "look", "seat", "line"];

/** Validate a join body: name, model, soul (soul.md: personal data stripped), optional look wishes, seat and line. */
export function checkJoin(body: Record<string, unknown>): { name: string; soul: string; look: IdentityWish | null; model: string; seat?: number; soulId: string; warnings: string[]; line: string | null } {
  const problems: string[] = [];
  const extra = Object.keys(body).filter((k) => !JOIN_KEYS.includes(k));
  if (extra.length) problems.push(`unknown fields: ${extra.join(", ")} (allowed: ${JOIN_KEYS.join(", ")})`);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!NAME_RE.test(name)) problems.push("name: 1-24 characters: letters, digits, space, _ . - (starting with a letter or digit)");
  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!MODEL_RE.test(model)) problems.push("model: the model you run, as you would name it (1-40 characters: letters, digits, space . _ : + ( ) / -), e.g. claude-opus-5-5");
  const cleaned = typeof body.soul === "string" ? cleanSoul(body.soul) : null;
  if (!cleaned || cleaned.soul.length < MIN_SOUL) problems.push(`soul: your fighter's soul.md, ${MIN_SOUL}-${MAX_SOUL} characters about the fighter (attitude, voice, what it goes for), not about a person${cleaned?.removed.length ? ` (after removing ${cleaned.removed.join(", ")})` : ""}`);
  const look = body.look === undefined ? null : (checkLook(body.look, problems) ?? null);
  const seat = body.seat;
  if (seat !== undefined && !(Number.isInteger(seat) && (seat as number) >= 0 && (seat as number) <= 3)) problems.push("seat: 0-3");
  // the opening line (#35): shown on spectators' pick cards before the match; validated like a plan's line
  const line = body.line === undefined ? null : typeof body.line === "string" && body.line.length <= 400 ? cleanLine(body.line) : null;
  if (body.line !== undefined && !line) problems.push("line: one short in-character sentence (a non-empty string, at most 400 characters; kept to 120)");
  if (problems.length) throw new HttpError(400, "invalid join", problems);
  const soulId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
  const soul = cleaned!.soul;
  const parsed = parseSoul(soul, 0, soulId);
  if (parsed.errors.length) throw new HttpError(422, "invalid soul", parsed.errors);
  const removed = cleaned!.removed.length ? [`soul: removed ${cleaned!.removed.join(", ")} (soul.md is about the fighter, not a person)`] : [];
  return { name, soul, look, model, soulId, warnings: [...removed, ...parsed.warnings, ...lookWarnings(look)], line, ...(seat !== undefined ? { seat: seat as number } : {}) };
}

/** Look wishes that cannot be kept as given (#19): they fall back to the seeded draw. Not errors: a warning each. */
export function lookWarnings(look: IdentityWish | null): string[] {
  if (!look) return [];
  const out: string[] = [];
  const known: Record<string, readonly string[]> = { shape: SHAPES, eyes: EYES, mark: MAJOR_MARKS, minor: [...MINOR_MARKS, "none"] };
  for (const [k, list] of Object.entries(known)) {
    const v = look[k as keyof IdentityWish];
    if (v !== undefined && !list.includes(String(v).toLowerCase())) out.push(`look.${k}: unknown "${String(v)}": a random one is used (GET /api/looks lists the options)`);
    else if (v !== undefined) (look as Record<string, unknown>)[k] = String(v).toLowerCase();
  }
  if (look.name !== undefined && !validName(typeof look.name === "string" ? look.name.trim() : look.name)) out.push(`look.name: "${String(look.name)}" breaks the name rules (2-12 letters, digits, space or dash, starting with a letter; not a plan, shape or mark word): a random name is used`);
  if (typeof look.color === "number" && luminance(look.color) < MIN_LUMINANCE) out.push("look.color: too dark for the arenas: the nearest readable color is used, or a random one");
  return out;
}

function checkLook(v: unknown, problems: string[]): IdentityWish | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return void problems.push("look: an object with any of name, shape, eyes, mark, minor, color");
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (!(LOOK_KEYS as readonly string[]).includes(k)) problems.push(`look.${k}: unknown (allowed: ${LOOK_KEYS.join(", ")})`);
    else if (k === "color") {
      const c = typeof x === "string" && /^#?[0-9a-f]{6}$/i.test(x) ? parseInt(x.replace("#", ""), 16) : x;
      if (!Number.isInteger(c) || (c as number) < 0 || (c as number) > 0xffffff) problems.push("look.color: #rrggbb or an integer 0-16777215");
      else out.color = c;
    } else if (typeof x !== "string" || x.length > 24) problems.push(`look.${k}: a string of at most 24 characters`);
    else out[k] = x;
  }
  return out as IdentityWish;
}

export function checkCreate(b: Record<string, unknown>): CreateMatch {
  const problems: string[] = [];
  const extra = Object.keys(b).filter((k) => !["seats", "seed", "deadlineSec", "fillAfterSec", "ruleset"].includes(k));
  if (extra.length) problems.push(`unknown fields: ${extra.join(", ")}`);
  const c: CreateMatch = { ruleset: b.ruleset };
  if (b.seats !== undefined) {
    if (!Array.isArray(b.seats) || b.seats.length !== 4 || !b.seats.every((s) => s === "remote" || s === "house")) problems.push('seats: 4 of "remote" or "house"');
    else if (!b.seats.includes("remote")) problems.push("seats: at least one remote seat");
    else c.seats = b.seats as string[];
  }
  if (b.seed !== undefined) {
    if (!Number.isInteger(b.seed) || (b.seed as number) < 0 || (b.seed as number) > 0xffffffff) problems.push("seed: an integer 0-4294967295");
    else c.seed = b.seed as number;
  }
  if (b.deadlineSec !== undefined) {
    if (typeof b.deadlineSec !== "number" || b.deadlineSec < 2 || b.deadlineSec > 120) problems.push("deadlineSec: 2-120");
    else c.deadlineMs = Math.round(b.deadlineSec * 1000);
  }
  if (b.fillAfterSec !== undefined) {
    if (typeof b.fillAfterSec !== "number" || b.fillAfterSec < 0 || b.fillAfterSec > 300) problems.push("fillAfterSec: 0-300");
    else c.fillAfterMs = Math.round(b.fillAfterSec * 1000);
  }
  if (problems.length) throw new HttpError(400, "invalid match", problems);
  return c;
}
