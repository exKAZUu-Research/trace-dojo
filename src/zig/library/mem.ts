// code-gauge-allow-file fileNcss 577 -- Groups the related standard library operations that share this module.
// code-gauge-allow-file duplicateLines 25 -- Library types repeat the same shape of method on purpose, each over its own state.
import { indexOutOfBounds, PANIC, panic } from '../arith';
import type { Expression, Span } from '../ast';
import { type AnyFloat, compareFloats, floatFromBigInt, minMaxFloat } from '../floats';
import { sizeOf } from '../layout';
import type { Frame } from '../runtime';
import { copyForStorage, known, newArray, runtime, type SemaApi, type TExpr, undefinedValue } from '../semaBase';
import {
  BOOL,
  CONST_U8_SLICE,
  optionalOf,
  pointerTo,
  sliceOf,
  type StructField,
  type StructType,
  TYPE,
  type Type,
  typeId,
  typeName,
  U8,
  USIZE,
  VOID,
} from '../types';
import { NULL, type Pointer, Slice, storageLocation, storageOverlaps, storeInto, type Value, ZStruct } from '../values';
import { WeakValueMap } from '../weakValueMap';
import { blockSortFunction, runBlockSort } from './blockSort';
import {
  allocating,
  allocatorArg,
  compareScalars,
  computed,
  constSlice,
  elements,
  equalValues,
  generic,
  mutableSlice,
  newSlice,
  OPTIONAL_USIZE,
  optionalIndex,
  ORDER,
  orderValue,
  storeSliceValue,
  storeSliceValues,
  subSlice,
  tupleOf,
} from './common';
import { ALLOCATOR, allocatorState, ERROR_OUT_OF_MEMORY, reserveNativeAllocation } from './heap';
import {
  addMembers,
  compileArgs,
  expectArgs,
  fnMember,
  type Member,
  nativeCall,
  nativeStruct,
  typeMember,
} from './native';
import { type SortAlgorithm, sortValues } from './sorting';

interface AllocationPlan {
  length: number;
  build: () => Value[];
}

function comparisonBudget(sema: SemaApi, frame?: Frame): typeof equalValues {
  const spend = nativeBudget(sema, frame);
  return (a, b) => {
    spend();
    return equalValues(a, b);
  };
}

function nativeBudget(sema: SemaApi, frame?: Frame): () => void {
  return frame ? () => frame.runtime.spend() : () => sema.spendCompilation();
}

function findSequence(haystack: Value[], needle: Value[], from: number, equal: typeof equalValues): number {
  if (needle.length === 0) return from <= haystack.length ? from : -1;
  outer: for (let index = from; index + needle.length <= haystack.length; index++) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (!equal(haystack[index + offset], needle[offset])) continue outer;
    }
    return index;
  }
  return -1;
}

function findSequenceLast(haystack: Value[], needle: Value[], equal: typeof equalValues): number {
  for (let index = haystack.length - needle.length; index >= 0; index--) {
    if (needle.every((value, offset) => equal(haystack[index + offset], value))) return index;
  }
  return -1;
}

function startsWith(haystack: Value[], needle: Value[], equal: typeof equalValues, at = 0): boolean {
  return at + needle.length <= haystack.length && needle.every((value, offset) => equal(haystack[at + offset], value));
}

/** `(T, slice, other)` functions that compare two slices or a slice and a scalar, known at compile time when both are. */
function sliceSearch(
  name: string,
  second: 'slice' | 'scalar',
  resultType: Type,
  compute: (haystack: Value[], operand: Value, equal: typeof equalValues) => Value
): () => Member {
  return generic(name, 3, (sema, call, type, [haystack, operand]) => {
    const a = constSlice(sema, haystack, type);
    const b =
      second === 'slice' ? constSlice(sema, operand, type) : sema.coerce(sema.compile(operand, type), type, operand);
    return computed(resultType, [a, b], call.span, ([x, y], frame) =>
      compute(elements(x), second === 'slice' ? (elements(y) as unknown as Value) : y, comparisonBudget(sema, frame))
    );
  });
}

function positionSearch(
  name: string,
  second: 'slice' | 'scalar',
  compute: (haystack: Value[], start: number, operand: Value, equal: typeof equalValues) => number
): () => Member {
  return generic(name, 4, (sema, call, type, [haystack, startArg, operand]) => {
    const a = constSlice(sema, haystack, type);
    const [start] = compileArgs(sema, [startArg], [USIZE]);
    const b =
      second === 'slice' ? constSlice(sema, operand, type) : sema.coerce(sema.compile(operand, type), type, operand);
    return computed(OPTIONAL_USIZE, [a, start, b], call.span, ([x, s, y], frame) =>
      optionalIndex(
        compute(
          elements(x),
          Number(s as bigint),
          second === 'slice' ? (elements(y) as unknown as Value) : y,
          comparisonBudget(sema, frame)
        )
      )
    );
  });
}

// code-gauge-allow functionCognitiveComplexity 16 -- Handles each kind of value the operation accepts.
function trimmer(name: string, start: boolean, end: boolean): () => Member {
  return generic(name, 3, (sema, call, type, [sliceArg, stripArg]) => {
    const slice = constSlice(sema, sliceArg, type);
    const strip = constSlice(sema, stripArg, type);
    return computed(sliceOf(type, true), [slice, strip], call.span, ([value, values], frame) => {
      const items = elements(value);
      const set = elements(values);
      const equal = comparisonBudget(sema, frame);
      let from = 0;
      let to = items.length;
      if (start) while (from < to && set.some((each) => equal(each, items[from]))) from++;
      if (end) while (to > from && set.some((each) => equal(each, items[to - 1]))) to--;
      return slicePart(value, from, to - from);
    });
  });
}

