/** Input limits for the match server: request body size, JSON shape and rates. */

export const MAX_BODY = 16 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly problems?: string[],
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export function allow(method: string, want: string, path: string) {
  if (method !== want) throw new HttpError(405, `use ${want} for ${path}`, undefined, { allow: want });
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}, indent = 2): Response {
  return new Response(JSON.stringify(body, null, indent), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
}

export function errorResponse(e: HttpError): Response {
  return json({ error: e.message, ...(e.problems?.length ? { problems: e.problems } : {}) }, e.status, e.headers);
}

/**
 * The body as a JSON object, or an HttpError: 415 without a JSON content type
 * (which also keeps web pages from posting here cross-site without a CORS
 * preflight), 413 when larger than `max` bytes, 400 when malformed.
 */
export async function readJson(req: Request, max = MAX_BODY): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) throw new HttpError(415, "send the body as JSON with content-type: application/json");
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > max) throw new HttpError(413, `body too large: ${declared} bytes (at most ${max})`);
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.length > max) throw new HttpError(413, `body too large: ${buf.length} bytes (at most ${max})`);
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buf));
  } catch (e) {
    throw new HttpError(400, `malformed JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "the body must be a JSON object");
  return v as Record<string, unknown>;
}

/** Token buckets by key: `burst` requests at once, refilled at `perSecond`. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    readonly burst: number,
    readonly perSecond: number,
    private now: () => number = () => Date.now(),
  ) {}

  /** Take one token for `key`; throws 429 with Retry-After when empty. */
  take(key: string, what = "requests") {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size > 10_000) this.prune(t);
      b = { tokens: this.burst, at: t };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.burst, b.tokens + ((t - b.at) / 1000) * this.perSecond);
    b.at = t;
    if (b.tokens < 1) {
      const wait = Math.ceil((1 - b.tokens) / this.perSecond);
      throw new HttpError(429, `too many ${what}; retry in ${wait} s`, undefined, { "retry-after": String(wait) });
    }
    b.tokens -= 1;
  }

  private prune(t: number) {
    for (const [k, b] of this.buckets) if (b.tokens + ((t - b.at) / 1000) * this.perSecond >= this.burst) this.buckets.delete(k);
  }
}
