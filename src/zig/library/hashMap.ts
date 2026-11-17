// code-gauge-allow-file fileNcss 464 -- Keeps hash-map state, storage layout, and public method registration together.
import { allocationSlots, transferCost, valueSlots } from '../allocation';
import { reserveAllocatorBytes } from '../allocatorStorage';
// code-gauge-allow-file duplicateLines 19 -- Library types repeat the same shape of method on purpose, each over its own state.
import { panic } from '../arith';
import type { Expression, Span } from '../ast';
import { bindBufferMemory } from '../bufferMemory';
import { alignOf, sizeOf } from '../layout';
import type { Frame } from '../runtime';
import { copyForFrame, known, runtime, type SemaApi, type TExpr, undefinedValue } from '../semaBase';
import {
  BOOL,
  CONST_U8_SLICE,
  errorUnionOf,
  optionalOf,
  pointerTo,
  sliceOf,
  type StructType,
  TYPE,
  type Type,
  typeId,
  typeName,
  U32,
  VOID,
} from '../types';
import {
  ErrorValue,
  NativeHandle,
  NULL,
  optionalSome,
  Pointer,
  type Slice,
  type Slots,
  Some,
  storeInto,
  type Value,
  ZArray,
  zeroArrayElement,
  ZStruct,
  ZUnion,
} from '../values';
import { WeakValueMap } from '../weakValueMap';
import { equalValues } from './common';
import { autoHashBytes, hasPhysicalHashLayout, wyhash } from './hashing';
import {
  ALLOCATOR,
  ALLOCATOR_ERROR,
  type AllocatorState,
  allocatorState,
  ERROR_OUT_OF_MEMORY,
  freeMemory,
} from './heap';
import {
  addMembers,
  compileArgs,
  expectArgs,
  fnMember,
  type Member,
  nativeCall,
  nativeStateCall,
  nativeStruct,
} from './native';

type KeyKind = 'auto' | 'string';

interface MapState extends Record<string, unknown> {
  capacity: number;
  /** 0 for free, 1 for a tombstone, and 0x80 | fingerprint for a used slot, as Zig's `Metadata` bytes. */
  metadata: number[];
  keys: ZArray;
  values: ZArray;
  size: number;
  available: number;
  allocator?: AllocatorState;
  memory?: object;
  header?: ZStruct;
}

const MINIMAL_CAPACITY = 8;
const MAX_LOAD = 80;

function hashOf(frame: Frame, key: Value, keyType: Type, kind: KeyKind): bigint {
  if (kind === 'string') {
    const slice = key as Slice;
    frame.runtime.spend(1 + Number(slice.lengthValue));
    return wyhash(
      0n,
      Array.from({ length: slice.length }, (_, index) => Number(slice.get(index) as bigint))
    );
  }
  const bytes = autoHashBytes(
    key,
    keyType,
    (value) => frame.runtime.identityOf(value),
    (cost) => frame.runtime.spend(cost)
  );
  frame.runtime.spend(1 + bytes.length);
  return wyhash(0n, bytes);
}

// code-gauge-allow functionCognitiveComplexity 17 -- Compares each supported representation with the same runtime budget.
function keysEqual(frame: Frame, a: Value, b: Value, kind: KeyKind): boolean {
  frame.runtime.spend();
  if (kind === 'string') return stringKeysEqual(frame, a as Slice, b as Slice);
  if (a instanceof ZStruct && b instanceof ZStruct) {
    if (a.slots.length !== b.slots.length) return false;
    for (let index = 0; index < a.slots.length; index++)
      if (!keysEqual(frame, a.slots[index], b.slots[index], 'auto')) return false;
    return true;
  }
  if (a instanceof ZArray && b instanceof ZArray) return arrayKeysEqual(frame, a, b);
  if (a instanceof ZUnion && b instanceof ZUnion)
    return a.tag === b.tag && keysEqual(frame, a.slots[0], b.slots[0], 'auto');
  if (a instanceof Some && b instanceof Some) return keysEqual(frame, a.value, b.value, 'auto');
  return equalValues(a, b);
}

