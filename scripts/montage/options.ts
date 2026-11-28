/** Command-line options of `bun run montage` (docs/video.md). */
import { OptionError, serverSource, videoFlags } from "../video-options";
import { GPU_ENV, resolveGpu, type GpuBackend } from "../viewer-browser";

export type MontageSource = { kind: "paths"; paths: string[] } | { kind: "server"; url: string };

export interface MontageOptions {
  source: MontageSource;
  out: string;
  workers: number;
  work: string | null;
  keepWork: boolean;
  /** the capture browser's GPU backend: --gpu, else KB_TEASER_GPU, else swiftshader */
  gpu: GpuBackend;
}

export const MONTAGE_USAGE = `bun run montage <records folder | record files...> | --server <url>  [--out <dir>] [--workers <n>] [--work <dir>] [--keep-work] [--gpu swiftshader|metal|default]
  <folder|files>    match records (records/*.json): the montage cuts the best moments of all of them
  --server <url>    the newest finished records with AI agents of a running match server (e.g. http://localhost:5176)
  --out <dir>       output folder (default: videos/montage-<date>)
  --workers <n>     parallel capture pages (default 3)
  --work <dir>      scratch folder for frames, sound and encodes (default: the system temp dir; keep it local)
  --keep-work       keep the scratch folder after the run
  --gpu <backend>   capture browser GPU: swiftshader (default, CPU), metal or default (Chromium picks); env KB_TEASER_GPU`;

export function parseMontageArgs(argv: string[], now = new Date(), env: string | undefined = process.env[GPU_ENV]): MontageOptions {
  const paths: string[] = [];
  const flags = videoFlags(argv, ["server", "out", "workers", "work", "keep-work", "gpu", "help"], ["keep-work", "help"], paths);
  if (flags.has("help")) throw new OptionError(MONTAGE_USAGE);
  let source: MontageSource;
  if (flags.has("server")) {
    if (paths.length) throw new OptionError("pick one source: record paths or --server");
    source = serverSource(flags.get("server")!);
  } else if (paths.length) source = { kind: "paths", paths };
  else throw new OptionError(`give records (a folder or files) or --server\n${MONTAGE_USAGE}`);
  const workers = flags.has("workers") ? Number(flags.get("workers")) : 3;
  if (!Number.isInteger(workers) || workers < 1 || workers > 16) throw new OptionError("--workers must be a whole number 1-16");
  let gpu: GpuBackend;
  try {
    gpu = resolveGpu(flags.get("gpu"), env);
  } catch (e) {
    throw new OptionError((e as Error).message);
  }
  return {
    source,
    out: flags.get("out") ?? `videos/montage-${now.toISOString().slice(0, 16).replace(/[:T]/g, "-")}`,
    workers,
    work: flags.get("work") ?? null,
    keepWork: flags.has("keep-work"),
    gpu,
  };
}
