import { indexOutOfBounds, PANIC, panic } from '../arith';
import type { Span } from '../ast';
import { sizeOf } from '../layout';
import type { Frame } from '../runtime';
import { copyForStorage, known, runtime, type SemaApi, type TExpr, undefinedValue } from '../semaBase';
import {
  errorUnionOf,
  optionalOf,
  pointerTo,
  sliceOf,
  type StructType,
  TYPE,
  type Type,
  typeName,
  U8,
  USIZE,
  VOID,
} from '../types';
import { NULL, Pointer, Slice, type Value, ZArray, ZStruct } from '../values';
import { constSlice, elements } from './common';
import { ALLOCATOR, ALLOCATOR_ERROR, ERROR_OUT_OF_MEMORY, nativeEnum } from './heap';
import { compileArgs, expectArgs, fnMember, type Member, nativeStruct } from './native';
import { compilePrint } from './print';

const SAFETY_STATE = nativeEnum('debug.SafetyLock.State', ['unlocked', 'locked']);
const SAFETY_LOCK = nativeStruct('debug.SafetyLock', {}, [
  { name: 'state', type: SAFETY_STATE, hasDefault: true, defaultValue: 0n },
]);

/** The cache line of the reference toolchain's CPU (aarch64), which sets the first capacity. */
const CACHE_LINE = 128;

const listTypes = new Map<Type, StructType>();

/** `std.ArrayList(T)`: a struct with Zig's fields, so that it prints and copies as Zig's does. */
export function arrayListType(child: Type): StructType {
  const existing = listTypes.get(child);
  if (existing) return existing;
  const type = nativeStruct(
    `array_list.Aligned(${typeName(child)},null)`,
    {},
    [
      { name: 'items', type: sliceOf(child, false), hasDefault: false },
      { name: 'capacity', type: USIZE, hasDefault: false },
      {
        name: 'pointer_stability',
        type: SAFETY_LOCK,
        hasDefault: true,
        defaultValue: new ZStruct([0n]),
      },
    ],
    { kind: 'arrayList', args: [child] }
  );
  listTypes.set(child, type);
  defineMembers(type, child);
  return type;
}

function emptyList(): ZStruct {
  return new ZStruct([new Slice(new ZArray([]), 0, 0), 0n, new ZStruct([0n])]);
}

interface List {
  struct: ZStruct;
  items: Slice;
  capacity: number;
}

function listOf(struct: ZStruct): List {
  return { struct, items: struct.slots[0] as Slice, capacity: Number(struct.slots[1] as bigint) };
}

/** `growCapacity`: the capacity a list grows to when it needs `minimum`. */
function growCapacity(minimum: number, child: Type): number {
  const size = sizeOf(child);
  const initial = Math.max(1, Math.floor(CACHE_LINE / Math.max(size, 1)));
  return minimum + Math.floor(minimum / 2) + initial;
}

/** Gives the list exactly `capacity` slots, copying its items to new storage; false when memory runs out. */
function reallocate(frame: Frame, list: List, capacity: number, child: Type): boolean {
  if (!frame.runtime.canAllocate(capacity)) return false;
  frame.runtime.allocate(capacity);
  const values = list.items.values();
  for (let index = values.length; index < capacity; index++) values.push(undefinedValue(child));
  list.struct.slots[0] = new Slice(new ZArray(values, 0, capacity), 0, list.items.length);
  list.struct.slots[1] = BigInt(capacity);
  list.items = list.struct.slots[0] as Slice;
  list.capacity = capacity;
  return true;
}

function ensureTotalCapacity(frame: Frame, list: List, capacity: number, child: Type): boolean {
  if (list.capacity >= capacity) return true;
  return reallocate(frame, list, growCapacity(capacity, child), child);
}

function setLength(list: List, length: number): void {
  list.struct.slots[0] = new Slice(list.items.target, list.items.start, length);
  list.items = list.struct.slots[0] as Slice;
}

