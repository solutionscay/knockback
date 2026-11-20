import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rescoreRecord } from "../src/ai/run";
import { MatchServer } from "../src/server/match-server";
import { SqliteStore } from "../src/server/store";
import { ENGINE_VERSION, initPhysics, isOtherEngine, Match, OtherEngineError, recordEngine, replayMatch, summarizeRecord, type MatchRecord } from "../src/sim";
import { showOldRecord } from "../src/viewer/old-record";

beforeAll(async () => {
  await initPhysics();
});

const fresh = (seed: number): MatchRecord => {
  const m = new Match(seed);
  m.playToEnd();
  return JSON.parse(JSON.stringify(m.record));
};

/** The same record as an older engine wrote it: no engine field (version 0). */
const asOld = (rec: MatchRecord): MatchRecord => {
  const old = JSON.parse(JSON.stringify(rec));
  delete old.engine;
  return old;
};

describe("engine version", () => {
  test("new records carry this engine's version; a missing or odd field counts as version 0", () => {
    expect(ENGINE_VERSION).toBeGreaterThanOrEqual(1);
    expect(new Match(4).record.engine).toBe(ENGINE_VERSION);
    expect(recordEngine({})).toBe(0);
    expect(recordEngine({ engine: String(ENGINE_VERSION) })).toBe(0);
    expect(recordEngine({ engine: -2 })).toBe(0);
    expect(recordEngine(null)).toBe(0);
    expect(isOtherEngine({ engine: ENGINE_VERSION })).toBe(false);
    expect(isOtherEngine({})).toBe(true);
  });

  test("a current record replays to its recorded hashes", () => {
    const rec = fresh(7);
    expect(replayMatch(rec).record.rounds.map((r) => r.fight.finalHash)).toEqual(rec.rounds.map((r) => r.fight.finalHash));
    expect(() => rescoreRecord(rec, ["house", "house", "house", "house"])).not.toThrow();
  });

  test("the field is not hashed: the same match gives the same hashes whatever the record says", () => {
    const a = fresh(12);
    const b = replayMatch({ ...a, engine: ENGINE_VERSION });
    expect(b.record.rounds.map((r) => r.fight.finalHash)).toEqual(a.rounds.map((r) => r.fight.finalHash));
  });

  test("a record from another engine is refused before any simulation, with the engine named", () => {
    const old = asOld(fresh(9));
    const t0 = performance.now();
    expect(() => replayMatch(old)).toThrow(OtherEngineError);
    expect(performance.now() - t0).toBeLessThan(1000); // refused up front (a full replay takes seconds)
    expect(() => replayMatch(old)).toThrow(`engine v0; this is engine v${ENGINE_VERSION},`);
    expect(() => replayMatch({ ...old, engine: ENGINE_VERSION + 1 })).toThrow(OtherEngineError);
    expect(() => rescoreRecord(old, ["house", "house", "house", "house"])).toThrow(OtherEngineError);
  });

  test("the summary of an old record needs no simulation: line-up, result, lines", () => {
    const rec = fresh(21);
    const s = summarizeRecord({ ...asOld(rec), labels: ["claude/haiku", "codex/gpt-6-luna", "grok/grok-4.6", "house"] })!;
    expect(s.engine).toBe(0);
    expect(s.seed).toBe(21);
    expect(s.names).toEqual(rec.identities!.map((i) => i.name));
    expect(s.labels).toEqual(["claude/haiku", "codex/gpt-6-luna", "grok/grok-4.6", "house"]);
    expect(s.colors).toEqual(rec.identities!.map((i) => i.color));
    expect(s.winner).toBe(rec.winner);
    expect(s.wins).toEqual(rec.wins);
    expect(s.rounds.map((r) => r.lines)).toEqual(rec.rounds.map((r) => r.lines));
    expect(s.rounds.map((r) => r.winner)).toEqual(rec.rounds.map((r) => r.winner));
    // older schemas: names from the souls; junk is not a record
    expect(summarizeRecord({ seed: 3, rounds: [], souls: [{ name: "Old Bot" }], winner: 0, wins: [1] })!.names[0]).toBe("Old Bot");
    expect(summarizeRecord({ seed: 3 })).toBeNull();
    expect(summarizeRecord("nope")).toBeNull();
  });
});

