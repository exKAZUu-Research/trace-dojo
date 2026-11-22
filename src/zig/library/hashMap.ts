// code-gauge-allow-file fileNcss -- Keeps hash-map state, storage layout, and public method registration together.
import { allocationSlots, transferCost } from '../allocation';
import { type ByteRegion, reserveAllocatorBytes } from '../allocatorStorage';
// code-gauge-allow-file duplicateLines -- Library types repeat the same shape of method on purpose, each over its own state.
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
  fnType,
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
  registerNativeReferences,
  Slice,
  type Slots,
  storeInto,
  type Value,
  ZArray,
  ZStruct,
} from '../values';
import { WeakValueMap } from '../weakValueMap';
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
  receiverAddress,
} from './native';
import { validateEquality, valuesEqual } from './valueEquality';

type KeyKind = 'auto' | 'string';

interface MapState extends Record<string, unknown> {
  capacity: number;
  metadata: MapMetadata;
  keys: ZArray;
  values: ZArray;
  size: number;
  available: number;
  allocator?: AllocatorState;
  memory?: object;
  header?: ZStruct;
}

class MapMetadata {
  readonly occupied = new Set<number>();

  constructor(
    private readonly bytes: Uint8Array | Slice,
    private readonly offset = 0,
    private readonly length = bytes.length
  ) {}

  get(index: number): number {
    const { bytes, offset } = this;
    return bytes instanceof Slice ? Number(bytes.get(offset + index)) : bytes[index];
  }

  set(index: number, value: number): void {
    const { bytes, offset } = this;
    if (bytes instanceof Slice) bytes.set(offset + index, BigInt(value));
    else bytes[index] = value;
    if ((value & 0x80) === 0) this.occupied.delete(index);
    else this.occupied.add(index);
  }

  clear(): void {
    const { bytes, offset, length } = this;
    if (bytes instanceof Slice) {
      for (let index = 0; index < length; index++) bytes.set(offset + index, 0n);
    } else {
      bytes.fill(0);
    }
    this.occupied.clear();
  }
}

const MINIMAL_CAPACITY = 8;
const MAX_LOAD = 80;

function hashOf(frame: Frame, key: Value, keyType: Type, kind: KeyKind): bigint {
  const spend = (cost?: number): void => frame.runtime.spend(cost);
  if (kind === 'string') {
    const slice = key as Slice;
    return wyhash(0n, slice.length, (index) => Number(slice.get(index) as bigint), spend);
  }
  const bytes = autoHashBytes(key, keyType, (value) => frame.runtime.identityOf(value), spend);
  return wyhash(0n, bytes.length, (index) => bytes[index], spend);
}

function keysEqual(frame: Frame, a: Value, b: Value, type: Type, kind: KeyKind): boolean {
  if (kind === 'string') {
    frame.runtime.spend();
    return stringKeysEqual(frame, a as Slice, b as Slice);
  }
  return valuesEqual(type, a, b, (cost) => frame.runtime.spend(cost));
}

function stringKeysEqual(frame: Frame, x: Slice, y: Slice): boolean {
  if (x.lengthValue !== y.lengthValue) return false;
  for (let index = 0; index < x.length; index++) {
    frame.runtime.spend(3);
    if (x.get(index) !== y.get(index)) return false;
  }
  return true;
}

function storeMapSlot(frame: Frame, storage: Slots, index: number, value: Value, type: Type): void {
  frame.runtime.spend(2 * transferCost(type));
  storeInto(storage, index, value);
}

function snapshotEntry(frame: Frame, state: MapState, index: number, keyType: Type, valueType: Type): ZStruct {
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
    metadata: new MapMetadata(new Uint8Array(0)),
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
  while (state.metadata.get(index) !== 0 && limit !== 0) {
    frame.runtime.spend();
    if (state.metadata.get(index) === (0x80 | print) && keysEqual(frame, key, state.keys.slots[index], keyType, kind))
      return index;
    limit--;
    index = (index + 1) & mask;
  }
  return -1;
}

// code-gauge-allow functionParameterCount -- Rehashing binds both typed payloads to the table, runtime and key strategy.
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
  while ((state.metadata.get(index) & 0x80) !== 0) {
    frame.runtime.spend();
    index = (index + 1) & mask;
  }
  state.available--;
  state.metadata.set(index, 0x80 | fingerprint(hash));
  storeMapSlot(frame, state.keys, index, key, keyType);
  storeMapSlot(frame, state.values, index, value, valueType);
  state.size++;
}

