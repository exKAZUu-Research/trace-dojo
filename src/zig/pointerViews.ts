import { BufferMemory, type BufferMemorySpace } from './bufferMemory';
import { fieldOffsets, sizeOf } from './layout';
import { reserveMemory, spendMemory } from './memoryAccounting';
import { arrayOf, type Type, typeId } from './types';
import {
  Cell,
  Pointer,
  registerPointerLocation,
  registerStorageLocation,
  storeInto,
  type Value,
  ZArray,
  type ZStruct,
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
  const bytes = location.storage as Value[];
  const physical = space.memories.get(bytes);
  let result: Pointer;
  if (physical)
    result = new Pointer(
      physical.arrayView(type, capacity(bytes.length - location.index, type), location.index * 8),
      0
    );
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
  return undefined;
}

function logicalView(source: Pointer, sourceType: Type, type: Type, space: BufferMemorySpace): Pointer {
  if (source.target instanceof ZArray) {
    const count =
      source.target.lengthValue - BigInt(source.index - source.target.offset) + (source.target.hasSentinel ? 1n : 0n);
    const array = new ZArray(source.target.slots, source.index, count);
    source = new Pointer(new Cell(array), 0);
    sourceType = arrayOf(count, sourceType);
  }
  const length = sizeOf(sourceType);
  reserveMemory(length);
  spendMemory(length);
  const bytes = Array.from<Value>({ length }).fill(0xaan);
  const memory = new BufferMemory(
    bytes,
    spendMemory,
    space,
    undefined,
    {
      pull: () => memory.write(sourceType, 0, source.load()),
      push: () => storeInto(source.target, source.index, memory.read(sourceType, 0)),
    },
    (offset) => sourceLocation(source, sourceType, offset)
  );
  const view = memory.arrayView(type, capacity(length, type), 0);
  const origin = source.storageLocation();
  const unit = sizeOf(sourceType.kind === 'array' ? sourceType.child : sourceType);
  registerStorageLocation(view.slots, (index) => ({
    storage: origin.storage,
    index: origin.index * unit + index * sizeOf(type),
  }));
  registerPointerLocation(view.slots, (index) => sourceLocation(source, sourceType, index * sizeOf(type) * 8));
  return new Pointer(view, 0);
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
    const fields = type.fields ?? [];
    const offsets = fieldOffsets(type);
    for (const [index, field] of fields.entries()) {
      spendMemory();
      if (offset >= offsets[index] && offset < offsets[index] + sizeOf(field.type) * 8)
        return sourceLocation(new Pointer(pointer.load() as ZStruct, index), field.type, offset - offsets[index]);
    }
  }
  const location = pointer.storageLocation();
  return { storage: location.storage, index: location.index + offset / (8 * Math.max(1, sizeOf(type))) };
}

function capacity(bytes: number, type: Type): bigint {
  const stride = sizeOf(type);
  return stride === 0 ? 1n : BigInt(Math.floor(bytes / stride));
}
