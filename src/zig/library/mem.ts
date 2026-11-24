// code-gauge-allow-file fileNcss -- Memory adapters share typed slice access, comparison, and allocation helpers.
import { transferCost } from '../allocation';
import { indexOutOfBounds, PANIC, panic } from '../arith';
import type { Expression, Span } from '../ast';
import { zeroPhysicalValue } from '../bufferMemory';
import { enumLookup } from '../enumLookup';
import { type AnyFloat, BigFloat, compareFloats, floatFromBigInt, minMaxFloat } from '../floats';
import { sizeOf } from '../layout';
import { MemoryFault } from '../memoryFault';
import { isArithmeticType } from '../operands';
import type { Frame } from '../runtime';
import { copyForStorage, known, newArray, runtime, type SemaApi, type TExpr, undefinedValue } from '../semaBase';
import { singleValueOf } from '../singleValue';
import {
  arrayOf,
  BOOL,
  CONST_U8_SLICE,
  fnType,
  optionalOf,
  pointerTo,
  sliceOf,
  type StructType,
  TYPE,
  type Type,
  typeId,
  typeName,
  U8,
  USIZE,
  VOID,
} from '../types';
import {
  isUndefinedMemory,
  NULL,
  type Pointer,
  scalarValuesEqual,
  Slice,
  storageByteLocation,
  storageLocation,
  storageOverlaps,
  storeInto,
  type Value,
  type ZArray,
  ZStruct,
} from '../values';
import { WeakValueMap } from '../weakValueMap';
import { zeroAllocation } from '../zeroSizedMemory';
import {
  allocating,
  allocatorArg,
  compareScalars,
  computed,
  constSlice,
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
  subSlice as uncheckedSubSlice,
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
import { findSequence, type SearchSequence, sequenceMatches } from './sequenceSearch';
import { sorter } from './sort';

interface AllocationPlan {
  length: bigint;
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
    private readonly read: (index: bigint) => Value,
    private readonly location?: ReturnType<typeof storageLocation>
  ) {}

  get(index: bigint): Value {
    return this.read(index);
  }

  sameRange(other: SearchSequence<Value>): boolean {
    return (
      other instanceof Sequence &&
      this.location !== undefined &&
      this.location.storage === other.location?.storage &&
      this.location.index === other.location.index &&
      this.length === other.length
    );
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

function sequence(value: Value, spend: () => void, scalar = false, type?: Type): Sequence {
  if (scalar) return new Sequence(1n, () => value);
  const slice = value as Slice;
  const location =
    (type?.kind === 'int' || type === VOID) && !slice.undefinedHeader && !isUndefinedMemory(slice)
      ? storageLocation(slice.target.slots, slice.start)
      : undefined;
  return new Sequence(slice.lengthValue, (index) => readSlice(slice, index, spend), location);
}

function readSlice(slice: Slice, index: number | bigint, spend: () => void): Value {
  spend();
  return slice.get(Number(index));
}

function findSequenceLast(haystack: Sequence, needle: Sequence, equal: typeof equalValues): bigint | undefined {
  if (haystack.sameRange(needle)) return 0n;
  const found = findSequence(reversedSequence(haystack), reversedSequence(needle), 0n, equal);
  return found === undefined ? undefined : haystack.length - needle.length - found;
}

function reversedSequence(items: Sequence): Sequence {
  return new Sequence(items.length, (index) => items.get(items.length - index - 1n));
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
  const matches = sequenceMatches(haystack, needle, 0n, equal);
  for (let count = 1n; !matches.next().done; count++) {
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
    const b = searchOperand(sema, type, operand, second);
    const equality = comparisonOf(sema, type, call.span);
    return computed(resultType, [a, b], call.span, ([x, y], frame) => {
      const spend = nativeBudget(sema, frame);
      return compute(sequence(x, spend, false, type), sequence(y, spend, second === 'scalar', type), equality(frame));
    });
  });
}

// code-gauge-allow duplicateLines -- Search adapters share typed argument setup while indexed searches retain their start argument.
function positionSearch(
  name: string,
  second: 'slice' | 'scalar',
  compute: (haystack: Sequence, start: bigint, operand: Sequence, equal: typeof equalValues) => bigint | undefined
): () => Member {
  return generic(name, 4, (sema, call, type, [haystack, startArg, operand]) => {
    const a = constSlice(sema, haystack, type);
    const [start] = compileArgs(sema, [startArg], [USIZE]);
    const b = searchOperand(sema, type, operand, second);
    const equality = comparisonOf(sema, type, call.span);
    return computed(OPTIONAL_USIZE, [a, start, b], call.span, ([x, from, y], frame) => {
      const spend = nativeBudget(sema, frame);
      return optionalIndex(
        compute(
          sequence(x, spend, false, type),
          from as bigint,
          sequence(y, spend, second === 'scalar', type),
          equality(frame)
        )
      );
    });
  });
}

function searchOperand(sema: SemaApi, type: Type, arg: Expression, kind: 'slice' | 'scalar'): TExpr {
  return kind === 'slice' ? constSlice(sema, arg, type) : sema.coerce(sema.compile(arg, type), type, arg);
}

// code-gauge-allow functionCognitiveComplexity -- Keeps the paired live trim bounds together.
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
  const indexSlot = kind === 'split' ? 1 : 2;
  const delimiterSlot = kind === 'split' ? 2 : 1;
  const delimiterType = delimiter === 'scalar' ? child : sliceOf(child, true);
  const resultSlice = sliceOf(child, true);
  const created: StructType = nativeStruct(
    `mem.${kind === 'split' ? 'SplitIterator' : 'TokenIterator'}(${typeName(child)},.${delimiter})`,
    {},
    [
      { name: 'buffer', type: resultSlice, hasDefault: false },
      ...(kind === 'split'
        ? [
            { name: 'index', type: optionalOf(USIZE), hasDefault: false },
            { name: 'delimiter', type: delimiterType, hasDefault: false },
          ]
        : [
            { name: 'delimiter', type: delimiterType, hasDefault: false },
            { name: 'index', type: USIZE, hasDefault: false },
          ]),
    ]
  );
  type = created;
  iteratorTypes.set(key, type);
  const isDelimiter = (
    buffer: Slice,
    index: bigint,
    value: Value,
    equal: typeof equalValues,
    spend: () => void
  ): boolean => {
    if (delimiter === 'scalar') return equal(readSlice(buffer, index, spend), value);
    const set = value as Slice;
    if (delimiter === 'any') {
      if (set.lengthValue === 0n) return false;
      const item = readSlice(buffer, index, spend);
      for (let offset = 0n; offset < set.lengthValue; offset++)
        if (equal(readSlice(set, offset, spend), item)) return true;
      return false;
    }
    return startsWith(sequence(buffer, spend), sequence(set, spend), equal, index);
  };
  const findDelimiter = (
    buffer: Slice,
    from: bigint,
    value: Value,
    equal: typeof equalValues,
    spend: () => void
  ): bigint | undefined => {
    if (delimiter === 'sequence') return findSequence(sequence(buffer, spend), sequence(value, spend), from, equal);
    for (let index = from; index < buffer.lengthValue; index++)
      if (isDelimiter(buffer, index, value, equal, spend)) return index;
    return undefined;
  };
  const delimiterLength = (value: Value): bigint => (delimiter === 'sequence' ? (value as Slice).lengthValue : 1n);
  const method = (
    name: string,
    returnType: Type,
    run: (state: ZStruct, equal: typeof equalValues, spend: () => void) => Value
  ): (() => Member) =>
    fnMember(
      `${key}.${name}`,
      (sema, call) => {
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
      },
      () => ({
        type: fnType([name === 'rest' ? created : pointerTo(created, kind === 'split' && name === 'peek')], returnType),
        receiver: true,
      })
    );
  const tokenPeek = (
    state: ZStruct,
    equal: typeof equalValues,
    spend: () => void
  ): { start: bigint; end: bigint } | undefined => {
    const buffer = state.slots[0] as Slice;
    let index = state.slots[indexSlot] as bigint;
    while (index < buffer.lengthValue && isDelimiter(buffer, index, state.slots[delimiterSlot], equal, spend))
      index += delimiterLength(state.slots[delimiterSlot]);
    storeInto(state, indexSlot, index);
    if (index === buffer.lengthValue) return undefined;
    const end = findDelimiter(buffer, index, state.slots[delimiterSlot], equal, spend) ?? buffer.lengthValue;
    return { start: index, end };
  };
  const members: Record<string, () => Member> =
    kind === 'split'
      ? {
          next: method('next', optionalOf(resultSlice), (state, equal, spend) => {
            const startValue = state.slots[indexSlot];
            if (startValue === NULL) return NULL;
            const start = startValue as bigint;
            const buffer = state.slots[0] as Slice;
            let end = buffer.lengthValue;
            const found = findDelimiter(buffer, start, state.slots[delimiterSlot], equal, spend) ?? -1n;
            if (found === -1n) {
              storeInto(state, indexSlot, NULL);
            } else {
              storeInto(state, indexSlot, found + delimiterLength(state.slots[delimiterSlot]));
              end = found;
            }
            return subSlice(state.slots[0] as Slice, start, end - start);
          }),
          first: method('first', resultSlice, (state, equal, spend) => {
            if (state.slots[indexSlot] === NULL) panic(PANIC.nullUnwrap);
            if (state.slots[indexSlot] !== 0n) panic(PANIC.unreachable);
            const buffer = state.slots[0] as Slice;
            const end = findDelimiter(buffer, 0n, state.slots[delimiterSlot], equal, spend) ?? buffer.lengthValue;
            storeInto(
              state,
              indexSlot,
              end === buffer.lengthValue ? NULL : end + delimiterLength(state.slots[delimiterSlot])
            );
            return subSlice(state.slots[0] as Slice, 0n, end);
          }),
          peek: method('peek', optionalOf(resultSlice), (state, equal, spend) => {
            const startValue = state.slots[indexSlot];
            if (startValue === NULL) return NULL;
            const start = startValue as bigint;
            const buffer = state.slots[0] as Slice;
            const end = findDelimiter(buffer, start, state.slots[delimiterSlot], equal, spend) ?? buffer.lengthValue;
            return subSlice(state.slots[0] as Slice, start, end - start);
          }),
          rest: method('rest', resultSlice, (state) => {
            const buffer = state.slots[0] as Slice;
            const startValue = state.slots[indexSlot];
            const start = startValue === NULL ? buffer.lengthValue : (startValue as bigint);
            return subSlice(buffer, start, buffer.lengthValue - start);
          }),
          reset: method('reset', VOID, (state) => {
            storeInto(state, indexSlot, 0n);
            return;
          }),
        }
      : {
          next: method('next', optionalOf(resultSlice), (state, equal, spend) => {
            const token = tokenPeek(state, equal, spend);
            if (!token) return NULL;
            storeInto(state, indexSlot, token.end);
            return subSlice(state.slots[0] as Slice, token.start, token.end - token.start);
          }),
          peek: method('peek', optionalOf(resultSlice), (state, equal, spend) => {
            const token = tokenPeek(state, equal, spend);
            if (!token) return NULL;
            return subSlice(state.slots[0] as Slice, token.start, token.end - token.start);
          }),
          rest: method('rest', resultSlice, (state, equal, spend) => {
            const buffer = state.slots[0] as Slice;
            let index = state.slots[indexSlot] as bigint;
            while (index < buffer.lengthValue && isDelimiter(buffer, index, state.slots[delimiterSlot], equal, spend))
              index += delimiterLength(state.slots[delimiterSlot]);
            return subSlice(state.slots[0] as Slice, index, buffer.lengthValue - index);
          }),
          reset: method('reset', VOID, (state) => {
            storeInto(state, indexSlot, 0n);
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
      return new ZStruct(kind === 'split' ? [value, 0n, separator] : [value, separator, 0n]);
    });
  });
}

