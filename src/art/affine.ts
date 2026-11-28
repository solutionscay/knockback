/** Column-major SVG/Pixi affine transform [a, b, c, d, tx, ty]. */
export type Mat = [number, number, number, number, number, number];

/** Compose two transforms, applying right before left. */
export function mul(left: Mat, right: Mat): Mat {
  const [a, b, c, d, tx, ty] = left;
  const [e, f, g, h, x, y] = right;
  return [a * e + c * f, b * e + d * f, a * g + c * h, b * g + d * h, a * x + c * y + tx, b * x + d * y + ty];
}