function slicePart(value: Value, start: number, length: number): Slice {
  if (value instanceof Slice) return subSlice(value, start, length);
  return newSlice(elements(value).slice(start, start + length));
}

// Iterators -----------------------------------------------------------------------------------------------------------

type DelimiterKind = 'scalar' | 'sequence' | 'any';

const iteratorTypes = new WeakValueMap<string, StructType>();

/** `std.mem.SplitIterator(T, kind)` or `TokenIterator`: fields `buffer`, `index`, and `delimiter`, as in Zig. */
function iteratorType(kind: 'split' | 'token', delimiter: DelimiterKind, child: Type): StructType {
  const key = `${kind} ${delimiter} ${typeId(child)}`;
  let type = iteratorTypes.get(key);
  if (type) return type;
  const delimiterType = delimiter === 'scalar' ? child : sliceOf(child, true);
  const resultSlice = sliceOf(child, true);
  const created: StructType = nativeStruct(
    `mem.${kind === 'split' ? 'SplitIterator' : 'TokenIterator'}(${typeName(child)},.${delimiter})`,
    {},
    [
      { name: 'buffer', type: resultSlice, hasDefault: false },
      { name: 'index', type: kind === 'split' ? optionalOf(USIZE) : USIZE, hasDefault: false },
      { name: 'delimiter', type: delimiterType, hasDefault: false },
    ]
  );
  type = created;
  iteratorTypes.set(key, type);
  const isDelimiter = (buffer: Value[], index: number, value: Value, equal: typeof equalValues): boolean => {
    if (delimiter === 'scalar') return equal(buffer[index], value);
    const set = elements(value);
    if (delimiter === 'any') return set.some((each) => equal(each, buffer[index]));
    return startsWith(buffer, set, equal, index);
  };
  const delimiterLength = (value: Value): number => (delimiter === 'sequence' ? elements(value).length : 1);
  const method = (
    name: string,
    returnType: Type,
    run: (state: ZStruct, equal: typeof equalValues) => Value
  ): (() => Member) =>
    fnMember(`${key}.${name}`, (sema, call) => {
      expectArgs(sema, call, 0, name);
      const state = iteratorState(sema, call.receiver, created, call.span);
      return runtime(
        returnType,
        (frame) => {
          frame.runtime.spend();
          return run(state(frame), comparisonBudget(sema, frame));
        },
        call.span
      );
    });
  const tokenPeek = (state: ZStruct, equal: typeof equalValues): { start: number; end: number } | undefined => {
    const buffer = elements(state.slots[0]);
    let index = Number(state.slots[1] as bigint);
    while (index < buffer.length && isDelimiter(buffer, index, state.slots[2], equal))
      index += delimiterLength(state.slots[2]);
    state.slots[1] = BigInt(index);
    if (index === buffer.length) return undefined;
    let end = index;
    while (end < buffer.length && !isDelimiter(buffer, end, state.slots[2], equal)) end++;
    return { start: index, end };
  };
  const members: Record<string, () => Member> =
    kind === 'split'
      ? {
          next: method('next', optionalOf(resultSlice), (state, equal) => {
            const startValue = state.slots[1];
            if (startValue === NULL) return NULL;
            const start = Number(startValue as bigint);
            const buffer = elements(state.slots[0]);
            let end = buffer.length;
            let found = -1;
            for (let index = start; index < buffer.length; index++) {
              if (
                delimiter === 'sequence'
                  ? startsWith(buffer, elements(state.slots[2]), equal, index)
                  : isDelimiter(buffer, index, state.slots[2], equal)
              ) {
                found = index;
                break;
              }
            }
            if (delimiter === 'sequence' && found === -1 && elements(state.slots[2]).length === 0) found = start;
            if (found === -1) {
              state.slots[1] = NULL;
            } else {
              state.slots[1] = BigInt(found + delimiterLength(state.slots[2]));
              end = found;
            }
            return subSlice(state.slots[0] as Slice, start, end - start);
          }),
          first: method('first', resultSlice, (state, equal) => {
            const buffer = elements(state.slots[0]);
            let end = buffer.length;
            for (let index = 0; index < buffer.length; index++) {
              if (isDelimiter(buffer, index, state.slots[2], equal)) {
                end = index;
                break;
              }
            }
            state.slots[1] = end === buffer.length ? NULL : BigInt(end + delimiterLength(state.slots[2]));
            return subSlice(state.slots[0] as Slice, 0, end);
          }),
          peek: method('peek', optionalOf(resultSlice), (state, equal) => {
            const startValue = state.slots[1];
            if (startValue === NULL) return NULL;
            const start = Number(startValue as bigint);
            const buffer = elements(state.slots[0]);
            let end = buffer.length;
            for (let index = start; index < buffer.length; index++) {
              if (isDelimiter(buffer, index, state.slots[2], equal)) {
                end = index;
                break;
              }
            }
            return subSlice(state.slots[0] as Slice, start, end - start);
          }),
          rest: method('rest', resultSlice, (state) => {
            const buffer = state.slots[0] as Slice;
            const startValue = state.slots[1];
            const start = startValue === NULL ? buffer.length : Number(startValue as bigint);
            return subSlice(buffer, start, buffer.length - start);
          }),
          reset: method('reset', VOID, (state) => {
            state.slots[1] = 0n;
            return;
          }),
        }
      : {
          next: method('next', optionalOf(resultSlice), (state, equal) => {
            const token = tokenPeek(state, equal);
            if (!token) return NULL;
            state.slots[1] = BigInt(token.end);
            return subSlice(state.slots[0] as Slice, token.start, token.end - token.start);
          }),
          peek: method('peek', optionalOf(resultSlice), (state, equal) => {
            const token = tokenPeek(state, equal);
            if (!token) return NULL;
            return subSlice(state.slots[0] as Slice, token.start, token.end - token.start);
          }),
          rest: method('rest', resultSlice, (state, equal) => {
            const buffer = elements(state.slots[0]);
            let index = Number(state.slots[1] as bigint);
            while (index < buffer.length && isDelimiter(buffer, index, state.slots[2], equal))
              index += delimiterLength(state.slots[2]);
            return subSlice(state.slots[0] as Slice, index, buffer.length - index);
          }),
          reset: method('reset', VOID, (state) => {
            state.slots[1] = 0n;
            return;
          }),
        };
  addMembers(created, members);
  return created;
}