function stringKeysEqual(frame: Frame, x: Slice, y: Slice): boolean {
  if (x.lengthValue !== y.lengthValue) return false;
  for (let index = 0; index < x.length; index++) {
    frame.runtime.spend();
    if (x.get(index) !== y.get(index)) return false;
  }
  return true;
}

function arrayKeysEqual(frame: Frame, a: ZArray, b: ZArray): boolean {
  if (a.lengthValue !== b.lengthValue) return false;
  const x = zeroArrayElement(a),
    y = zeroArrayElement(b);
  if (x && y) return keysEqual(frame, x.value, y.value, 'auto');
  for (let index = 0; index < a.length; index++)
    if (!keysEqual(frame, a.get(index), b.get(index), 'auto')) return false;
  return true;
}

function storeMapSlot(frame: Frame, storage: Slots, index: number, value: Value, type: Type): void {
  frame.runtime.spend(2 * transferCost(type));
  storeInto(storage, index, value);
}

function snapshotEntry(frame: Frame, state: MapState, index: number, keyType: Type, valueType: Type): ZStruct {
  frame.runtime.spend(transferCost(keyType) + transferCost(valueType));
  return new ZStruct([
    copyForFrame(frame, state.keys.slots[index], keyType),
    copyForFrame(frame, state.values.slots[index], valueType),
  ]);
}

function capacityForSize(size: number): number {
  const needed = Math.floor((size * 100) / MAX_LOAD) + 1;
  let capacity = 1;
  while (capacity < needed) capacity *= 2;
  return capacity;
}

function emptyState(): MapState {
  return {
    capacity: 0,
    metadata: [],
    keys: new ZArray([]),
    values: new ZArray([]),
    size: 0,
    available: 0,
    memory: undefined,
  };
}

function fingerprint(hash: bigint): number {
  return Number(hash >> 57n);
}

function getIndex(frame: Frame, state: MapState, key: Value, keyType: Type, kind: KeyKind): number {
  if (state.size === 0) return -1;
  const hash = hashOf(frame, key, keyType, kind);
  const mask = state.capacity - 1;
  const print = fingerprint(hash);
  let limit = state.capacity;
  let index = Number(hash & BigInt(mask));
  while (state.metadata[index] !== 0 && limit !== 0) {
    frame.runtime.spend();
    if (state.metadata[index] === (0x80 | print) && keysEqual(frame, key, state.keys.slots[index], kind)) return index;
    limit--;
    index = (index + 1) & mask;
  }
  return -1;
}

// code-gauge-allow functionParameterCount 7 -- Rehashing binds both typed payloads to the table, runtime and key strategy.
function putNoClobber(
  frame: Frame,
  state: MapState,
  key: Value,
  value: Value,
  keyType: Type,
  valueType: Type,
  kind: KeyKind
): void {
  const hash = hashOf(frame, key, keyType, kind);
  const mask = state.capacity - 1;
  let index = Number(hash & BigInt(mask));
  while ((state.metadata[index] & 0x80) !== 0) {
    frame.runtime.spend();
    index = (index + 1) & mask;
  }
  state.available--;
  state.metadata[index] = 0x80 | fingerprint(hash);
  storeMapSlot(frame, state.keys, index, key, keyType);
  storeMapSlot(frame, state.values, index, value, valueType);
  state.size++;
}

