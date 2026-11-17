import { panic } from './arith';
import { enumLookup } from './enumLookup';
import { asBigFloat, BigFloat, type FloatBits, floatOf, FORMATS } from './floats';
import { bitSizeOf, errorUnionOffsets, fieldOffsets, optionalNicheBits, sizeOf, unionOffsets } from './layout';
import { copyForStorage, undefinedValue } from './semaBase';
import { singleValueOf } from './singleValue';
import { type Type, typeId } from './types';
import {
  ErrorValue,
  NULL,
  Pointer,
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
import { WeakValueMap } from './weakValueMap';

interface FieldLocation {
  type: Type;
  offset: number;
  packed?: number;
  constant?: { value: Value };
}

export class BufferMemorySpace {
  readonly memories = new WeakMap<Value[], BufferMemory>();
  readonly referenceIds = new WeakMap<object, bigint>();
  readonly references = new WeakValueMap<string, object>();
  nextReferenceId = 1n;
  readonly errorReferenceIds = new WeakMap<object, bigint>();
  nextErrorReferenceId = 1n;
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
  const initial = singleValueOf(type, spend) ? [] : destination.slots.slice(0, initialized).map(copyForStorage);
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

class BufferMemory {
  private readonly views = new Map<string, Value>();
  private readonly referenceHolds = new Map<string, object>();

  constructor(
    private readonly bytes: Value[],
    private readonly spend: () => void,
    private readonly space: BufferMemorySpace,
    private readonly addressOf?: (value: object) => bigint
  ) {}

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
        if (!field) panic('index out of bounds');
        this.write(field.type, field.offset, value, field.packed);
        return true;
      },
    });
    registerStorageLocation(slots, (index) => ({ storage: this.bytes, index: (fields[index]?.offset ?? 0) / 8 }));
    return slots;
  }

  // code-gauge-allow functionNcss 40 -- Decodes each scalar representation and transparent wrapper from shared bytes.
  // code-gauge-allow functionCognitiveComplexity 22 -- Decodes each scalar representation and transparent wrapper from shared bytes.
  private read(type: Type, offset: number, packed?: number): Value {
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
        const length = this.readBits(offset + 64, 64);
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

  // code-gauge-allow functionCognitiveComplexity 21 -- Builds stable typed views for arrays, structs, and tagged unions.
  private readAggregate(type: Extract<Type, { kind: 'array' | 'struct' | 'union' }>, offset: number): Value {
    const key = `${typeId(type)} ${offset}`;
    if (type.kind === 'struct' && (type.native?.storageSlots !== undefined || type.native?.kind === 'allocator'))
      return this.reference(offset, type);
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
      const layout = unionOffsets(type);
      const tag = (): number => this.unionTag(type, offset + layout.tag * 8);
      const union = new ZUnion(0, undefined);
      Object.defineProperty(union, 'tag', {
        get: tag,
        set: (index: number) => {
          const encoded = type.tagType?.fields?.[index]?.value ?? BigInt(index);
          this.writeBits(offset + layout.tag * 8, (type.tagType ? sizeOf(type.tagType) : 1) * 8, encoded);
        },
      });
      union.slots = new Proxy([undefined] as Value[], {
        get: (target, property, receiver) =>
          property === '0'
            ? this.read(type.fields![tag()].type, offset + layout.payload * 8)
            : Reflect.get(target, property, receiver),
        set: (target, property, value: Value, receiver) => {
          if (property !== '0') return Reflect.set(target, property, value, receiver);
          this.write(type.fields![tag()].type, offset + layout.payload * 8, value);
          return true;
        },
      });
      registerStorageLocation(union.slots, () => ({ storage: this.bytes, index: offset / 8 + layout.payload }));
      value = union;
    }
    this.views.set(key, value);
    return value;
  }

  arrayView(child: Type, length: bigint, offset: number, hasSentinel = false): ZArray {
    const singleton = singleValueOf(child, this.spend);
    if (singleton) {
      const array = zeroArray(length, hasSentinel, copyForStorage(singleton.value));
      registerStorageLocation(array.slots, () => ({ storage: this.bytes, index: offset / 8 }), true);
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
    registerStorageLocation(slots, (index) => ({ storage: this.bytes, index: offset / 8 + index * stride }), true);
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
        this.writeBits(offset, type.bits, encodeFloat(value, type.bits));
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
          this.writeBits(offset + 64, 64, slice.lengthValue);
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

  // code-gauge-allow functionCognitiveComplexity 21 -- Writes aggregate contents using their physical layout without replacing interior views.
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
          this.write(type.child, offset + Number(type.length) * sizeOf(type.child) * 8, type.sentinel);
        return;
      }
      case 'struct': {
        if (type.native?.storageSlots !== undefined || type.native?.kind === 'allocator') {
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
        const union = value as ZUnion;
        const layout = unionOffsets(type);
        if (type.tagType) this.write(type.tagType, offset + layout.tag * 8, type.tagType.fields![union.tag].value);
        else this.writeBits(offset + layout.tag * 8, 8, BigInt(union.tag));
        this.write(type.fields![union.tag].type, offset + layout.payload * 8, union.slots[0]);
        return;
      }
    }
  }

  private readBits(offset: number, bits: number): bigint {
    if (offset < 0 || offset + bits > this.bytes.length * 8) panic('index out of bounds');
    let result = 0n;
    for (let index = 0; index < bits; index += 8) {
      this.spend();
      const position = offset + index;
      const byte = position >> 3;
      const shift = position & 7;
      let value = Number(this.bytes[byte] as bigint) >> shift;
      if (shift !== 0 && index + 8 < bits + shift)
        value |= Number((this.bytes[byte + 1] ?? 0n) as bigint) << (8 - shift);
      result |= BigInt(value & ((1 << Math.min(8, bits - index)) - 1)) << BigInt(index);
    }
    return result;
  }

  private writeBits(offset: number, bits: number, value: bigint): void {
    if (offset < 0 || offset + bits > this.bytes.length * 8) panic('index out of bounds');
    for (let index = 0; index < bits;) {
      this.spend();
      const position = offset + index;
      const byte = position >> 3;
      const shift = position & 7;
      const count = Math.min(8 - shift, bits - index);
      const mask = ((1 << count) - 1) << shift;
      const previous = Number(this.bytes[byte] as bigint);
      this.bytes[byte] = BigInt(
        (previous & ~mask) | (Number((value >> BigInt(index)) & BigInt((1 << count) - 1)) << shift)
      );
      index += count;
    }
  }

  private reference(offset: number, type: Type, bits = 64): Value {
    const id = this.readBits(offset, bits);
    const key = referenceKey(id, type, bits);
    const value = this.referenceHolds.get(key) ?? this.space.references.get(key);
    if (value) this.referenceHolds.set(key, value);
    return (value as Value) ?? undefinedValue(type);
  }

  private writeReference(offset: number, value: Value, type: Type, bits = 64): void {
    if (typeof value !== 'object') {
      this.writeBits(offset, bits, 0n);
      return;
    }
    if (this.addressOf) {
      this.writeBits(offset, bits, this.addressOf(value));
      return;
    }
    let id: bigint;
    if (bits === 16) {
      const existing = this.space.errorReferenceIds.get(value);
      id = existing ?? 1n + (this.space.nextErrorReferenceId++ % 65_535n);
      this.space.errorReferenceIds.set(value, id);
    } else {
      const location = value instanceof Pointer ? value.storageLocation() : { storage: value, index: 0 };
      let base = this.space.referenceIds.get(location.storage);
      if (base === undefined) {
        base = this.space.nextReferenceId++;
        this.space.referenceIds.set(location.storage, base);
      }
      id = (base << 40n) + BigInt(location.index * 8);
    }
    const key = referenceKey(id, type, bits);
    this.space.references.set(key, value);
    this.referenceHolds.set(key, value);
    this.writeBits(offset, bits, id);
  }

  private unionTag(type: Extract<Type, { kind: 'union' }>, offset: number): number {
    if (!type.tagType) return Number(this.readBits(offset, 8));
    const value = this.read(type.tagType, offset);
    return enumLookup(type.tagType.fields!, this.spend).indexByValue.get(value as bigint) ?? -1;
  }
}