function iteratorState(
  sema: SemaApi,
  receiver: TExpr | undefined,
  type: StructType,
  span: Span
): (frame: Frame) => ZStruct {
  if (!receiver) return sema.error(span, 'イテレータの値に対して呼び出してください。');
  const evaluate = receiver.eval;
  if (receiver.type.kind === 'pointer' && receiver.type.child === type)
    return (frame) => (evaluate(frame) as Pointer).load() as ZStruct;
  if (receiver.type !== type) return sema.error(span, 'イテレータの値に対して呼び出してください。');
  const address = sema.addressOf(receiver);
  if (address.type.kind === 'pointer' && address.type.isConst)
    sema.error(span, 'イテレータは var で宣言してください。');
  const locate = address.eval;
  return (frame) => (locate(frame) as Pointer).load() as ZStruct;
}

function iteratorFactory(name: string, kind: 'split' | 'token', delimiter: DelimiterKind): () => Member {
  return generic(name, 3, (sema, call, type, [bufferArg, delimiterArg]) => {
    const buffer = constSlice(sema, bufferArg, type);
    const delimiterValue =
      delimiter === 'scalar'
        ? sema.coerce(sema.compile(delimiterArg, type), type, delimiterArg)
        : constSlice(sema, delimiterArg, type);
    const iterator = iteratorType(kind, delimiter, type);
    return computed(iterator, [buffer, delimiterValue], call.span, ([value, separator]) => {
      if (delimiter === 'sequence' && elements(separator).length === 0) panic('reached unreachable code');
      return new ZStruct([value, 0n, separator]);
    });
  });
}

// The namespace ---------------------------------------------------------------------------------------------------------

