/**
 * Preloaded once per `bun test` run (bunfig.toml): works out the engine stamp (src/sim/engine.ts: a reference round on
 * every map, about 3 s) before the first test, so no test pays it inside its time limit. Modules are shared across test
 * files, so every later engineStamp() call is the cached value.
 */
import { initPhysics } from "../../src/sim";
import { engineStamp } from "../../src/sim/engine";

await initPhysics();
engineStamp();
