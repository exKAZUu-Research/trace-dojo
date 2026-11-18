// code-gauge-allow-file fileNcss 688 -- Keeps byte codecs, typed views, alias-safe copying, and reference recovery together.
import { transferCost } from './allocation';
import { PANIC, panic } from './arith';
import { enumLookup } from './enumLookup';
import { decodeFloat, encodeFloat } from './floatEncoding';
import type { AnyFloat } from './floats';
import {
  bitSizeOf,
  errorUnionOffsets,
  fieldOffsets,
  optionalNicheBits,
  sizeOf,
  SLICE_LENGTH_BIT_OFFSET,
  unionOffsets,
  usesFieldLayout,
} from './layout';
import { memorySpace, reserveMemory, spendMemory } from './memoryAccounting';
import { rememberPointerType, viewPointer } from './pointerViews';
import { copyForStorage, undefinedValue } from './semaBase';
import { singleValueOf } from './singleValue';
import {
  clearSparseBytes,
  copySparseBytes,
  propertyIndex,
  sparseBytes,
  sparseByteValues,
  sparseEntriesInRange,
} from './sparseBytes';
import { type Type, typeId } from './types';
import {
  ErrorValue,
  FnValue,
  NativeHandle,
  NULL,
  Pointer,
  registerPointerLocation,
  registerStorageLocation,
  Slice,
  type Slots,
  Some,
  storageLocation,
  type Value,
  ZArray,
  zeroArray,
  ZStruct,
  ZUnion,
} from './values';

interface StoredReference {
  key: string;
  value: object;
  id: bigint;
  bits: number;
}

type LocatedReference = StoredReference & { offset: number };

interface FieldLocation {
  type: Type;
  offset: number;
  packed?: number;
  constant?: { value: Value };
}

export class BufferMemorySpace {
  readonly memories = new WeakMap<Value[], BufferMemory>();
  readonly typedViews = new WeakMap<Value[], { memory: BufferMemory; offset: (index: number) => number }>();
  readonly logicalMemories = new WeakMap<object, Map<string, BufferMemory>>();
  readonly referenceIds = new WeakMap<object, bigint>();
  private readonly references = new Map<string, object>();
  readonly referenceTypes = new WeakMap<Type, boolean>();
  nextReferenceId = 1n;
  readonly errorReferenceIds = new WeakMap<object, bigint>();
  nextErrorReferenceId = 1n;
  private readonly writerVtables = new Map<string, object>();

  reference(key: string): object | undefined {
    return this.references.get(key);
  }

  keepReference(key: string, value: object): void {
    if (!this.references.has(key)) reserveMemory(1);
    this.references.set(key, value);
  }

  get hasReferences(): boolean {
    return this.references.size > 0;
  }

  identityOf(value: object): bigint {
    let identity = this.referenceIds.get(value);
    if (identity === undefined) {
      identity = this.nextReferenceId++;
      this.referenceIds.set(value, identity);
    }
    return identity;
  }

  writerVtable(writer: ZStruct): object {
    const growth = writer.slots[4];
    const kind = growth instanceof NativeHandle ? growth.kind : writer.slots[2] === undefined ? 'fixed' : 'file';
    let vtable = this.writerVtables.get(kind);
    if (!vtable) {
      vtable = {};
      this.writerVtables.set(kind, vtable);
    }
    return vtable;
  }
}

export function physicalBytes(
  value: Value,
  type: Type,
  addressOf: (value: object) => bigint,
  spend: (cost?: number) => void
): number[] {
  const length = sizeOf(type);
  spend(length);
  const bytes = Array.from<Value>({ length }).fill(0n);
  const memory = new BufferMemory(bytes, () => spend(), new BufferMemorySpace(), addressOf);
  memory.write(type, 0, value);
  return bytes.map(Number);
}

export function packedValuesEqual(type: Extract<Type, { kind: 'struct' | 'union' }>, a: Value, b: Value): boolean {
  const length = sizeOf(type);
  spendMemory(length * 2);
  const left = Array.from<Value>({ length }).fill(0n);
  const right = Array.from<Value>({ length }).fill(0n);
  new BufferMemory(left, spendMemory, memorySpace()).write(type, 0, a);
  new BufferMemory(right, spendMemory, memorySpace()).write(type, 0, b);
  const bits = bitSizeOf(type);
  for (let at = 0; at < bits; at += 8) {
    spendMemory();
    const mask = (1n << BigInt(Math.min(8, bits - at))) - 1n;
    if (((left[at / 8] as bigint) & mask) !== ((right[at / 8] as bigint) & mask)) return false;
  }
  return true;
}

