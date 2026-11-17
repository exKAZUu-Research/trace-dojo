import { transferCost } from '../allocation';
import { indexOutOfBounds, PANIC, panic } from '../arith';
import { enumLookup } from '../enumLookup';
import { sizeOf } from '../layout';
import { isIntegerType } from '../operands';
import { type Frame, withHeldValues } from '../runtime';
import { copyForFrame, copyForStorage, FnRef, known, undefinedValue } from '../semaBase';
import {
  BOOL,
  CONST_U8_SLICE,
  errorSetOf,
  errorUnionOf,
  fitsInt,
  intType,
  optionalOf,
  pointerTo,
  sliceOf,
  type StructType,
  TYPE,
  type Type,
  typeId,
  typeName,
  U8,
  U21,
  USIZE,
  VOID,
} from '../types';
import { decodeIdentifierBytes } from '../utf8';
import {
  ErrorValue,
  FnValue,
  NULL,
  optionalSome,
  type Pointer,
  Slice,
  type Value,
  ZArray,
  ZStruct,
  type ZUnion,
} from '../values';
import { WeakValueMap } from '../weakValueMap';
import { zeroAllocation } from '../zeroSizedMemory';
import { computed, constSlice, nativeBudget, newSlice, ORDER, ORDER_GT, ORDER_LT, storeSliceValue } from './common';
import {
  ALLOCATOR,
  ALLOCATOR_ERROR,
  type AllocatorState,
  allocatorState,
  ERROR_OUT_OF_MEMORY,
  freeMemory,
  reserveNativeAllocation,
} from './heap';
import {
  addMembers,
  callbackFunction,
  checkCallback,
  compileArgs,
  concreteFnMember,
  expectArgs,
  fnMember,
  type Member,
  nativeStateCall,
  nativeStruct,
  structReceiver,
} from './native';
import { validateEquality, valuesEqual } from './valueEquality';

// std.unicode -----------------------------------------------------------------------------------------------------------

const U3 = intType(false, 3);
const UTF8_DECODE_ERRORS = [
  'Utf8ExpectedContinuation',
  'Utf8OverlongEncoding',
  'Utf8EncodesSurrogateHalf',
  'Utf8CodepointTooLarge',
];

function sequenceLength(first: number): number | undefined {
  if (first < 0x80) return 1;
  if ((first & 0xe0) === 0xc0) return 2;
  if ((first & 0xf0) === 0xe0) return 3;
  if ((first & 0xf8) === 0xf0) return 4;
  return undefined;
}

/** Decodes one UTF-8 sequence as `utf8Decode` does, or names its error. */
// code-gauge-allow functionCognitiveComplexity 24 -- Transcribes the corresponding function of Zig's standard library or compiler step by step.
// code-gauge-allow functionNcss 31 -- Keeps sequence-shape assertions and recoverable decode errors together.
function decode(bytes: number[]): number | string {
  if (bytes.length === 0 || bytes.length > 4) panic(PANIC.unreachable);
  if (bytes.length > 1 && bytes[0] >> (7 - bytes.length) !== ((1 << bytes.length) - 1) << 1) panic(PANIC.unreachable);
  switch (bytes.length) {
    case 1: {
      return bytes[0];
    }
    case 2: {
      if ((bytes[1] & 0xc0) !== 0x80) return 'Utf8ExpectedContinuation';
      const value = ((bytes[0] & 0x1f) << 6) | (bytes[1] & 0x3f);
      return value < 0x80 ? 'Utf8OverlongEncoding' : value;
    }
    case 3: {
      if ((bytes[1] & 0xc0) !== 0x80 || (bytes[2] & 0xc0) !== 0x80) return 'Utf8ExpectedContinuation';
      const value = ((bytes[0] & 0x0f) << 12) | ((bytes[1] & 0x3f) << 6) | (bytes[2] & 0x3f);
      if (value < 0x8_00) return 'Utf8OverlongEncoding';
      if (value >= 0xd8_00 && value <= 0xdf_ff) return 'Utf8EncodesSurrogateHalf';
      return value;
    }
    default: {
      if ((bytes[1] & 0xc0) !== 0x80 || (bytes[2] & 0xc0) !== 0x80 || (bytes[3] & 0xc0) !== 0x80) {
        return 'Utf8ExpectedContinuation';
      }
      const value =
        ((bytes[0] & 0x07) << 18) | ((bytes[1] & 0x3f) << 12) | ((bytes[2] & 0x3f) << 6) | (bytes[3] & 0x3f);
      if (value < 0x1_00_00) return 'Utf8OverlongEncoding';
      if (value > 0x10_ff_ff) return 'Utf8CodepointTooLarge';
      return value;
    }
  }
}

