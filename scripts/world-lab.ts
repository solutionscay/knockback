/**
 * The world-art lab page (#87): every world sprite at game size (1:1), next to a plush fighter for scale.
 *   bun scripts/world-lab.ts [--port 5294]   -> http://localhost:5294/?s=45   (s: screen pixels per meter)
 */
import lab from "../tools/art/world-lab.html";
const i = process.argv.indexOf("--port");
const server = Bun.serve({ port: i > 0 ? Number(process.argv[i + 1]) : 5294, routes: { "/": lab }, development: false, fetch: () => new Response("Not found", { status: 404 }) });
console.log(`world lab: http://localhost:${server.port}/`);
