import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MatchRunner } from "../src/ai/runner";
import { lookOptions } from "../src/ai/looks";
import { parseSuitUp, settleSuitUp, suitUp, suitUpPrompt } from "../src/ai/suitup";
import type { Provider } from "../src/ai/providers";
import { initPhysics, Match, replayMatch } from "../src/sim";
import { colorsApart, EYES, generateIdentities, MAJOR_MARKS, MIN_COLOR_DISTANCE, MINOR_MARKS, nearDuplicateName, nudgeColor, SHAPES } from "../src/sim/identity";
import { oklabDistance } from "../src/sim/color";
import { parseSoul, type Soul } from "../src/sim/soul";
import { exampleSouls } from "../src/sim/souls";

beforeAll(async () => {
  await initPhysics();
});

const souls: Soul[] = exampleSouls();
const answer = (o: Record<string, unknown>, delay = 5): Provider => ({ label: "look/test", ask: async () => (await Bun.sleep(delay), `Here you go:\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\``) });
const hang: Provider = { label: "hang/test", ask: (_p, signal) => new Promise((_r, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))) };
const junk: Provider = { label: "junk/test", ask: async () => "I'd rather not dress up." };
const broken: Provider = { label: "broken/test", ask: async () => { throw new Error("exit 1"); } };

describe("look options and the suit-up prompt", () => {
  test("every shape, eye style and mark the renderer draws, each with a one-line description; name and palette rules", () => {
    const o = lookOptions();
    expect(Object.keys(o.shape)).toEqual([...SHAPES]);
    expect(Object.keys(o.eyes)).toEqual([...EYES]);
    expect(Object.keys(o.mark)).toEqual([...MAJOR_MARKS]);
    expect(Object.keys(o.minor)).toEqual([...MINOR_MARKS, "none"]);
    for (const d of [...Object.values(o.shape), ...Object.values(o.mark)]) expect(d.length).toBeGreaterThan(5);
    expect(o.color).toContain("OKLab");
    expect(o.shapeFamilies).toContain("round (squircle, dome");
    const p = suitUpPrompt(souls[0]!);
    expect(p).toContain(souls[0]!.body.slice(0, 40));
    for (const s of SHAPES) expect(p).toContain(`  ${s}: `);
    expect(p).toContain('Reply ONLY with JSON: {"name"');
  });

  test("parseSuitUp: JSON in prose or a fence; #rrggbb to a number; ids lower-cased, the name's case kept; nonsense -> null", () => {
    expect(parseSuitUp('ok {"name":"Krak","shape":"Barrel","color":"#FF8800","mark":"horns","line":"  \\"Move.\\" ","why":"big and loud"}')).toEqual({ wish: { name: "Krak", shape: "barrel", color: 0xff8800, mark: "horns" }, line: "Move.", why: "big and loud" });
    expect(parseSuitUp("no json here")).toBeNull();
    expect(parseSuitUp('{"plan":"x"}')).toBeNull();
  });
});

describe("validation", () => {
  test("near-duplicate names: the same first 3 letters, or 1-2 letters apart", () => {
    expect(nearDuplicateName("Gasket", "Basket")).toBe(true);
    expect(nearDuplicateName("Rivet", "rivets")).toBe(true);
    expect(nearDuplicateName("Junko", "Junwick")).toBe(true);
    expect(nearDuplicateName("Bolt", "Volt")).toBe(true);
    expect(nearDuplicateName("Krak", "Pixel")).toBe(false);
  });

  test("a clashing color is nudged to the nearest free one (OKLab), not replaced at random", () => {
    const taken = [0xff5ab4];
    const to = nudgeColor(0xff5ab4, taken)!;
    expect(colorsApart(to, taken)).toBe(true);
    expect(oklabDistance(to, 0xff5ab4)).toBeGreaterThanOrEqual(MIN_COLOR_DISTANCE);
    expect(oklabDistance(to, 0xff5ab4)).toBeLessThan(0.2); // still a pink-ish neighbour
    expect(nudgeColor(0x33cc66, taken)).toBe(0x33cc66); // free: unchanged
  });
});