function byteNumbers(value: Value, spend: (cost?: number) => void): number[] {
  const slice = value as Slice;
  spend(slice.length);
  return slice.values().map((byte) => Number(byte as bigint));
}

function codepoints(value: Value, spend: (cost?: number) => void): number | string {
  const bytes = value as Slice;
  let count = 0;
  let index = 0;
  while (index < bytes.length) {
    spend();
    const first = Number(bytes.get(index));
    const length = sequenceLength(first);
    if (length === undefined) return 'Utf8InvalidStartByte';
    if (index + length > bytes.length) return 'TruncatedInput';
    const sequence = [first];
    for (let offset = 1; offset < length; offset++) {
      spend();
      sequence.push(Number(bytes.get(index + offset)));
    }
    const point = decode(sequence);
    if (typeof point === 'string') return point;
    count++;
    index += length;
  }
  return count;
}

const UTF8_ITERATOR: StructType = nativeStruct('unicode.Utf8Iterator', {}, [
  { name: 'bytes', type: CONST_U8_SLICE, hasDefault: false },
  { name: 'i', type: USIZE, hasDefault: false },
]);

const UTF8_VIEW: StructType = nativeStruct('unicode.Utf8View', {}, [
  { name: 'bytes', type: CONST_U8_SLICE, hasDefault: false },
]);

/** The next code point's bytes, advancing the iterator. */
function nextSlice(state: ZStruct): Slice | undefined {
  const bytes = state.slots[0] as Slice;
  const index = Number(state.slots[1] as bigint);
  if (index >= bytes.length) return undefined;
  const length = sequenceLength(Number(bytes.get(index) as bigint)) ?? 1;
  state.slots[1] = BigInt(index + length);
  return new Slice(bytes.target, bytes.start + index, length);
}

addMembers(UTF8_ITERATOR, {
  nextCodepointSlice: concreteFnMember(
    'Utf8Iterator.nextCodepointSlice',
    [pointerTo(UTF8_ITERATOR, false)],
    optionalOf(CONST_U8_SLICE),
    ([pointer]) => nextSlice((pointer as Pointer).load() as ZStruct) ?? NULL
  ),
  nextCodepoint: concreteFnMember(
    'Utf8Iterator.nextCodepoint',
    [pointerTo(UTF8_ITERATOR, false)],
    optionalOf(U21),
    ([pointer], frame) => {
      const slice = nextSlice((pointer as Pointer).load() as ZStruct);
      if (!slice) return NULL;
      const value = decode(byteNumbers(slice, (cost) => frame.runtime.spend(cost)));
      if (typeof value === 'string') panic(PANIC.unreachable);
      return BigInt(value);
    }
  ),
});

addMembers(UTF8_VIEW, {
  init: concreteFnMember(
    'Utf8View.init',
    [CONST_U8_SLICE],
    errorUnionOf(errorSetOf(['InvalidUtf8']), UTF8_VIEW),
    ([value], frame) =>
      typeof codepoints(value, (cost) => frame.runtime.spend(cost)) === 'string'
        ? ErrorValue.of('InvalidUtf8')
        : new ZStruct([value])
  ),
  initUnchecked: concreteFnMember(
    'Utf8View.initUnchecked',
    [CONST_U8_SLICE],
    UTF8_VIEW,
    ([value]) => new ZStruct([value])
  ),
  iterator: concreteFnMember(
    'Utf8View.iterator',
    [UTF8_VIEW],
    UTF8_ITERATOR,
    ([value]) => new ZStruct([(value as ZStruct).slots[0], 0n])
  ),
});

