import { formatSeconds } from "../format";
import type { Beat } from "../flow/beats";
import { POINTS, Tally } from "../flow/score";
import { TICK_RATE } from "../sim/constants";
import { type Match } from "../sim/match";
import type { MoraleState, RoundFacts } from "../sim/morale";
import { behindHitText, topDamager } from "../sim/roundstats";
import type { Sim } from "../sim/sim";
import type { Strategy } from "../sim/sim-types";
import type { Decision } from "../sim/voice";
import { bestRule, type KoEvent, type RuleFiring } from "./callouts";
import { esc, hex } from "../html";
import { portraitSvg } from "./portrait";
import { modelBadgeHtml } from "./model-badge";
import { buildChipHtml } from "./build-view";
import { strategyBuild } from "../sim/build";
import type { CamMode } from "./scene-camera";

const TALLY_KEY = "knockback.tally.v1";
const CAM_KEY = "knockback.camera.v1";

export interface Hud {
  clock: HTMLElement;
  intro: HTMLElement;
  lineup: HTMLElement;
  count: HTMLElement;
  callout: HTMLElement;
  celebrate: HTMLElement;
  cam: HTMLElement;
  dialogue: HTMLElement;
}


const STANCE: Record<Strategy["stance"], string> = { rush: "RUSH", distance: "KEEP DISTANCE", cover: "TAKE COVER", item: "GRAB ITEMS", overwatch: "OVERWATCH", flank: "FLANK", hold: "HOLD THE SPOT" };
const MOOD_LABEL: Record<MoraleState, string> = { cocky: "COCKY", confident: "CONFIDENT", rattled: "RATTLED", furious: "FURIOUS", desperate: "DESPERATE" };
const MOOD_COLOR: Record<MoraleState, string> = { cocky: "#ffd84a", confident: "#7dffa0", rattled: "#9fe0ff", furious: "#ff5a6a", desperate: "#d59bff" };

export function loadTally(): Tally {
  try {
    return Tally.from(JSON.parse(sessionStorage.getItem(TALLY_KEY) ?? "null"));
  } catch {
    return new Tally();
  }
}

export function saveTally(tally: Tally) {
  try {
    sessionStorage.setItem(TALLY_KEY, JSON.stringify(tally));
  } catch {
    /* private mode etc: the tally still lives for this page */
  }
}

export function loadCamera(): CamMode {
  try {
    const v = JSON.parse(sessionStorage.getItem(CAM_KEY) ?? "null");
    if (v?.kind === "auto") return { kind: "auto" };
    if (v?.kind === "follow" && Number.isInteger(v.id) && v.id >= 0 && v.id < 4) return { kind: "follow", id: v.id };
  } catch {
    /* ignore */
  }
  // default: everyone on screen (the operator's preference for watching)
  return { kind: "all" };
}

export function saveCamera(mode: CamMode) {
  try {
    sessionStorage.setItem(CAM_KEY, JSON.stringify(mode));
  } catch {
    /* private mode: still works for this page */
  }
}

export function renderCamBar(el: HTMLElement, m: CamMode, sim?: Sim) {
  const chips = (sim?.fighters ?? [])
    .map((f) => {
      const on = m.kind === "follow" && m.id === f.id;
      return `<button type="button" class="f${on ? " on" : ""}${f.alive ? "" : " out"}" data-follow="${f.id}" style="--c:${hex(f.color)}" title="Follow ${esc(f.name)} (${f.id + 1})"><i></i>${esc(f.name)}</button>`;
    })
    .join("");
  el.innerHTML = `<span class="lbl">CAMERA</span>
    <button type="button" data-cam="auto" class="${m.kind === "auto" ? "on" : ""}" title="Auto: frame the action (A)">Auto</button>
    <button type="button" data-cam="all" class="${m.kind === "all" ? "on" : ""}" title="View all fighters (V)">View all</button>
    <span class="sep"></span>${chips}`;
}

export function pipsHtml(match: Match, size: "small" | "big"): string {
  const pips = match.identities.map((c, i) => {
    const w = match.wins[i]!;
    const dots = Array.from({ length: match.ruleset.round.winsToTake }, (_, k) => `<b class="${k < w ? "on" : ""}"></b>`).join("");
    // the big line (round end, the winner's card) shows each fighter's plush head; the clock's small one a dot
    const face = size === "big" ? portraitSvg(c, w > 0 && w >= Math.max(...match.wins) ? "win" : "fight", "tiny") : "";
    return `<span class="pip" style="--c:${hex(c.color)}"><i>${face}</i>${size === "big" ? esc(c.name) : ""}${dots}</span>`;
  }).join("");
  return `<span class="pips pips-${size}">${pips}</span>`;
}