export function zeroPhysicalValue(type: Extract<Type, { kind: 'struct' | 'union' }>): Value {
  const length = sizeOf(type);
  reserveMemory(length);
  spendMemory(length);
  const memory = new BufferMemory(Array.from<Value>({ length }).fill(0n), spendMemory, memorySpace());
  return memory.read(type, 0);
}

export function physicalUnion(type: Extract<Type, { kind: 'union' }>, value: ZUnion): ZUnion {
  if (value.fieldView) return value;
  const bytes = sparseBytes(sizeOf(type));
  const memory = new BufferMemory(bytes, spendMemory, memorySpace());
  memory.write(type, 0, value);
  const backing = memory.read(type, 0) as ZUnion;
  value.retainedPayloads = undefined;
  Object.defineProperty(value, 'tag', {
    get: () => backing.tag,
    set: (tag: number) => {
      backing.tag = tag;
    },
  });
  value.slots = backing.slots;
  value.rawTag = backing.rawTag;
  value.fieldView = backing.fieldView;
  value.copyBacking = backing.copyBacking;
  value.writeBacking = backing.writeBacking;
  value.backingKey = backing.backingKey;
  value.backingReferences = backing.backingReferences;
  value.copyBackingTo = backing.copyBackingTo;
  return value;
}

export function activeUnionIndex(value: ZUnion, invalid: string = PANIC.invalidEnum): number {
  const index = value.tag;
  if (index < 0) return panic(invalid);
  return index;
}

export function unionTagValue(value: ZUnion, tags: readonly { value: bigint }[]): bigint {
  return value.rawTag?.() ?? tags[activeUnionIndex(value)].value;
}

// code-gauge-allow functionParameterCount 7 -- Binds typed storage, its byte region, work budget, and initialized prefix together.
export function bindBufferMemory(
  memory: object,
  type: Type,
  count: number,
  buffer: Slice,
  offset: number,
  execution: { readonly bufferMemory: BufferMemorySpace; spend: (cost?: number) => void },
  initialized = count
): void {
  const spend = (): void => execution.spend();
  const space = execution.bufferMemory;
  if (!('slots' in memory) || !Array.isArray(memory.slots)) return;
  const destination = memory as Slots;
  const initial: Value[] = [];
  if (initialized > 0 && !singleValueOf(type, spend)) {
    execution.spend(initialized * transferCost(type));
    for (let index = 0; index < initialized; index++) initial.push(copyForStorage(destination.slots[index]));
  }
  const location = storageLocation(buffer.target.slots, buffer.start);
  const bytes = location.storage as Value[];
  let backing = space.memories.get(bytes);
  if (!backing) {
    backing = new BufferMemory(bytes, spend, space);
    space.memories.set(bytes, backing);
  }
  const start = location.index + offset;
  const byteLength = sizeOf(type) * count;
  for (let index = 0; index < byteLength; index++) {
    spend();
    bytes[start + index] = 0xaan;
  }
  destination.slots = backing.arrayView(type, BigInt(count), start * 8).slots;
  for (const [index, value] of initial.entries()) destination.slots[index] = value;
}

export class BufferMemory {
  private accessDepth = 0;
  private readonly views = new Map<string, Value>();
  private readonly referenceHolds = new Map<string, object>();
  private readonly referenceOffsets = new Map<number, StoredReference>();

  constructor(
    private readonly bytes: Value[],
    private readonly spend: () => void,
    private readonly space: BufferMemorySpace,
    private readonly addressOf?: (value: object) => bigint,
    private readonly synchronization?: {
      pull: (offset: number, bits: number) => void;
      push: (offset: number, bits: number) => void;
    },
    private readonly pointerLocation?: (offset: number, type: Type | undefined) => { storage: object; index: number }
  ) {
    space.memories.set(bytes, this);
  }

  get byteLength(): number {
    return this.bytes.length;
  }

  activatePayload(type: Extract<Type, { kind: 'optional' | 'error_union' }>, offset: number): void {
    if (type.kind === 'optional') this.writeBits(offset + sizeOf(type.child) * 8, 8, 1n);
    else this.writeBits(offset + errorUnionOffsets(type.payload).error * 8, 16, 0n);
  }

  writeWholePayload(type: Type, offset: number, value: Value): void {
    const bits = sizeOf(type) * 8;
    this.checkRegion(offset, bits);
    this.access(true, offset, bits, () => {
      this.clearRegion(offset, bits, true);
      this.write(type, offset, value);
    });
  }

  copyPayloadTo(type: Type, offset: number, target: BufferMemory, start: number): void {
    const bits = sizeOf(type) * 8;
    this.checkRegion(offset, bits);
    target.checkRegion(start, bits);
    if (target === this && offset === start) return;
    if (target === this && this.synchronization) {
      const snapshot = new BufferMemory(sparseBytes(sizeOf(type)), this.spend, this.space);
      this.copyRegion(snapshot, offset, 0, bits);
      snapshot.copyRegion(target, 0, start, bits);
      return;
    }
    this.copyRegion(target, offset, start, bits);
  }