const UNICODE: Record<string, () => Member> = {
  Utf8View: () => ({ type: TYPE, value: UTF8_VIEW }),
  Utf8Iterator: () => ({ type: TYPE, value: UTF8_ITERATOR }),
  replacement_character: () => ({ type: U21, value: 0xff_fdn }),
  utf8ByteSequenceLength: concreteFnMember(
    'std.unicode.utf8ByteSequenceLength',
    [U8],
    errorUnionOf(errorSetOf(['Utf8InvalidStartByte']), U3),
    ([value]) => {
      const length = sequenceLength(Number(value as bigint));
      return length === undefined ? ErrorValue.of('Utf8InvalidStartByte') : BigInt(length);
    }
  ),
  utf8CodepointSequenceLength: concreteFnMember(
    'std.unicode.utf8CodepointSequenceLength',
    [U21],
    errorUnionOf(errorSetOf(['CodepointTooLarge']), U3),
    ([value]) => {
      const length = utf8SequenceLength(Number(value as bigint));
      return length instanceof ErrorValue ? length : BigInt(length);
    }
  ),
  utf8Encode: concreteFnMember(
    'std.unicode.utf8Encode',
    [U21, sliceOf(U8, false)],
    errorUnionOf(errorSetOf(['Utf8CannotEncodeSurrogateHalf', 'CodepointTooLarge']), U3),
    ([value, target]) => {
      const n = Number(value as bigint);
      const length = utf8SequenceLength(n);
      if (length instanceof ErrorValue) return length;
      const slice = target as Slice;
      if (BigInt(length) > slice.lengthValue) panic(PANIC.unreachable);
      if (n >= 0xd8_00 && n <= 0xdf_ff) return ErrorValue.of('Utf8CannotEncodeSurrogateHalf');
      const bytes = [...new TextEncoder().encode(String.fromCodePoint(n))];
      for (const [index, byte] of bytes.entries()) slice.set(index, BigInt(byte));
      return BigInt(bytes.length);
    }
  ),
  utf8Decode: concreteFnMember(
    'std.unicode.utf8Decode',
    [CONST_U8_SLICE],
    errorUnionOf(errorSetOf(UTF8_DECODE_ERRORS), U21),
    ([value], frame) => {
      const result = decode(byteNumbers(value, (cost) => frame.runtime.spend(cost)));
      return typeof result === 'string' ? ErrorValue.of(result) : BigInt(result);
    }
  ),
  utf8ValidCodepoint: concreteFnMember('std.unicode.utf8ValidCodepoint', [U21], BOOL, ([value]) => {
    const codepoint = value as bigint;
    return codepoint <= 0x10_ff_ffn && !(codepoint >= 0xd8_00n && codepoint <= 0xdf_ffn);
  }),
  utf8CountCodepoints: concreteFnMember(
    'std.unicode.utf8CountCodepoints',
    [CONST_U8_SLICE],
    errorUnionOf(errorSetOf(['Utf8InvalidStartByte', 'TruncatedInput', ...UTF8_DECODE_ERRORS]), USIZE),
    ([value], frame) => {
      const result = codepoints(value, (cost) => frame.runtime.spend(cost));
      return typeof result === 'string' ? ErrorValue.of(result) : BigInt(result);
    }
  ),
  utf8ValidateSlice: concreteFnMember(
    'std.unicode.utf8ValidateSlice',
    [CONST_U8_SLICE],
    BOOL,
    ([value], frame) => typeof codepoints(value, (cost) => frame.runtime.spend(cost)) !== 'string'
  ),
};

function utf8SequenceLength(codepoint: number): number | ErrorValue {
  if (codepoint < 0x80) return 1;
  if (codepoint < 0x8_00) return 2;
  if (codepoint < 0x1_00_00) return 3;
  if (codepoint < 0x11_00_00) return 4;
  return ErrorValue.of('CodepointTooLarge');
}

// std.meta and std.enums ------------------------------------------------------------------------------------------------