/** Just enough DOM for the card: elements, text, classes, styles, a tree to search. */
function fakeDom() {
  class El {
    id = "";
    className = "";
    textContent = "";
    children: El[] = [];
    vars: Record<string, string> = {};
    style = { setProperty: (k: string, v: string) => (this.vars[k] = v) };
    dataset: Record<string, string> = {};
    title = "";
    attrs: Record<string, string> = {};
    setAttribute(k: string, v: string) {
      this.attrs[k] = v;
    }
    parent: El | null = null;
    constructor(readonly tag: string) {}
    append(...xs: (El | { text: string })[]) {
      for (const x of xs) if (x instanceof El) ((x.parent = this), this.children.push(x));
      else this.children.push(Object.assign(new El("#text"), { textContent: x.text }));
    }
    appendChild(x: El) {
      this.append(x);
    }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    }
    text(): string {
      return this.textContent + this.children.map((c) => c.text()).join(" ");
    }
    all(): El[] {
      return [this, ...this.children.flatMap((c) => c.all())];
    }
  }
  const head = new El("head");
  const body = new El("body");
  const doc = {
    head,
    body,
    createElement: (t: string) => new El(t),
    createTextNode: (t: string) => ({ text: t }),
    getElementById: (id: string) => [...head.all(), ...body.all()].find((e) => e.id === id) ?? null,
  };
  return { doc, body };
}

describe("old record card (viewer)", () => {
  test("shows the friendly card with line-up, winner and the lines, as plain text", () => {
    const { doc, body } = fakeDom();
    (globalThis as { document?: unknown }).document = doc;
    try {
      const rec = fresh(21);
      const evil = asOld(rec) as ReturnType<typeof asOld> & { labels?: string[] };
      evil.rounds[0]!.lines[1] = "<img src=x onerror=alert(1)> snack";
      evil.labels = ["claude/haiku", "codex/gpt-6-luna", "remote/Zap@<b>grok-4.6</b>", "house"];
      const s = summarizeRecord(evil)!;
      const card = showOldRecord(s) as unknown as { text(): string; all(): { className: string }[] };
      const text = card.text();
      expect(text).toContain("Recorded with an older engine (v0).");
      expect(text).toContain("This replay can't be shown on the current physics.");
      for (const n of s.names) expect(text).toContain(n);
      expect(text).toContain(`WINNER`);
      // model badges (model spotlight): big model names, the remote agent's own claim marked, as plain text
      expect(text).toContain("CLAUDE HAIKU");
      expect(text).toContain("GPT-6 LUNA (CODEX)");
      expect(text).toContain("HOUSE BOT");
      expect(text).toContain("<B>GROK 4.6</B>");
      expect(text).toContain("SELF-REPORTED");
      expect(text).toContain("“<img src=x onerror=alert(1)> snack”"); // shown as text, never parsed as HTML
      expect(card.all().filter((e) => /^seat( won)?$/.test(e.className)).length).toBe(4);
      expect(card.all().filter((e) => e.className.includes("won")).length).toBe(1);
      // shown again: replaces the first card
      showOldRecord(s);
      expect(body.children.filter((c) => c.id === "old-record").length).toBe(1);
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
  });
});

describe("server: records list their engine version", () => {
  test("GET /api/records: engine per record, old ones marked", async () => {
    const store = new SqliteStore(":memory:");
    const s = new MatchServer({ outDir: mkdtempSync(join(tmpdir(), "kb-engine-")), store });
    await store.insertMatch({ id: "m1", seed: 1, kinds: ["house", "house", "house", "house"], deadlineMs: 1000, fillAfterMs: 1000, status: "over", createdAt: 1, startedAt: 1, endedAt: 2, creator: null, error: null, winner: 0 });
    await store.insertMatch({ id: "m2", seed: 2, kinds: ["house", "house", "house", "house"], deadlineMs: 1000, fillAfterMs: 1000, status: "over", createdAt: 1, startedAt: 1, endedAt: 2, creator: null, error: null, winner: 0 });
    await store.insertRecord({ matchId: "m1", path: "/records/old.json", seed: 1, hashes: ["a"], winner: 0, createdAt: 1, engine: 0 });
    await store.insertRecord({ matchId: "m2", path: "/records/new.json", seed: 2, hashes: ["b"], winner: 0, createdAt: 2, engine: ENGINE_VERSION });
    const res = (await s.handle(new Request("http://kb.test/api/records"), "1.1.1.1"))!;
    const body = (await res.json()) as { engine: number; records: { path: string; engine: number; old: boolean }[] };
    expect(body.engine).toBe(ENGINE_VERSION);
    expect(body.records.find((r) => r.path === "/records/old.json")).toMatchObject({ engine: 0, old: true });
    expect(body.records.find((r) => r.path === "/records/new.json")).toMatchObject({ engine: ENGINE_VERSION, old: false });
    await store.close();
  });
});
