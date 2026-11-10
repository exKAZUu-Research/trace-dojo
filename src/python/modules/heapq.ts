import { builtin } from '../define';
import { registerModule } from '../modules';
import { argument, checkArgs } from '../nativeArgs';
import { toIndex } from '../numbers';
import { callValue, toArray } from '../objects';
import { lessThan } from '../operators';
import { currentRuntime } from '../runtimeContext';
import { newList, None, pyError, typeError, typeName } from '../types';
import { type Kwargs, PyList, type PyValue } from '../values';

function heapOf(value: PyValue): PyValue[] {
  if (!(value instanceof PyList)) throw typeError(`heap argument must be a list, not ${typeName(value)}`);
  return value.items;
}

// The sift functions transcribe heapq.py, so that ties and comparisons happen in CPython's order.
function siftDown(heap: PyValue[], start: number, position: number): void {
  const item = heap[position];
  let pos = position;
  while (pos > start) {
    currentRuntime().spend();
    const parentPosition = (pos - 1) >> 1;
    const parent = heap[parentPosition];
    if (lessThan(item, parent)) {
      heap[pos] = parent;
      pos = parentPosition;
      continue;
    }
    break;
  }
  heap[pos] = item;
}

function siftUp(heap: PyValue[], position: number): void {
  const end = heap.length;
  const start = position;
  const item = heap[position];
  let pos = position;
  let child = 2 * pos + 1;
  while (child < end) {
    currentRuntime().spend();
    const right = child + 1;
    if (right < end && !lessThan(heap[child], heap[right])) child = right;
    heap[pos] = heap[child];
    pos = child;
    child = 2 * pos + 1;
  }
  heap[pos] = item;
  siftDown(heap, start, pos);
}

function heappush([heap, item]: PyValue[]): PyValue {
  const items = heapOf(heap);
  items.push(item);
  siftDown(items, 0, items.length - 1);
  return None;
}

function heappop([heap]: PyValue[]): PyValue {
  const items = heapOf(heap);
  if (items.length === 0) throw pyError('IndexError', 'index out of range');
  const last = items.pop() as PyValue;
  if (items.length === 0) return last;
  const result = items[0];
  items[0] = last;
  siftUp(items, 0);
  return result;
}

function heapify([heap]: PyValue[]): PyValue {
  const items = heapOf(heap);
  for (let index = (items.length >> 1) - 1; index >= 0; index--) siftUp(items, index);
  return None;
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

registerModule(
  'heapq',
  () =>
    new Map<string, PyValue>([
      ['heappush', builtin('heappush', 'expected', 2, 2, heappush)],
      ['heappop', builtin('heappop', 'one', 1, 1, heappop)],
      ['heapify', builtin('heapify', 'one', 1, 1, heapify)],
      [
        'heappushpop',
        builtin('heappushpop', 'expected', 2, 2, ([heap, item]) => {
          const items = heapOf(heap);
          if (items.length > 0 && lessThan(items[0], item)) {
            const result = items[0];
            items[0] = item;
            siftUp(items, 0);
            return result;
          }
          return item;
        }),
      ],
      [
        'heapreplace',
        builtin('heapreplace', 'expected', 2, 2, ([heap, item]) => {
          const items = heapOf(heap);
          if (items.length === 0) throw pyError('IndexError', 'index out of range');
          const result = items[0];
          items[0] = item;
          siftUp(items, 0);
          return result;
        }),
      ],
      ['nlargest', builtin('nlargest', 'takes', 2, 2, nSorted(true), { keywords: ['key'] })],
      ['nsmallest', builtin('nsmallest', 'takes', 2, 2, nSorted(false), { keywords: ['key'] })],
    ])
);

export { argument };
