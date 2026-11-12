import { moduleBuiltin } from '../define';
import { floatPower } from '../floatPower';
import { frexp } from '../hashing';
import { registerModule, registerUnsupportedAttributes } from '../modules';
import { argument } from '../nativeArgs';
import { exactBinary, floatRepr, intToFloat, scaleToFloat, toIndex } from '../numbers';
import { bindValue, callValue, isTruthy, lookupSpecial, toArray } from '../objects';
import { binaryOp } from '../operators';
import { currentRuntime } from '../runtimeContext';
import { newTuple, pyError, typeError, typeName, valueError } from '../types';
import type { Kwargs, PyValue } from '../values';
import { fma } from './mathFma';
import { sumprod } from './mathSumprod';

const builtin = moduleBuiltin('math');

/** A real number argument as a float, as math functions convert theirs. */
export function realArgument(value: PyValue): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return intToFloat(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  const special = lookupSpecial(value, '__float__') ?? lookupSpecial(value, '__index__');
  if (special !== undefined) {
    const result = callValue(bindValue(special, value), []);
    if (typeof result === 'number') return result;
    if (typeof result === 'bigint') return intToFloat(result);
  }
  throw typeError(`must be real number, not ${typeName(value)}`);
}

const domainError = (): Error => valueError('math domain error');
const rangeError = (): Error => pyError('OverflowError', 'math range error');

/** Wraps a float function, raising the errors CPython's math module raises for NaN and infinity it produces. */
function floatFunction(name: string, fn: (x: number) => number, check?: (x: number) => Error | undefined): PyValue {
  return builtin(name, 'one', 1, 1, ([value]) => {
    const x = realArgument(value);
    const error = check?.(x);
    if (error) throw error;
    const result = fn(x);
    if (Number.isNaN(result) && !Number.isNaN(x)) throw domainError();
    if (!Number.isFinite(result) && Number.isFinite(x)) throw rangeError();
    return result;
  });
}

const rangeCheck =
  (low: number, high: number, message: string) =>
  (x: number): Error | undefined =>
    x < low || x > high ? valueError(`${message}, got ${floatRepr(x)}`) : undefined;

const finiteCheck = (x: number): Error | undefined =>
  Number.isFinite(x) || Number.isNaN(x) ? undefined : valueError(`expected a finite input, got ${floatRepr(x)}`);

/** The natural logarithm of an int too large for a float, from its bit length. */
function logOfInt(value: bigint): number {
  const bits = value.toString(2).length;
  if (bits <= 1000) return Math.log(Number(value));
  const shift = BigInt(bits - 60);
  return Math.log(Number(value >> shift)) + Number(shift) * Math.LN2;
}

function logOf(value: PyValue, base: (x: number) => number): number {
  if (typeof value === 'bigint' || typeof value === 'boolean') {
    if (BigInt(value) <= 0n) throw valueError('expected a positive input');
    return base(logOfInt(BigInt(value)));
  }
  const x = realArgument(value);
  if (!(x > 0)) {
    if (Number.isNaN(x)) return x;
    throw valueError(`expected a positive input, got ${floatRepr(x)}`);
  }
  return base(Math.log(x));
}

function integerArgument(value: PyValue): bigint {
  return toIndex(value);
}

// code-gauge-allow functionCognitiveComplexity 16 -- Follows math.floor and math.ceil's special methods and float checks.
function floorOrCeil(name: string, round: (x: number) => number, special: string): PyValue {
  return builtin(name, 'one', 1, 1, ([value]) => {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'boolean') return value ? 1n : 0n;
    if (typeof value !== 'number') {
      const method = lookupSpecial(value, special);
      if (method !== undefined) return callValue(bindValue(method, value), []);
    }
    const x = realArgument(value);
    if (Number.isNaN(x)) throw valueError('cannot convert float NaN to integer');
    if (!Number.isFinite(x)) throw pyError('OverflowError', 'cannot convert float infinity to integer');
    return BigInt(round(x));
  });
}

function factorial(value: PyValue): bigint {
  const n = integerArgument(value);
  if (n < 0n) throw valueError('factorial() not defined for negative values');
  let result = 1n;
  for (let index = 2n; index <= n; index++) {
    currentRuntime().chargeBigint(result, index);
    result *= index;
  }
  return result;
}

const SMALL_INT = 1n << 64n;
/** The bits of operand that one remainder step of Euclid's algorithm handles for one unit of the budget. */
const BITS_PER_OPERATION = 1 << 13;

