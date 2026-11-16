import { allocationSlots } from '../allocation';
import { indexOutOfBounds, PANIC, panic } from '../arith';
import type { Span } from '../ast';
import { type Frame, withHeldValues } from '../runtime';
import {
  copyForStorage,
  evaluateHeld,
  FnRef,
  known,
  runtime,
  type SemaApi,
  type TExpr,
  undefinedValue,
} from '../semaBase';
import {
  BOOL,
  CONST_U8_SLICE,
  errorSetOf,
  errorUnionOf,
  intType,
  optionalOf,
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
import {
  ErrorValue,
  FnValue,
  NULL,
  optionalSome,
  type Pointer,
  Slice,
  Some,
  UNASSIGNED,
  type Value,
  ZArray,
  ZStruct,
  ZUnion,
} from '../values';
import { WeakValueMap } from '../weakValueMap';
import { computed, constSlice, elements, equalValues, mutableSlice, newSlice, storeSliceValue } from './common';
import { ALLOCATOR, ALLOCATOR_ERROR, ERROR_OUT_OF_MEMORY } from './heap';
import { addMembers, compileArgs, expectArgs, fnMember, type Member, nativeStruct } from './native';

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
// code-gauge-allow functionCognitiveComplexity 20 -- Transcribes the corresponding function of Zig's standard library or compiler step by step.
function decode(bytes: number[]): number | string {
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

function byteNumbers(value: Value): number[] {
  return elements(value).map((byte) => Number(byte as bigint));
}

function codepoints(bytes: number[]): number[] | string {
  const result: number[] = [];
  let index = 0;
  while (index < bytes.length) {
    const length = sequenceLength(bytes[index]);
    if (length === undefined) return 'Utf8InvalidStartByte';
    if (index + length > bytes.length) return 'TruncatedInput';
    const value = decode(bytes.slice(index, index + length));
    if (typeof value === 'string') return value;
    result.push(value);
    index += length;
  }
  return result;
}

const UTF8_ITERATOR: StructType = nativeStruct('unicode.Utf8Iterator', {}, [
  { name: 'bytes', type: CONST_U8_SLICE, hasDefault: false },
  { name: 'i', type: USIZE, hasDefault: false },
]);

const UTF8_VIEW: StructType = nativeStruct('unicode.Utf8View', {}, [
  { name: 'bytes', type: CONST_U8_SLICE, hasDefault: false },
]);

function iteratorState(sema: SemaApi, receiver: TExpr | undefined, span: Span): (frame: Frame) => ZStruct {
  if (!receiver) return sema.error(span, 'Utf8Iterator に対して呼び出してください。');
  let pointer = receiver;
  if (receiver.type === UTF8_ITERATOR) pointer = sema.addressOf(receiver);
  if (pointer.type.kind !== 'pointer' || pointer.type.child !== UTF8_ITERATOR || pointer.type.isConst) {
    return sema.error(span, 'Utf8Iterator は var で宣言してください。');
  }
  const evaluate = pointer.eval;
  return (frame) => (evaluate(frame) as Pointer).load() as ZStruct;
}

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
  nextCodepointSlice: fnMember('Utf8Iterator.nextCodepointSlice', (sema, call) => {
    expectArgs(sema, call, 0, 'nextCodepointSlice');
    const state = iteratorState(sema, call.receiver, call.span);
    return runtime(optionalOf(CONST_U8_SLICE), (frame) => nextSlice(state(frame)) ?? NULL, call.span);
  }),
  nextCodepoint: fnMember('Utf8Iterator.nextCodepoint', (sema, call) => {
    expectArgs(sema, call, 0, 'nextCodepoint');
    const state = iteratorState(sema, call.receiver, call.span);
    return runtime(
      optionalOf(U21),
      (frame) => {
        const slice = nextSlice(state(frame));
        if (!slice) return NULL;
        const value = decode(byteNumbers(slice));
        if (typeof value === 'string') panic(PANIC.unreachable);
        return BigInt(value);
      },
      call.span
    );
  }),
});

