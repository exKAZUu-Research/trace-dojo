import type { Span } from '../ast';
// code-gauge-allow-file duplicateLines 26 -- Library types repeat the same shape of method on purpose, each over its own state.
import type { Frame } from '../runtime';
import { known, type SemaApi } from '../semaBase';
import { BOOL, fnType, optionalOf, type StructType, type Type, typeName, USIZE, VOID } from '../types';
import { FnValue, NULL, type Slice, type Value, ZStruct } from '../values';
import { compareScalars, constSlice, generic, mutableSlice, ORDER, tupleOf } from './common';
import { type Member, nativeCall, nativeFunction, nativeStruct } from './native';
import { type SortAlgorithm, sortValues } from './sorting';

/** `std.sort.asc(T)` and `desc(T)`: comparison functions for `std.mem.sort`. */
function comparator(name: string, direction: number): () => Member {
  const cache = new WeakMap<Type, FnValue>();
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
function sorter(name: string, algorithm: SortAlgorithm): () => Member {
  return generic(name, 4, (sema, call, type, [itemsArg, contextArg, lessThanArg]) => {
    const items = mutableSlice(sema, itemsArg, type);
    const context = sema.compile(contextArg);
    const lessThan = sema.functionOf(sema.compile(lessThanArg), lessThanArg);
    checkParams(sema, name, lessThan.params, [context.type, type, type], lessThanArg);
    return nativeCall(VOID, [items, context], call.span, ([value, contextValue], frame) => {
      const slice = value as Slice;
      const sorted = sortValues(
        slice.values(),
        (a, b) => lessThan.call(frame, [contextValue, a, b]) as boolean,
        algorithm,
        frame
      );
      for (const [index, value] of sorted.entries()) slice.set(index, value);
      return;
    });
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
    return nativeCall(resultType(type), [items, context], call.span, ([slice, contextValue], frame: Frame) => {
      const values = (slice as Slice).values();
      return compute(values, (args) => {
        frame.runtime.spend();
        return fn.call(frame, [contextValue, ...args]);
      });
    });
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

/** `equalRange(T, items, context, compareFn)`: the bounds of the items the function finds equal. */
function equalRangeMember(): Member {
  return generic('std.sort.equalRange', 4, (sema, call, type, [itemsArg, contextArg, fnArg]) => {
    const items = constSlice(sema, itemsArg, type);
    const context = sema.compile(contextArg);
    const fn = sema.functionOf(sema.compile(fnArg), fnArg);
    checkParams(sema, 'std.sort.equalRange', fn.params, [context.type, type], fnArg);
    return nativeCall(
      tupleOf(sema, [USIZE, USIZE]),
      [items, context],
      call.span,
      ([slice, contextValue], frame: Frame) => {
        const values = (slice as Slice).values();
        const order = (item: Value): bigint => {
          frame.runtime.spend();
          return fn.call(frame, [contextValue, item]) as bigint;
        };
        let low = 0;
        let high = values.length;
        while (low < high) {
          const middle = low + Math.floor((high - low) / 2);
          const comparison = order(values[middle]);
          if (comparison === 2n) low = middle + 1;
          else if (comparison === 0n) high = middle;
          else {
            const lower = low + partitionPoint(values.slice(low, middle), (item) => order(item) === 2n);
            const upper = middle + partitionPoint(values.slice(middle, high), (item) => order(item) !== 0n);
            return new ZStruct([BigInt(lower), BigInt(upper)]);
          }
        }
        return new ZStruct([BigInt(low), BigInt(low)]);
      }
    );
  })();
}

const MEMBERS: Record<string, () => Member> = {
  asc: comparator('std.sort.asc', 1),
  desc: comparator('std.sort.desc', -1),
  block: sorter('std.sort.block', 'stable'),
  insertion: sorter('std.sort.insertion', 'stable'),
  heap: sorter('std.sort.heap', 'heap'),
  pdq: sorter('std.sort.pdq', 'pdq'),
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
  equalRange: () => equalRangeMember(),
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
