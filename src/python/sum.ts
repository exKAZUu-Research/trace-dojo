import { newComplex } from './complexNumbers';
import { argument, checkArgs } from './nativeArgs';
import { asFloat } from './numbers';
import { iterate, type NextFunction } from './objects';
import { binaryOp } from './operators';
import { currentRuntime } from './runtimeContext';
import { complexClass, stringValue, typeError } from './types';
import { DONE, type Kwargs, PyComplex, type PyValue } from './values';

type Item = PyValue | typeof DONE;

/** A float sum with Neumaier's compensation, as CPython's CompensatedSum keeps it. */
interface CompensatedSum {
  high: number;
  low: number;
}

/**
 * Python's `sum`, which follows builtin_sum_impl: ints add exactly, then floats and then complex numbers add with
 * Neumaier's compensation, each run handing its total and the first item it cannot take to the next.
 */
export function sum(args: PyValue[], kwargs: Kwargs): PyValue {
  if (args.length === 0) throw typeError('sum() takes at least 1 positional argument (0 given)');
  checkArgs({ qualified: 'sum', min: 1, max: 2, style: 'takes', keywords: ['start'], named: 1 }, args, kwargs);
  let result = argument(args, kwargs, 1, 'start') ?? 0n;
  if (stringValue(result) !== undefined) throw typeError("sum() can't sum strings [use ''.join(seq) instead]");
  const next = iterate(args[0]);
  let item: Item;
  [result, item] = sumInts(result, next);
  if (typeof result === 'number') [result, item] = sumFloats(result, item, next);
  if (result instanceof PyComplex && result.cls === complexClass) [result, item] = sumComplexes(result, item, next);
  const runtime = currentRuntime();
  for (; item !== DONE; item = next()) {
    runtime.spend();
    result = binaryOp('+', result, item);
  }
  return result;
}

/** Adds the leading ints to an int total, then the first item that is not one, as the ints' run ends. */
function sumInts(start: PyValue, next: NextFunction): [PyValue, Item] {
  let result = start;
  let item = next();
  const runtime = currentRuntime();
  while (item !== DONE && typeof result === 'bigint' && (typeof item === 'bigint' || typeof item === 'boolean')) {
    runtime.spend();
    result += BigInt(item);
    item = next();
  }
  if (item === DONE || typeof result !== 'bigint') return [result, item];
  return [binaryOp('+', result, item), next()];
}

/** Adds the floats and ints that follow to a float total, then the first other item. */
function sumFloats(start: number, first: Item, next: NextFunction): [PyValue, Item] {
  const real = compensated(start);
  let item = first;
  const runtime = currentRuntime();
  for (; item !== DONE; item = next()) {
    runtime.spend();
    if (typeof item !== 'number' && typeof item !== 'bigint' && typeof item !== 'boolean') break;
    addCompensated(real, asFloat(item));
  }
  const total = compensatedTotal(real);
  if (item === DONE) return [total, item];
  return [binaryOp('+', total, item), next()];
}

/** Adds the complex numbers, floats, and ints that follow to a complex total, part by part. */
function sumComplexes(start: PyComplex, first: Item, next: NextFunction): [PyValue, Item] {
  const real = compensated(start.real);
  const imag = compensated(start.imag);
  let item = first;
  const runtime = currentRuntime();
  for (; item !== DONE; item = next()) {
    runtime.spend();
    if (item instanceof PyComplex && item.cls === complexClass) {
      addCompensated(real, item.real);
      addCompensated(imag, item.imag);
    } else if (typeof item === 'number' || typeof item === 'bigint' || typeof item === 'boolean') {
      addCompensated(real, asFloat(item));
    } else {
      break;
    }
  }
  return [newComplex(compensatedTotal(real), compensatedTotal(imag)), item];
}

const compensated = (start: number): CompensatedSum => ({ high: start, low: 0 });

function addCompensated(sum: CompensatedSum, x: number): void {
  const total = sum.high + x;
  sum.low += Math.abs(sum.high) >= Math.abs(x) ? sum.high - total + x : x - total + sum.high;
  sum.high = total;
}

function compensatedTotal({ high, low }: CompensatedSum): number {
  return low && Number.isFinite(low) ? high + low : high;
}
