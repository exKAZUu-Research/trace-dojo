import type { Span } from '../ast';
import { type Frame, withHeldValues } from '../runtime';
import { copyForFrame, known, type SemaApi } from '../semaBase';
import { BOOL, fnType, optionalOf, type StructType, type Type, typeName, USIZE, VOID } from '../types';
import { FnValue, NULL, optionalSome, Slice, type Value, ZStruct } from '../values';
import { blockSortFunction, runBlockSort } from './blockSort';
import {
  compareScalars,
  constSlice,
  generic,
  mutableSlice,
  ORDER,
  ORDER_EQ,
  ORDER_GT,
  ORDER_LT,
  tupleOf,
} from './common';
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
export function sorter(name: string, algorithm: SortAlgorithm): () => Member {
  return generic(name, 4, (sema, call, type, [itemsArg, contextArg, lessThanArg]) => {
    const items = mutableSlice(sema, itemsArg, type);
    const context = sema.compile(contextArg);
    const lessThan = sema.functionOf(sema.compile(lessThanArg), lessThanArg);
    checkParams(sema, name, lessThan.params, [context.type, type, type], lessThanArg);
    if (lessThan.returnType !== BOOL) sema.error(lessThanArg, '比べる関数の戻り値は bool にしてください。');
    const block = algorithm === 'block' ? blockSortFunction(sema, type, context.type, call.span) : undefined;
    return nativeCall(VOID, [items, context], call.span, ([value, contextValue], frame) => {
      const slice = value as Slice;
      if (block) runBlockSort(sema, block, frame, slice, contextValue, (args) => lessThan.call(frame, args));
      else
        sortValues(
          slice,
          (a, b) => lessThan.call(frame, [contextValue, a, b]) as boolean,
          algorithm as Exclude<SortAlgorithm, 'block'>,
          frame
        );
      return;
    });
  });
}

/** Functions of `(T, items, context, f)` that read the items with a function of the context and elements. */
function reader(
  name: string,
  elementCount: 1 | 2,
  resultType: (type: Type) => Type,
  compute: (items: Slice, call: (args: Value[]) => Value, frame: Frame, type: Type) => Value
): () => Member {
  return generic(name, 4, (sema, call, type, [itemsArg, contextArg, fnArg]) => {
    const items = constSlice(sema, itemsArg, type);
    const context = sema.compile(contextArg);
    const fn = sema.functionOf(sema.compile(fnArg), fnArg);
    checkParams(sema, name, fn.params, [context.type, ...Array.from({ length: elementCount }, () => type)], fnArg);
    return nativeCall(resultType(type), [items, context], call.span, ([slice, contextValue], frame: Frame) => {
      return compute(
        slice as Slice,
        (args) => {
          frame.runtime.spend();
          return fn.call(frame, [contextValue, ...args]);
        },
        frame,
        type
      );
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

function binarySearch(items: Slice, order: (item: Value) => bigint): Value {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const comparison = order(items.get(middle));
    if (comparison === ORDER_EQ) return BigInt(middle);
    if (comparison === ORDER_GT) low = middle + 1;
    else high = middle;
  }
  return NULL;
}

/** `partitionPoint`: the first index whose element the predicate rejects. */
function partitionPoint(items: Slice, predicate: (item: Value) => boolean): number {
  let position = 0;
  let length = items.length;
  while (length > 1) {
    const half = Math.floor(length / 2);
    length -= half;
    if (predicate(items.get(position + half - 1))) position += half;
  }
  if (position < items.length && predicate(items.get(position))) position++;
  return position;
}

function subSlice(items: Slice, start: number, end: number): Slice {
  return new Slice(items.target, items.start + start, end - start);
}

function extremum(items: Slice, call: (args: Value[]) => Value, frame: Frame, type: Type, maximum: boolean): Value {
  if (items.length === 0) return NULL;
  const saved = new ZStruct([copyForFrame(frame, items.get(0), type), undefined]);
  return withHeldValues(frame, [saved], () => {
    let best = 0;
    for (let index = 1; index < items.length; index++) {
      saved.slots[1] = copyForFrame(frame, items.get(index), type);
      const args = maximum ? [saved.slots[0], saved.slots[1]] : [saved.slots[1], saved.slots[0]];
      if (call(args) as boolean) {
        saved.slots[0] = saved.slots[1];
        best = index;
      }
      saved.slots[1] = undefined;
    }
    return BigInt(best);
  });
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
        const values = slice as Slice;
        const order = (item: Value): bigint => {
          frame.runtime.spend();
          return fn.call(frame, [contextValue, item]) as bigint;
        };
        let low = 0;
        let high = values.length;
        while (low < high) {
          const middle = low + Math.floor((high - low) / 2);
          const comparison = order(values.get(middle));
          if (comparison === ORDER_GT) low = middle + 1;
          else if (comparison === ORDER_LT) high = middle;
          else {
            const lower = low + partitionPoint(subSlice(values, low, middle), (item) => order(item) === ORDER_GT);
            const upper = middle + partitionPoint(subSlice(values, middle, high), (item) => order(item) !== ORDER_LT);
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
  block: sorter('std.sort.block', 'block'),
  insertion: sorter('std.sort.insertion', 'insertion'),
  heap: sorter('std.sort.heap', 'heap'),
  pdq: sorter('std.sort.pdq', 'pdq'),
  isSorted: reader(
    'std.sort.isSorted',
    2,
    () => BOOL,
    (items, call) => {
      for (let index = 1; index < items.length; index++)
        if (call([items.get(index), items.get(index - 1)]) as boolean) return false;
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
    (items, call) => BigInt(partitionPoint(items, (item) => (call([item]) as bigint) === ORDER_GT))
  ),
  upperBound: reader(
    'std.sort.upperBound',
    1,
    () => USIZE,
    (items, call) => BigInt(partitionPoint(items, (item) => (call([item]) as bigint) !== ORDER_LT))
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
    (items, call, frame, type) => extremum(items, call, frame, type, false)
  ),
  argMax: reader(
    'std.sort.argMax',
    2,
    () => optionalOf(USIZE),
    (items, call, frame, type) => extremum(items, call, frame, type, true)
  ),
  min: reader(
    'std.sort.min',
    2,
    (type) => optionalOf(type),
    (items, call, frame, type) => {
      const index = extremum(items, call, frame, type, false);
      return index === NULL ? NULL : optionalSome(items.get(Number(index as bigint)), type);
    }
  ),
  max: reader(
    'std.sort.max',
    2,
    (type) => optionalOf(type),
    (items, call, frame, type) => {
      const index = extremum(items, call, frame, type, true);
      return index === NULL ? NULL : optionalSome(items.get(Number(index as bigint)), type);
    }
  ),
};

let sort: StructType | undefined;

export function sortNamespace(): StructType {
  sort ??= nativeStruct('std.sort', MEMBERS);
  return sort;
}

export { ORDER };
