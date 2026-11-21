/**
 * Capture for bun run teaser: a private viewer server, one quick scan for the beat timeline, then parallel
 * browser pages, each stepping its own chunk of frames (the game is deterministic, so every page sees the same
 * match) and saving JPEGs plus the sound cues of every frame.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import index from "../../index.html";
import type { LoggedCue } from "../../src/viewer/audio/engine";
import { chunks, type Plan, type Timeline } from "./plan";

export const START_CAPTION = "Claude, Codex and Grok plan the fight";
export const END_TITLE = "KNOCKBACK";
export const END_TEXT = "AI agents plan. Physics decides.";

/** Serve the viewer and one record (as /records/match.json) on a free port. */
export function serveViewer(recordJson: string) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes: { "/": index },
    development: false,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/records/match.json") return new Response(recordJson, { headers: { "content-type": "application/json" } });
      return new Response("Not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

export async function launch(): Promise<Browser> {
  return chromium.launch({ args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });
}

async function openPage(browser: Browser, base: string, w: number, h: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/?record=/records/match.json&capture&video&sounds=off`);
  await page.waitForFunction(() => (window as unknown as { __kb?: { ready: boolean } }).__kb?.ready, null, { timeout: 60000 });
  if (errors.length) throw new Error(`viewer error: ${errors[0]}`);
  if (await page.$("#refused")) throw new Error("the viewer refused this record (not a current-engine match record)");
  return page;
}

type Kb = {
  advance(dt: number, frames?: number, render?: boolean): void;
  state(): { finished: boolean; beat: string };
  timeline(): Timeline;
  drainSounds(): LoggedCue[];
  caption(c: { kind: "start" | "end"; title?: string; text: string } | null): void;
  tag(on: boolean): void;
};

/** Run the whole match once without drawing: the beat at every frame and the sim tick during fights. */
export async function scanTimeline(browser: Browser, base: string): Promise<Timeline> {
  const page = await openPage(browser, base, 640, 360);
  for (let i = 0; i < 400; i++) {
    const done = await page.evaluate(() => {
      const kb = (window as unknown as { __kb: Kb }).__kb;
      kb.advance(1 / 60, 300, false);
      kb.drainSounds();
      return kb.state().finished;
    });
    if (done) break;
  }
  const t = await page.evaluate(() => {
    const tl = (window as unknown as { __kb: Kb }).__kb.timeline();
    return { beats: tl.beats, ticks: tl.ticks, frames: tl.frames };
  });
  await page.close();
  return t;
}

export interface CaptureResult {
  /** sound cues with the source frame they happened in */
  cues: (LoggedCue & { frame: number })[];
  frames: number;
}

/**
 * Capture the plan's frames with `workers` pages in parallel. JPEGs go to framesDir as %06d.jpg (output index).
 * onProgress gets the number of frames saved so far.
 */
export async function captureFrames(browser: Browser, base: string, plan: Plan, size: { w: number; h: number }, workers: number, framesDir: string, onProgress?: (n: number) => void): Promise<CaptureResult> {
  mkdirSync(framesDir, { recursive: true });
  const parts = chunks(plan.frames, workers);
  let saved = 0;
  const results = await Promise.all(
    parts.map(async (part, pi) => {
      const page = await openPage(browser, base, size.w, size.h);
      const cdp = await page.context().newCDPSession(page);
      // sound cues from right after the previous chunk, so frames between chunks (skipped by a step) keep theirs
      const first = pi === 0 ? 1 : parts[pi - 1]![parts[pi - 1]!.length - 1]!.src + 1;
      const last = part[part.length - 1]!.src;
      const want = new Map(part.map((f) => [f.src, f]));
      // fast-forward without drawing to just before this chunk
      let frame = 0;
      while (frame < first - 1) {
        const n = Math.min(600, first - 1 - frame);
        await page.evaluate((k) => {
          const kb = (window as unknown as { __kb: Kb }).__kb;
          kb.advance(1 / 60, k, false);
          kb.drainSounds();
        }, n);
        frame += n;
      }
      const cues: CaptureResult["cues"] = [];
      let caption: string | null = null;
      let tag = false;
      while (frame < last) {
        frame++;
        const f = want.get(frame);
        const capNow: string | null = f ? f.caption : caption;
        const tagNow: boolean = f ? f.tag : tag;
        const got = await page.evaluate(
          ([draw, cap, cKind, tg, tChange]) => {
            const kb = (window as unknown as { __kb: Kb }).__kb;
            if (cKind) kb.caption(cap === "start" ? { kind: "start", text: cKind[0] } : cap === "end" ? { kind: "end", title: cKind[1], text: cKind[2] } : null);
            if (tChange) kb.tag(tg);
            kb.advance(1 / 60, 1, draw);
            return kb.drainSounds();
          },
          [!!f, capNow, capNow !== caption ? [START_CAPTION, END_TITLE, END_TEXT] : null, tagNow, tagNow !== tag] as const,
        );
        caption = capNow;
        tag = tagNow;
        for (const c of got) cues.push({ ...c, frame });
        if (f) {
          const r = (await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 90, optimizeForSpeed: true })) as { data: string };
          writeFileSync(join(framesDir, `${String(f.out).padStart(6, "0")}.jpg`), Buffer.from(r.data, "base64"));
          onProgress?.(++saved);
        }
      }
      await page.close();
      return cues;
    }),
  );
  return { cues: results.flat(), frames: saved };
}