  private access<T>(write: boolean, offset: number, bits: number, run: () => T): T {
    if (!this.synchronization || this.accessDepth !== 0) return run();
    this.accessDepth++;
    try {
      this.synchronization.pull(offset, bits);
      const result = run();
      if (write) this.synchronization.push(offset, bits);
      return result;
    } finally {
      this.accessDepth--;
    }
  }

  slots(fields: readonly FieldLocation[]): Value[] {
    const slots = new Proxy(Array.from<Value>({ length: fields.length }).fill(undefined), {
      get: (target, property, receiver) => {
        const index = propertyIndex(property);
        if (index === undefined || index >= fields.length) return Reflect.get(target, property, receiver);
        const field = fields[index];
        return field.constant ? field.constant.value : this.read(field.type, field.offset, field.packed);
      },
      set: (target, property, value: Value, receiver) => {
        const index = propertyIndex(property);
        if (index === undefined) return Reflect.set(target, property, value, receiver);
        const field = fields[index];
        if (!field) return Reflect.set(target, property, value, receiver);
        this.write(field.type, field.offset, value, field.packed);
        return true;
      },
    });
    this.registerBacking(
      slots,
      (index) => fields[index]?.offset ?? 0,
      (index) => fields[index]?.type
    );
    return slots;
  }

  private registerBacking(
    slots: Value[],
    offset: (index: number) => number,
    type: (index: number) => Type | undefined,
    virtual = false
  ): void {
    this.space.typedViews.set(slots, { memory: this, offset });
    registerStorageLocation(slots, (index) => ({ storage: this.bytes, index: offset(index) / 8 }), virtual);
    if (this.pointerLocation)
      registerPointerLocation(slots, (index) => this.pointerLocation!(offset(index), type(index)));
  }

  // code-gauge-allow functionNcss 40 -- Decodes each scalar representation and transparent wrapper from shared bytes.
  // code-gauge-allow functionCognitiveComplexity 22 -- Decodes each scalar representation and transparent wrapper from shared bytes.
  read(type: Type, offset: number, packed?: number): Value {
    if (type.kind === 'array' || type.kind === 'struct' || type.kind === 'union')
      return this.readAggregate(type, offset);
    switch (type.kind) {
      case 'int': {
        const value = this.readBits(offset, packed ?? sizeOf(type) * 8);
        return type.signed ? BigInt.asIntN(type.bits, value) : BigInt.asUintN(type.bits, value);
      }
      case 'bool': {
        return this.readBits(offset, packed ?? 1) !== 0n;
      }
      case 'float': {
        return decodeFloat(this.readBits(offset, type.bits), type.bits);
      }
      case 'enum': {
        const bits = type.tagType?.bits ?? 0;
        const value = this.readBits(offset, packed ?? sizeOf(type) * 8);
        return type.tagType?.signed ? BigInt.asIntN(bits, value) : BigInt.asUintN(bits, value);
      }
      case 'pointer': {
        const pointer = this.reference(offset, type);
        if (type.size !== 'slice') return pointer;
        const length = this.readBits(offset + SLICE_LENGTH_BIT_OFFSET, 64);
        return pointer instanceof Pointer ? new Slice(pointer.target, pointer.index, length) : undefinedValue(type);
      }
      case 'optional': {
        const niche = optionalNicheBits(type.child);
        if (niche) return this.readBits(offset, niche) === 0n ? NULL : this.read(type.child, offset);
        const child = sizeOf(type.child);
        if (this.readBits(offset + child * 8, 1) === 0n) return NULL;
        const value = this.read(type.child, offset);
        return type.child.kind === 'optional' ? new Some(value) : value;
      }
      case 'error_union': {
        const layout = errorUnionOffsets(type.payload);
        const code = this.readBits(offset + layout.error * 8, 16);
        if (code !== 0n) return this.reference(offset + layout.error * 8, type.errorSet, 16);
        return this.read(type.payload, offset + layout.payload * 8);
      }
      case 'error_set': {
        return this.reference(offset, type, 16);
      }
      default: {
        return undefinedValue(type);
      }
    }
  }