/** Grows the table to a new capacity, reinserting the used entries in slot order. */
// code-gauge-allow functionNcss 41 -- Reserves backing bytes before rebuilding the table in reference slot order.
function grow(
  frame: Frame,
  state: MapState,
  newCapacity: number,
  keyType: Type,
  valueType: Type,
  kind: KeyKind
): boolean {
  const capacity = Math.max(newCapacity, MINIMAL_CAPACITY);
  const slots = capacity + allocationSlots(capacity, keyType) + allocationSlots(capacity, valueType);
  if (!frame.runtime.canAllocate(slots)) return false;
  const layout = mapAllocationLayout(capacity, keyType, valueType);
  const reserved = reserveAllocatorBytes(frame, state.allocator, layout.size, layout.alignment);
  if (!reserved) return false;
  frame.runtime.allocate(slots);
  const old = { ...state, metadata: state.metadata, keys: state.keys, values: state.values };
  const memory = {};
  reserved.complete(memory);
  frame.runtime.spend(capacity * (transferCost(keyType) + transferCost(valueType)));
  const keys = new ZArray(Array.from({ length: capacity }, () => undefinedValue(keyType)));
  const values = new ZArray(Array.from({ length: capacity }, () => undefinedValue(valueType)));
  let metadata = Array.from<number>({ length: capacity }).fill(0);
  if (reserved.region) {
    const { buffer, offset } = reserved.region;
    bindBufferMemory(keys, keyType, capacity, buffer, offset + layout.keys, frame.runtime, 0);
    bindBufferMemory(values, valueType, capacity, buffer, offset + layout.values, frame.runtime, 0);
    metadata = byteMetadata(buffer, offset + 24, capacity);
    metadata.fill(0);
    for (let index = 0; index < 4; index++) buffer.set(offset + 16 + index, BigInt((capacity >>> (index * 8)) & 255));
  }
  state.capacity = capacity;
  state.memory = memory;
  state.metadata = metadata;
  state.keys = keys;
  state.values = values;
  state.available = Math.floor((capacity * MAX_LOAD) / 100);
  const size = old.size;
  state.size = 0;
  for (let index = 0; index < old.capacity && state.size < size; index++) {
    frame.runtime.spend();
    if ((old.metadata[index] & 0x80) === 0) continue;
    putNoClobber(frame, state, old.keys.slots[index], old.values.slots[index], keyType, valueType, kind);
  }
  if (old.memory) freeMemory(old.allocator, old.memory);
  return true;
}

function mapAllocationLayout(
  capacity: number,
  key: Type,
  value: Type
): { size: number; alignment: number; keys: number; values: number } {
  const keyAlign = sizeOf(key) === 0 ? 1 : alignOf(key);
  const valueAlign = sizeOf(value) === 0 ? 1 : alignOf(value);
  const alignment = Math.max(8, keyAlign, valueAlign);
  const keys = Math.ceil((24 + capacity) / keyAlign) * keyAlign;
  const values = Math.ceil((keys + capacity * sizeOf(key)) / valueAlign) * valueAlign;
  const size = Math.ceil((values + capacity * sizeOf(value)) / alignment) * alignment;
  return { size, alignment, keys, values };
}

function byteMetadata(buffer: Slice, offset: number, capacity: number): number[] {
  return new Proxy(Array.from<number>({ length: capacity }).fill(0), {
    get: (target, property, receiver) => {
      if (typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property) && Number(property) < capacity)
        return Number(buffer.get(offset + Number(property)) as bigint);
      return Reflect.get(target, property, receiver);
    },
    set: (target, property, value: number, receiver) => {
      if (typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property) && Number(property) < capacity) {
        buffer.set(offset + Number(property), BigInt(value));
        return true;
      }
      return Reflect.set(target, property, value, receiver);
    },
  });
}

function load(state: MapState): number {
  return Math.floor((state.capacity * MAX_LOAD) / 100) - state.available;
}

function growIfNeeded(
  frame: Frame,
  state: MapState,
  count: number,
  keyType: Type,
  valueType: Type,
  kind: KeyKind
): boolean {
  if (count > state.available)
    return grow(frame, state, capacityForSize(load(state) + count), keyType, valueType, kind);
  return true;
}

/** `getOrPut`: the slot of a key, adding it (without a value) when absent; undefined when allocation fails. */
function getOrPut(
  frame: Frame,
  state: MapState,
  key: Value,
  keyType: Type,
  valueType: Type,
  kind: KeyKind
): { index: number; found: boolean } | undefined {
  if (!growIfNeeded(frame, state, 1, keyType, valueType, kind)) {
    const index = getIndex(frame, state, key, keyType, kind);
    return index === -1 ? undefined : { index, found: true };
  }
  const hash = hashOf(frame, key, keyType, kind);
  const mask = state.capacity - 1;
  const print = fingerprint(hash);
  let limit = state.capacity;
  let index = Number(hash & BigInt(mask));
  let firstTombstone = state.capacity;
  while (state.metadata[index] !== 0 && limit !== 0) {
    frame.runtime.spend();
    if (state.metadata[index] === (0x80 | print)) {
      if (keysEqual(frame, key, state.keys.slots[index], kind)) return { index, found: true };
    } else if (firstTombstone === state.capacity && state.metadata[index] === 1) {
      firstTombstone = index;
    }
    limit--;
    index = (index + 1) & mask;
  }
  if (firstTombstone < state.capacity) index = firstTombstone;
  state.available--;
  state.metadata[index] = 0x80 | print;
  frame.runtime.spend(transferCost(keyType) + transferCost(valueType));
  storeMapSlot(frame, state.keys, index, undefinedValue(keyType), keyType);
  storeMapSlot(frame, state.values, index, undefinedValue(valueType), valueType);
  state.size++;
  return { index, found: false };
}

