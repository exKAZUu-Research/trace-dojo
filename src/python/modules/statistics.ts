// code-gauge-allow-file fileNcss 522 -- Transcribes statistics.py, whose functions share its exact sums.
import { pyRepr } from '../conversions';
import { sumOfProducts } from '../floatArithmetic';
import { registerModule } from '../modules';
import { callValue, getAttributeOrUndefined, isTruthy, iterate, lengthOf, toArray } from '../objects';
import { binaryOp, compareOp, equals, lessThan } from '../operators';
import { currentRuntime } from '../runtimeContext';
import { sortList } from '../typeContainers';
import { toFloat } from '../typeNumbers';
import {
  boolClass,
  classOf,
  exceptionClassNamed,
  floatClass,
  intClass,
  nativeFunction,
  newDict,
  newException,
  newList,
  newTuple,
  None,
  pyError,
  typeError,
  valueError,
} from '../types';
import { DONE, type Kwargs, type PyClass, type PyDict, PyError, PyList, PyTuple, type PyValue } from '../values';
import { makeNamedTupleClass } from './collections';
import { decimalClass, PyDecimal } from './decimal';
import { fractionClass, fromCoprime, PyFraction } from './fractions';
import { fsum, log, realArgument } from './math';
import { normalDistClass, statisticsError, statisticsErrorClass } from './normalDist';
import { realClass } from './numbers';
import { bindArguments, type PythonSignature } from './numberSupport';

// Transcribes Lib/statistics.py of CPython 3.14, whose exact arithmetic runs on the program's own number types.

type Ratio = [PyValue, bigint | undefined];

/** `_exact_ratio`: a numerator and denominator, or the value itself and undefined for an infinity or NaN. */
function exactRatio(value: PyValue): Ratio {
  if (typeof value === 'bigint') return [value, 1n];
  if (typeof value === 'boolean') return [value ? 1n : 0n, 1n];
  if (value instanceof PyFraction) return [value.numerator, value.denominator];
  const asRatio = getAttributeOrUndefined(value, 'as_integer_ratio');
  if (asRatio !== undefined) {
    try {
      const pair = callValue(asRatio, []) as PyTuple;
      return [pair.items[0], pair.items[1] as bigint];
    } catch (error) {
      if (error instanceof PyError && ['OverflowError', 'ValueError'].includes(error.exception.cls.name)) {
        return [value, undefined];
      }
      throw error;
    }
  }
  const numerator = getAttributeOrUndefined(value, 'numerator');
  const denominator = getAttributeOrUndefined(value, 'denominator');
  if (numerator === undefined || denominator === undefined) {
    throw typeError(`can't convert type '${classOf(value).name}' to numerator/denominator`);
  }
  return [numerator, denominator as bigint];
}

/**
 * Coerces the types of the data as `reduce(_coerce, types, int)` does. CPython iterates a set of the types, whose order
 * follows their addresses, so this approximates it by taking the builtin types first.
 */
function coerceAll(types: PyClass[]): PyClass {
  const ordered = [
    ...types.filter((type) => type.module === 'builtins'),
    ...types.filter((type) => type.module !== 'builtins'),
  ];
  let result = intClass;
  for (const type of ordered) result = coerce(result, type);
  return result;
}

/** `_coerce`: the type a mean of values of types T and S has. */
function coerce(t: PyClass, s: PyClass): PyClass {
  if (t === s) return t;
  if (s === intClass || s === boolClass) return t;
  if (t === intClass) return s;
  if (s.isSubclassOf(t)) return s;
  if (t.isSubclassOf(s)) return t;
  if (t.isSubclassOf(intClass)) return s;
  if (s.isSubclassOf(intClass)) return t;
  if (t.isSubclassOf(fractionClass) && s.isSubclassOf(floatClass)) return s;
  if (t.isSubclassOf(floatClass) && s.isSubclassOf(fractionClass)) return t;
  throw typeError(`don't know how to coerce ${t.name} and ${s.name}`);
}

interface Partials {
  /** The numerators summed by denominator, which may be undefined for infinities and NaNs. */
  entries: Map<string, { denominator: bigint | undefined; numerator: PyValue }>;
}

