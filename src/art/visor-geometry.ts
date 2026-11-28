import type { Mat } from "./affine";
import { COLS, FEET_Y, K, P, ROWS } from "./bot";

/** The code face's visor in its own meters (bot.ts drawVisor): center line, half width, half height. */
const FACE_CY = (15.5 - 3.5) * K - FEET_Y;
const VHW = ((COLS * P + 1.4) / 2) * K;
const VHH = ((ROWS * P + 1.4) / 2) * K;
/** The code face -> the rendered visor (as plush-bot.ts: centered between the visor's side points). */
export function faceMatrix(points: readonly [number, number][]): Mat {
  const [c0, r, u, l] = points;
  const c = [(r![0] + l![0]) / 2, (r![1] + l![1]) / 2] as const;
  const a = (r![0] - c[0]) / (0.8 * VHW), b = (r![1] - c[1]) / (0.8 * VHW);
  const cc = -(u![0] - c0![0]) / (0.78 * VHH), d = -(u![1] - c0![1]) / (0.78 * VHH);
  return [a, b, cc, d, c[0] - cc * FACE_CY, c[1] - d * FACE_CY];
}
