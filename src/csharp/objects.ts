// oxlint-disable unicorn/prefer-code-point -- C# characters are UTF-16 code units, which code points would merge.
import { compareCulture } from './culture';
import { CsDecimal } from './decimal';
import type { Evaluator } from './evaluator';
import { formatFloat } from './format';
import { linqDisplayName } from './library/nativesLinq';
import type { NativeCall } from './natives';
import { PendingException } from './numeric';
import type { ExceptionState, Frame, Runtime } from './runtime';
import {
  type FieldSymbol,
  type MethodSymbol,
  type NamedType,
  namedType,
  nullableUnderlying,
  type PropertySymbol,
  sameType,
  specialOf,
  substitute,
  substitutionOf,
  type Type,
  type TypeParameterSymbol,
  type TypeSymbol,
} from './types';
import {
  CsArray,
  CsBox,
  CsDelegate,
  CsObject,
  type CsString,
  CsStruct,
  freshString,
  isString,
  plainString,
  stringText,
  type Value,
  type VariableReference,
} from './values';

/** The name that .NET's `Type.ToString()` gives a type, such as `System.Collections.Generic.List\`1[System.Int32]`. */
export function runtimeTypeName(type: Type): string {
  switch (type.kind) {
    case 'named': {
      // A tuple of more than 7 elements is .NET's `ValueTuple<T1, …, T7, TRest>` with the rest nested.
      if (type.symbol.special === 'valueTuple' && type.args.length > 7) return tupleTypeName(type.args);
      const base = type.symbol.fullName;
      if (type.args.length === 0) return base;
      return `${base}[${type.args.map(runtimeTypeName).join(',')}]`;
    }
    case 'array': {
      return `${runtimeTypeName(type.element)}[${','.repeat(type.rank - 1)}]`;
    }
    case 'typeParameter': {
      return type.symbol.name;
    }
    default: {
      return 'System.Object';
    }
  }
}

function tupleTypeName(args: Type[]): string {
  if (args.length <= 7) return `System.ValueTuple\`${args.length}[${args.map(runtimeTypeName).join(',')}]`;
  return `System.ValueTuple\`8[${[...args.slice(0, 7).map(runtimeTypeName), tupleTypeName(args.slice(7))].join(',')}]`;
}

/** The simple name that `Type.Name` gives, such as `List\`1` or `Int32[]`. */
export function runtimeSimpleName(type: Type): string {
  if (type.kind === 'array') return `${runtimeSimpleName(type.element)}[${','.repeat(type.rank - 1)}]`;
  if (type.kind === 'named') return type.symbol.runtimeNameOverride ?? type.symbol.metadataName;
  return runtimeTypeName(type);
}

/** The value of a primitive or a box, unwrapped, with a string as its text. */
export function unboxed(value: Value): Value {
  return value instanceof CsBox ? value.value : plainString(value);
}

/** The member name of an enum value, or its number when no member has it. */
export function enumText(type: NamedType, value: Value): string {
  const member = type.symbol.fields.find((field) => field.isConst && sameNumber(field.constantValue, value));
  return member ? member.name : String(value);
}

function sameNumber(a: unknown, b: unknown): boolean {
  if (typeof a === 'bigint' || typeof b === 'bigint') return BigInt(a as number) === BigInt(b as number);
  return a === b;
}

/** The text of a value of a known type as `ToString()` gives it, calling the program's overrides. */
export function stringOf(evaluator: Evaluator, value: Value, type: Type, frame: Frame): string {
  if (value === undefined) return '';
  const underlying = nullableUnderlying(type) ?? type;
  const primitive = primitiveText(value, underlying);
  if (primitive !== undefined) return primitive;
  return stringText(invokeToString(evaluator, value, frame) ?? '');
}

/**
 * The string `ToString()` returns for a value of a known type, as the object .NET returns: a string itself, the
 * interned `True` and `False`, the cached text of a small number or an enum member, or a new string.
 */
