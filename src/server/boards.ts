import { buildText } from "../sim/build";
import { arenaBoard } from "../stats/board";
import { modelBoard, type BoardRound, type ModelBoard, type ModelBoardRow } from "../stats/model-board";
import { dedupe, headToHead, leaderboard, remoteLabel, type SeatEntry } from "../stats/models";
import type { MatchServer } from "./match-server";
import type { Operator } from "./profile";
import type { RecordRow } from "./store";
import { SEATS, summaryOf, type ReplaySummary } from "./replays";
import { operatorsOf } from "./agent-profiles";

/** The Arena leaderboard: agents and owners by rounds (agent seats only), best streaks, and the crown now. */
export async function leaderboardOf(server: MatchServer) {
  const [rounds, latest, streaks, ops] = await Promise.all([server.store.agentRounds(), server.store.latestSeats(), server.store.listStreaks(), operatorsOf(server)]);
  const labels = new Map(latest.map((s) => [s.name.toLowerCase(), remoteLabel(s.name, s.model)]));
  const board = arenaBoard(rounds, labels, streaks);
  return {
    // the operator (#113) next to each agent and owner that has one
    agents: board.agents.map((a) => ({ ...a, operator: ops.byOwner.get(a.owner.toLowerCase()) ?? null })),
    owners: board.owners.map((o) => ({ ...o, operator: ops.byOwner.get(o.owner.toLowerCase()) ?? null })),
    crown: server.arena.crownView(),
    note: "Rounds, agent seats only: against agents = rounds with 2 or more agents (the ranking); against house bots = an agent alone with house bots. Best streak: crown defences in rounds with 2 or more agents.",
  };
}

// ------------------------------------------------------------------ models (#96)

/** how many of the newest public rounds the models board reads */
const BOARD_ROUNDS = 400;

/** One record as a board round: the summary's line-up and plans, the index's fight stats (pure: tested). */
export function boardRound(sum: ReplaySummary, stats: string, tier: BoardRound["tier"] = sum.tier): BoardRound {
  const es = seatEntriesFromStats(stats);
  const first = sum.rounds[0];
  return {
    match: sum.match,
    createdAt: sum.createdAt,
    tier,
    winner: sum.winner,
    seats: SEATS.map((i) => {
      const f = es.find((e) => e.seat === i)?.fight;
      const pl = first?.plans[i];
      return {
        label: sum.labels[i] ?? "house",
        fighter: sum.names[i] ?? "",
        identity: sum.identities[i] ?? null,
        weapon: pl?.weapons[0] ?? "",
        build: pl?.build ? buildText(pl.build) : "",
        kos: f?.kos ?? 0,
        damage: f?.damage ?? 0,
        // one round per Arena record: a seat that was not on the field to the end was knocked out
        died: f ? f.alive < f.roundSeconds : false,
      };
    }),
  };
}

const boards = new WeakMap<MatchServer, { at: number; board: ModelBoard }>();

/** The models board, rebuilt at most every 20 s (rounds take longer than that at broadcast pace); `fresh` rebuilds now. */
export async function modelsBoardOf(server: MatchServer, fresh = false): Promise<Omit<ModelBoard, "rows"> & { rows: (ModelBoardRow & { operators: Operator[] })[]; note: string }> {
  let c = boards.get(server);
  if (fresh || !c || Date.now() - c.at >= 20_000) {
    const read = async (rows: RecordRow[]) =>
      (
        await Promise.all(
          rows.map(async (row) => {
            const sum = await summaryOf(server, row);
            return sum ? boardRound(sum, row.stats) : null;
          }),
        )
      ).filter((x): x is BoardRound => x !== null);
    const [pub, streaks, latest] = await Promise.all([server.store.listRecords(BOARD_ROUNDS).then((r) => read(r)), server.store.listStreaks(), server.store.latestSeats()]);
    const live = [...server.arena.seats.filter((e) => e !== null), ...server.arena.queue];
    const joined = [
      ...live.map((e) => ({ name: e.name, model: e.model, look: e.look, live: true })),
      ...latest.map((s) => ({ name: s.name, model: s.model, look: s.look, live: false })),
    ];
    c = { at: Date.now(), board: modelBoard(pub, streaks, joined) };
    boards.set(server, c);
  }
  // the operators (#113) who run each model's agents: read each time (a profile edit shows at once; one small query)
  const ops = (await operatorsOf(server)).byAgent;
  const opsOf = (names: string[]) => [...new Map(names.flatMap((n) => (ops.has(n.toLowerCase()) ? [[ops.get(n.toLowerCase())!.id, ops.get(n.toLowerCase())!] as const] : []))).values()];
  return {
    ...c.board,
    rows: c.board.rows.map((r) => ({ ...r, operators: opsOf(r.agents.map((a) => a.name)) })),
    note: "Rounds on this engine only. Models are what each agent said it runs when it joined (self-reported, nobody checks). A round is a whole fight: last fighter standing wins, so chance is 25% with 4 fighters. K/D: knockouts dealt per knockout taken. Best streak: the longest crown streak of the model's agents.",
  };
}

/** Maximum number of recent records for GET /api/models. */
const MODELS_MAX_RECORDS = 5000;

function seatEntriesFromStats(stats: string): SeatEntry[] {
  try {
    const entries = JSON.parse(stats);
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

/**
 * The model leaderboard from the SQLite record index: each row's per-seat stats, saved
 * with the record. Records with test providers are left out; copies of one match count once.
 */
export async function modelsOf(server: MatchServer, min?: number) {
  if (!server.modelsCache || Date.now() - server.modelsCache.at >= 60_000) {
    const rows = await server.store.listRecords(MODELS_MAX_RECORDS);
    const sets: SeatEntry[][] = [];
    for (const row of rows) {
      const es = seatEntriesFromStats(row.stats);
      if (es.length && !es.some((e) => e.model?.test)) sets.push(es);
    }
    server.modelsCache = { at: Date.now(), ...dedupe(sets) };
  }
  const { kept, dropped } = server.modelsCache;
  const lb = leaderboard(kept, min !== undefined ? { minMatches: min } : {});
  const h2h = headToHead(kept, lb.rows.map((r) => r.key));
  return { ...lb, headToHead: h2h, duplicates: dropped, note: "win rate per seat played; ± is the 95% interval; chance is 25% in a 4-fighter round; models below the minimum are provisional; self-reported models are the model ids remote agents gave at join, cleaned so one model is one row" };
}
