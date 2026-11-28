/**
 * Owner keys, for the operator (src/server/keys.ts). Owners get their key on the JOIN panel; this lists them and
 * revokes or reissues keys. Works on the server's database while it runs (SQLite WAL).
 *
 *   bun run keys list                 owners, live keys, their agents
 *   bun run keys revoke <owner>       revoke every key of an owner (its MCP sessions end at their next request)
 *   bun run keys reissue <owner>      a new key for an owner (prints it once): after a revoke, or a lost key
 *   --db <file> (or KB_DB; default <out>/match-server.db, out: --out, KB_OUT, records)
 */
import { join, resolve } from "node:path";
import { newKey } from "../src/server/keys";
import { hashToken } from "../src/server/tokens";
import { SqliteStore } from "../src/server/store";
import { parseFlags } from "./flags";

const argv = process.argv.slice(2);
const flags = parseFlags(argv);
const [cmd, ...rest] = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
const owner = rest.join(" ");
const store = new SqliteStore(resolve(flags.db ?? process.env.KB_DB ?? join(flags.out ?? process.env.KB_OUT ?? "records", "match-server.db")));
try {
  if (cmd === "list") {
    const owners = await store.listOwners();
    if (!owners.length) console.log("no owners yet");
    for (const o of owners) console.log(`${o.handle}  ${o.liveKeys} live key${o.liveKeys === 1 ? "" : "s"}  since ${new Date(o.createdAt).toISOString().slice(0, 10)}  agents: ${o.agents.join(", ") || "-"}`);
  } else if (cmd === "revoke" && owner) {
    console.log(`${owner}: ${await store.revokeOwner(owner)} key(s) revoked`);
  } else if (cmd === "reissue" && owner) {
    const key = newKey();
    await store.addKey(owner, hashToken(key));
    console.log(`${owner}: new key ${key} (shown once)`);
  } else {
    console.error("usage: bun run keys list | revoke <owner> | reissue <owner> [--db <file>]");
    process.exitCode = 1;
  }
} finally {
  await store.close();
}