/** Grows the table to a new capacity, reinserting the used entries in slot order. */
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
  const { metadata, keys, values } = initializeMapStorage(frame, reserved.region, capacity, layout, keyType, valueType);
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
    if ((old.metadata.get(index) & 0x80) === 0) continue;
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

function initializeMapStorage(
  frame: Frame,
  region: ByteRegion | undefined,
  capacity: number,
  layout: ReturnType<typeof mapAllocationLayout>,
  keyType: Type,
  valueType: Type
): Pick<MapState, 'metadata' | 'keys' | 'values'> {
  if (!region) {
    frame.runtime.spend(capacity * (1 + transferCost(keyType) + transferCost(valueType)));
    return {
      metadata: new MapMetadata(new Uint8Array(capacity)),
      keys: new ZArray(Array.from({ length: capacity }, () => undefinedValue(keyType))),
      values: new ZArray(Array.from({ length: capacity }, () => undefinedValue(valueType))),
    };
  }
  const { buffer, offset } = region;
  frame.runtime.spend(capacity + 4);
  const metadata = new MapMetadata(buffer, offset + 24, capacity);
  metadata.clear();
  for (let index = 0; index < 4; index++) buffer.set(offset + 16 + index, BigInt((capacity >>> (index * 8)) & 255));
  const keys = new ZArray([], 0, capacity);
  const values = new ZArray([], 0, capacity);
  bindBufferMemory(keys, keyType, capacity, buffer, offset + layout.keys, frame.runtime, 0);
  bindBufferMemory(values, valueType, capacity, buffer, offset + layout.values, frame.runtime, 0);
  return { metadata, keys, values };
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
  while (state.metadata.get(index) !== 0 && limit !== 0) {
    frame.runtime.spend();
    if (state.metadata.get(index) === (0x80 | print)) {
      if (keysEqual(frame, key, state.keys.slots[index], keyType, kind)) return { index, found: true };
    } else if (firstTombstone === state.capacity && state.metadata.get(index) === 1) {
      firstTombstone = index;
    }
    limit--;
    index = (index + 1) & mask;
  }
  if (firstTombstone < state.capacity) index = firstTombstone;
  state.available--;
  state.metadata.set(index, 0x80 | print);
  frame.runtime.spend(transferCost(keyType) + transferCost(valueType));
  storeMapSlot(frame, state.keys, index, undefinedValue(keyType), keyType);
  storeMapSlot(frame, state.values, index, undefinedValue(valueType), valueType);
  state.size++;
  return { index, found: false };
}

function removeAt(frame: Frame, state: MapState, index: number, keyType: Type, valueType: Type): void {
  state.metadata.set(index, 1);
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
    defaultValue: managed ? undefined : () => emptyMapValue(map),
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
// code-gauge-allow functionCognitiveComplexity -- Validates the receiver and selects value or pointer semantics together.
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
      return readMapState(mutable ? value : copyForFrame(frame, value, type), type);
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
    return readMapState(mutable ? value : copyForFrame(frame, value, type), type);
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
    fnMember(
      `${map.namespace.name}.${name}`,
      (sema, call) => {
        sema.resolveStorage(keyType, call.span);
        sema.resolveStorage(valueType, call.span);
        if (kind === 'auto' && options.args.includes(keyType)) {
          validateAutoKey(sema, keyType, call.span);
          validateEquality(sema, keyType, call.span);
        }
        const takesAllocator = options.allocates === true && !managed;
        const expected = takesAllocator ? [ALLOCATOR, ...options.args] : options.args;
        const args = compileArgs(sema, expectArgs(sema, call, expected.length, name), expected);
        const state = stateOf(sema, call.receiver, map, call.span, options.mutable);
        return nativeStateCall(options.result, args, call.span, state, (received, values, frame) => {
          if (takesAllocator) received.allocator = allocatorState(values[0]);
          return run(received, values.slice(takesAllocator ? 1 : 0), frame);
        });
      },
      () => ({
        type: fnType(
          [
            name === 'iterator' ? pointerTo(map, true) : options.mutable ? pointerTo(map, false) : map,
            ...(options.allocates && !managed ? [ALLOCATOR] : []),
            ...options.args,
          ],
          options.result
        ),
        receiver: true,
      })
    );
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
        frame.runtime.spend(state.capacity);
        state.metadata.clear();
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
    iterator: method('iterator', { args: [], result: iterator, mutable: false }, mapIteratorValue),
    keyIterator: method('keyIterator', { args: [], result: keyIterator, mutable: false }, mapIteratorValue),
    valueIterator: method('valueIterator', { args: [], result: valueIterator, mutable: false }, mapIteratorValue),
  };
  if (managed) {
    members.init = fnMember(
      `${map.namespace.name}.init`,
      (sema, call) => {
        const [allocator] = compileArgs(sema, expectArgs(sema, call, 1, 'init'), [ALLOCATOR]);
        return nativeCall(map, [allocator], call.span, ([value]) => emptyMapValue(map, value));
      },
      () => ({ type: fnType([ALLOCATOR], map) })
    );
  } else {
    members.empty = () => ({ type: map, value: emptyMapValue(map) });
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
      if ((state.metadata.get(index) & 0x80) !== 0) {
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
    next: fnMember(
      `${type.namespace.name}.next`,
      (sema, call) => {
        expectArgs(sema, call, 0, 'next');
        const pointer = receiverAddress(sema, call, type);
        const evaluate = pointer.eval;
        return runtime(
          result,
          (frame) => {
            frame.runtime.spend();
            return run((evaluate(frame) as Pointer).load() as ZStruct, frame);
          },
          call.span
        );
      },
      () => ({ type: fnType([pointerTo(type, false)], result), receiver: true })
    ),
  };
}

