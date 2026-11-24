/** IPv4/IPv6 CIDR matching for the trusted-proxy check (no dependencies). */

type Cidr = { v6: boolean; bits: bigint; prefix: number };

function toBig(ip: string): { v6: boolean; n: bigint } | null {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1]!;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    const parts = ip.split(".").map(Number);
    if (parts.some((x) => x > 255)) return null;
    return { v6: false, n: parts.reduce((a, x) => (a << 8n) | BigInt(x), 0n) };
  }
  if (!ip.includes(":") || !/^[0-9a-f:]+$/i.test(ip)) return null;
  const [head, tail = ""] = ip.split("::") as [string, string?];
  if (ip.split("::").length > 2) return null;
  const h = head ? head.split(":") : [];
  const t = ip.includes("::") ? (tail ? tail.split(":") : []) : [];
  const fill = ip.includes("::") ? 8 - h.length - t.length : 0;
  const groups = [...h, ...Array(Math.max(0, fill)).fill("0"), ...t];
  if (groups.length !== 8) return null;
  return { v6: true, n: groups.reduce((a, g) => (a << 16n) | BigInt(parseInt(g || "0", 16)), 0n) };
}

export function parseCidrs(list: string): Cidr[] {
  return list
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((c) => {
      const [ip, p] = c.split("/") as [string, string?];
      const b = toBig(ip);
      if (!b) throw new Error(`bad CIDR: ${c}`);
      const prefix = p === undefined ? (b.v6 ? 128 : 32) : Number(p);
      return { v6: b.v6, bits: b.n, prefix };
    });
}

export function inCidrs(ip: string, cidrs: Cidr[]): boolean {
  const b = toBig(ip);
  if (!b) return false;
  return cidrs.some((c) => {
    if (c.v6 !== b.v6) return false;
    const width = c.v6 ? 128n : 32n;
    const shift = width - BigInt(c.prefix);
    return b.n >> shift === c.bits >> shift;
  });
}