export function toStringValue(evaluator: Evaluator, value: Value, type: Type, frame: Frame): string | CsString {
  if (value === undefined) return '';
  if (isString(value)) return value;
  const underlying = value instanceof CsBox ? value.type : (nullableUnderlying(type) ?? type);
  const inner = unboxed(value);
  const primitive = primitiveText(inner, underlying);
  if (primitive === undefined) return invokeToString(evaluator, value, frame) ?? '';
  if (typeof inner === 'boolean') return primitive;
  const runtime = evaluator.runtime;
  if (underlying.kind === 'named' && underlying.symbol.kind === 'enum')
    return runtime.enumString(underlying, primitive);
  if (typeof inner === 'bigint' || (typeof inner === 'number' && isIntegral(underlying)))
    return runtime.numberString(primitive);
  return freshString(primitive);
}

function isIntegral(type: Type): boolean {
  return ['sbyte', 'byte', 'short', 'ushort', 'int', 'uint', 'long', 'ulong'].includes(specialOf(type) ?? '');
}

/** The text of a value whose static type says how its representation reads, for primitives. */
export function primitiveText(value: Value, type: Type): string | undefined {
  if (value instanceof CsBox) return primitiveText(value.value, value.type);
  if (type.kind !== 'named') return undefined;
  if (type.symbol.kind === 'enum') return enumText(type, value);
  switch (type.symbol.special) {
    case 'bool': {
      return value ? 'True' : 'False';
    }
    case 'char': {
      return String.fromCharCode(value as number);
    }
    case 'sbyte':
    case 'byte':
    case 'short':
    case 'ushort':
    case 'int':
    case 'uint':
    case 'long':
    case 'ulong': {
      return String(value);
    }
    case 'float':
    case 'double': {
      return formatFloat(value as number, type.symbol.special === 'float');
    }
    case 'decimal': {
      return (value as CsDecimal).toString();
    }
    case 'string': {
      return stringText(value as string | CsString);
    }
    default: {
      return undefined;
    }
  }
}

/** Calls `ToString()` on an object, struct, box, array, or delegate, dispatching to the program's override. */
export function invokeToString(evaluator: Evaluator, value: Value, frame: Frame): string | CsString | undefined {
  if (value === undefined) return undefined;
  if (isString(value)) return value;
  const objectToString = objectMethod(evaluator, 'ToString', 0);
  const implementation = evaluator.runtime.dispatch(objectToString, value);
  const result = evaluator.invoke(
    frame,
    implementation,
    value,
    [],
    undefined,
    environmentOf(evaluator, implementation, value)
  );
  return (result as string | CsString | undefined) ?? '';
}

/** The `System.Object` method of a name and parameter count. */
export function objectMethod(evaluator: Evaluator, name: string, parameterCount: number): MethodSymbol {
  const symbol = evaluator.runtime.library.specials.get('object') as TypeSymbol;
  const method = symbol.methods.find(
    (candidate) => candidate.name === name && candidate.parameters.length === parameterCount && !candidate.isStatic
  );
  if (!method) throw new Error(`System.Object.${name} is missing`);
  return method;
}

/** The type arguments that a method sees when it runs on a receiver of its runtime type. */
export function environmentOf(
  evaluator: Evaluator,
  method: MethodSymbol,
  receiver: Value
): Map<TypeParameterSymbol, Type> {
  const type = evaluator.runtime.runtimeTypeOf(receiver);
  if (!type || type.kind !== 'named') return new Map();
  for (
    let current: NamedType | undefined = type;
    current;
    current = current.symbol.baseType
      ? (substitute(current.symbol.baseType, substitutionOf(current)) as NamedType)
      : undefined
  ) {
    if (current.symbol === method.owner) return substitutionOf(current);
  }
  return new Map();
}

