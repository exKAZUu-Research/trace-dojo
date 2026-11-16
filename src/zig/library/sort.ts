import type { Span } from '../ast';
// code-gauge-allow-file duplicateLines 25 -- Library types repeat the same shape of method on purpose, each over its own state.
import type { Frame } from '../runtime';
import { known, runtime, type SemaApi } from '../semaBase';
import { BOOL, fnType, optionalOf, type StructType, type Type, typeName, USIZE, VOID } from '../types';
import { FnValue, NULL, type Slice, type Value } from '../values';
import { compareScalars, constSlice, generic, mutableSlice, ORDER } from './common';
import { type Member, nativeFunction, nativeStruct } from './native';
import { sortValues } from './sorting';

/** `std.sort.asc(T)` and `desc(T)`: comparison functions for `std.mem.sort`. */
function comparator(name: string, direction: number): () => Member {
  const cache = new Map<Type, FnValue>();
  return generic(name, 1, (_sema, call, type) => {
    let value = cache.get(type);
    if (!value) {
      value = new FnValue(
        nativeFunction(
          `${name}(${typeName(type)})`,
          [VOID, type, type],
          BOOL,
          ([, a, b]) => compareScalars(a, b) * direction < 0
        )
      );
      cache.set(type, value);
    }
    return known(fnType([VOID, type, type], BOOL), value, call.span);
  });
}

/** `sort(T, items, context, lessThan)` for each of Zig's sort algorithms. */
function sorter(name: string, stable: boolean): () => Member {
  return generic(name, 4, (sema, call, type, [itemsArg, contextArg, lessThanArg]) => {
    const items = mutableSlice(sema, itemsArg, type);
    const context = sema.compile(contextArg);
    const lessThan = sema.functionOf(sema.compile(lessThanArg), lessThanArg);
    checkParams(sema, name, lessThan.params, [context.type, type, type], lessThanArg);
    const evaluateItems = items.eval;
    const evaluateContext = context.eval;
    return runtime(
      VOID,
      (frame) => {
        const slice = evaluateItems(frame) as Slice;
        const contextValue = evaluateContext(frame);
        const sorted = sortValues(
          slice.values(),
          (a, b) => lessThan.call(frame, [contextValue, a, b]) as boolean,
          stable,
          frame
        );
        for (const [index, value] of sorted.entries()) slice.set(index, value);
        return;
      },
      call.span
    );
  });
}

/** Functions of `(T, items, context, f)` that read the items with a function of the context and elements. */
function reader(
  name: string,
  elementCount: 1 | 2,
  resultType: (type: Type) => Type,
  compute: (items: Value[], call: (args: Value[]) => Value) => Value
): () => Member {
  return generic(name, 4, (sema, call, type, [itemsArg, contextArg, fnArg]) => {
    const items = constSlice(sema, itemsArg, type);
    const context = sema.compile(contextArg);
    const fn = sema.functionOf(sema.compile(fnArg), fnArg);
    checkParams(sema, name, fn.params, [context.type, ...Array.from({ length: elementCount }, () => type)], fnArg);
    const evaluateItems = items.eval;
    const evaluateContext = context.eval;
    return runtime(
      resultType(type),
      (frame: Frame) => {
        const values = (evaluateItems(frame) as Slice).values();
        const contextValue = evaluateContext(frame);
        return compute(values, (args) => {
          frame.runtime.spend();
          return fn.call(frame, [contextValue, ...args]);
        });
      },
      call.span
    );
  });
}

/** Zig requires the function's parameters to be exactly the context's type followed by the element type. */
function checkParams(
  sema: SemaApi,
  name: string,
  params: readonly Type[],
  expected: readonly Type[],
  span: Span
): void {
  if (params.length === expected.length && params.every((param, index) => param === expected[index])) return;
  sema.error(
    span,
    `${name} に渡す関数の引数は、(${expected.map((type) => typeName(type)).join(', ')}) にしてください。`
  );
}

function binarySearch(items: Value[], order: (item: Value) => bigint): Value {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const comparison = order(items[middle]);
    if (comparison === 1n) return BigInt(middle);
    if (comparison === 2n) low = middle + 1;
    else high = middle;
  }
  return NULL;
}

/** `partitionPoint`: the first index whose element the predicate rejects. */
function partitionPoint(items: Value[], predicate: (item: Value) => boolean): number {
  let low = 0;
  let size = items.length;
  while (size > 0) {
    const half = Math.floor(size / 2);
    const middle = low + half;
    if (predicate(items[middle])) {
      low = middle + 1;
      size -= half + 1;
    } else {
      size = half;
    }
  }
  return low;
}

const MEMBERS: Record<string, () => Member> = {
  asc: comparator('std.sort.asc', 1),
  desc: comparator('std.sort.desc', -1),
  block: sorter('std.sort.block', true),
  insertion: sorter('std.sort.insertion', true),
  heap: sorter('std.sort.heap', false),
  pdq: sorter('std.sort.pdq', false),
  isSorted: reader(
    'std.sort.isSorted',
    2,
    () => BOOL,
    (items, call) => {
      for (let index = 1; index < items.length; index++)
        if (call([items[index], items[index - 1]]) as boolean) return false;
      return true;
    }
  ),
  binarySearch: reader(
    'std.sort.binarySearch',
    1,
    () => optionalOf(USIZE),
    (items, call) => binarySearch(items, (item) => call([item]) as bigint)
  ),
  lowerBound: reader(
    'std.sort.lowerBound',
    1,
    () => USIZE,
    (items, call) => BigInt(partitionPoint(items, (item) => (call([item]) as bigint) === 2n))
  ),
  upperBound: reader(
    'std.sort.upperBound',
    1,
    () => USIZE,
    (items, call) => BigInt(partitionPoint(items, (item) => (call([item]) as bigint) !== 0n))
  ),
  partitionPoint: reader(
    'std.sort.partitionPoint',
    1,
    () => USIZE,
    (items, call) => BigInt(partitionPoint(items, (item) => call([item]) as boolean))
  ),
  argMin: reader(
    'std.sort.argMin',
    2,
    () => optionalOf(USIZE),
    (items, call) => {
      if (items.length === 0) return NULL;
      let best = 0;
      for (let index = 1; index < items.length; index++) if (call([items[index], items[best]]) as boolean) best = index;
      return BigInt(best);
    }
  ),
  argMax: reader(
    'std.sort.argMax',
    2,
    () => optionalOf(USIZE),
    (items, call) => {
      if (items.length === 0) return NULL;
      let best = 0;
      for (let index = 1; index < items.length; index++) if (call([items[best], items[index]]) as boolean) best = index;
      return BigInt(best);
    }
  ),
  min: reader(
    'std.sort.min',
    2,
    (type) => optionalOf(type),
    (items, call) => {
      if (items.length === 0) return NULL;
      let best = 0;
      for (let index = 1; index < items.length; index++) if (call([items[index], items[best]]) as boolean) best = index;
      return items[best];
    }
  ),
  max: reader(
    'std.sort.max',
    2,
    (type) => optionalOf(type),
    (items, call) => {
      if (items.length === 0) return NULL;
      let best = 0;
      for (let index = 1; index < items.length; index++) if (call([items[best], items[index]]) as boolean) best = index;
      return items[best];
    }
  ),
};

let sort: StructType | undefined;

export function sortNamespace(): StructType {
  sort ??= nativeStruct('std.sort', MEMBERS);
  return sort;
}

export { ORDER };