function removeAt(frame: Frame, state: MapState, index: number, keyType: Type, valueType: Type): void {
  state.metadata[index] = 1;
  frame.runtime.spend(transferCost(keyType) + transferCost(valueType));
  storeMapSlot(frame, state.keys, index, undefinedValue(keyType), keyType);
  storeMapSlot(frame, state.values, index, undefinedValue(valueType), valueType);
  state.size--;
  state.available++;
}

// Types -----------------------------------------------------------------------------------------------------------------

interface MapTypes {
  map: StructType;
  entry: StructType;
  kv: StructType;
  getOrPutResult: StructType;
  iterator: StructType;
  keyIterator: StructType;
  valueIterator: StructType;
}

const mapTypes = new WeakValueMap<string, StructType>();

/** A hash map's type for its key and value types, managed (holding its allocator) or not. */
function hashMapType(name: string, keyType: Type, valueType: Type, kind: KeyKind, managed: boolean): StructType {
  const key = `${name} ${typeId(keyType)} ${typeId(valueType)}`;
  const existing = mapTypes.get(key);
  if (existing) return existing;
  const keyPointer = pointerTo(keyType, false);
  const valuePointer = pointerTo(valueType, false);
  const entry = nativeStruct(`${name}.Entry`, {}, [
    { name: 'key_ptr', type: keyPointer, hasDefault: false },
    { name: 'value_ptr', type: valuePointer, hasDefault: false },
  ]);
  const kv = nativeStruct(`${name}.KV`, {}, [
    { name: 'key', type: keyType, hasDefault: false },
    { name: 'value', type: valueType, hasDefault: false },
  ]);
  const getOrPutResult = nativeStruct(`${name}.GetOrPutResult`, {}, [
    { name: 'key_ptr', type: keyPointer, hasDefault: false },
    { name: 'value_ptr', type: valuePointer, hasDefault: false },
    { name: 'found_existing', type: BOOL, hasDefault: false },
  ]);
  const map = nativeStruct(`${name}(${typeName(keyType)},${typeName(valueType)})`, {}, [], {
    kind: 'hashMap',
    defaultValue: managed ? undefined : () => emptyMapValue(),
    storageSlots: managed ? 5 : 4,
    byteSize: managed ? 40 : 24,
    args: [keyType, valueType],
  });
  const iterator = nativeStruct(`${name}.Iterator`, {}, [], {
    kind: 'hashMapIterator',
    args: [],
    storageSlots: 2,
    byteSize: 16,
  });
  const keyIterator = nativeStruct(`${name}.KeyIterator`, {}, [], {
    kind: 'hashMapIterator',
    args: [],
    storageSlots: 2,
    byteSize: 24,
  });
  const valueIterator = nativeStruct(`${name}.ValueIterator`, {}, [], {
    kind: 'hashMapIterator',
    args: [],
    storageSlots: 2,
    byteSize: 24,
  });
  const types: MapTypes = { map, entry, kv, getOrPutResult, iterator, keyIterator, valueIterator };
  mapTypes.set(key, map);
  defineMembers(types, keyType, valueType, kind, managed);
  return map;
}

