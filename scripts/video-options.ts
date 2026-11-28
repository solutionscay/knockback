export class OptionError extends Error {}

export function videoFlags(argv: string[], options: readonly string[], switches: readonly string[], paths?: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      if (!paths) throw new OptionError(`unexpected argument: ${a}`);
      paths.push(a);
      continue;
    }
    const [k, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
    if (paths && !options.includes(k)) throw new OptionError(`unknown option --${k}`);
    const boolean = switches.includes(k);
    const v = boolean ? "true" : (inline ?? argv[++i]);
    if (v === undefined || (!boolean && v.startsWith("--"))) throw new OptionError(`--${k} needs a value`);
    if (!paths && !options.includes(k)) throw new OptionError(`unknown option --${k}`);
    flags.set(k, v);
  }
  return flags;
}

export function serverSource(url: string): { kind: "server"; url: string } {
  if (!/^https?:\/\/[\w.-]+(:\d+)?\/?$/.test(url)) throw new OptionError("--server must be a base URL like http://localhost:5176");
  return { kind: "server", url: url.replace(/\/$/, "") };
}
