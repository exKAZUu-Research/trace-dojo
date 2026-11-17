// code-gauge-allow-file fileNcss 620 -- Groups the related standard library operations that share this module.
import { indexOutOfBounds, PANIC, panic } from '../arith';
import type { Expression, Span } from '../ast';
import { type AnyFloat, compareFloats, floatFromBigInt, minMaxFloat } from '../floats';
import { sizeOf } from '../layout';
import { isArithmeticType } from '../operands';
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
  nativeBudget,
  nativeTransferCost,
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
  structReceiver,
  typeMember,
} from './native';
import { sorter } from './sort';

interface AllocationPlan {
  length: number;
  build: () => Value[];
}

function comparisonOf(sema: SemaApi, type: Type, span: Span): (frame?: Frame) => typeof equalValues {
  const compare = sema.valueComparator(type, false, span);
  return (frame) => {
    const spend = nativeBudget(sema, frame);
    return (a, b) => {
      spend();
      return compare(a, b) === 0;
    };
  };
}

class Sequence {
  constructor(
    readonly length: bigint,
    private readonly read: (index: bigint) => Value
  ) {}

  get(index: bigint): Value {
    return this.read(index);
  }

  some(predicate: (value: Value, index: bigint) => boolean): boolean {
    return this.findFrom(predicate) !== undefined;
  }

  every(predicate: (value: Value, index: bigint) => boolean): boolean {
    return this.findFrom((value, index) => !predicate(value, index)) === undefined;
  }

  findFrom(predicate: (value: Value, index: bigint) => boolean, from = 0n): bigint | undefined {
    for (let index = from; index < this.length; index++) if (predicate(this.get(index), index)) return index;
    return undefined;
  }

  findLastIndex(predicate: (value: Value, index: bigint) => boolean): bigint | undefined {
    for (let index = this.length; index > 0n;) {
      index--;
      if (predicate(this.get(index), index)) return index;
    }
    return undefined;
  }

  count(predicate: (value: Value) => boolean): bigint {
    let count = 0n;
    for (let index = 0n; index < this.length; index++) if (predicate(this.get(index))) count++;
    return count;
  }
}

function sequence(value: Value, spend: () => void, scalar = false): Sequence {
  if (scalar) return new Sequence(1n, () => value);
  const slice = value as Slice;
  return new Sequence(slice.lengthValue, (index) => {
    spend();
    return slice.get(Number(index));
  });
}

function findSequence(
  haystack: Sequence,
  needle: Sequence,
  from: bigint,
  equal: typeof equalValues
): bigint | undefined {
  if (needle.length === 0n) return from <= haystack.length ? from : undefined;
  outer: for (let index = from; index + needle.length <= haystack.length; index++) {
    for (let offset = 0n; offset < needle.length; offset++) {
      if (!equal(haystack.get(index + offset), needle.get(offset))) continue outer;
    }
    return index;
  }
  return undefined;
}

function findSequenceLast(haystack: Sequence, needle: Sequence, equal: typeof equalValues): bigint | undefined {
  for (let index = haystack.length - needle.length; index >= 0n; index--) {
    if (needle.every((value, offset) => equal(haystack.get(index + offset), value))) return index;
  }
  return undefined;
}

function startsWith(haystack: Sequence, needle: Sequence, equal: typeof equalValues, at = 0n): boolean {
  return (
    at >= 0n &&
    at + needle.length <= haystack.length &&
    needle.every((value, offset) => equal(haystack.get(at + offset), value))
  );
}

function containsScalar(haystack: Sequence, value: Value, minimum: bigint, equal: typeof equalValues): boolean {
  let count = 0n;
  for (let index = 0n; index < haystack.length; index++) {
    if (equal(haystack.get(index), value)) count++;
    if (count >= minimum) return true;
  }
  return false;
}

function containsSequence(haystack: Sequence, needle: Sequence, minimum: bigint, equal: typeof equalValues): boolean {
  if (needle.length === 1n) return containsScalar(haystack, needle.get(0n), minimum, equal);
  if (needle.length === 0n) panic(PANIC.unreachable);
  if (minimum === 0n) return true;
  let count = 0n;
  for (
    let index = findSequence(haystack, needle, 0n, equal);
    index !== undefined;
    index = findSequence(haystack, needle, index + needle.length, equal)
  ) {
    count++;
    if (count >= minimum) return true;
  }
  return false;
}

