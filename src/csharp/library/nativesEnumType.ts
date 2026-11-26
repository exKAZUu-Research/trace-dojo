import { defineNatives, type NativeCall, type NativeMethod } from '../natives';
import { PendingException } from '../numeric';
import { runtimeTypeName, unboxed } from '../objects';
import type { FieldSymbol, NamedType, Type } from '../types';
import { CsBox, isString, plainString, type Value } from '../values';
import { enumMembers, parseEnum, typeObject, typeOf } from './nativesCore';
import { evaluatorOf, fail, failNull, libraryType, newArray, refOf } from './support';

/**
 * The `Enum` methods that take the enum as a `Type`, which work as their generic forms do on the enum it stands for
 * and return its values boxed.
 */

/** The integral types whose values `GetName` and `ToObject` read as an enum's number. */
const INTEGRAL_NAMES = new Set(['sbyte', 'byte', 'short', 'ushort', 'int', 'uint', 'long', 'ulong', 'char', 'bool']);

function enumTypeOf(value: Value): NamedType {
  if (value === undefined) failNull('enumType');
  const type = typeOf(value);
  if (typeof type === 'string' || type.kind !== 'named' || type.symbol.kind !== 'enum')
    fail('System.ArgumentException', 'Type provided must be an Enum.', 'enumType');
  return type;
}

function underlyingOf(type: NamedType): NamedType {
  return type.symbol.enumUnderlying as NamedType;
}

/** The type of a boxed value an `object` parameter received, undefined for a string. */
function boxedType(value: Value): Type | undefined {
  return value instanceof CsBox ? value.type : undefined;
}

/** The number of an enum or integral value, which `GetName` and `ToObject` take from any of them. */
function enumNumber(value: Value): bigint {
  const type = boxedType(value);
  const isNumber =
    type?.kind === 'named' && (type.symbol.kind === 'enum' || INTEGRAL_NAMES.has(type.symbol.special ?? ''));
  if (!isNumber)
    fail(
      'System.ArgumentException',
      'The value passed in must be an enum base or an underlying type for an enum, such as an Int32.',
      'value'
    );
  const number = unboxed(value) as number | bigint | boolean | string;
  if (typeof number === 'boolean') return number ? 1n : 0n;
  // A char is one UTF-16 code unit.
  // oxlint-disable-next-line unicorn/prefer-code-point
  if (typeof number === 'string') return BigInt(number.charCodeAt(0));
  return BigInt(number);
}

/** A number as a value of an enum, wrapped to its underlying type's width as .NET's conversion does. */
function enumValue(type: NamedType, number: bigint): Value {
  const special = underlyingOf(type).symbol.special ?? 'int';
  const widths: Record<string, number> = {
    sbyte: 8,
    byte: 8,
    short: 16,
    ushort: 16,
    int: 32,
    uint: 32,
    long: 64,
    ulong: 64,
  };
  const width = widths[special] ?? 32;
  const wrapped =
    special.startsWith('u') || special === 'byte' ? BigInt.asUintN(width, number) : BigInt.asIntN(width, number);
  return width === 64 ? wrapped : Number(wrapped);
}

function memberOf(type: NamedType, number: bigint): FieldSymbol | undefined {
  return enumMembers(type).find((field) => BigInt(field.constantValue as number | bigint) === number);
}

/** `IsDefined(Type, object)`, which takes a name, a value of the enum, or a number of its underlying type. */
function isDefined(type: NamedType, value: Value): boolean {
  if (value === undefined) failNull('value');
  if (isString(value)) return enumMembers(type).some((field) => field.name === plainString(value));
  const valueType = boxedType(value) as NamedType;
  if (valueType.symbol.kind === 'enum') {
    if (valueType.symbol !== type.symbol)
      fail(
        'System.ArgumentException',
        `Object must be the same type as the enum. The type passed in was '${runtimeTypeName(valueType)}'; the enum type was '${runtimeTypeName(type)}'.`
      );
  } else if (INTEGRAL_NAMES.has(valueType.symbol.special ?? '') && valueType.symbol.special !== 'bool') {
    const underlying = underlyingOf(type);
    if (valueType.symbol !== underlying.symbol)
      fail(
        'System.ArgumentException',
        `Enum underlying type and the object must be same type or object must be a String. Type passed in was '${runtimeTypeName(valueType)}'; the enum underlying type was '${runtimeTypeName(underlying)}'.`
      );
  } else {
    throw new PendingException('System.InvalidOperationException', 'Unknown enum type.');
  }
  return memberOf(type, BigInt(unboxed(value) as number | bigint)) !== undefined;
}

const toObject: NativeMethod = (call, _receiver, [enumType, value]) => {
  const type = enumTypeOf(enumType as Value);
  if (value === undefined) failNull('value');
  const number = typeof value === 'number' || typeof value === 'bigint' ? BigInt(value) : enumNumber(value as Value);
  return evaluatorOf(call).box(enumValue(type, number), type);
};

function tryParse(call: NativeCall, args: Value[]): boolean {
  const type = enumTypeOf(args[0]);
  const ignoreCase = args.length > 3 && (args[2] as boolean);
  const parsed = parseEnum(call, args[1] as string | undefined, ignoreCase, false, type);
  refOf(args.at(-1) as Value).set(parsed === undefined ? undefined : evaluatorOf(call).box(parsed, type));
  return parsed !== undefined;
}

defineNatives({
  'System.Enum.GetName(Type, object)': (call, _receiver, [enumType, value]) => {
    const type = enumTypeOf(enumType as Value);
    if (value === undefined) failNull('value');
    const member = memberOf(type, enumNumber(value as Value));
    return member ? call.frame.runtime.enumString(type, member.name) : undefined;
  },
  'System.Enum.GetNames(Type)': (call, _receiver, [enumType]) => {
    const type = enumTypeOf(enumType as Value);
    return newArray(
      call,
      libraryType(call, 'System.String'),
      enumMembers(type).map((field) => call.frame.runtime.enumString(type, field.name))
    );
  },
  'System.Enum.GetValues(Type)': (call, _receiver, [enumType]) => {
    const type = enumTypeOf(enumType as Value);
    return newArray(
      call,
      type,
      enumMembers(type).map((field) => field.constantValue as Value)
    );
  },
  'System.Enum.IsDefined(Type, object)': (_call, _receiver, [enumType, value]) =>
    isDefined(enumTypeOf(enumType as Value), value as Value),
  'System.Enum.Parse(Type, string)': (call, _receiver, [enumType, text]) => {
    const type = enumTypeOf(enumType as Value);
    return evaluatorOf(call).box(parseEnum(call, text as string | undefined, false, true, type), type);
  },
  'System.Enum.Parse(Type, string, bool)': (call, _receiver, [enumType, text, ignoreCase]) => {
    const type = enumTypeOf(enumType as Value);
    return evaluatorOf(call).box(parseEnum(call, text as string | undefined, ignoreCase as boolean, true, type), type);
  },
  'System.Enum.TryParse(Type, string?, object?)': (call, _receiver, args) => tryParse(call, args as Value[]),
  'System.Enum.TryParse(Type, string?, bool, object?)': (call, _receiver, args) => tryParse(call, args as Value[]),
  'System.Enum.GetUnderlyingType': (call, _receiver, [enumType]) =>
    typeObject(call, underlyingOf(enumTypeOf(enumType as Value))),
  'System.Enum.ToObject': toObject,
});
