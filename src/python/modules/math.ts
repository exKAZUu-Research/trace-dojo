import { builtin } from '../define';
import { sumOfProducts, vectorNorm } from '../floatArithmetic';
import { frexp } from '../hashing';
import { registerModule, registerUnsupportedAttributes } from '../modules';
import { argument, checkArgs } from '../nativeArgs';
import { exactBinary, floatRepr, intToFloat, scaleToFloat, toIndex } from '../numbers';
import { bindValue, callValue, isTruthy, iterate, lookupSpecial, toArray } from '../objects';
import { binaryOp } from '../operators';
import { currentRuntime } from '../runtimeContext';
import { newTuple, pyError, typeError, typeName, valueError } from '../types';
import type { Kwargs, PyValue } from '../values';
import { fma } from './mathFma';

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

/** The natural logarithm of an int too large for a float, from its bit length. */
function logOfInt(value: bigint): number {
  const bits = value.toString(2).length;
  if (bits <= 1000) return Math.log(Number(value));
  const shift = BigInt(bits - 60);
  return Math.log(Number(value >> shift)) + Number(shift) * Math.LN2;
}

function logOf(value: PyValue, base: (x: number) => number): number {
  if ((typeof value === 'bigint' || typeof value === 'boolean') && BigInt(value) > 0n)
    return base(logOfInt(BigInt(value)));
  const x = realArgument(value);
  if (!(x > 0)) {
    if (Number.isNaN(x)) return x;
    throw valueError('expected a positive input');
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

function gcdOf(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) [x, y] = [y, x % y];
  return x;
}

export function isqrt(n: bigint): bigint {
  if (n < 0n) throw valueError('isqrt() argument must be nonnegative');
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  if (n > 1n << 100n) x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) break;
    x = y;
  }
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x;
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
export function fsum(iterable: PyValue): number {
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

function remainder(x: number, y: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.NaN;
  if (!Number.isFinite(x) || y === 0) throw domainError();
  if (!Number.isFinite(y)) return x;
  const quotient = x / y;
  let nearest = Math.round(quotient);
  if (Math.abs(quotient - Math.trunc(quotient)) === 0.5) nearest = 2 * Math.round(quotient / 2);
  const result = x - nearest * y;
  return result === 0 ? signedZero(x) : result;
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
  checkArgs({ qualified: 'isclose', min: 2, max: 2, style: 'takes', keywords: ['rel_tol', 'abs_tol'] }, args, kwargs);
  const a = realArgument(args[0]);
  const b = realArgument(args[1]);
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
  const result = x ** y;
  if (!Number.isFinite(result) && Number.isFinite(x) && Number.isFinite(y)) throw rangeError();
  return result;
}

function product(args: PyValue[], kwargs: Kwargs): PyValue {
  checkArgs({ qualified: 'prod', min: 1, max: 1, style: 'takes', keywords: ['start'] }, args, kwargs);
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
    ['sin', floatFunction('sin', Math.sin)],
    ['cos', floatFunction('cos', Math.cos)],
    ['tan', floatFunction('tan', Math.tan)],
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
    ['hypot', builtin('hypot', 'expected', 0, Number.POSITIVE_INFINITY, (args) => vectorNorm(args.map(realArgument)))],
    ['dist', builtin('dist', 'expected', 2, 2, ([p, q]) => dist(p, q))],
    ['fsum', builtin('fsum', 'one', 1, 1, ([iterable]) => fsum(iterable))],
    ['prod', builtin('prod', 'takes', 1, 1, product, { keywords: ['start'] })],
    ['sumprod', builtin('sumprod', 'expected', 2, 2, ([p, q]) => sumOfProducts(iterate(p), iterate(q)))],
    ['isclose', builtin('isclose', 'takes', 2, 2, isclose, { keywords: ['rel_tol', 'abs_tol'] })],
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

export function log(value: PyValue, base: PyValue | undefined): number {
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
  return vectorNorm(a.map((value, index) => value - b[index]));
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