  private readAggregate(type: Extract<Type, { kind: 'array' | 'struct' | 'union' }>, offset: number): Value {
    const key = `${typeId(type)} ${offset}`;
    if (type.kind === 'struct' && type.native?.kind === 'writer') return this.writerView(type, offset);
    if (type.kind === 'struct' && !usesFieldLayout(type)) return this.reference(offset, type);
    const cached = this.views.get(key);
    if (cached) return cached;
    let value: Value;
    if (type.kind === 'array') {
      value = this.arrayView(type.child, type.length, offset, type.sentinel !== undefined);
    } else if (type.kind === 'struct') {
      const offsets = fieldOffsets(type);
      value = new ZStruct(
        this.slots(
          (type.fields ?? []).map((field, index) => ({
            type: field.type,
            offset: offset + offsets[index],
            packed: type.layout === 'packed' ? bitSizeOf(field.type) : undefined,
            constant: field.comptimeValue,
          }))
        )
      );
    } else {
      value = this.unionView(type, offset);
    }
    this.views.set(key, value);
    return value;
  }

  private writerView(type: Extract<Type, { kind: 'struct' }>, offset: number): ZStruct {
    const key = `${typeId(type)} ${offset}`;
    const cached = this.views.get(key);
    if (cached) return cached as ZStruct;
    const fields = type.fields!;
    const [buffer, end] = fieldOffsets(type);
    const slots = this.slots([
      { type: fields[0].type, offset: offset + buffer },
      { type: fields[1].type, offset: offset + end },
    ]);
    for (let index = 2; index < 5; index++) {
      Object.defineProperty(slots, index, {
        enumerable: true,
        configurable: true,
        get: () => (this.reference(offset, type) as ZStruct).slots[index],
        set: (value: Value) => {
          (this.reference(offset, type) as ZStruct).slots[index] = value;
        },
      });
    }
    const header = new ZStruct(slots);
    this.views.set(key, header);
    return header;
  }

  private writeWriter(type: Extract<Type, { kind: 'struct' }>, offset: number, header: ZStruct): void {
    spendMemory(5);
    const snapshot = new ZStruct([...header.slots]);
    this.writeReference(offset, snapshot, type, 64, this.space.writerVtable(snapshot));
    const [buffer, end] = fieldOffsets(type);
    this.write(type.fields![0].type, offset + buffer, snapshot.slots[0]);
    this.write(type.fields![1].type, offset + end, snapshot.slots[1]);
  }

  private unionView(type: Extract<Type, { kind: 'union' }>, offset: number): ZUnion {
    const layout = unionOffsets(type);
    const tagOffset = layout.tag;
    let active = 0;
    const tag = (): number => (tagOffset === undefined ? active : this.unionTag(type, offset + tagOffset * 8));
    const union = new ZUnion(0, undefined);
    const tagType = type.tagType;
    if (tagType && tagOffset !== undefined) union.rawTag = () => this.read(tagType, offset + tagOffset * 8) as bigint;
    const payload = (): FieldLocation => unionFieldLocation(type, activeUnionIndex(union), offset + layout.payload * 8);
    Object.defineProperty(union, 'tag', {
      get: tag,
      set: (index: number) => {
        active = index;
        if (tagOffset !== undefined) {
          const encoded = type.tagType?.fields?.[index]?.value ?? BigInt(index);
          this.writeBits(offset + tagOffset * 8, (type.tagType ? sizeOf(type.tagType) : 1) * 8, encoded);
        }
      },
    });
    union.slots = new Proxy([undefined] as Value[], {
      get: (target, property, receiver) => {
        if (property !== '0') return Reflect.get(target, property, receiver);
        const field = payload();
        return this.read(field.type, field.offset, field.packed);
      },
      set: (target, property, value: Value, receiver) => {
        if (property !== '0') return Reflect.set(target, property, value, receiver);
        const field = payload();
        this.write(field.type, field.offset, value, field.packed);
        return true;
      },
    });
    registerStorageLocation(union.slots, () => ({ storage: this.bytes, index: offset / 8 + layout.payload }));
    this.space.typedViews.set(union.slots, { memory: this, offset: () => payload().offset });
    union.fieldView = (index) => ({
      slots: this.slots([unionFieldLocation(type, index, offset + layout.payload * 8)]),
    });
    this.attachUnionBacking(union, type, offset);
    return union;
  }

  private attachUnionBacking(union: ZUnion, type: Extract<Type, { kind: 'union' }>, offset: number): void {
    const bits = unionBitSize(type);
    if (type.layout !== 'auto') {
      union.backingKey = () => {
        spendMemory(Math.ceil(bits / 8));
        return this.access(false, offset, bits, () => this.regionBytes(offset, bits).join(','));
      };
    }
    union.backingReferences = () => this.unionReferences(type, offset, bits);
    union.copyBacking = () => {
      const memory = new BufferMemory(sparseBytes(sizeOf(type)), spendMemory, this.space);
      this.copyRegion(memory, offset, 0, bits);
      const copy = memory.read(type, 0) as ZUnion;
      if (unionOffsets(type).tag === undefined) copy.tag = union.tag;
      return copy;
    };
    union.writeBacking = (value) =>
      this.write(type, offset, type.layout === 'auto' ? value : physicalUnion(type, value));
    union.copyBackingTo = (destination, start) => this.copyRegion(destination as BufferMemory, offset, start, bits);
  }

