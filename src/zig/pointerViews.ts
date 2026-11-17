import { BufferMemory, type BufferMemorySpace, physicalUnion } from './bufferMemory';
import { BigFloat } from './floats';
import { bitSizeOf, fieldOffsets, sizeOf } from './layout';
import { reserveMemory, spendMemory } from './memoryAccounting';
import { arrayOf, type StructType, type Type, typeId } from './types';
import {
  Cell,
  ErrorValue,
  FnValue,
  NULL,
  Pointer,
  registerStorageLocation,
  storeInto,
  type Value,
  ZArray,
  type ZStruct,
  type ZUnion,
} from './values';
import { WeakValueMap } from './weakValueMap';

interface Pointee {
  source: Pointer;
  sourceType: Type;
  type: Type;
}

const pointees = new WeakMap<Pointer, Pointee>();
const views = new WeakMap<BufferMemorySpace, WeakValueMap<string, Pointer>>();

export function rememberPointerType(pointer: Pointer, type: Type): void {
  if (!pointees.has(pointer)) pointees.set(pointer, { source: pointer, sourceType: type, type });
}

export function viewPointer(pointer: Pointer, type: Type, space: BufferMemorySpace): Pointer {
  const pointee = pointees.get(pointer);
  if (!pointee || pointee.type === type) return pointer;
  const source = pointee.source;
  const sourceType = pointee.sourceType;
  const location = source.storageLocation();
  let cached = views.get(space);
  if (!cached) {
    cached = new WeakValueMap();
    views.set(space, cached);
  }
  const key = `${space.identityOf(location.storage)} ${location.index} ${typeId(type)}`;
  const prior = cached.get(key);
  if (prior) return prior;
  const backing = space.typedViews.get(pointer.target.slots);
  const memory = backing?.memory ?? space.memories.get(location.storage as Value[]);
  const offset = backing ? backing.offset(pointer.index) : location.index * 8;
  let result: Pointer;
  if (memory) result = new Pointer(memory.arrayView(type, capacity(memory.byteLength - offset / 8, type), offset), 0);
  else {
    const first = firstField(source, sourceType, type);
    result = first ? viewPointer(first.pointer, type, space) : logicalView(source, sourceType, type, space);
  }
  pointees.set(result, { source, sourceType, type });
  cached.set(key, result);
  return result;
}

function firstField(source: Pointer, sourceType: Type, type: Type): { pointer: Pointer } | undefined {
  if (sourceType.kind === 'array' && sourceType.length !== 0n && sizeOf(type) <= sizeOf(sourceType.child)) {
    const array = source.load() as ZArray;
    const pointer = new Pointer(array, array.offset);
    rememberPointerType(pointer, sourceType.child);
    return { pointer };
  }
  if (sourceType.kind === 'struct' && sourceType.layout !== 'packed') {
    const offsets = fieldOffsets(sourceType);
    for (const [index, field] of (sourceType.fields ?? []).entries()) {
      spendMemory();
      if (offsets[index] !== 0 || sizeOf(type) > sizeOf(field.type)) continue;
      const pointer = new Pointer(source.load() as ZStruct, index);
      rememberPointerType(pointer, field.type);
      return { pointer };
    }
  }
  if (sourceType.kind === 'union' && sourceType.layout !== 'auto') {
    const field = sourceType.fields?.[0];
    if (field) {
      const union = physicalUnion(sourceType, source.load() as ZUnion);
      const pointer = new Pointer(union.fieldView!(0), 0);
      rememberPointerType(pointer, field.type);
      return { pointer };
    }
  }
  return undefined;
}

function logicalView(source: Pointer, sourceType: Type, type: Type, space: BufferMemorySpace): Pointer {
  let offset = 0;
  if (source.target instanceof ZArray) {
    const array = source.target;
    offset = (source.index - array.offset) * sizeOf(sourceType) * 8;
    source = new Pointer(new Cell(array), 0);
    sourceType = arrayOf(array.lengthValue + (array.hasSentinel ? 1n : 0n), sourceType);
  }
  const length = sizeOf(sourceType);
  const origin = source.storageLocation();
  let memories = space.logicalMemories.get(origin.storage);
  if (!memories) {
    memories = new Map();
    space.logicalMemories.set(origin.storage, memories);
  }
  const key = `${origin.index} ${typeId(sourceType)}`;
  let memory = memories.get(key);
  if (!memory) {
    const storage: PointerStorage = { source, type: sourceType, cache: new Map() };
    const created = new BufferMemory(
      lazyBytes(length),
      spendMemory,
      space,
      undefined,
      {
        pull: (offset, bits) => synchronizeRegion(created, storage, offset, bits, false),
        push: (offset, bits) => synchronizeRegion(created, storage, offset, bits, true),
      },
      (offset) => sourceLocation(source, sourceType, offset)
    );
    memory = created;
    memories.set(key, memory);
  }
  const view = memory.arrayView(type, capacity(length - offset / 8, type), offset);
  const unit = sizeOf(sourceType.kind === 'array' ? sourceType.child : sourceType);
  registerStorageLocation(view.slots, (index) => ({
    storage: origin.storage,
    index: origin.index * unit + offset / 8 + index * sizeOf(type),
  }));
  return new Pointer(view, 0);
}

interface PointerStorage {
  source: Pointer;
  type: Type;
  cache: Map<number, { value: Value }>;
}