// The namespace ---------------------------------------------------------------------------------------------------------

/** The elements from a pointer up to a sentinel value, for `std.mem.span`, `len`, and `sliceTo`. */
function sentinelSpan(name: string, kind: 'span' | 'len' | 'sliceTo'): () => Member {
  return fnMember(name, (sema, call) => {
    const args = expectArgs(sema, call, kind === 'sliceTo' ? 2 : 1, name);
    const operand = sema.compile(args[0]);
    let type = operand.type;
    const optional = type.kind === 'optional';
    if (type.kind === 'optional') type = type.child;
    if (type.kind !== 'pointer') return sema.error(call.span, `${name} にはポインタかスライスを渡してください。`);
    const array = type.size === 'one' && type.child.kind === 'array' ? type.child : undefined;
    const child = array ? array.child : type.child;
    const sentinel = array ? array.sentinel : type.sentinel;
    const end =
      kind === 'sliceTo'
        ? sema.knownValue(sema.coerce(sema.compile(args[1], child), child, args[1]), '終わりの値')
        : undefined;
    if (kind !== 'sliceTo' && sentinel === undefined && type.size !== 'slice')
      return sema.error(call.span, `${name} には、番兵付きのポインタ（[*:0]u8 など）を渡してください。`);
    const stop = end ?? sentinel?.value;
    const keepsSentinel = sentinel !== undefined && (end === undefined || scalarValuesEqual(end, sentinel.value));
    const sliceType = sliceOf(child, type.isConst, keepsSentinel ? sentinel : undefined);
    const resultType = kind === 'len' ? USIZE : optional ? optionalOf(sliceType) : sliceType;
    const evaluate = operand.eval;
    const span = (value: Value, frame: Frame): Value => {
      if (value === NULL) return NULL;
      let target: { slots: Value[] };
      let start: number;
      let limit: number;
      if (value instanceof Slice) {
        target = value.target;
        start = value.start;
        limit = start + value.length;
      } else if (array) {
        const view = (value as Pointer).load() as ZArray;
        target = view;
        start = view.offset;
        limit = start + view.length;
      } else {
        target = (value as Pointer).target;
        start = (value as Pointer).index;
        limit = target.slots.length;
      }
      let position = start;
      while (position < limit && (stop === undefined || !scalarValuesEqual(target.slots[position], stop))) {
        frame.runtime.spend();
        position++;
      }
      if (position >= target.slots.length && !(value instanceof Slice) && !array) throw new MemoryFault();
      if (kind === 'len') return BigInt(position - start);
      return new Slice(target, start, position - start);
    };
    return runtime(resultType, (frame) => span(evaluate(frame), frame), call.span);
  });
}

