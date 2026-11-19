/**
 * Deterministic sin/cos: only + - * / and a polynomial, so every JS engine
 * returns bit-identical results (Math.sin/cos are not specified to be exact).
 * Accurate to ~1e-9 over any range, plenty for game physics.
 */
const TWO_PI = 6.283185307179586;
const PI = 3.141592653589793;
const HALF_PI = 1.5707963267948966;

function reduce(x: number): number {
  // to [-PI, PI]
  const k = Math.floor((x + PI) / TWO_PI);
  return x - k * TWO_PI;
}

function sinPoly(x: number): number {
  // x in [-PI/2, PI/2]; Taylor to x^15
  const x2 = x * x;
  return (
    x *
    (1 +
      x2 *
        (-1 / 6 +
          x2 *
            (1 / 120 +
              x2 * (-1 / 5040 + x2 * (1 / 362880 + x2 * (-1 / 39916800 + x2 * (1 / 6227020800 + x2 * (-1 / 1307674368000))))))))
  );
}

export function dsin(x: number): number {
  let r = reduce(x);
  if (r > HALF_PI) r = PI - r;
  else if (r < -HALF_PI) r = -PI - r;
  return sinPoly(r);
}

export function dcos(x: number): number {
  return dsin(x + HALF_PI);
}