/** What `Object.ToString()` gives a value that no type overrides it for: its type's full name. */
export function defaultToString(evaluator: Evaluator, value: Value): string {
  const linqName = value instanceof CsObject ? linqDisplayName(value.native) : undefined;
  if (linqName) return linqName;
  if (value instanceof CsObject && value.native && isExceptionState(value.native))
    return exceptionText(evaluator, value);
  const type = evaluator.runtime.runtimeTypeOf(value);
  if (value instanceof CsBox) return primitiveText(value.value, value.type) ?? runtimeTypeName(value.type);
  return type ? runtimeTypeName(type) : 'System.Object';
}

export function isExceptionState(native: unknown): native is ExceptionState {
  return native instanceof Object && 'wasThrown' in native;
}

/** The message of an exception, as its `Message` property gives it by default. */
export function exceptionMessage(exception: CsObject): string {
  const state = exception.native as ExceptionState;
  let message = state.message ?? defaultMessage(exception.type);
  if (state.paramName !== undefined && isArgumentException(exception.type))
    message += ` (Parameter '${state.paramName}')`;
  if (state.actualValue !== undefined) message += `\nActual value was ${String(state.actualValue)}.`;
  return message;
}

function isArgumentException(type: NamedType): boolean {
  for (let current: NamedType | undefined = type; current; current = current.symbol.baseType) {
    if (current.symbol.fullName === 'System.ArgumentException') return true;
  }
  return false;
}

/** The message an exception created without one has, which .NET's resources give each type. */
export function defaultMessage(type: NamedType): string {
  const name = type.symbol.fullName;
  const messages: Record<string, string> = {
    'System.ArgumentException': 'Value does not fall within the expected range.',
    'System.ArgumentNullException': 'Value cannot be null.',
    'System.ArgumentOutOfRangeException': 'Specified argument was out of the range of valid values.',
    'System.InvalidOperationException': 'Operation is not valid due to the current state of the object.',
    'System.NotImplementedException': 'The method or operation is not implemented.',
    'System.NotSupportedException': 'Specified method is not supported.',
    'System.NullReferenceException': 'Object reference not set to an instance of an object.',
    'System.IndexOutOfRangeException': 'Index was outside the bounds of the array.',
    'System.DivideByZeroException': 'Attempted to divide by zero.',
    'System.OverflowException': 'Arithmetic operation resulted in an overflow.',
    'System.ArithmeticException': 'Overflow or underflow in the arithmetic operation.',
    'System.FormatException': 'One of the identified items was in an invalid format.',
    'System.InvalidCastException': 'Specified cast is not valid.',
    'System.Collections.Generic.KeyNotFoundException': 'The given key was not present in the dictionary.',
    'System.ApplicationException': 'Error in the application.',
    'System.SystemException': 'System error.',
    'System.TimeoutException': 'The operation has timed out.',
  };
  return messages[name] ?? `Exception of type '${name}' was thrown.`;
}

/** What `Exception.ToString()` gives: the type, the message, and the inner exceptions. */
export function exceptionText(evaluator: Evaluator, exception: CsObject): string {
  const state = exception.native as ExceptionState;
  const message = evaluator.exceptionMessageOf(exception);
  let text = `${runtimeTypeName(exception.type)}${message ? `: ${message}` : ''}`;
  if (state.inner)
    text += `\n ---> ${exceptionText(evaluator, state.inner)}\n   --- End of inner exception stack trace ---`;
  return text;
}

// ---- Equality and hashing ----

