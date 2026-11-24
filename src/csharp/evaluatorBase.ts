import { BinderBase } from './binderBase';
import type { CompiledProgram } from './compiler';
import type { ConversionKind, Conversions } from './conversions';
import { CsDecimal } from './decimal';
import { convertNumeric, type NumericValue, PendingException } from './numeric';
import { runtimeTypeName } from './objects';
import type { Frame, Runtime, Slot } from './runtime';
import {
  baseTypeOf,
  isReferenceType,
  type LocalSymbol,
  type MethodSymbol,
  type NamedType,
  nullableUnderlying,
  type PropertySymbol,
  sameType,
  specialOf,
  type SpecialType,
  substitute,
  substitutionOf,
  type Type,
  type TypeParameterSymbol,
} from './types';
import {
  Cell,
  copyValue,
  CsArray,
  CsBox,
  CsDelegate,
  CsObject,
  CsStruct,
  isString,
  UNASSIGNED,
  type Value,
  type VariableReference,
} from './values';

/** A `ref` or `out` argument, which reads and writes the caller's variable. */
export class Reference implements VariableReference {
  readonly set: (value: Value) => void;

  /** A variable's storage, which receives a copy of a struct written through it, as an `out` argument from a library method. */
  constructor(
    readonly get: () => Value,
    set: (value: Value) => void
  ) {
    this.set = (value) => set(copyValue(value));
  }
}

/** Storage that an assignment reads and writes after evaluating its receiver and indices once. */
export interface Place {
  get(): Value;
  set(value: Value): void;
}

export const NULL_REFERENCE = (): PendingException =>
  new PendingException('System.NullReferenceException', 'Object reference not set to an instance of an object.');

const SPECIAL_DEFAULTS: Partial<Record<SpecialType, Value>> = {
  bool: false,
  long: 0n,
  ulong: 0n,
  decimal: CsDecimal.ZERO,
  char: 0,
  sbyte: 0,
  byte: 0,
  short: 0,
  ushort: 0,
  int: 0,
  uint: 0,
  float: 0,
  double: 0,
};

/** The evaluator's operations on values and storage that need no evaluation of the bound tree. */
export abstract class EvaluatorBase {
  /** Whether statements record steps, which only traces need. */
  tracing = false;

  protected readonly conversions: Conversions;

  constructor(
    readonly runtime: Runtime,
    readonly program: CompiledProgram
  ) {
    this.conversions = new BinderBase(program.library).conversions;
  }

  // ---- Locals ----

  readLocal(frame: Frame, local: LocalSymbol): Value {
    const slot: Slot =
      local.owner === frame.method || !local.owner ? frame.slots[local.slot] : frame.captured.get(local);
    if (slot === UNASSIGNED) return undefined;
    if (slot instanceof Cell) return slot.value === UNASSIGNED ? undefined : (slot.value as Value);
    if (slot instanceof Reference) return slot.get();
    return slot as Value;
  }

  /** Stores a local's value; a fresh variable of a loop or a catch clause gets a fresh cell when lambdas capture it. */
  storeLocal(frame: Frame, local: LocalSymbol, value: Value, isFresh = false): void {
    if (local.owner !== frame.method && local.owner) {
      const cell = frame.captured.get(local);
      if (cell) cell.value = value;
      return;
    }
    const slot = frame.slots[local.slot];
    if (local.isCaptured && (isFresh || !(slot instanceof Cell))) {
      frame.slots[local.slot] = new Cell(value);
      return;
    }
    if (slot instanceof Cell) slot.value = value;
    else if (slot instanceof Reference) slot.set(value);
    else frame.slots[local.slot] = value;
  }

  protected withOperand<T>(frame: Frame, value: Value, run: () => T): T {
    frame.operands.push(value);
    try {
      return run();
    } finally {
      frame.operands.pop();
    }
  }

  // ---- Members ----

  /** The fields of an object or struct, failing on null as reading a member of null does. */
  protected fieldsOf(receiver: Value): Value[] {
    if (receiver instanceof CsObject || receiver instanceof CsStruct) return receiver.fields;
    if (receiver instanceof CsBox && receiver.value instanceof CsStruct) return receiver.value.fields;
    throw NULL_REFERENCE();
  }

  /** The type environment of an instance method called on a receiver of a runtime type. */
  protected environmentFor(method: MethodSymbol, receiverType: Type | undefined): Map<TypeParameterSymbol, Type> {
    if (!receiverType || receiverType.kind !== 'named') return new Map();
    for (let current: NamedType | undefined = receiverType; current; current = baseTypeOf(current)) {
      if (current.symbol === method.owner) return substitutionOf(current);
    }
    return substitutionOf(receiverType);
  }

