/**
 * Contract 6: store. A fresh database gets the current schema and works; reopening it keeps the data. A database with
 * an old schema is refused (pre-alpha: never upgraded, never touched) with a message that says how to reset it, and
 * that reset works. The one exception is v7 (#88): v8 only added matches.engine, so a v7 database gets that column
 * (empty: its rounds are checked later) and keeps all its data.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, SchemaError, SqliteStore } from "../src/server/store";

const dir = mkdtempSync(join(tmpdir(), "kb-store-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A database file as an older server left it. */
function oldDb(name: string, version: number): string {
  const path = join(dir, name);
  const db = new Database(path, { create: true });
  db.exec("CREATE TABLE matches (id TEXT PRIMARY KEY, seed INTEGER); INSERT INTO matches VALUES ('m1', 42);");
  db.exec(`PRAGMA user_version = ${version}`);
  db.close();
  return path;
}

const versionOf = (path: string) => {
  const db = new Database(path, { readonly: true });
  try {
    return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
};

describe("store", () => {
  test("a fresh database gets the current schema, works, and keeps its data across a reopen", async () => {
    const path = join(dir, "fresh.db");
    const s = new SqliteStore(path);
    expect(await s.createOwner("Ada", "h1")).toBe(true);
    expect(await s.createOwner("ada", "h2")).toBe(false); // handles are unique, ignoring case
    expect(await s.claimAgent("Basher", "Ada")).toBe("Ada");
    expect((await s.defaultRulesetPreset())?.name).toBe("Classic");
    await s.close();
    expect(versionOf(path)).toBe(SCHEMA_VERSION);

    const again = new SqliteStore(path);
    expect(await again.ownerOfKey("h1")).toBe("Ada");
    expect(await again.listAgents("Ada")).toEqual(["Basher"]);
    await again.close();
  });

  for (const [what, version] of [
    ["an older schema version", SCHEMA_VERSION - 2],
    ["tables from before the single schema (no version)", 0],
  ] as const)
    test(`refuses ${what} with the reset command, and leaves the file alone`, () => {
      const path = oldDb(`old-${version}.db`, version);
      let err: unknown;
      try {
        new SqliteStore(path);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(SchemaError);
      expect((err as Error).message).toContain(`bun run db:reset --db ${path}`);
      expect(versionOf(path)).toBe(version);
      const db = new Database(path, { readonly: true });
      expect(db.query("SELECT seed FROM matches").get()).toEqual({ seed: 42 });
      db.close();
    });

  test("v7 (#88) gets the engine column and keeps its data; the column starts empty", async () => {
    expect(SCHEMA_VERSION).toBe(8);
    const path = oldDb("v7.db", 7);
    const s = new SqliteStore(path, "e-test");
    await s.close();
    const db = new Database(path); // WAL now: read it with a normal connection
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(8);
    expect(db.query("SELECT seed, engine FROM matches").get()).toEqual({ seed: 42, engine: null });
    db.close();
  });

  test("the reset command from the message gives a working database and keeps the old file", async () => {
    const path = oldDb("reset.db", SCHEMA_VERSION - 2);
    const p = Bun.spawnSync(["bun", "scripts/db-reset.ts", "--db", path], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString()).toContain(`schema v${SCHEMA_VERSION}`);
    const s = new SqliteStore(path);
    expect(await s.createOwner("Ada", "h1")).toBe(true);
    await s.close();
    expect([...new Bun.Glob("reset.db.reset-*").scanSync(dir)].length).toBeGreaterThan(0);
  });
});