const MEMBERS: Record<string, () => Member> = {
  Allocator: typeMember(() => ALLOCATOR),
  eql: generic('std.mem.eql', 3, (sema, call, type, [a, b]) => {
    const left = constSlice(sema, a, type);
    const right = constSlice(sema, b, type);
    return computed(BOOL, [left, right], call.span, ([x, y]) => {
      const xs = elements(x);
      const ys = elements(y);
      return xs.length === ys.length && xs.every((value, index) => equalValues(value, ys[index]));
    });
  }),
  startsWith: sliceSearch('std.mem.startsWith', 'slice', BOOL, (haystack, needle, equal) =>
    startsWith(haystack, needle as unknown as Value[], equal)
  ),
  endsWith: sliceSearch('std.mem.endsWith', 'slice', BOOL, (haystack, needle, equal) => {
    const values = needle as unknown as Value[];
    return startsWith(haystack, values, equal, haystack.length - values.length) && values.length <= haystack.length;
  }),
  indexOf: sliceSearch('std.mem.indexOf', 'slice', OPTIONAL_USIZE, (h, n, equal) =>
    optionalIndex(findSequence(h, n as unknown as Value[], 0, equal))
  ),
  find: sliceSearch('std.mem.find', 'slice', OPTIONAL_USIZE, (h, n, equal) =>
    optionalIndex(findSequence(h, n as unknown as Value[], 0, equal))
  ),
  lastIndexOf: sliceSearch('std.mem.lastIndexOf', 'slice', OPTIONAL_USIZE, (h, n, equal) =>
    optionalIndex(findSequenceLast(h, n as unknown as Value[], equal))
  ),
  findLast: sliceSearch('std.mem.findLast', 'slice', OPTIONAL_USIZE, (h, n, equal) =>
    optionalIndex(findSequenceLast(h, n as unknown as Value[], equal))
  ),
  indexOfScalar: sliceSearch('std.mem.indexOfScalar', 'scalar', OPTIONAL_USIZE, (h, v, equal) =>
    optionalIndex(h.findIndex((x) => equal(x, v)))
  ),
  findScalar: sliceSearch('std.mem.findScalar', 'scalar', OPTIONAL_USIZE, (h, v, equal) =>
    optionalIndex(h.findIndex((x) => equal(x, v)))
  ),
  lastIndexOfScalar: sliceSearch('std.mem.lastIndexOfScalar', 'scalar', OPTIONAL_USIZE, (h, v, equal) =>
    optionalIndex(h.findLastIndex((x) => equal(x, v)))
  ),
  findScalarLast: sliceSearch('std.mem.findScalarLast', 'scalar', OPTIONAL_USIZE, (h, v, equal) =>
    optionalIndex(h.findLastIndex((x) => equal(x, v)))
  ),
  indexOfAny: sliceSearch('std.mem.indexOfAny', 'slice', OPTIONAL_USIZE, (h, set, equal) =>
    optionalIndex(h.findIndex((x) => (set as unknown as Value[]).some((y) => equal(x, y))))
  ),
  findAny: sliceSearch('std.mem.findAny', 'slice', OPTIONAL_USIZE, (h, set, equal) =>
    optionalIndex(h.findIndex((x) => (set as unknown as Value[]).some((y) => equal(x, y))))
  ),
  lastIndexOfAny: sliceSearch('std.mem.lastIndexOfAny', 'slice', OPTIONAL_USIZE, (h, set, equal) =>
    optionalIndex(h.findLastIndex((x) => (set as unknown as Value[]).some((y) => equal(x, y))))
  ),
  findLastAny: sliceSearch('std.mem.findLastAny', 'slice', OPTIONAL_USIZE, (h, set, equal) =>
    optionalIndex(h.findLastIndex((x) => (set as unknown as Value[]).some((y) => equal(x, y))))
  ),
  indexOfNone: sliceSearch('std.mem.indexOfNone', 'slice', OPTIONAL_USIZE, (h, set, equal) =>
    optionalIndex(h.findIndex((x) => !(set as unknown as Value[]).some((y) => equal(x, y))))
  ),
  findNone: sliceSearch('std.mem.findNone', 'slice', OPTIONAL_USIZE, (h, set, equal) =>
    optionalIndex(h.findIndex((x) => !(set as unknown as Value[]).some((y) => equal(x, y))))
  ),
  indexOfPos: positionSearch('std.mem.indexOfPos', 'slice', (h, start, n, equal) =>
    findSequence(h, n as unknown as Value[], start, equal)
  ),
  findPos: positionSearch('std.mem.findPos', 'slice', (h, start, n, equal) =>
    findSequence(h, n as unknown as Value[], start, equal)
  ),
  indexOfAnyPos: positionSearch('std.mem.indexOfAnyPos', 'slice', (h, start, set, equal) => {
    for (let index = start; index < h.length; index++)
      if ((set as unknown as Value[]).some((y) => equal(h[index], y))) return index;
    return -1;
  }),
  findAnyPos: positionSearch('std.mem.findAnyPos', 'slice', (h, start, set, equal) => {
    for (let index = start; index < h.length; index++)
      if ((set as unknown as Value[]).some((y) => equal(h[index], y))) return index;
    return -1;
  }),
  indexOfScalarPos: positionSearch('std.mem.indexOfScalarPos', 'scalar', (h, start, v, equal) => {
    for (let index = start; index < h.length; index++) if (equal(h[index], v)) return index;
    return -1;
  }),
  findScalarPos: positionSearch('std.mem.findScalarPos', 'scalar', (h, start, v, equal) => {
    for (let index = start; index < h.length; index++) if (equal(h[index], v)) return index;
    return -1;
  }),
  count: sliceSearch('std.mem.count', 'slice', USIZE, (h, n, equal) => {
    const needle = n as unknown as Value[];
    if (needle.length === 0) panic(PANIC.unreachable);
    let found = 0n;
    for (
      let index = findSequence(h, needle, 0, equal);
      index !== -1;
      index = findSequence(h, needle, index + needle.length, equal)
    )
      found++;
    return found;
  }),
  countScalar: sliceSearch('std.mem.countScalar', 'scalar', USIZE, (h, v, equal) =>
    BigInt(h.filter((x) => equal(x, v)).length)
  ),
  // code-gauge-allow functionNcss 32 -- Keeps bounded substring search with argument analysis.
  // code-gauge-allow functionCognitiveComplexity 25 -- Keeps bounded substring search with argument analysis.
  containsAtLeast: generic('std.mem.containsAtLeast', 4, (sema, call, type, [h, countArg, n]) => {
    const haystack = constSlice(sema, h, type);
    const [count] = compileArgs(sema, [countArg], [USIZE]);
    const needle = constSlice(sema, n, type);
    return computed(BOOL, [haystack, count, needle], call.span, ([x, c, y], frame) => {
      const values = elements(y);
      if (values.length === 0) panic(PANIC.unreachable);
      if (c === 0n) return true;
      const items = elements(x);
      const spend = (): void => {
        if (frame) frame.runtime.spend();
        else sema.spendCompilation();
      };
      let found = 0n;
      for (let position = 0; position + values.length <= items.length;) {
        let equal = true;
        for (let offset = 0; offset < values.length; offset++) {
          spend();
          if (!equalValues(items[position + offset], values[offset])) {
            equal = false;
            break;
          }
        }
        if (equal) {
          found++;
          if (found >= (c as bigint)) return true;
          position += values.length;
        } else position++;
      }
      return false;
    });
  }),
  trim: trimmer('std.mem.trim', true, true),
  trimStart: trimmer('std.mem.trimStart', true, false),
  trimEnd: trimmer('std.mem.trimEnd', false, true),
  allEqual: sliceSearch('std.mem.allEqual', 'scalar', BOOL, (h, v, equal) => h.every((x) => equal(x, v))),
  lessThan: () => sliceOrder('std.mem.lessThan', true),
  order: () => sliceOrder('std.mem.order', false),
  max: generic('std.mem.max', 2, (sema, call, type, [sliceArg]) => {
    const slice = constSlice(sema, sliceArg, type);
    return computed(type, [slice], call.span, ([value], frame) =>
      extreme(elements(value), 1, type, nativeBudget(sema, frame))
    );
  }),
  min: generic('std.mem.min', 2, (sema, call, type, [sliceArg]) => {
    const slice = constSlice(sema, sliceArg, type);
    return computed(type, [slice], call.span, ([value], frame) =>
      extreme(elements(value), -1, type, nativeBudget(sema, frame))
    );
  }),
  indexOfMax: extremeIndex('std.mem.indexOfMax', 1),
  findMax: extremeIndex('std.mem.findMax', 1),
  indexOfMin: extremeIndex('std.mem.indexOfMin', -1),
  findMin: extremeIndex('std.mem.findMin', -1),
  minMax: generic('std.mem.minMax', 2, (sema, call, type, [sliceArg]) => {
    const slice = constSlice(sema, sliceArg, type);
    return computed(tupleOf(sema, [type, type]), [slice], call.span, ([value], frame) => {
      const items = elements(value);
      if (items.length === 0) panic(PANIC.unreachable);
      return new ZStruct([
        extreme(items, -1, type, nativeBudget(sema, frame)),
        extreme(items, 1, type, nativeBudget(sema, frame)),
      ]);
    });
  }),
  indexOfMinMax: () => minMaxIndexes('std.mem.indexOfMinMax'),
  findMinMax: () => minMaxIndexes('std.mem.findMinMax'),
  cut: () => cutter('std.mem.cut', 'slice', false),
  cutLast: () => cutter('std.mem.cutLast', 'slice', true),
  cutScalar: () => cutter('std.mem.cutScalar', 'scalar', false),
  cutScalarLast: () => cutter('std.mem.cutScalarLast', 'scalar', true),
  indexOfDiff: () => diffMember('std.mem.indexOfDiff'),
  findDiff: () => diffMember('std.mem.findDiff'),
  lastIndexOfNone: sliceSearch('std.mem.lastIndexOfNone', 'slice', OPTIONAL_USIZE, (h, set, equal) =>
    optionalIndex(h.findLastIndex((x) => !(set as unknown as Value[]).some((y) => equal(x, y))))
  ),
  findLastNone: sliceSearch('std.mem.findLastNone', 'slice', OPTIONAL_USIZE, (h, set, equal) =>
    optionalIndex(h.findLastIndex((x) => !(set as unknown as Value[]).some((y) => equal(x, y))))
  ),
  containsAtLeastScalar: generic(
    'std.mem.containsAtLeastScalar',
    4,
    (sema, call, type, [listArg, elementArg, minArg]) => {
      const list = constSlice(sema, listArg, type);
      const element = sema.coerce(sema.compile(elementArg, type), type, elementArg);
      const minimum = sema.coerce(sema.compile(minArg, USIZE), USIZE, minArg);
      return computed(
        BOOL,
        [list, element, minimum],
        call.span,
        ([value, x, n]) => BigInt(elements(value).filter((item) => equalValues(item, x)).length) >= (n as bigint)
      );
    }
  ),
  rotate: generic('std.mem.rotate', 3, (sema, call, type, [itemsArg, amountArg]) => {
    const items = mutableSlice(sema, itemsArg, type);
    const amount = sema.coerce(sema.compile(amountArg, USIZE), USIZE, amountArg);
    return nativeCall(VOID, [items, amount], call.span, ([value, amount], frame) => {
      const slice = value as Slice;
      const shift = Number(amount as bigint);
      // `items[0..amount]` panics as Zig's slicing does when the amount is past the end.
      if (shift > slice.length) panic(`end index ${shift} out of bounds for slice of length ${slice.length}`);
      const values = slice.values();
      frame.runtime.spend(values.length);
      storeSliceValues(slice, [...values.slice(shift), ...values.slice(0, shift)]);
      return;
    });
  }),
  reverse: generic('std.mem.reverse', 2, (sema, call, type, [itemsArg]) => {
    const items = mutableSlice(sema, itemsArg, type);
    return nativeCall(VOID, [items], call.span, ([value], frame) => {
      const slice = value as Slice;
      const values = slice.values().toReversed();
      frame.runtime.spend(values.length);
      storeSliceValues(slice, values);
      return;
    });
  }),
  swap: generic('std.mem.swap', 3, (sema, call, type, [aArg, bArg]) => {
    const [a, b] = compileArgs(sema, [aArg, bArg], [pointerTo(type, false), pointerTo(type, false)]);
    return nativeCall(VOID, [a, b], call.span, ([a, b]) => {
      const x = a as Pointer;
      const y = b as Pointer;
      const temporary = copyForStorage(x.load());
      const other = copyForStorage(y.load());
      storeInto(x.target, x.index, other);
      storeInto(y.target, y.index, temporary);
      return;
    });
  }),
  copyForwards: copier('std.mem.copyForwards'),
  copyBackwards: copier('std.mem.copyBackwards'),
  replaceScalar: generic('std.mem.replaceScalar', 4, (sema, call, type, [sliceArg, matchArg, replacementArg]) => {
    const slice = mutableSlice(sema, sliceArg, type);
    const [match, replacement] = compileArgs(sema, [matchArg, replacementArg], [type, type]);
    return computed(VOID, [slice, match, replacement], call.span, ([value, from, to]) => {
      const target = value as Slice;
      for (let index = 0; index < target.length; index++)
        if (equalValues(target.get(index), from)) target.set(index, to);
      return;
    });
  }),
  replacementSize: generic('std.mem.replacementSize', 4, (sema, call, type, [inputArg, needleArg, replacementArg]) => {
    const [input, needle, replacement] = [inputArg, needleArg, replacementArg].map((arg) =>
      constSlice(sema, arg, type)
    );
    return computed(USIZE, [input, needle, replacement], call.span, ([x, n, r], frame) => {
      const source = elements(x),
        pattern = elements(n),
        replace = elements(r);
      const count = replacementCount(source, pattern, () => (frame ? frame.runtime.spend() : sema.spendCompilation()));
      return BigInt(source.length + count * (replace.length - pattern.length));
    });
  }),
  // code-gauge-allow functionNcss 34 -- Implements sequential replacement, overlap and capacity checks together.
  // code-gauge-allow functionCognitiveComplexity 29 -- Implements sequential replacement, overlap and capacity checks together.
  replace: generic('std.mem.replace', 5, (sema, call, type, [inputArg, needleArg, replacementArg, outputArg]) => {
    const [input, needle, replacement] = [inputArg, needleArg, replacementArg].map((arg) =>
      constSlice(sema, arg, type)
    );
    const output = mutableSlice(sema, outputArg, type);
    return computed(USIZE, [input, needle, replacement, output], call.span, ([x, n, r, out], frame) => {
      const source = x as Slice,
        pattern = n as Slice,
        replace = r as Slice,
        target = out as Slice;
      if (pattern.length === 0) panic(PANIC.unreachable);
      const spend = (cost = 1): void => {
        if (frame) frame.runtime.spend(cost);
        else sema.spendCompilation(cost);
      };
      let index = 0,
        written = 0,
        count = 0;
      while (index < source.length) {
        spend();
        let matches = index + pattern.length <= source.length;
        for (let offset = 0; matches && offset < pattern.length; offset++) {
          spend();
          matches = equalValues(source.get(index + offset), pattern.get(offset));
        }
        if (matches) {
          if (written + replace.length > target.length) indexOutOfBounds(replace.length, target.length - written);
          if (
            storageOverlaps(
              target.target,
              target.start + written,
              replace.target,
              replace.start,
              replace.length,
              sizeOf(type)
            )
          )
            panic(PANIC.memcpyAlias);
          spend(1 + Math.floor(replace.length / 16));
          storeSliceValues(subSlice(target, written, replace.length), replace.values());
          written += replace.length;
          index += pattern.length;
          count++;
        } else {
          if (written >= target.length) indexOutOfBounds(written, target.length);
          storeSliceValue(target, written++, source.get(index++));
        }
      }
      return BigInt(count);
    });
  }),
  replaceOwned: generic(
    'std.mem.replaceOwned',
    5,
    (sema, call, type, [allocatorArgument, inputArg, needleArg, replacementArg]) => {
      const allocator = allocatorArg(sema, allocatorArgument);
      const [input, needle, replacement] = [inputArg, needleArg, replacementArg].map((arg) =>
        constSlice(sema, arg, type)
      );
      return allocatingCall(
        sliceOf(type, false),
        [allocator, input, needle, replacement],
        call.span,
        ([x, n, r], frame) => replacementPlan(elements(x), elements(n), elements(r), () => frame.runtime.spend())
      );
    }
  ),
  concat: fnMember('std.mem.concat', (sema, call) => {
    const [allocatorArgument, typeArg, slicesArg] = expectArgs(sema, call, 3, 'std.mem.concat');
    const allocator = allocatorArg(sema, allocatorArgument);
    const type = sema.compileType(typeArg);
    const slices = sema.coerce(
      sema.compile(slicesArg, sliceOf(sliceOf(type, true), true)),
      sliceOf(sliceOf(type, true), true),
      slicesArg
    );
    return allocatingCall(sliceOf(type, false), [allocator, slices], call.span, ([value], frame) =>
      joiningPlan(elements(value), [], () => frame.runtime.spend())
    );
  }),
  join: fnMember('std.mem.join', (sema, call) => {
    const [allocatorArgument, separatorArg, slicesArg] = expectArgs(sema, call, 3, 'std.mem.join');
    const allocator = allocatorArg(sema, allocatorArgument);
    const separator = constSlice(sema, separatorArg, U8);
    const slices = sema.coerce(
      sema.compile(slicesArg, sliceOf(CONST_U8_SLICE, true)),
      sliceOf(CONST_U8_SLICE, true),
      slicesArg
    );
    return allocatingCall(sliceOf(U8, false), [allocator, separator, slices], call.span, ([sep, value], frame) =>
      joiningPlan(elements(value), elements(sep), () => frame.runtime.spend())
    );
  }),
  sort: sorter('std.mem.sort', 'block'),
  sortUnstable: sorter('std.mem.sortUnstable', 'pdq'),
  zeroes: fnMember('std.mem.zeroes', (sema, call) => {
    const [typeArg] = expectArgs(sema, call, 1, 'std.mem.zeroes');
    const type = sema.compileType(typeArg);
    sema.reserveStorage(type, call.span);
    return known(
      type,
      zeroValue(type, (struct) => sema.structFields(struct, call.span)),
      call.span
    );
  }),
  cutPrefix: cutMember('std.mem.cutPrefix', false),
  cutSuffix: cutMember('std.mem.cutSuffix', true),
  splitScalar: iteratorFactory('std.mem.splitScalar', 'split', 'scalar'),
  splitSequence: iteratorFactory('std.mem.splitSequence', 'split', 'sequence'),
  splitAny: iteratorFactory('std.mem.splitAny', 'split', 'any'),
  tokenizeScalar: iteratorFactory('std.mem.tokenizeScalar', 'token', 'scalar'),
  tokenizeSequence: iteratorFactory('std.mem.tokenizeSequence', 'token', 'sequence'),
  tokenizeAny: iteratorFactory('std.mem.tokenizeAny', 'token', 'any'),
};