/** The state of the map a method is called on, by value or through a pointer. */
// code-gauge-allow functionCognitiveComplexity 16 -- Validates the receiver and selects value or pointer semantics together.
function stateOf(
  sema: SemaApi,
  receiver: TExpr | undefined,
  type: StructType,
  span: Span,
  mutable: boolean
): (frame: Frame) => MapState {
  if (!receiver) return sema.error(span, `${type.namespace.name} の値に対して呼び出してください。`);
  const evaluate = receiver.eval;
  if (receiver.type.kind === 'pointer' && receiver.type.child === type) {
    if (mutable && receiver.type.isConst)
      sema.error(span, '定数のハッシュマップは変更できません（var で宣言してください）。');
    return (frame) => {
      const value = (evaluate(frame) as Pointer).load();
      return readMapState(mutable ? value : copyForFrame(frame, value, type));
    };
  }
  if (receiver.type !== type) return sema.error(span, `${type.namespace.name} の値に対して呼び出してください。`);
  if (mutable) {
    const address = sema.addressOf(receiver);
    if (address.type.kind === 'pointer' && address.type.isConst)
      sema.error(span, 'ハッシュマップは var で宣言してください。');
  }
  return (frame) => {
    const value = evaluate(frame);
    return readMapState(mutable ? value : copyForFrame(frame, value, type));
  };
}

