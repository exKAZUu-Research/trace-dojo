import { isPointerType, isValueType, type NamedType, sameType, substitute, substitutionOf, type Type } from './types';
import { CsStruct, type Value } from './values';

const PRIMITIVE_SIZES: Partial<Record<string, number>> = {
  sbyte: 1,
  byte: 1,
  bool: 1,
  short: 2,
  ushort: 2,
  char: 2,
  int: 4,
  uint: 4,
  float: 4,
  long: 8,
  ulong: 8,
  double: 8,
  decimal: 16,
};

/** Where each field of a struct lies, and the struct's size and alignment, as .NET's sequential layout places them. */
export interface Layout {
  size: number;
  align: number;
  fields: { slot: number; offset: number; type: Type }[];
}

/** The primitive type a value of a type is stored as: its own, or an enum's underlying type. */
function primitiveOf(type: Type): string | undefined {
  if (type.kind !== 'named') return undefined;
  if (type.symbol.kind === 'enum') return type.symbol.enumUnderlying?.symbol.special;
  return type.symbol.special;
}

/** The layout of a type's values in memory: a primitive's, a pointer's or reference's (8 bytes), or a struct's. */
export function layoutOf(type: Type): Layout {
  const primitive = primitiveOf(type);
  const size = primitive ? PRIMITIVE_SIZES[primitive] : undefined;
  if (size !== undefined) return { size, align: Math.min(size, 8), fields: [] };
  if (type.kind !== 'named' || !isValueType(type) || isPointerType(type)) return { size: 8, align: 8, fields: [] };
  const substitution = substitutionOf(type);
  const fields: Layout['fields'] = [];
  let offset = 0;
  let align = 1;
  for (const field of type.symbol.fields.filter((candidate) => !candidate.isStatic && !candidate.isConst)) {
    const fieldType = substitute(field.type, substitution);
    const inner = layoutOf(fieldType);
    offset = Math.ceil(offset / inner.align) * inner.align;
    fields.push({ slot: field.slot, offset, type: fieldType });
    offset += inner.size;
    align = Math.max(align, inner.align);
  }
  // An empty struct still takes a byte.
  return { size: Math.max(Math.ceil(offset / align) * align, 1), align, fields };
}

export function sizeOf(type: Type): number {
  return layoutOf(type).size;
}

/** Access through a pointer outside the storage it points into, which .NET leaves undefined; here it stops the run. */
export class PointerRangeError extends Error {
  constructor() {
    super('ポインターが、確保された範囲の外を指しています。');
    this.name = 'PointerRangeError';
  }
}

/** Pointable storage: a variable, an array's elements, a string's characters, or a `stackalloc` buffer. */
export class MemoryBlock {
  readonly elementSize: number;

  constructor(
    /** The block's virtual address, which pointer-to-integer casts and comparisons across blocks use. */
    readonly base: bigint,
    readonly elementType: Type,
    readonly length: number,
    readonly get: (index: number) => Value,
    readonly set: ((index: number, value: Value) => void) | undefined
  ) {
    this.elementSize = sizeOf(elementType);
  }

  get byteLength(): number {
    return this.elementSize * this.length;
  }
}

/** A pointer: a byte offset into a block, or with no block, an address that points into no storage. */
export class CsPointer {
  constructor(
    readonly block: MemoryBlock | undefined,
    readonly offset: number
  ) {}

  get address(): bigint {
    return (this.block?.base ?? 0n) + BigInt(this.offset);
  }

  moved(bytes: number): CsPointer {
    return new CsPointer(this.block, this.offset + bytes);
  }

  /** The text a trace shows for the pointer: its virtual address in hexadecimal. */
  get text(): string {
    return `0x${this.address.toString(16).toUpperCase()}`;
  }
}

/** The run's pointable storage, each block at its own virtual address, and one block for each variable. */
export class PointerMemory {
  private next = 0x1_00_00n;
  private readonly blocks: MemoryBlock[] = [];
  private readonly byOwner = new WeakMap<object, Map<unknown, MemoryBlock>>();

