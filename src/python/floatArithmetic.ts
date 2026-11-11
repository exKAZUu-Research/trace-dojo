import { exactBinary, scaleToFloat } from './numbers';
import { binaryOp } from './operators';
import { valueError } from './types';
import { DONE, type PyValue } from './values';

// Floating-point algorithms of CPython's C code that JavaScript has no equivalent of, transcribed so that results match
// in the last bit.

/** `fma(a, b, c)`: `a * b + c` rounded once, which C code and contracted C expressions compute. */
export function fma(a: number, b: number, c: number): number {
  const product = a * b;
  if (!Number.isFinite(product) || !Number.isFinite(c) || product === 0 || c === 0) return product + c;
  const x = exactBinary(a);
  const y = exactBinary(b);
  const z = exactBinary(c);
  const productExponent = x.exponent + y.exponent;
  const exponent = Math.min(productExponent, z.exponent);
  const sum =
    ((x.mantissa * y.mantissa) << BigInt(productExponent - exponent)) + (z.mantissa << BigInt(z.exponent - exponent));
  return sum === 0n ? 0 : scaleToFloat(sum, exponent);
}

type DoubleLength = [hi: number, lo: number];

function fastSum(a: number, b: number): DoubleLength {
  const x = a + b;
  return [x, a - x + b];
}

function twoSum(a: number, b: number): DoubleLength {
  const x = a + b;
  const z = x - a;
  return [x, a - (x - z) + (b - z)];
}

function twoProduct(x: number, y: number): DoubleLength {
  const z = x * y;
  return [z, fma(x, y, -z)];
}

/** The Euclidean norm of non-negative finite-or-not coordinates, as `vector_norm` of mathmodule.c computes it. */
// code-gauge-allow functionNcss 31 -- Transcribes the algorithm of mathmodule.c.
export function vectorNorm(values: number[]): number {
  const magnitudes = values.map(Math.abs);
  const max = Math.max(0, ...magnitudes.filter((value) => !Number.isNaN(value)));
  if (max === Number.POSITIVE_INFINITY) return max;
  if (magnitudes.some(Number.isNaN)) return Number.NaN;
  if (max === 0 || magnitudes.length <= 1) return max;
  if (frexpExponent(max) < -1023) {
    const smallest = 2 ** -1022;
    return smallest * vectorNorm(magnitudes.map((value) => value / smallest));
  }
  const scale = 2 ** -frexpExponent(max);
  let total = 1;
  let fraction1 = 0;
  let fraction2 = 0;
  for (const value of magnitudes) {
    const scaled = value * scale;
    const [square, squareError] = twoProduct(scaled, scaled);
    const [sum, sumError] = fastSum(total, square);
    total = sum;
    fraction1 += squareError;
    fraction2 += sumError;
  }
  let h = Math.sqrt(total - 1 + (fraction1 + fraction2));
  const [square, squareError] = twoProduct(-h, h);
  const [sum, sumError] = fastSum(total, square);
  fraction1 += squareError;
  fraction2 += sumError;
  const x = sum - 1 + (fraction1 + fraction2);
  h += x / (2 * h);
  return h / scale;
}

/** The exponent `frexp` returns: the e with 0.5 <= value / 2**e < 1. */
function frexpExponent(value: number): number {
  let exponent = Math.floor(Math.log2(value)) + 1;
  if (value * 2 ** -exponent >= 1) exponent++;
  if (value * 2 ** -exponent < 0.5) exponent--;
  return exponent;
}

const LONG_MAX = (1n << 63n) - 1n;
const LONG_MIN = -(1n << 63n);

type TripleLength = [hi: number, lo: number, tiny: number];

function tripleFma(x: number, y: number, [hi, lo, tiny]: TripleLength): TripleLength {
  const [productHi, productLo] = twoProduct(x, y);
  const [sumHi, sumLo] = twoSum(hi, productHi);
  const [r1Hi, r1Lo] = twoSum(lo, productLo);
  const [r2Hi, r2Lo] = twoSum(r1Hi, sumLo);
  return [sumHi, r2Hi, tiny + r1Lo + r2Lo];
}

function tripleToDouble([hi, lo, tiny]: TripleLength): number {
  const [lastHi, lastLo] = twoSum(lo, hi);
  return tiny + lastLo + lastHi;
}

const isIntLike = (value: PyValue): boolean => typeof value === 'bigint' || typeof value === 'boolean';

/** A float operand of the float path of sumprod: a float, or an int or bool paired with a float. */
function floatPair(p: PyValue, q: PyValue): [number, number] | undefined {
  if (typeof p === 'number' && (typeof q === 'number' || isIntLike(q))) return [p, Number(q)];
  if (typeof q === 'number' && isIntLike(p)) return [Number(p), q];
  return undefined;
}

interface SumprodState {
  total: PyValue;
  intPath: boolean;
  intTotal?: bigint;
  floatPath: boolean;
  floatTotal?: TripleLength;
}

/** `math.sumprod`, with its exact int path and its triple-length float path before falling back to generic math. */
// code-gauge-allow functionCognitiveComplexity 18 -- Transcribes the algorithm of mathmodule.c.
export function sumOfProducts(nextP: () => PyValue | typeof DONE, nextQ: () => PyValue | typeof DONE): PyValue {
  const state: SumprodState = { total: 0n, intPath: true, floatPath: true };
  for (;;) {
    const p = nextP();
    const q = nextQ();
    if ((p === DONE) !== (q === DONE)) throw valueError('Inputs are not the same length');
    if (p === DONE || q === DONE) {
      if (state.intPath) addInts(state, undefined, undefined);
      if (state.floatPath) addFloats(state, undefined, undefined);
      return state.total;
    }
    if (state.intPath && addInts(state, p, q)) continue;
    if (state.floatPath && addFloats(state, p, q)) continue;
    state.total = binaryOp('+', state.total, binaryOp('*', p, q));
  }
}

/** Adds p * q on the int path, or ends the path, adding its total to the generic one, and returns false. */
function addInts(state: SumprodState, p: PyValue | undefined, q: PyValue | undefined): boolean {
  if (typeof p === 'bigint' && typeof q === 'bigint') {
    const sum = (state.intTotal ?? 0n) + p * q;
    // The int path adds in C longs, so a value or a sum beyond them leaves it for the next path.
    if ([p, q, p * q, sum].every((value) => value >= LONG_MIN && value <= LONG_MAX)) {
      state.intTotal = sum;
      return true;
    }
  }
  state.intPath = false;
  if (state.intTotal !== undefined) state.total = binaryOp('+', state.total, state.intTotal);
  return false;
}

/** Adds p * q on the float path, or ends the path, adding its total to the generic one, and returns false. */
function addFloats(state: SumprodState, p: PyValue | undefined, q: PyValue | undefined): boolean {
  const pair = p === undefined || q === undefined ? undefined : floatPair(p, q);
  if (pair) {
    const next = tripleFma(pair[0], pair[1], state.floatTotal ?? [0, 0, 0]);
    if (Number.isFinite(next[0])) {
      state.floatTotal = next;
      return true;
    }
  }
  state.floatPath = false;
  if (state.floatTotal !== undefined) state.total = binaryOp('+', state.total, tripleToDouble(state.floatTotal));
  return false;
}