/** Short round recap: damage dealt/taken and who hurt each fighter most (from round stats). */
/** Short round recap: damage dealt/taken and who hurt each fighter most (from round stats); `labels`: who plays each seat. */
export function recapHtml(match: Match, facts: RoundFacts, firings: RuleFiring[], kos: KoEvent[], labels: (string | null)[] = []): string {
  const st = facts.stats;
  const rows = match.identities.map((c, i) => {
    const dealt = st.damage[i]!.reduce((a, s, j) => a + (j === i ? 0 : s.damage), 0);
    const took = st.damage.reduce((a, row, j) => a + (j === i ? 0 : row[i]!.damage), 0);
    const worst = topDamager(st, i);
    const w = worst >= 0 ? st.damage[worst]![i]! : null;
    const hurt = w && w.damage >= 8 ? `${esc(match.identities[worst]!.name)} ${Math.round(w.damage)}${behindHitText(w, 1)}` : "";
    return `<div class="rr" style="--c:${hex(c.color)}"><i>${portraitSvg(c, "fight", "tiny")}</i><b>${esc(c.name)}</b>${modelBadgeHtml(labels[i] ?? null, "xs")}<span>dealt ${Math.round(dealt)}</span><span>took ${Math.round(took)}</span><em>${hurt ? `hurt most by ${hurt}` : ""}</em></div>`;
  }).join("");
  // best rule (#11): a rule firing followed within 5 s by a knockout by the same fighter
  const br = bestRule(firings, kos);
  const brRule = br ? match.record.rounds[facts.round - 1]?.strategies[br.fighter]?.rules?.[br.rule] : undefined;
  const best = br && brRule ? `<div class="best" style="--c:${hex(match.identities[br.fighter]!.color)}">BEST RULE · <b>${esc(match.names[br.fighter]!)}</b> '${esc(brRule.label)}' → knocked out ${esc(match.names[br.victim]!)}</div>` : "";
  return `<div class="recap">${rows}${best}</div>`;
}

/** `label`: who plays this fighter ("claude/haiku", "house", "remote/Zapbit@grok-4.6"): shown as the model badge. */
export function dialogueHtml(match: Match, decision: Decision, label: string | null, b: Extract<Beat, { kind: "dialogue" }>): string {
  const c = match.identities[b.fighter]!;
  const d = decision;
  const m = match.morale[b.fighter]!;
  const s = d.strategy;
  const tgt = esc(s.target === "grudge" && s.grudge !== undefined ? `AFTER ${match.identities[s.grudge]!.name.toUpperCase()}` : `TARGET: ${String(s.target).toUpperCase()}`);
  const head = b.phase === "intro" ? "BEFORE ROUND 1" : `AFTER ROUND ${b.round - 1} · NEXT: ROUND ${b.round}`;
  const meta = match.record.rounds[b.round - 1]?.meta?.[b.fighter];
  // the model badge is the headline (#model spotlight); how this plan was made is the small print next to it
  const badge = modelBadgeHtml(label ?? meta?.provider ?? null, "lg");
  const who = meta
    ? meta.outcome === "ok"
      ? `<span class="ai">${formatSeconds(meta.ms)}</span>`
      : meta.outcome === "house"
        ? ""
        : `<span class="ai bot">${meta.outcome === "fallback-timeout" ? "timed out" : meta.outcome === "fallback-error" ? "error" : "bad answer"} · ${meta.aiLine ? "bot plan" : "bot line"}</span>`
    : "";
  const lastStats = b.phase === "between" ? match.facts[b.round - 2]?.stats.summary[b.fighter] : undefined;
  // rules (#11): last round's rules with their firing counts, then this round's rules; the AI's reason (#10)
  const lastRules = b.phase === "between" ? match.record.rounds[b.round - 2]?.strategies[b.fighter]?.rules : undefined;
  const lastFired = b.phase === "between" ? match.facts[b.round - 2]?.stats.rules?.[b.fighter] : undefined;
  const counts = lastRules?.length ? `<div class="rules"><span class="k">LAST ROUND'S RULES</span>${lastRules.map((r, i) => `<span>${esc(r.label)} <b>×${lastFired?.[i]?.fires ?? 0}</b></span>`).join("")}</div>` : "";
  const nextRules = s.rules?.length ? `<div class="rules next"><span class="k">RULES</span>${s.rules.map((r) => `<span>${esc(r.label)}</span>`).join("")}</div>` : "";
  const why = meta?.why ? `<div class="why">${esc(meta.why)}</div>` : "";
  const rt = s.retaliate === "attacker" ? "TURN ON ATTACKERS" : s.retaliate === "ignore" ? "IGNORE BACKSTABS" : "FIGHT BACK";
  // the intro card boots the fighter up (#19), and says when it chose its own look
  const intro = b.phase === "intro";
  const suit = intro ? match.record.suitUp?.find((e) => e.seat === b.fighter) : undefined;
  const suitTag = !suit
    ? ""
    : suit.outcome === "ok" || suit.outcome === "partial"
      ? `<span class="suit" title="${esc(suit.why ?? "")}">${suit.by === "ai" ? "PICKED ITS OWN LOOK" : "ITS AGENT PICKED THE LOOK"}${suit.outcome === "partial" ? " · PARTLY TAKEN" : ""}</span>`
      : `<span class="suit random">RANDOM LOOK · ${suit.outcome === "fallback-timeout" ? "TIMED OUT" : suit.outcome === "fallback-error" ? "ERROR" : "BAD ANSWER"}</span>`;
  return `
      <div class="panel" style="--c:${hex(c.color)}">
        <div class="portrait${intro ? " boot" : ""}">${portraitSvg(c, m.state)}${intro ? `<i class="bootscan"></i><em class="bootlabel">ONLINE</em>` : ""}</div>
        <div class="body">
          <div class="who"><span class="name">${esc(c.name.toUpperCase())}</span>${badge}<span class="mood" style="--m:${MOOD_COLOR[m.state]}">${MOOD_LABEL[m.state]}</span>${who}${suitTag}</div>
          ${lastStats ? `<div class="stat">LAST ROUND · ${esc(lastStats)}</div>` : ""}
          <div class="line"><span class="typed"></span><span class="caret"></span></div>
          <div class="plan"><span class="k">${head}</span>${buildChipHtml(strategyBuild(s.build))}<b>${esc(STANCE[s.stance] ?? String(s.stance))}</b><b>${esc(`WANTS ${s.weapons.join(" > ")}`.toUpperCase())}</b><b>${tgt}</b><b>${rt}</b></div>
          ${nextRules}${counts}${why}
        </div>
        <button type="button" class="skip" title="Skip the dialogue">SKIP ▸▸</button>
        <div class="hint">SPACE ▸</div>
      </div>`;
}