function mapIteratorValue(state: MapState): ZStruct {
  return new ZStruct([new NativeHandle('mapIterator', state), 0n]);
}

function emptyMapValue(type: StructType, allocator?: Value): ZStruct {
  const state = emptyState();
  const allocation = mapAllocation({ metadata: state.metadata, keys: state.keys, values: state.values }, type);
  const slots: Value[] = [0, 0, 0, allocation];
  if (allocator !== undefined) slots.push(allocator);
  return new ZStruct(slots);
}

function readMapState(value: Value, type: StructType): MapState {
  const header = value as ZStruct;
  const state = {
    header,
    allocator: header.slots[4] instanceof NativeHandle ? allocatorState(header.slots[4]) : undefined,
  } as MapState;
  registerNativeReferences(state, () => [{ value: header, type }]);
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
        header.slots[3] = mapAllocation({ ...(header.slots[3] as NativeHandle).state, [name]: value }, type);
      },
    });
  }
  return state;
}

function mapAllocation(state: Record<string, unknown>, type: StructType): NativeHandle {
  const [keyType, valueType] = type.native!.args;
  registerNativeReferences(state, function* (spend, mayContainTurtles) {
    const visitKeys = mayContainTurtles(keyType);
    const visitValues = mayContainTurtles(valueType);
    if (!visitKeys && !visitValues) return;
    const metadata = state.metadata as MapMetadata;
    for (const index of metadata.occupied) {
      spend();
      if ((metadata.get(index) & 0x80) === 0) continue;
      if (visitKeys) yield { value: (state.keys as ZArray).get(index), type: keyType };
      if (visitValues) yield { value: (state.values as ZArray).get(index), type: valueType };
    }
  });
  return new NativeHandle('hashMapAllocation', state);
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

// code-gauge-allow functionNcss -- Validates each key representation once per slice policy before hashing.
function validateAutoKey(
  sema: SemaApi,
  type: Type,
  span: Span,
  rejectSlices = true,
  seen = new Map<boolean, Set<Type>>()
): void {
  sema.spendCompilation();
  let visited = seen.get(rejectSlices);
  if (!visited) {
    visited = new Set();
    seen.set(rejectSlices, visited);
  }
  if (visited.has(type)) return;
  visited.add(type);
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
      if (rejectSlices && type.size === 'slice')
        sema.error(span, 'スライスをキーにするときは、std.StringHashMap を使ってください。');
      return;
    }
    case 'array': {
      if (type.length !== 0n) validateAutoKey(sema, type.child, span, false, seen);
      return;
    }
    case 'optional': {
      validateAutoKey(sema, type.child, span, false, seen);
      return;
    }
    case 'error_union': {
      validateAutoKey(sema, type.payload, span, false, seen);
      return;
    }
    case 'struct': {
      for (const field of type.fields ?? []) validateAutoKey(sema, field.type, span, rejectSlices, seen);
      return;
    }
    case 'union': {
      if (!type.tagType) sema.error(span, 'タグのない共用体は、自動ハッシュのキーにできません。');
      for (const field of type.fields ?? []) validateAutoKey(sema, field.type, span, rejectSlices, seen);
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