// code-gauge-allow functionCognitiveComplexity 16 -- Keeps generic prefix and suffix validation with the resulting shared-storage view.
function cutMember(name: string, suffix: boolean): () => Member {
  return generic(name, 3, (sema, call, type, [sourceArg, needleArg]) => {
    const source = constSlice(sema, sourceArg, type);
    const needle = constSlice(sema, needleArg, type);
    return computed(optionalOf(sliceOf(type, true)), [source, needle], call.span, ([value, pattern], frame) => {
      const input = value as Slice;
      const target = pattern as Slice;
      if (target.length > input.length) return NULL;
      const offset = suffix ? input.length - target.length : 0;
      const equal = comparisonBudget(sema, frame);
      for (let index = 0; index < target.length; index++)
        if (!equal(input.get(offset + index), target.get(index))) return NULL;
      return new Slice(input.target, input.start + (suffix ? 0 : target.length), input.length - target.length);
    });
  });
}

function sliceOrder(name: string, lessThan: boolean): Member {
  return generic(name, 3, (sema, call, type, [leftArg, rightArg]) => {
    const left = constSlice(sema, leftArg, type);
    const right = constSlice(sema, rightArg, type);
    return computed(lessThan ? BOOL : ORDER, [left, right], call.span, ([a, b], frame) => {
      const result = lexicographic(a as Slice, b as Slice, type, nativeBudget(sema, frame));
      return lessThan ? result < 0 : orderValue(result);
    });
  })();
}