describe("suit up", () => {
  test("parallel answers -> settled identities; clashes resolved in seat order; timeout, error and junk fall back to the seeded draw", async () => {
    const seats = [
      { provider: answer({ name: "Krak", shape: "barrel", eyes: "set", color: "#ff5ab4", mark: "horns", minor: "scratch", line: "Move or get moved.", why: "a bruiser looks heavy" }), soul: souls[0]! },
      // wants Krak's look too: the shape's family, the mark and the name are taken; the color is nudged
      { provider: answer({ name: "Krok", shape: "squircle", color: "#ff5ab4", mark: "horns", eyes: "slit" }), soul: souls[1]! },
      { provider: hang, soul: souls[2]! },
      { provider: junk, soul: souls[3]! },
    ];
    const logs: string[] = [];
    const r = await suitUp(77, seats, { deadlineMs: 80, log: (s) => logs.push(s) });
    expect(r.identities[0]).toEqual({ name: "Krak", shape: "barrel", eyes: "set", color: 0xff5ab4, mark: "horns", minor: "scratch" });
    const e = Object.fromEntries(r.entries.map((x) => [x.seat, x]));
    expect(e[0]).toMatchObject({ by: "ai", outcome: "ok", kept: ["name", "shape", "eyes", "mark", "minor", "color"], line: "Move or get moved.", why: "a bruiser looks heavy" });
    expect(e[1]!.outcome).toBe("partial");
    expect(e[1]!.dropped).toEqual([{ field: "name", why: "near-duplicate" }, { field: "shape", why: "taken" }, { field: "mark", why: "taken" }]);
    expect(e[1]!.nudged!.from).toBe(0xff5ab4);
    expect(r.identities[1]!.color).toBe(e[1]!.nudged!.to);
    expect(r.identities[1]!.eyes).toBe("slit");
    expect(e[2]).toMatchObject({ outcome: "fallback-timeout", kept: [] });
    expect(e[3]).toMatchObject({ outcome: "fallback-invalid", kept: [] });
    expect((await suitUp(77, [{ provider: broken, soul: souls[0]! }, { provider: null, soul: souls[1]! }, { provider: null, soul: souls[2]! }, { provider: null, soul: souls[3]! }])).entries).toEqual([expect.objectContaining({ seat: 0, outcome: "fallback-error" })]);
    // all four distinct in the usual ways
    const ids = r.identities;
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
      expect(nearDuplicateName(ids[i]!.name, ids[j]!.name)).toBe(false);
      expect(ids[i]!.mark).not.toBe(ids[j]!.mark);
      expect(oklabDistance(ids[i]!.color, ids[j]!.color)).toBeGreaterThanOrEqual(MIN_COLOR_DISTANCE);
    }
    expect(logs.some((l) => l.includes("seat 2") && l.includes("fallback-timeout"))).toBe(true);
    expect(logs.some((l) => l.includes("replaced name (near-duplicate)"))).toBe(true);
  });

  test("an agent's join look is a suit-up too; seats with nothing asked keep the seeded identity (identical to no suit-up)", async () => {
    const r = await suitUp(5, [{ provider: null, soul: souls[0]!, agentLook: { name: "Brixel", color: 0x33ccff }, agentLine: "Hi." }, { provider: null, soul: souls[1]! }, { provider: null, soul: souls[2]! }, { provider: null, soul: souls[3]! }]);
    expect(r.entries).toEqual([expect.objectContaining({ seat: 0, by: "agent", outcome: "ok", kept: ["name", "color"], line: "Hi." })]);
    expect(r.identities[0]!.name).toBe("Brixel");
    const none = await suitUp(5, souls.map((soul) => ({ provider: null, soul })));
    expect(none.entries).toEqual([]);
    expect(none.identities).toEqual(generateIdentities(5));
  });

  test("settling is deterministic, and the record carries the choice: the replay needs no AI", async () => {
    const seats = [0, 1, 2, 3].map((i) => ({ provider: i === 1 ? answer({ name: "Mopsy", shape: "cloud", color: "#88ddff", mark: "halo", line: "Please don't." }) : null, soul: souls[i]! }));
    const r = await suitUp(42, seats);
    expect(settleSuitUp(42, r.answers).identities).toEqual(r.identities);
    const runner = new MatchRunner({ seed: 42, seats: souls.map((soul) => ({ providerName: "house", provider: null, soul })), suitUp: r });
    expect(runner.match.identities).toEqual(r.identities);
    expect(runner.match.record.suitUp).toEqual(r.entries);
    const events: unknown[] = [];
    runner.opts.onEvent = (e) => events.push(e);
    runner.start();
    expect(events[0]).toMatchObject({ type: "match", suitUp: r.entries });
    await runner.run();
    const rec = JSON.parse(JSON.stringify(runner.savedRecord()));
    const again = new Match(42, { recorded: rec });
    expect(again.identities).toEqual(r.identities);
    expect(again.record.suitUp).toEqual(r.entries);
    expect(replayMatch(rec).record.rounds.map((x) => x.fight.finalHash)).toEqual(runner.match.record.rounds.map((x) => x.fight.finalHash));
  });

  test("a soul is personality only: the suit-up prompt differs by soul", () => {
    const coward = parseSoul(readFileSync("souls/rat.md", "utf8"), 2, "rat").soul;
    const bruiser = parseSoul(readFileSync("souls/brawler.md", "utf8"), 0, "brawler").soul;
    expect(suitUpPrompt(coward)).not.toBe(suitUpPrompt(bruiser));
  });
});
