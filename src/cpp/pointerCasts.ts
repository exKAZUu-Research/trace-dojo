import { CppRuntimeError } from './errors';
import { FloatNaN } from './floatSign';
import {
  type ArithmeticType,
  type ClassType,
  classType,
  type IntType,
  isArithmetic,
  isSigned,
  isStandardLayout,
  isWide,
  sameType,
  sizeOf,
  type Type,
  typeName,
} from './types';
import { CObject, PartialScalar, Ptr, Store, UNINIT, type Value } from './values';

export function erasePointee(pointer: Ptr, pointee: Type): Ptr {
  if (pointer instanceof IncompatiblePointer) return pointer.erased;
  if (pointer.isNull || pointer instanceof ErasedPointer) return pointer;
  if (pointer instanceof ScalarAliasPointer) return pointer.erase();
  return new ErasedPointer(pointer, pointee);
}

export function recoverPointee(pointer: Ptr, target: Type): Ptr {
  if (pointer.isNull || !(pointer instanceof ErasedPointer)) return pointer;
  const { original, pointee } = pointer;
  if (sameType(pointee, target, false)) return original;
  const related = pointerInterconvertible(original, pointee, target);
  if (related) return related;
  if (isArithmetic(pointee) && target.kind === 'int') {
    const byteView = target.name === 'char' || target.name === 'uchar';
    if (byteView || correspondingIntegers(pointee, target)) {
      const storage = new ScalarAliasStorage(original, pointee, target, byteView);
      return storage.location(storage.first);
    }
  }
  return new IncompatiblePointer(pointer, target);
}

function pointerInterconvertible(pointer: Ptr, source: Type, target: Type): Ptr | undefined {
  const inside = firstSubobject(pointer, source, target);
  if (inside) return inside;
  if (target.kind === 'class' && isStandardLayout(target.cls)) return enclosingSubobject(pointer, source, target);
}

function firstSubobject(pointer: Ptr, source: Type, target: Type): Ptr | undefined {
  if (sameType(source, target, false)) return pointer;
  if (source.kind !== 'class' || !isStandardLayout(source.cls)) return;
  if (target.kind === 'class' && source.cls.isDerivedFrom(target.cls)) return pointer.forClass(target.cls);
  const object = pointer.readRaw();
  if (!(object instanceof CObject)) return;
  if (
    target.kind === 'class' &&
    target.cls.isDerivedFrom(source.cls) &&
    object.cls.isDerivedFrom(target.cls) &&
    isStandardLayout(object.cls)
  )
    return pointer.forClass(target.cls);
  const first = source.cls.fields[0];
  if (!first) return;
  const location = new Ptr(object, first.index, { location: pointer, cls: source.cls });
  return firstSubobject(location, first.type, target);
}

function enclosingSubobject(pointer: Ptr, source: Type, target: ClassType): Ptr | undefined {
  const member = pointer.memberOwner;
  if (!member) return;
  const context = pointer.enclosingObject;
  const owner = context?.cls ?? member.object.completeClass;
  const location = context?.location ?? member.object.receiver(owner);
  const requestedMember = target.cls.fields[0];
  if (
    member.object.cls.isDerivedFrom(target.cls) &&
    requestedMember?.index === member.field &&
    sameType(requestedMember.type, source, false)
  )
    return location.forClass(target.cls);
  const first = owner.fields[0];
  if (isStandardLayout(owner) && first?.index === member.field && sameType(first.type, source, false))
    return enclosingSubobject(location, classType(owner), target);
}

function correspondingIntegers(from: ArithmeticType, to: IntType): boolean {
  if (from.kind !== 'int') return false;
  const counterparts: Partial<Record<IntType['name'], IntType['name']>> = {
    schar: 'uchar',
    short: 'ushort',
    int: 'uint',
    long: 'ulong',
    llong: 'ullong',
  };
  return counterparts[from.name] === to.name || counterparts[to.name] === from.name;
}

class ErasedPointer extends Ptr {
  constructor(
    readonly original: Ptr,
    readonly pointee: Type
  ) {
    super(undefined, 0);
  }

  override get store(): Store | undefined {
    return this.original.store;
  }

  override get index(): number {
    return this.original.index;
  }

  override get address(): Ptr['address'] {
    return this.original.address;
  }

  override get storageAddress(): Ptr['storageAddress'] {
    return this.original.storageAddress;
  }
}

class IncompatiblePointer extends ErasedPointer {
  constructor(
    readonly erased: ErasedPointer,
    readonly requested: Type
  ) {
    super(erased.original, erased.pointee);
  }

  override target(): Store {
    throw new CppRuntimeError(
      'custom',
      `${typeName(this.pointee)} 型の値を ${typeName(this.requested)} 型のポインタで扱えません。`
    );
  }
}

class ScalarAliasStorage extends Store {
  private readonly start: number;
  private readonly width: number;

  constructor(
    readonly origin: Ptr,
    readonly source: ArithmeticType,
    readonly target: IntType,
    readonly byteView: boolean
  ) {
    super();
    this.start = origin.index;
    this.width = byteView ? sizeOf(source) : 1;
  }