  private unionReferences(type: Extract<Type, { kind: 'union' }>, offset: number, bits: number): Value[] {
    if (!this.space.hasReferences) return [];
    const known = this.sparseReferences(offset, offset, bits);
    const locations = new Set(known.map((reference) => reference.offset));
    const values = known.map((reference) => reference.value as Value);
    for (const at of this.referenceLocations(type, offset)) {
      this.spend();
      if (at < offset || at + 64 > offset + bits || locations.has(at)) continue;
      locations.add(at);
      const id = this.readBits(at, 64);
      const key = referenceKey(id, 64);
      const value = this.space.reference(key);
      if (!value) continue;
      this.referenceOffsets.set(at, { key, value, id, bits: 64 });
      values.push(value as Value);
    }
    return values;
  }

  // code-gauge-allow functionNcss 31 -- Traverses the shared physical layout for each reference-bearing type.
  private *referenceLocations(type: Type, offset: number): IterableIterator<number> {
    if (!encodesReferences(type, this.space.referenceTypes, this.spend)) return;
    this.spend();
    switch (type.kind) {
      case 'pointer': {
        yield offset;
        return;
      }
      case 'optional': {
        yield* this.referenceLocations(type.child, offset);
        return;
      }
      case 'error_union': {
        yield* this.referenceLocations(type.payload, offset + errorUnionOffsets(type.payload).payload * 8);
        return;
      }
      case 'array': {
        yield* this.arrayReferenceLocations(type, offset);
        return;
      }
      case 'union': {
        const payload = offset + unionOffsets(type).payload * 8;
        for (const field of type.fields ?? []) yield* this.referenceLocations(field.type, payload);
        return;
      }
      case 'struct': {
        if (!usesFieldLayout(type)) {
          yield offset;
          return;
        }
        const fields = fieldOffsets(type);
        for (const [index, field] of (type.fields ?? []).entries())
          if (field.comptimeValue === undefined) yield* this.referenceLocations(field.type, offset + fields[index]);
        return;
      }
    }
  }

  private *arrayReferenceLocations(type: Extract<Type, { kind: 'array' }>, offset: number): IterableIterator<number> {
    const stride = sizeOf(type.child) * 8;
    const length = Number(type.length + (type.sentinel === undefined ? 0n : 1n));
    if (stride === 0 || length === 0) return;
    const sparse = sparseByteValues.get(this.bytes);
    if (!sparse) {
      for (let index = 0; index < length; index++) yield* this.referenceLocations(type.child, offset + index * stride);
      return;
    }
    const start = Math.floor(offset / 8);
    const end = Math.ceil((offset + length * stride) / 8);
    const used = new Set<number>();
    for (const [byte, value] of sparseEntriesInRange(sparse.values, start, end - start)) {
      if (value === 0n) continue;
      const index = Math.max(0, Math.floor((byte * 8 - offset) / stride));
      if (index < length) used.add(index);
    }
    for (const index of used) yield* this.referenceLocations(type.child, offset + index * stride);
  }

  arrayView(child: Type, length: bigint, offset: number, hasSentinel = false): ZArray {
    const singleton = singleValueOf(child, this.spend);
    if (singleton) {
      const array = zeroArray(length, hasSentinel, copyForStorage(singleton.value));
      this.registerBacking(
        array.slots,
        () => offset,
        () => child,
        true
      );
      return array;
    }
    const count = length + (hasSentinel ? 1n : 0n);
    const stride = sizeOf(child);
    const slots = new Proxy<Value[]>([], {
      get: (target, property, receiver) => {
        if (property === 'length') return Number(count);
        const index = propertyIndex(property);
        return index !== undefined && BigInt(index) < count
          ? this.read(child, offset + index * stride * 8)
          : Reflect.get(target, property, receiver);
      },
      has: (target, property) => {
        const index = propertyIndex(property);
        return index !== undefined && BigInt(index) < count ? true : Reflect.has(target, property);
      },
      set: (target, property, value: Value, receiver) => {
        const index = propertyIndex(property);
        if (index === undefined) return Reflect.set(target, property, value, receiver);
        if (BigInt(index) >= count) panic('index out of bounds');
        this.write(child, offset + index * stride * 8, value);
        return true;
      },
    });
    this.registerBacking(
      slots,
      (index) => offset + index * stride * 8,
      () => child,
      true
    );
    return new ZArray(slots, 0, length, hasSentinel);
  }

