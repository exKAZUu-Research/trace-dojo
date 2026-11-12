import { iterate } from '../objects';
import { binaryOp } from '../operators';
import { currentRuntime } from '../runtimeContext';
import { valueError } from '../types';
import { DONE, type PyValue } from '../values';
import { fma } from './mathFma';

interface DoubleLength {
  hi: number;
  lo: number;
}

interface TripleLength extends DoubleLength {
  tiny: number;
}

const LONG_MIN = -(2n ** 63n);
const LONG_MAX = 2n ** 63n - 1n;

/** The running sums of math_sumprod_impl: a fast path is `undefined` once a pair has ended it. */
interface Sums {
  total: PyValue;
  ints?: bigint;
  hasInts: boolean;
  floats?: TripleLength;
  hasFloats: boolean;
}

type Pair = readonly [PyValue, PyValue] | undefined;

/**
 * `math.sumprod`, transcribing math_sumprod_impl of CPython's mathmodule.c: it sums the products of machine integers
 * exactly and those of floats in triple-length arithmetic, until a pair fits neither, from which on it adds the
 * products one by one.
 */
export function sumprod(p: PyValue, q: PyValue): PyValue {
  const nextP = iterate(p);
  const nextQ = iterate(q);
  const sums: Sums = { total: 0n, ints: 0n, hasInts: false, floats: { hi: 0, lo: 0, tiny: 0 }, hasFloats: false };
  for (;;) {
    const a = nextP();
    const b = nextQ();
    if ((a === DONE) !== (b === DONE)) throw valueError('Inputs are not the same length');
    const pair: Pair = a === DONE || b === DONE ? undefined : [a, b];
    currentRuntime().spend();
    if (addOnIntPath(sums, pair) || addOnFloatPath(sums, pair)) continue;
    if (!pair) return sums.total;
    sums.total = binaryOp('+', sums.total, binaryOp('*', pair[0], pair[1]));
  }
}

/** Adds a pair of ints to the exact integer sum, or ends that path and moves its sum to the total. */
function addOnIntPath(sums: Sums, pair: Pair): boolean {
  if (sums.ints === undefined) return false;
  const sum = pair && addIntProduct(sums.ints, pair[0], pair[1]);
  if (sum !== undefined) {
    sums.ints = sum;
    sums.hasInts = true;
    return true;
  }
  if (sums.hasInts) sums.total = binaryOp('+', sums.total, sums.ints);
  sums.ints = undefined;
  return false;
}

/** Adds a pair with a float to the triple-length sum, or ends that path and moves its sum to the total. */
function addOnFloatPath(sums: Sums, pair: Pair): boolean {
  if (sums.floats === undefined) return false;
  const sum = pair && addFloatProduct(sums.floats, pair[0], pair[1]);
  if (sum !== undefined) {
    sums.floats = sum;
    sums.hasFloats = true;
    return true;
  }
  if (sums.hasFloats) sums.total = binaryOp('+', sums.total, tripleToFloat(sums.floats));
  sums.floats = undefined;
  return false;
}

/** The total with the product of two ints added, unless an operand is not an int or a C long overflows. */
function addIntProduct(total: bigint, a: PyValue, b: PyValue): bigint | undefined {
  if (typeof a !== 'bigint' || typeof b !== 'bigint' || !isLong(a) || !isLong(b)) return undefined;
  const product = a * b;
  if (!isLong(product) || !isLong(total + product)) return undefined;
  return total + product;
}

function isLong(value: bigint): boolean {
  return value >= LONG_MIN && value <= LONG_MAX;
}

/** The total with the product of a float and a float, int or bool added, unless the pair is not such or overflows. */
function addFloatProduct(total: TripleLength, a: PyValue, b: PyValue): TripleLength | undefined {
  if (typeof a !== 'number' && typeof b !== 'number') return undefined;
  const x = floatOperand(a);
  const y = floatOperand(b);
  if (x === undefined || y === undefined) return undefined;
  const sum = tripleFma(x, y, total);
  return Number.isFinite(sum.hi) ? sum : undefined;
}

function floatOperand(value: PyValue): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value !== 'bigint') return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

/** tl_fma: algorithm 5.10 with SumKVert for K=3 of Ogita, Rump and Oishi's "Accurate Sum and Dot Product". */
function tripleFma(x: number, y: number, total: TripleLength): TripleLength {
  const product = exactProduct(x, y);
  const sum = exactSum(total.hi, product.hi);
  const r1 = exactSum(total.lo, product.lo);
  const r2 = exactSum(r1.hi, sum.lo);
  return { hi: sum.hi, lo: r2.hi, tiny: total.tiny + r1.lo + r2.lo };
}

function tripleToFloat(total: TripleLength): number {
  const last = exactSum(total.lo, total.hi);
  return total.tiny + last.lo + last.hi;
}

function exactSum(a: number, b: number): DoubleLength {
  const x = a + b;
  const z = x - a;
  return { hi: x, lo: a - (x - z) + (b - z) };
}

function exactProduct(x: number, y: number): DoubleLength {
  const z = x * y;
  // A product that is not finite ends the float path, whatever its low part is.
  return { hi: z, lo: Number.isFinite(z) ? fma(x, y, -z) : 0 };
}
