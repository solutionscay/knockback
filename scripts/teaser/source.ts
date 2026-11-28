/**
 * Where the match comes from (bun run teaser): a record file, a house-bot match by seed, the best of n real AI
 * matches, or the newest finished match of a running match server. Also the sim pass over a record: dead
 * stretches per round (for the 2x parts), the big moments (for bun run montage) and an action score (for --best-of).
 */
import { TICK_RATE } from "../../src/sim/constants";
import { mkdirSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { initPhysics, Match, type MatchRecord } from "../../src/sim";
import { deadStretches } from "./plan";
import type { Source } from "./options";

/** Sim events that count as action (dead stretches, the score). */
const ACTION = new Set(["fire", "pellet", "swing", "grapple", "hit", "ko", "explosion", "carve", "break", "shatter", "detach", "impact", "suddenDeath", "lit", "zap", "shieldPop", "chainBreak", "platformFall", "ignite", "burn", "fieldUp", "fieldHit"]);

/** How much each big moment counts (the --best-of score and the montage cuts): the big moments count more than the steady ones. */
export const MAYHEM: Record<string, number> = { explosion: 1, chainBreak: 1.5, platformFall: 4, "ko.ringout": 6, "ko.hp": 5, suddenDeath: 6, ignite: 0.3, hit: 0.1 };

/** One weighted moment of a fight: where (world meters) and when (sim tick). KOs carry who went out and who did it. */
export interface Moment {
  tick: number;
  kind: string;
  weight: number;
  x: number;
  fighter?: number;
  by?: number;
}

export interface MatchFacts {
  /** dead stretches per fight, in sim ticks */
  dead: [number, number][][];
  /** the weighted moments of each fight (kinds in MAYHEM), in tick order */
  moments: Moment[][];
  /** the last sim tick of each fight */
  endTicks: number[];
  /** fight length per round, seconds */
  fightSeconds: number[];
  /** event counts over the match */
  counts: Record<string, number>;
  /** action per fight second (for --best-of) */
  score: number;
}

/** Replay a record in the sim: dead stretches and the action score. */
export async function matchFacts(rec: MatchRecord): Promise<MatchFacts> {
  await initPhysics();
  const m = new Match(rec.seed, { recorded: rec });
  const dead: [number, number][][] = [];
  const fightSeconds: number[] = [];
  const counts: Record<string, number> = {};
  const moments: Moment[][] = [];
  const endTicks: number[] = [];
  for (let r = 0; r < rec.rounds.length; r++) {
    m.prepareRound();
    const sim = m.fight!.sim;
    const acts: number[] = [];
    const ms: Moment[] = [];
    m.onEvent = (e) => {
      const k = e.type === "ko" ? `ko.${e.cause}` : e.type;
      counts[k] = (counts[k] ?? 0) + 1;
      if (ACTION.has(e.type)) acts.push(e.tick);
      const weight = MAYHEM[k];
      if (weight !== undefined) {
        const x = "x" in e ? e.x : NaN;
        ms.push({ tick: e.tick, kind: k, weight, x, ...(e.type === "ko" ? { fighter: e.fighter, by: e.by } : {}) });
      }
    };
    const near: boolean[] = [];
    while (!m.step()) {
      const ps = sim.fighters.filter((f) => f.alive && !f.removed).map((f) => f.entity.body.translation());
      let close = false;
      for (let i = 0; i < ps.length && !close; i++) for (let j = i + 1; j < ps.length; j++) if (Math.hypot(ps[i]!.x - ps[j]!.x, ps[i]!.y - ps[j]!.y) < 7) close = true;
      near[sim.tick] = close;
    }
    fightSeconds.push(sim.tick / TICK_RATE);
    endTicks.push(sim.tick);
    moments.push(ms);
    dead.push(deadStretches(sim.tick, acts, near));
    m.finishRound();
  }
  const secs = fightSeconds.reduce((a, b) => a + b, 0) || 1;
  const score = Object.entries(MAYHEM).reduce((a, [k, w]) => a + (counts[k] ?? 0) * w, 0) / secs;
  return { dead, moments, endTicks, fightSeconds, counts, score };
}

export interface Got {
  rec: MatchRecord & { labels?: string[] };
  /** where the record came from, for the README */
  from: string;
  /** other candidates (--best-of): file and score */
  candidates?: { file: string; score: number; seconds: number }[];
}

const readJson = async (file: string) => JSON.parse(await Bun.file(file).text());

export async function newestRecords(url: string): Promise<{ path: string; createdAt: number }[]> {
  const res = await fetch(`${url}/api/records`);
  if (!res.ok) throw new Error(`${url}/api/records: HTTP ${res.status}`);
  const { records = [] } = await res.json() as { records?: { path: string; createdAt: number }[] };
  return (records ?? []).sort((a, b) => b.createdAt - a.createdAt);
}

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
      const [newest] = await newestRecords(src.url);
      if (!newest) throw new Error(`${src.url} has no finished match recorded yet`);
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