const META: Record<string, () => Member> = {
  eql: fnMember('std.meta.eql', (sema, call) => {
    const [aArg, bArg] = expectArgs(sema, call, 2, 'std.meta.eql');
    const a = sema.compile(aArg);
    const b = sema.coerce(sema.compile(bArg, a.type), a.type, bArg);
    sema.resolveStorage(a.type, call.span);
    validateEquality(sema, a.type, call.span);
    return computed(BOOL, [a, b], call.span, ([x, y], frame) => valuesEqual(a.type, x, y, nativeBudget(sema, frame)));
  }),
  stringToEnum: fnMember('std.meta.stringToEnum', (sema, call) => {
    const [typeArg, textArg] = expectArgs(sema, call, 2, 'std.meta.stringToEnum');
    const type = sema.compileType(typeArg);
    if (type.kind !== 'enum')
      return sema.error(typeArg, `stringToEnum には enum の型を渡してください（${typeName(type)} です）。`);
    const fields = enumLookup(sema.enumFields(type), () => sema.spendCompilation());
    const text = constSlice(sema, textArg, U8);
    return computed(optionalOf(type), [text], call.span, ([value], frame) => {
      const name = decodeIdentifierBytes(byteNumbers(value, nativeBudget(sema, frame)));
      return fields.byName.get(name)?.value ?? NULL;
    });
  }),
  activeTag: fnMember('std.meta.activeTag', (sema, call) => {
    const [unionArg] = expectArgs(sema, call, 1, 'std.meta.activeTag');
    const union = sema.compile(unionArg);
    const type = union.type;
    if (type.kind !== 'union' || !type.tagType)
      return sema.error(unionArg, 'activeTag にはタグ付き union を渡してください。');
    const tagType = type.tagType;
    const tags = sema.enumFields(tagType);
    return computed(tagType, [union], call.span, ([value]) => tags[(value as ZUnion).tag].value);
  }),
};

const ENUMS: Record<string, () => Member> = {
  tagName: fnMember('std.enums.tagName', (sema, call) => {
    const [typeArg, valueArg] = expectArgs(sema, call, 2, 'std.enums.tagName');
    const type = sema.compileType(typeArg);
    if (type.kind !== 'enum') return sema.error(typeArg, 'tagName には enum の型を渡してください。');
    const fields = enumLookup(sema.enumFields(type), () => sema.spendCompilation());
    const value = sema.coerce(sema.compile(valueArg, type), type, valueArg);
    return computed(optionalOf(CONST_U8_SLICE), [value], call.span, ([tag], frame) => {
      const field = fields.byValue.get(tag as bigint);
      if (!field) return NULL;
      return sema.nameSlice(field.name, frame);
    });
  }),
  fromInt: fnMember('std.enums.fromInt', (sema, call) => {
    const [typeArg, valueArg] = expectArgs(sema, call, 2, 'std.enums.fromInt');
    const type = sema.compileType(typeArg);
    if (type.kind !== 'enum') return sema.error(typeArg, 'fromInt には enum の型を渡してください。');
    const fields = enumLookup(sema.enumFields(type), () => sema.spendCompilation());
    const value = sema.compile(valueArg);
    if (!isIntegerType(value.type)) return sema.error(valueArg, 'fromInt の値は整数にしてください。');
    return computed(optionalOf(type), [value], call.span, ([n]) =>
      fitsInt(n as bigint, type.tagType!) && (!type.exhaustive || fields.byValue.has(n as bigint)) ? n : NULL
    );
  }),
  values: fnMember('std.enums.values', (sema, call) => {
    const [typeArg] = expectArgs(sema, call, 1, 'std.enums.values');
    const type = sema.compileType(typeArg);
    if (type.kind !== 'enum') return sema.error(typeArg, 'values には enum の型を渡してください。');
    return known(sliceOf(type, true), newSlice(sema.enumFields(type).map((field) => field.value)), call.span);
  }),
};

// std.PriorityQueue -----------------------------------------------------------------------------------------------------

const queueTypes = new WeakValueMap<string, StructType>();