function defineMembers(types: MapTypes, keyType: Type, valueType: Type, kind: KeyKind, managed: boolean): void {
  const { map, entry, kv, getOrPutResult, iterator, keyIterator, valueIterator } = types;
  /** A method: the allocator comes first for unmanaged maps' allocating methods. */
  const method = (
    name: string,
    options: { args: Type[]; result: Type; mutable: boolean; allocates?: boolean },
    run: (state: MapState, args: Value[], frame: Frame) => Value
  ): (() => Member) =>
    fnMember(`${map.namespace.name}.${name}`, (sema, call) => {
      sema.resolveStorage(keyType, call.span);
      sema.resolveStorage(valueType, call.span);
      if (kind === 'auto' && options.args.includes(keyType)) validateAutoKey(sema, keyType, call.span);
      const takesAllocator = options.allocates === true && !managed;
      const expected = takesAllocator ? [ALLOCATOR, ...options.args] : options.args;
      const args = compileArgs(sema, expectArgs(sema, call, expected.length, name), expected);
      const state = stateOf(sema, call.receiver, map, call.span, options.mutable);
      const transfers = args.map((arg) => {
        const evaluate = arg.eval;
        const cost = transferCost(arg.type);
        return {
          ...arg,
          eval: (frame: Frame) => {
            const value = evaluate(frame);
            frame.runtime.spend(cost);
            return value;
          },
        };
      });
      return nativeStateCall(options.result, transfers, call.span, state, (received, values, frame) => {
        if (takesAllocator) received.allocator = allocatorState(values[0]);
        return run(received, values.slice(takesAllocator ? 1 : 0), frame);
      });
    });
  const members: Record<string, () => Member> = {
    Entry: () => ({ type: TYPE, value: entry }),
    KV: () => ({ type: TYPE, value: kv }),
    GetOrPutResult: () => ({ type: TYPE, value: getOrPutResult }),
    Iterator: () => ({ type: TYPE, value: iterator }),
    Size: () => ({ type: TYPE, value: U32 }),
    deinit: method('deinit', { args: [], result: VOID, mutable: true, allocates: true }, (state) => {
      if (state.memory) freeMemory(state.allocator, state.memory);
      Object.assign(state, emptyState());
      return;
    }),
    put: method(
      'put',
      { args: [keyType, valueType], result: allocating(VOID), mutable: true, allocates: true },
      (state, [key, value], frame) => {
        const slot = getOrPut(frame, state, key, keyType, valueType, kind);
        if (!slot) return ERROR_OUT_OF_MEMORY;
        if (!slot.found) storeMapSlot(frame, state.keys, slot.index, key, keyType);
        storeMapSlot(frame, state.values, slot.index, value, valueType);
        return;
      }
    ),
    putNoClobber: method(
      'putNoClobber',
      { args: [keyType, valueType], result: allocating(VOID), mutable: true, allocates: true },
      (state, [key, value], frame) => {
        const slot = getOrPut(frame, state, key, keyType, valueType, kind);
        if (!slot) return ERROR_OUT_OF_MEMORY;
        if (slot.found) panic('reached unreachable code');
        storeMapSlot(frame, state.keys, slot.index, key, keyType);
        storeMapSlot(frame, state.values, slot.index, value, valueType);
        return;
      }
    ),
    fetchPut: method(
      'fetchPut',
      {
        args: [keyType, valueType],
        result: allocating(optionalOf(kv)),
        mutable: true,
        allocates: true,
      },
      (state, [key, value], frame) => {
        const slot = getOrPut(frame, state, key, keyType, valueType, kind);
        if (!slot) return ERROR_OUT_OF_MEMORY;
        const previous = slot.found ? snapshotEntry(frame, state, slot.index, keyType, valueType) : NULL;
        if (!slot.found) storeMapSlot(frame, state.keys, slot.index, key, keyType);
        storeMapSlot(frame, state.values, slot.index, value, valueType);
        return previous;
      }
    ),
    getOrPut: method(
      'getOrPut',
      { args: [keyType], result: allocating(getOrPutResult), mutable: true, allocates: true },
      (state, [key], frame) => {
        const slot = getOrPut(frame, state, key, keyType, valueType, kind);
        if (!slot) return ERROR_OUT_OF_MEMORY;
        if (!slot.found) storeMapSlot(frame, state.keys, slot.index, key, keyType);
        return new ZStruct([new Pointer(state.keys, slot.index), new Pointer(state.values, slot.index), slot.found]);
      }
    ),
    getOrPutValue: method(
      'getOrPutValue',
      { args: [keyType, valueType], result: allocating(entry), mutable: true, allocates: true },
      (state, [key, value], frame) => {
        const slot = getOrPut(frame, state, key, keyType, valueType, kind);
        if (!slot) return ERROR_OUT_OF_MEMORY;
        if (!slot.found) {
          storeMapSlot(frame, state.keys, slot.index, key, keyType);
          storeMapSlot(frame, state.values, slot.index, value, valueType);
        }
        return new ZStruct([new Pointer(state.keys, slot.index), new Pointer(state.values, slot.index)]);
      }
    ),
    get: method('get', { args: [keyType], result: optionalOf(valueType), mutable: false }, (state, [key], frame) => {
      const index = getIndex(frame, state, key, keyType, kind);
      return index === -1 ? NULL : optionalSome(state.values.slots[index], valueType);
    }),
    getPtr: method(
      'getPtr',
      { args: [keyType], result: optionalOf(pointerTo(valueType, false)), mutable: false },
      (state, [key], frame) => {
        const index = getIndex(frame, state, key, keyType, kind);
        return index === -1 ? NULL : new Pointer(state.values, index);
      }
    ),
    getKey: method(
      'getKey',
      { args: [keyType], result: optionalOf(keyType), mutable: false },
      (state, [key], frame) => {
        const index = getIndex(frame, state, key, keyType, kind);
        return index === -1 ? NULL : optionalSome(state.keys.slots[index], keyType);
      }
    ),
    getEntry: method(
      'getEntry',
      { args: [keyType], result: optionalOf(entry), mutable: false },
      (state, [key], frame) => {
        const index = getIndex(frame, state, key, keyType, kind);
        return index === -1 ? NULL : new ZStruct([new Pointer(state.keys, index), new Pointer(state.values, index)]);
      }
    ),
    contains: method(
      'contains',
      { args: [keyType], result: BOOL, mutable: false },
      (state, [key], frame) => getIndex(frame, state, key, keyType, kind) !== -1
    ),
    remove: method('remove', { args: [keyType], result: BOOL, mutable: true }, (state, [key], frame) => {
      const index = getIndex(frame, state, key, keyType, kind);
      if (index === -1) return false;
      removeAt(frame, state, index, keyType, valueType);
      return true;
    }),
    fetchRemove: method(
      'fetchRemove',
      { args: [keyType], result: optionalOf(kv), mutable: true },
      (state, [key], frame) => {
        const index = getIndex(frame, state, key, keyType, kind);
        if (index === -1) return NULL;
        const removed = snapshotEntry(frame, state, index, keyType, valueType);
        removeAt(frame, state, index, keyType, valueType);
        return removed;
      }
    ),
    count: method('count', { args: [], result: U32, mutable: false }, (state) => BigInt(state.size)),
    capacity: method('capacity', { args: [], result: U32, mutable: false }, (state) => BigInt(state.capacity)),
    clearRetainingCapacity: method(
      'clearRetainingCapacity',
      { args: [], result: VOID, mutable: true },
      (state, _args, frame) => {
        frame.runtime.spend(state.capacity * (1 + valueSlots(keyType) + valueSlots(valueType)));
        state.metadata.fill(0);
        for (let index = 0; index < state.capacity; index++) {
          state.keys.slots[index] = undefinedValue(keyType);
          state.values.slots[index] = undefinedValue(valueType);
        }
        state.size = 0;
        state.available = Math.floor((state.capacity * MAX_LOAD) / 100);
        return;
      }
    ),
    clearAndFree: method('clearAndFree', { args: [], result: VOID, mutable: true, allocates: true }, (state) => {
      if (state.memory) freeMemory(state.allocator, state.memory);
      Object.assign(state, emptyState());
      return;
    }),
    ensureTotalCapacity: method(
      'ensureTotalCapacity',
      { args: [U32], result: allocating(VOID), mutable: true, allocates: true },
      (state, [size], frame) => {
        const wanted = Number(size as bigint);
        if (wanted > state.size && !growIfNeeded(frame, state, wanted - state.size, keyType, valueType, kind))
          return ERROR_OUT_OF_MEMORY;
        return;
      }
    ),
    iterator: method(
      'iterator',
      { args: [], result: iterator, mutable: false },
      (state) => new ZStruct([new NativeHandle('mapIterator', state), 0n])
    ),
    keyIterator: method(
      'keyIterator',
      { args: [], result: keyIterator, mutable: false },
      (state) => new ZStruct([new NativeHandle('mapIterator', state), 0n])
    ),
    valueIterator: method(
      'valueIterator',
      { args: [], result: valueIterator, mutable: false },
      (state) => new ZStruct([new NativeHandle('mapIterator', state), 0n])
    ),
  };
  if (managed) {
    members.init = fnMember(`${map.namespace.name}.init`, (sema, call) => {
      const [allocator] = compileArgs(sema, expectArgs(sema, call, 1, 'init'), [ALLOCATOR]);
      return nativeCall(map, [allocator], call.span, ([value]) => emptyMapValue(value));
    });
  } else {
    members.empty = () => ({ type: map, value: emptyMapValue() });
  }
  addMembers(map, members);
  addMembers(
    iterator,
    nextMember(
      iterator,
      optionalOf(entry),
      advance((state, index) => new ZStruct([new Pointer(state.keys, index), new Pointer(state.values, index)]))
    )
  );
  addMembers(
    keyIterator,
    nextMember(
      keyIterator,
      optionalOf(pointerTo(keyType, false)),
      advance((state, index) => new Pointer(state.keys, index))
    )
  );
  addMembers(
    valueIterator,
    nextMember(
      valueIterator,
      optionalOf(pointerTo(valueType, false)),
      advance((state, index) => new Pointer(state.values, index))
    )
  );
}

