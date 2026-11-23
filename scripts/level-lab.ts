/**
 * The level-art lab page (#92): each theme's terrain, cracks, carving and the level props at game size (1:1).
 *   bun scripts/level-lab.ts [--port 5295]   -> http://localhost:5295/?s=45   (s: screen pixels per meter)
 */
import lab from "../tools/art/level-lab.html";
const i = process.argv.indexOf("--port");
const server = Bun.serve({ port: i > 0 ? Number(process.argv[i + 1]) : 5295, routes: { "/": lab }, development: false, fetch: () => new Response("Not found", { status: 404 }) });
console.log(`level lab: http://localhost:${server.port}/`);