  // code-gauge-allow functionNcss 45 -- Encodes each scalar representation and transparent wrapper into shared bytes.
  // code-gauge-allow functionCognitiveComplexity 23 -- Encodes each scalar representation and transparent wrapper into shared bytes.
  write(type: Type, offset: number, value: Value, packed?: number): void {
    if (type.kind === 'array' || type.kind === 'struct' || type.kind === 'union') {
      this.writeAggregate(type, offset, value);
      return;
    }
    switch (type.kind) {
      case 'int': {
        this.writeBits(offset, packed ?? sizeOf(type) * 8, BigInt.asUintN(type.bits, value as bigint));
        return;
      }
      case 'bool': {
        this.writeBits(offset, packed ?? 8, value ? 1n : 0n);
        return;
      }
      case 'float': {
        this.writeBits(offset, type.bits, encodeFloat(value as AnyFloat, type.bits));
        return;
      }
      case 'enum': {
        this.writeBits(offset, packed ?? sizeOf(type) * 8, value as bigint);
        return;
      }
      case 'pointer': {
        if (type.size === 'slice') {
          const slice = value as Slice;
          this.writeReference(offset, new Pointer(slice.target, slice.start), type);
          this.writeBits(offset + SLICE_LENGTH_BIT_OFFSET, 64, slice.lengthValue);
        } else this.writeReference(offset, value, type);
        return;
      }
      case 'optional': {
        const niche = optionalNicheBits(type.child);
        if (value === NULL) {
          this.writeBits(offset + (niche ? 0 : sizeOf(type.child) * 8), niche ?? 8, 0n);
          return;
        }
        this.write(type.child, offset, value instanceof Some ? value.value : value);
        if (!niche) this.writeBits(offset + sizeOf(type.child) * 8, 8, 1n);
        return;
      }
      case 'error_union': {
        const layout = errorUnionOffsets(type.payload);
        if (value instanceof ErrorValue) this.writeReference(offset + layout.error * 8, value, type.errorSet, 16);
        else {
          this.writeBits(offset + layout.error * 8, 16, 0n);
          this.write(type.payload, offset + layout.payload * 8, value);
        }
        return;
      }
      case 'error_set': {
        this.writeReference(offset, value, type, 16);
        return;
      }
    }
  }

  // code-gauge-allow functionCognitiveComplexity 23 -- Writes aggregate contents using their physical layout without replacing interior views.
  private writeAggregate(
    type: Extract<Type, { kind: 'array' | 'struct' | 'union' }>,
    offset: number,
    value: Value
  ): void {
    switch (type.kind) {
      case 'array': {
        if (singleValueOf(type.child, this.spend)) return;
        const array = value as ZArray;
        for (let index = 0; index < type.length; index++)
          this.write(type.child, offset + index * sizeOf(type.child) * 8, array.get(index));
        if (type.sentinel !== undefined)
          this.write(type.child, offset + Number(type.length) * sizeOf(type.child) * 8, array.get(Number(type.length)));
        return;
      }
      case 'struct': {
        if (type.native?.kind === 'writer') {
          this.writeWriter(type, offset, value as ZStruct);
          return;
        }
        if (!usesFieldLayout(type)) {
          this.writeReference(offset, value, type);
          return;
        }
        const offsets = fieldOffsets(type);
        for (const [index, field] of (type.fields ?? []).entries()) {
          if (field.comptimeValue !== undefined) continue;
          this.write(
            field.type,
            offset + offsets[index],
            (value as ZStruct).slots[index],
            type.layout === 'packed' ? bitSizeOf(field.type) : undefined
          );
        }
        return;
      }
      case 'union': {
        this.writeUnion(type, offset, value as ZUnion);
        return;
      }
    }
  }

  private writeUnion(type: Extract<Type, { kind: 'union' }>, offset: number, value: ZUnion): void {
    const bits = unionBitSize(type);
    this.checkRegion(offset, bits);
    this.access(true, offset, bits, () => {
      const layout = unionOffsets(type);
      if (value.copyBackingTo) {
        value.copyBackingTo(this, offset);
        if (layout.tag === undefined) (this.readAggregate(type, offset) as ZUnion).tag = value.tag;
        return;
      }
      this.clearRegion(offset, bits, value.payloadInitialized);
      if (!value.payloadInitialized) return;
      const tag = activeUnionIndex(value);
      (this.readAggregate(type, offset) as ZUnion).tag = tag;
      const payloadOffset = offset + layout.payload * 8;
      for (const [index, payload] of value.retainedPayloads?.values ?? []) {
        this.spend();
        this.writeUnionPayload(type, index, payloadOffset, payload);
      }
      this.writeUnionPayload(type, tag, payloadOffset, value.slots[0]);
    });
  }