/** An iterator's `next`: the entry of the next used slot from the iterator's index. */
function advance(returns: (state: MapState, index: number) => Value): (iteratorState: ZStruct, frame: Frame) => Value {
  return (iteratorState, frame) => {
    const state = (iteratorState.slots[0] as NativeHandle).state as MapState;
    let index = Number(iteratorState.slots[1] as bigint);
    if (state.size === 0) return NULL;
    while (index < state.capacity) {
      frame.runtime.spend();
      if ((state.metadata[index] & 0x80) !== 0) {
        iteratorState.slots[1] = BigInt(index + 1);
        return returns(state, index);
      }
      index++;
    }
    iteratorState.slots[1] = BigInt(index);
    return NULL;
  };
}

function nextMember(
  type: StructType,
  result: Type,
  run: (iteratorState: ZStruct, frame: Frame) => Value
): Record<string, () => Member> {
  return {
    next: fnMember(`${type.namespace.name}.next`, (sema, call) => {
      expectArgs(sema, call, 0, 'next');
      const receiver = call.receiver;
      if (!receiver) return sema.error(call.span, 'イテレータに対して呼び出してください。');
      let pointer = receiver;
      if (receiver.type === type) pointer = sema.addressOf(receiver);
      if (pointer.type.kind !== 'pointer' || pointer.type.child !== type)
        return sema.error(call.span, 'イテレータに対して呼び出してください。');
      if (pointer.type.isConst) sema.error(call.span, 'イテレータは var で宣言してください。');
      const evaluate = pointer.eval;
      return runtime(
        result,
        (frame) => {
          frame.runtime.spend();
          return run((evaluate(frame) as Pointer).load() as ZStruct, frame);
        },
        call.span
      );
    }),
  };
}

