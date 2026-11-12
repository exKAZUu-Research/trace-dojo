import { iterate } from '../objects';
import { currentRuntime } from '../runtimeContext';
import { pyError, valueError } from '../types';
import { DONE, type PyValue } from '../values';

/**
 * `math.fsum`, transcribing math_fsum of CPython's mathmodule.c: Shewchuk's partials hold the exact sum of the finite
 * items, and an infinity or NaN among the items sets them aside, with an OverflowError when a finite item overflows a
 * partial even though the exact sum is finite.
 */
export function fsum(iterable: PyValue, toFloat: (value: PyValue) => number): number {
  const partials: number[] = [];
  let specialSum = 0;
  let infSum = 0;
  const next = iterate(iterable);
  const runtime = currentRuntime();
  for (let item = next(); item !== DONE; item = next()) {
    runtime.spend();
    const value = toFloat(item);
    const x = addToPartials(partials, value);
    if (x === 0) continue;
    if (Number.isFinite(x)) partials.push(x);
    else {
      if (Number.isFinite(value)) throw pyError('OverflowError', 'intermediate overflow in fsum');
      if (!Number.isNaN(value)) infSum += value;
      specialSum += value;
      partials.length = 0;
    }
  }
  if (specialSum !== 0) {
    if (Number.isNaN(infSum)) throw valueError('-inf + inf in fsum');
    return specialSum;
  }
  return roundPartials(partials);
}

/** Adds `value` to the partials, keeping the nonzero round-off errors and returning the high part left to append. */
function addToPartials(partials: number[], value: number): number {
  let x = value;
  let kept = 0;
  for (let y of partials) {
    if (Math.abs(x) < Math.abs(y)) [x, y] = [y, x];
    const hi = x + y;
    const lo = y - (hi - x);
    if (lo !== 0) partials[kept++] = lo;
    x = hi;
  }
  partials.length = kept;
  return x;
}

/** The sum of the partials rounded once, with CPython's correction for halfway cases across partials. */
function roundPartials(partials: number[]): number {
  let n = partials.length;
  if (n === 0) return 0;
  let hi = partials[--n];
  let lo = 0;
  while (n > 0) {
    const x = hi;
    const y = partials[--n];
    hi = x + y;
    lo = y - (hi - x);
    if (lo !== 0) break;
  }
  if (n > 0 && ((lo < 0 && partials[n - 1] < 0) || (lo > 0 && partials[n - 1] > 0))) {
    const y = lo * 2;
    const x = hi + y;
    if (y === x - hi) hi = x;
  }
  return hi;
}