function addPartial(partials: Partials, denominator: bigint | undefined, numerator: PyValue): void {
  const key = denominator === undefined ? 'None' : denominator.toString();
  const entry = partials.entries.get(key);
  if (entry) entry.numerator = binaryOp('+', entry.numerator, numerator);
  else partials.entries.set(key, { denominator, numerator: binaryOp('+', 0n, numerator) });
}

function sumPartials(partials: Partials, square = false): PyValue {
  let total: PyValue = 0n;
  for (const { denominator, numerator } of partials.entries.values()) {
    const d = denominator as bigint;
    total = binaryOp('+', total, newFraction(numerator, square ? d * d : d));
  }
  return total;
}

function newFraction(numerator: PyValue, denominator: PyValue): PyValue {
  return callValue(fractionClass, [numerator, denominator]);
}

interface Sum {
  type: PyClass;
  total: PyValue;
  count: number;
}

/** `_sum`: the exact sum of the data, its count, and the type of its mean. */
function exactSum(data: PyValue): Sum {
  const types: PyClass[] = [];
  const partials: Partials = { entries: new Map() };
  let count = 0;
  const next = iterate(data);
  for (let item = next(); item !== DONE; item = next()) {
    currentRuntime().spend();
    const type = classOf(item);
    if (!types.includes(type)) types.push(type);
    const [numerator, denominator] = exactRatio(item);
    count++;
    addPartial(partials, denominator, numerator);
  }
  const infinite = partials.entries.get('None');
  const total = infinite ? infinite.numerator : sumPartials(partials);
  return { type: coerceAll(types), total, count };
}

interface SumOfSquares extends Sum {
  mean: PyValue;
}

/** `_ss`: the sum of squared deviations from the mean, or from `c` when it is given. */
// code-gauge-allow functionNcss 31 -- Transcribes statistics.py.
function sumOfSquares(data: PyValue, c: PyValue | undefined): SumOfSquares {
  if (c !== undefined && c !== None) {
    const values = toArray(data).map((x) => {
      const d = binaryOp('-', x, c);
      return binaryOp('*', d, d);
    });
    return { ...exactSum(newList(values)), mean: c };
  }
  const types: PyClass[] = [];
  const sx: Partials = { entries: new Map() };
  const sxx: Partials = { entries: new Map() };
  let count = 0;
  for (const item of toArray(data)) {
    currentRuntime().spend();
    const type = classOf(item);
    if (!types.includes(type)) types.push(type);
    const [numerator, denominator] = exactRatio(item);
    count++;
    addPartial(sx, denominator, numerator);
    addPartial(sxx, denominator, binaryOp('*', numerator, numerator));
  }
  const type = coerceAll(types);
  if (count === 0) {
    const zero = fromCoprime([0n, 1n]);
    return { type, total: zero, mean: zero, count };
  }
  const infinite = sx.entries.get('None');
  if (infinite) return { type, total: infinite.numerator, mean: infinite.numerator, count };
  const sumX = sumPartials(sx);
  const sumXX = sumPartials(sxx, true);
  const n = BigInt(count);
  const ssd = binaryOp('/', binaryOp('-', binaryOp('*', n, sumXX), binaryOp('*', sumX, sumX)), n);
  return { type, total: ssd, mean: binaryOp('/', sumX, n), count };
}

/** `_convert`: the value as type T, as the mean of data of that type. */
function convert(value: PyValue, type: PyClass): PyValue {
  if (classOf(value) === type) return value;
  let target = type;
  if (target.isSubclassOf(intClass) && !equals(getAttributeOrUndefined(value, 'denominator') ?? 1n, 1n)) {
    target = floatClass;
  }
  try {
    return callValue(target, [value]);
  } catch (error) {
    if (error instanceof PyError && error.exception.cls.name === 'TypeError' && target.isSubclassOf(decimalClass)) {
      const numerator = callValue(target, [getAttributeOrUndefined(value, 'numerator') as PyValue]);
      return binaryOp('/', numerator, callValue(target, [getAttributeOrUndefined(value, 'denominator') as PyValue]));
    }
    throw error;
  }
}

// Averages -----------------------------------------------------------------------------------------------------------

function mean(data: PyValue): PyValue {
  const { type, total, count } = exactSum(data);
  if (count < 1) throw statisticsError('mean requires at least one data point');
  return convert(binaryOp('/', total, BigInt(count)), type);
}

