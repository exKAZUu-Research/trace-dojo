import { allocationSlots } from '../allocation';
import { indexOutOfBounds, PANIC, panic } from '../arith';
import type { Span } from '../ast';
import { sizeOf } from '../layout';
import { type Frame, withHeldValues } from '../runtime';
import { copyForFrame, copyForStorage, known, runtime, type SemaApi, type TExpr, undefinedValue } from '../semaBase';
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
import {
  NativeHandle,
  NULL,
  optionalSome,
  Pointer,
  registerStorageLocation,
  Slice,
  type Slots,
  storageLocation,
  storeInto,
  type Value,
  ZArray,
  ZStruct,
} from '../values';
import { constSlice, elements } from './common';
import {
  ALLOCATOR,
  ALLOCATOR_ERROR,
  type AllocatorState,
  allocatorState,
  ERROR_OUT_OF_MEMORY,
  freeMemory,
  nativeEnum,
  reserveNativeAllocation,
} from './heap';
import { addMembers, compileArgs, expectArgs, fnMember, type Member, nativeStateCall, nativeStruct } from './native';
import { compilePrint, PrintWriteError } from './print';
import type { WriterState } from './writer';

const SAFETY_STATE = nativeEnum('debug.SafetyLock.State', ['unlocked', 'locked']);
const SAFETY_LOCK = nativeStruct('debug.SafetyLock', {}, [
  { name: 'state', type: SAFETY_STATE, hasDefault: true, defaultValue: 0n },
]);

/** The cache line of the reference toolchain's CPU (aarch64), which sets the first capacity. */
const CACHE_LINE = 128;

const MAX_CAPACITY = (1n << 64n) - 1n;
const zeroExtents = new WeakMap<object, number>();

const listTypes = new WeakMap<Type, StructType>();

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
  child: Type;
  struct: ZStruct;
  items: Slice;
  capacity: number;
  /** The allocator a method received, which accounts for the list's memory. */
  allocator?: AllocatorState;
}

function listOf(struct: ZStruct, child: Type): List {
  return { child, struct, items: struct.slots[0] as Slice, capacity: Number(struct.slots[1] as bigint) };
}

/** `growCapacity`: the capacity a list grows to when it needs `minimum`. */
function growCapacity(minimum: number, child: Type): number {
  const size = sizeOf(child);
  const initial = Math.max(1, Math.floor(CACHE_LINE / Math.max(size, 1)));
  return minimum + Math.floor(minimum / 2) + initial;
}

/** Gives the list exactly `capacity` slots, copying its items to new storage; false when memory runs out. */
function reallocate(frame: Frame, list: List, capacity: number, child: Type): boolean {
  if (sizeOf(child) === 0) {
    list.struct.slots[1] = MAX_CAPACITY;
    list.capacity = Number(MAX_CAPACITY);
    if (!zeroExtents.has(list.items.target)) zeroExtents.set(list.items.target, list.items.target.slots.length);
    return true;
  }
  const previous = list.capacity > 0 ? list.items.target : undefined;
  const complete = reserveNativeAllocation(frame, list.allocator, capacity, child, previous);
  if (!complete) return false;
  const values = list.items.values().map(copyForStorage);
  for (let index = values.length; index < capacity; index++) values.push(undefinedValue(child));
  const storage = new ZArray(values, 0, capacity);
  complete(storage, list.items.length);
  list.struct.slots[0] = new Slice(storage, 0, list.items.length);
  list.struct.slots[1] = BigInt(capacity);
  list.items = list.struct.slots[0] as Slice;
  list.capacity = capacity;
  return true;
}

function freeList(list: List): void {
  if (list.capacity > 0) freeMemory(list.allocator, list.items.target);
  list.struct.slots[0] = new Slice(new ZArray([]), 0, 0);
  list.struct.slots[1] = 0n;
}

function ensureTotalCapacity(frame: Frame, list: List, capacity: number, child: Type): boolean {
  if (list.capacity >= capacity) return true;
  return reallocate(frame, list, growCapacity(capacity, child), child);
}

