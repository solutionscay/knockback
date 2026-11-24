/**
 * The fight on the site pages is the real viewer in a same-origin iframe (`?embed`, see src/viewer/embed.ts).
 * This side listens to its playback position and live messages, and sends seek and speed for replays.
 */
import type { PlanEvent, PlaybackPos } from "../viewer/embed";

export interface StageEvents {
  pos?: (p: PlaybackPos | null) => void;
  live?: (msg: unknown) => void;
  seeking?: (on: boolean) => void;
  /** rule starts/stops and knockouts as the fight plays (#104) */
  ev?: (round: number, e: PlanEvent) => void;
}

export class Stage {
  readonly frame: HTMLIFrameElement;
  src = "";
  pos: PlaybackPos | null = null;
  /** the fighter the viewer's camera follows (-1: none) */
  follow = -1;

  constructor(
    readonly box: HTMLElement,
    private ev: StageEvents = {},
  ) {
    this.frame = document.createElement("iframe");
    this.frame.title = "Knockback fight";
    this.frame.allow = "autoplay; fullscreen";
    box.prepend(this.frame);
    // sound is on by default: any gesture on the page starts the viewer's audio (browsers need one per page)
    const unlock = () => this.frame.contentWindow?.postMessage({ kb: "unlock" }, location.origin);
    for (const ev of ["pointerdown", "keydown", "touchstart"]) addEventListener(ev, unlock, { capture: true, passive: true });
    this.frame.addEventListener("load", unlock);
    addEventListener("message", (e) => {
      if (e.origin !== location.origin || e.source !== this.frame.contentWindow || !e.data || typeof e.data !== "object") return;
      const d = e.data as { kb?: string; pos?: PlaybackPos | null; msg?: unknown; on?: boolean; follow?: number; round?: number; e?: PlanEvent };
      if (d.kb === "pos") {
        this.pos = d.pos ?? null;
        this.follow = typeof d.follow === "number" ? d.follow : -1;
        this.ev.pos?.(this.pos);
      } else if (d.kb === "live") this.ev.live?.(d.msg);
      else if (d.kb === "seeking") this.ev.seeking?.(!!d.on);
      else if (d.kb === "ev" && typeof d.round === "number" && d.e && typeof d.e === "object") this.ev.ev?.(d.round, d.e);
    });
  }

  /** Show a live match (its stream replays from round 1 for late joiners). */
  live(matchId: string) {
    this.load(`/?live&embed&match=${encodeURIComponent(matchId)}`);
  }

  /** Show the Arena live (#64): its stream goes on from round to round; the viewer starts each new round itself. */
  arena() {
    this.load("/?live&embed");
  }

  /** Show a saved record. */
  record(path: string) {
    this.load(`/?record=${encodeURIComponent(path)}&embed`);
  }

  /** Nothing on stage: unload the viewer. */
  stop() {
    if (!this.src) return;
    this.src = "";
    this.pos = null;
    this.frame.src = "about:blank";
  }

  private load(src: string) {
    if (src === this.src) return;
    this.src = src;
    this.pos = null;
    this.frame.src = src;
  }

  seek(to: PlaybackPos) {
    this.frame.contentWindow?.postMessage({ kb: "seek", to }, location.origin);
  }

  /** the camera follows fighter `id` (-1: back to auto) */
  followFighter(id: number) {
    this.follow = id;
    this.frame.contentWindow?.postMessage({ kb: "follow", id }, location.origin);
  }

  speed(x: number) {
    this.frame.contentWindow?.postMessage({ kb: "speed", speed: x }, location.origin);
  }
}