// code-gauge-allow functionCognitiveComplexity 30 -- Defines each method of Zig's ArrayList.
// code-gauge-allow functionNcss 150 -- Defines each method of Zig's ArrayList.
function defineMembers(type: StructType, child: Type): void {
  const items = sliceOf(child, false);
  const constItems = sliceOf(child, true);
  const method = (
    name: string,
    options: { args: Type[]; result: Type; byValue?: boolean; allocator?: boolean },
    run: (list: List, args: Value[], frame: Frame) => Value
  ): (() => Member) =>
    fnMember(`ArrayList.${name}`, (sema, call) => {
      const expected = options.allocator ? [ALLOCATOR, ...options.args] : options.args;
      const args = compileArgs(sema, expectArgs(sema, call, expected.length, name), expected);
      const list = receiverOf(sema, call.receiver, type, call.span, options.byValue !== true);
      const evaluators = args.slice(options.allocator ? 1 : 0).map((arg) => arg.eval);
      return runtime(
        options.result,
        (frame) => {
          frame.runtime.spend();
          return run(
            listOf(list(frame)),
            evaluators.map((evaluate) => evaluate(frame)),
            frame
          );
        },
        call.span
      );
    });
  const insertValues = (frame: Frame, list: List, index: number, values: Value[]): Value => {
    if (index > list.items.length) indexOutOfBounds(index, list.items.length + 1);
    if (!ensureTotalCapacity(frame, list, list.items.length + values.length, child)) return ERROR_OUT_OF_MEMORY;
    const current = list.items.values();
    current.splice(index, 0, ...values.map((value) => copyForStorage(value)));
    for (const [position, value] of current.entries()) list.items.target.slots[list.items.start + position] = value;
    setLength(list, current.length);
    return undefined;
  };
  const members: Record<string, () => Member> = {
    Slice: () => ({ type: TYPE, value: items }),
    empty: () => ({ type, value: emptyList() }),
    initCapacity: fnMember('ArrayList.initCapacity', (sema, call) => {
      const [, count] = compileArgs(sema, expectArgs(sema, call, 2, 'initCapacity'), [ALLOCATOR, USIZE]);
      const evaluate = count.eval;
      return runtime(
        allocating(type),
        (frame) => {
          const list = listOf(emptyList());
          if (!reallocate(frame, list, Number(evaluate(frame) as bigint), child)) return ERROR_OUT_OF_MEMORY;
          return list.struct;
        },
        call.span
      );
    }),
    fromOwnedSlice: fnMember('ArrayList.fromOwnedSlice', (sema, call) => {
      const [slice] = compileArgs(sema, expectArgs(sema, call, 1, 'fromOwnedSlice'), [items]);
      return runtime(
        type,
        (frame) => {
          const value = slice.eval(frame) as Slice;
          return new ZStruct([value, BigInt(value.length), new ZStruct([0n])]);
        },
        call.span
      );
    }),
    deinit: method('deinit', { args: [], result: VOID, allocator: true }, (list) => {
      list.struct.slots[0] = new Slice(new ZArray([]), 0, 0);
      list.struct.slots[1] = 0n;
      return;
    }),
    append: method('append', { args: [child], result: allocating(VOID), allocator: true }, (list, [item], frame) => {
      if (!ensureTotalCapacity(frame, list, list.items.length + 1, child)) return ERROR_OUT_OF_MEMORY;
      list.items.target.slots[list.items.start + list.items.length] = copyForStorage(item);
      setLength(list, list.items.length + 1);
      return;
    }),
    appendAssumeCapacity: method('appendAssumeCapacity', { args: [child], result: VOID }, (list, [item]) => {
      if (list.items.length >= list.capacity) panic(PANIC.unreachable);
      list.items.target.slots[list.items.start + list.items.length] = copyForStorage(item);
      setLength(list, list.items.length + 1);
      return;
    }),
    appendSlice: method(
      'appendSlice',
      { args: [constItems], result: allocating(VOID), allocator: true },
      (list, [slice], frame) => insertValues(frame, list, list.items.length, elements(slice))
    ),
    appendNTimes: method(
      'appendNTimes',
      { args: [child, USIZE], result: allocating(VOID), allocator: true },
      (list, [value, count], frame) =>
        insertValues(
          frame,
          list,
          list.items.length,
          Array.from({ length: Number(count as bigint) }, () => value)
        )
    ),
    insert: method(
      'insert',
      { args: [USIZE, child], result: allocating(VOID), allocator: true },
      (list, [index, item], frame) => insertValues(frame, list, Number(index as bigint), [item])
    ),
    insertSlice: method(
      'insertSlice',
      { args: [USIZE, constItems], result: allocating(VOID), allocator: true },
      (list, [index, slice], frame) => insertValues(frame, list, Number(index as bigint), elements(slice))
    ),
    orderedRemove: method('orderedRemove', { args: [USIZE], result: child }, (list, [index]) => {
      const position = Number(index as bigint);
      if (position >= list.items.length) indexOutOfBounds(position, list.items.length);
      const values = list.items.values();
      const [removed] = values.splice(position, 1);
      for (const [at, value] of values.entries()) list.items.set(at, value);
      setLength(list, values.length);
      return removed;
    }),
    swapRemove: method('swapRemove', { args: [USIZE], result: child }, (list, [index]) => {
      const position = Number(index as bigint);
      if (position >= list.items.length) indexOutOfBounds(position, list.items.length);
      const removed = list.items.get(position);
      list.items.set(position, list.items.get(list.items.length - 1));
      setLength(list, list.items.length - 1);
      return removed;
    }),
    pop: method('pop', { args: [], result: optionalOf(child) }, (list) => {
      if (list.items.length === 0) return NULL;
      const value = list.items.get(list.items.length - 1);
      setLength(list, list.items.length - 1);
      return value;
    }),
    getLast: method('getLast', { args: [], result: child, byValue: true }, (list) => {
      if (list.items.length === 0) panic(PANIC.overflow);
      return list.items.get(list.items.length - 1);
    }),
    getLastOrNull: method('getLastOrNull', { args: [], result: optionalOf(child), byValue: true }, (list) =>
      list.items.length === 0 ? NULL : list.items.get(list.items.length - 1)
    ),
    last: method('last', { args: [], result: optionalOf(child), byValue: true }, (list) =>
      list.items.length === 0 ? NULL : list.items.get(list.items.length - 1)
    ),
    clearRetainingCapacity: method('clearRetainingCapacity', { args: [], result: VOID }, (list) => {
      setLength(list, 0);
      return;
    }),
    clearAndFree: method('clearAndFree', { args: [], result: VOID, allocator: true }, (list) => {
      list.struct.slots[0] = new Slice(new ZArray([]), 0, 0);
      list.struct.slots[1] = 0n;
      return;
    }),
    shrinkRetainingCapacity: method('shrinkRetainingCapacity', { args: [USIZE], result: VOID }, (list, [length]) => {
      if (Number(length as bigint) > list.items.length) panic(PANIC.unreachable);
      setLength(list, Number(length as bigint));
      return;
    }),
    resize: method('resize', { args: [USIZE], result: allocating(VOID), allocator: true }, (list, [length], frame) => {
      const size = Number(length as bigint);
      if (!ensureTotalCapacity(frame, list, size, child)) return ERROR_OUT_OF_MEMORY;
      setLength(list, size);
      return;
    }),
    ensureTotalCapacity: method(
      'ensureTotalCapacity',
      { args: [USIZE], result: allocating(VOID), allocator: true },
      (list, [capacity], frame) =>
        ensureTotalCapacity(frame, list, Number(capacity as bigint), child) ? undefined : ERROR_OUT_OF_MEMORY
    ),
    ensureTotalCapacityPrecise: method(
      'ensureTotalCapacityPrecise',
      { args: [USIZE], result: allocating(VOID), allocator: true },
      (list, [capacity], frame) => {
        const size = Number(capacity as bigint);
        if (list.capacity >= size) return;
        return reallocate(frame, list, size, child) ? undefined : ERROR_OUT_OF_MEMORY;
      }
    ),
    ensureUnusedCapacity: method(
      'ensureUnusedCapacity',
      { args: [USIZE], result: allocating(VOID), allocator: true },
      (list, [count], frame) =>
        ensureTotalCapacity(frame, list, list.items.length + Number(count as bigint), child)
          ? undefined
          : ERROR_OUT_OF_MEMORY
    ),
    addOne: method(
      'addOne',
      { args: [], result: allocating(pointerTo(child, false)), allocator: true },
      (list, _, frame) => {
        if (!ensureTotalCapacity(frame, list, list.items.length + 1, child)) return ERROR_OUT_OF_MEMORY;
        setLength(list, list.items.length + 1);
        return new Pointer(list.items.target, list.items.start + list.items.length - 1);
      }
    ),
    toOwnedSlice: method('toOwnedSlice', { args: [], result: allocating(items), allocator: true }, (list) => {
      const values = list.items.values();
      list.struct.slots[0] = new Slice(new ZArray([]), 0, 0);
      list.struct.slots[1] = 0n;
      return new Slice(new ZArray(values, 0, values.length), 0, values.length);
    }),
    clone: method('clone', { args: [], result: allocating(type), byValue: true, allocator: true }, (list, _, frame) => {
      const copy = listOf(
        new ZStruct([new Slice(new ZArray(list.items.values()), 0, list.items.length), 0n, new ZStruct([0n])])
      );
      if (!reallocate(frame, copy, list.capacity, child)) return ERROR_OUT_OF_MEMORY;
      return copy.struct;
    }),
    allocatedSlice: method(
      'allocatedSlice',
      { args: [], result: items, byValue: true },
      (list) => new Slice(list.items.target, list.items.start, list.capacity)
    ),
    expandToCapacity: method('expandToCapacity', { args: [], result: VOID }, (list) => {
      setLength(list, list.capacity);
      return;
    }),
    replaceRange: method(
      'replaceRange',
      { args: [USIZE, USIZE, constItems], result: allocating(VOID), allocator: true },
      (list, [start, length, slice], frame) => {
        const from = Number(start as bigint);
        const count = Number(length as bigint);
        const values = list.items.values();
        if (from + count > values.length) indexOutOfBounds(from + count, values.length);
        values.splice(from, count, ...elements(slice));
        if (!ensureTotalCapacity(frame, list, values.length, child)) return ERROR_OUT_OF_MEMORY;
        for (const [position, value] of values.entries()) list.items.target.slots[list.items.start + position] = value;
        setLength(list, values.length);
        return;
      }
    ),
  };
  if (child === U8) {
    members.print = fnMember('ArrayList.print', (sema, call) => {
      const [allocatorArg, format, args] = expectArgs(sema, call, 3, 'print');
      compileArgs(sema, [allocatorArg], [ALLOCATOR]);
      const list = receiverOf(sema, call.receiver, type, call.span, true);
      const print = compilePrint(sema, format, args, call.span);
      return runtime(
        allocating(VOID),
        (frame) => {
          const bytes = print(frame).map(BigInt);
          return insertValues(frame, listOf(list(frame)), listOf(list(frame)).items.length, bytes);
        },
        call.span
      );
    });
  }
  for (const [name, resolve] of Object.entries(members)) {
    let resolved: Member | undefined;
    type.namespace.decls.set(name, {
      kind: 'native',
      name,
      resolve: () => {
        resolved ??= resolve();
        return resolved;
      },
    });
  }
}