const MEMBERS: Record<string, () => Member> = {
  Allocator: typeMember(() => ALLOCATOR),
  span: sentinelSpan('std.mem.span', 'span'),
  len: sentinelSpan('std.mem.len', 'len'),
  sliceTo: sentinelSpan('std.mem.sliceTo', 'sliceTo'),
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
      const spend = nativeBudget(sema, frame);
      for (let index = 0; index < a.length; index++)
        if (!equal(readSlice(a, index, spend), readSlice(b, index, spend))) return false;
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
  count: sliceSearch('std.mem.count', 'slice', USIZE, replacementCount),
  countScalar: sliceSearch('std.mem.countScalar', 'scalar', USIZE, countScalar),
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
    return computed(tupleOf(sema, [type, type]), [slice], call.span, ([value], frame) =>
      sliceExtrema(value as Slice, type, nativeBudget(sema, frame))
    );
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
    const cost = nativeTransferCost(sema, type, call.span);
    return computed(VOID, [slice, match, replacement], call.span, ([value, from, to], frame) => {
      const target = value as Slice;
      const equal = equality(frame);
      const spend = nativeBudget(sema, frame);
      for (let index = 0; index < target.length; index++) {
        if (!equal(readSlice(target, index, spend), from)) continue;
        spend(cost);
        storeSliceValue(target, index, to);
      }
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
      return replacementLength(source.length, pattern.length, (r as Slice).lengthValue, count);
    });
  }),
  // code-gauge-allow functionNcss -- Implements sequential replacement, overlap and capacity checks together.
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
      const changesSearch = replacementCanChangeSearch(source, pattern, replace, target, sizeOf(type));
      const text = sequence(source, spend);
      const needle = sequence(pattern, spend);
      const matchesInStableInput = changesSearch ? undefined : sequenceMatches(text, needle, 0n, equal);
      let next = matchesInStableInput?.next().value;
      let index = 0,
        written = 0,
        count = 0;
      while (index < source.length) {
        spend();
        const matches = changesSearch ? startsWith(text, needle, equal, BigInt(index)) : next === BigInt(index);
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
          next = matchesInStableInput?.next().value;
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
    const empty = emptySliceLiteral(sema, type, call.span);
    return allocatingCall(sliceOf(type, false), [allocator, slices], call.span, ([value], frame) =>
      joiningPlan(value as Slice, undefined, empty, () => frame.runtime.spend(), sizeOf(type) === 0)
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
    const empty = emptySliceLiteral(sema, U8, call.span);
    return allocatingCall(sliceOf(U8, false), [allocator, separator, slices], call.span, ([sep, value], frame) =>
      joiningPlan(value as Slice, sep as Slice, empty, () => frame.runtime.spend())
    );
  }),
  sort: sorter('std.mem.sort', 'block'),
  sortUnstable: sorter('std.mem.sortUnstable', 'pdq'),
  zeroes: fnMember('std.mem.zeroes', (sema, call) => {
    const [typeArg] = expectArgs(sema, call, 1, 'std.mem.zeroes');
    const type = sema.compileType(typeArg);
    sema.reserveStorage(type, call.span);
    sema.spendCompilation(transferCost(type));
    return known(type, zeroValue(type, sema, call.span), call.span);
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

function replacementCanChangeSearch(
  source: Slice,
  needle: Slice,
  replacement: Slice,
  target: Slice,
  stride: number
): boolean {
  const overlaps = (input: Slice): boolean =>
    storageOverlaps(input.target, input.start, target.target, target.start, input.length, stride, target.length);
  if (overlaps(needle)) return true;
  if (!overlaps(source)) return false;
  const sourceLocation = storageByteLocation(source.target, source.start, stride);
  const targetLocation = storageByteLocation(target.target, target.start, stride);
  return targetLocation.index > sourceLocation.index || replacement.lengthValue > needle.lengthValue;
}

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
      const spend = nativeBudget(sema, frame);
      if (!startsWith(sequence(input, spend), sequence(target, spend), equality(frame), offset)) return NULL;
      return new Slice(
        input.target,
        input.start + (suffix ? 0 : Number(target.lengthValue)),
        input.lengthValue - target.lengthValue
      );
    });
  });
}

