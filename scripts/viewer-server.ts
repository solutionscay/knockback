import { networkInterfaces } from "node:os";
import { join } from "node:path";

/**
 * GET /records/<name>.json from `recordsDir`. Only plain `.json` file names
 * are served (no paths, no dot files): the records folder can also hold the
 * match server's SQLite file, its WAL and logs, which must never be served.
 */
export async function serveRecord(pathname: string, recordsDir: string): Promise<Response | null> {
  const prefix = "/records/";
  if (!pathname.startsWith(prefix)) return null;
  let name: string;
  try {
    name = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return new Response("Not found", { status: 404 });
  }
  if (!/^[\w-][\w.-]*\.json$/.test(name)) return new Response("Not found", { status: 404 });
  const file = Bun.file(join(recordsDir, name));
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  return new Response(file, { headers: { "content-type": "application/json", "cache-control": "no-cache" } });
}

export function logLanUrls(hostname: string, port: number | undefined, path: string) {
  if (hostname !== "0.0.0.0" && hostname !== "::") return;
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) console.log(`  LAN: http://${ni.address}:${port}${path}`);
    }
  }
}