  private clearRegion(offset: number, bits: number, initialized: boolean): void {
    if (bits === 0) return;
    const storage = sparseByteValues.get(this.bytes);
    if (storage && offset % 8 === 0 && bits % 8 === 0) {
      clearSparseBytes(storage, offset / 8, bits / 8, initialized);
    } else {
      const fill = initialized ? 0n : 0xaan;
      for (let bit = 0; bit < bits; bit += 8) this.writeRawBits(offset + bit, Math.min(8, bits - bit), fill);
    }
    for (const [at] of sparseEntriesInRange(this.referenceOffsets, offset, bits)) this.referenceOffsets.delete(at);
  }

  private writeUnionPayload(type: Extract<Type, { kind: 'union' }>, tag: number, offset: number, value: Value): void {
    const field = unionFieldLocation(type, tag, offset);
    this.write(field.type, offset, value, field.packed);
  }

  private copyRegion(destination: BufferMemory, offset: number, start: number, bits: number): void {
    if (bits === 0) return;
    this.access(false, offset, bits, () =>
      destination.access(true, start, bits, () => this.copyRegionRaw(destination, offset, start, bits))
    );
  }

  private copyRegionRaw(destination: BufferMemory, offset: number, start: number, bits: number): void {
    const sourceBytes = sparseByteValues.get(this.bytes);
    const destinationBytes = sparseByteValues.get(destination.bytes);
    if (sourceBytes && destinationBytes && offset % 8 === 0 && start % 8 === 0 && bits % 8 === 0) {
      const references = this.sparseReferences(offset, start, bits);
      copySparseBytes(sourceBytes, destinationBytes, offset / 8, start / 8, bits / 8);
      for (const [at] of sparseEntriesInRange(destination.referenceOffsets, start, bits))
        destination.referenceOffsets.delete(at);
      destination.restoreReferences(references);
      return;
    }
    spendMemory(Math.ceil(bits / 8) * 20);
    const bytes = this.regionBytes(offset, bits);
    const references: (StoredReference & { offset: number })[] = [];
    for (let bit = 0; bit < bits; bit++) {
      const reference = this.currentReference(offset + bit);
      if (reference) references.push({ ...reference, offset: start + bit });
    }
    for (let bit = 0; bit < bits; bit++) destination.referenceOffsets.delete(start + bit);
    destination.writeRegionBytes(start, bits, bytes);
    destination.restoreReferences(references);
  }

  private sparseReferences(offset: number, start: number, bits: number): LocatedReference[] {
    const references: LocatedReference[] = [];
    for (const [at] of sparseEntriesInRange(this.referenceOffsets, offset, bits)) {
      const reference = this.currentReference(at);
      if (reference) references.push({ ...reference, offset: start + at - offset });
    }
    return references;
  }

  private restoreReferences(references: readonly LocatedReference[]): void {
    for (const reference of references) {
      this.referenceOffsets.set(reference.offset, reference);
      this.referenceHolds.set(reference.key, reference.value);
      this.space.keepReference(reference.key, reference.value);
    }
  }

  private regionBytes(offset: number, bits: number): Value[] {
    if (offset % 8 === 0 && bits % 8 === 0) return this.bytes.slice(offset / 8, (offset + bits) / 8);
    const bytes: Value[] = [];
    for (let bit = 0; bit < bits; bit += 8) bytes.push(this.readRawBits(offset + bit, Math.min(8, bits - bit)));
    return bytes;
  }

  private writeRegionBytes(offset: number, bits: number, bytes: readonly Value[]): void {
    for (const [index, value] of bytes.entries()) {
      const at = offset + index * 8;
      if (offset % 8 === 0 && at + 8 <= offset + bits) this.bytes[at / 8] = value;
      else this.writeRawBits(at, Math.min(8, offset + bits - at), value as bigint);
    }
  }

  private readBits(offset: number, bits: number): bigint {
    this.checkRegion(offset, bits);
    return this.access(false, offset, bits, () => this.readRawBits(offset, bits));
  }

  private readRawBits(offset: number, bits: number): bigint {
    let result = 0n;
    for (let index = 0; index < bits; index += 8) {
      this.spend();
      const position = offset + index;
      const byte = Math.floor(position / 8);
      const shift = position % 8;
      let value = Number(this.bytes[byte] as bigint) >> shift;
      if (shift !== 0 && index + 8 < bits + shift)
        value |= Number((this.bytes[byte + 1] ?? 0n) as bigint) << (8 - shift);
      result |= BigInt(value & ((1 << Math.min(8, bits - index)) - 1)) << BigInt(index);
    }
    return result;
  }

  private writeBits(offset: number, bits: number, value: bigint): void {
    this.checkRegion(offset, bits);
    this.access(true, offset, bits, () => this.writeRawBits(offset, bits, value));
  }

  private checkRegion(offset: number, bits: number): void {
    if (offset < 0 || offset + bits > this.bytes.length * 8) panic('index out of bounds');
  }

