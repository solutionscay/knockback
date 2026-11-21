/**
 * Spectator SSE: shared match history, bounded queues for individual viewers.
 *
 * The Arena (#64) has one stream that never ends: each round's match stream mirrors into it, and it restarts its
 * history at every round (reset), so a viewer that connects late gets the current round from its start.
 */
const enc = new TextEncoder();
const PING = enc.encode(": ping\n\n");
type Client = { controller: ReadableStreamDefaultController<Uint8Array>; next: number };

export class LiveStream {
  private history: Uint8Array[] = [];
  private clients = new Set<Client>();
  private pinger: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  /** every message broadcast here also goes to this stream (a round's match stream -> the Arena stream) */
  mirror: LiveStream | null = null;

  constructor(
    readonly maxClients = 64,
    readonly pingMs = 15_000,
    /** Queued bytes per viewer; slow viewers disconnect and can reconnect. */
    readonly maxQueuedBytes = 256 * 1024,
  ) {}

  private remove(client: Client) {
    this.clients.delete(client);
    if (!this.clients.size) {
      clearInterval(this.pinger);
      this.pinger = undefined;
    }
  }

  private drop(client: Client) {
    client.controller.error(new Error("spectator is too slow; reconnect"));
    this.remove(client);
  }

  /** Replay history on demand, so a late viewer need not queue the entire match. */
  private pump(client: Client) {
    while (client.next < this.history.length) {
      const chunk = this.history[client.next]!;
      if (chunk.byteLength > this.maxQueuedBytes) return this.drop(client);
      if ((client.controller.desiredSize ?? 0) < chunk.byteLength) return;
      // advance first: with a read waiting, enqueue() can call pull() (this pump) again before it returns
      client.next++;
      client.controller.enqueue(chunk);
    }
  }

  private ping() {
    for (const client of this.clients) {
      if ((client.controller.desiredSize ?? 0) < PING.byteLength) this.drop(client);
      else client.controller.enqueue(PING);
    }
  }

  get size(): number {
    return this.clients.size;
  }

  broadcast(msg: unknown) {
    this.mirror?.broadcast(msg);
    if (this.closed) return;
    this.history.push(enc.encode(`data: ${JSON.stringify(msg)}\n\n`));
    for (const client of this.clients) {
      this.pump(client);
      if (this.clients.has(client) && client.next < this.history.length) this.drop(client);
    }
  }

  /** Start the history again (a new Arena round): connected viewers stay and get what comes next. */
  reset() {
    this.history = [];
    for (const client of this.clients) client.next = 0;
  }

  response(): Response {
    if (this.closed) return new Response("stream closed", { status: 503 });
    if (this.clients.size >= this.maxClients) return new Response("too many spectators", { status: 503 });
    let client: Client;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        client = { controller, next: 0 };
        this.clients.add(client);
        this.pump(client);
        if (this.clients.has(client) && !this.pinger && this.pingMs > 0) this.pinger = setInterval(() => this.ping(), this.pingMs);
      },
      pull: () => this.pump(client),
      cancel: () => this.remove(client),
    }, { highWaterMark: this.maxQueuedBytes, size: (chunk) => chunk?.byteLength ?? 0 });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
  }

  close() {
    this.closed = true;
    for (const client of this.clients) client.controller.close();
    this.clients.clear();
    clearInterval(this.pinger);
    this.pinger = undefined;
  }
}