function referenceKey(id: bigint, type: Type, bits: number): string {
  const projection = bits === 16 ? 'error' : typeId(type.kind === 'pointer' ? type.child : type);
  return `${id} ${projection}`;
}

function propertyIndex(property: string | symbol): number | undefined {
  return typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property) ? Number(property) : undefined;
}

// code-gauge-allow functionCognitiveComplexity 20 -- Encodes normal, subnormal, infinite, and NaN values across the supported binary formats.
function encodeFloat(value: Value, bits: FloatBits): bigint {
  const float = asBigFloat(value as number | BigFloat);
  const precision = FORMATS[bits].precision;
  const fractionBits = precision - 1;
  const exponentBits = bits === 16 ? 5 : bits === 32 ? 8 : bits === 64 ? 11 : 15;
  const bias = (1 << (exponentBits - 1)) - 1;
  const explicit = bits === 80;
  const mantissaBits = fractionBits + (explicit ? 1 : 0);
  let exponent = 0;
  let mantissa = 0n;
  if (float.kind !== 'finite') {
    exponent = (1 << exponentBits) - 1;
    mantissa =
      (explicit ? 1n << BigInt(fractionBits) : 0n) | (float.kind === 'nan' ? 1n << BigInt(fractionBits - 1) : 0n);
  } else if (float.mantissa !== 0n) {
    const highest = float.mantissa.toString(2).length - 1 + float.exponent;
    exponent = Math.max(0, highest + bias);
    const unitExponent = (exponent === 0 ? 1 - bias : highest) - fractionBits;
    const shift = float.exponent - unitExponent;
    mantissa = shift >= 0 ? float.mantissa << BigInt(shift) : float.mantissa >> BigInt(-shift);
    if (!explicit && exponent !== 0) mantissa -= 1n << BigInt(fractionBits);
  }
  return (BigInt(float.sign) << BigInt(bits - 1)) | (BigInt(exponent) << BigInt(mantissaBits)) | mantissa;
}

function decodeFloat(value: bigint, bits: FloatBits): Value {
  const fractionBits = FORMATS[bits].precision - 1;
  const exponentBits = bits === 16 ? 5 : bits === 32 ? 8 : bits === 64 ? 11 : 15;
  const bias = (1 << (exponentBits - 1)) - 1;
  const mantissaBits = fractionBits + (bits === 80 ? 1 : 0);
  const exponent = Number((value >> BigInt(mantissaBits)) & BigInt((1 << exponentBits) - 1));
  const sign = value >> BigInt(bits - 1) !== 0n;
  let mantissa = value & ((1n << BigInt(mantissaBits)) - 1n);
  if (exponent === (1 << exponentBits) - 1) {
    const fraction = mantissa & ((1n << BigInt(fractionBits)) - 1n);
    return floatOf(new BigFloat(sign, fraction === 0n ? 'inf' : 'nan', 0n, 0), bits);
  }
  if (exponent !== 0 && bits !== 80) mantissa |= 1n << BigInt(fractionBits);
  return floatOf(
    new BigFloat(sign, 'finite', mantissa, (exponent === 0 ? 1 - bias : exponent - bias) - fractionBits),
    bits
  );
}
