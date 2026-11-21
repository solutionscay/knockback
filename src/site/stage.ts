/**
 * The fight on the site pages is the real viewer in a same-origin iframe (`?embed`, see src/viewer/embed.ts).
 * This side listens to its playback position and live messages, and sends seek and speed for replays.
 */
import type { PlaybackPos } from "../viewer/embed";

export interface StageEvents {
  pos?: (p: PlaybackPos | null) => void;
  live?: (msg: unknown) => void;
  seeking?: (on: boolean) => void;
}

export class Stage {
  readonly frame: HTMLIFrameElement;
  src = "";
  pos: PlaybackPos | null = null;

  constructor(
    readonly box: HTMLElement,
    private ev: StageEvents = {},
  ) {
    this.frame = document.createElement("iframe");
    this.frame.title = "Knockback fight";
    this.frame.allow = "autoplay; fullscreen";
    box.prepend(this.frame);
    addEventListener("message", (e) => {
      if (e.origin !== location.origin || e.source !== this.frame.contentWindow || !e.data || typeof e.data !== "object") return;
      const d = e.data as { kb?: string; pos?: PlaybackPos | null; msg?: unknown; on?: boolean };
      if (d.kb === "pos") {
        this.pos = d.pos ?? null;
        this.ev.pos?.(this.pos);
      } else if (d.kb === "live") this.ev.live?.(d.msg);
      else if (d.kb === "seeking") this.ev.seeking?.(!!d.on);
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

  speed(x: number) {
    this.frame.contentWindow?.postMessage({ kb: "speed", speed: x }, location.origin);
  }
}