function emptyMapValue(allocator?: Value): ZStruct {
  const state = emptyState();
  const slots: Value[] = [
    0,
    0,
    0,
    new NativeHandle('hashMapAllocation', { metadata: state.metadata, keys: state.keys, values: state.values }),
  ];
  if (allocator !== undefined) slots.push(allocator);
  return new ZStruct(slots);
}

function readMapState(value: Value): MapState {
  const header = value as ZStruct;
  const state = {
    header,
    allocator: header.slots[4] instanceof NativeHandle ? allocatorState(header.slots[4]) : undefined,
  } as MapState;
  for (const [index, name] of ['capacity', 'size', 'available'].entries()) {
    Object.defineProperty(state, name, {
      enumerable: true,
      get: () => header.slots[index],
      set: (value: number) => {
        header.slots[index] = value;
      },
    });
  }
  for (const name of ['metadata', 'keys', 'values', 'memory']) {
    Object.defineProperty(state, name, {
      enumerable: true,
      get: () => (header.slots[3] as NativeHandle).state[name],
      set: (value: unknown) => {
        header.slots[3] = new NativeHandle('hashMapAllocation', {
          ...(header.slots[3] as NativeHandle).state,
          [name]: value,
        });
      },
    });
  }
  return state;
}

function allocating(type: Type): Type {
  return errorUnionOf(ALLOCATOR_ERROR, type);
}

function mapFactory(name: string, kind: KeyKind, managed: boolean): () => Member {
  const count = kind === 'string' ? 1 : 2;
  return fnMember(`std.${name}`, (sema, call) => {
    const args = expectArgs(sema, call, count, `std.${name}`);
    const types = args.map((arg: Expression) => sema.compileType(arg));
    const [keyType, valueType] = kind === 'string' ? [CONST_U8_SLICE, types[0]] : types;
    if (kind === 'auto' && keyType.kind === 'pointer' && keyType.size === 'slice') {
      sema.error(call.span, 'スライスをキーにするときは、std.StringHashMap を使ってください。');
    }
    return known(TYPE, hashMapType(name, keyType, valueType, kind, managed), call.span);
  });
}

// code-gauge-allow functionNcss 34 -- Checks the supported key representations recursively before a hashing operation.
function validateAutoKey(sema: SemaApi, type: Type, span: Span): void {
  if (hasPhysicalHashLayout(type, (cost) => sema.spendCompilation(cost))) return;
  switch (type.kind) {
    case 'void':
    case 'int':
    case 'bool':
    case 'enum':
    case 'error_set':
    case 'fn': {
      return;
    }
    case 'pointer': {
      if (type.size === 'slice') sema.error(span, 'スライスをキーにするときは、std.StringHashMap を使ってください。');
      return;
    }
    case 'optional':
    case 'array': {
      validateAutoKey(sema, type.child, span);
      return;
    }
    case 'error_union': {
      validateAutoKey(sema, type.payload, span);
      return;
    }
    case 'struct': {
      for (const field of type.fields ?? []) validateAutoKey(sema, field.type, span);
      return;
    }
    case 'union': {
      if (!type.tagType) sema.error(span, 'タグのない共用体は、自動ハッシュのキーにできません。');
      for (const field of type.fields ?? []) validateAutoKey(sema, field.type, span);
      return;
    }
    default: {
      sema.error(span, `${typeName(type)} 型は、自動ハッシュのキーにできません。`);
    }
  }
}

export const HASH_MAP_MEMBERS: Record<string, () => Member> = {
  AutoHashMap: mapFactory('AutoHashMap', 'auto', true),
  AutoHashMapUnmanaged: mapFactory('AutoHashMapUnmanaged', 'auto', false),
  StringHashMap: mapFactory('StringHashMap', 'string', true),
  StringHashMapUnmanaged: mapFactory('StringHashMapUnmanaged', 'string', false),
};

export { ErrorValue, sliceOf };
