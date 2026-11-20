/**
 * Server-sent events for spectators: every message is kept, so a viewer
 * that connects late catches up from the start of the match.
 */
const enc = new TextEncoder();

export class LiveStream {
  private history: Uint8Array[] = [];
  private clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  /** cap on concurrent spectators of one stream */
  constructor(readonly maxClients = 64) {}

  get size(): number {
    return this.clients.size;
  }

  broadcast(msg: unknown) {
    const chunk = enc.encode(`data: ${JSON.stringify(msg)}\n\n`);
    this.history.push(chunk);
    for (const c of this.clients) {
      try {
        c.enqueue(chunk);
      } catch {
        this.clients.delete(c);
      }
    }
  }

  /** A text/event-stream response that replays the history, then follows. */
  response(): Response {
    if (this.clients.size >= this.maxClients) return new Response("too many spectators", { status: 503 });
    let ctl: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        ctl = c;
        for (const h of this.history) c.enqueue(h);
        this.clients.add(c);
      },
      cancel: () => {
        this.clients.delete(ctl);
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
  }

  close() {
    for (const c of this.clients) {
      try {
        c.close();
      } catch {
        /* already closed */
      }
    }
    this.clients.clear();
  }
}