  private writeRawBits(offset: number, bits: number, value: bigint): void {
    for (let index = 0; index < bits;) {
      this.spend();
      const position = offset + index;
      const byte = Math.floor(position / 8);
      const shift = position % 8;
      const count = Math.min(8 - shift, bits - index);
      const mask = ((1 << count) - 1) << shift;
      const previous = Number(this.bytes[byte] as bigint);
      this.bytes[byte] = BigInt(
        (previous & ~mask) | (Number((value >> BigInt(index)) & BigInt((1 << count) - 1)) << shift)
      );
      index += count;
    }
  }

  private currentReference(offset: number): StoredReference | undefined {
    return this.access(false, offset, 1, () => {
      const reference = this.referenceOffsets.get(offset);
      return reference && this.readBits(offset, reference.bits) === reference.id ? reference : undefined;
    });
  }

  private reference(offset: number, type: Type, bits = 64): Value {
    const id = this.readBits(offset, bits);
    const key = referenceKey(id, bits);
    const stored = this.referenceOffsets.get(offset);
    const value =
      (stored?.key === key ? stored.value : undefined) ?? this.referenceHolds.get(key) ?? this.space.reference(key);
    if (value) {
      this.referenceHolds.set(key, value);
      this.referenceOffsets.set(offset, { key, value, id, bits });
    }
    return value instanceof Pointer && type.kind === 'pointer'
      ? viewPointer(value, type.child, this.space)
      : ((value as Value) ?? undefinedValue(type));
  }

  private writeReference(offset: number, value: Value, type: Type, bits = 64, identity?: object): void {
    if (typeof value !== 'object') {
      this.writeBits(offset, bits, 0n);
      return;
    }
    if (this.addressOf) {
      this.writeBits(offset, bits, this.addressOf(identity ?? value));
      return;
    }
    let id: bigint;
    if (bits === 16) {
      const existing = this.space.errorReferenceIds.get(value);
      id = existing ?? 1n + (this.space.nextErrorReferenceId++ % 65_535n);
      this.space.errorReferenceIds.set(value, id);
    } else {
      const location =
        value instanceof Pointer
          ? value.storageLocation()
          : { storage: identity ?? (value instanceof FnValue ? value.fn : value), index: 0 };
      id = (this.space.identityOf(location.storage) << 32n) + BigInt(location.index * 8);
    }
    if (value instanceof Pointer && type.kind === 'pointer') rememberPointerType(value, type.child);
    const key = referenceKey(id, bits);
    this.space.keepReference(key, value);
    this.referenceHolds.set(key, value);
    this.referenceOffsets.set(offset, { key, value, id, bits });
    this.writeBits(offset, bits, id);
  }

  private unionTag(type: Extract<Type, { kind: 'union' }>, offset: number): number {
    if (!type.tagType) {
      const index = Number(this.readBits(offset, 8));
      return index < (type.fields?.length ?? 0) ? index : -1;
    }
    const value = this.read(type.tagType, offset);
    return enumLookup(type.tagType.fields!, this.spend).indexByValue.get(value as bigint) ?? -1;
  }
}

function unionFieldLocation(type: Extract<Type, { kind: 'union' }>, index: number, offset: number): FieldLocation {
  const field = type.fields?.[index];
  if (!field) return panic(PANIC.invalidEnum);
  return { type: field.type, offset, packed: type.layout === 'packed' ? bitSizeOf(field.type) : undefined };
}

function unionBitSize(type: Extract<Type, { kind: 'union' }>): number {
  return type.layout === 'packed' ? bitSizeOf(type) : sizeOf(type) * 8;
}

function encodesReferences(type: Type, cached: WeakMap<Type, boolean>, spend: () => void): boolean {
  spend();
  const prior = cached.get(type);
  if (prior !== undefined) return prior;
  let result = false;
  switch (type.kind) {
    case 'pointer': {
      result = true;
      break;
    }
    case 'array':
    case 'optional': {
      result = encodesReferences(type.child, cached, spend);
      break;
    }
    case 'error_union': {
      result = encodesReferences(type.payload, cached, spend);
      break;
    }
    case 'struct': {
      result =
        !usesFieldLayout(type) ||
        Boolean(
          type.fields?.some(
            (field) => field.comptimeValue === undefined && encodesReferences(field.type, cached, spend)
          )
        );
      break;
    }
    case 'union': {
      result = Boolean(type.fields?.some((field) => encodesReferences(field.type, cached, spend)));
      break;
    }
  }
  cached.set(type, result);
  return result;
}

function referenceKey(id: bigint, bits: number): string {
  const projection = bits === 16 ? 'error' : 'address';
  return `${id} ${projection}`;
}
