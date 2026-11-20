/** Command-line options of `bun run teaser` (docs/video.md). Pure: tested in tests/teaser.test.ts. */

export type Source = { kind: "record"; file: string } | { kind: "seed"; seed: number } | { kind: "best-of"; n: number } | { kind: "server"; url: string };

export interface TeaserOptions {
  source: Source;
  out: string;
  /** output heights, largest first (1080 and/or 720) */
  sizes: number[];
  fps: 30 | 60;
  /** quick preview: 30 fps, 720p only, fast encode (unless --fps / --sizes say otherwise) */
  fast: boolean;
  /** parallel browser pages for the capture */
  workers: number;
  /** keep the captured frames (they are deleted after a successful encode) */
  keepFrames: boolean;
}

export const USAGE = `bun run teaser [--record <file> | --seed <n> | --best-of <n> | --server <url>] [--out <dir>] [--sizes 1080,720] [--fps 30|60] [--fast] [--workers <n>] [--keep-frames]
  --record <file>   a saved match record (records/*.json)
  --seed <n>        a house-bot match with this seed (no AI calls)
  --best-of <n>     play n real AI matches headless (default providers), keep the one with the most action per second
  --server <url>    the newest finished match of a running match server (e.g. http://localhost:5176)
  --out <dir>       output folder (default: videos/<seed>-<date>)
  --sizes 1080,720  output heights (default 1080,720; the 720p copy stays under 30 MB)
  --fps 30|60       frame rate (default 60; --fast: 30)
  --fast            quick preview: 30 fps, 720p only, fast encode
  --workers <n>     parallel capture pages (default 6)
  --keep-frames     keep the captured JPEG frames`;

export class OptionError extends Error {}

export function parseTeaserArgs(argv: string[], now = new Date()): TeaserOptions {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new OptionError(`unexpected argument: ${a}`);
    const [k, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
    const boolean = k === "fast" || k === "keep-frames" || k === "help";
    const v = boolean ? "true" : (inline ?? argv[++i]);
    if (v === undefined || (!boolean && v.startsWith("--"))) throw new OptionError(`--${k} needs a value`);
    if (!["record", "seed", "best-of", "server", "out", "sizes", "fps", "fast", "workers", "keep-frames", "help"].includes(k)) throw new OptionError(`unknown option --${k}`);
    flags.set(k, v);
  }
  if (flags.has("help")) throw new OptionError(USAGE);
  const sources = ["record", "seed", "best-of", "server"].filter((k) => flags.has(k));
  if (sources.length > 1) throw new OptionError(`pick one source: ${sources.map((s) => `--${s}`).join(", ")}`);
  const int = (k: string, min: number, max: number) => {
    const n = Number(flags.get(k));
    if (!Number.isInteger(n) || n < min || n > max) throw new OptionError(`--${k} must be a whole number ${min}-${max}`);
    return n;
  };
  let source: Source;
  if (flags.has("record")) source = { kind: "record", file: flags.get("record")! };
  else if (flags.has("seed")) source = { kind: "seed", seed: int("seed", 0, 0xffffffff) };
  else if (flags.has("best-of")) source = { kind: "best-of", n: int("best-of", 1, 12) };
  else if (flags.has("server")) {
    const url = flags.get("server")!;
    if (!/^https?:\/\/[\w.-]+(:\d+)?\/?$/.test(url)) throw new OptionError("--server must be a base URL like http://localhost:5176");
    source = { kind: "server", url: url.replace(/\/$/, "") };
  } else throw new OptionError(`pick a source: --record, --seed, --best-of or --server\n${USAGE}`);
  const fast = flags.has("fast");
  const fps = flags.has("fps") ? Number(flags.get("fps")) : fast ? 30 : 60;
  if (fps !== 30 && fps !== 60) throw new OptionError("--fps must be 30 or 60");
  const sizes = flags.has("sizes")
    ? [...new Set(flags.get("sizes")!.split(",").map((s) => Number(s.trim().replace(/p$/, ""))))].sort((a, b) => b - a)
    : fast
      ? [720]
      : [1080, 720];
  if (!sizes.length || sizes.some((s) => s !== 1080 && s !== 720)) throw new OptionError("--sizes takes 1080 and/or 720");
  const stamp = now.toISOString().slice(0, 16).replace(/[:T]/g, "-");
  return {
    source,
    out: flags.get("out") ?? `videos/${source.kind === "seed" ? source.seed : source.kind}-${stamp}`,
    sizes,
    fps,
    fast,
    workers: flags.has("workers") ? int("workers", 1, 16) : 6,
    keepFrames: flags.has("keep-frames"),
  };
}