  get first(): number {
    return this.start * this.width;
  }

  get length(): number {
    return (this.origin.target().length + this.start - this.origin.index) * this.width;
  }

  override checkAlive(): void {
    this.origin.target();
  }

  children(): Value[] {
    return [this.origin];
  }

  override location(index: number): Ptr {
    return new ScalarAliasPointer(this, index);
  }

  get(index: number): Value {
    const original = this.elementPlace(index);
    if (!this.byteView) return decodeScalar(encodeScalar(original.read(), this.source), this.target);
    const value = original.readRaw() ?? original.read();
    const offset = this.byteOffset(index);
    if (value === UNINIT || (value instanceof PartialScalar && (value.initializedByteMask & (1 << offset)) === 0))
      throw new CppRuntimeError('uninitialized');
    const byte = encodeScalar(value, this.source).getUint8(offset);
    return this.target.name === 'char' && byte >= 128 ? byte - 256 : byte;
  }

  set(index: number, value: Value): void {
    const original = this.elementPlace(index);
    if (!this.byteView) {
      original.write(decodeScalar(encodeScalar(value, this.target), this.source));
      return;
    }
    const stored = original.readRaw() ?? original.read();
    const offset = this.byteOffset(index);
    const fullMask = (1 << this.width) - 1;
    const initialized = stored instanceof PartialScalar ? stored.initializedByteMask : stored === UNINIT ? 0 : fullMask;
    const mask = initialized | (1 << offset);
    const bits = encodeScalar(stored, this.source);
    bits.setUint8(offset, Number(value));
    original.write(
      mask === fullMask ? decodeScalar(bits, this.source) : new PartialScalar(bits.getBigUint64(0, true), mask)
    );
  }

  private elementPlace(index: number): Ptr {
    if (index < 0 || index >= this.length) throw new CppRuntimeError('outOfBounds');
    return this.place(index);
  }

  place(index: number): Ptr {
    return this.origin.offset(Math.floor(index / this.width) - this.start);
  }

  byteOffset(index: number): number {
    return index % this.width;
  }
}

class ScalarAliasPointer extends Ptr {
  constructor(
    readonly alias: ScalarAliasStorage,
    index: number
  ) {
    super(alias, index);
  }

  override offset(delta: number | bigint, asIterator = false): Ptr {
    if (!this.alias.byteView) throw new CppRuntimeError('pointerOutOfRange');
    return super.offset(delta, asIterator);
  }

  override sharesRange(other: Ptr): boolean {
    return this.alias.byteView && super.sharesRange(other);
  }

  override get address(): Ptr['address'] {
    const { store, index } = this.alias.place(this.index).address;
    return { store, index: index + this.alias.byteOffset(this.index) };
  }

  override byteAddress(): Ptr['address'] {
    const place = this.alias.place(this.index);
    const { store, index } = place.byteAddress(sizeOf(this.alias.source));
    return { store, index: index + this.alias.byteOffset(this.index) };
  }

  override get storageAddress(): Ptr['storageAddress'] {
    const address = this.alias.place(this.index).storageAddress;
    return {
      store: address.store,
      index: address.index + this.alias.byteOffset(this.index) / sizeOf(this.alias.source),
    };
  }

  erase(): Ptr {
    return this.alias.byteOffset(this.index) === 0
      ? erasePointee(this.alias.place(this.index), this.alias.source)
      : new ErasedPointer(this, this.alias.target);
  }
}

function encodeScalar(value: Value, type: ArithmeticType): DataView {
  const bits = new DataView(new ArrayBuffer(8));
  if (value === UNINIT) return bits;
  if (value instanceof PartialScalar) bits.setBigUint64(0, value.bits, true);
  else if (value instanceof FloatNaN) bits.setBigUint64(0, value.bits(type.name === 'float'), true);
  else if (type.kind === 'int') bits.setBigUint64(0, BigInt.asUintN(64, BigInt(value as number | bigint)), true);
  else if (type.name === 'float') bits.setFloat32(0, value as number, true);
  else bits.setFloat64(0, value as number, true);
  return bits;
}

function decodeScalar(bits: DataView, type: ArithmeticType): Value {
  if (type.kind === 'float') {
    const single = type.name === 'float';
    const value = single ? bits.getFloat32(0, true) : bits.getFloat64(0, true);
    if (!Number.isNaN(value)) return value;
    const representation = single ? BigInt(bits.getUint32(0, true)) : bits.getBigUint64(0, true);
    return FloatNaN.fromBits(representation, single);
  }
  const width = sizeOf(type) * 8;
  const stored = bits.getBigUint64(0, true);
  const integer = isSigned(type) ? BigInt.asIntN(width, stored) : BigInt.asUintN(width, stored);
  if (type.name === 'bool' && integer > 1n) throw new CppRuntimeError('custom', 'bool 型の表現が正しくありません。');
  return isWide(type) ? integer : Number(integer);
}
