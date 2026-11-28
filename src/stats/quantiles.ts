/** The upper bucket at exact boundaries, used in balance reports. */
export function sampleQuantile(values: readonly number[], fraction: number): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
}

/** Nearest-rank percentile, used in latency and stalled-pursuit reports. */
export function nearestRank(values: readonly number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, index))]!;
}
