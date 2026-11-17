import { transferCost } from '../allocation';
import { indexOutOfBounds, PANIC, panic } from '../arith';
import type { Span } from '../ast';
import { sizeOf } from '../layout';
import { type Frame, withHeldValues } from '../runtime';
import { copyForFrame, copyForStorage, known, runtime, type SemaApi, type TExpr, undefinedValue } from '../semaBase';
import {
  errorUnionOf,
  fnType,
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
  ErrorValue,
  NativeHandle,
  NULL,
  optionalSome,
  Pointer,
  Slice,
  storeInto,
  type Value,
  ZArray,
  ZStruct,
} from '../values';
import { zeroSlice } from '../zeroSizedMemory';
import { orderedRemover, sliceMutator } from './arrayListAlgorithms';
import { constSlice } from './common';
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
import {
  addMembers,
  compileArgs,
  expectArgs,
  fnMember,
  type Member,
  nativeStruct,
  nativeStructCall,
  structReceiver,
} from './native';
import { compilePrint } from './print';
import { WriterWriteError } from './writer';
import type { WriterState } from './writer';

const SAFETY_STATE = nativeEnum('debug.SafetyLock.State', ['unlocked', 'locked']);
const SAFETY_LOCK = nativeStruct('debug.SafetyLock', {}, [
  { name: 'state', type: SAFETY_STATE, hasDefault: true, defaultValue: 0n },
]);

/** The cache line of the reference toolchain's CPU (aarch64), which sets the first capacity. */
const CACHE_LINE = 128;

const MAX_CAPACITY = (1n << 64n) - 1n;

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
  frame: Frame;
  transferCost: number;
  struct: ZStruct;
  items: Slice;
  capacity: number;
  /** The allocator a method received, which accounts for the list's memory. */
  allocator?: AllocatorState;
}

function listOf(struct: ZStruct, child: Type, frame: Frame): List {
  const items = struct.slots[0] as Slice;
  return {
    child,
    frame,
    transferCost: transferCost(child),
    struct,
    items: sizeOf(child) === 0 ? zeroSlice(items, items.lengthValue, child) : items,
    capacity: Number(struct.slots[1] as bigint),
  };
}

/** `growCapacity`: the capacity a list grows to when it needs `minimum`. */
export function growCapacity(minimum: number, child: Type): number {
  const size = sizeOf(child);
  const initial = Math.max(1, Math.floor(CACHE_LINE / Math.max(size, 1)));
  return minimum + Math.floor(minimum / 2) + initial;
}

