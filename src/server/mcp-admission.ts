import { HttpError } from "./limits";

/** Bounds HTTP requests, including SSE response lifetimes, before MCP dispatch. */
export class McpAdmission {
  private active = 0;
  private ips = new Map<string, number>();
  private sessions = new Map<string, number>();

  constructor(readonly max = 256, readonly perIp = 16, readonly perSession = 4) {}

  async run(req: Request, ip: string, dispatch: () => Promise<Response>): Promise<Response> {
    if (req.signal.aborted) throw new HttpError(499, "request aborted");
    const sid = req.headers.get("mcp-session-id");
    if ((this.ips.get(ip) ?? 0) >= this.perIp || (sid && (this.sessions.get(sid) ?? 0) >= this.perSession))
      throw new HttpError(429, "too many MCP requests in flight; try later", undefined, { "retry-after": "1" });
    if (this.active >= this.max) throw new HttpError(503, "MCP request capacity reached; try later", undefined, { "retry-after": "1" });
    const bump = (map: Map<string, number>, key: string, delta: number) => {
      const n = (map.get(key) ?? 0) + delta;
      if (n) map.set(key, n);
      else map.delete(key);
    };
    this.active++;
    bump(this.ips, ip, 1);
    if (sid) bump(this.sessions, sid, 1);
    let released = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const release = () => {
      if (released) return;
      released = true;
      this.active--;
      bump(this.ips, ip, -1);
      if (sid) bump(this.sessions, sid, -1);
      req.signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      void reader?.cancel().catch(() => undefined);
      release();
    };
    req.signal.addEventListener("abort", abort, { once: true });
    try {
      const res = await dispatch();
      if (!res.body || !res.headers.get("content-type")?.includes("text/event-stream")) {
        release();
        return res;
      }
      reader = res.body.getReader();
      if (req.signal.aborted) {
        await reader.cancel();
        release();
        return new Response(null, { status: 499 });
      }
      const body = new ReadableStream<Uint8Array>({
        async pull(c) {
          try {
            const next = await reader!.read();
            if (next.done) {
              release();
              c.close();
            } else c.enqueue(next.value);
          } catch (e) {
            release();
            c.error(e);
          }
        },
        async cancel(reason) {
          try {
            await reader!.cancel(reason);
          } finally {
            release();
          }
        },
      }, { highWaterMark: 0 });
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    } catch (e) {
      release();
      throw e;
    }
  }
}
