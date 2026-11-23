/**
 * The plush lab page: moods, identity colors, marks and moments at game size (1:1), the code bot
 * beside it.
 *   bun scripts/plush-lab.ts [--port 5293]   -> http://localhost:5293/?s=45   (s: screen pixels per meter)
 */
import lab from "../tools/art/plush-lab.html";
const i = process.argv.indexOf("--port");
const server = Bun.serve({ port: i > 0 ? Number(process.argv[i + 1]) : 5293, routes: { "/": lab }, development: false, fetch: () => new Response("Not found", { status: 404 }) });
console.log(`plush lab: http://localhost:${server.port}/`);