/** Whether two values are equal as `object.Equals` decides, calling the program's overrides. */
// code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
export function valuesEqual(evaluator: Evaluator, first: Value, second: Value, frame: Frame): boolean {
  const a = plainString(first);
  const b = plainString(second);
  if (a === b) return typeof a !== 'number' || !Number.isNaN(a) || true;
  if (a === undefined || b === undefined) return false;
  if (typeof a === 'number' && typeof b === 'number') return a === b || (Number.isNaN(a) && Number.isNaN(b));
  if (typeof a === 'bigint' || typeof b === 'bigint') return typeof a === typeof b && a === b;
  if (a instanceof CsDecimal && b instanceof CsDecimal) return a.equals(b);
  if (typeof a === 'string' || typeof b === 'string' || typeof a === 'boolean' || typeof b === 'boolean')
    return a === b;
  if (a instanceof CsBox && b instanceof CsBox)
    return sameType(a.type, b.type) && valuesEqual(evaluator, a.value, b.value, frame);
  if (a instanceof CsBox || b instanceof CsBox) {
    if (a instanceof CsBox && b instanceof CsStruct) return valuesEqual(evaluator, a.value, b, frame);
    if (b instanceof CsBox && a instanceof CsStruct) return valuesEqual(evaluator, a, b.value, frame);
    return false;
  }
  const equals = objectMethod(evaluator, 'Equals', 1);
  const implementation = evaluator.runtime.dispatch(equals, a);
  return evaluator.invoke(
    frame,
    implementation,
    a,
    [b],
    undefined,
    environmentOf(evaluator, implementation, a)
  ) as boolean;
}

/** `ValueType.Equals`: the same type and equal fields. */
export function structEquals(evaluator: Evaluator, a: CsStruct, b: Value, frame: Frame): boolean {
  const other = b instanceof CsBox ? b.value : b;
  if (!(other instanceof CsStruct) || !sameType(a.type, other.type)) return false;
  return (
    a.fields.every((field, index) => valuesEqual(evaluator, field, other.fields[index], frame)) &&
    a.native === other.native
  );
}

/** The hash code that `GetHashCode()` gives, calling the program's overrides. */
export function hashOf(evaluator: Evaluator, value: Value, frame: Frame): number {
  if (value === undefined) return 0;
  // A string's hash reads every character, so hashing many references to one long string costs its length each time.
  const text = unboxed(value);
  if (typeof text === 'string') evaluator.runtime.spend(Math.ceil(text.length / 16));
  const primitive = primitiveHash(value);
  if (primitive !== undefined) return primitive;
  const getHashCode = objectMethod(evaluator, 'GetHashCode', 0);
  const implementation = evaluator.runtime.dispatch(getHashCode, value);
  return evaluator.invoke(
    frame,
    implementation,
    value,
    [],
    undefined,
    environmentOf(evaluator, implementation, value)
  ) as number;
}

/** The hash codes of .NET's primitives, which are deterministic except for strings (randomized per process in .NET). */
export function primitiveHash(boxed: Value): number | undefined {
  const value = unboxed(boxed);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= -2_147_483_648 && value <= 4_294_967_295) return toInt32(value);
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value === 0 ? 0 : value);
    return toInt32(view.getInt32(0) ^ view.getInt32(4));
  }
  if (typeof value === 'bigint') return Number(BigInt.asIntN(32, value ^ (value >> 32n)));
  if (typeof value === 'string') {
    let hash = 5381;
    for (let index = 0; index < value.length; index++) hash = toInt32((hash << 5) + hash + value.charCodeAt(index));
    return hash;
  }
  if (value instanceof CsDecimal) return primitiveHash(value.toDouble());
  return undefined;
}

/** `RuntimeHelpers.GetHashCode`: an identity hash for objects that do not override `GetHashCode`. */
export function identityHash(runtime: Runtime, value: Value): number {
  if (value instanceof CsObject || value instanceof CsArray || value instanceof CsDelegate || value instanceof CsBox) {
    value.hashCode ??= runtime.nextHashCode();
    return value.hashCode;
  }
  return 0;
}

/** `ValueType.GetHashCode`: a combination of the fields' hash codes. */
export function structHash(evaluator: Evaluator, value: CsStruct, frame: Frame): number {
  let hash = 17;
  for (const field of value.fields) hash = toInt32(Math.imul(hash, 31) + hashOf(evaluator, field, frame));
  return hash;
}

// ---- Ordering ----