function fmean(data: PyValue, weights: PyValue | undefined): PyValue {
  if (weights === undefined || weights === None) {
    const items = toArray(data);
    const total = fsum(newList(items));
    if (items.length === 0) throw statisticsError('fmean requires at least one data point');
    return binaryOp('/', total, BigInt(items.length));
  }
  const weightList = weights instanceof PyList || weights instanceof PyTuple ? weights : newList(toArray(weights));
  let numerator: PyValue;
  try {
    numerator = sumOfProducts(iterate(data), iterate(weightList));
  } catch (error) {
    if (error instanceof PyError && error.exception.cls.name === 'ValueError') {
      throw statisticsError('data and weights must be the same length');
    }
    throw error;
  }
  const denominator = fsum(weightList);
  if (denominator === 0) throw statisticsError('sum of weights must be non-zero');
  return binaryOp('/', numerator, denominator);
}

function geometricMean(data: PyValue): PyValue {
  let count = 0;
  let foundZero = false;
  const logs: number[] = [];
  for (const x of toArray(data)) {
    count++;
    if (isTruthy(compareOp('>', x, 0)) || Number.isNaN(realArgument(x))) logs.push(log(x, undefined));
    else if (isTruthy(compareOp('==', x, 0))) foundZero = true;
    else throw statisticsErrorWith(['No negative inputs allowed', x]);
  }
  const total = fsum(newList(logs));
  if (count === 0) throw statisticsError('Must have a non-empty dataset');
  if (Number.isNaN(total)) return Number.NaN;
  if (foundZero) return total === Number.POSITIVE_INFINITY ? Number.NaN : 0;
  const result = Math.exp(total / count);
  if (!Number.isFinite(result)) throw pyError('OverflowError', 'math range error');
  return result;
}

const HARMONIC_ERROR = 'harmonic mean does not support negative values';

function failNegative(value: PyValue): PyValue {
  if (isTruthy(compareOp('<', value, 0n))) throw statisticsError(HARMONIC_ERROR);
  return value;
}

// code-gauge-allow functionCognitiveComplexity 20 -- Transcribes statistics.py.
// code-gauge-allow functionNcss 35 -- Transcribes statistics.py.
function harmonicMean(dataValue: PyValue, weightsValue: PyValue | undefined): PyValue {
  const data = toArray(dataValue);
  const n = data.length;
  if (n < 1) throw statisticsError('harmonic_mean requires at least one data point');
  const noWeights = weightsValue === undefined || weightsValue === None;
  if (n === 1 && noWeights) {
    const [x] = data;
    if (!(x instanceof PyDecimal) && !classOf(x).isSubclassOf(realClass)) throw typeError('unsupported type');
    if (isTruthy(compareOp('<', x, 0n))) throw statisticsError(HARMONIC_ERROR);
    return x;
  }
  let weights: PyValue[];
  let sumWeights: PyValue;
  if (noWeights) {
    weights = data.map(() => 1n);
    sumWeights = BigInt(n);
  } else {
    weights = toArray(weightsValue);
    if (weights.length !== n) throw statisticsError('Number of weights does not match data size');
    sumWeights = exactSum(newList(weights.map(failNegative))).total;
  }
  let terms: PyValue[];
  try {
    terms = weights.map((w, index) => {
      const x = failNegative(data[index]);
      return isTruthy(w) ? binaryOp('/', w, x) : 0n;
    });
  } catch (error) {
    if (error instanceof PyError && error.exception.cls.isSubclassOf(exceptionClassNamed('ZeroDivisionError'))) {
      return 0n;
    }
    throw error;
  }
  const { type, total } = exactSum(newList(terms));
  if (isTruthy(compareOp('<=', total, 0n))) throw statisticsError('Weighted sum must be positive');
  return convert(binaryOp('/', sumWeights, total), type);
}

function sortedData(data: PyValue): PyValue[] {
  const list = newList(toArray(data));
  currentRuntime().allocate(list.items.length + 1);
  sortList(list, None, false);
  return list.items;
}

function median(data: PyValue): PyValue {
  const items = sortedData(data);
  const n = items.length;
  if (n === 0) throw statisticsError('no median for empty data');
  if (n % 2 === 1) return items[(n - 1) / 2];
  return binaryOp('/', binaryOp('+', items[n / 2 - 1], items[n / 2]), 2n);
}

function medianLow(data: PyValue): PyValue {
  const items = sortedData(data);
  const n = items.length;
  if (n === 0) throw statisticsError('no median for empty data');
  return n % 2 === 1 ? items[(n - 1) / 2] : items[n / 2 - 1];
}