function gcdOf(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  if (x < SMALL_INT && y < SMALL_INT) {
    while (y) [x, y] = [y, x % y];
    return x;
  }
  // The steps of large operands are too many and too slow to leave uncharged.
  const bits = Math.max(x.toString(16).length, y.toString(16).length) * 4;
  let work = 0;
  while (y) {
    work += bits;
    if (work >= BITS_PER_OPERATION) {
      currentRuntime().spend(Math.floor(work / BITS_PER_OPERATION));
      work %= BITS_PER_OPERATION;
    }
    [x, y] = [y, x % y];
  }
  return x;
}

/**
 * CPython's adaptive-precision integer square root (Modules/mathmodule.c): each step doubles the number of correct
 * bits of `a`, so the whole costs about one division of full size.
 */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw valueError('isqrt() argument must be nonnegative');
  if (n === 0n) return 0n;
  const bits = n.toString(2).length;
  currentRuntime().chargeBits(BigInt(bits));
  const c = (bits - 1) >> 1;
  let a = 1n;
  let d = 0;
  for (let s = 31 - Math.clz32(c); s >= 0; s--) {
    const e = d;
    d = c >> s;
    a = (a << BigInt(d - e - 1)) + (n >> BigInt(2 * c - e - d + 1)) / a;
  }
  return a * a > n ? a - 1n : a;
}

function comb(nValue: PyValue, kValue: PyValue): bigint {
  const n = integerArgument(nValue);
  const k = integerArgument(kValue);
  if (n < 0n) throw valueError('n must be a non-negative integer');
  if (k < 0n) throw valueError('k must be a non-negative integer');
  if (k > n) return 0n;
  const smaller = k < n - k ? k : n - k;
  let result = 1n;
  for (let index = 1n; index <= smaller; index++) {
    currentRuntime().spend();
    result = (result * (n - smaller + index)) / index;
  }
  return result;
}

function perm(nValue: PyValue, kValue: PyValue | undefined): bigint {
  const n = integerArgument(nValue);
  if (n < 0n) throw valueError('n must be a non-negative integer');
  if (kValue === undefined || kValue === currentRuntime().none) return factorial(n);
  const k = integerArgument(kValue);
  if (k < 0n) throw valueError('k must be a non-negative integer');
  if (k > n) return 0n;
  let result = 1n;
  for (let index = n - k + 1n; index <= n; index++) {
    currentRuntime().spend();
    result *= index;
  }
  return result;
}

/** `math.fsum`: the exact sum of the floats, rounded once. */
// code-gauge-allow functionCognitiveComplexity 16 -- Follows math.fsum's handling of NaN, infinities, and signed zero.
function fsum(iterable: PyValue): number {
  const values = toArray(iterable).map(realArgument);
  let infinity = 0;
  for (const value of values) {
    if (Number.isNaN(value)) return Number.NaN;
    if (!Number.isFinite(value)) {
      if (infinity !== 0 && Math.sign(value) !== infinity) throw valueError('-inf + inf in fsum');
      infinity = Math.sign(value);
    }
  }
  if (infinity !== 0) return infinity * Number.POSITIVE_INFINITY;
  const parts = values.filter((value) => value !== 0).map(exactBinary);
  if (parts.length === 0) return values.some((value) => !Object.is(value, -0)) || values.length === 0 ? 0 : -0;
  const exponent = Math.min(...parts.map((part) => part.exponent));
  let total = 0n;
  for (const part of parts) total += part.mantissa << BigInt(part.exponent - exponent);
  const result = scaleToFloat(total, exponent);
  if (!Number.isFinite(result)) throw pyError('OverflowError', 'intermediate overflow in fsum');
  return result;
}

function hypot(values: number[]): number {
  currentRuntime().scan(values.length);
  const magnitudes = values.map(Math.abs);
  let max = 0;
  for (const magnitude of magnitudes) if (magnitude > max) max = magnitude;
  return vectorNorm(magnitudes, max);
}

const DBL_MIN = 2 ** -1022;

/**
 * CPython's vector_norm (Modules/mathmodule.c): the square root of the sum of the squares of non-negative `values`,
 * the largest of which is `max`. The values are scaled by a power of two so that the largest is in [0.5, 1), their
 * squares are summed without loss into `csum` (which starts at 1 so that every addition is of a smaller term) plus
 * the two error sums, and one differential correction is applied to the square root.
 */