function lexicographic(first: Slice, second: Slice, type: Type, spend: () => void): number {
  const location = storageLocation(first.target.slots, first.start);
  const other = storageLocation(second.target.slots, second.start);
  if (location.storage === other.storage && location.index === other.index) return first.length - second.length;
  const length = Math.min(first.length, second.length);
  for (let index = 0; index < length; index++) {
    spend();
    const x = first.get(index);
    const y = second.get(index);
    const order =
      type.kind === 'float' || type.kind === 'comptime_float'
        ? compareFloats(x as AnyFloat, y as AnyFloat)
        : compareScalars(x, y);
    if (order === undefined) panic(PANIC.unreachable);
    if (order !== 0) return order;
  }
  return first.length - second.length;
}

function extreme(values: Value[], direction: number, type: Type, spend: () => void): Value {
  if (values.length === 0) panic(PANIC.unreachable);
  let best = values[0];
  for (const value of values.slice(1)) {
    spend();
    if (type.kind === 'float' || type.kind === 'comptime_float')
      best = minMaxFloat(best as AnyFloat, value as AnyFloat, direction > 0);
    else if (compareScalars(value, best) * direction > 0) best = value;
  }
  return best;
}

function extremeIndex(name: string, direction: number): () => Member {
  return generic(name, 2, (sema, call, type, [sliceArg]) => {
    const slice = constSlice(sema, sliceArg, type);
    return computed(USIZE, [slice], call.span, ([value]) => {
      const values = elements(value);
      if (values.length === 0) panic(PANIC.unreachable);
      let best = 0;
      for (let index = 1; index < values.length; index++)
        if (compareScalars(values[index], values[best]) * direction > 0) best = index;
      return BigInt(best);
    });
  });
}

