// code-gauge-allow-file duplicateLines 19 -- Library types repeat the same shape of method on purpose, each over its own state.
import { panic } from '../arith';
import type { Expression, Span } from '../ast';
import type { Frame } from '../runtime';
import { copyForStorage, known, runtime, type SemaApi, type TExpr, undefinedValue } from '../semaBase';
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
import { ErrorValue, NativeHandle, NULL, Pointer, type Value, ZArray, ZStruct } from '../values';
import { WeakValueMap } from '../weakValueMap';
import { elements, equalValues } from './common';
import { autoHashBytes, wyhash } from './hashing';
import { ALLOCATOR, ALLOCATOR_ERROR, ERROR_OUT_OF_MEMORY } from './heap';
import { compileArgs, expectArgs, fnMember, type Member, nativeStruct } from './native';

type KeyKind = 'auto' | 'string';

interface MapState extends Record<string, unknown> {
  capacity: number;
  /** 0 for free, 1 for a tombstone, and 0x80 | fingerprint for a used slot, as Zig's `Metadata` bytes. */
  metadata: number[];
  keys: ZArray;
  values: ZArray;
  size: number;
  available: number;
}

const MINIMAL_CAPACITY = 8;
const MAX_LOAD = 80;

function hashOf(key: Value, keyType: Type, kind: KeyKind): bigint {
  const bytes = kind === 'string' ? elements(key).map((byte) => Number(byte as bigint)) : autoHashBytes(key, keyType);
  return wyhash(0n, bytes);
}

function keysEqual(a: Value, b: Value, kind: KeyKind): boolean {
  if (kind === 'string') {
    const x = elements(a);
    const y = elements(b);
    return x.length === y.length && x.every((value, index) => value === y[index]);
  }
  if (a instanceof ZStruct && b instanceof ZStruct)
    return a.slots.every((value, index) => equalValues(value, b.slots[index]));
  if (a instanceof ZArray && b instanceof ZArray)
    return a.values().every((value, index) => equalValues(value, b.get(index)));
  return equalValues(a, b);
}

function capacityForSize(size: number): number {
  const needed = Math.floor((size * 100) / MAX_LOAD) + 1;
  let capacity = 1;
  while (capacity < needed) capacity *= 2;
  return capacity;
}

function emptyState(keyType: Type, valueType: Type): MapState {
  void keyType;
  void valueType;
  return {
    capacity: 0,
    metadata: [],
    keys: new ZArray([]),
    values: new ZArray([]),
    size: 0,
    available: 0,
  };
}

function fingerprint(hash: bigint): number {
  return Number(hash >> 57n);
}

function getIndex(state: MapState, key: Value, keyType: Type, kind: KeyKind): number {
  if (state.size === 0) return -1;
  const hash = hashOf(key, keyType, kind);
  const mask = state.capacity - 1;
  const print = fingerprint(hash);
  let limit = state.capacity;
  let index = Number(hash & BigInt(mask));
  while (state.metadata[index] !== 0 && limit !== 0) {
    if (state.metadata[index] === (0x80 | print) && keysEqual(key, state.keys.slots[index], kind)) return index;
    limit--;
    index = (index + 1) & mask;
  }
  return -1;
}

function putNoClobber(state: MapState, key: Value, value: Value, keyType: Type, kind: KeyKind): void {
  const hash = hashOf(key, keyType, kind);
  const mask = state.capacity - 1;
  let index = Number(hash & BigInt(mask));
  while ((state.metadata[index] & 0x80) !== 0) index = (index + 1) & mask;
  state.available--;
  state.metadata[index] = 0x80 | fingerprint(hash);
  state.keys.slots[index] = key;
  state.values.slots[index] = value;
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
  if (!frame.runtime.canAllocate(capacity * 2)) return false;
  frame.runtime.allocate(capacity * 2);
  const old = { ...state, metadata: state.metadata, keys: state.keys, values: state.values };
  state.capacity = capacity;
  state.metadata = Array.from<number>({ length: capacity }).fill(0);
  state.keys = new ZArray(Array.from({ length: capacity }, () => undefinedValue(keyType)));
  state.values = new ZArray(Array.from({ length: capacity }, () => undefinedValue(valueType)));
  state.available = Math.floor((capacity * MAX_LOAD) / 100);
  const size = old.size;
  state.size = 0;
  for (let index = 0; index < old.capacity && state.size < size; index++) {
    if ((old.metadata[index] & 0x80) === 0) continue;
    putNoClobber(state, old.keys.slots[index], old.values.slots[index], keyType, kind);
  }
  return true;
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
    const index = getIndex(state, key, keyType, kind);
    return index === -1 ? undefined : { index, found: true };
  }
  const hash = hashOf(key, keyType, kind);
  const mask = state.capacity - 1;
  const print = fingerprint(hash);
  let limit = state.capacity;
  let index = Number(hash & BigInt(mask));
  let firstTombstone = state.capacity;
  while (state.metadata[index] !== 0 && limit !== 0) {
    if (state.metadata[index] === (0x80 | print)) {
      if (keysEqual(key, state.keys.slots[index], kind)) return { index, found: true };
    } else if (firstTombstone === state.capacity && state.metadata[index] === 1) {
      firstTombstone = index;
    }
    limit--;
    index = (index + 1) & mask;
  }
  if (firstTombstone < state.capacity) index = firstTombstone;
  state.available--;
  state.metadata[index] = 0x80 | print;
  state.keys.slots[index] = undefinedValue(keyType);
  state.values.slots[index] = undefinedValue(valueType);
  state.size++;
  return { index, found: false };
}