  /**
   * A value that a library implementation returns unboxed, such as a `List<int>` enumerator's `Current`, boxed in its
   * type when the member called, such as the non-generic `IEnumerator.Current`, returns `object`.
   */
  protected boxedAsCalled(
    called: MethodSymbol,
    implementation: MethodSymbol,
    receiverType: Type | undefined,
    value: Value
  ): Value {
    if (called === implementation || !implementation.native || specialOf(called.returnType) !== 'object') return value;
    if (
      typeof value !== 'number' &&
      typeof value !== 'bigint' &&
      typeof value !== 'boolean' &&
      !(value instanceof CsDecimal) &&
      !(value instanceof CsStruct)
    )
      return value;
    const type = substitute(implementation.returnType, this.environmentFor(implementation, receiverType));
    return type.kind === 'named' && type.symbol.isValueType && !nullableUnderlying(type)
      ? new CsBox(type, copyValue(value))
      : value;
  }

  protected getterOf(property: PropertySymbol): MethodSymbol | undefined {
    for (let current: PropertySymbol | undefined = property; current; current = current.overridden)
      if (current.getter) return current.getter;
    return undefined;
  }

  protected setterOf(property: PropertySymbol): MethodSymbol | undefined {
    for (let current: PropertySymbol | undefined = property; current; current = current.overridden)
      if (current.setter) return current.setter;
    return undefined;
  }

  // ---- Conversions ----

  convertValue(value: Value, conversion: ConversionKind, from: Type, to: Type): Value {
    switch (conversion) {
      case 'identity':
      case 'reference':
      case 'nullableWrap':
      case 'nullLiteral': {
        return value;
      }
      case 'numeric':
      case 'enumNumeric': {
        if (value === undefined) throw NULL_REFERENCE();
        return convertNumeric(value as NumericValue, numericKindOf(from), numericKindOf(to));
      }
      case 'referenceCheck': {
        if (value === undefined || this.isInstanceOf(value, to)) return value;
        throw this.invalidCast(value, to);
      }
      case 'boxing':
      case 'typeParameterBox': {
        return this.box(value, from);
      }
      case 'unboxing':
      case 'typeParameterUnbox': {
        return this.unbox(value, to);
      }
      case 'nullableUnwrap': {
        return this.unwrapNullable(value, from, to);
      }
      case 'nullableLifted': {
        return this.convertLifted(value, from, to);
      }
      case 'tuple': {
        return this.convertTuple(value as CsStruct, from as NamedType, to as NamedType);
      }
      case 'userDefined': {
        throw new Error('User-defined conversions are not supported');
      }
    }
  }

  box(value: Value, from: Type): Value {
    if (value === undefined) return undefined;
    if (!this.isValueTypeValue(value)) return value;
    const underlying = nullableUnderlying(from);
    const boxedType = underlying ?? from;
    return new CsBox(boxedType, copyValue(value));
  }

  private unwrapNullable(value: Value, from: Type, to: Type): Value {
    if (value === undefined)
      throw new PendingException('System.InvalidOperationException', 'Nullable object must have a value.');
    const underlying = nullableUnderlying(from) as Type;
    return sameType(underlying, to)
      ? value
      : convertNumeric(value as NumericValue, numericKindOf(underlying), numericKindOf(to));
  }

  private convertLifted(value: Value, from: Type, to: Type): Value {
    if (value === undefined) return undefined;
    const fromType = nullableUnderlying(from) ?? from;
    const toType = nullableUnderlying(to) ?? to;
    if (sameType(fromType, toType)) return value;
    if (value instanceof CsBox) return this.unbox(value, to);
    return convertNumeric(value as NumericValue, numericKindOf(fromType), numericKindOf(toType));
  }

  private convertTuple(tuple: CsStruct, from: NamedType, to: NamedType): Value {
    return new CsStruct(
      to,
      tuple.fields.map((field, index) => this.convertRuntime(field, from.args[index], to.args[index]))
    );
  }

  /** Converts a value between types without a bound conversion, as tuple element conversions need. */
  private convertRuntime(value: Value, from: Type, to: Type): Value {
    if (sameType(from, to)) return value;
    const fromSpecial = specialOf(from);
    const toSpecial = specialOf(to);
    if (
      fromSpecial &&
      toSpecial &&
      !isString(value) &&
      value !== undefined &&
      !(value instanceof CsStruct) &&
      !(value instanceof CsObject) &&
      !(value instanceof CsBox) &&
      typeof value !== 'boolean' &&
      toSpecial !== 'object' &&
      toSpecial !== 'string'
    ) {
      return convertNumeric(value as NumericValue, fromSpecial, toSpecial);
    }
    if (nullableUnderlying(to)) return value;
    if (isReferenceType(to) && this.isValueTypeValue(value)) return new CsBox(from, copyValue(value));
    return value;
  }