function medianHigh(data: PyValue): PyValue {
  const items = sortedData(data);
  if (items.length === 0) throw statisticsError('no median for empty data');
  return items[Math.floor(items.length / 2)];
}

function medianGrouped(data: PyValue, intervalValue: PyValue | undefined): PyValue {
  const items = sortedData(data);
  const n = items.length;
  if (n === 0) throw statisticsError('no median for empty data');
  const middle = items[Math.floor(n / 2)];
  let i = 0;
  while (i < n && lessThan(items[i], middle)) i++;
  let j = i;
  while (j < n && !lessThan(middle, items[j])) j++;
  let interval: number;
  let x: number;
  try {
    interval = toFloat(intervalValue ?? 1);
    x = toFloat(middle);
  } catch (error) {
    if (error instanceof PyError && error.exception.cls.name === 'ValueError') {
      throw typeError('Value cannot be converted to a float');
    }
    throw error;
  }
  const lower = x - interval / 2;
  return lower + (interval * (n / 2 - i)) / (j - i);
}

function counts(data: PyValue): PyDict {
  const dict = newDict();
  const next = iterate(data);
  for (let item = next(); item !== DONE; item = next()) {
    currentRuntime().spend();
    dict.store.set(item, ((dict.store.get(item) as bigint | undefined) ?? 0n) + 1n);
  }
  return dict;
}

function mode(data: PyValue): PyValue {
  let best: { key: PyValue; count: bigint } | undefined;
  for (const entry of counts(data).store.ordered()) {
    const count = entry.value as bigint;
    if (!best || count > best.count) best = { key: entry.key, count };
  }
  if (!best) throw statisticsError('no mode for empty data');
  return best.key;
}

function multimode(data: PyValue): PyValue {
  const entries = counts(data).store.ordered();
  if (entries.length === 0) return newList([]);
  let max = 0n;
  for (const entry of entries) if ((entry.value as bigint) > max) max = entry.value as bigint;
  return newList(entries.filter((entry) => entry.value === max).map((entry) => entry.key));
}

// Spread -------------------------------------------------------------------------------------------------------------

function variance(data: PyValue, xbar: PyValue | undefined, population: boolean): PyValue {
  const { type, total, count } = sumOfSquares(data, xbar);
  const name = population ? 'pvariance' : 'variance';
  if (count < (population ? 1 : 2)) {
    throw statisticsError(`${name} requires at least ${population ? 'one data point' : 'two data points'}`);
  }
  return convert(binaryOp('/', total, BigInt(population ? count : count - 1)), type);
}

function standardDeviation(data: PyValue, xbar: PyValue | undefined, population: boolean): PyValue {
  const { type, total, count } = sumOfSquares(data, xbar);
  const name = population ? 'pstdev' : 'stdev';
  if (count < (population ? 1 : 2)) {
    throw statisticsError(`${name} requires at least ${population ? 'one data point' : 'two data points'}`);
  }
  const meanSquare = binaryOp('/', total, BigInt(population ? count : count - 1));
  const numerator = getAttributeOrUndefined(meanSquare, 'numerator');
  const denominator = getAttributeOrUndefined(meanSquare, 'denominator');
  if (numerator === undefined || denominator === undefined) throw valueError('inf or nan encountered in data');
  if (type.isSubclassOf(decimalClass)) return decimalSqrtOfFraction(numerator as bigint, denominator as bigint);
  return floatSqrtOfFraction(numerator as bigint, denominator as bigint);
}

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) break;
    x = y;
  }
  while (x * x > n) x -= 1n;
  while ((x + 1n) * (x + 1n) <= n) x += 1n;
  return x;
}

function sqrtOfFractionRoundToOdd(n: bigint, m: bigint): bigint {
  const a = isqrt(n / m);
  return a | (a * a * m === n ? 0n : 1n);
}

const SQRT_BIT_WIDTH = 2 * 53 + 3;

const bitLength = (value: bigint): number => (value === 0n ? 0 : value.toString(2).length);