function vectorNorm(values: number[], max: number): number {
  if (max === Number.POSITIVE_INFINITY) return max;
  if (values.some((value) => Number.isNaN(value))) return Number.NaN;
  if (max === 0 || values.length <= 1) return max;
  const maxExponent = frexp(max).exponent;
  if (maxExponent < -1023) {
    // The scale below would overflow, so subnormals are made normal first.
    return (
      DBL_MIN *
      vectorNorm(
        values.map((value) => value / DBL_MIN),
        max / DBL_MIN
      )
    );
  }
  const scale = 2 ** -maxExponent;
  let csum = 1;
  let frac1 = 0;
  let frac2 = 0;
  const addProduct = (x: number, y: number): void => {
    const high = x * y;
    const low = fma(x, y, -high);
    const sum = csum + high;
    frac2 += csum - sum + high;
    csum = sum;
    frac1 += low;
  };
  for (const value of values) addProduct(value * scale, value * scale);
  let h = Math.sqrt(csum - 1 + (frac1 + frac2));
  addProduct(-h, h);
  h += (csum - 1 + (frac1 + frac2)) / (2 * h);
  return h / scale;
}

/** CPython's m_remainder (Modules/mathmodule.c), every step of which is exact. */
function remainder(x: number, y: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.NaN;
  if (!Number.isFinite(x) || y === 0) throw domainError();
  if (!Number.isFinite(y)) return x;
  const absX = Math.abs(x);
  const absY = Math.abs(y);
  const modulus = absX % absY;
  const complement = absY - modulus;
  let result: number;
  if (modulus < complement) result = modulus;
  else if (modulus > complement) result = -complement;
  // Halfway between two multiples of y, the even one is the nearest.
  else result = modulus - 2 * ((0.5 * (absX - modulus)) % absY);
  return copysign(1, x) * result;
}

/** Zero with the sign of `x`. */
function signedZero(x: number): number {
  return x < 0 || Object.is(x, -0) ? -0 : 0;
}

function nextafter(x: number, y: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.NaN;
  if (x === y) return y;
  if (x === 0) return y > 0 ? Number.MIN_VALUE : -Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigInt64(0);
  view.setBigInt64(0, y > x === x > 0 ? bits + 1n : bits - 1n);
  return view.getFloat64(0);
}

function ulp(x: number): number {
  if (Number.isNaN(x)) return x;
  const magnitude = Math.abs(x);
  if (!Number.isFinite(magnitude)) return magnitude;
  if (magnitude === Number.MAX_VALUE) return magnitude - nextafter(magnitude, 0);
  return nextafter(magnitude, Number.POSITIVE_INFINITY) - magnitude;
}

function isclose(args: PyValue[], kwargs: Kwargs): boolean {
  const a = realArgument(argument(args, kwargs, 0, 'a') as PyValue);
  const b = realArgument(argument(args, kwargs, 1, 'b') as PyValue);
  const relative = realArgument(kwargs?.get('rel_tol') ?? 1e-9);
  const absolute = realArgument(kwargs?.get('abs_tol') ?? 0);
  if (relative < 0 || absolute < 0) throw valueError('tolerances must be non-negative');
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const difference = Math.abs(b - a);
  return difference <= Math.abs(relative * b) || difference <= Math.abs(relative * a) || difference <= absolute;
}

function pow(x: number, y: number): number {
  if (x === 0 && y < 0 && Number.isFinite(y)) throw domainError();
  if (x < 0 && Number.isFinite(x) && Number.isFinite(y) && !Number.isInteger(y)) throw domainError();
  if (x === 1 || y === 0) return 1;
  const result = floatPower(x, y);
  if (!Number.isFinite(result) && Number.isFinite(x) && Number.isFinite(y)) throw rangeError();
  return result;
}

function product(args: PyValue[], kwargs: Kwargs): PyValue {
  let result = kwargs?.get('start') ?? 1n;
  for (const item of toArray(args[0])) result = binaryOp('*', result, item);
  return result;
}

function two(name: string, run: (x: number, y: number) => number): PyValue {
  return builtin(name, 'expected', 2, 2, ([a, b]) => run(realArgument(a), realArgument(b)));
}

function lcm(values: bigint[]): bigint {
  let result = 1n;
  for (const value of values) {
    if (result === 0n || value === 0n) return 0n;
    currentRuntime().chargeBigint(result, value);
    const product = result * value;
    result = (product < 0n ? -product : product) / gcdOf(result, value);
  }
  return result;
}