function materializeLength(frame: Frame, list: List, length: number): void {
  if (sizeOf(list.child) !== 0) return;
  const target = list.items.target;
  const previous = zeroExtents.get(target) ?? target.slots.length;
  const needed = list.items.start + length;
  if (needed <= previous) return;
  frame.runtime.reserveStorage(allocationSlots(needed - previous, list.child));
  zeroExtents.set(target, needed);
  for (let index = target.slots.length; index < needed; index++) target.slots.push(undefinedValue(list.child));
}

function setLength(list: List, length: number, frame: Frame): void {
  materializeLength(frame, list, length);
  for (let index = length; index < list.items.length; index++)
    list.items.target.slots[list.items.start + index] = undefinedValue(list.child);
  list.struct.slots[0] = new Slice(list.items.target, list.items.start, length);
  list.items = list.struct.slots[0] as Slice;
}

function capacitySlice(list: List, unused: boolean): Slice {
  const start = unused ? list.items.length : 0;
  const length = (list.struct.slots[1] as bigint) - BigInt(start);
  if (sizeOf(list.child) !== 0) return new Slice(list.items.target, list.items.start + start, length);
  const storage: Slots = {
    slots: new Proxy<Value[]>([], {
      get: (target, key, receiver) =>
        typeof key === 'string' && /^\d+$/.test(key) ? undefinedValue(list.child) : Reflect.get(target, key, receiver),
      set: () => true,
    }),
  };
  registerStorageLocation(storage.slots, () => storageLocation(list.items.target.slots, list.items.start), true);
  return new Slice(storage, 0, length);
}