function copier(name: string): () => Member {
  return generic(name, 3, (sema, call, type, [destinationArg, sourceArg]) => {
    const destination = mutableSlice(sema, destinationArg, type);
    const source = constSlice(sema, sourceArg, type);
    return computed(VOID, [destination, source], call.span, ([out, input]) => {
      const values = elements(input);
      const target = out as Slice;
      // `copyForwards` loops over `dest[0..source.len]`, and `copyBackwards` asserts the length.
      if (values.length > target.length) {
        panic(
          name.endsWith('Forwards')
            ? `index out of bounds: index ${values.length}, len ${target.length}`
            : PANIC.unreachable
        );
      }
      for (let position = 0; position < values.length; position++) {
        const index = name.endsWith('Backwards') ? values.length - position - 1 : position;
        storeSliceValue(target, index, values[index]);
      }
      return;
    });
  });
}

function replacementCount(
  input: Value[],
  needle: Value[],
  spend: () => void,
  onMatch?: (position: number) => void
): number {
  if (needle.length === 0) panic(PANIC.unreachable);
  let count = 0;
  for (let index = 0; index < input.length;) {
    spend();
    let matches = index + needle.length <= input.length;
    for (let offset = 0; matches && offset < needle.length; offset++) {
      spend();
      matches = equalValues(input[index + offset], needle[offset]);
    }
    if (matches) {
      count++;
      onMatch?.(index);
      index += needle.length;
    } else index++;
  }
  return count;
}

function replacementPlan(input: Value[], needle: Value[], replacement: Value[], spend: () => void): AllocationPlan {
  const positions: number[] = [];
  const count = replacementCount(input, needle, spend, (position) => positions.push(position));
  const length = input.length + count * (replacement.length - needle.length);
  return {
    length,
    build: () => {
      const values: Value[] = [];
      let cursor = 0,
        match = 0;
      while (cursor < input.length) {
        if (cursor === positions[match]) {
          for (const value of replacement) values.push(value);
          cursor += needle.length;
          match++;
        } else values.push(input[cursor++]);
      }
      return values;
    },
  };
}