addMembers(UTF8_VIEW, {
  init: fnMember('Utf8View.init', (sema, call) => {
    const [text] = compileArgs(sema, expectArgs(sema, call, 1, 'Utf8View.init'), [CONST_U8_SLICE]);
    return computed(errorUnionOf(errorSetOf(['InvalidUtf8']), UTF8_VIEW), [text], call.span, ([value]) =>
      typeof codepoints(byteNumbers(value)) === 'string' ? ErrorValue.of('InvalidUtf8') : new ZStruct([value])
    );
  }),
  initUnchecked: fnMember('Utf8View.initUnchecked', (sema, call) => {
    const [text] = compileArgs(sema, expectArgs(sema, call, 1, 'Utf8View.initUnchecked'), [CONST_U8_SLICE]);
    return computed(UTF8_VIEW, [text], call.span, ([value]) => new ZStruct([value]));
  }),
  iterator: fnMember('Utf8View.iterator', (sema, call) => {
    expectArgs(sema, call, 0, 'iterator');
    const receiver = call.receiver;
    if (!receiver) return sema.error(call.span, 'Utf8View に対して呼び出してください。');
    const evaluate = receiver.eval;
    const viaPointer = receiver.type.kind === 'pointer';
    return runtime(
      UTF8_ITERATOR,
      (frame) => {
        const value = evaluate(frame);
        const view = (viaPointer ? (value as Pointer).load() : value) as ZStruct;
        return new ZStruct([view.slots[0], 0n]);
      },
      call.span
    );
  }),
});

const UNICODE: Record<string, () => Member> = {
  Utf8View: () => ({ type: TYPE, value: UTF8_VIEW }),
  Utf8Iterator: () => ({ type: TYPE, value: UTF8_ITERATOR }),
  replacement_character: () => ({ type: U21, value: 0xff_fdn }),
  utf8ByteSequenceLength: fnMember('std.unicode.utf8ByteSequenceLength', (sema, call) => {
    const [first] = compileArgs(sema, expectArgs(sema, call, 1, 'utf8ByteSequenceLength'), [U8]);
    return computed(errorUnionOf(errorSetOf(['Utf8InvalidStartByte']), U3), [first], call.span, ([value]) => {
      const length = sequenceLength(Number(value as bigint));
      return length === undefined ? ErrorValue.of('Utf8InvalidStartByte') : BigInt(length);
    });
  }),
  utf8CodepointSequenceLength: fnMember('std.unicode.utf8CodepointSequenceLength', (sema, call) => {
    const [c] = compileArgs(sema, expectArgs(sema, call, 1, 'utf8CodepointSequenceLength'), [U21]);
    return computed(errorUnionOf(errorSetOf(['CodepointTooLarge']), U3), [c], call.span, ([value]) => {
      const n = value as bigint;
      if (n < 0x80n) return 1n;
      if (n < 0x8_00n) return 2n;
      if (n < 0x1_00_00n) return 3n;
      if (n < 0x11_00_00n) return 4n;
      return ErrorValue.of('CodepointTooLarge');
    });
  }),
  utf8Encode: fnMember('std.unicode.utf8Encode', (sema, call) => {
    const [cArg, outArg] = expectArgs(sema, call, 2, 'utf8Encode');
    const [c] = compileArgs(sema, [cArg], [U21]);
    const out = mutableSlice(sema, outArg, U8);
    const errors = errorSetOf(['Utf8CannotEncodeSurrogateHalf', 'CodepointTooLarge']);
    return computed(errorUnionOf(errors, U3), [c, out], call.span, ([value, target]) => {
      const n = Number(value as bigint);
      if (n >= 0xd8_00 && n <= 0xdf_ff) return ErrorValue.of('Utf8CannotEncodeSurrogateHalf');
      if (n > 0x10_ff_ff) return ErrorValue.of('CodepointTooLarge');
      const bytes = [...new TextEncoder().encode(String.fromCodePoint(n))];
      const slice = target as Slice;
      if (bytes.length > slice.length) indexOutOfBounds(bytes.length - 1, slice.length);
      for (const [index, byte] of bytes.entries()) slice.set(index, BigInt(byte));
      return BigInt(bytes.length);
    });
  }),
  utf8Decode: fnMember('std.unicode.utf8Decode', (sema, call) => {
    const [bytesArg] = expectArgs(sema, call, 1, 'utf8Decode');
    const bytes = constSlice(sema, bytesArg, U8);
    const errors = errorSetOf(UTF8_DECODE_ERRORS);
    return computed(errorUnionOf(errors, U21), [bytes], call.span, ([value]) => {
      const result = decode(byteNumbers(value));
      return typeof result === 'string' ? ErrorValue.of(result) : BigInt(result);
    });
  }),
  utf8ValidCodepoint: fnMember('std.unicode.utf8ValidCodepoint', (sema, call) => {
    const [arg] = compileArgs(sema, expectArgs(sema, call, 1, 'utf8ValidCodepoint'), [intType(false, 21)]);
    return computed(BOOL, [arg], call.span, ([value]) => {
      const codePoint = value as bigint;
      return codePoint <= 0x10_ff_ffn && !(codePoint >= 0xd8_00n && codePoint <= 0xdf_ffn);
    });
  }),
  utf8CountCodepoints: fnMember('std.unicode.utf8CountCodepoints', (sema, call) => {
    const [textArg] = expectArgs(sema, call, 1, 'utf8CountCodepoints');
    const text = constSlice(sema, textArg, U8);
    return computed(
      errorUnionOf(errorSetOf(['Utf8InvalidStartByte', 'TruncatedInput', ...UTF8_DECODE_ERRORS]), USIZE),
      [text],
      call.span,
      ([value]) => {
        const points = codepoints(byteNumbers(value));
        return typeof points === 'string' ? ErrorValue.of(points) : BigInt(points.length);
      }
    );
  }),
  utf8ValidateSlice: fnMember('std.unicode.utf8ValidateSlice', (sema, call) => {
    const [textArg] = expectArgs(sema, call, 1, 'utf8ValidateSlice');
    const text = constSlice(sema, textArg, U8);
    return computed(BOOL, [text], call.span, ([value]) => typeof codepoints(byteNumbers(value)) !== 'string');
  }),
};