  /** The block of some storage, made once per owner and key so that `&x` gives the same address each time. */
  blockOf(owner: object, key: unknown, make: () => BlockParts): MemoryBlock {
    let keyed = this.byOwner.get(owner);
    if (!keyed) {
      keyed = new Map();
      this.byOwner.set(owner, keyed);
    }
    let block = keyed.get(key);
    if (!block) {
      block = this.allocate(make());
      keyed.set(key, block);
    }
    return block;
  }

  allocate(parts: BlockParts): MemoryBlock {
    const block = new MemoryBlock(this.next, parts.elementType, parts.length, parts.get, parts.set);
    // Blocks lie apart, aligned to 16 bytes, so that no pointer of one points into another.
    this.next += BigInt(Math.ceil((block.byteLength + 16) / 16) * 16);
    this.blocks.push(block);
    return block;
  }

  /** The pointer of an address that a cast from an integer gives. */
  pointerAt(address: bigint): CsPointer | undefined {
    if (address === 0n) return undefined;
    const block = this.blocks.find(
      (candidate) => candidate.base <= address && address < candidate.base + BigInt(candidate.byteLength)
    );
    return block ? new CsPointer(block, Number(address - block.base)) : new CsPointer(undefined, Number(address));
  }
}

export interface BlockParts {
  elementType: Type;
  length: number;
  get: (index: number) => Value;
  set: ((index: number, value: Value) => void) | undefined;
}

// ---- Reading and writing ----

/** Reads a value of a type at a pointer, reinterpreting the bytes of what is stored there when the types differ. */
export function readAt(pointer: CsPointer, type: Type): Value {
  const { block, index, inner } = locate(pointer, sizeOf(type));
  const element = block.get(index);
  if (inner === 0 && sameType(type, block.elementType)) return element;
  if (inner + sizeOf(type) <= block.elementSize) return readWithin(element, block.elementType, inner, type);
  return decode(spanBytes(block, pointer.offset, sizeOf(type)), type);
}

/** Writes a value of a type at a pointer, into a struct's field in place or over the bytes stored there. */
export function writeAt(pointer: CsPointer, type: Type, value: Value): void {
  const { block, index, inner } = locate(pointer, sizeOf(type));
  if (!block.set) throw new PointerRangeError();
  if (inner === 0 && sameType(type, block.elementType)) {
    block.set(index, value);
    return;
  }
  if (inner + sizeOf(type) <= block.elementSize) {
    block.set(index, writeWithin(block.get(index), block.elementType, inner, type, value));
    return;
  }
  const bytes = encode(value, type);
  for (let at = 0; at < bytes.length;) {
    const offset = pointer.offset + at;
    const elementIndex = Math.floor(offset / block.elementSize);
    const start = offset - elementIndex * block.elementSize;
    const count = Math.min(block.elementSize - start, bytes.length - at);
    const old = encode(block.get(elementIndex), block.elementType);
    old.set(bytes.subarray(at, at + count), start);
    block.set(elementIndex, decode(old, block.elementType));
    at += count;
  }
}

function locate(pointer: CsPointer, size: number): { block: MemoryBlock; index: number; inner: number } {
  const { block, offset } = pointer;
  if (!block || offset < 0 || offset + size > block.byteLength) throw new PointerRangeError();
  const index = Math.floor(offset / block.elementSize);
  return { block, index, inner: offset - index * block.elementSize };
}

function spanBytes(block: MemoryBlock, offset: number, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let at = 0; at < size; at++) {
    const elementIndex = Math.floor((offset + at) / block.elementSize);
    bytes[at] = encode(block.get(elementIndex), block.elementType)[offset + at - elementIndex * block.elementSize];
  }
  return bytes;
}

function fieldAt(type: Type, inner: number, size: number): Layout['fields'][number] | undefined {
  return layoutOf(type).fields.find(
    (field) => field.offset <= inner && inner + size <= field.offset + sizeOf(field.type)
  );
}