function joiningPlan(parts: readonly Value[], separator: readonly Value[], spend: () => void): AllocationPlan {
  const slices = parts as readonly Slice[];
  let length = separator.length * Math.max(0, slices.length - 1);
  for (const slice of slices) {
    spend();
    length += slice.length;
  }
  return {
    length,
    build: () => {
      const values: Value[] = [];
      for (const [index, slice] of slices.entries()) {
        if (index > 0) for (const value of separator) values.push(value);
        for (let at = 0; at < slice.length; at++) values.push(slice.get(at));
      }
      return values;
    },
  };
}

function allocatingCall(
  type: Type,
  args: readonly TExpr[],
  span: Span,
  plan: (values: Value[], frame: Frame) => AllocationPlan
): TExpr {
  return nativeCall(allocating(type), args, span, (values, frame) => {
    const allocation = plan(values.slice(1), frame);
    const child = type.kind === 'pointer' ? type.child : type;
    const complete = reserveNativeAllocation(frame, allocatorState(values[0]), allocation.length, child);
    if (!complete) return ERROR_OUT_OF_MEMORY;
    const result = newSlice(allocation.build());
    complete(result.target);
    return result;
  });
}

function sorter(name: string, algorithm: SortAlgorithm): () => Member {
  return generic(name, 4, (sema, call, type, [itemsArg, contextArg, lessThanArg]) => {
    const items = mutableSlice(sema, itemsArg, type);
    const context = sema.compile(contextArg);
    const lessThan = sema.functionOf(sema.compile(lessThanArg), lessThanArg);
    if (lessThan.params.length !== 3)
      sema.error(lessThanArg, '比べる関数は fn (context, a, b) bool の形にしてください。');
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

/** `std.mem.zeroes`: a value whose bits are all zero. */
export function zeroValue(type: Type, fieldsOf: (type: StructType) => readonly StructField[]): Value {
  switch (type.kind) {
    case 'int':
    case 'enum': {
      return 0n;
    }
    case 'float': {
      return floatFromBigInt(0n, type.bits);
    }
    case 'bool': {
      return false;
    }
    case 'optional': {
      return NULL;
    }
    case 'array': {
      return newArray(
        Array.from({ length: type.length }, () => zeroValue(type.child, fieldsOf)),
        type.sentinel
      );
    }
    case 'struct': {
      return new ZStruct(fieldsOf(type).map((field) => zeroValue(field.type, fieldsOf)));
    }
    default: {
      return undefinedValue(type);
    }
  }
}

/** `findMinMax(T, slice)`: the indexes of the first minimum and the first maximum. */
function minMaxIndexes(name: string): Member {
  return generic(name, 2, (sema, call, type, [sliceArg]) => {
    const slice = constSlice(sema, sliceArg, type);
    return computed(tupleOf(sema, [USIZE, USIZE]), [slice], call.span, ([value]) => {
      const items = elements(value);
      if (items.length === 0) panic(PANIC.unreachable);
      let low = 0;
      let high = 0;
      for (const [index, item] of items.entries()) {
        if (compareScalars(item, items[low]) < 0) low = index;
        if (compareScalars(item, items[high]) > 0) high = index;
      }
      return new ZStruct([BigInt(low), BigInt(high)]);
    });
  })();
}

/** `cut(T, haystack, needle)` and its variants: the parts before and after the first or last match, or null. */
function cutter(name: string, needleKind: 'slice' | 'scalar', last: boolean): Member {
  return generic(name, 3, (sema, call, type, [haystackArg, needleArg]) => {
    const haystack = constSlice(sema, haystackArg, type);
    const needle =
      needleKind === 'slice'
        ? constSlice(sema, needleArg, type)
        : sema.coerce(sema.compile(needleArg, type), type, needleArg);
    const slice = sliceOf(type, true);
    return computed(optionalOf(tupleOf(sema, [slice, slice])), [haystack, needle], call.span, ([h, n], frame) => {
      const items = elements(h);
      const pattern = needleKind === 'slice' ? elements(n) : [n];
      const equal = comparisonBudget(sema, frame);
      const index = last ? findSequenceLast(items, pattern, equal) : findSequence(items, pattern, 0, equal);
      if (index < 0) return NULL;
      const whole = h as Slice;
      return new ZStruct([
        subSlice(whole, 0, index),
        subSlice(whole, index + pattern.length, items.length - index - pattern.length),
      ]);
    });
  })();
}

/** `findDiff(T, a, b)`: the first index where two slices differ, or where the shorter one ends. */
function diffMember(name: string): Member {
  return generic(name, 3, (sema, call, type, [aArg, bArg]) => {
    const a = constSlice(sema, aArg, type);
    const b = constSlice(sema, bArg, type);
    return computed(OPTIONAL_USIZE, [a, b], call.span, ([x, y]) => {
      const xs = elements(x);
      const ys = elements(y);
      const shorter = Math.min(xs.length, ys.length);
      for (let index = 0; index < shorter; index++) if (!equalValues(xs[index], ys[index])) return BigInt(index);
      return xs.length === ys.length ? NULL : BigInt(shorter);
    });
  })();
}

let mem: StructType | undefined;

export function memNamespace(): StructType {
  mem ??= nativeStruct('std.mem', MEMBERS);
  return mem;
}

export { TYPE };
export type { Expression };
