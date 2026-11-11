import { BUILTIN_DOC } from '../attributes';
import { builtin } from '../define';
import { registerModule, registerUnsupportedAttributes } from '../modules';
import { argument, checkArgs } from '../nativeArgs';
import { toIndex } from '../numbers';
import { callValue, toArray } from '../objects';
import { lessThan } from '../operators';
import { currentRuntime } from '../runtimeContext';
import { runModuleSource } from '../sourceModules';
import { newList, None, pyError, typeError, typeName } from '../types';
import { type Kwargs, PyList, type PyValue } from '../values';

/** The items of a heap argument, which argument clinic checks is a list, naming the function. */
function heapOf(value: PyValue, name: string, onlyArgument: boolean): PyValue[] {
  if (!(value instanceof PyList)) {
    throw typeError(`${name}() argument${onlyArgument ? '' : ' 1'} must be list, not ${typeName(value)}`);
  }
  return value.items;
}

type Less = (a: PyValue, b: PyValue) => boolean;
const minLess: Less = lessThan;
/** The order of the max-heap functions, whose heap has its largest item first. */
const maxLess: Less = (a, b) => lessThan(b, a);

// The sift functions transcribe heapq.py, so that ties and comparisons happen in CPython's order.
function siftDown(heap: PyValue[], start: number, position: number, less: Less = minLess): void {
  const item = heap[position];
  let pos = position;
  while (pos > start) {
    currentRuntime().spend();
    const parentPosition = (pos - 1) >> 1;
    const parent = heap[parentPosition];
    if (less(item, parent)) {
      heap[pos] = parent;
      pos = parentPosition;
      continue;
    }
    break;
  }
  heap[pos] = item;
}

function siftUp(heap: PyValue[], position: number, less: Less = minLess): void {
  const end = heap.length;
  const start = position;
  const item = heap[position];
  let pos = position;
  let child = 2 * pos + 1;
  while (child < end) {
    currentRuntime().spend();
    const right = child + 1;
    if (right < end && !less(heap[child], heap[right])) child = right;
    heap[pos] = heap[child];
    pos = child;
    child = 2 * pos + 1;
  }
  heap[pos] = item;
  siftDown(heap, start, pos, less);
}

function heappush([heap, item]: PyValue[], less: Less = minLess): PyValue {
  const items = heapOf(heap, less === minLess ? 'heappush' : 'heappush_max', false);
  items.push(item);
  siftDown(items, 0, items.length - 1, less);
  return None;
}

function heappop([heap]: PyValue[], less: Less = minLess): PyValue {
  const items = heapOf(heap, less === minLess ? 'heappop' : 'heappop_max', true);
  if (items.length === 0) throw pyError('IndexError', 'index out of range');
  const last = items.pop() as PyValue;
  if (items.length === 0) return last;
  const result = items[0];
  items[0] = last;
  siftUp(items, 0, less);
  return result;
}

function heapify([heap]: PyValue[], less: Less = minLess): PyValue {
  const items = heapOf(heap, less === minLess ? 'heapify' : 'heapify_max', true);
  for (let index = (items.length >> 1) - 1; index >= 0; index--) siftUp(items, index, less);
  return None;
}

function heappushpop([heap, item]: PyValue[], less: Less = minLess): PyValue {
  const items = heapOf(heap, less === minLess ? 'heappushpop' : 'heappushpop_max', false);
  if (items.length > 0 && less(items[0], item)) {
    const result = items[0];
    items[0] = item;
    siftUp(items, 0, less);
    return result;
  }
  return item;
}

function heapreplace([heap, item]: PyValue[], less: Less = minLess): PyValue {
  const items = heapOf(heap, less === minLess ? 'heapreplace' : 'heapreplace_max', false);
  if (items.length === 0) throw pyError('IndexError', 'index out of range');
  const result = items[0];
  items[0] = item;
  siftUp(items, 0, less);
  return result;
}

// code-gauge-allow functionCognitiveComplexity 17 -- Follows heapq.nsmallest and heapq.nlargest's shortcuts.
function nSorted(largest: boolean): (args: PyValue[], kwargs: Kwargs) => PyValue {
  return (args, kwargs) => {
    checkArgs(
      { qualified: largest ? 'nlargest' : 'nsmallest', min: 2, max: 2, style: 'takes', keywords: ['key'] },
      args,
      kwargs
    );
    const count = Number(toIndex(args[0]));
    const key = kwargs?.get('key') ?? None;
    const items = toArray(args[1]).map((item, index) => ({
      item,
      index,
      key: key === None ? item : callValue(key, [item]),
    }));
    const sorted = items.toSorted((a, b) => {
      const first = largest ? b : a;
      const second = largest ? a : b;
      if (lessThan(first.key, second.key)) return -1;
      if (lessThan(second.key, first.key)) return 1;
      return a.index - b.index;
    });
    return newList(sorted.slice(0, Math.max(0, count)).map((entry) => entry.item));
  };
}

