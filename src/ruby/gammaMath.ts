// Numerical branches and coefficients follow Apple Libm Source/ARM/{tgamma,lgamma}.c (2007, Apple Inc.).
const GAMMA_P = [
  -1.716185138865495, 24.76565080557592, -379.80425647094563, 629.3311553128184, 866.9662027904133,
  -31_451.272968848367, -36_144.413418691176, 66_456.14382024054,
];
const GAMMA_Q = [
  -30.840230011973897, 315.35062697960416, -1015.1563674902192, -3107.771671572311, 22_538.11842098015,
  4755.846277527881, -134_659.9598649693, -115_132.25967555349,
];
const GAMMA_C = [
  0.08333333333333333, -0.002777777777777778, 0.0007936507936507937, -0.0005952380952380953, 0.0008417508417508417,
  -0.0019175269175269176, 0.00641025641025641,
];
const LOG_P1 = [
  4.945235359296727, 201.8112620856775, 2290.8383738313464, 11_319.672059033808, 28_557.246356716354,
  38_484.962284437934, 26_377.487876241954, 7225.813979700288,
];
const LOG_Q1 = [
  67.48212550303778, 1113.3323938571993, 7738.757056935398, 27_639.870744033407, 54_993.102062261576,
  61_611.22180066002, 36_351.2759150194, 8785.536302431014,
];
const LOG_P2 = [
  4.974607845568932, 542.4138599891071, 15_506.93864978365, 184_793.29044456323, 1_088_204.7694688288,
  3_338_152.96798703, 5_106_661.678927353, 3_074_109.0548505397,
];
const LOG_Q2 = [
  183.03283993705926, 7765.049321445006, 133_190.38279660742, 1_136_705.8213219696, 5_267_964.117437947,
  13_467_014.543111017, 17_827_365.303532742, 9_533_095.591844354,
];
const LOG_P4 = [
  14_745.0216605994, 2_426_813.3694867045, 121_475_557.40450932, 2_663_432_449.630977, 29_403_789_566.34554,
  170_266_573_776.5399, 492_612_579_337.7431, 560_625_185_622.3951,
];
const LOG_Q4 = [
  2690.5301758708993, 639_388.5654300093, 41_355_999.30241388, 1_120_872_109.616148, 14_886_137_286.788137,
  101_680_358_627.24382, 341_747_634_550.73773, 446_315_818_741.9713,
];
const LOG_C = [
  -0.001910444077728, 0.00084171387781295, -0.0005952379913043012, 0.0007936507935003503, -0.0027777777777776816,
  0.08333333333333333, 0.0057083835261,
];
const LOG_SQRT_TWO_PI = 0.9189385332046728;
const PI = 3.141592653589793;

export function gammaApprox(value: number): number {
  if (value === 0) return Object.is(value, -0) ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  if (Number.isNaN(value) || !Number.isFinite(value)) return value;
  let y = value;
  let parity = false;
  let factor = 1;
  if (value < 0) {
    y = -value;
    if (y < 2 ** -1022) return 1 / value;
    const integer = y < 2 ** 54 ? Math.trunc(y) : y;
    const fraction = y - integer;
    if (fraction === 0) return Number.NaN;
    parity = BigInt(integer) % 2n !== 0n;
    factor = -PI / Math.sin(PI * fraction);
    y++;
  }
  let result: number;
  if (y < Number.EPSILON) result = 1 / y;
  else if (y < 12) result = gammaSmall(y);
  else if (value < 171.624) {
    const squared = y * y;
    let sum = GAMMA_C[6];
    for (let index = 5; index >= 0; index--) sum = sum / squared + GAMMA_C[index];
    sum = sum / y - y + LOG_SQRT_TWO_PI;
    sum += (y - 0.5) * Math.log(y);
    result = Math.exp(sum);
  } else return Number.POSITIVE_INFINITY;
  if (parity) result = -result;
  return factor === 1 ? result : factor / result;
}

function gammaSmall(value: number): number {
  let y = value;
  let count = 0;
  let z: number;
  if (y < 1) {
    z = y;
    y++;
  } else {
    count = Math.trunc(y) - 1;
    y -= count;
    z = y - 1;
  }
  let numerator = 0;
  let denominator = 1;
  for (let index = 0; index < 8; index++) {
    numerator = (numerator + GAMMA_P[index]) * z;
    denominator = denominator * z + GAMMA_Q[index];
  }
  let result = numerator / denominator + 1;
  if (value < y) result /= value;
  else if (value > y)
    for (let index = 0; index < count; index++) {
      result *= y;
      y++;
    }
  return result;
}

export function logGammaApprox(value: number): [number, number] {
  if (Number.isNaN(value)) return [Number.NaN, 1];
  if (value === Number.POSITIVE_INFINITY) return [Number.POSITIVE_INFINITY, 1];
  if (value === 0) return [Number.POSITIVE_INFINITY, Object.is(value, -0) ? -1 : 1];
  if (value < 0) {
    if (value <= -(2 ** 52) || Number.isInteger(value)) return [Number.POSITIVE_INFINITY, 1];
    const magnitude = -value;
    const integer = Math.trunc(magnitude);
    const fraction = magnitude - integer;
    const sign = integer % 2 === 0 ? -1 : 1;
    const sine = Math.sin(PI * fraction);
    const [reflected] = logGammaApprox(magnitude);
    return [Math.log(PI / Math.abs(sine * value)) - reflected, sign];
  }
  if (value > 2.55e305) return [Number.POSITIVE_INFINITY, 1];
  if (value <= 2.22e-16) return [-Math.log(value), 1];
  if (value <= 1.5) return [logGammaNearOne(value), 1];
  if (value <= 4) {
    const delta = value - 2;
    return [delta === 0 ? 0 : delta * (0.42278433509846713 + delta * rational(delta, LOG_P2, LOG_Q2)), 1];
  }
  if (value <= 12) {
    const delta = value - 4;
    return [1.791759469228055 + delta * rational(delta, LOG_P4, LOG_Q4, -1), 1];
  }
  let result = 0;
  if (value <= 2.25e76) {
    result = LOG_C[6];
    const squared = value * value;
    for (let index = 0; index < 6; index++) result = result / squared + LOG_C[index];
  }
  result /= value;
  const logarithm = Math.log(value);
  result += LOG_SQRT_TWO_PI - 0.5 * logarithm;
  result += value * (logarithm - 1);
  return [result, 1];
}

function logGammaNearOne(value: number): number {
  let corrector: number;
  let delta: number;
  if (value < 0.6796875) {
    corrector = -Math.log(value);
    delta = value;
  } else {
    corrector = 0;
    delta = value - 0.5 - 0.5;
  }
  if (value <= 0.5 || value >= 0.6796875) {
    if (delta === 0) return corrector;
    return corrector + delta * (-0.5772156649015329 + delta * rational(delta, LOG_P1, LOG_Q1));
  }
  const offset = value - 0.5 - 0.5;
  return corrector + offset * (0.42278433509846713 + offset * rational(offset, LOG_P2, LOG_Q2));
}

function rational(
  value: number,
  numeratorCoefficients: number[],
  denominatorCoefficients: number[],
  start = 1
): number {
  let numerator = 0;
  let denominator = start;
  for (let index = 0; index < numeratorCoefficients.length; index++) {
    numerator = numerator * value + numeratorCoefficients[index];
    denominator = denominator * value + denominatorCoefficients[index];
  }
  return numerator / denominator;
}