function sliceSearch(
  name: string,
  second: 'slice' | 'scalar',
  resultType: Type,
  compute: (haystack: Sequence, operand: Sequence, equal: typeof equalValues) => Value
): () => Member {
  return generic(name, 3, (sema, call, type, [haystack, operand]) => {
    const a = constSlice(sema, haystack, type);
    const b =
      second === 'slice' ? constSlice(sema, operand, type) : sema.coerce(sema.compile(operand, type), type, operand);
    const equality = comparisonOf(sema, type, call.span);
    return computed(resultType, [a, b], call.span, ([x, y], frame) => {
      const spend = nativeBudget(sema, frame);
      return compute(sequence(x, spend), sequence(y, spend, second === 'scalar'), equality(frame));
    });
  });
}

function positionSearch(
  name: string,
  second: 'slice' | 'scalar',
  compute: (haystack: Sequence, start: bigint, operand: Sequence, equal: typeof equalValues) => bigint | undefined
): () => Member {
  return generic(name, 4, (sema, call, type, [haystack, startArg, operand]) => {
    const a = constSlice(sema, haystack, type);
    const [start] = compileArgs(sema, [startArg], [USIZE]);
    const b =
      second === 'slice' ? constSlice(sema, operand, type) : sema.coerce(sema.compile(operand, type), type, operand);
    const equality = comparisonOf(sema, type, call.span);
    return computed(OPTIONAL_USIZE, [a, start, b], call.span, ([x, from, y], frame) => {
      const spend = nativeBudget(sema, frame);
      return optionalIndex(
        compute(sequence(x, spend), from as bigint, sequence(y, spend, second === 'scalar'), equality(frame))
      );
    });
  });
}

