import { CppRuntimeError } from './errors';
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
import { Box, CObject, Ptr, Store, type Value } from './values';

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
  if (target.kind === 'class' && source.cls.isDerivedFrom(target.cls)) return pointer;
  const object = pointer.readRaw();
  if (!(object instanceof CObject)) return;
  if (
    target.kind === 'class' &&
    target.cls.isDerivedFrom(source.cls) &&
    object.cls.isDerivedFrom(target.cls) &&
    isStandardLayout(object.cls)
  )
    return pointer;
  const first = source.cls.fields[0];
  if (!first) return;
  const location = new Ptr(object, first.index, { location: pointer, cls: source.cls });
  return firstSubobject(location, first.type, target);
}

function enclosingSubobject(pointer: Ptr, source: Type, target: ClassType): Ptr | undefined {
  const member = pointer.memberOwner;
  if (!member) return;
  const context = pointer.enclosingObject;
  const location = context?.location ?? new Ptr(new Box(member.object, false), 0);
  const requestedMember = target.cls.fields[0];
  if (
    member.object.cls.isDerivedFrom(target.cls) &&
    requestedMember?.index === member.field &&
    sameType(requestedMember.type, source, false)
  )
    return location;
  const owner = context?.cls ?? member.object.cls;
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
    const original = this.place(index);
    const bits = encodeScalar(original.read(), this.source);
    if (!this.byteView) return decodeScalar(bits, this.target);
    const byte = bits.getUint8(this.byteOffset(index));
    return this.target.name === 'char' && byte >= 128 ? byte - 256 : byte;
  }

  set(index: number, value: Value): void {
    const original = this.place(index);
    const bits = this.byteView ? encodeScalar(original.read(), this.source) : encodeScalar(value, this.target);
    if (this.byteView) bits.setUint8(this.byteOffset(index), Number(value));
    original.write(decodeScalar(bits, this.source));
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

  override get address(): Ptr['address'] {
    return this.storageAddress;
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
  if (type.kind === 'int') bits.setBigUint64(0, BigInt.asUintN(64, BigInt(value as number | bigint)), true);
  else if (type.name === 'float') bits.setFloat32(0, value as number, true);
  else bits.setFloat64(0, value as number, true);
  return bits;
}

function decodeScalar(bits: DataView, type: ArithmeticType): number | bigint {
  if (type.kind === 'float') return type.name === 'float' ? bits.getFloat32(0, true) : bits.getFloat64(0, true);
  const width = sizeOf(type) * 8;
  const stored = bits.getBigUint64(0, true);
  const integer = isSigned(type) ? BigInt.asIntN(width, stored) : BigInt.asUintN(width, stored);
  if (type.name === 'bool' && integer > 1n) throw new CppRuntimeError('custom', 'bool 型の表現が正しくありません。');
  return isWide(type) ? integer : Number(integer);
}
