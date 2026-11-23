/**
 * The plush marks in motion (plush-bot.ts). Pure: which frame of a mark's sheet to draw.
 */

/** Marks that hang from the torso (the others ride on the head); the cape hangs behind the body. */
export const TORSO_MARKS = new Set(["cape", "scarf"]);
export const BEHIND_MARKS = new Set(["cape"]);
/** Marks in motion: flapping (headband, cape, scarf: ping-pong frames), spinning (propeller), whipping (antenna). */
export const FLAP_MARKS = new Set(["headband", "cape", "scarf"]);

/**
 * The frame of a mark in motion (n frames in its sheet): a flap (0 1 2 1 ...) by the clock, faster with the speed
 * (m/s); the propeller's spin by the clock; the antenna by its spring angle whip (-1..1: frame 0 leans one way, n-1
 * the other, the middle frame is upright). A mark with one frame is 0.
 */
export function markFrame(mark: string, n: number, clock: number, speed: number, whip: number): number {
  if (n <= 1) return 0;
  if (FLAP_MARKS.has(mark)) {
    const seq = [...Array.from({ length: n }, (_, i) => i), ...Array.from({ length: n - 2 }, (_, i) => n - 2 - i)];
    return seq[Math.floor(clock * (5 + Math.min(6, Math.abs(speed)) * 0.9)) % seq.length]!;
  }
  if (mark === "propeller") return Math.floor(clock * 16) % n;
  if (mark === "antenna") return Math.max(0, Math.min(n - 1, Math.round(((whip + 1) / 2) * (n - 1))));
  return 0;
}
