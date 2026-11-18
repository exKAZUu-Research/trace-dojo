import { BufferMemory, type BufferMemorySpace, physicalUnion } from './bufferMemory';
import { BigFloat } from './floats';
import {
  bitSizeOf,
  errorUnionOffsets,
  fieldOffsets,
  optionalNicheBits,
  sizeOf,
  unionOffsets,
  usesFieldLayout,
} from './layout';
import { spendMemory } from './memoryAccounting';
import { sparseBytes } from './sparseBytes';
import { arrayOf, type StructType, type Type, typeId, U8, U16 } from './types';
import {
  Cell,
  ErrorValue,
  FnValue,
  hasAggregateStorage,
  NULL,
  optionalSome,
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
  if (sourceType.kind === 'struct' && sourceType.layout !== 'packed' && usesFieldLayout(sourceType)) {
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
  const originalSource = source;
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
      sparseBytes(length),
      spendMemory,
      space,
      undefined,
      {
        pull: (offset, bits) => synchronizeRegion(created, storage, offset, bits, false),
        push: (offset, bits) => synchronizeRegion(created, storage, offset, bits, true),
      },
      (position, viewType) =>
        viewType && sizeOf(viewType) === 0
          ? originalSource.fieldLocation((position - offset) / 8)
          : sourceLocation(source, sourceType, position)
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
  visitRegion(
    source,
    type,
    { start: offset, end: offset + bits, offset: 0 },
    {
      value(pointer, child, start, packed) {
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
      },
      tag(pointer, wrapper, start) {
        if (write) restoreWrapperTag(memory, pointer, wrapper, start);
        else writeWrapperTag(memory, pointer, wrapper, start);
      },
    }
  );
}

interface WrapperRegion {
  type: Extract<Type, { kind: 'optional' | 'error_union' }>;
  child: Type;
  payloadOffset: number;
  tagOffset: number;
  tagBits: number;
}

function wrapperRegion(type: Type): WrapperRegion | undefined {
  if (type.kind === 'optional' && !optionalNicheBits(type.child)) {
    return { type, child: type.child, payloadOffset: 0, tagOffset: sizeOf(type.child) * 8, tagBits: 8 };
  }
  if (type.kind === 'error_union') {
    const { payload, error } = errorUnionOffsets(type.payload);
    return { type, child: type.payload, payloadOffset: payload * 8, tagOffset: error * 8, tagBits: 16 };
  }
  return undefined;
}

function wrapperPayload(pointer: Pointer, wrapper: WrapperRegion): Pointer | undefined {
  const { type, payloadOffset } = wrapper;
  if (type.kind === 'optional') {
    if (pointer.load() === NULL && !Pointer.optionalProjection(pointer.target, pointer.index)) return undefined;
    return pointer.project('optional').withFieldLocation(pointer, 0);
  }
  if (pointer.load() instanceof ErrorValue && !Pointer.errorProjection(pointer.target, pointer.index)) return undefined;
  return pointer.projectErrorPayload(payloadOffset / 8).withFieldLocation(pointer, payloadOffset / 8);
}

function restoreWrapperTag(memory: BufferMemory, pointer: Pointer, wrapper: WrapperRegion, offset: number): void {
  const { type, child, tagOffset, payloadOffset } = wrapper;
  const at = offset + tagOffset;
  const value = pointer.load();
  if (type.kind === 'optional' && ((memory.read(U8, at) as bigint) & 1n) === 0n) {
    if (value !== NULL) {
      wrapperPayload(pointer, wrapper);
      pointer.target.slots[pointer.index] = NULL;
    }
    return;
  }
  if (type.kind === 'error_union' && memory.read(U16, at) !== 0n) {
    wrapperPayload(pointer, wrapper);
    pointer.target.slots[pointer.index] = memory.read(type.errorSet, at);
    return;
  }
  const inactive = type.kind === 'optional' ? value === NULL : value instanceof ErrorValue;
  if (!inactive) return;
  const payload = wrapperPayload(pointer, wrapper);
  if (payload) {
    const restored = payload.load();
    pointer.target.slots[pointer.index] = type.kind === 'optional' ? optionalSome(restored, child) : restored;
  } else {
    const restored = memory.read(child, offset + payloadOffset);
    storeInto(pointer.target, pointer.index, type.kind === 'optional' ? optionalSome(restored, child) : restored);
  }
}

function writeWrapperTag(memory: BufferMemory, pointer: Pointer, wrapper: WrapperRegion, offset: number): void {
  const { type, tagOffset } = wrapper;
  const at = offset + tagOffset;
  const value = pointer.load();
  if (type.kind === 'optional') memory.write(U8, at, value === NULL ? 0n : 1n);
  else if (value instanceof ErrorValue) memory.write(type.errorSet, at, value);
  else memory.write(U16, at, 0n);
}

interface RegionVisitor {
  value: (pointer: Pointer, type: Type, offset: number, packed: number | undefined) => void;
  tag: (pointer: Pointer, wrapper: WrapperRegion, offset: number) => void;
}

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
  const wrapper = wrapperRegion(type);
  if (wrapper) {
    visitWrapper(pointer, wrapper, range, visit);
    return;
  }
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
  if (type.kind === 'struct' && usesFieldLayout(type)) {
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
  visit.value(pointer, type, offset, packed);
}

function visitWrapper(pointer: Pointer, wrapper: WrapperRegion, range: BitRegion, visit: RegionVisitor): void {
  const { start, end, offset } = range;
  const { child, payloadOffset, tagOffset, tagBits } = wrapper;
  const payloadStart = Math.max(0, start - payloadOffset);
  const payloadEnd = Math.min(sizeOf(child) * 8, end - payloadOffset);
  if (payloadStart < payloadEnd) {
    const payload = wrapperPayload(pointer, wrapper);
    if (payload)
      visitRegion(payload, child, { start: payloadStart, end: payloadEnd, offset: offset + payloadOffset }, visit);
  }
  if (start < tagOffset + tagBits && end > tagOffset) visit.tag(pointer, wrapper, offset);
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

function sourceLocation(pointer: Pointer, type: Type, offset: number): { storage: object; index: number } {
  spendMemory();
  if (type.kind === 'array' && sizeOf(type.child) !== 0) {
    const array = pointer.load() as ZArray;
    const stride = sizeOf(type.child) * 8;
    const index = Math.floor(offset / stride);
    const element = new Pointer(array, array.offset + index);
    const source = hasAggregateStorage(type.child) ? element.withFieldLocation(pointer, (index * stride) / 8) : element;
    return sourceLocation(source, type.child, offset - index * stride);
  }
  if (type.kind === 'struct' && type.layout !== 'packed' && (usesFieldLayout(type) || type.native?.kind === 'writer')) {
    for (const region of intersectingFields(type, offset, offset + 1)) {
      const field = new Pointer(pointer.load() as ZStruct, region.index);
      const source = hasAggregateStorage(region.type) ? field.withFieldLocation(pointer, region.offset / 8) : field;
      return sourceLocation(source, region.type, offset - region.offset);
    }
  }
  const wrapper = wrapperRegion(type);
  if (wrapper) return wrapperSourceLocation(pointer, wrapper, offset);
  if (type.kind === 'optional') return sourceLocation(pointer, type.child, offset);
  if (type.kind === 'union') {
    const union = physicalUnion(type, pointer.load() as ZUnion);
    const payload = new Pointer(union.fieldView!(0), 0).storageLocation();
    return { storage: payload.storage, index: payload.index + offset / 8 - unionOffsets(type).payload };
  }
  const location = pointer.storageLocation();
  return { storage: location.storage, index: location.index + offset / (8 * Math.max(1, sizeOf(type))) };
}

function wrapperSourceLocation(
  pointer: Pointer,
  wrapper: WrapperRegion,
  offset: number
): ReturnType<Pointer['storageLocation']> {
  const within = offset - wrapper.payloadOffset;
  if (within >= 0 && within < sizeOf(wrapper.child) * 8) {
    const payload = wrapperPayload(pointer, wrapper);
    if (payload) return sourceLocation(payload, wrapper.child, within);
  }
  return pointer.fieldLocation(offset / 8);
}

function capacity(bytes: number, type: Type): bigint {
  const stride = sizeOf(type);
  return stride === 0 ? 1n : BigInt(Math.floor(bytes / stride));
}