  protected isValueTypeValue(value: Value): boolean {
    if (
      value instanceof CsObject ||
      value instanceof CsArray ||
      value instanceof CsDelegate ||
      value instanceof CsBox ||
      isString(value)
    )
      return false;
    return true;
  }

  unbox(value: Value, to: Type): Value {
    const underlying = nullableUnderlying(to);
    if (value === undefined) {
      if (underlying || isReferenceType(to)) return undefined;
      throw NULL_REFERENCE();
    }
    if (!(value instanceof CsBox)) {
      if (this.isInstanceOf(value, to)) return value;
      throw this.invalidCast(value, to);
    }
    const target = underlying ?? to;
    if (this.boxMatches(value.type, target)) return copyValue(value.value);
    if (isReferenceType(target) && this.isInstanceOf(value, target)) return value;
    throw this.invalidCast(value, to);
  }

  /** Whether a box of one type unboxes to another, which an enum allows to its underlying type and back. */
  protected boxMatches(boxed: Type, target: Type): boolean {
    if (sameType(boxed, target)) return true;
    return sameType(enumUnderlyingOf(boxed), enumUnderlyingOf(target));
  }

  private invalidCast(value: Value, to: Type): PendingException {
    const from = this.runtime.runtimeTypeOf(value);
    return new PendingException(
      'System.InvalidCastException',
      `Unable to cast object of type '${from ? runtimeTypeName(from) : 'System.Object'}' to type '${runtimeTypeName(to)}'.`
    );
  }

  /** Whether a value is of a type at run time, as `is` and casts test. */
  isInstanceOf(value: Value, type: Type): boolean {
    if (value === undefined) return false;
    if (type.kind === 'named' && type.symbol.special === 'object') return true;
    if (value instanceof CsBox) {
      if (sameType(value.type, type)) return true;
      if (nullableUnderlying(type) && sameType(nullableUnderlying(type) as Type, value.type)) return true;
      return this.isAssignable(value.type, type);
    }
    // A primitive carries no type of its own, so it is an instance of no type tested here.
    const actual = this.runtime.runtimeTypeOf(value);
    return actual !== undefined && this.isAssignable(actual, type);
  }

  /** Whether a runtime type converts to another by reference or boxing, as instance tests decide. */
  isAssignable(actual: Type, type: Type): boolean {
    if (sameType(actual, type)) return true;
    const conversion = this.conversions.implicit(actual, type);
    return conversion === 'reference' || conversion === 'boxing' || conversion === 'identity';
  }

  /** The default value of a type: null, zero, false, or an empty struct. */
  defaultOf(type: Type): Value {
    if (type.kind !== 'named') return undefined;
    const special = type.symbol.special;
    if (special === 'nullable') return undefined;
    const specialDefault = special === undefined ? undefined : SPECIAL_DEFAULTS[special];
    if (specialDefault !== undefined) return specialDefault;
    if (type.symbol.kind === 'enum') {
      const underlying = specialOf(type.symbol.enumUnderlying as Type);
      return underlying === 'long' || underlying === 'ulong' ? 0n : 0;
    }
    if (type.symbol.kind !== 'struct') return undefined;
    const fields: Value[] = Array.from<Value>({ length: type.symbol.instanceFieldCount });
    const substitution = substitutionOf(type);
    for (const field of type.symbol.fields) {
      if (!field.isStatic && !field.isConst) fields[field.slot] = this.defaultOf(substitute(field.type, substitution));
    }
    return new CsStruct(type, fields);
  }

  /** The slots that defaultOf allocates for a value of the type beyond the one holding it: a struct's fields, nested. */
  defaultSlotCount(type: Type): number {
    if (type.kind !== 'named' || type.symbol.kind !== 'struct') return 0;
    const special = type.symbol.special;
    if (special === 'nullable' || (special !== undefined && SPECIAL_DEFAULTS[special] !== undefined)) return 0;
    const substitution = substitutionOf(type);
    let count = type.symbol.instanceFieldCount;
    for (const field of type.symbol.fields) {
      if (!field.isStatic && !field.isConst) count += this.defaultSlotCount(substitute(field.type, substitution));
    }
    return count;
  }
}

function numericKindOf(type: Type): SpecialType {
  if (type.kind === 'named' && type.symbol.kind === 'enum')
    return specialOf(type.symbol.enumUnderlying as Type) as SpecialType;
  return (specialOf(nullableUnderlying(type) ?? type) ?? 'int') as SpecialType;
}

/** The underlying type of an enum, which its box unboxes to as well, or any other type itself. */
function enumUnderlyingOf(type: Type): Type {
  return type.kind === 'named' && type.symbol.kind === 'enum' ? (type.symbol.enumUnderlying as Type) : type;
}
