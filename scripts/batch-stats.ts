/**
 * Statistics for the batch reports (#82): win-rate intervals, a one-sided exact test for "wins more", the Holm
 * correction for many comparisons, and a least-squares fit. Pure functions, no sim.
 */

/** Wilson score interval for w successes in n trials, 95% by default. [0, 1] when n is 0. */
export function wilson(w: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = w / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

const logFact: number[] = [0];
function lf(n: number): number {
  for (let i = logFact.length; i <= n; i++) logFact.push(logFact[i - 1]! + Math.log(i));
  return logFact[n]!;
}

/**
 * Fisher's exact test, one-sided: the chance that group A (wa wins of na) shows at least wa wins when both groups
 * share one win rate, given the total wins. A small value says A wins more than B.
 */
export function fisherGreater(wa: number, na: number, wb: number, nb: number): number {
  const k = wa + wb, n = na + nb;
  const hi = Math.min(k, na);
  const lnDen = lf(n) - lf(k) - lf(n - k);
  let p = 0;
  for (let x = wa; x <= hi; x++) {
    if (k - x > nb) continue;
    p += Math.exp(lf(na) - lf(x) - lf(na - x) + lf(nb) - lf(k - x) - lf(nb - k + x) - lnDen);
  }
  return Math.min(1, p);
}

/** Holm–Bonferroni: adjusted p-values in the input order (family-wise error at most alpha when adjusted < alpha). */
export function holm(ps: readonly number[]): number[] {
  const m = ps.length;
  const order = ps.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]);
  const out = Array<number>(m).fill(1);
  let run = 0;
  order.forEach(([p, i], rank) => {
    run = Math.max(run, Math.min(1, (m - rank) * p));
    out[i] = run;
  });
  return out;
}

/** Ordinary least squares: coefficients b minimizing |Xb - y|², and their covariance matrix. */
export function leastSquares(X: readonly number[][], y: readonly number[]): { b: number[]; cov: number[][] } {
  const k = X[0]!.length, n = X.length;
  const A = Array.from({ length: k }, () => Array<number>(k).fill(0));
  const v = Array<number>(k).fill(0);
  for (let r = 0; r < n; r++) {
    const x = X[r]!;
    for (let i = 0; i < k; i++) {
      v[i]! += x[i]! * y[r]!;
      for (let j = 0; j < k; j++) A[i]![j]! += x[i]! * x[j]!;
    }
  }
  const inv = invert(A);
  const b = inv.map((row) => row.reduce((s, a, j) => s + a * v[j]!, 0));
  let rss = 0;
  for (let r = 0; r < n; r++) {
    const e = y[r]! - X[r]!.reduce((s, a, j) => s + a * b[j]!, 0);
    rss += e * e;
  }
  const s2 = rss / Math.max(1, n - k);
  return { b, cov: inv.map((row) => row.map((a) => a * s2)) };
}

function invert(M: number[][]): number[][] {
  const n = M.length;
  const a = M.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[p]![c]!)) p = r;
    if (Math.abs(a[p]![c]!) < 1e-12) throw new Error("singular design");
    [a[c], a[p]] = [a[p]!, a[c]!];
    const d = a[c]![c]!;
    for (let j = 0; j < 2 * n; j++) a[c]![j]! /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r]![c]!;
      if (f !== 0) for (let j = 0; j < 2 * n; j++) a[r]![j]! -= f * a[c]![j]!;
    }
  }
  return a.map((row) => row.slice(n));
}