function priorityQueueType(
  element: Type,
  context: Type,
  compare: { call: (frame: Frame, args: Value[]) => Value },
  key: string
): StructType {
  const existing = queueTypes.get(key);
  if (existing) return existing;
  const type = nativeStruct(`priority_queue.PriorityQueue(${typeName(element)})`, {}, [
    { name: 'items', type: sliceOf(element, false), hasDefault: false },
    { name: 'cap', type: USIZE, hasDefault: false },
    { name: 'context', type: context, hasDefault: false },
  ]);
  queueTypes.set(key, type);
  const store = (frame: Frame, items: Slice, index: number, value: Value): void => {
    frame.runtime.spend(2 * transferCost(element));
    storeSliceValue(items, index, value);
  };
  const order = (frame: Frame, queue: ZStruct, a: Value, b: Value): bigint =>
    compare.call(frame, [queue.slots[2], a, b]) as bigint;
  const siftUp = (frame: Frame, queue: ZStruct, start: number): void => {
    const items = queue.slots[0] as Slice;
    const child = copyForFrame(frame, items.get(start), element);
    let index = start;
    while (index > 0) {
      const parentIndex = (index - 1) >> 1;
      const parent = items.get(parentIndex);
      if (order(frame, queue, child, parent) !== ORDER_LT) break;
      store(frame, items, index, parent);
      index = parentIndex;
    }
    store(frame, items, index, child);
  };
  const siftDown = (frame: Frame, queue: ZStruct, target: number): void => {
    const items = queue.slots[0] as Slice;
    const saved = copyForFrame(frame, items.get(target), element);
    let index = target;
    for (;;) {
      let lesser = index * 2 + 1;
      if (lesser >= items.length) break;
      const next = lesser + 1;
      if (next < items.length && order(frame, queue, items.get(next), items.get(lesser)) === ORDER_LT) lesser = next;
      if (order(frame, queue, saved, items.get(lesser)) === ORDER_LT) break;
      store(frame, items, index, items.get(lesser));
      index = lesser;
    }
    store(frame, items, index, saved);
  };
  const reserve = (frame: Frame, queue: ZStruct, wanted: number, allocator: AllocatorState | undefined): boolean => {
    let capacity = Number(queue.slots[1] as bigint);
    if (capacity >= wanted) return true;
    while (capacity < wanted) capacity += Math.floor(capacity / 2) + 8;
    const items = queue.slots[0] as Slice;
    const complete = reserveNativeAllocation(
      frame,
      allocator,
      capacity,
      element,
      Number(queue.slots[1] as bigint) > 0 ? items.target : undefined
    );
    if (!complete) return false;
    if (sizeOf(element) === 0) {
      const storage = zeroAllocation(frame.runtime, BigInt(capacity), element);
      complete(storage.target, items.length);
      queue.slots[0] = new Slice(storage.target, storage.start, items.lengthValue);
      queue.slots[1] = BigInt(capacity);
      return true;
    }
    frame.runtime.spend((capacity + items.length) * transferCost(element));
    const values = items.values().map(copyForStorage);
    while (values.length < capacity) values.push(undefinedValue(element));
    const storage = new ZArray(values, 0, capacity);
    complete(storage, items.length);
    queue.slots[0] = new Slice(storage, 0, items.length);
    queue.slots[1] = BigInt(capacity);
    return true;
  };
  const method = (
    name: string,
    args: Type[],
    result: Type,
    allocator: boolean,
    run: (frame: Frame, queue: ZStruct, values: Value[], allocator: AllocatorState | undefined) => Value
  ): (() => Member) =>
    fnMember(`PriorityQueue.${name}`, (sema, call) => {
      sema.resolveStorage(element, call.span);
      const expected = allocator ? [ALLOCATOR, ...args] : args;
      const compiled = compileArgs(sema, expectArgs(sema, call, expected.length, name), expected);
      const queue = structReceiver(sema, call, type, !['peek', 'count', 'capacity'].includes(name));
      return nativeStateCall(
        result,
        compiled,
        call.span,
        (frame) => ({ receiver: queue(frame) }),
        (state, values, frame) =>
          run(frame, state.receiver, values.slice(allocator ? 1 : 0), allocator ? allocatorState(values[0]) : undefined)
      );
    });
  const push = (
    frame: Frame,
    queue: ZStruct,
    values: Value[] | Slice,
    allocator: AllocatorState | undefined
  ): Value => {
    const items = queue.slots[0] as Slice;
    if (!reserve(frame, queue, items.length + values.length, allocator)) return ERROR_OUT_OF_MEMORY;
    for (let index = 0; index < values.length; index++) {
      const value = values instanceof Slice ? values.get(index) : values[index];
      const current = queue.slots[0] as Slice;
      const grown = new Slice(current.target, current.start, current.length + 1);
      store(frame, grown, current.length, value);
      queue.slots[0] = grown;
      siftUp(frame, queue, grown.length - 1);
    }
    return undefined;
  };
  const popIndex = (frame: Frame, queue: ZStruct, index: number): Value => {
    const items = queue.slots[0] as Slice;
    if (index >= items.length) indexOutOfBounds(index, items.length);
    const last = copyForFrame(frame, items.get(items.length - 1), element);
    const item = copyForFrame(frame, items.get(index), element);
    store(frame, items, index, last);
    const shrunk = new Slice(items.target, items.start, items.length - 1);
    queue.slots[0] = shrunk;
    return withHeldValues(frame, [item, last], () => {
      if (index === shrunk.length) return item;
      if (index === 0) {
        siftDown(frame, queue, index);
      } else {
        const parent = shrunk.get((index - 1) >> 1);
        if (order(frame, queue, last, parent) === ORDER_GT) siftDown(frame, queue, index);
        else siftUp(frame, queue, index);
      }
      return item;
    });
  };
  addMembers(type, {
    empty: () => ({ type, value: new ZStruct([new Slice(new ZArray([]), 0, 0), 0n, undefinedValue(context)]) }),
    initContext: fnMember('PriorityQueue.initContext', (sema, call) => {
      const [ctx] = compileArgs(sema, expectArgs(sema, call, 1, 'initContext'), [context]);
      return computed(type, [ctx], call.span, ([value]) => new ZStruct([new Slice(new ZArray([]), 0, 0), 0n, value]));
    }),
    deinit: method('deinit', [], VOID, true, (_, queue, _args, allocator) => {
      if ((queue.slots[1] as bigint) > 0n) freeMemory(allocator, (queue.slots[0] as Slice).target);
      queue.slots[0] = new Slice(new ZArray([]), 0, 0);
      queue.slots[1] = 0n;
      return;
    }),
    push: method('push', [element], errorUnionOf(ALLOCATOR_ERROR, VOID), true, (frame, queue, [value], allocator) =>
      push(frame, queue, [value], allocator)
    ),
    pushSlice: method(
      'pushSlice',
      [sliceOf(element, true)],
      errorUnionOf(ALLOCATOR_ERROR, VOID),
      true,
      (frame, queue, [values], allocator) => push(frame, queue, values as Slice, allocator)
    ),
    peek: method('peek', [], optionalOf(element), false, (frame, queue) => {
      const items = queue.slots[0] as Slice;
      return items.length > 0 ? optionalSome(copyForFrame(frame, items.get(0), element), element) : NULL;
    }),
    pop: method('pop', [], optionalOf(element), false, (frame, queue) =>
      (queue.slots[0] as Slice).length > 0 ? optionalSome(popIndex(frame, queue, 0), element) : NULL
    ),
    popIndex: method('popIndex', [USIZE], element, false, (frame, queue, [index]) =>
      popIndex(frame, queue, Number(index as bigint))
    ),
    count: method('count', [], USIZE, false, (_, queue) => BigInt((queue.slots[0] as Slice).length)),
    capacity: method('capacity', [], USIZE, false, (_, queue) => queue.slots[1]),
    clearRetainingCapacity: method('clearRetainingCapacity', [], VOID, false, (_, queue) => {
      const items = queue.slots[0] as Slice;
      queue.slots[0] = new Slice(items.target, items.start, 0);
      return;
    }),
  });
  return type;
}

