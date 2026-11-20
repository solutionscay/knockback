import { networkInterfaces } from "node:os";
import { join } from "node:path";

export function serveRecord(pathname: string, recordsDir: string): Response | null {
  const prefix = "/records/";
  if (!pathname.startsWith(prefix)) return null;
  const file = Bun.file(join(recordsDir, pathname.slice(prefix.length).replace(/[^\w.-]/g, "")));
  return new Response(file, { headers: { "content-type": "application/json" } });
}

export function logLanUrls(hostname: string, port: number | undefined, path: string) {
  if (hostname !== "0.0.0.0" && hostname !== "::") return;
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) console.log(`  LAN: http://${ni.address}:${port}${path}`);
    }
  }
}