export function compareOrdinal(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

/** `Comparer<T>.Default.Compare`, which compares primitives by value and others through `IComparable`. */
export function defaultCompare(evaluator: Evaluator, a: Value, b: Value, frame: Frame): number {
  if (a === undefined) return b === undefined ? 0 : -1;
  if (b === undefined) return 1;
  const spend = (cost: number): void => evaluator.runtime.spend(cost);
  return comparePrimitives(unboxed(a), unboxed(b), spend) ?? evaluator.compareThroughInterface(a, b, frame);
}

/** The order of two primitive values of the same kind, or undefined for other values. */
function comparePrimitives(x: Value, y: Value, spend: (cost: number) => void): number | undefined {
  if (typeof x === 'string' && typeof y === 'string') return compareCulture(x, y, { spend });
  if (typeof x === 'number' && typeof y === 'number') return compareNumbers(x, y);
  if (typeof x === 'bigint' && typeof y === 'bigint') return orderOf(x, y);
  if (x instanceof CsDecimal && y instanceof CsDecimal) return x.compare(y);
  if (typeof x === 'boolean' && typeof y === 'boolean') return orderOf(Number(x), Number(y));
  return undefined;
}

/** The order of two numbers, where NaN comes before every other number, as `double.CompareTo` does. */
function compareNumbers(x: number, y: number): number {
  if (Number.isNaN(x)) return Number.isNaN(y) ? 0 : -1;
  if (Number.isNaN(y)) return 1;
  return orderOf(x, y);
}

function orderOf<T extends number | bigint>(x: T, y: T): number {
  if (x < y) return -1;
  return x > y ? 1 : 0;
}

export function fieldOf(type: NamedType, name: string): FieldSymbol | undefined {
  return type.symbol.fields.find((field) => field.name === name);
}

/** A tuple's text: `(1, a)`. */
export function tupleText(evaluator: Evaluator, tuple: CsStruct, frame: Frame): string {
  return `(${tuple.fields.map((field, index) => stringOf(evaluator, field, tuple.type.args[index], frame)).join(', ')})`;
}

export function noValue(): PendingException {
  return new PendingException('System.InvalidOperationException', 'Nullable object must have a value.');
}

/** The members that a record's `ToString` prints: its public instance fields and properties, base record first. */
interface PrintedMember {
  name: string;
  read: (value: CsObject | CsStruct) => Value;
  type: Type;
  /** The getter of a property without a backing field, which printing calls. */
  getter?: MethodSymbol;
}

function printedMembers(type: NamedType): PrintedMember[] {
  const chain: NamedType[] = [];
  for (
    let current: NamedType | undefined = type;
    current && current.symbol.special !== 'object' && current.symbol.special !== 'valueType';
    current = current.symbol.baseType
      ? (substitute(current.symbol.baseType, substitutionOf(current)) as NamedType)
      : undefined
  )
    chain.unshift(current);
  return chain.flatMap(ownPrintedMembers);
}

/** A type's own printed members in the order of their declarations. */
function ownPrintedMembers(owner: NamedType): PrintedMember[] {
  const members: (PrintedMember & { row: number; column: number })[] = [];
  const substitution = substitutionOf(owner);
  for (const field of owner.symbol.fields) {
    if (field.isStatic || field.isConst || field.access !== 'public' || field.property || field.isPrimaryParameter)
      continue;
    members.push({
      name: field.name,
      read: (value) => value.fields[field.slot],
      type: substitute(field.type, substitution),
      row: field.row,
      column: field.column,
    });
  }
  for (const property of owner.symbol.properties) {
    if (
      property.isStatic ||
      property.isIndexer ||
      property.access !== 'public' ||
      !property.getter ||
      property.isOverride
    )
      continue;
    const backing = property.backingField;
    if (backing)
      members.push({
        name: property.name,
        read: (value) => value.fields[backing.slot],
        type: substitute(property.type, substitution),
        row: property.row,
        column: property.column,
      });
    else
      members.push({
        name: property.name,
        read: () => {},
        type: substitute(property.type, substitution),
        getter: property.getter,
        row: property.row,
        column: property.column,
      });
  }
  return members.toSorted((a, b) => a.row - b.row || a.column - b.column);
}

/** Runs a member that the compiler synthesizes for records and anonymous types. */
export function recordMember(
  evaluator: Evaluator,
  call: NativeCall,
  name: string,
  receiver: Value,
  args: Value[]
): Value {
  const frame = call.frame;
  switch (name) {
    case 'ToString': {
      // .NET builds the text in a StringBuilder, whose ToString() makes a new string each time.
      return freshString(recordText(evaluator, frame, receiver as CsObject | CsStruct));
    }
    case 'Equals': {
      return recordEquals(evaluator, frame, receiver as CsObject | CsStruct, unboxed(args[0]));
    }
    case 'GetHashCode': {
      const value = receiver as CsObject | CsStruct;
      let hash = 17;
      for (const field of value.fields) hash = toInt32(Math.imul(hash, 31) + hashOf(evaluator, field, frame));
      return hash;
    }
    case 'op_Equality':
    case 'op_Inequality': {
      const [left, right] = args;
      const equal =
        left === undefined || right === undefined
          ? left === right
          : (recordMember(evaluator, call, 'Equals', left, [right]) as boolean);
      return name === 'op_Equality' ? equal : !equal;
    }
    case 'Deconstruct': {
      deconstructRecord(call.method.owner, receiver as CsObject | CsStruct, args);
      return undefined;
    }
    default: {
      throw new Error(`Unknown record member ${name}`);
    }
  }
}

function recordText(evaluator: Evaluator, frame: Frame, value: CsObject | CsStruct): string {
  const members = printedMembers(value.type).map((member) => {
    const getter = member.getter;
    const memberValue = getter
      ? evaluator.invoke(
          frame,
          evaluator.runtime.dispatch(getter, value),
          value,
          [],
          undefined,
          environmentOf(evaluator, getter, value)
        )
      : member.read(value);
    return `${member.name} = ${memberValue === undefined ? '' : stringOf(evaluator, memberValue, member.type, frame)}`;
  });
  const isAnonymous = value.type.symbol.anonymousDisplay !== undefined;
  const body = members.length > 0 ? ` ${members.join(', ')} ` : ' ';
  return isAnonymous ? `{${body}}` : `${value.type.symbol.name}${body === ' ' ? ' { }' : ` {${body}}`}`;
}

function recordEquals(evaluator: Evaluator, frame: Frame, value: CsObject | CsStruct, other: Value): boolean {
  if (other === undefined || !(other instanceof CsObject || other instanceof CsStruct)) return false;
  if (!sameType(value.type, other.type)) return false;
  return value.fields.every((field, index) => valuesEqual(evaluator, field, other.fields[index], frame));
}

/**
 * A record's `Deconstruct`, which reads the properties of the parameters of the record that declares it, whatever the
 * object's own type, from that record or a base record that declares them.
 */
function deconstructRecord(owner: TypeSymbol, value: CsObject | CsStruct, args: Value[]): void {
  for (const [index, parameter] of (owner.primaryParameters ?? []).entries()) {
    let property: PropertySymbol | undefined;
    for (let current: TypeSymbol | undefined = owner; current && !property; current = current.baseType?.symbol)
      property = current.properties.find((candidate) => candidate.name === parameter.name);
    const field = property?.backingField;
    const memberValue = field ? value.fields[field.slot] : undefined;
    (args[index] as unknown as VariableReference).set(memberValue);
  }
}

export { compareCulture, namedType, specialOf };

/** A number wrapped to a 32-bit integer, as C#'s unchecked int arithmetic gives hash codes. */
function toInt32(value: number): number {
  // oxlint-disable-next-line unicorn/prefer-math-trunc -- `| 0` wraps to 32 bits, which Math.trunc does not.
  return value | 0;
}
