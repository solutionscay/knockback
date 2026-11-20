import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveRecord } from "../scripts/viewer-server";

test("/records/ serves only plain .json names: never the server's database, WAL, dot files or other paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kb-rec-"));
  writeFileSync(join(dir, "remote-1-x.json"), "{}");
  for (const f of ["match-server.db", "match-server.db-wal", ".hidden.json", "x.log.txt"]) writeFileSync(join(dir, f), "secret");
  const status = async (p: string) => (await serveRecord(p, dir))?.status ?? null;
  expect(await status("/records/remote-1-x.json")).toBe(200);
  for (const p of ["/records/match-server.db", "/records/match-server.db-wal", "/records/.hidden.json", "/records/x.log.txt", "/records/..%2Fsecret.json", "/records/missing.json", "/records/%E0", "/records/a.json%00.db"])
    expect(await status(p)).toBe(404);
  expect(await status("/other")).toBeNull();
});