/** `_float_sqrt_of_frac`: the square root of n/m rounded correctly to a float. */
export function floatSqrtOfFraction(n: bigint, m: bigint): number {
  const q = Math.floor((bitLength(n) - bitLength(m) - SQRT_BIT_WIDTH) / 2);
  if (q >= 0) return Number(binaryOp('/', sqrtOfFractionRoundToOdd(n, m << BigInt(2 * q)) << BigInt(q), 1n));
  return Number(binaryOp('/', sqrtOfFractionRoundToOdd(n << BigInt(-2 * q), m), 1n << BigInt(-q)));
}

const call = (value: PyValue, name: string): PyValue => callValue(getAttributeOrUndefined(value, name) as PyValue, []);

function decimalSqrtOfFraction(numerator: bigint, denominator: bigint): PyValue {
  let n = numerator;
  let m = denominator;
  if (n <= 0n) {
    if (n === 0n) return callValue(decimalClass, ['0.0']);
    [n, m] = [-n, -m];
  }
  const ratio = (value: PyValue): [bigint, bigint] => {
    const pair = call(value, 'as_integer_ratio') as PyTuple;
    return [pair.items[0] as bigint, pair.items[1] as bigint];
  };
  const root = call(binaryOp('/', callValue(decimalClass, [n]), callValue(decimalClass, [m])), 'sqrt');
  const [nr, dr] = ratio(root);
  const plus = call(root, 'next_plus');
  const [np, dp] = ratio(plus);
  if (4n * n * (dr * dp) ** 2n > m * (dr * np + dp * nr) ** 2n) return plus;
  const minus = call(root, 'next_minus');
  const [nm, dm] = ratio(minus);
  if (4n * n * (dr * dm) ** 2n < m * (dr * nm + dm * nr) ** 2n) return minus;
  return root;
}

/** `_mean_stdev`: the mean and standard deviation of sample data as floats. */
export function meanAndStdev(data: PyValue): [number, number] {
  const { total, mean: xbar, count } = sumOfSquares(data, undefined);
  if (count < 2) throw statisticsError('stdev requires at least two data points');
  const meanSquare = binaryOp('/', total, BigInt(count - 1));
  const numerator = getAttributeOrUndefined(meanSquare, 'numerator');
  const denominator = getAttributeOrUndefined(meanSquare, 'denominator');
  if (numerator === undefined || denominator === undefined) return [toFloat(xbar), toFloat(xbar) / toFloat(total)];
  return [toFloat(xbar), floatSqrtOfFraction(numerator as bigint, denominator as bigint)];
}

// Relations between two inputs ------------------------------------------------------------------------------------------

function pairLengths(x: PyValue, y: PyValue, what: string): number {
  const n = lengthOf(x);
  if (lengthOf(y) !== n) throw statisticsError(`${what} requires that both inputs have same number of data points`);
  if (n < 2) throw statisticsError(`${what} requires at least two data points`);
  return n;
}

function centered(values: PyValue): PyValue[] {
  const items = toArray(values);
  const mean = fsum(newList(items)) / items.length;
  return items.map((value) => binaryOp('-', value, mean));
}

function sumprod(a: PyValue[], b: PyValue[]): PyValue {
  let i = 0;
  let j = 0;
  return sumOfProducts(
    () => (i < a.length ? a[i++] : DONE),
    () => (j < b.length ? b[j++] : DONE)
  );
}

function covariance(x: PyValue, y: PyValue): PyValue {
  const n = pairLengths(x, y, 'covariance');
  return binaryOp('/', sumprod(centered(x), centered(y)), BigInt(n - 1));
}

function correlation(xValue: PyValue, yValue: PyValue, method: PyValue): PyValue {
  const n = pairLengths(xValue, yValue, 'correlation');
  if (method !== 'linear' && method !== 'ranked') throw valueError(`Unknown method: ${pyRepr(method)}`);
  let x: PyValue[];
  let y: PyValue[];
  if (method === 'ranked') {
    const start = (n - 1) / -2;
    x = rank(toArray(xValue), start);
    y = rank(toArray(yValue), start);
  } else {
    x = centered(xValue);
    y = centered(yValue);
  }
  const sxy = sumprod(x, y);
  const sxx = sumprod(x, x);
  const syy = sumprod(y, y);
  try {
    return binaryOp('/', sxy, sqrtProduct(toFloat(sxx), toFloat(syy)));
  } catch (error) {
    if (error instanceof PyError && error.exception.cls.name === 'ZeroDivisionError') {
      throw statisticsError('at least one of the inputs is constant');
    }
    throw error;
  }
}

