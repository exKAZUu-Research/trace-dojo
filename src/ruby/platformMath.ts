// Godfrey's coefficients for the Lanczos approximation with g = 607/128, accurate to about 15 significant digits.
const LANCZOS_G = 607 / 128;
const LANCZOS_COEFFICIENTS = [
  0.9999999999999971, 57.15623566586292, -59.59796035547549, 14.136097974741746, -0.4919138160976202,
  0.3399464998481189e-4, 0.46523628927048576e-4, -0.9837447530487956e-4, 0.15808870322491249e-3,
  -0.21026444172410488e-3, 0.21743961811521264e-3, -0.1643181065367639e-3, 0.8441822398385274e-4,
  -0.2619083840158141e-4, 0.3689918265953162e-5,
];
const HALF_LOG_TWO_PI = Math.log(2 * Math.PI) / 2;
/** The largest argument whose gamma value, a factorial, a double represents exactly. */
const MAX_EXACT_FACTORIAL_ARGUMENT = 23;
/** Below this argument the logarithm of the gamma value is more accurate than the sum of its logarithmic terms. */
const MAX_DIRECT_LOG_ARGUMENT = 16;

export const platformGamma = (value: number): number => {
  if (Number.isInteger(value) && value > 0 && value <= MAX_EXACT_FACTORIAL_ARGUMENT) {
    let factorial = 1;
    for (let factor = 2; factor < value; factor++) factorial *= factor;
    return factorial;
  }
  if (value < 0.5) return Math.PI / (Math.sin(Math.PI * value) * platformGamma(1 - value));
  const x = value - 1;
  const t = x + LANCZOS_G + 0.5;
  // The power is taken in two halves because it overflows before the product does.
  const halfPower = Math.pow(t, (x + 0.5) / 2);
  return Math.sqrt(2 * Math.PI) * halfPower * Math.exp(-t) * halfPower * lanczosSeries(x);
};

/** The logarithm of the absolute value of the gamma function, and the sign of the gamma function. */
export const platformLogGamma = (value: number): [number, number] => {
  if (value <= 0 && Number.isInteger(value)) return [Number.POSITIVE_INFINITY, 1];
  if (value < 0.5) {
    const sine = Math.sin(Math.PI * value);
    return [Math.log(Math.PI / Math.abs(sine)) - platformLogGamma(1 - value)[0], sine < 0 ? -1 : 1];
  }
  if (value < MAX_DIRECT_LOG_ARGUMENT) return [Math.log(platformGamma(value)), 1];
  const x = value - 1;
  const t = x + LANCZOS_G + 0.5;
  return [HALF_LOG_TWO_PI + (x + 0.5) * Math.log(t) - t + Math.log(lanczosSeries(x)), 1];
};

function lanczosSeries(x: number): number {
  let sum = LANCZOS_COEFFICIENTS[0];
  for (let index = 1; index < LANCZOS_COEFFICIENTS.length; index++) sum += LANCZOS_COEFFICIENTS[index] / (x + index);
  return sum;
}
