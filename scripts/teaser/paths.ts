/**
 * Where bun run teaser works and where it delivers. All scratch (frames, sound cues, the WAV, the encodes in
 * progress) stays on the local disk, in a folder of its own under os.tmpdir() or --work; only the finished files
 * are copied to --out. A slow or network --out (a share) then costs one copy of the results, not the frame I/O
 * (on the share, a 1080p encode took 552 s instead of ~170 s).
 */
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export interface TeaserPaths {
  /** this run's scratch folder (created by the run; the only thing it deletes) */
  work: string;
  frames: string;
  audio: string;
  cues: string;
  plan: string;
  /** AI match records for --best-of */
  aiMatches: string;
  /** finished files before they are copied to `out` */
  staging: string;
  out: string;
}

/**
 * The paths of one run. `workRoot` = --work or os.tmpdir(); the run gets its own sub-folder there (`tag` makes it
 * unique). Scratch is never put inside `out`: if --work points into --out, the tmp dir is used instead.
 */
export function teaserPaths(out: string, workRoot: string, tag: string, tmp: string): TeaserPaths {
  const o = resolve(out);
  let root = resolve(workRoot);
  const inside = (a: string, b: string) => {
    const r = relative(b, a);
    return r === "" || (!r.startsWith("..") && !r.startsWith("/"));
  };
  if (inside(root, o)) root = resolve(tmp);
  const work = join(root, `knockback-teaser-${tag.replace(/[^\w.-]/g, "_")}`);
  return {
    work,
    frames: join(work, "frames"),
    audio: join(work, "audio.wav"),
    cues: join(work, "cues.json"),
    plan: join(work, "plan.json"),
    aiMatches: join(work, "ai-matches"),
    staging: join(work, "out"),
    out: o,
  };
}

/** Copy the finished files (everything in staging: MP4s, stills, README, match.json, timing.json) to out. */
export function deliver(p: TeaserPaths): { file: string; bytes: number }[] {
  mkdirSync(p.out, { recursive: true });
  return readdirSync(p.staging)
    .filter((f) => statSync(join(p.staging, f)).isFile())
    .sort()
    .map((f) => {
      copyFileSync(join(p.staging, f), join(p.out, f));
      return { file: join(p.out, f), bytes: statSync(join(p.out, f)).size };
    });
}

/** Remove this run's scratch folder (and nothing else). */
export function cleanup(p: TeaserPaths) {
  if (!/knockback-teaser-[\w.-]+$/.test(p.work)) throw new Error(`refusing to delete ${p.work}`);
  rmSync(p.work, { recursive: true, force: true });
}