/** Gives the list exactly `capacity` slots, copying its items to new storage; false when memory runs out. */
function reallocate(frame: Frame, list: List, requested: number | bigint, child: Type): boolean {
  if (BigInt(requested) > MAX_CAPACITY) return false;
  if (sizeOf(child) === 0) {
    list.struct.slots[1] = MAX_CAPACITY;
    list.capacity = Number(MAX_CAPACITY);
    return true;
  }
  const capacity = Number(requested);
  const previous = list.capacity > 0 ? list.items.target : undefined;
  const complete = reserveNativeAllocation(frame, list.allocator, capacity, child, previous);
  if (!complete) return false;
  spendTransfers(list, list.items.length * 2 + capacity);
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

function ensureTotalCapacity(frame: Frame, list: List, capacity: number | bigint, child: Type): boolean {
  if (BigInt(capacity) > MAX_CAPACITY) return false;
  if ((list.struct.slots[1] as bigint) >= BigInt(capacity)) return true;
  return reallocate(frame, list, sizeOf(child) === 0 ? capacity : growCapacity(Number(capacity), child), child);
}

function setLength(list: List, length: number | bigint, poison = true): void {
  if (BigInt(length) > MAX_CAPACITY || BigInt(length) < 0n) panic(PANIC.overflow);
  const size = Number(length);
  if (sizeOf(list.child) === 0) list.items = zeroSlice(list.items, BigInt(length), list.child);
  else {
    if (poison) {
      spendTransfers(list, Math.max(0, list.items.length - size));
      for (let index = size; index < list.items.length; index++)
        list.items.target.slots[list.items.start + index] = undefinedValue(list.child);
    }
    list.items = new Slice(list.items.target, list.items.start, size);
  }
  list.struct.slots[0] = list.items;
}

function spendTransfers(list: List, count: number | bigint, copies = 1): void {
  if (list.transferCost !== 0) list.frame.runtime.spend(Number(count) * list.transferCost * copies);
}

function capacitySlice(list: List, unused: boolean): Slice {
  const start = unused ? list.items.lengthValue : 0n;
  const capacity = list.struct.slots[1] as bigint;
  if (start > capacity) panic(`start index ${start} is larger than end index ${capacity}`);
  const length = capacity - start;
  return sizeOf(list.child) === 0
    ? zeroSlice(list.items, length, list.child)
    : new Slice(list.items.target, list.items.start + Number(start), length);
}

function defineMembers(type: StructType, child: Type): void {
  const items = sliceOf(child, false);
  const constItems = sliceOf(child, true);
  const method = (
    name: string,
    options: { args: Type[]; result: Type; byValue?: boolean; allocator?: boolean },
    run: (list: List, args: Value[], frame: Frame) => Value
  ): (() => Member) =>
    fnMember(
      `ArrayList.${name}`,
      (sema, call) => {
        sema.resolveStorage(child, call.span);
        const expected = options.allocator ? [ALLOCATOR, ...options.args] : options.args;
        const args = compileArgs(sema, expectArgs(sema, call, expected.length, name), expected);
        const list = receiverOf(sema, call.receiver, type, call.span, options.byValue !== true);
        return nativeStructCall(
          options.result,
          args,
          call.span,
          {
            type,
            evaluate: (frame) => (options.byValue ? (copyForFrame(frame, list(frame), type) as ZStruct) : list(frame)),
          },
          (receiver, values, frame) => {
            const received = listOf(receiver, child, frame);
            if (options.allocator) received.allocator = allocatorState(values[0]);
            return run(received, options.allocator ? values.slice(1) : values, frame);
          }
        );
      },
      () => ({
        type: fnType(
          [options.byValue ? type : pointerTo(type, false), ...(options.allocator ? [ALLOCATOR] : []), ...options.args],
          options.result
        ),
        receiver: true,
      })
    );
  const mutateSlice = (name: 'appendSlice' | 'insertSlice' | 'replaceRange'): (() => Member) =>
    fnMember(
      `ArrayList.${name}`,
      (sema, call) => {
        sema.resolveStorage(child, call.span);
        const params = [
          ALLOCATOR,
          ...(name === 'appendSlice' ? [] : [USIZE]),
          ...(name === 'replaceRange' ? [USIZE] : []),
          constItems,
        ];
        const args = compileArgs(sema, expectArgs(sema, call, params.length, name), params);
        const list = receiverOf(sema, call.receiver, type, call.span, true);
        const fn = sliceMutator(sema, child, type, name, call.span);
        return nativeStructCall(
          allocating(VOID),
          args,
          call.span,
          { type, evaluate: list },
          (receiver, values, frame) => {
            const received = listOf(receiver, child, frame);
            received.allocator = allocatorState(values[0]);
            const removed = name === 'replaceRange' ? (values[2] as bigint) : 0n;
            if (removed > received.items.lengthValue) panic(PANIC.overflow);
            const nextLength = received.items.lengthValue - removed + (values.at(-1) as Slice).lengthValue;
            if (!ensureTotalCapacity(frame, received, nextLength, child)) return ERROR_OUT_OF_MEMORY;
            return sema.callFunction(fn, [new Pointer({ slots: [receiver] }, 0), ...values.slice(1)], frame);
          }
        );
      },
      () => ({
        type: fnType(
          [
            pointerTo(type, false),
            ALLOCATOR,
            ...(name === 'appendSlice' ? [] : [USIZE]),
            ...(name === 'replaceRange' ? [USIZE] : []),
            constItems,
          ],
          allocating(VOID)
        ),
        receiver: true,
      })
    );
  const insertValue = (frame: Frame, list: List, at: bigint, value: Value): Value => {
    const length = list.items.lengthValue + 1n;
    if (!ensureTotalCapacity(frame, list, length, child)) return ERROR_OUT_OF_MEMORY;
    if (at > list.items.lengthValue) panic(`start index ${at} is larger than end index ${list.items.lengthValue}`);
    if (sizeOf(child) === 0) {
      setLength(list, length);
      return undefined;
    }
    const index = Number(at);
    spendTransfers(list, length - at, 2);
    for (let position = list.items.length; position > index; position--)
      storeInto(list.items.target, list.items.start + position, list.items.get(position - 1));
    storeInto(list.items.target, list.items.start + index, value);
    setLength(list, length);
    return undefined;
  };
  const members: Record<string, () => Member> = {
    Slice: () => ({ type: TYPE, value: items }),
    empty: () => ({ type, value: emptyList() }),
    initCapacity: fnMember(
      'ArrayList.initCapacity',
      (sema, call) => {
        sema.resolveStorage(child, call.span);
        const [allocator, count] = compileArgs(sema, expectArgs(sema, call, 2, 'initCapacity'), [ALLOCATOR, USIZE]);
        const evaluate = count.eval;
        const evaluateAllocator = allocator.eval;
        return runtime(
          allocating(type),
          (frame) => {
            const list = listOf(emptyList(), child, frame);
            list.allocator = allocatorState(evaluateAllocator(frame));
            if (!reallocate(frame, list, evaluate(frame) as bigint, child)) return ERROR_OUT_OF_MEMORY;
            return list.struct;
          },
          call.span
        );
      },
      () => ({ type: fnType([ALLOCATOR, USIZE], allocating(type)) })
    ),
    initBuffer: fnMember(
      'ArrayList.initBuffer',
      (sema, call) => {
        const [buffer] = compileArgs(sema, expectArgs(sema, call, 1, 'initBuffer'), [items]);
        return runtime(
          type,
          (frame) => {
            const slice = buffer.eval(frame) as Slice;
            return new ZStruct([new Slice(slice.target, slice.start, 0), slice.lengthValue, new ZStruct([0n])]);
          },
          call.span
        );
      },
      () => ({ type: fnType([items], type) })
    ),
    fromOwnedSlice: fnMember(
      'ArrayList.fromOwnedSlice',
      (sema, call) => {
        const [slice] = compileArgs(sema, expectArgs(sema, call, 1, 'fromOwnedSlice'), [items]);
        return runtime(
          type,
          (frame) => {
            const value = slice.eval(frame) as Slice;
            return new ZStruct([value, value.lengthValue, new ZStruct([0n])]);
          },
          call.span
        );
      },
      () => ({ type: fnType([items], type) })
    ),
    deinit: method('deinit', { args: [], result: VOID, allocator: true }, (list) => {
      freeList(list);
      return;
    }),
    append: method('append', { args: [child], result: allocating(VOID), allocator: true }, (list, [item], frame) => {
      const pointer = addOne(frame, list, child);
      if (pointer instanceof ErrorValue) return pointer;
      spendTransfers(list, 1, 2);
      storeInto(pointer.target, pointer.index, item);
      return;
    }),
    appendAssumeCapacity: method('appendAssumeCapacity', { args: [child], result: VOID }, (list, [item]) => {
      if (list.items.lengthValue >= (list.struct.slots[1] as bigint)) panic(PANIC.unreachable);
      spendTransfers(list, 1, 2);
      storeInto(list.items.target, list.items.start + list.items.length, item);
      setLength(list, list.items.lengthValue + 1n);
      return;
    }),
    appendSlice: mutateSlice('appendSlice'),
    appendNTimes: method(
      'appendNTimes',
      { args: [child, USIZE], result: allocating(VOID), allocator: true },
      (list, [value, count], frame) => {
        const length = list.items.lengthValue + (count as bigint);
        if (!ensureTotalCapacity(frame, list, length, child)) return ERROR_OUT_OF_MEMORY;
        spendTransfers(list, count as bigint, 2);
        for (let index = list.items.length; sizeOf(child) !== 0 && index < Number(length); index++)
          storeInto(list.items.target, list.items.start + index, value);
        setLength(list, length);
        return;
      }
    ),
    insert: method(
      'insert',
      { args: [USIZE, child], result: allocating(VOID), allocator: true },
      (list, [index, item], frame) => insertValue(frame, list, index as bigint, item)
    ),
    insertSlice: mutateSlice('insertSlice'),
    orderedRemove: method('orderedRemove', { args: [USIZE], result: child }, (list, [index]) => {
      const position = Number(index as bigint);
      if ((index as bigint) >= list.items.lengthValue) indexOutOfBounds(index as bigint, list.items.lengthValue);
      if (sizeOf(child) === 0) {
        setLength(list, list.items.lengthValue - 1n);
        return undefinedValue(child);
      }
      spendTransfers(list, 1);
      const removed = copyForStorage(list.items.get(position));
      spendTransfers(list, list.items.lengthValue - (index as bigint) - 1n, 2);
      for (let at = position; at + 1 < list.items.length; at++)
        storeInto(list.items.target, list.items.start + at, list.items.get(at + 1));
      setLength(list, list.items.lengthValue - 1n);
      return removed;
    }),
    swapRemove: method('swapRemove', { args: [USIZE], result: child }, (list, [index]) => {
      const position = Number(index as bigint);
      if ((index as bigint) >= list.items.lengthValue) indexOutOfBounds(index as bigint, list.items.lengthValue);
      spendTransfers(list, 1, 3);
      const removed = copyForStorage(list.items.get(position));
      storeInto(list.items.target, list.items.start + position, list.items.get(Number(list.items.lengthValue - 1n)));
      setLength(list, list.items.lengthValue - 1n);
      return removed;
    }),
    pop: method('pop', { args: [], result: optionalOf(child) }, (list, _) => {
      if (list.items.length === 0) return NULL;
      spendTransfers(list, 1);
      const value = copyForStorage(list.items.get(Number(list.items.lengthValue - 1n)));
      setLength(list, list.items.lengthValue - 1n);
      return optionalSome(value, child);
    }),
    getLast: method('getLast', { args: [], result: child, byValue: true }, (list) => {
      if (list.items.length === 0) panic(PANIC.overflow);
      return list.items.get(Number(list.items.lengthValue - 1n));
    }),
    getLastOrNull: method('getLastOrNull', { args: [], result: optionalOf(child), byValue: true }, (list) =>
      list.items.length === 0 ? NULL : optionalSome(list.items.get(Number(list.items.lengthValue - 1n)), child)
    ),
    last: method('last', { args: [], result: optionalOf(child), byValue: true }, (list) =>
      list.items.length === 0 ? NULL : optionalSome(list.items.get(Number(list.items.lengthValue - 1n)), child)
    ),
    clearRetainingCapacity: method('clearRetainingCapacity', { args: [], result: VOID }, (list, _) => {
      setLength(list, 0);
      return;
    }),
    clearAndFree: method('clearAndFree', { args: [], result: VOID, allocator: true }, (list) => {
      freeList(list);
      return;
    }),
    shrinkRetainingCapacity: method('shrinkRetainingCapacity', { args: [USIZE], result: VOID }, (list, [length]) => {
      if ((length as bigint) > list.items.lengthValue) panic(PANIC.unreachable);
      setLength(list, length as bigint);
      return;
    }),
    orderedRemoveMany: fnMember(
      'ArrayList.orderedRemoveMany',
      (sema, call) => {
        sema.resolveStorage(child, call.span);
        const args = compileArgs(sema, expectArgs(sema, call, 1, 'orderedRemoveMany'), [sliceOf(USIZE, true)]);
        const list = receiverOf(sema, call.receiver, type, call.span, true);
        const fn = orderedRemover(sema, child, type, call.span);
        return nativeStructCall(VOID, args, call.span, { type, evaluate: list }, (receiver, values, frame) =>
          sema.callFunction(fn, [new Pointer({ slots: [receiver] }, 0), values[0]], frame)
        );
      },
      () => ({ type: fnType([pointerTo(type, false), sliceOf(USIZE, true)], VOID), receiver: true })
    ),
    shrinkAndFree: method(
      'shrinkAndFree',
      { args: [USIZE], result: VOID, allocator: true },
      (list, [length], frame) => {
        const size = length as bigint;
        if (size > list.items.lengthValue) panic(PANIC.unreachable);
        setLength(list, size, false);
        if (sizeOf(child) !== 0) reallocate(frame, list, size, child);
        return;
      }
    ),
    addManyAsSlice: method(
      'addManyAsSlice',
      { args: [USIZE], result: allocating(items), allocator: true },
      (list, [count], frame) => {
        const previous = list.items.lengthValue;
        const size = previous + (count as bigint);
        if (!ensureTotalCapacity(frame, list, size, child)) return ERROR_OUT_OF_MEMORY;
        setLength(list, size);
        return new Slice(list.items.target, list.items.start + Number(previous), size - previous);
      }
    ),
    unusedCapacitySlice: method('unusedCapacitySlice', { args: [], result: items, byValue: true }, (list) =>
      capacitySlice(list, true)
    ),
    appendBounded: method('appendBounded', { args: [child], result: allocating(VOID) }, (list, [item]) => {
      if (list.items.lengthValue >= (list.struct.slots[1] as bigint)) return ERROR_OUT_OF_MEMORY;
      spendTransfers(list, 1, 2);
      storeInto(list.items.target, list.items.start + list.items.length, item);
      setLength(list, list.items.lengthValue + 1n);
      return;
    }),
    resize: method('resize', { args: [USIZE], result: allocating(VOID), allocator: true }, (list, [length], frame) => {
      const size = length as bigint;
      if (!ensureTotalCapacity(frame, list, size, child)) return ERROR_OUT_OF_MEMORY;
      setLength(list, size);
      return;
    }),
    ensureTotalCapacity: method(
      'ensureTotalCapacity',
      { args: [USIZE], result: allocating(VOID), allocator: true },
      (list, [capacity], frame) =>
        ensureTotalCapacity(frame, list, capacity as bigint, child) ? undefined : ERROR_OUT_OF_MEMORY
    ),
    ensureTotalCapacityPrecise: method(
      'ensureTotalCapacityPrecise',
      { args: [USIZE], result: allocating(VOID), allocator: true },
      (list, [capacity], frame) => {
        const size = capacity as bigint;
        if (sizeOf(child) !== 0 && (list.struct.slots[1] as bigint) >= size) return;
        return reallocate(frame, list, size, child) ? undefined : ERROR_OUT_OF_MEMORY;
      }
    ),
    ensureUnusedCapacity: method(
      'ensureUnusedCapacity',
      { args: [USIZE], result: allocating(VOID), allocator: true },
      (list, [count], frame) =>
        ensureTotalCapacity(frame, list, list.items.lengthValue + (count as bigint), child)
          ? undefined
          : ERROR_OUT_OF_MEMORY
    ),
    addOne: method(
      'addOne',
      { args: [], result: allocating(pointerTo(child, false)), allocator: true },
      (list, _, frame) => addOne(frame, list, child)
    ),
    toOwnedSlice: method('toOwnedSlice', { args: [], result: allocating(items), allocator: true }, (list, _, frame) => {
      // The memory shrinks to the items, in place where the allocator can.
      if (sizeOf(child) === 0) {
        const owned = list.items;
        freeList(list);
        return owned;
      }
      const complete = reserveNativeAllocation(frame, list.allocator, list.items.length, child, list.items.target);
      if (!complete) return ERROR_OUT_OF_MEMORY;
      spendTransfers(list, list.items.lengthValue, 2);
      const values = list.items.values().map(copyForStorage);
      const owned = new ZArray(values, 0, values.length);
      complete(owned);
      list.struct.slots[0] = new Slice(new ZArray([]), 0, 0);
      list.struct.slots[1] = 0n;
      return new Slice(owned, 0, values.length);
    }),
    clone: method('clone', { args: [], result: allocating(type), byValue: true, allocator: true }, (list, _, frame) => {
      const copy = listOf(emptyList(), child, frame);
      copy.allocator = list.allocator;
      if (!reallocate(frame, copy, list.struct.slots[1] as bigint, child)) return ERROR_OUT_OF_MEMORY;
      spendTransfers(list, list.items.lengthValue, 2);
      for (let index = 0; sizeOf(child) !== 0 && index < list.items.length; index++)
        storeInto(copy.items.target, copy.items.start + index, list.items.get(index));
      setLength(copy, list.items.lengthValue);
      return copy.struct;
    }),
    allocatedSlice: method('allocatedSlice', { args: [], result: items, byValue: true }, (list) =>
      capacitySlice(list, false)
    ),
    expandToCapacity: method('expandToCapacity', { args: [], result: VOID }, (list, _) => {
      setLength(list, list.struct.slots[1] as bigint);
      return;
    }),
    replaceRange: mutateSlice('replaceRange'),
  };
  if (child === U8) {
    members.print = fnMember('ArrayList.print', (sema, call) => {
      const [allocatorArg, format, args] = expectArgs(sema, call, 3, 'print');
      const [allocator] = compileArgs(sema, [allocatorArg], [ALLOCATOR]);
      const list = receiverOf(sema, call.receiver, type, call.span, true);
      const print = compilePrint(sema, format, args, call.span);
      return nativeStructCall(
        allocating(VOID),
        [allocator],
        call.span,
        { type, evaluate: list },
        (receiver, [allocator], frame) => {
          const prepared = print.prepare(frame);
          return withHeldValues(
            frame,
            [prepared.args],
            () => {
              const received = listOf(receiver, child, frame);
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
                    setLength(received, writer.end);
                    if (!ensureTotalCapacity(frame, received, end + 1, child)) return false;
                    writer.buffer = new Slice(received.items.target, received.items.start, received.capacity);
                    writer.capacity = received.capacity;
                    return true;
                  },
                }),
              };
              return withHeldValues(
                frame,
                [received.struct],
                () => {
                  let completed = false;
                  try {
                    prepared.write(destination);
                    completed = true;
                    return;
                  } catch (error) {
                    if (error instanceof WriterWriteError) {
                      completed = true;
                      return ERROR_OUT_OF_MEMORY;
                    }
                    throw error;
                  } finally {
                    if (completed) {
                      setLength(received, destination.end);
                      for (const [index, value] of received.struct.slots.entries()) storeInto(owner, index, value);
                    }
                  }
                },
                [type]
              );
            },
            [prepared.type]
          );
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
  return structReceiver(sema, { receiver, span }, type, mutable);
}

export function arrayListFactory(): () => Member {
  return fnMember('std.ArrayList', (sema, call) => {
    const [typeArg] = expectArgs(sema, call, 1, 'std.ArrayList');
    return known(TYPE, arrayListType(sema.compileType(typeArg)), call.span);
  });
}

export { constSlice };

function addOne(frame: Frame, list: List, child: Type): Pointer | ErrorValue {
  const length = list.items.lengthValue + 1n;
  if (length > MAX_CAPACITY) panic(PANIC.overflow);
  if (!ensureTotalCapacity(frame, list, length, child)) return ERROR_OUT_OF_MEMORY;
  setLength(list, length);
  return new Pointer(list.items.target, list.items.start + Number(length - 1n));
}