export function celebrateHtml(match: Match, tally: Tally, matchPoints: number[], matchesPlayed: number, autopilot: boolean[] = [], labels: (string | null)[] = []): string {
  const m = match;
  const w = match.identities[m.winner]!;
  // an Arena round is a whole fight on its own (one round): no "rounds to" score
  const single = m.ruleset.round.maxRounds === 1;
  const why = single ? "last one standing" : m.decidedBy() === "two-wins" ? `${m.wins[m.winner]} rounds to ${Math.max(...m.wins.filter((_, i) => i !== m.winner))}` : "won the deciding round";
  const best = Math.max(1, ...tally.points);
  const rows = tally
    .ranking()
    .map((id, rank) => {
      const c = match.identities[id]!;
      const gained = matchPoints[id]!;
      const wins = m.wins[id]!;
      const kos = m.kos[id]!;
      const parts = [wins ? `${wins} ROUND${wins > 1 ? "S" : ""} +${wins * POINTS.win}` : "", kos ? `${kos} KO +${kos * POINTS.ko}` : ""].filter(Boolean).join(" · ");
      return `<div class="row${id === m.winner ? " champ" : ""}" style="--c:${hex(c.color)};--w:${(100 * tally.points[id]!) / best}%">
          <span class="rank">${rank + 1}</span><i>${portraitSvg(c, id === m.winner ? "win" : "fight", "tiny")}</i><span class="name">${esc(c.name)}</span>
          <span class="bar"><span></span></span><span class="pts">${tally.points[id]}</span>${gained ? `<em>+${gained}</em>` : `<em class="zero">+0</em>`}<span class="mdl">${modelBadgeHtml(labels[id] ?? null, "sm")}</span><span class="why">${parts}${autopilot[id] ? `${parts ? " · " : ""}<b class="autopilot">finished on autopilot</b>` : ""}</span></div>`;
    })
    .join("");
  return `
      <div class="winner" style="--c:${hex(w.color)}">
        <div class="big">${esc(w.name.toUpperCase())} WINS</div>
        <div class="model">${modelBadgeHtml(labels[m.winner] ?? null, "xl")}</div>
        <div class="why">${single ? why : `${why} · ${m.round} rounds`}</div>
        ${pipsHtml(match, "big")}
      </div>
      <div class="board">
        <div class="head">SCOREBOARD <span>${matchesPlayed + 1} match${matchesPlayed === 0 ? "" : "es"} this session · round win ${POINTS.win} · knockout ${POINTS.ko}</span></div>
        ${rows}
        <button class="next" type="button">NEXT MATCH <span class="auto"></span></button>
      </div>`;
}

/** Re-trigger CSS entrance animations. */
export function restart(el: HTMLElement, cls: string) {
  el.className = "";
  void el.offsetWidth;
  el.className = cls;
}

/** Type the line out over time; returns how many characters show (sound: dialogue blips). */
export function renderDialogueLine(el: HTMLElement, line: string, elapsed: number, duration: number): number {
  const typed = el.querySelector<HTMLElement>(".typed");
  const n = Math.floor(line.length * Math.min(1, Math.max(0, (elapsed - 0.2) / Math.min(1.6, duration * 0.5))));
  if (typed && typed.textContent!.length !== n) typed.textContent = line.slice(0, n);
  return n;
}

/** The fight's one clock: the time left (#109). A one-round match (every Arena round) has no round number to show. */
export function renderRoundClock(el: HTMLElement, match: Match, tick: number) {
  const left = Math.max(0, (match.ruleset.round.fightTicks - tick) / TICK_RATE);
  const round = match.ruleset.round.maxRounds > 1 ? `<span class="r">ROUND ${match.round}</span>` : "";
  const txt = `${round}${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, "0")}${pipsHtml(match, "small")}`;
  if (el.innerHTML !== txt) el.innerHTML = txt;
  el.className = left < 10 ? "show low" : "show";
}