/** `_rank` with ties averaged. */
function rank(data: PyValue[], start: number): number[] {
  const pairs = newList(data.map((value, index) => newTuple([value, BigInt(index)])));
  sortList(pairs, None, false);
  const result: number[] = Array.from({ length: data.length }, () => 0);
  let i = start - 1;
  let index = 0;
  while (index < pairs.items.length) {
    const value = (pairs.items[index] as PyTuple).items[0];
    let end = index + 1;
    while (end < pairs.items.length && equals((pairs.items[end] as PyTuple).items[0], value)) end++;
    const size = end - index;
    const rankValue = i + (size + 1) / 2;
    for (let k = index; k < end; k++) result[Number((pairs.items[k] as PyTuple).items[1])] = rankValue;
    i += size;
    index = end;
  }
  return result;
}

/** `_sqrtprod`: sqrt(x * y) with improved accuracy and without overflow or underflow. */
function sqrtProduct(x: number, y: number): number {
  const h = Math.sqrt(x * y);
  if (!Number.isFinite(h)) {
    if (h === Number.POSITIVE_INFINITY && Number.isFinite(x) && Number.isFinite(y)) {
      const scale = 2 ** -512;
      return sqrtProduct(scale * x, scale * y) / scale;
    }
    return h;
  }
  if (h === 0) {
    if (x && y) {
      const scale = 2 ** 537;
      return sqrtProduct(scale * x, scale * y) / scale;
    }
    return h;
  }
  const d = sumprod([x, h], [y, -h]) as number;
  return h + d / (2 * h);
}

const linearRegressionClass = makeNamedTupleClass('LinearRegression', ['slope', 'intercept'], 'statistics');

function linearRegression(xValue: PyValue, yValue: PyValue, proportional: PyValue): PyValue {
  const n = pairLengths(xValue, yValue, 'linear regression');
  let x = toArray(xValue);
  let y = toArray(yValue);
  let xbar = 0;
  let ybar = 0;
  if (!isTruthy(proportional)) {
    xbar = fsum(newList(x)) / n;
    ybar = fsum(newList(y)) / n;
    x = x.map((value) => binaryOp('-', value, xbar));
    y = y.map((value) => binaryOp('-', value, ybar));
  }
  const sxy = binaryOp('+', sumprod(x, y), 0);
  const sxx = sumprod(x, x);
  let slope: PyValue;
  try {
    slope = binaryOp('/', sxy, sxx);
  } catch (error) {
    if (error instanceof PyError && error.exception.cls.name === 'ZeroDivisionError') {
      throw statisticsError('x is constant');
    }
    throw error;
  }
  const intercept = isTruthy(proportional) ? 0 : binaryOp('-', ybar, binaryOp('*', slope, xbar));
  return callValue(linearRegressionClass, [slope, intercept]);
}

// code-gauge-allow functionCognitiveComplexity 17 -- Transcribes statistics.py.
function quantiles(dataValue: PyValue, nValue: PyValue, method: PyValue): PyValue {
  if (isTruthy(compareOp('<', nValue, 1n))) throw statisticsError('n must be at least 1');
  const data = sortedData(dataValue);
  const ld = data.length;
  const n = Number(nValue as bigint);
  if (ld < 2) {
    if (ld === 1) return binaryOp('*', newList(data), binaryOp('-', nValue, 1n));
    throw statisticsError('must have at least one data point');
  }
  const result: PyValue[] = [];
  const interpolate = (low: PyValue, high: PyValue, delta: bigint): PyValue =>
    binaryOp('/', binaryOp('+', binaryOp('*', low, binaryOp('-', nValue, delta)), binaryOp('*', high, delta)), nValue);
  if (method === 'inclusive') {
    const m = BigInt(ld - 1);
    for (let i = 1n; i < BigInt(n); i++) {
      const j = (i * m) / BigInt(n);
      const delta = (i * m) % BigInt(n);
      result.push(interpolate(data[Number(j)], data[Number(j) + 1], delta));
    }
    return newList(result);
  }
  if (method === 'exclusive') {
    const m = BigInt(ld + 1);
    for (let i = 1n; i < BigInt(n); i++) {
      let j = (i * m) / BigInt(n);
      j = j < 1n ? 1n : j > BigInt(ld - 1) ? BigInt(ld - 1) : j;
      const delta = i * m - j * BigInt(n);
      result.push(interpolate(data[Number(j) - 1], data[Number(j)], delta));
    }
    return newList(result);
  }
  throw valueError(`Unknown method: ${pyRepr(method)}`);
}