let queueKeys = 0;
const compareKeys = new WeakMap<object, number>();

export const PRIORITY_QUEUE = fnMember('std.PriorityQueue', (sema, call) => {
  const [elementArg, contextArg, compareArg] = expectArgs(sema, call, 3, 'std.PriorityQueue');
  const element = sema.compileType(elementArg);
  const context = sema.compileType(contextArg);
  const compareExpression = sema.compile(compareArg);
  const compare = callbackFunction(sema, compareExpression, compareArg);
  checkCallback(sema, 'std.PriorityQueue', compare, [context, element, element], ORDER, compareArg);
  // The same function, named twice, gives the same queue type.
  const named = compareExpression.value as unknown;
  const identity = (
    named instanceof FnRef ? named.decl : named instanceof FnValue ? named.fn : compareExpression
  ) as object;
  let id = compareKeys.get(identity);
  if (id === undefined) {
    id = ++queueKeys;
    compareKeys.set(identity, id);
  }
  return known(
    TYPE,
    priorityQueueType(element, context, compare, `${typeId(element)} ${typeId(context)} ${id}`),
    call.span
  );
});

let unicode: StructType | undefined;
let meta: StructType | undefined;
let enums: StructType | undefined;

export function unicodeNamespace(): StructType {
  unicode ??= nativeStruct('std.unicode', UNICODE);
  return unicode;
}

export function metaNamespace(): StructType {
  meta ??= nativeStruct('std.meta', META);
  return meta;
}

export function enumsNamespace(): StructType {
  enums ??= nativeStruct('std.enums', ENUMS);
  return enums;
}

export { ALLOCATOR_ERROR, panic };