function synchronizeRegion(
  memory: BufferMemory,
  storage: PointerStorage,
  offset: number,
  bits: number,
  write: boolean
): void {
  const { source, type, cache } = storage;
  visitRegion(source, type, { start: offset, end: offset + bits, offset: 0 }, (pointer, child, start, packed) => {
    if (write) {
      storeInto(pointer.target, pointer.index, memory.read(child, start, packed));
      cache.delete(start);
      return;
    }
    const value = pointer.load();
    if (cache.has(start) && Object.is(cache.get(start)!.value, value)) return;
    memory.write(child, start, value, packed);
    if (
      typeof value !== 'object' ||
      value instanceof BigFloat ||
      value instanceof Pointer ||
      value instanceof ErrorValue ||
      value instanceof FnValue ||
      value === NULL
    )
      cache.set(start, { value });
  });
}

type RegionVisitor = (pointer: Pointer, type: Type, offset: number, packed: number | undefined) => void;

interface BitRegion {
  start: number;
  end: number;
  offset: number;
  packed?: number;
}

function visitRegion(pointer: Pointer, type: Type, range: BitRegion, visit: RegionVisitor): void {
  const { start, end, offset, packed } = range;
  spendMemory();
  if (start >= end) return;
  if (type.kind === 'array') {
    const stride = sizeOf(type.child) * 8;
    if (stride === 0) return;
    const array = pointer.load() as ZArray;
    const first = Math.floor(start / stride),
      last = Math.ceil(end / stride);
    for (let index = first; index < last; index++) {
      spendMemory();
      visitRegion(
        new Pointer(array, array.offset + index),
        type.child,
        {
          start: Math.max(0, start - index * stride),
          end: Math.min(stride, end - index * stride),
          offset: offset + index * stride,
        },
        visit
      );
    }
    return;
  }
  if (type.kind === 'struct' && type.native?.storageSlots === undefined && type.native?.kind !== 'allocator') {
    const struct = pointer.load() as ZStruct;
    for (const region of intersectingFields(type, start, end)) {
      visitRegion(
        new Pointer(struct, region.index),
        region.type,
        {
          start: Math.max(0, start - region.offset),
          end: Math.min(region.bits, end - region.offset),
          offset: offset + region.offset,
          packed: type.layout === 'packed' ? region.bits : undefined,
        },
        visit
      );
    }
    return;
  }
  visit(pointer, type, offset, packed);
}

interface StructRegion {
  index: number;
  type: Type;
  offset: number;
  bits: number;
}
const regionCache = new WeakMap<StructType, StructRegion[]>();

function* intersectingFields(type: StructType, start: number, end: number): Generator<StructRegion> {
  const regions = structRegions(type);
  let low = 0,
    high = regions.length;
  while (low < high) {
    spendMemory();
    const middle = (low + high) >>> 1;
    if (regions[middle].offset + regions[middle].bits <= start) low = middle + 1;
    else high = middle;
  }
  for (let index = low; index < regions.length && regions[index].offset < end; index++) {
    spendMemory();
    yield regions[index];
  }
}

function structRegions(type: StructType): StructRegion[] {
  const cached = regionCache.get(type);
  if (cached) return cached;
  const offsets = fieldOffsets(type);
  const regions: StructRegion[] = [];
  for (const [index, field] of (type.fields ?? []).entries()) {
    spendMemory();
    if (field.comptimeValue !== undefined) continue;
    const bits = type.layout === 'packed' ? bitSizeOf(field.type) : sizeOf(field.type) * 8;
    if (bits !== 0) regions.push({ index, type: field.type, offset: offsets[index], bits });
  }
  regions.sort((a, b) => {
    spendMemory();
    return a.offset - b.offset;
  });
  regionCache.set(type, regions);
  return regions;
}

function lazyBytes(length: number): Value[] {
  const values = new Map<number, Value>();
  return new Proxy<Value[]>([], {
    get: (target, property, receiver) => {
      if (property === 'length') return length;
      const index = byteIndex(property);
      return index === undefined ? Reflect.get(target, property, receiver) : (values.get(index) ?? 0xaan);
    },
    has: (target, property) => {
      const index = byteIndex(property);
      return index === undefined ? Reflect.has(target, property) : index < length;
    },
    set: (target, property, value: Value, receiver) => {
      const index = byteIndex(property);
      if (index === undefined) return Reflect.set(target, property, value, receiver);
      if (!values.has(index)) reserveMemory(1);
      values.set(index, value);
      return true;
    },
  });
}

function byteIndex(property: string | symbol): number | undefined {
  if (typeof property !== 'string') return undefined;
  const index = Number(property);
  return Number.isInteger(index) && index >= 0 && String(index) === property ? index : undefined;
}

function sourceLocation(pointer: Pointer, type: Type, offset: number): { storage: object; index: number } {
  spendMemory();
  if (type.kind === 'array' && sizeOf(type.child) !== 0) {
    const array = pointer.load() as ZArray;
    const stride = sizeOf(type.child) * 8;
    const index = Math.floor(offset / stride);
    return sourceLocation(new Pointer(array, array.offset + index), type.child, offset - index * stride);
  }
  if (type.kind === 'struct' && type.layout !== 'packed') {
    for (const region of intersectingFields(type, offset, offset + 1))
      return sourceLocation(new Pointer(pointer.load() as ZStruct, region.index), region.type, offset - region.offset);
  }
  const location = pointer.storageLocation();
  return { storage: location.storage, index: location.index + offset / (8 * Math.max(1, sizeOf(type))) };
}

function capacity(bytes: number, type: Type): bigint {
  const stride = sizeOf(type);
  return stride === 0 ? 1n : BigInt(Math.floor(bytes / stride));
}
