/**
 * Dev server for the viewer.
 *   bun run dev                      -> http://localhost:5173
 *   bun run dev --host 0.0.0.0       -> also reachable on the LAN
 *   bun run dev --port 8080
 */
import { networkInterfaces } from "node:os";
import index from "../index.html";

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  const a = args[i]!;
  return a.includes("=") ? a.split("=")[1]! : (args[i + 1] ?? def);
};
const hostname = opt("host", "localhost");
const port = Number(opt("port", "5173"));

const server = Bun.serve({
  hostname,
  port,
  routes: { "/": index },
  development: process.env.NODE_ENV !== "production",
  fetch() {
    return new Response("Not found", { status: 404 });
  },
});

console.log(`Knockback viewer: http://localhost:${server.port}/`);
if (hostname === "0.0.0.0" || hostname === "::") {
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) console.log(`  LAN: http://${ni.address}:${server.port}/`);
    }
  }
}
console.log("  add ?seed=123 to pick a match, ?loop to auto-start new matches");