// CPython 3.14 takes these from the platform's C library (macOS's on the reference machine), whose results to the
// last digit no published algorithm reproduces.
registerUnsupportedAttributes('math', {
  erf: 'math.erf()（C ライブラリの erf と最後の桁まで同じ値を出せないため）',
  erfc: 'math.erfc()（C ライブラリの erfc と最後の桁まで同じ値を出せないため）',
  gamma: 'math.gamma()（C ライブラリの tgamma と最後の桁まで同じ値を出せないため）',
  lgamma: 'math.lgamma()（C ライブラリの lgamma と最後の桁まで同じ値を出せないため）',
});

registerModule('math', () => {
  return new Map<string, PyValue>([
    ['pi', Math.PI],
    ['e', Math.E],
    ['tau', 2 * Math.PI],
    ['inf', Number.POSITIVE_INFINITY],
    ['nan', Number.NaN],
    ['sqrt', builtin('sqrt', 'one', 1, 1, ([value]) => sqrt(realArgument(value)))],
    ['isqrt', builtin('isqrt', 'one', 1, 1, ([value]) => isqrt(integerArgument(value)))],
    ['cbrt', floatFunction('cbrt', Math.cbrt)],
    ['exp', floatFunction('exp', Math.exp)],
    ['exp2', floatFunction('exp2', (x) => 2 ** x)],
    ['expm1', floatFunction('expm1', Math.expm1)],
    ['log', builtin('log', 'expected', 1, 2, ([value, base]) => log(value, base))],
    ['log2', builtin('log2', 'one', 1, 1, ([value]) => log2Of(value))],
    ['log10', builtin('log10', 'one', 1, 1, ([value]) => log10Of(value))],
    [
      'log1p',
      floatFunction('log1p', Math.log1p, (x) =>
        x <= -1 ? valueError(`expected argument value > -1, got ${floatRepr(x)}`) : undefined
      ),
    ],
    ['sin', floatFunction('sin', Math.sin, finiteCheck)],
    ['cos', floatFunction('cos', Math.cos, finiteCheck)],
    ['tan', floatFunction('tan', Math.tan, finiteCheck)],
    ['asin', floatFunction('asin', Math.asin, rangeCheck(-1, 1, 'expected a number in range from -1 up to 1'))],
    ['acos', floatFunction('acos', Math.acos, rangeCheck(-1, 1, 'expected a number in range from -1 up to 1'))],
    ['atan', floatFunction('atan', Math.atan)],
    ['atan2', two('atan2', Math.atan2)],
    ['sinh', floatFunction('sinh', Math.sinh)],
    ['cosh', floatFunction('cosh', Math.cosh)],
    ['tanh', floatFunction('tanh', Math.tanh)],
    ['asinh', floatFunction('asinh', Math.asinh)],
    [
      'acosh',
      floatFunction('acosh', Math.acosh, (x) =>
        x < 1 ? valueError(`expected argument value not less than 1, got ${floatRepr(x)}`) : undefined
      ),
    ],
    [
      'atanh',
      floatFunction('atanh', Math.atanh, (x) =>
        x <= -1 || x >= 1 ? valueError(`expected a number between -1 and 1, got ${floatRepr(x)}`) : undefined
      ),
    ],
    ['degrees', floatFunction('degrees', (x) => x * (180 / Math.PI))],
    ['radians', floatFunction('radians', (x) => x * (Math.PI / 180))],
    ['floor', floorOrCeil('floor', Math.floor, '__floor__')],
    ['ceil', floorOrCeil('ceil', Math.ceil, '__ceil__')],
    ['trunc', floorOrCeil('trunc', Math.trunc, '__trunc__')],
    ['fabs', floatFunction('fabs', Math.abs)],
    ['factorial', builtin('factorial', 'one', 1, 1, ([value]) => factorial(value))],
    ['gcd', builtin('gcd', 'expected', 0, Number.POSITIVE_INFINITY, (args) => gcd(args.map(integerArgument)))],
    ['lcm', builtin('lcm', 'expected', 0, Number.POSITIVE_INFINITY, (args) => lcm(args.map(integerArgument)))],
    ['comb', builtin('comb', 'expected', 2, 2, ([n, k]) => comb(n, k))],
    ['perm', builtin('perm', 'expected', 1, 2, ([n, k]) => perm(n, k))],
    ['pow', two('pow', pow)],
    ['hypot', builtin('hypot', 'expected', 0, Number.POSITIVE_INFINITY, (args) => hypot(args.map(realArgument)))],
    ['dist', builtin('dist', 'expected', 2, 2, ([p, q]) => dist(p, q))],
    ['fsum', builtin('fsum', 'one', 1, 1, ([iterable]) => fsum(iterable))],
    ['prod', builtin('prod', 'takes', 1, 1, product, { keywords: ['start'] })],
    ['sumprod', builtin('sumprod', 'expected', 2, 2, ([p, q]) => sumprod(p, q))],
    ['isclose', builtin('isclose', 'takes', 2, 2, isclose, { keywords: ['a', 'b', 'rel_tol', 'abs_tol'], named: 2 })],
    ['isfinite', builtin('isfinite', 'one', 1, 1, ([value]) => Number.isFinite(realArgument(value)))],
    ['isinf', builtin('isinf', 'one', 1, 1, ([value]) => isInfinite(realArgument(value)))],
    ['isnan', builtin('isnan', 'one', 1, 1, ([value]) => Number.isNaN(realArgument(value)))],
    ['copysign', two('copysign', copysign)],
    ['fmod', two('fmod', fmod)],
    ['modf', builtin('modf', 'one', 1, 1, ([value]) => modf(realArgument(value)))],
    ['frexp', builtin('frexp', 'one', 1, 1, ([value]) => frexpTuple(realArgument(value)))],
    ['ldexp', builtin('ldexp', 'expected', 2, 2, ([value, exponent]) => ldexp(realArgument(value), exponent))],
    ['remainder', two('remainder', remainder)],
    [
      'nextafter',
      builtin('nextafter', 'takes', 2, 2, ([x, y]) => nextafter(realArgument(x), realArgument(y)), {
        keywords: ['steps'],
      }),
    ],
    ['ulp', floatFunction('ulp', ulp)],
    ['fma', builtin('fma', 'expected', 3, 3, ([x, y, z]) => fma(realArgument(x), realArgument(y), realArgument(z)))],
  ]);
});