function countScalar(haystack: Sequence, needle: Sequence, equal: typeof equalValues): bigint {
  const value = needle.get(0n);
  return haystack.count((item) => equal(item, value));
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
    const x = readSlice(first, index, spend);
    const y = readSlice(second, index, spend);
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
  let best = readSlice(values, 0, spend);
  for (let index = 1n; index < values.lengthValue; index++) {
    spend();
    best = selectExtreme(best, readSlice(values, index, spend), direction, type);
  }
  return best;
}

function sliceExtrema(values: Slice, type: Type, spend: (cost?: number) => void): ZStruct {
  if (values.lengthValue === 0n) panic(PANIC.unreachable);
  let minimum = readSlice(values, 0, spend);
  let maximum = minimum;
  for (let index = 1n; index < values.lengthValue; index++) {
    spend(2);
    const value = readSlice(values, index, spend);
    minimum = selectExtreme(minimum, value, -1, type);
    maximum = selectExtreme(maximum, value, 1, type);
  }
  return new ZStruct([minimum, maximum]);
}

function selectExtreme(best: Value, value: Value, direction: number, type: Type): Value {
  if (type.kind === 'float' || type.kind === 'comptime_float')
    return minMaxFloat(best as AnyFloat, value as AnyFloat, direction > 0);
  return compareScalars(value, best) * direction > 0 ? value : best;
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
        if (compareScalars(readSlice(values, index, spend), readSlice(values, best, spend)) * direction > 0)
          best = index;
      }
      return best;
    });
  });
}

