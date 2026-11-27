/** Command-line options of `bun run montage` (docs/video.md). */
import { OptionError } from "../teaser/options";
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
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      paths.push(a);
      continue;
    }
    const [k, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
    if (!["server", "out", "workers", "work", "keep-work", "gpu", "help"].includes(k)) throw new OptionError(`unknown option --${k}`);
    const boolean = k === "keep-work" || k === "help";
    const v = boolean ? "true" : (inline ?? argv[++i]);
    if (v === undefined || (!boolean && v.startsWith("--"))) throw new OptionError(`--${k} needs a value`);
    flags.set(k, v);
  }
  if (flags.has("help")) throw new OptionError(MONTAGE_USAGE);
  let source: MontageSource;
  if (flags.has("server")) {
    if (paths.length) throw new OptionError("pick one source: record paths or --server");
    const url = flags.get("server")!;
    if (!/^https?:\/\/[\w.-]+(:\d+)?\/?$/.test(url)) throw new OptionError("--server must be a base URL like http://localhost:5176");
    source = { kind: "server", url: url.replace(/\/$/, "") };
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
