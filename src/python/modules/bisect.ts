import { builtin } from '../define';
import { registerModule } from '../modules';
import { argument, checkArgs } from '../nativeArgs';
import { toIndex } from '../numbers';
import { callValue, getAttribute, getItem, lengthOf } from '../objects';
import { lessThan } from '../operators';
import { currentRuntime } from '../runtimeContext';
import { None, valueError } from '../types';
import { type Kwargs, PyList, type PyValue } from '../values';

const KEYWORDS = ['a', 'x', 'lo', 'hi', 'key'];

function bounds(
  args: PyValue[],
  kwargs: Kwargs,
  name: string
): { a: PyValue; x: PyValue; lo: number; hi: number; key: PyValue } {
  checkArgs({ qualified: name, min: 2, max: 4, style: 'takes', keywords: KEYWORDS }, args, kwargs);
  const a = argument(args, kwargs, 0, 'a') as PyValue;
  const x = argument(args, kwargs, 1, 'x') as PyValue;
  const lo = Number(toIndex(argument(args, kwargs, 2, 'lo') ?? 0n));
  if (lo < 0) throw valueError('lo must be non-negative');
  const hiValue = argument(args, kwargs, 3, 'hi') ?? None;
  const hi = hiValue === None ? lengthOf(a) : Number(toIndex(hiValue));
  return { a, x, lo, hi, key: kwargs?.get('key') ?? None };
}

// Transcribes bisect.py, so that it compares items in CPython's order.
function search(args: PyValue[], kwargs: Kwargs, name: string, right: boolean): number {
  const { a, x, key } = bounds(args, kwargs, name);
  let { lo, hi } = bounds(args, kwargs, name);
  while (lo < hi) {
    currentRuntime().spend();
    const middle = (lo + hi) >> 1;
    const item = getItem(a, BigInt(middle));
    const itemKey = key === None ? item : callValue(key, [item]);
    if (right ? lessThan(x, itemKey) : lessThan(itemKey, x)) {
      if (right) hi = middle;
      else lo = middle + 1;
    } else if (right) {
      lo = middle + 1;
    } else {
      hi = middle;
    }
  }
  return lo;
}

function insort(right: boolean, name: string): (args: PyValue[], kwargs: Kwargs) => PyValue {
  return (args, kwargs) => {
    const { a, x, key } = bounds(args, kwargs, name);
    const searchArgs = [...args];
    searchArgs[1] = key === None ? x : callValue(key, [x]);
    const index = search(searchArgs, kwargs, name, right);
    if (a instanceof PyList) a.items.splice(index, 0, x);
    else callValue(getAttribute(a, 'insert'), [BigInt(index), x]);
    return None;
  };
}

registerModule('bisect', () => {
  const left = builtin(
    'bisect_left',
    'takes',
    2,
    4,
    (args, kwargs) => BigInt(search(args, kwargs, 'bisect_left', false)),
    { keywords: KEYWORDS }
  );
  const right = builtin(
    'bisect_right',
    'takes',
    2,
    4,
    (args, kwargs) => BigInt(search(args, kwargs, 'bisect_right', true)),
    { keywords: KEYWORDS }
  );
  const insortLeft = builtin('insort_left', 'takes', 2, 4, insort(false, 'insort_left'), { keywords: KEYWORDS });
  const insortRight = builtin('insort_right', 'takes', 2, 4, insort(true, 'insort_right'), { keywords: KEYWORDS });
  return new Map<string, PyValue>([
    ['bisect_left', left],
    ['bisect_right', right],
    ['bisect', right],
    ['insort_left', insortLeft],
    ['insort_right', insortRight],
    ['insort', insortRight],
  ]);
});