/** `heapq.merge` from CPython's `heapq.py`. */
const MERGE_SOURCE = String.raw`
def merge(*iterables, key=None, reverse=False):
    '''Merge multiple sorted inputs into a single sorted output.

    Similar to sorted(itertools.chain(*iterables)) but returns a generator,
    does not pull the data into memory all at once, and assumes that each of
    the input streams is already sorted (smallest to largest).

    >>> list(merge([1,3,5,7], [0,2,4,8], [5,10,15,20], [], [25]))
    [0, 1, 2, 3, 4, 5, 5, 7, 8, 10, 15, 20, 25]

    If *key* is not None, applies a key function to each element to determine
    its sort order.

    >>> list(merge(['dog', 'horse'], ['cat', 'fish', 'kangaroo'], key=len))
    ['dog', 'cat', 'fish', 'horse', 'kangaroo']

    '''

    h = []
    h_append = h.append

    if reverse:
        _heapify = heapify_max
        _heappop = heappop_max
        _heapreplace = heapreplace_max
        direction = -1
    else:
        _heapify = heapify
        _heappop = heappop
        _heapreplace = heapreplace
        direction = 1

    if key is None:
        for order, it in enumerate(map(iter, iterables)):
            try:
                next = it.__next__
                h_append([next(), order * direction, next])
            except StopIteration:
                pass
        _heapify(h)
        while len(h) > 1:
            try:
                while True:
                    value, order, next = s = h[0]
                    yield value
                    s[0] = next()           # raises StopIteration when exhausted
                    _heapreplace(h, s)      # restore heap condition
            except StopIteration:
                _heappop(h)                 # remove empty iterator
        if h:
            # fast case when only a single iterator remains
            value, order, next = h[0]
            yield value
            yield from next.__self__
        return

    for order, it in enumerate(map(iter, iterables)):
        try:
            next = it.__next__
            value = next()
            h_append([key(value), order * direction, value, next])
        except StopIteration:
            pass
    _heapify(h)
    while len(h) > 1:
        try:
            while True:
                key_value, order, value, next = s = h[0]
                yield value
                value = next()
                s[0] = key(value)
                s[2] = value
                _heapreplace(h, s)
        except StopIteration:
            _heappop(h)
    if h:
        key_value, order, value, next = h[0]
        yield value
        yield from next.__self__
`;

registerModule('heapq', (runtime, namespace) => {
  for (const [key, value] of [
    ['heappush', builtin('heappush', 'expected', 2, 2, (args) => heappush(args))],
    ['heappop', builtin('heappop', 'one', 1, 1, (args) => heappop(args))],
    ['heapify', builtin('heapify', 'one', 1, 1, (args) => heapify(args))],
    ['heappushpop', builtin('heappushpop', 'expected', 2, 2, (args) => heappushpop(args))],
    ['heapreplace', builtin('heapreplace', 'expected', 2, 2, (args) => heapreplace(args))],
    ['heappush_max', builtin('heappush_max', 'expected', 2, 2, (args) => heappush(args, maxLess))],
    ['heappop_max', builtin('heappop_max', 'one', 1, 1, (args) => heappop(args, maxLess))],
    ['heapify_max', builtin('heapify_max', 'one', 1, 1, (args) => heapify(args, maxLess))],
    ['heappushpop_max', builtin('heappushpop_max', 'expected', 2, 2, (args) => heappushpop(args, maxLess))],
    ['heapreplace_max', builtin('heapreplace_max', 'expected', 2, 2, (args) => heapreplace(args, maxLess))],
    ['nlargest', builtin('nlargest', 'takes', 2, 2, nSorted(true), { keywords: ['key'] })],
    ['nsmallest', builtin('nsmallest', 'takes', 2, 2, nSorted(false), { keywords: ['key'] })],
  ] as [string, PyValue][]) {
    namespace.set(key, value);
  }
  runModuleSource(runtime, namespace, MERGE_SOURCE);
  return new Map();
});

registerUnsupportedAttributes('heapq', { __about__: BUILTIN_DOC });

export { argument };
