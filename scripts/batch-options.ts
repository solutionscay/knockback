/** House bots without plan rules (#6 A/B). */
export function houseRulesEnabled(args: string[]): boolean {
  return !args.includes("--house-rules=off") && args[args.indexOf("--house-rules") + 1] !== "off";
}

export function comparisonBatchOptions(argv: string[]) {
  const pos = argv.slice(2).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--house-rules");
  return { count: Number(pos[0] ?? 200), first: Number(pos[1] ?? 1), houseRules: houseRulesEnabled(argv) };
}

/** Bucket by index in the sorted sample, clamped to the last value. */
export function sampleQuantile(values: number[], fraction: number): number {
  const sorted = values.slice().sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
}
