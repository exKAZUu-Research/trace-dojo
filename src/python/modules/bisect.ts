import { builtin } from '../define';
import { registerModule } from '../modules';
import { argument, checkArgs } from '../nativeArgs';
import { toIndex } from '../numbers';
import { callValue, getAttribute, getItem, lengthOf } from '../objects';
import { lessThan } from '../operators';
import { currentRuntime } from '../runtimeContext';
import { None, pyError, valueError } from '../types';
import { type Kwargs, PyList, PyRange, type PyValue } from '../values';

const KEYWORDS = ['a', 'x', 'lo', 'hi', 'key'];

const MAX_SSIZE = (1n << 63n) - 1n;

function bounds(
  args: PyValue[],
  kwargs: Kwargs,
  name: string
): { a: PyValue; x: PyValue; lo: bigint; hi: bigint; key: PyValue } {
  checkArgs({ qualified: name, min: 2, max: 4, style: 'takes', keywords: KEYWORDS, named: 4 }, args, kwargs);
  const a = argument(args, kwargs, 0, 'a') as PyValue;
  const x = argument(args, kwargs, 1, 'x') as PyValue;
  const lo = ssize(argument(args, kwargs, 2, 'lo') ?? 0n, 'Python int too large to convert to C ssize_t');
  if (lo < 0n) throw valueError('lo must be non-negative');
  const hiValue = argument(args, kwargs, 3, 'hi') ?? None;
  // Argument clinic converts `lo` as a Py_ssize_t and the optional `hi` with PyNumber_AsSsize_t, whose messages differ.
  const hi = hiValue === None ? lengthOfSequence(a) : ssize(hiValue, "cannot fit 'int' into an index-sized integer");
  return { a, x, lo, hi, key: kwargs?.get('key') ?? None };
}

/** An index argument as the Py_ssize_t CPython converts it to, raising OverflowError with `message` beyond it. */
function ssize(value: PyValue, message: string): bigint {
  const index = toIndex(value);
  if (index > MAX_SSIZE || index < -MAX_SSIZE - 1n) throw pyError('OverflowError', message);
  return index;
}

/** The length of the searched sequence, read exactly for a range, which a search need not materialize. */
function lengthOfSequence(a: PyValue): bigint {
  if (!(a instanceof PyRange)) return BigInt(lengthOf(a));
  if (a.length > MAX_SSIZE) throw pyError('OverflowError', 'Python int too large to convert to C ssize_t');
  return a.length;
}

// Transcribes bisect.py, so that it compares items in CPython's order; the bounds stay exact integers.
function search({ a, x, lo: start, hi: end, key }: ReturnType<typeof bounds>, right: boolean): bigint {
  let lo = start;
  let hi = end;
  while (lo < hi) {
    currentRuntime().spend();
    const middle = (lo + hi) / 2n;
    const item = getItem(a, middle);
    const itemKey = key === None ? item : callValue(key, [item]);
    if (right ? lessThan(x, itemKey) : lessThan(itemKey, x)) {
      if (right) hi = middle;
      else lo = middle + 1n;
    } else if (right) {
      lo = middle + 1n;
    } else {
      hi = middle;
    }
  }
  return lo;
}

function insort(right: boolean, name: string): (args: PyValue[], kwargs: Kwargs) => PyValue {
  return (args, kwargs) => {
    const searched = bounds(args, kwargs, name);
    const { a, x, key } = searched;
    const index = search({ ...searched, x: key === None ? x : callValue(key, [x]) }, right);
    if (a instanceof PyList) a.splice(Number(index), 0, [x]);
    else callValue(getAttribute(a, 'insert'), [index, x]);
    return None;
  };
}

registerModule('bisect', () => {
  const left = builtin(
    'bisect_left',
    'takes',
    2,
    4,
    (args, kwargs) => search(bounds(args, kwargs, 'bisect_left'), false),
    { keywords: KEYWORDS, named: 4 }
  );
  const right = builtin(
    'bisect_right',
    'takes',
    2,
    4,
    (args, kwargs) => search(bounds(args, kwargs, 'bisect_right'), true),
    { keywords: KEYWORDS, named: 4 }
  );
  const insortLeft = builtin('insort_left', 'takes', 2, 4, insort(false, 'insort_left'), {
    keywords: KEYWORDS,
    named: 4,
  });
  const insortRight = builtin('insort_right', 'takes', 2, 4, insort(true, 'insort_right'), {
    keywords: KEYWORDS,
    named: 4,
  });
  return new Map<string, PyValue>([
    ['bisect_left', left],
    ['bisect_right', right],
    ['bisect', right],
    ['insort_left', insortLeft],
    ['insort_right', insortRight],
    ['insort', insortRight],
  ]);
});
