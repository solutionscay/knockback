/**
 * Contract: the statistics the builds balance report (#82) rests on. The Wilson interval, the one-sided Fisher test and
 * the Holm correction give the textbook values, so a "within noise" or "wins significantly more" verdict in a batch
 * report means what the report says it means.
 *
 * Pure functions. No sim, no real time, no network, no provider.
 */
import { describe, expect, test } from "bun:test";
import { fisherGreater, holm, wilson } from "../scripts/batch-stats";

describe("batch statistics", () => {
  test("Wilson 95% interval: textbook values, inside [0, 1] at the edges", () => {
    // 10 of 20: 0.5 ± 0.2004 (centre 0.5); 0 of 10: [0, 0.2775]
    const [lo, hi] = wilson(10, 20);
    expect(lo).toBeCloseTo(0.2993, 4);
    expect(hi).toBeCloseTo(0.7007, 4);
    const [lo0, hi0] = wilson(0, 10);
    expect(lo0).toBe(0);
    expect(hi0).toBeCloseTo(0.2775, 4);
    expect(wilson(10, 10)[1]).toBe(1);
    // more fighter-rounds, a narrower interval around the same rate
    expect(wilson(100, 400)[1] - wilson(100, 400)[0]).toBeLessThan(wilson(25, 100)[1] - wilson(25, 100)[0]);
  });

  test("Fisher's exact test, one-sided: the hypergeometric tail", () => {
    // the tea-tasting table: 3 of 4 right against 1 of 4 → P(X ≥ 3) = (16 + 1) / 70
    expect(fisherGreater(3, 4, 1, 4)).toBeCloseTo(17 / 70, 12);
    expect(fisherGreater(4, 4, 0, 4)).toBeCloseTo(1 / 70, 12);
    // one-sided: a group that wins less is never "more"
    expect(fisherGreater(1, 4, 3, 4)).toBeCloseTo(69 / 70, 12);
    // large groups: 130 of 400 against 100 of 400 is significant at 5%, 110 of 400 is not
    expect(fisherGreater(130, 400, 100, 400)).toBeLessThan(0.05);
    expect(fisherGreater(110, 400, 100, 400)).toBeGreaterThan(0.05);
  });

  test("Holm: step-down adjusted p-values in input order, monotone, capped at 1", () => {
    holm([0.01, 0.04, 0.03, 0.2]).forEach((p, i) => expect(p).toBeCloseTo([0.04, 0.09, 0.09, 0.2][i]!, 12));
    expect(holm([0.5, 0.5])).toEqual([1, 1]);
    // one comparison is not corrected
    expect(holm([0.03])).toEqual([0.03]);
  });
});