// The module ---------------------------------------------------------------------------------------------------------

function statisticsErrorWith(args: PyValue[]): PyError {
  return new PyError(newException(statisticsErrorClass, args));
}

type Run = (args: (PyValue | undefined)[]) => PyValue;

function pythonFunction(
  signature: Omit<PythonSignature, 'qualified'> & { name: string; keywordOnly?: string[] },
  run: Run
): PyValue {
  return nativeFunction(signature.name, (args: PyValue[], kwargs: Kwargs) => run(bindPython(signature, args, kwargs)));
}

function bindPython(
  signature: Omit<PythonSignature, 'qualified'> & { name: string; keywordOnly?: string[] },
  args: PyValue[],
  kwargs: Kwargs
): (PyValue | undefined)[] {
  const keywordOnly = signature.keywordOnly ?? [];
  const positional = new Map([...(kwargs ?? [])].filter(([key]) => !keywordOnly.includes(key)));
  const bound = bindArguments(
    {
      qualified: signature.name,
      params: signature.params,
      required: signature.required,
      positionalOnly: signature.positionalOnly,
      isFunction: true,
    },
    args,
    positional.size > 0 ? positional : undefined
  );
  for (const key of keywordOnly) bound.push(kwargs?.get(key));
  return bound;
}

registerModule('statistics', () => {
  const one = (name: string, run: (data: PyValue) => PyValue): [string, PyValue] => [
    name,
    pythonFunction({ name, params: ['data'], required: 1 }, ([data]) => run(data as PyValue)),
  ];
  return new Map<string, PyValue>([
    one('mean', mean),
    [
      'fmean',
      pythonFunction({ name: 'fmean', params: ['data', 'weights'], required: 1 }, ([d, w]) => fmean(d as PyValue, w)),
    ],
    one('geometric_mean', geometricMean),
    [
      'harmonic_mean',
      pythonFunction({ name: 'harmonic_mean', params: ['data', 'weights'], required: 1 }, ([d, w]) =>
        harmonicMean(d as PyValue, w)
      ),
    ],
    one('median', median),
    one('median_low', medianLow),
    one('median_high', medianHigh),
    [
      'median_grouped',
      pythonFunction({ name: 'median_grouped', params: ['data', 'interval'], required: 1 }, ([d, i]) =>
        medianGrouped(d as PyValue, i)
      ),
    ],
    one('mode', mode),
    one('multimode', multimode),
    ...(['variance', 'pvariance', 'stdev', 'pstdev'] as const).map((name): [string, PyValue] => {
      const population = name.startsWith('p');
      const spread = name.endsWith('variance') ? variance : standardDeviation;
      const center = population ? 'mu' : 'xbar';
      return [
        name,
        pythonFunction({ name, params: ['data', center], required: 1 }, ([d, c]) =>
          spread(d as PyValue, c, population)
        ),
      ];
    }),
    [
      'covariance',
      pythonFunction({ name: 'covariance', params: ['x', 'y'], required: 2, positionalOnly: true }, ([x, y]) =>
        covariance(x as PyValue, y as PyValue)
      ),
    ],
    [
      'correlation',
      pythonFunction(
        { name: 'correlation', params: ['x', 'y'], required: 2, positionalOnly: true, keywordOnly: ['method'] },
        ([x, y, method]) => correlation(x as PyValue, y as PyValue, method ?? 'linear')
      ),
    ],
    [
      'linear_regression',
      pythonFunction(
        {
          name: 'linear_regression',
          params: ['x', 'y'],
          required: 2,
          positionalOnly: true,
          keywordOnly: ['proportional'],
        },
        ([x, y, proportional]) => linearRegression(x as PyValue, y as PyValue, proportional ?? false)
      ),
    ],
    [
      'quantiles',
      pythonFunction(
        { name: 'quantiles', params: ['data'], required: 1, keywordOnly: ['n', 'method'] },
        ([data, n, method]) => quantiles(data as PyValue, n ?? 4n, method ?? 'exclusive')
      ),
    ],
    ['NormalDist', normalDistClass],
    ['LinearRegression', linearRegressionClass],
    ['StatisticsError', statisticsErrorClass],
  ]);
});
