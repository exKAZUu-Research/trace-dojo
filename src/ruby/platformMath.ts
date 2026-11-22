// Godfrey's coefficients for the Lanczos approximation with g = 607/128, accurate to about 15 significant digits.
const LANCZOS_G = 607 / 128;
const LANCZOS_COEFFICIENTS = [
  0.9999999999999971, 57.15623566586292, -59.59796035547549, 14.136097974741746, -0.4919138160976202,
  3.399464998481189e-5, 4.652362892704858e-5, -9.837447530487956e-5, 1.580887032249125e-4, -2.1026444172410488e-4,
  2.1743961811521265e-4, -1.643181065367639e-4, 8.441822398385274e-5, -2.619083840158141e-5, 3.689918265953162e-6,
];
const HALF_LOG_TWO_PI = Math.log(2 * Math.PI) / 2;
/** Every larger argument has a gamma value beyond the largest double; the product below would yield NaN there. */
const MAX_FINITE_GAMMA_ARGUMENT = 172;
const TINY_ARGUMENT = 1e-17;
/** Below this argument the logarithm of the gamma value is more accurate than the sum of its logarithmic terms. */
const MAX_DIRECT_LOG_ARGUMENT = 16;

export const platformGamma = (value: number): number => {
  if (Number.isInteger(value) && value > 0 && value <= MAX_FINITE_GAMMA_ARGUMENT) {
    // The exact factorial is rounded once, where the approximation below loses the last digits.
    let factorial = 1n;
    for (let factor = 2n; factor < value; factor++) factorial *= factor;
    return Number(factorial);
  }
  if (value < 0.5) return Math.PI / (sinePi(value) * platformGamma(1 - value));
  if (value > MAX_FINITE_GAMMA_ARGUMENT) return Number.POSITIVE_INFINITY;
  const x = value - 1;
  const t = x + LANCZOS_G + 0.5;
  // The power is taken in two halves because it overflows before the product does.
  const halfPower = Math.pow(t, (x + 0.5) / 2);
  return Math.sqrt(2 * Math.PI) * halfPower * Math.exp(-t) * halfPower * lanczosSeries(x);
};

/** The logarithm of the absolute value of the gamma function, and the sign of the gamma function. */
export const platformLogGamma = (value: number): [number, number] => {
  if (value <= 0 && Number.isInteger(value)) return [Number.POSITIVE_INFINITY, 1];
  // Near zero the gamma function is 1/x to double precision, and the reflection below would round a subnormal product.
  if (Math.abs(value) < TINY_ARGUMENT) return [-Math.log(Math.abs(value)), value < 0 ? -1 : 1];
  if (value < 0.5) {
    const sine = sinePi(value);
    // The quotient of pi and a subnormal sine would overflow, so the logarithms are subtracted instead.
    return [Math.log(Math.PI) - Math.log(Math.abs(sine)) - platformLogGamma(1 - value)[0], sine < 0 ? -1 : 1];
  }
  if (value < MAX_DIRECT_LOG_ARGUMENT) return [Math.log(platformGamma(value)), 1];
  const x = value - 1;
  const t = x + LANCZOS_G + 0.5;
  return [HALF_LOG_TWO_PI + (x + 0.5) * Math.log(t) - t + Math.log(lanczosSeries(x)), 1];
};

/** sin(pi * x), reduced to the nearest integer first so that the distance from a pole keeps its precision. */
function sinePi(x: number): number {
  const nearest = Math.round(x);
  const sine = Math.sin(Math.PI * (x - nearest));
  return nearest % 2 === 0 ? sine : -sine;
}

function lanczosSeries(x: number): number {
  let sum = LANCZOS_COEFFICIENTS[0];
  for (let index = 1; index < LANCZOS_COEFFICIENTS.length; index++) sum += LANCZOS_COEFFICIENTS[index] / (x + index);
  return sum;
}