function allocating(result: Type): Type {
  return errorUnionOf(ALLOCATOR_ERROR, result);
}

/** The list a method is called on: through its address, which methods that change it need. */
function receiverOf(
  sema: SemaApi,
  receiver: TExpr | undefined,
  type: StructType,
  span: Span,
  mutable: boolean
): (frame: Frame) => ZStruct {
  if (!receiver) return sema.error(span, 'ArrayList の値に対して呼び出してください。');
  const evaluate = receiver.eval;
  if (receiver.type.kind === 'pointer' && receiver.type.child === type) {
    if (mutable && receiver.type.isConst)
      sema.error(span, '定数の ArrayList は変更できません（var で宣言してください）。');
    return (frame) => (evaluate(frame) as Pointer).load() as ZStruct;
  }
  if (receiver.type !== type) return sema.error(span, 'ArrayList の値に対して呼び出してください。');
  if (mutable) {
    const address = sema.addressOf(receiver);
    if (address.type.kind === 'pointer' && address.type.isConst) {
      sema.error(span, '定数の ArrayList は変更できません（var で宣言してください）。');
    }
    const locate = address.eval;
    return (frame) => (locate(frame) as Pointer).load() as ZStruct;
  }
  return (frame) => evaluate(frame) as ZStruct;
}

export function arrayListFactory(): () => Member {
  return fnMember('std.ArrayList', (sema, call) => {
    const [typeArg] = expectArgs(sema, call, 1, 'std.ArrayList');
    return known(TYPE, arrayListType(sema.compileType(typeArg)), call.span);
  });
}

export { constSlice };
