import { BUILTIN_DOC } from '../attributes';
import { moduleBuiltin } from '../define';
import { runLibrarySource } from '../librarySource';
import { registerModule, registerUnsupportedAttributes } from '../modules';
import { argument } from '../nativeArgs';
import { lessThan } from '../operators';
import { currentRuntime } from '../runtimeContext';
import { None, pyError, typeError, typeName } from '../types';
import { PyList, type PyValue } from '../values';

const builtin = moduleBuiltin('_heapq');

/** The items of a heap argument, which argument clinic checks is a list, naming the function. */
function heapOf(value: PyValue, name: string, onlyArgument: boolean): PyValue[] {
  if (!(value instanceof PyList)) {
    throw typeError(`${name}() argument${onlyArgument ? '' : ' 1'} must be list, not ${typeName(value)}`);
  }
  return value.editableItems;
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
  (heap as PyList).append(item);
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

/**
 * heapq.merge, nsmallest, and nlargest from CPython 3.14's Lib/heapq.py, with `yield from` written as a loop and the
 * conditional expressions of nsmallest and nlargest written as statements.
 */
const HEAPQ_SOURCE = String.raw`def nsmallest(n, iterable, key=None):
    """Find the n smallest elements in a dataset.

    Equivalent to:  sorted(iterable, key=key)[:n]
    """

    # Short-cut for n==1 is to use min()
    if n == 1:
        it = iter(iterable)
        sentinel = object()
        result = min(it, default=sentinel, key=key)
        if result is sentinel:
            return []
        return [result]

    # When n>=size, it's faster to use sorted()
    try:
        size = len(iterable)
    except (TypeError, AttributeError):
        pass
    else:
        if n >= size:
            return sorted(iterable, key=key)[:n]

    # When key is none, use simpler decoration
    if key is None:
        it = iter(iterable)
        # put the range(n) first so that zip() doesn't
        # consume one too many elements from the iterator
        result = [(elem, i) for i, elem in zip(range(n), it)]
        if not result:
            return result
        heapify_max(result)
        top = result[0][0]
        order = n
        _heapreplace = heapreplace_max
        for elem in it:
            if elem < top:
                _heapreplace(result, (elem, order))
                top, _order = result[0]
                order += 1
        result.sort()
        return [elem for (elem, order) in result]

    # General case, slowest method
    it = iter(iterable)
    result = [(key(elem), i, elem) for i, elem in zip(range(n), it)]
    if not result:
        return result
    heapify_max(result)
    top = result[0][0]
    order = n
    _heapreplace = heapreplace_max
    for elem in it:
        k = key(elem)
        if k < top:
            _heapreplace(result, (k, order, elem))
            top, _order, _elem = result[0]
            order += 1
    result.sort()
    return [elem for (k, order, elem) in result]

def nlargest(n, iterable, key=None):
    """Find the n largest elements in a dataset.

    Equivalent to:  sorted(iterable, key=key, reverse=True)[:n]
    """

    # Short-cut for n==1 is to use max()
    if n == 1:
        it = iter(iterable)
        sentinel = object()
        result = max(it, default=sentinel, key=key)
        if result is sentinel:
            return []
        return [result]

    # When n>=size, it's faster to use sorted()
    try:
        size = len(iterable)
    except (TypeError, AttributeError):
        pass
    else:
        if n >= size:
            return sorted(iterable, key=key, reverse=True)[:n]

    # When key is none, use simpler decoration
    if key is None:
        it = iter(iterable)
        result = [(elem, i) for i, elem in zip(range(0, -n, -1), it)]
        if not result:
            return result
        heapify(result)
        top = result[0][0]
        order = -n
        _heapreplace = heapreplace
        for elem in it:
            if top < elem:
                _heapreplace(result, (elem, order))
                top, _order = result[0]
                order -= 1
        result.sort(reverse=True)
        return [elem for (elem, order) in result]

    # General case, slowest method
    it = iter(iterable)
    result = [(key(elem), i, elem) for i, elem in zip(range(0, -n, -1), it)]
    if not result:
        return result
    heapify(result)
    top = result[0][0]
    order = -n
    _heapreplace = heapreplace
    for elem in it:
        k = key(elem)
        if top < k:
            _heapreplace(result, (k, order, elem))
            top, _order, _elem = result[0]
            order -= 1
    result.sort(reverse=True)
    return [elem for (k, order, elem) in result]



def merge(*iterables, key=None, reverse=False):
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
                    s[0] = next()
                    _heapreplace(h, s)
            except StopIteration:
                _heappop(h)
        if h:
            value, order, next = h[0]
            yield value
            for value in next.__self__:
                yield value
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
        for value in next.__self__:
            yield value
`;

registerModule('heapq', () => {
  const natives = new Map<string, PyValue>([
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
  ]);
  return runLibrarySource('heapq', HEAPQ_SOURCE, natives);
});

registerUnsupportedAttributes('heapq', { __about__: BUILTIN_DOC });

export { argument };