function sqrt(x: number): number {
  if (x < 0) throw valueError(`expected a nonnegative input, got ${floatRepr(x)}`);
  return Math.sqrt(x);
}

function log(value: PyValue, base: PyValue | undefined): number {
  const numerator = logOf(value, (x) => x);
  if (base === undefined) return numerator;
  const denominator = logOf(base, (x) => x);
  if (denominator === 0) throw pyError('ZeroDivisionError', 'division by zero');
  return numerator / denominator;
}

function gcd(values: bigint[]): bigint {
  let result = 0n;
  for (const value of values) result = gcdOf(result, value);
  return result;
}

function dist(p: PyValue, q: PyValue): number {
  const a = toArray(p).map(realArgument);
  const b = toArray(q).map(realArgument);
  if (a.length !== b.length) throw valueError('both points must have the same number of dimensions');
  return hypot(a.map((value, index) => value - b[index]));
}

function isInfinite(x: number): boolean {
  return !Number.isFinite(x) && !Number.isNaN(x);
}

function copysign(x: number, y: number): number {
  return Math.abs(x) * (y < 0 || Object.is(y, -0) ? -1 : 1);
}

function fmod(x: number, y: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.NaN;
  if (!Number.isFinite(x) || y === 0) throw domainError();
  return x % y;
}

function modf(x: number): PyValue {
  if (!Number.isFinite(x)) return newTuple([Number.isNaN(x) ? x : signedZero(x), x]);
  const integer = Math.trunc(x);
  return newTuple([x - integer === 0 ? signedZero(x) : x - integer, integer]);
}

function frexpTuple(x: number): PyValue {
  const { mantissa, exponent } = frexp(x);
  return newTuple([mantissa, BigInt(exponent)]);
}

function ldexp(x: number, exponent: PyValue): number {
  const power = Number(integerArgument(exponent));
  const half = Math.trunc(power / 2);
  const result = x * 2 ** half * 2 ** (power - half);
  if (!Number.isFinite(result) && Number.isFinite(x)) throw rangeError();
  return result;
}

function log2Of(value: PyValue): number {
  if (typeof value === 'number' && value > 0) return Math.log2(value);
  if (
    (typeof value === 'bigint' || typeof value === 'boolean') &&
    BigInt(value) > 0n &&
    BigInt(value).toString(2).length <= 1000
  ) {
    return Math.log2(Number(value));
  }
  return logOf(value, (x) => x / Math.LN2);
}

function log10Of(value: PyValue): number {
  if (typeof value === 'number' && value > 0) return Math.log10(value);
  if (
    (typeof value === 'bigint' || typeof value === 'boolean') &&
    BigInt(value) > 0n &&
    BigInt(value).toString(2).length <= 1000
  ) {
    return Math.log10(Number(value));
  }
  return logOf(value, (x) => x / Math.LN10);
}

export { argument, isTruthy };