// std.meta and std.enums ------------------------------------------------------------------------------------------------

/** `std.meta.eql`: equality by value, through arrays, structs, unions, and optionals but not pointers. */
function deepEqual(a: Value, b: Value): boolean {
  if (a instanceof ZArray && b instanceof ZArray)
    return a.values().every((value, index) => deepEqual(value, b.get(index)));
  if (a instanceof ZStruct && b instanceof ZStruct)
    return a.slots.every((value, index) => deepEqual(value, b.slots[index]));
  if (a instanceof ZUnion && b instanceof ZUnion) return a.tag === b.tag && deepEqual(a.slots[0], b.slots[0]);
  if (a instanceof Some && b instanceof Some) return deepEqual(a.value, b.value);
  if (a instanceof Slice && b instanceof Slice)
    return a.target === b.target && a.start === b.start && a.length === b.length;
  return equalValues(a, b);
}

const META: Record<string, () => Member> = {
  eql: fnMember('std.meta.eql', (sema, call) => {
    const [aArg, bArg] = expectArgs(sema, call, 2, 'std.meta.eql');
    const a = sema.compile(aArg);
    const b = sema.coerce(sema.compile(bArg, a.type), a.type, bArg);
    return computed(BOOL, [a, b], call.span, ([x, y]) => deepEqual(x, y));
  }),
  stringToEnum: fnMember('std.meta.stringToEnum', (sema, call) => {
    const [typeArg, textArg] = expectArgs(sema, call, 2, 'std.meta.stringToEnum');
    const type = sema.compileType(typeArg);
    if (type.kind !== 'enum')
      return sema.error(typeArg, `stringToEnum には enum の型を渡してください（${typeName(type)} です）。`);
    const fields = sema.enumFields(type);
    const text = constSlice(sema, textArg, U8);
    return computed(optionalOf(type), [text], call.span, ([value]) => {
      const name = new TextDecoder().decode(new Uint8Array(byteNumbers(value)));
      return fields.find((field) => field.name === name)?.value ?? NULL;
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
    const fields = sema.enumFields(type);
    const value = sema.coerce(sema.compile(valueArg, type), type, valueArg);
    return computed(optionalOf(CONST_U8_SLICE), [value], call.span, ([tag]) => {
      const field = fields.find((each) => each.value === tag);
      if (!field) return NULL;
      return newSlice([...new TextEncoder().encode(field.name)].map(BigInt));
    });
  }),
  fromInt: fnMember('std.enums.fromInt', (sema, call) => {
    const [typeArg, valueArg] = expectArgs(sema, call, 2, 'std.enums.fromInt');
    const type = sema.compileType(typeArg);
    if (type.kind !== 'enum') return sema.error(typeArg, 'fromInt には enum の型を渡してください。');
    const fields = sema.enumFields(type);
    const value = sema.compile(valueArg);
    return computed(
      optionalOf(type),
      [value],
      call.span,
      ([n]) => fields.find((field) => field.value === n)?.value ?? NULL
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
  const order = (frame: Frame, queue: ZStruct, a: Value, b: Value): bigint =>
    compare.call(frame, [queue.slots[2], a, b]) as bigint;
  const siftUp = (frame: Frame, queue: ZStruct, start: number): void => {
    const items = queue.slots[0] as Slice;
    const child = copyForStorage(items.get(start));
    let index = start;
    while (index > 0) {
      const parentIndex = (index - 1) >> 1;
      const parent = items.get(parentIndex);
      if (order(frame, queue, child, parent) !== 0n) break;
      storeSliceValue(items, index, parent);
      index = parentIndex;
    }
    storeSliceValue(items, index, child);
  };
  const siftDown = (frame: Frame, queue: ZStruct, target: number): void => {
    const items = queue.slots[0] as Slice;
    const element = copyForStorage(items.get(target));
    let index = target;
    for (;;) {
      let lesser = index * 2 + 1;
      if (lesser >= items.length) break;
      const next = lesser + 1;
      if (next < items.length && order(frame, queue, items.get(next), items.get(lesser)) === 0n) lesser = next;
      if (order(frame, queue, element, items.get(lesser)) === 0n) break;
      storeSliceValue(items, index, items.get(lesser));
      index = lesser;
    }
    storeSliceValue(items, index, element);
  };
  const reserve = (frame: Frame, queue: ZStruct, wanted: number): boolean => {
    let capacity = Number(queue.slots[1] as bigint);
    if (capacity >= wanted) return true;
    while (capacity < wanted) capacity += Math.floor(capacity / 2) + 8;
    if (!frame.runtime.canAllocate(allocationSlots(capacity, element))) return false;
    frame.runtime.allocate(allocationSlots(capacity, element));
    const items = queue.slots[0] as Slice;
    const values = items.values();
    while (values.length < capacity) values.push(undefinedValue(element));
    queue.slots[0] = new Slice(new ZArray(values, 0, capacity), 0, items.length);
    queue.slots[1] = BigInt(capacity);
    return true;
  };
  const method = (
    name: string,
    args: Type[],
    result: Type,
    allocator: boolean,
    run: (frame: Frame, queue: ZStruct, values: Value[]) => Value
  ): (() => Member) =>
    fnMember(`PriorityQueue.${name}`, (sema, call) => {
      sema.resolveStorage(element, call.span);
      const expected = allocator ? [ALLOCATOR, ...args] : args;
      const compiled = compileArgs(sema, expectArgs(sema, call, expected.length, name), expected);
      const queue = queueState(sema, call.receiver, type, call.span);
      const evaluators = compiled.map((arg) => arg.eval);
      return runtime(
        result,
        (frame) => {
          frame.runtime.spend();
          const received = queue(frame);
          const values = evaluateHeld(frame, evaluators);
          return withHeldValues(frame, values, () => run(frame, received, values.slice(allocator ? 1 : 0)));
        },
        call.span
      );
    });
  const push = (frame: Frame, queue: ZStruct, values: Value[]): Value => {
    const items = queue.slots[0] as Slice;
    if (!reserve(frame, queue, items.length + values.length)) return ERROR_OUT_OF_MEMORY;
    for (const value of values) {
      const current = queue.slots[0] as Slice;
      const grown = new Slice(current.target, current.start, current.length + 1);
      grown.set(current.length, copyForStorage(value));
      queue.slots[0] = grown;
      siftUp(frame, queue, grown.length - 1);
    }
    return undefined;
  };
  const popIndex = (frame: Frame, queue: ZStruct, index: number): Value => {
    const items = queue.slots[0] as Slice;
    if (index >= items.length) indexOutOfBounds(index, items.length);
    const last = copyForStorage(items.get(items.length - 1));
    const item = copyForStorage(items.get(index));
    storeSliceValue(items, index, last);
    const shrunk = new Slice(items.target, items.start, items.length - 1);
    queue.slots[0] = shrunk;
    items.target.slots[items.start + shrunk.length] = UNASSIGNED;
    return withHeldValues(frame, [item, last], () => {
      if (index === shrunk.length) return item;
      if (index === 0) {
        siftDown(frame, queue, index);
      } else {
        const parent = shrunk.get((index - 1) >> 1);
        if (order(frame, queue, last, parent) === 2n) siftDown(frame, queue, index);
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
    deinit: method('deinit', [], VOID, true, (_, queue) => {
      queue.slots[0] = new Slice(new ZArray([]), 0, 0);
      queue.slots[1] = 0n;
      return;
    }),
    push: method('push', [element], errorUnionOf(ALLOCATOR_ERROR, VOID), true, (frame, queue, [value]) =>
      push(frame, queue, [value])
    ),
    add: method('add', [element], errorUnionOf(ALLOCATOR_ERROR, VOID), true, (frame, queue, [value]) =>
      push(frame, queue, [value])
    ),
    pushSlice: method(
      'pushSlice',
      [sliceOf(element, true)],
      errorUnionOf(ALLOCATOR_ERROR, VOID),
      true,
      (frame, queue, [values]) => push(frame, queue, elements(values))
    ),
    peek: method('peek', [], optionalOf(element), false, (_, queue) => {
      const items = queue.slots[0] as Slice;
      return items.length > 0 ? optionalSome(items.get(0), element) : NULL;
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
      for (let index = 0; index < items.length; index++) items.target.slots[items.start + index] = UNASSIGNED;
      queue.slots[0] = new Slice(items.target, items.start, 0);
      return;
    }),
  });
  return type;
}

function queueState(
  sema: SemaApi,
  receiver: TExpr | undefined,
  type: StructType,
  span: Span
): (frame: Frame) => ZStruct {
  if (!receiver) return sema.error(span, 'PriorityQueue に対して呼び出してください。');
  let pointer = receiver;
  if (receiver.type === type) pointer = sema.addressOf(receiver);
  if (pointer.type.kind !== 'pointer' || pointer.type.child !== type)
    return sema.error(span, 'PriorityQueue に対して呼び出してください。');
  const evaluate = pointer.eval;
  return (frame) => (evaluate(frame) as Pointer).load() as ZStruct;
}

let queueKeys = 0;
const compareKeys = new WeakMap<object, number>();

export const PRIORITY_QUEUE = fnMember('std.PriorityQueue', (sema, call) => {
  const [elementArg, contextArg, compareArg] = expectArgs(sema, call, 3, 'std.PriorityQueue');
  const element = sema.compileType(elementArg);
  const context = sema.compileType(contextArg);
  const compareExpression = sema.compile(compareArg);
  const compare = sema.functionOf(compareExpression, compareArg);
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
