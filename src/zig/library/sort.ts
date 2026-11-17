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
  nativeTransferCost,
  ORDER,
  ORDER_EQ,
  ORDER_GT,
  ORDER_LT,
  tupleOf,
} from './common';
import { callbackFunction, checkCallback, type Member, nativeCall, nativeFunction, nativeStruct } from './native';
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
          ([, a, b]) => compareScalars(a, b) * direction < 0,
          (sema, span) => {
            sema.valueComparator(type, true, span);
          }
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
    const lessThan = callbackFunction(sema, sema.compile(lessThanArg), lessThanArg);
    checkCallback(sema, name, lessThan, [context.type, type, type], BOOL, lessThanArg);
    const cost = nativeTransferCost(sema, type, call.span);
    const block = algorithm === 'block' ? blockSortFunction(sema, type, context.type, call.span) : undefined;
    return nativeCall(VOID, [items, context], call.span, ([value, contextValue], frame) => {
      const slice = value as Slice;
      const compare = (args: Value[]): Value => {
        frame.runtime.spend(cost * 2);
        return lessThan.call(frame, args);
      };
      if (block) runBlockSort(sema, block, frame, slice, contextValue, compare);
      else
        sortValues(
          slice,
          (a, b) => compare([contextValue, a, b]) as boolean,
          algorithm as Exclude<SortAlgorithm, 'block'>,
          frame,
          cost
        );
      return;
    });
  });
}

/** Functions of `(T, items, context, f)` that read the items with a function of the context and elements. */
function reader(
  name: string,
  elementCount: 1 | 2,
  callbackReturn: Type,
  resultType: (type: Type, sema: SemaApi) => Type,
  compute: (items: Slice, call: (args: Value[]) => Value, frame: Frame, type: Type) => Value
): () => Member {
  return generic(name, 4, (sema, call, type, [itemsArg, contextArg, fnArg]) => {
    const items = constSlice(sema, itemsArg, type);
    const context = sema.compile(contextArg);
    const fn = callbackFunction(sema, sema.compile(fnArg), fnArg);
    checkCallback(
      sema,
      name,
      fn,
      [context.type, ...Array.from({ length: elementCount }, () => type)],
      callbackReturn,
      fnArg
    );
    return nativeCall(resultType(type, sema), [items, context], call.span, ([slice, contextValue], frame: Frame) => {
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

function binarySearch(items: Slice, order: (item: Value) => bigint): Value {
  let low = 0n;
  let high = items.lengthValue;
  while (low < high) {
    const middle = low + (high - low) / 2n;
    const comparison = order(items.get(Number(middle)));
    if (comparison === ORDER_EQ) return middle;
    if (comparison === ORDER_GT) low = middle + 1n;
    else high = middle;
  }
  return NULL;
}

/** `partitionPoint`: the first index whose element the predicate rejects. */
function partitionPoint(items: Slice, predicate: (item: Value) => boolean): bigint {
  let position = 0n;
  let length = items.lengthValue;
  while (length > 1n) {
    const half = length / 2n;
    length -= half;
    if (predicate(items.get(Number(position + half - 1n)))) position += half;
  }
  if (position < items.lengthValue && predicate(items.get(Number(position)))) position++;
  return position;
}

function subSlice(items: Slice, start: bigint, end: bigint): Slice {
  return new Slice(items.target, items.start + Number(start), end - start);
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
  return reader(
    'std.sort.equalRange',
    1,
    ORDER,
    (_type, sema) => tupleOf(sema, [USIZE, USIZE]),
    (values, call) => {
      const order = (item: Value): bigint => call([item]) as bigint;
      let low = 0n;
      let high = values.lengthValue;
      while (low < high) {
        const middle = low + (high - low) / 2n;
        const comparison = order(values.get(Number(middle)));
        if (comparison === ORDER_GT) low = middle + 1n;
        else if (comparison === ORDER_LT) high = middle;
        else {
          const lower = low + partitionPoint(subSlice(values, low, middle), (item) => order(item) === ORDER_GT);
          const upper = middle + partitionPoint(subSlice(values, middle, high), (item) => order(item) !== ORDER_LT);
          return new ZStruct([lower, upper]);
        }
      }
      return new ZStruct([low, low]);
    }
  )();
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
    BOOL,
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
    ORDER,
    () => optionalOf(USIZE),
    (items, call) => binarySearch(items, (item) => call([item]) as bigint)
  ),
  equalRange: () => equalRangeMember(),
  lowerBound: reader(
    'std.sort.lowerBound',
    1,
    ORDER,
    () => USIZE,
    (items, call) => BigInt(partitionPoint(items, (item) => (call([item]) as bigint) === ORDER_GT))
  ),
  upperBound: reader(
    'std.sort.upperBound',
    1,
    ORDER,
    () => USIZE,
    (items, call) => BigInt(partitionPoint(items, (item) => (call([item]) as bigint) !== ORDER_LT))
  ),
  partitionPoint: reader(
    'std.sort.partitionPoint',
    1,
    BOOL,
    () => USIZE,
    (items, call) => BigInt(partitionPoint(items, (item) => call([item]) as boolean))
  ),
  argMin: reader(
    'std.sort.argMin',
    2,
    BOOL,
    () => optionalOf(USIZE),
    (items, call, frame, type) => extremum(items, call, frame, type, false)
  ),
  argMax: reader(
    'std.sort.argMax',
    2,
    BOOL,
    () => optionalOf(USIZE),
    (items, call, frame, type) => extremum(items, call, frame, type, true)
  ),
  min: reader(
    'std.sort.min',
    2,
    BOOL,
    (type) => optionalOf(type),
    (items, call, frame, type) => {
      const index = extremum(items, call, frame, type, false);
      return index === NULL ? NULL : optionalSome(items.get(Number(index as bigint)), type);
    }
  ),
  max: reader(
    'std.sort.max',
    2,
    BOOL,
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
