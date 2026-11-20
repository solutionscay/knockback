/**
 * Video mode (?capture&video): what the video pipeline (bun run teaser, docs/video.md) needs from the viewer.
 * - the camera stays on View all: no zoom on the talking bot or the winner, no K.O. slow motion (game.videoMode)
 * - a clean screen: no camera bar, no buttons, no SKIP / SPACE hints (body.video)
 * - one caption box, set per frame by the pipeline (start and end captions)
 * - a frame-accurate timeline: the beat at every frame and the sim tick during fights, so the pipeline can plan
 *   its cuts from one quick scan
 */

const CSS = `
body.video #cam, body.video #controls, body.video #dialogue .skip, body.video #dialogue .hint { display: none !important; }
#video-caption { position: absolute; left: 50%; transform: translateX(-50%); z-index: 20; display: none; text-align: center;
  background: rgba(8, 10, 20, 0.86); border-radius: 2.2vh; padding: 1.4vh 3.6vh; color: #fff; font-weight: 800;
  font-family: "Helvetica Neue", Arial, system-ui, sans-serif; white-space: nowrap; }
#video-caption.show { display: block; }
#video-caption.start { top: 9vh; font-size: 4.6vh; }
#video-caption.end { bottom: 7vh; }
#video-caption.end b { display: block; color: #ffd23f; font-size: 6.4vh; letter-spacing: 0.02em; }
#video-caption.end span { display: block; color: #dce2f0; font-size: 3.4vh; margin-top: 0.4vh; }
#video-tag { position: absolute; right: 2vh; top: 8.5vh; z-index: 20; display: none; padding: 0.5vh 1.4vh; border-radius: 99px;
  background: rgba(8, 10, 20, 0.8); border: 0.25vh solid #ffd23f; color: #ffd23f; font: 800 2.6vh "Helvetica Neue", Arial, sans-serif; }
#video-tag.show { display: block; }
`;

/** Turn on the clean screen and add the caption box. */
export function enableVideoMode() {
  document.body.classList.add("video");
  const st = document.createElement("style");
  st.textContent = CSS;
  document.head.appendChild(st);
  const box = document.createElement("div");
  box.id = "video-caption";
  document.body.appendChild(box);
  const tag = document.createElement("div");
  tag.id = "video-tag";
  tag.textContent = "2×";
  document.body.appendChild(tag);
}

/** The small "2×" tag over a sped-up quiet stretch. */
export function setVideoTag(on: boolean) {
  document.getElementById("video-tag")?.classList.toggle("show", on);
}

/** Show a caption ("start": one line at the top; "end": a title and a line at the bottom), or hide it (null). */
export function setVideoCaption(c: { kind: "start" | "end"; title?: string; text: string } | null) {
  const box = document.getElementById("video-caption");
  if (!box) return;
  if (!c) {
    box.className = "";
    return;
  }
  box.replaceChildren();
  if (c.title) {
    const b = document.createElement("b");
    b.textContent = c.title;
    box.append(b);
  }
  const s = document.createElement(c.kind === "end" ? "span" : "div");
  s.textContent = c.text;
  box.append(s);
  box.className = `show ${c.kind}`;
}

/** The beat timeline of a capture: one entry per beat change, and the sim tick at every frame. */
export interface Timeline {
  /** frame = the number of advance steps done when this beat was first seen (frame 1 = after the first step) */
  beats: { frame: number; kind: string; round: number; index: number; value?: number; fighter?: number }[];
  /** sim tick of the shown fight after each frame (index 0 = frame 1) */
  ticks: number[];
  frames: number;
}

export class TimelineLog implements Timeline {
  beats: Timeline["beats"] = [];
  ticks: number[] = [];
  frames = 0;
  private last = -1;

  /** After each game.update in capture mode. */
  record(beat: { kind: string; value?: number; fighter?: number }, index: number, round: number, tick: number) {
    this.frames++;
    this.ticks.push(tick);
    if (index !== this.last) {
      this.last = index;
      this.beats.push({ frame: this.frames, kind: beat.kind, round, index, ...(beat.value !== undefined ? { value: beat.value } : {}), ...(beat.fighter !== undefined ? { fighter: beat.fighter } : {}) });
    }
  }
}