// code-gauge-allow functionCognitiveComplexity -- Keeps exact bounds, copy direction and reference transfer in evaluation order.
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
  for (const index of sequenceMatches(input, needle, 0n, equal)) {
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
  const length = replacementLength(input.length, needle.length, replacement.length, count);
  return {
    length,
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

function emptySliceLiteral(sema: SemaApi, type: Type, span: Span, sentinel?: 0n): Slice {
  const literal = known(arrayOf(0, type, sentinel), newArray([], sentinel), span);
  const array = (sema.addressOf(literal).value as Pointer).load() as ZArray;
  return new Slice(array, array.offset, 0);
}

// code-gauge-allow functionCognitiveComplexity -- Plans exact lengths before traversing only stored data.
function joiningPlan(
  parts: Slice,
  separator: Slice | undefined,
  empty: Slice,
  spend: () => void,
  zero = false
): AllocationPlan | Slice {
  if (parts.lengthValue === 0n) return empty;
  const slices: Slice[] = [];
  let length = BigInt(separator?.length ?? 0) * BigInt(Math.max(0, parts.length - 1));
  for (let index = 0; index < parts.length; index++) {
    spend();
    const slice = parts.get(index) as Slice;
    slices.push(slice);
    length += slice.lengthValue;
    if (length > (1n << 64n) - 1n) panic(PANIC.overflow);
  }
  return {
    length,
    build: () => {
      if (zero) return [];
      const values: Value[] = [];
      for (const [index, slice] of slices.entries()) {
        if (index > 0 && separator) for (let at = 0; at < separator.length; at++) values.push(separator.get(at));
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
  plan: (values: Value[], frame: Frame) => AllocationPlan | Slice
): TExpr {
  return nativeCall(allocating(type), args, span, (values, frame) => {
    const allocation = plan(values.slice(1), frame);
    if (allocation instanceof Slice) return allocation;
    const child = type.kind === 'pointer' ? type.child : type;
    const complete = reserveNativeAllocation(frame, allocatorState(values[0]), allocation.length, child);
    if (!complete) return ERROR_OUT_OF_MEMORY;
    if (sizeOf(child) !== 0) frame.runtime.spend(Number(allocation.length) * (transferCost(child) + 1));
    const { length } = allocation;
    const result =
      length === 0n || sizeOf(child) === 0
        ? zeroAllocation(frame.runtime, length, child)
        : newSlice(allocation.build());
    complete(result.target);
    return result;
  });
}

// code-gauge-allow functionCognitiveComplexity -- Follows the reference zero-initialization rules for each supported type.
// code-gauge-allow functionNcss -- Keeps type validation with the corresponding zero representation.
function zeroValue(type: Type, sema: SemaApi, span: Span): Value {
  sema.spendCompilation();
  const zero = (child: Type): Value => zeroValue(child, sema, span);
  switch (type.kind) {
    case 'int':
    case 'comptime_int': {
      return 0n;
    }
    case 'comptime_float': {
      return BigFloat.zero();
    }
    case 'float': {
      return floatFromBigInt(0n, type.bits);
    }
    case 'enum': {
      const fields = enumLookup(sema.enumFields(type), () => sema.spendCompilation());
      if (type.exhaustive && !fields.byValue.has(0n)) return sema.error(span, 'enum に値 0 がありません。');
      return 0n;
    }
    case 'void': {
      return undefined;
    }
    case 'bool': {
      return false;
    }
    case 'null':
    case 'optional': {
      return NULL;
    }
    case 'array': {
      const child = zero(type.child);
      const singleton = singleValueOf(type, () => sema.spendCompilation());
      if (singleton) return copyForStorage(singleton.value);
      return newArray(
        Array.from({ length: Number(type.length) }, () => copyForStorage(child)),
        type.sentinel
      );
    }
    case 'struct': {
      if (sizeOf(type) === 0) return undefinedValue(type);
      if (type.layout === 'extern') return zeroPhysicalValue(type);
      return new ZStruct(
        sema
          .structFields(type, span)
          .map((field) => (field.comptimeValue ? field.comptimeValue.value : zero(field.type)))
      );
    }
    case 'pointer': {
      if (type.size === 'slice') {
        if (type.sentinel === undefined) return emptySliceLiteral(sema, type.child, span);
        if (type.isConst && type.child === U8 && type.sentinel.value === 0n)
          return emptySliceLiteral(sema, U8, span, 0n);
      }
      break;
    }
    case 'union': {
      if (type.layout === 'extern') {
        sema.unionFields(type);
        return zeroPhysicalValue(type);
      }
      break;
    }
  }
  return sema.error(span, `std.mem.zeroes は ${typeName(type)} 型をゼロにできません。`);
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
        const item = readSlice(items, index, spend);
        if (compareScalars(item, readSlice(items, low, spend)) < 0) low = index;
        if (compareScalars(item, readSlice(items, high, spend)) > 0) high = index;
      }
      return new ZStruct([BigInt(low), BigInt(high)]);
    });
  })();
}

/** `cut(T, haystack, needle)` and its variants: the parts before and after the first or last match, or null. */
function cutter(name: string, needleKind: 'slice' | 'scalar', last: boolean): Member {
  return generic(name, 3, (sema, call, type, [haystackArg, needleArg]) => {
    const haystack = constSlice(sema, haystackArg, type);
    const needle = searchOperand(sema, type, needleArg, needleKind);
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
      const spend = nativeBudget(sema, frame);
      for (let index = 0n; index < shorter; index++)
        if (!equal(readSlice(xs, index, spend), readSlice(ys, index, spend))) return index;
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

function subSlice(slice: Slice, start: number | bigint, length: number | bigint): Slice {
  const first = BigInt(start),
    end = first + BigInt(length);
  if (first > end) panic(`start index ${first} is larger than end index ${end}`);
  if (end > slice.lengthValue) indexOutOfBounds(end, slice.lengthValue);
  return uncheckedSubSlice(slice, start, length);
}

function replacementLength(input: bigint, needle: bigint, replacement: bigint, count: bigint): bigint {
  const length = input + count * (replacement - needle);
  if (length < 0n || length > (1n << 64n) - 1n) panic(PANIC.overflow);
  return length;
}