function removeAt(state: MapState, index: number, keyType: Type, valueType: Type): void {
  state.metadata[index] = 1;
  state.keys.slots[index] = undefinedValue(keyType);
  state.values.slots[index] = undefinedValue(valueType);
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
    args: [keyType, valueType],
  });
  const iterator = nativeStruct(`${name}.Iterator`, {});
  const keyIterator = nativeStruct(`${name}.KeyIterator`, {});
  const valueIterator = nativeStruct(`${name}.ValueIterator`, {});
  const types: MapTypes = { map, entry, kv, getOrPutResult, iterator, keyIterator, valueIterator };
  mapTypes.set(key, map);
  defineMembers(types, keyType, valueType, kind, managed);
  return map;
}

function setMembers(type: StructType, members: Record<string, () => Member>): void {
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

/** The state of the map a method is called on, by value or through a pointer. */
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
    return (frame) => readMapState((evaluate(frame) as Pointer).load());
  }
  if (receiver.type !== type) return sema.error(span, `${type.namespace.name} の値に対して呼び出してください。`);
  if (mutable) {
    const address = sema.addressOf(receiver);
    if (address.type.kind === 'pointer' && address.type.isConst)
      sema.error(span, 'ハッシュマップは var で宣言してください。');
  }
  return (frame) => readMapState(evaluate(frame));
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
      const takesAllocator = options.allocates === true && !managed;
      const expected = takesAllocator ? [ALLOCATOR, ...options.args] : options.args;
      const args = compileArgs(sema, expectArgs(sema, call, expected.length, name), expected);
      const state = stateOf(sema, call.receiver, map, call.span, options.mutable);
      const evaluators = args.map((arg) => arg.eval).slice(takesAllocator ? 1 : 0);
      return runtime(
        options.result,
        (frame) => {
          frame.runtime.spend();
          return run(
            state(frame),
            evaluators.map((evaluate) => copyForStorage(evaluate(frame))),
            frame
          );
        },
        call.span
      );
    });
  const fresh = (): ZStruct => new ZStruct([new NativeHandle('hashMap', emptyState(keyType, valueType))]);
  const members: Record<string, () => Member> = {
    Entry: () => ({ type: TYPE, value: entry }),
    KV: () => ({ type: TYPE, value: kv }),
    GetOrPutResult: () => ({ type: TYPE, value: getOrPutResult }),
    Iterator: () => ({ type: TYPE, value: iterator }),
    Size: () => ({ type: TYPE, value: U32 }),
    deinit: method('deinit', { args: [], result: VOID, mutable: true, allocates: true }, (state) => {
      Object.assign(state, emptyState(keyType, valueType));
      return;
    }),
    put: method(
      'put',
      { args: [keyType, valueType], result: allocating(VOID), mutable: true, allocates: true },
      (state, [key, value], frame) => {
        const slot = getOrPut(frame, state, key, keyType, valueType, kind);
        if (!slot) return ERROR_OUT_OF_MEMORY;
        state.keys.slots[slot.index] = key;
        state.values.slots[slot.index] = value;
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
        state.keys.slots[slot.index] = key;
        state.values.slots[slot.index] = value;
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
        const previous = slot.found
          ? new ZStruct([state.keys.slots[slot.index], state.values.slots[slot.index]])
          : NULL;
        state.keys.slots[slot.index] = key;
        state.values.slots[slot.index] = value;
        return previous;
      }
    ),
    getOrPut: method(
      'getOrPut',
      { args: [keyType], result: allocating(getOrPutResult), mutable: true, allocates: true },
      (state, [key], frame) => {
        const slot = getOrPut(frame, state, key, keyType, valueType, kind);
        if (!slot) return ERROR_OUT_OF_MEMORY;
        if (!slot.found) state.keys.slots[slot.index] = key;
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
          state.keys.slots[slot.index] = key;
          state.values.slots[slot.index] = value;
        }
        return new ZStruct([new Pointer(state.keys, slot.index), new Pointer(state.values, slot.index)]);
      }
    ),
    get: method('get', { args: [keyType], result: optionalOf(valueType), mutable: false }, (state, [key]) => {
      const index = getIndex(state, key, keyType, kind);
      return index === -1 ? NULL : state.values.slots[index];
    }),
    getPtr: method(
      'getPtr',
      { args: [keyType], result: optionalOf(pointerTo(valueType, false)), mutable: false },
      (state, [key]) => {
        const index = getIndex(state, key, keyType, kind);
        return index === -1 ? NULL : new Pointer(state.values, index);
      }
    ),
    getKey: method('getKey', { args: [keyType], result: optionalOf(keyType), mutable: false }, (state, [key]) => {
      const index = getIndex(state, key, keyType, kind);
      return index === -1 ? NULL : state.keys.slots[index];
    }),
    getEntry: method('getEntry', { args: [keyType], result: optionalOf(entry), mutable: false }, (state, [key]) => {
      const index = getIndex(state, key, keyType, kind);
      return index === -1 ? NULL : new ZStruct([new Pointer(state.keys, index), new Pointer(state.values, index)]);
    }),
    contains: method(
      'contains',
      { args: [keyType], result: BOOL, mutable: false },
      (state, [key]) => getIndex(state, key, keyType, kind) !== -1
    ),
    remove: method('remove', { args: [keyType], result: BOOL, mutable: true }, (state, [key]) => {
      const index = getIndex(state, key, keyType, kind);
      if (index === -1) return false;
      removeAt(state, index, keyType, valueType);
      return true;
    }),
    fetchRemove: method('fetchRemove', { args: [keyType], result: optionalOf(kv), mutable: true }, (state, [key]) => {
      const index = getIndex(state, key, keyType, kind);
      if (index === -1) return NULL;
      const removed = new ZStruct([state.keys.slots[index], state.values.slots[index]]);
      removeAt(state, index, keyType, valueType);
      return removed;
    }),
    count: method('count', { args: [], result: U32, mutable: false }, (state) => BigInt(state.size)),
    capacity: method('capacity', { args: [], result: U32, mutable: false }, (state) => BigInt(state.capacity)),
    clearRetainingCapacity: method('clearRetainingCapacity', { args: [], result: VOID, mutable: true }, (state) => {
      state.metadata.fill(0);
      state.size = 0;
      state.available = Math.floor((state.capacity * MAX_LOAD) / 100);
      return;
    }),
    clearAndFree: method('clearAndFree', { args: [], result: VOID, mutable: true, allocates: true }, (state) => {
      Object.assign(state, emptyState(keyType, valueType));
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
      return runtime(
        map,
        (frame) => {
          void allocator.eval(frame);
          return fresh();
        },
        call.span
      );
    });
  } else {
    // A variable that takes `.empty` gets a map of its own, as Zig's copy of the empty struct is one.
    members.empty = () => ({
      type: map,
      value: new ZStruct([
        new NativeHandle('template', {
          fresh: () => new NativeHandle('hashMap', emptyState(keyType, valueType)),
        }),
      ]),
    });
  }
  setMembers(map, members);
  setMembers(
    iterator,
    nextMember(
      iterator,
      optionalOf(entry),
      advance((state, index) => new ZStruct([new Pointer(state.keys, index), new Pointer(state.values, index)]))
    )
  );
  setMembers(
    keyIterator,
    nextMember(
      keyIterator,
      optionalOf(pointerTo(keyType, false)),
      advance((state, index) => new Pointer(state.keys, index))
    )
  );
  setMembers(
    valueIterator,
    nextMember(
      valueIterator,
      optionalOf(pointerTo(valueType, false)),
      advance((state, index) => new Pointer(state.values, index))
    )
  );
}

/** An iterator's `next`: the entry of the next used slot from the iterator's index. */
function advance(returns: (state: MapState, index: number) => Value): (iteratorState: ZStruct) => Value {
  return (iteratorState) => {
    const state = (iteratorState.slots[0] as NativeHandle).state as MapState;
    let index = Number(iteratorState.slots[1] as bigint);
    if (state.size === 0) return NULL;
    while (index < state.capacity) {
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
  run: (iteratorState: ZStruct) => Value
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
          return run((evaluate(frame) as Pointer).load() as ZStruct);
        },
        call.span
      );
    }),
  };
}

function readMapState(value: Value): MapState {
  return ((value as ZStruct).slots[0] as NativeHandle).state as MapState;
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

export const HASH_MAP_MEMBERS: Record<string, () => Member> = {
  AutoHashMap: mapFactory('AutoHashMap', 'auto', true),
  AutoHashMapUnmanaged: mapFactory('AutoHashMapUnmanaged', 'auto', false),
  StringHashMap: mapFactory('StringHashMap', 'string', true),
  StringHashMapUnmanaged: mapFactory('StringHashMapUnmanaged', 'string', false),
};

export { ErrorValue, sliceOf };
