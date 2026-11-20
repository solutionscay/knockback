/**
 * Where the match comes from (bun run teaser): a record file, a house-bot match by seed, the best of n real AI
 * matches, or the newest finished match of a running match server. Also the sim pass over a record: dead
 * stretches per round (for the 2x parts) and an action score (for --best-of).
 */
import { mkdirSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { checkRecordEngine, initPhysics, Match, type MatchRecord } from "../../src/sim";
import { deadStretches } from "./plan";
import type { Source } from "./options";

/** Sim events that count as action (dead stretches, the score). */
const ACTION = new Set(["fire", "pellet", "swing", "grapple", "hit", "ko", "explosion", "carve", "break", "shatter", "detach", "impact", "suddenDeath", "lit", "zap", "shieldPop", "chainBreak", "platformFall", "ignite", "burn"]);

export interface MatchFacts {
  /** dead stretches per fight, in sim ticks */
  dead: [number, number][][];
  /** fight length per round, seconds */
  fightSeconds: number[];
  /** event counts over the match */
  counts: Record<string, number>;
  /** action per fight second (for --best-of) */
  score: number;
}

/** Replay a record in the sim: dead stretches and the action score. Refuses another engine's record. */
export async function matchFacts(rec: MatchRecord): Promise<MatchFacts> {
  checkRecordEngine(rec);
  await initPhysics();
  const m = new Match(rec.seed, { recorded: rec });
  const dead: [number, number][][] = [];
  const fightSeconds: number[] = [];
  const counts: Record<string, number> = {};
  for (let r = 0; r < rec.rounds.length; r++) {
    m.prepareRound();
    const sim = m.fight!.sim;
    const acts: number[] = [];
    m.onEvent = (e) => {
      const k = e.type === "ko" ? `ko.${e.cause}` : e.type;
      counts[k] = (counts[k] ?? 0) + 1;
      if (ACTION.has(e.type)) acts.push(e.tick);
    };
    const near: boolean[] = [];
    while (!m.step()) {
      const ps = sim.fighters.filter((f) => f.alive && !f.removed).map((f) => f.entity.body.translation());
      let close = false;
      for (let i = 0; i < ps.length && !close; i++) for (let j = i + 1; j < ps.length; j++) if (Math.hypot(ps[i]!.x - ps[j]!.x, ps[i]!.y - ps[j]!.y) < 7) close = true;
      near[sim.tick] = close;
    }
    fightSeconds.push(sim.tick / 60);
    dead.push(deadStretches(sim.tick, acts, near));
    m.finishRound();
  }
  const secs = fightSeconds.reduce((a, b) => a + b, 0) || 1;
  // weights: the big moments count more than the steady ones
  const w = (k: string, x: number) => (counts[k] ?? 0) * x;
  const score = (w("explosion", 1) + w("chainBreak", 1.5) + w("platformFall", 4) + w("ko.ringout", 6) + w("ko.hp", 5) + w("suddenDeath", 6) + w("ignite", 0.3) + w("hit", 0.1)) / secs;
  return { dead, fightSeconds, counts, score };
}

export interface Got {
  rec: MatchRecord & { labels?: string[] };
  /** where the record came from, for the README */
  from: string;
  /** other candidates (--best-of): file and score */
  candidates?: { file: string; score: number; seconds: number }[];
}

const readJson = async (file: string) => JSON.parse(await Bun.file(file).text());

/** Get the match record for a source. `work` = a scratch folder (AI match records land there). */
export async function getRecord(src: Source, work: string, log: (s: string) => void): Promise<Got> {
  switch (src.kind) {
    case "record":
      return { rec: await readJson(resolve(src.file)), from: `record ${basename(src.file)}` };
    case "seed": {
      await initPhysics();
      const m = new Match(src.seed);
      m.playToEnd();
      return { rec: JSON.parse(JSON.stringify(m.record)), from: `house-bot match, seed ${src.seed}` };
    }
    case "server": {
      const res = await fetch(`${src.url}/api/records`);
      if (!res.ok) throw new Error(`${src.url}/api/records: HTTP ${res.status}`);
      const list = ((await res.json()) as { records?: { path: string; createdAt: number; old?: boolean }[] }).records ?? [];
      const newest = list.filter((r) => !r.old).sort((a, b) => b.createdAt - a.createdAt)[0];
      if (!newest) throw new Error(`${src.url} has no finished match recorded with this engine yet`);
      const r = await fetch(`${src.url}${newest.path}`);
      if (!r.ok) throw new Error(`${src.url}${newest.path}: HTTP ${r.status}`);
      return { rec: await r.json(), from: `match server ${src.url}, ${newest.path}` };
    }
    case "best-of": {
      const dir = join(work, "ai-matches");
      mkdirSync(dir, { recursive: true });
      const base = (Math.random() * 1e8) >>> 0;
      log(`playing ${src.n} real AI match${src.n > 1 ? "es" : ""} (default providers), in parallel...`);
      const t0 = performance.now();
      const runs = Array.from({ length: src.n }, (_, i) => {
        // new matches are recorded with mid-round check-ins (#9), as live matches are played
        const p = Bun.spawn(["bun", "scripts/ai-match.ts", "--headless", "--checkins", "on", "--seed", String(base + i), "--out", dir], { stdout: "pipe", stderr: "pipe" });
        return p.exited.then(async (code) => ({ code, out: await new Response(p.stdout).text() }));
      });
      const done = await Promise.all(runs);
      log(`AI matches done in ${((performance.now() - t0) / 1000).toFixed(0)} s (${done.filter((d) => d.code === 0).length}/${src.n} ok)`);
      const files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".prompts.json"));
      const scored = [];
      for (const f of files) {
        const rec = await readJson(join(dir, f));
        const facts = await matchFacts(rec);
        scored.push({ file: join(dir, f), score: +facts.score.toFixed(3), seconds: +facts.fightSeconds.reduce((a, b) => a + b, 0).toFixed(0), rec });
      }
      if (!scored.length) throw new Error("no AI match finished (see the ai-match output above)");
      scored.sort((a, b) => b.score - a.score);
      return { rec: scored[0]!.rec, from: `best of ${src.n} real AI matches (${basename(scored[0]!.file)})`, candidates: scored.map(({ file, score, seconds }) => ({ file: basename(file), score, seconds })) };
    }
  }
}