// code-gauge-allow functionCognitiveComplexity 16 -- Keeps the paired live trim bounds together.
function trimmer(name: string, start: boolean, end: boolean): () => Member {
  return generic(name, 3, (sema, call, type, [sliceArg, stripArg]) => {
    const slice = constSlice(sema, sliceArg, type);
    const strip = constSlice(sema, stripArg, type);
    const equality = comparisonOf(sema, type, call.span);
    return computed(sliceOf(type, true), [slice, strip], call.span, ([value, values], frame) => {
      const spend = nativeBudget(sema, frame);
      const items = sequence(value, spend),
        set = sequence(values, spend);
      const equal = equality(frame);
      let from = 0n,
        to = items.length;
      if (start) while (from < to && set.some((each) => equal(each, items.get(from)))) from++;
      if (end) while (to > from && set.some((each) => equal(each, items.get(to - 1n)))) to--;
      return subSlice(value as Slice, from, to - from);
    });
  });
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
  const isDelimiter = (
    buffer: Slice,
    index: number,
    value: Value,
    equal: typeof equalValues,
    spend: () => void
  ): boolean => {
    spend();
    if (delimiter === 'scalar') return equal(buffer.get(index), value);
    const set = value as Slice;
    if (delimiter === 'any') {
      for (let offset = 0; offset < set.length; offset++) if (equal(set.get(offset), buffer.get(index))) return true;
      return false;
    }
    if (index + set.length > buffer.length) return false;
    for (let offset = 0; offset < set.length; offset++)
      if (!equal(buffer.get(index + offset), set.get(offset))) return false;
    return true;
  };
  const delimiterLength = (value: Value): number => (delimiter === 'sequence' ? (value as Slice).length : 1);
  const method = (
    name: string,
    returnType: Type,
    run: (state: ZStruct, equal: typeof equalValues, spend: () => void) => Value
  ): (() => Member) =>
    fnMember(`${key}.${name}`, (sema, call) => {
      expectArgs(sema, call, 0, name);
      const mutable = name !== 'rest' && !(kind === 'split' && name === 'peek');
      const state = structReceiver(sema, call, created, mutable);
      const equality =
        name === 'reset' || (kind === 'split' && name === 'rest')
          ? () => equalValues
          : comparisonOf(sema, child, call.span);
      return runtime(
        returnType,
        (frame) => {
          frame.runtime.spend();
          return run(state(frame), equality(frame), nativeBudget(sema, frame));
        },
        call.span
      );
    });
  const tokenPeek = (
    state: ZStruct,
    equal: typeof equalValues,
    spend: () => void
  ): { start: number; end: number } | undefined => {
    const buffer = state.slots[0] as Slice;
    let index = Number(state.slots[1] as bigint);
    while (index < buffer.length && isDelimiter(buffer, index, state.slots[2], equal, spend))
      index += delimiterLength(state.slots[2]);
    state.slots[1] = BigInt(index);
    if (index === buffer.length) return undefined;
    let end = index;
    while (end < buffer.length && !isDelimiter(buffer, end, state.slots[2], equal, spend)) end++;
    return { start: index, end };
  };
  const members: Record<string, () => Member> =
    kind === 'split'
      ? {
          next: method('next', optionalOf(resultSlice), (state, equal, spend) => {
            const startValue = state.slots[1];
            if (startValue === NULL) return NULL;
            const start = Number(startValue as bigint);
            const buffer = state.slots[0] as Slice;
            let end = buffer.length;
            let found = -1;
            for (let index = start; index < buffer.length; index++) {
              if (isDelimiter(buffer, index, state.slots[2], equal, spend)) {
                found = index;
                break;
              }
            }
            if (delimiter === 'sequence' && found === -1 && delimiterLength(state.slots[2]) === 0) found = start;
            if (found === -1) {
              state.slots[1] = NULL;
            } else {
              state.slots[1] = BigInt(found + delimiterLength(state.slots[2]));
              end = found;
            }
            return subSlice(state.slots[0] as Slice, start, end - start);
          }),
          first: method('first', resultSlice, (state, equal, spend) => {
            if (state.slots[1] === NULL) panic(PANIC.nullUnwrap);
            if (state.slots[1] !== 0n) panic(PANIC.unreachable);
            const buffer = state.slots[0] as Slice;
            let end = buffer.length;
            for (let index = 0; index < buffer.length; index++) {
              if (isDelimiter(buffer, index, state.slots[2], equal, spend)) {
                end = index;
                break;
              }
            }
            state.slots[1] = end === buffer.length ? NULL : BigInt(end + delimiterLength(state.slots[2]));
            return subSlice(state.slots[0] as Slice, 0, end);
          }),
          peek: method('peek', optionalOf(resultSlice), (state, equal, spend) => {
            const startValue = state.slots[1];
            if (startValue === NULL) return NULL;
            const start = Number(startValue as bigint);
            const buffer = state.slots[0] as Slice;
            let end = buffer.length;
            for (let index = start; index < buffer.length; index++) {
              if (isDelimiter(buffer, index, state.slots[2], equal, spend)) {
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
          next: method('next', optionalOf(resultSlice), (state, equal, spend) => {
            const token = tokenPeek(state, equal, spend);
            if (!token) return NULL;
            state.slots[1] = BigInt(token.end);
            return subSlice(state.slots[0] as Slice, token.start, token.end - token.start);
          }),
          peek: method('peek', optionalOf(resultSlice), (state, equal, spend) => {
            const token = tokenPeek(state, equal, spend);
            if (!token) return NULL;
            return subSlice(state.slots[0] as Slice, token.start, token.end - token.start);
          }),
          rest: method('rest', resultSlice, (state, equal, spend) => {
            const buffer = state.slots[0] as Slice;
            let index = Number(state.slots[1] as bigint);
            while (index < buffer.length && isDelimiter(buffer, index, state.slots[2], equal, spend))
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

function iteratorFactory(name: string, kind: 'split' | 'token', delimiter: DelimiterKind): () => Member {
  return generic(name, 3, (sema, call, type, [bufferArg, delimiterArg]) => {
    const buffer = constSlice(sema, bufferArg, type);
    const delimiterValue =
      delimiter === 'scalar'
        ? sema.coerce(sema.compile(delimiterArg, type), type, delimiterArg)
        : constSlice(sema, delimiterArg, type);
    const iterator = iteratorType(kind, delimiter, type);
    return computed(iterator, [buffer, delimiterValue], call.span, ([value, separator]) => {
      if (delimiter === 'sequence' && (separator as Slice).length === 0) panic('reached unreachable code');
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
    const equality = comparisonOf(sema, type, call.span);
    return computed(BOOL, [left, right], call.span, ([x, y], frame) => {
      const a = x as Slice,
        b = y as Slice;
      if (a.lengthValue !== b.lengthValue) return false;
      const first = storageLocation(a.target.slots, a.start),
        second = storageLocation(b.target.slots, b.start);
      if (type.kind !== 'float' && first.storage === second.storage && first.index === second.index) return true;
      const equal = equality(frame);
      for (let index = 0; index < a.length; index++) if (!equal(a.get(index), b.get(index))) return false;
      return true;
    });
  }),
  startsWith: sliceSearch('std.mem.startsWith', 'slice', BOOL, (haystack, needle, equal) =>
    startsWith(haystack, needle, equal)
  ),
  endsWith: sliceSearch('std.mem.endsWith', 'slice', BOOL, (haystack, needle, equal) =>
    startsWith(haystack, needle, equal, haystack.length - needle.length)
  ),
  indexOf: sliceSearch('std.mem.indexOf', 'slice', OPTIONAL_USIZE, (h, n, equal) =>
    optionalIndex(findSequence(h, n, 0n, equal))
  ),
  find: sliceSearch('std.mem.find', 'slice', OPTIONAL_USIZE, (h, n, equal) =>
    optionalIndex(findSequence(h, n, 0n, equal))
  ),
  lastIndexOf: sliceSearch('std.mem.lastIndexOf', 'slice', OPTIONAL_USIZE, (h, n, equal) =>
    optionalIndex(findSequenceLast(h, n, equal))
  ),
  findLast: sliceSearch('std.mem.findLast', 'slice', OPTIONAL_USIZE, (h, n, equal) =>
    optionalIndex(findSequenceLast(h, n, equal))
  ),
  indexOfScalar: sliceSearch('std.mem.indexOfScalar', 'scalar', OPTIONAL_USIZE, (h, v, equal) =>
    optionalIndex(h.findFrom((x) => equal(x, v.get(0n))))
  ),
  findScalar: sliceSearch('std.mem.findScalar', 'scalar', OPTIONAL_USIZE, (h, v, equal) =>
    optionalIndex(h.findFrom((x) => equal(x, v.get(0n))))
  ),
  lastIndexOfScalar: sliceSearch('std.mem.lastIndexOfScalar', 'scalar', OPTIONAL_USIZE, (h, v, equal) =>
    optionalIndex(h.findLastIndex((x) => equal(x, v.get(0n))))
  ),
  findScalarLast: sliceSearch('std.mem.findScalarLast', 'scalar', OPTIONAL_USIZE, (h, v, equal) =>
    optionalIndex(h.findLastIndex((x) => equal(x, v.get(0n))))
  ),
  indexOfAny: sliceSearch('std.mem.indexOfAny', 'slice', OPTIONAL_USIZE, (h, set, equal) =>
    optionalIndex(h.findFrom((x) => set.some((y) => equal(x, y))))
  ),
  findAny: sliceSearch('std.mem.findAny', 'slice', OPTIONAL_USIZE, (h, set, equal) =>
    optionalIndex(h.findFrom((x) => set.some((y) => equal(x, y))))
  ),
  lastIndexOfAny: sliceSearch('std.mem.lastIndexOfAny', 'slice', OPTIONAL_USIZE, (h, set, equal) =>
    optionalIndex(h.findLastIndex((x) => set.some((y) => equal(x, y))))
  ),
  findLastAny: sliceSearch('std.mem.findLastAny', 'slice', OPTIONAL_USIZE, (h, set, equal) =>
    optionalIndex(h.findLastIndex((x) => set.some((y) => equal(x, y))))
  ),
  indexOfNone: sliceSearch('std.mem.indexOfNone', 'slice', OPTIONAL_USIZE, (h, set, equal) =>
    optionalIndex(h.findFrom((x) => !set.some((y) => equal(x, y))))
  ),
  findNone: sliceSearch('std.mem.findNone', 'slice', OPTIONAL_USIZE, (h, set, equal) =>
    optionalIndex(h.findFrom((x) => !set.some((y) => equal(x, y))))
  ),
  indexOfPos: positionSearch('std.mem.indexOfPos', 'slice', (h, start, n, equal) => findSequence(h, n, start, equal)),
  findPos: positionSearch('std.mem.findPos', 'slice', (h, start, n, equal) => findSequence(h, n, start, equal)),
  indexOfAnyPos: positionSearch('std.mem.indexOfAnyPos', 'slice', (h, start, set, equal) =>
    h.findFrom((value) => set.some((other) => equal(value, other)), start)
  ),
  findAnyPos: positionSearch('std.mem.findAnyPos', 'slice', (h, start, set, equal) =>
    h.findFrom((value) => set.some((other) => equal(value, other)), start)
  ),
  indexOfScalarPos: positionSearch('std.mem.indexOfScalarPos', 'scalar', (h, start, v, equal) =>
    h.findFrom((value) => equal(value, v.get(0n)), start)
  ),
  findScalarPos: positionSearch('std.mem.findScalarPos', 'scalar', (h, start, v, equal) =>
    h.findFrom((value) => equal(value, v.get(0n)), start)
  ),
  count: sliceSearch('std.mem.count', 'slice', USIZE, (h, needle, equal) => {
    if (needle.length === 0n) panic(PANIC.unreachable);
    let found = 0n;
    for (
      let index = findSequence(h, needle, 0n, equal);
      index !== undefined;
      index = findSequence(h, needle, index + needle.length, equal)
    )
      found++;
    return found;
  }),
  countScalar: sliceSearch('std.mem.countScalar', 'scalar', USIZE, (h, v, equal) =>
    h.count((x) => equal(x, v.get(0n)))
  ),
  containsAtLeast: generic('std.mem.containsAtLeast', 4, (sema, call, type, [h, countArg, n]) => {
    const haystack = constSlice(sema, h, type);
    const [count] = compileArgs(sema, [countArg], [USIZE]);
    const needle = constSlice(sema, n, type);
    const equality = comparisonOf(sema, type, call.span);
    return computed(BOOL, [haystack, count, needle], call.span, ([x, minimum, y], frame) => {
      const spend = nativeBudget(sema, frame);
      return containsSequence(sequence(x, spend), sequence(y, spend), minimum as bigint, equality(frame));
    });
  }),
  trim: trimmer('std.mem.trim', true, true),
  trimStart: trimmer('std.mem.trimStart', true, false),
  trimEnd: trimmer('std.mem.trimEnd', false, true),
  allEqual: sliceSearch('std.mem.allEqual', 'scalar', BOOL, (h, v, equal) => h.every((x) => equal(x, v.get(0n)))),
  lessThan: () => sliceOrder('std.mem.lessThan', true),
  order: () => sliceOrder('std.mem.order', false),
  max: generic('std.mem.max', 2, (sema, call, type, [sliceArg]) => {
    checkOrdering(sema, type, call.span);
    const slice = constSlice(sema, sliceArg, type);
    return computed(type, [slice], call.span, ([value], frame) =>
      extreme(value as Slice, 1, type, nativeBudget(sema, frame))
    );
  }),
  min: generic('std.mem.min', 2, (sema, call, type, [sliceArg]) => {
    checkOrdering(sema, type, call.span);
    const slice = constSlice(sema, sliceArg, type);
    return computed(type, [slice], call.span, ([value], frame) =>
      extreme(value as Slice, -1, type, nativeBudget(sema, frame))
    );
  }),
  indexOfMax: extremeIndex('std.mem.indexOfMax', 1),
  findMax: extremeIndex('std.mem.findMax', 1),
  indexOfMin: extremeIndex('std.mem.indexOfMin', -1),
  findMin: extremeIndex('std.mem.findMin', -1),
  minMax: generic('std.mem.minMax', 2, (sema, call, type, [sliceArg]) => {
    checkOrdering(sema, type, call.span);
    const slice = constSlice(sema, sliceArg, type);
    return computed(tupleOf(sema, [type, type]), [slice], call.span, ([value], frame) => {
      const items = value as Slice;
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
    optionalIndex(h.findLastIndex((x) => !set.some((y) => equal(x, y))))
  ),
  findLastNone: sliceSearch('std.mem.findLastNone', 'slice', OPTIONAL_USIZE, (h, set, equal) =>
    optionalIndex(h.findLastIndex((x) => !set.some((y) => equal(x, y))))
  ),
  containsAtLeastScalar: generic(
    'std.mem.containsAtLeastScalar',
    4,
    (sema, call, type, [listArg, elementArg, minArg]) => {
      const list = constSlice(sema, listArg, type);
      const element = sema.coerce(sema.compile(elementArg, type), type, elementArg);
      const minimum = sema.coerce(sema.compile(minArg, USIZE), USIZE, minArg);
      const equality = comparisonOf(sema, type, call.span);
      return computed(BOOL, [list, element, minimum], call.span, ([value, x, n], frame) =>
        containsScalar(sequence(value, nativeBudget(sema, frame)), x, n as bigint, equality(frame))
      );
    }
  ),
  rotate: generic('std.mem.rotate', 3, (sema, call, type, [itemsArg, amountArg]) => {
    const items = mutableSlice(sema, itemsArg, type);
    const amount = sema.coerce(sema.compile(amountArg, USIZE), USIZE, amountArg);
    const cost = nativeTransferCost(sema, type, call.span);
    return nativeCall(VOID, [items, amount], call.span, ([value, amount], frame) => {
      const slice = value as Slice;
      if ((amount as bigint) > slice.lengthValue)
        panic(`end index ${amount as bigint} out of bounds for slice of length ${slice.lengthValue}`);
      if (cost === 0) return;
      const shift = Number(amount as bigint);
      const values = slice.values((length) => frame.runtime.spend(length * (cost * 2 + 1)));
      storeSliceValues(slice, [...values.slice(shift), ...values.slice(0, shift)]);
      return;
    });
  }),
  reverse: generic('std.mem.reverse', 2, (sema, call, type, [itemsArg]) => {
    const items = mutableSlice(sema, itemsArg, type);
    const cost = nativeTransferCost(sema, type, call.span);
    return nativeCall(VOID, [items], call.span, ([value], frame) => {
      if (cost === 0) return;
      const slice = value as Slice;
      const values = slice.values((length) => frame.runtime.spend(length * (cost * 2 + 1))).toReversed();
      storeSliceValues(slice, values);
      return;
    });
  }),
  swap: generic('std.mem.swap', 3, (sema, call, type, [aArg, bArg]) => {
    const [a, b] = compileArgs(sema, [aArg, bArg], [pointerTo(type, false), pointerTo(type, false)]);
    const cost = nativeTransferCost(sema, type, call.span);
    return nativeCall(VOID, [a, b], call.span, ([a, b], frame) => {
      if (cost === 0) return;
      frame.runtime.spend(cost * 4);
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
    const equality = comparisonOf(sema, type, call.span);
    return computed(VOID, [slice, match, replacement], call.span, ([value, from, to], frame) => {
      const target = value as Slice;
      const equal = equality(frame);
      for (let index = 0; index < target.length; index++) if (equal(target.get(index), from)) target.set(index, to);
      return;
    });
  }),
  replacementSize: generic('std.mem.replacementSize', 4, (sema, call, type, [inputArg, needleArg, replacementArg]) => {
    const [input, needle, replacement] = [inputArg, needleArg, replacementArg].map((arg) =>
      constSlice(sema, arg, type)
    );
    const equality = comparisonOf(sema, type, call.span);
    return computed(USIZE, [input, needle, replacement], call.span, ([x, n, r], frame) => {
      const spend = nativeBudget(sema, frame);
      const source = sequence(x, spend),
        pattern = sequence(n, spend);
      const count = replacementCount(source, pattern, equality(frame));
      return source.length + count * ((r as Slice).lengthValue - pattern.length);
    });
  }),
  // code-gauge-allow functionNcss 42 -- Implements sequential replacement, overlap and capacity checks together.
  replace: generic('std.mem.replace', 5, (sema, call, type, [inputArg, needleArg, replacementArg, outputArg]) => {
    const [input, needle, replacement] = [inputArg, needleArg, replacementArg].map((arg) =>
      constSlice(sema, arg, type)
    );
    const output = mutableSlice(sema, outputArg, type);
    const cost = nativeTransferCost(sema, type, call.span);
    const equality = comparisonOf(sema, type, call.span);
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
      const equal = equality(frame);
      let index = 0,
        written = 0,
        count = 0;
      while (index < source.length) {
        spend();
        let matches = index + pattern.length <= source.length;
        for (let offset = 0; matches && offset < pattern.length; offset++) {
          spend();
          matches = equal(source.get(index + offset), pattern.get(offset));
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
          if (cost !== 0) {
            const values = replace.values((length) => spend(length * (cost * 2 + 1)));
            storeSliceValues(subSlice(target, written, replace.lengthValue), values);
          }
          written += replace.length;
          index += pattern.length;
          count++;
        } else {
          if (written >= target.length) indexOutOfBounds(written, target.length);
          if (cost !== 0) {
            spend(cost * 2);
            storeSliceValue(target, written, source.get(index));
          }
          written++;
          index++;
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
      const equality = comparisonOf(sema, type, call.span);
      return allocatingCall(
        sliceOf(type, false),
        [allocator, input, needle, replacement],
        call.span,
        ([x, n, r], frame) =>
          replacementPlan(
            sequence(x, () => frame.runtime.spend()),
            sequence(n, () => frame.runtime.spend()),
            sequence(r, () => frame.runtime.spend()),
            equality(frame)
          )
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
    const equality = comparisonOf(sema, type, call.span);
    return computed(optionalOf(sliceOf(type, true)), [source, needle], call.span, ([value, pattern], frame) => {
      const input = value as Slice;
      const target = pattern as Slice;
      if (target.lengthValue > input.lengthValue) return NULL;
      const offset = suffix ? input.lengthValue - target.lengthValue : 0n;
      const equal = equality(frame);
      for (let index = 0n; index < target.lengthValue; index++)
        if (!equal(input.get(Number(offset + index)), target.get(Number(index)))) return NULL;
      return new Slice(
        input.target,
        input.start + (suffix ? 0 : Number(target.lengthValue)),
        input.lengthValue - target.lengthValue
      );
    });
  });
}

function sliceOrder(name: string, lessThan: boolean): Member {
  return generic(name, 3, (sema, call, type, [leftArg, rightArg]) => {
    checkOrdering(sema, type, call.span);
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
  if (location.storage === other.storage && location.index === other.index)
    return compareScalars(first.lengthValue, second.lengthValue);
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
  return compareScalars(first.lengthValue, second.lengthValue);
}

function checkOrdering(sema: SemaApi, type: Type, span: Span): void {
  if (!isArithmeticType(type)) sema.error(span, `${typeName(type)} 型の要素は、大小を比べられません。`);
}

function extreme(values: Slice, direction: number, type: Type, spend: () => void): Value {
  if (values.lengthValue === 0n) panic(PANIC.unreachable);
  let best = values.get(0);
  for (let index = 1n; index < values.lengthValue; index++) {
    spend();
    const value = values.get(Number(index));
    if (type.kind === 'float' || type.kind === 'comptime_float')
      best = minMaxFloat(best as AnyFloat, value as AnyFloat, direction > 0);
    else if (compareScalars(value, best) * direction > 0) best = value;
  }
  return best;
}

function extremeIndex(name: string, direction: number): () => Member {
  return generic(name, 2, (sema, call, type, [sliceArg]) => {
    checkOrdering(sema, type, call.span);
    const slice = constSlice(sema, sliceArg, type);
    return computed(USIZE, [slice], call.span, ([value], frame) => {
      const values = value as Slice;
      if (values.lengthValue === 0n) panic(PANIC.unreachable);
      const spend = nativeBudget(sema, frame);
      let best = 0n;
      for (let index = 1n; index < values.lengthValue; index++) {
        spend();
        if (compareScalars(values.get(Number(index)), values.get(Number(best))) * direction > 0) best = index;
      }
      return best;
    });
  });
}

// code-gauge-allow functionCognitiveComplexity 17 -- Keeps directional transfer and exact bounds checks together.
function copier(name: string): () => Member {
  return generic(name, 3, (sema, call, type, [destinationArg, sourceArg]) => {
    const destination = mutableSlice(sema, destinationArg, type);
    const source = constSlice(sema, sourceArg, type);
    const cost = nativeTransferCost(sema, type, call.span);
    const backwards = name.endsWith('Backwards');
    return computed(VOID, [destination, source], call.span, ([out, input], frame) => {
      const values = input as Slice;
      const target = out as Slice;
      if (values.lengthValue > target.lengthValue) {
        panic(
          !backwards ? `index out of bounds: index ${values.lengthValue}, len ${target.lengthValue}` : PANIC.unreachable
        );
      }
      if (cost === 0) return;
      const spend = nativeBudget(sema, frame);
      for (let position = 0n; position < values.lengthValue; position++) {
        spend(cost * 2);
        const index = backwards ? values.lengthValue - position - 1n : position;
        storeSliceValue(target, Number(index), values.get(Number(index)));
      }
      return;
    });
  });
}

function replacementCount(
  input: Sequence,
  needle: Sequence,
  equal: typeof equalValues,
  onMatch?: (position: bigint) => void
): bigint {
  if (needle.length === 0n) panic(PANIC.unreachable);
  let count = 0n;
  for (
    let index = findSequence(input, needle, 0n, equal);
    index !== undefined;
    index = findSequence(input, needle, index + needle.length, equal)
  ) {
    count++;
    onMatch?.(index);
  }
  return count;
}

function replacementPlan(
  input: Sequence,
  needle: Sequence,
  replacement: Sequence,
  equal: typeof equalValues
): AllocationPlan {
  const positions: bigint[] = [];
  const count = replacementCount(input, needle, equal, (position) => positions.push(position));
  const length = input.length + count * (replacement.length - needle.length);
  return {
    length: Number(length),
    build: () => {
      const values: Value[] = [];
      let cursor = 0n,
        match = 0;
      while (cursor < input.length) {
        if (cursor === positions[match]) {
          for (let offset = 0n; offset < replacement.length; offset++) values.push(replacement.get(offset));
          cursor += needle.length;
          match++;
        } else values.push(input.get(cursor++));
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
        Array.from({ length: Number(type.length) }, () => zeroValue(type.child, fieldsOf)),
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
    checkOrdering(sema, type, call.span);
    const slice = constSlice(sema, sliceArg, type);
    return computed(tupleOf(sema, [USIZE, USIZE]), [slice], call.span, ([value], frame) => {
      const items = value as Slice;
      const spend = nativeBudget(sema, frame);
      if (items.length === 0) panic(PANIC.unreachable);
      let low = 0;
      let high = 0;
      for (let index = 0; index < items.length; index++) {
        spend(2);
        const item = items.get(index);
        if (compareScalars(item, items.get(low)) < 0) low = index;
        if (compareScalars(item, items.get(high)) > 0) high = index;
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
    const equality = comparisonOf(sema, type, call.span);
    return computed(optionalOf(tupleOf(sema, [slice, slice])), [haystack, needle], call.span, ([h, n], frame) => {
      const spend = nativeBudget(sema, frame);
      const items = sequence(h, spend);
      const pattern = sequence(n, spend, needleKind === 'scalar');
      const equal = equality(frame);
      const index = last ? findSequenceLast(items, pattern, equal) : findSequence(items, pattern, 0n, equal);
      if (index === undefined) return NULL;
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
    const equality = comparisonOf(sema, type, call.span);
    return computed(OPTIONAL_USIZE, [a, b], call.span, ([x, y], frame) => {
      const xs = x as Slice;
      const ys = y as Slice;
      const shorter = xs.lengthValue < ys.lengthValue ? xs.lengthValue : ys.lengthValue;
      const equal = equality(frame);
      for (let index = 0n; index < shorter; index++)
        if (!equal(xs.get(Number(index)), ys.get(Number(index)))) return index;
      return xs.lengthValue === ys.lengthValue ? NULL : shorter;
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