function defineMembers(type: StructType, child: Type): void {
  const items = sliceOf(child, false);
  const constItems = sliceOf(child, true);
  const method = (
    name: string,
    options: { args: Type[]; result: Type; byValue?: boolean; allocator?: boolean },
    run: (list: List, args: Value[], frame: Frame) => Value
  ): (() => Member) =>
    fnMember(`ArrayList.${name}`, (sema, call) => {
      sema.resolveStorage(child, call.span);
      const expected = options.allocator ? [ALLOCATOR, ...options.args] : options.args;
      const args = compileArgs(sema, expectArgs(sema, call, expected.length, name), expected);
      const list = receiverOf(sema, call.receiver, type, call.span, options.byValue !== true);
      return nativeStateCall(
        options.result,
        args,
        call.span,
        (frame) => ({ receiver: options.byValue ? (copyForFrame(frame, list(frame), type) as ZStruct) : list(frame) }),
        (state, values, frame) => {
          const received = listOf(state.receiver, child);
          if (options.allocator) received.allocator = allocatorState(values[0]);
          return run(received, options.allocator ? values.slice(1) : values, frame);
        }
      );
    });
  const insertValues = (frame: Frame, list: List, index: number, values: Value[]): Value => {
    if (!ensureTotalCapacity(frame, list, list.items.length + values.length, child)) return ERROR_OUT_OF_MEMORY;
    // `addManyAt` slices `items[index..]` after growing the list.
    if (index > list.items.length) panic(`start index ${index} is larger than end index ${list.items.length}`);
    materializeLength(frame, list, list.items.length + values.length);
    const current = list.items.values().map(copyForStorage);
    const inserted = values.map(copyForStorage);
    const combined = [...current.slice(0, index), ...inserted, ...current.slice(index)];
    for (const [position, value] of combined.entries())
      storeInto(list.items.target, list.items.start + position, value);
    setLength(list, combined.length, frame);
    return undefined;
  };
  const members: Record<string, () => Member> = {
    Slice: () => ({ type: TYPE, value: items }),
    empty: () => ({ type, value: emptyList() }),
    initCapacity: fnMember('ArrayList.initCapacity', (sema, call) => {
      const [allocator, count] = compileArgs(sema, expectArgs(sema, call, 2, 'initCapacity'), [ALLOCATOR, USIZE]);
      const evaluate = count.eval;
      const evaluateAllocator = allocator.eval;
      return runtime(
        allocating(type),
        (frame) => {
          const list = listOf(emptyList(), child);
          list.allocator = allocatorState(evaluateAllocator(frame));
          if (!reallocate(frame, list, Number(evaluate(frame) as bigint), child)) return ERROR_OUT_OF_MEMORY;
          return list.struct;
        },
        call.span
      );
    }),
    initBuffer: fnMember('ArrayList.initBuffer', (sema, call) => {
      const [buffer] = compileArgs(sema, expectArgs(sema, call, 1, 'initBuffer'), [items]);
      return runtime(
        type,
        (frame) => {
          const slice = buffer.eval(frame) as Slice;
          return new ZStruct([new Slice(slice.target, slice.start, 0), BigInt(slice.length), new ZStruct([0n])]);
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
      freeList(list);
      return;
    }),
    append: method('append', { args: [child], result: allocating(VOID), allocator: true }, (list, [item], frame) => {
      if (!ensureTotalCapacity(frame, list, list.items.length + 1, child)) return ERROR_OUT_OF_MEMORY;
      materializeLength(frame, list, list.items.length + 1);
      storeInto(list.items.target, list.items.start + list.items.length, item);
      setLength(list, list.items.length + 1, frame);
      return;
    }),
    appendAssumeCapacity: method('appendAssumeCapacity', { args: [child], result: VOID }, (list, [item], frame) => {
      if (list.items.length >= list.capacity) panic(PANIC.unreachable);
      materializeLength(frame, list, list.items.length + 1);
      storeInto(list.items.target, list.items.start + list.items.length, item);
      setLength(list, list.items.length + 1, frame);
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
      (list, [value, count], frame) => {
        const length = list.items.length + Number(count as bigint);
        if (!ensureTotalCapacity(frame, list, length, child)) return ERROR_OUT_OF_MEMORY;
        materializeLength(frame, list, length);
        for (let index = list.items.length; index < length; index++)
          storeInto(list.items.target, list.items.start + index, value);
        setLength(list, length, frame);
        return;
      }
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
    orderedRemove: method('orderedRemove', { args: [USIZE], result: child }, (list, [index], frame) => {
      const position = Number(index as bigint);
      if (position >= list.items.length) indexOutOfBounds(position, list.items.length);
      const values = list.items.values().map(copyForStorage);
      const [removed] = values.splice(position, 1);
      for (const [at, value] of values.entries()) storeInto(list.items.target, list.items.start + at, value);
      setLength(list, values.length, frame);
      return removed;
    }),
    swapRemove: method('swapRemove', { args: [USIZE], result: child }, (list, [index], frame) => {
      const position = Number(index as bigint);
      if (position >= list.items.length) indexOutOfBounds(position, list.items.length);
      const removed = copyForStorage(list.items.get(position));
      storeInto(list.items.target, list.items.start + position, list.items.get(list.items.length - 1));
      setLength(list, list.items.length - 1, frame);
      return removed;
    }),
    pop: method('pop', { args: [], result: optionalOf(child) }, (list, _, frame) => {
      if (list.items.length === 0) return NULL;
      const value = copyForStorage(list.items.get(list.items.length - 1));
      setLength(list, list.items.length - 1, frame);
      return optionalSome(value, child);
    }),
    getLast: method('getLast', { args: [], result: child, byValue: true }, (list) => {
      if (list.items.length === 0) panic(PANIC.overflow);
      return list.items.get(list.items.length - 1);
    }),
    getLastOrNull: method('getLastOrNull', { args: [], result: optionalOf(child), byValue: true }, (list) =>
      list.items.length === 0 ? NULL : optionalSome(list.items.get(list.items.length - 1), child)
    ),
    last: method('last', { args: [], result: optionalOf(child), byValue: true }, (list) =>
      list.items.length === 0 ? NULL : optionalSome(list.items.get(list.items.length - 1), child)
    ),
    clearRetainingCapacity: method('clearRetainingCapacity', { args: [], result: VOID }, (list, _, frame) => {
      setLength(list, 0, frame);
      return;
    }),
    clearAndFree: method('clearAndFree', { args: [], result: VOID, allocator: true }, (list) => {
      freeList(list);
      return;
    }),
    shrinkRetainingCapacity: method(
      'shrinkRetainingCapacity',
      { args: [USIZE], result: VOID },
      (list, [length], frame) => {
        if (Number(length as bigint) > list.items.length) panic(PANIC.unreachable);
        setLength(list, Number(length as bigint), frame);
        return;
      }
    ),
    orderedRemoveMany: method(
      'orderedRemoveMany',
      { args: [sliceOf(USIZE, true)], result: VOID },
      (list, [indexes], frame) => {
        const sorted = elements(indexes).map((index) => Number(index as bigint));
        const values = list.items.values().map(copyForStorage);
        for (const [position, index] of sorted.entries()) {
          if (position > 0 && index < sorted[position - 1]) panic(PANIC.overflow);
          if (index >= values.length) panic(`index out of bounds: index ${index}, len ${values.length}`);
        }
        const removed = new Set(sorted);
        const kept = values.filter((_, index) => !removed.has(index));
        for (const [position, value] of kept.entries())
          storeInto(list.items.target, list.items.start + position, value);
        setLength(list, kept.length, frame);
        return;
      }
    ),
    shrinkAndFree: method(
      'shrinkAndFree',
      { args: [USIZE], result: VOID, allocator: true },
      (list, [length], frame) => {
        const size = Number(length as bigint);
        if (size > list.items.length) panic(PANIC.unreachable);
        setLength(list, size, frame);
        // The memory shrinks to the items, in place where the allocator can.
        if (sizeOf(child) !== 0) reallocate(frame, list, size, child);
        return;
      }
    ),
    addManyAsSlice: method(
      'addManyAsSlice',
      { args: [USIZE], result: allocating(items), allocator: true },
      (list, [count], frame) => {
        const previous = list.items.length;
        const size = previous + Number(count as bigint);
        if (!ensureTotalCapacity(frame, list, size, child)) return ERROR_OUT_OF_MEMORY;
        setLength(list, size, frame);
        return new Slice(list.items.target, list.items.start + previous, size - previous);
      }
    ),
    unusedCapacitySlice: method('unusedCapacitySlice', { args: [], result: items, byValue: true }, (list) =>
      capacitySlice(list, true)
    ),
    appendBounded: method('appendBounded', { args: [child], result: allocating(VOID) }, (list, [item], frame) => {
      if (list.items.length >= list.capacity) return ERROR_OUT_OF_MEMORY;
      materializeLength(frame, list, list.items.length + 1);
      storeInto(list.items.target, list.items.start + list.items.length, item);
      setLength(list, list.items.length + 1, frame);
      return;
    }),
    resize: method('resize', { args: [USIZE], result: allocating(VOID), allocator: true }, (list, [length], frame) => {
      const size = Number(length as bigint);
      if (!ensureTotalCapacity(frame, list, size, child)) return ERROR_OUT_OF_MEMORY;
      setLength(list, size, frame);
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
        if (sizeOf(child) !== 0 && list.capacity >= size) return;
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
        setLength(list, list.items.length + 1, frame);
        return new Pointer(list.items.target, list.items.start + list.items.length - 1);
      }
    ),
    toOwnedSlice: method('toOwnedSlice', { args: [], result: allocating(items), allocator: true }, (list, _, frame) => {
      // The memory shrinks to the items, in place where the allocator can.
      const complete = reserveNativeAllocation(frame, list.allocator, list.items.length, child, list.items.target);
      if (!complete) return ERROR_OUT_OF_MEMORY;
      const values = list.items.values().map(copyForStorage);
      const owned = new ZArray(values, 0, values.length);
      complete(owned);
      list.struct.slots[0] = new Slice(new ZArray([]), 0, 0);
      list.struct.slots[1] = 0n;
      return new Slice(owned, 0, values.length);
    }),
    clone: method('clone', { args: [], result: allocating(type), byValue: true, allocator: true }, (list, _, frame) => {
      const copy = listOf(emptyList(), child);
      copy.allocator = list.allocator;
      if (!reallocate(frame, copy, list.capacity, child)) return ERROR_OUT_OF_MEMORY;
      materializeLength(frame, copy, list.items.length);
      for (let index = 0; index < list.items.length; index++)
        storeInto(copy.items.target, copy.items.start + index, list.items.get(index));
      setLength(copy, list.items.length, frame);
      return copy.struct;
    }),
    allocatedSlice: method('allocatedSlice', { args: [], result: items, byValue: true }, (list) =>
      capacitySlice(list, false)
    ),
    expandToCapacity: method('expandToCapacity', { args: [], result: VOID }, (list, _, frame) => {
      setLength(list, list.capacity, frame);
      return;
    }),
    replaceRange: method(
      'replaceRange',
      { args: [USIZE, USIZE, constItems], result: allocating(VOID), allocator: true },
      (list, [start, length, slice], frame) => {
        const from = Number(start as bigint);
        const count = Number(length as bigint);
        const values = list.items.values().map(copyForStorage);
        const replacement = elements(slice).map(copyForStorage);
        // Zig computes `items.len - len` before slicing `items[start + len ..]`.
        if (count > values.length) panic(PANIC.overflow);
        if (!ensureTotalCapacity(frame, list, values.length - count + replacement.length, child)) {
          return ERROR_OUT_OF_MEMORY;
        }
        if (from + count > values.length)
          panic(`start index ${from + count} is larger than end index ${values.length}`);
        const combined = [...values.slice(0, from), ...replacement, ...values.slice(from + count)];
        for (const [position, value] of combined.entries())
          storeInto(list.items.target, list.items.start + position, value);
        setLength(list, combined.length, frame);
        return;
      }
    ),
  };
  if (child === U8) {
    members.print = fnMember('ArrayList.print', (sema, call) => {
      const [allocatorArg, format, args] = expectArgs(sema, call, 3, 'print');
      const [allocator] = compileArgs(sema, [allocatorArg], [ALLOCATOR]);
      const list = receiverOf(sema, call.receiver, type, call.span, true);
      const print = compilePrint(sema, format, args, call.span);
      return nativeStateCall(
        allocating(VOID),
        [allocator],
        call.span,
        (frame) => ({ receiver: list(frame) }),
        (state, [allocator], frame) => {
          const prepared = print.prepare(frame);
          return withHeldValues(frame, [prepared.args], () => {
            const received = listOf(state.receiver, child);
            received.allocator = allocatorState(allocator);
            if (!ensureTotalCapacity(frame, received, received.items.length + print.formatLength, child))
              return ERROR_OUT_OF_MEMORY;
            const owner = received.struct;
            received.struct = new ZStruct(owner.slots.map(copyForStorage));
            storeInto(owner, 0, new Slice(new ZArray([]), 0, 0));
            owner.slots[1] = 0n;
            const destination: WriterState = {
              fd: undefined,
              buffer: new Slice(received.items.target, received.items.start, received.capacity),
              end: received.items.length,
              capacity: received.capacity,
              growth: new NativeHandle('writerGrowth', {
                grow: (frame: Frame, writer: WriterState, end: number) => {
                  setLength(received, writer.end, frame);
                  if (!ensureTotalCapacity(frame, received, end + 1, child)) return false;
                  writer.buffer = new Slice(received.items.target, received.items.start, received.capacity);
                  writer.capacity = received.capacity;
                  return true;
                },
              }),
            };
            return withHeldValues(frame, [received.struct], () => {
              let completed = false;
              try {
                prepared.write(destination);
                completed = true;
                return;
              } catch (error) {
                if (error instanceof PrintWriteError) {
                  completed = true;
                  return ERROR_OUT_OF_MEMORY;
                }
                throw error;
              } finally {
                if (completed) {
                  setLength(received, destination.end, frame);
                  for (const [index, value] of received.struct.slots.entries()) storeInto(owner, index, value);
                }
              }
            });
          });
        }
      );
    });
  }
  addMembers(type, members);
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