function readWithin(value: Value, valueType: Type, inner: number, type: Type): Value {
  if (inner === 0 && sameType(type, valueType)) return value;
  if (value instanceof CsStruct && !primitiveOf(valueType)) {
    const field = fieldAt(valueType, inner, sizeOf(type));
    if (field) return readWithin(value.fields[field.slot], field.type, inner - field.offset, type);
  }
  return decode(encode(value, valueType).subarray(inner, inner + sizeOf(type)), type);
}

function writeWithin(holder: Value, holderType: Type, inner: number, type: Type, value: Value): Value {
  if (inner === 0 && sameType(type, holderType)) return value;
  if (holder instanceof CsStruct && !primitiveOf(holderType)) {
    const field = fieldAt(holderType, inner, sizeOf(type));
    if (field) {
      // A struct holds its fields in place, so a pointer into a local's struct changes the local itself.
      holder.fields[field.slot] = writeWithin(holder.fields[field.slot], field.type, inner - field.offset, type, value);
      return holder;
    }
  }
  const bytes = encode(holder, holderType);
  bytes.set(encode(value, type), inner);
  return decode(bytes, holderType);
}

/** The little-endian bytes of a value, as .NET stores it on the machines it runs on. */
// code-gauge-allow functionNcss -- One case per kind of syntax or value that the function handles.
function encode(value: Value, type: Type): Uint8Array {
  const layout = layoutOf(type);
  const bytes = new Uint8Array(layout.size);
  const view = new DataView(bytes.buffer);
  const primitive = primitiveOf(type);
  switch (primitive) {
    case 'bool': {
      view.setUint8(0, value ? 1 : 0);
      return bytes;
    }
    case 'sbyte':
    case 'byte': {
      view.setUint8(0, Number(value) & 0xff);
      return bytes;
    }
    case 'short':
    case 'ushort':
    case 'char': {
      view.setUint16(0, Number(value) & 0xff_ff, true);
      return bytes;
    }
    case 'int':
    case 'uint': {
      view.setUint32(0, Number(value) >>> 0, true);
      return bytes;
    }
    case 'long':
    case 'ulong': {
      view.setBigUint64(0, BigInt.asUintN(64, value as bigint), true);
      return bytes;
    }
    case 'float': {
      view.setFloat32(0, value as number, true);
      return bytes;
    }
    case 'double': {
      view.setFloat64(0, value as number, true);
      return bytes;
    }
  }
  if (value instanceof CsStruct && type.kind === 'named') {
    for (const field of layout.fields) bytes.set(encode(value.fields[field.slot], field.type), field.offset);
    return bytes;
  }
  if (value instanceof CsPointer) {
    view.setBigUint64(0, value.address, true);
    return bytes;
  }
  // References have no bytes that a program could read.
  throw new PointerRangeError();
}

// code-gauge-allow functionNcss -- One case per kind of syntax or value that the function handles.
// code-gauge-allow duplicateLines -- Each interpreter decodes the bytes of its own numeric types.
function decode(bytes: Uint8Array, type: Type): Value {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (primitiveOf(type)) {
    case 'bool': {
      return view.getUint8(0) !== 0;
    }
    case 'sbyte': {
      return view.getInt8(0);
    }
    case 'byte': {
      return view.getUint8(0);
    }
    case 'short': {
      return view.getInt16(0, true);
    }
    case 'ushort':
    case 'char': {
      return view.getUint16(0, true);
    }
    case 'int': {
      return view.getInt32(0, true);
    }
    case 'uint': {
      return view.getUint32(0, true);
    }
    case 'long': {
      return view.getBigInt64(0, true);
    }
    case 'ulong': {
      return view.getBigUint64(0, true);
    }
    case 'float': {
      return view.getFloat32(0, true);
    }
    case 'double': {
      return view.getFloat64(0, true);
    }
  }
  if (type.kind === 'named' && isValueType(type) && !isPointerType(type)) {
    const layout = layoutOf(type);
    const fields: Value[] = Array.from({ length: (type as NamedType).symbol.instanceFieldCount });
    for (const field of layout.fields)
      fields[field.slot] = decode(bytes.subarray(field.offset, field.offset + sizeOf(field.type)), field.type);
    return new CsStruct(type as NamedType, fields);
  }
  throw new PointerRangeError();
}
