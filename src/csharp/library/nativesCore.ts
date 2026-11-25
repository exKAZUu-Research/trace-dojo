// code-gauge-allow-file fileNcss -- The nativesCore module keeps one stage of the C# interpreter together.
// oxlint-disable unicorn/prefer-code-point -- C# characters are UTF-16 code units, which code points would merge.
import { TURTLE_METHOD_NAMES } from '../../interpreter/turtleWorld';
import { CsDecimal } from '../decimal';
import { combineDelegates } from '../delegates';
import { MeteredText } from '../meteredText';
import { defineNatives, defineNativesKeepingStrings, type NativeCall, type NativeMethod } from '../natives';
import {
  arithmetic,
  convertNumeric,
  integerRange,
  isBigIntKind,
  type NumericValue,
  OVERFLOW_NAMES,
  PendingException,
} from '../numeric';
import {
  compareCulture,
  defaultCompare,
  defaultMessage,
  defaultToString,
  enumText,
  exceptionMessage,
  exceptionText,
  hashOf,
  identityHash,
  primitiveHash,
  runtimeSimpleName,
  runtimeTypeName,
  structEquals,
  structHash,
  toStringValue,
  tupleText,
  unboxed,
  valuesEqual,
} from '../objects';
import { CsThrow, type ExceptionState, ProgramExit, type Runtime } from '../runtime';
import { typedReferenceTarget } from '../typedReferences';
import {
  type FieldSymbol,
  MAX_TUPLE_ARITY,
  type MethodSymbol,
  type NamedType,
  namedType,
  sameType,
  specialOf,
  type SpecialType,
  substitute,
  substitutionOf,
  type Type,
} from '../types';
import {
  copyValue,
  type CsArray,
  CsBox,
  CsDelegate,
  CsObject,
  type CsString,
  CsStruct,
  freshString,
  isString,
  stringText,
  type Value,
  type VariableReference,
} from '../values';
import { formatValue, normalizeNumberText, parseNumber, trimNumberText } from './formatting';
import { linqDisplayName } from './nativesLinq';
import {
  arrayValues,
  evaluatorOf,
  fail,
  failNegative,
  failNull,
  failOutOfRange,
  libraryType,
  NARROW_INTEGRALS,
  newArray,
  nullReference,
  parameterType,
  refOf,
  textOf,
  unsupportedCall,
} from './support';
import { turtleMethodName } from './turtleSource';

const INTEGRAL: [string, SpecialType][] = [
  ['SByte', 'sbyte'],
  ['Byte', 'byte'],
  ['Int16', 'short'],
  ['UInt16', 'ushort'],
  ['Int32', 'int'],
  ['UInt32', 'uint'],
  ['Int64', 'long'],
  ['UInt64', 'ulong'],
];

// ---- Object ----

defineNativesKeepingStrings({
  'System.Object.ToString': (call, receiver) => objectString(call, receiver),
  'System.ValueType.ToString': (call, receiver) => objectString(call, receiver),
});

/** `Object.ToString()`, which returns the type's name that .NET makes once, unless a library type says otherwise. */
function objectString(call: NativeCall, receiver: Value): string | CsString {
  const text = defaultToString(evaluatorOf(call), receiver);
  const type = call.frame.runtime.runtimeTypeOf(receiver);
  const linqName = receiver instanceof CsObject ? linqDisplayName(receiver.native) : undefined;
  const typeName = linqName ?? (type && !(receiver instanceof CsBox) ? runtimeTypeName(type) : undefined);
  return text === typeName ? typeString(call, 'ToString', text) : freshString(text);
}

/** A name of a type that `Type`'s properties return, which .NET makes once for each type and property. */
function typeString(call: NativeCall, property: string, text: string): CsString {
  return call.frame.runtime.sharedString(`Type.${property}:${text}`, text);
}

defineNatives({
  'System.Object..ctor': () => {},
  'System.Object.Equals(object?)': (call, receiver, [other]) => {
    if (receiver instanceof CsStruct) return structEquals(evaluatorOf(call), receiver, other as Value, call.frame);
    if (receiver instanceof CsBox) return valuesEqual(evaluatorOf(call), receiver, other as Value, call.frame);
    return receiver === other;
  },
  'System.Object.GetHashCode': (call, receiver) => {
    if (receiver instanceof CsStruct) return structHash(evaluatorOf(call), receiver, call.frame);
    return primitiveHash(receiver) ?? identityHash(call.frame.runtime, receiver);
  },
  'System.Object.GetType': (call, receiver) => {
    const linqName = receiver instanceof CsObject ? linqDisplayName(receiver.native) : undefined;
    return typeObject(
      call,
      linqName ?? call.frame.runtime.runtimeTypeOf(receiver) ?? libraryType(call, 'System.Object')
    );
  },
  'System.Object.ReferenceEquals': (_call, _receiver, [a, b]) => a === b,
  'System.Object.Equals(object?, object?)': (call, _receiver, [a, b]) => {
    if (a === b) return true;
    if (a === undefined || b === undefined) return false;
    return valuesEqual(evaluatorOf(call), a as Value, b as Value, call.frame);
  },
  // A struct calls it in its box, whose copy is a new box of a copy of the value.
  'System.Object.MemberwiseClone': (call, receiver) => {
    if (!(receiver instanceof CsBox)) return evaluatorOf(call).cloneObject(receiver as CsObject);
    call.frame.runtime.retainSlots(1, [receiver.value]);
    const copy = new CsBox(receiver.type, copyValue(receiver.value));
    copy.isCharged = true;
    return copy;
  },
  // A call through `object` passes the struct in its box, since ValueType is a class.
  // An enum reaches it in a box, which compares as Object.Equals does a boxed value.
  'System.ValueType.Equals': (call, receiver, [other]) => {
    const value = unboxed(receiver);
    if (value instanceof CsStruct) return structEquals(evaluatorOf(call), value, other as Value, call.frame);
    return valuesEqual(evaluatorOf(call), receiver, other as Value, call.frame);
  },
  'System.ValueType.GetHashCode': (call, receiver) => {
    const value = unboxed(receiver);
    return value instanceof CsStruct ? structHash(evaluatorOf(call), value, call.frame) : (primitiveHash(value) ?? 0);
  },
});

defineNatives({
  'System.Type.get_Name': (call, receiver) => {
    const type = typeOf(receiver);
    const name = typeof type === 'string' ? (/[.+]([^.+[]+)(?:\[|$)/.exec(type)?.[1] ?? type) : runtimeSimpleName(type);
    return typeString(call, 'Name', name);
  },
  'System.Type.get_FullName': (call, receiver) => {
    const type = typeOf(receiver);
    // .NET qualifies a generic type's arguments with their assemblies, which name the program's own file.
    if (typeof type === 'string' || (type.kind === 'named' && type.args.length > 0))
      unsupportedCall(call, '型引数のある型の FullName');
    return typeString(call, 'FullName', runtimeTypeName(type));
  },
  'System.Type.get_Namespace': (call, receiver) => {
    const type = typeOf(receiver);
    const name =
      typeof type === 'string'
        ? type.slice(0, type.lastIndexOf('.', type.search(/[+`]/)))
        : type.kind === 'named'
          ? type.symbol.namespace || undefined
          : 'System';
    return name === undefined ? undefined : typeString(call, 'Namespace', name);
  },
  'System.Type.ToString': (call, receiver) => {
    const type = typeOf(receiver);
    return typeString(call, 'ToString', typeof type === 'string' ? type : runtimeTypeName(type));
  },
});

defineNatives({
  'System.TypedReference.GetTargetType': (call, _receiver, [value]) => {
    const target = typedReferenceTarget(value as Value);
    return target && typeObject(call, target.type);
  },
  'System.TypedReference.ToObject': (call, _receiver, [value]) => {
    const target = typedReferenceTarget(value as Value);
    if (!target) fail('System.ArgumentNullException', 'Type in TypedReference cannot be null.', 'value');
    return evaluatorOf(call).box(target.reference.get(), target.type);
  },
  'System.TypedReference.Equals': () => fail('System.NotSupportedException', 'This feature is not implemented.'),
  // .NET hashes the referenced variable's type, whose Type object's identity hash this is.
  'System.TypedReference.GetHashCode': (call, receiver) => {
    const target = typedReferenceTarget(receiver);
    return target ? identityHash(call.frame.runtime, typeObject(call, target.type)) : 0;
  },
});

/**
 * A `System.Type` object standing for a type, which only names it: a type of the program or the library, or the full
 * name of a LINQ iterator, which stands for .NET's internal classes.
 */
function typeObject(call: NativeCall, type: Type | string): CsObject {
  return typeObjectOf(call.frame.runtime, type);
}

/** The run's one `Type` object of a type, which `GetType()` and `typeof` give, so that `==` compares types. */
export function typeObjectOf(runtime: Runtime, type: Type | string): CsObject {
  let objects = typeObjects.get(runtime);
  if (!objects) {
    objects = new Map();
    typeObjects.set(runtime, objects);
  }
  const target = typeof type !== 'string' && type.kind === 'void' ? 'System.Void' : type;
  const key = typeof target === 'string' ? target : runtimeTypeName(target);
  let object = objects.get(key);
  if (!object) {
    object = new CsObject(namedType(runtime.library.typeNamed('System.Type')), []);
    object.native = target;
    objects.set(key, object);
  }
  return object;
}

const typeObjects = new WeakMap<object, Map<string, CsObject>>();

function typeOf(receiver: Value): Type | string {
  return (receiver as CsObject).native as Type | string;
}

// ---- Enum ----

defineNatives({
  'System.Enum.ToString()': (call, receiver) => {
    const box = receiver as CsBox;
    return call.frame.runtime.enumString(box.type as NamedType, enumText(box.type as NamedType, box.value));
  },
  'System.Enum.ToString(string?)': (call, receiver, [format]) => {
    const box = receiver as CsBox;
    const text = formatValue(
      evaluatorOf(call),
      box.value,
      box.type,
      (format as string | undefined) ?? undefined,
      call.frame
    );
    // The names and the decimal digits come from .NET's caches; the hexadecimal digits are new each time.
    return /^[xX]$/.test((format as string | undefined) ?? '')
      ? text
      : call.frame.runtime.enumString(box.type as NamedType, text);
  },
  'System.Enum.HasFlag': (call, receiver, [flag]) => {
    if (flag === undefined) failNull('flag');
    const enumType = (receiver as CsBox).type;
    const flagType = evaluatorOf(call).runtime.runtimeTypeOf(flag as Value);
    if (!flagType || !sameType(flagType, enumType))
      fail(
        'System.ArgumentException',
        `The argument type, '${flagType ? runtimeTypeName(flagType) : 'null'}', is not the same as the enum type '${runtimeTypeName(enumType)}'.`
      );
    const value = BigInt(unboxed(receiver) as number | bigint);
    const mask = BigInt(unboxed(flag as Value) as number | bigint);
    return (value & mask) === mask;
  },
  'System.Enum.CompareTo': (call, receiver, [other]) => {
    if (other === undefined) return 1;
    const enumType = (receiver as CsBox).type;
    const otherType = evaluatorOf(call).runtime.runtimeTypeOf(other as Value);
    if (!otherType || !sameType(otherType, enumType))
      fail(
        'System.ArgumentException',
        `Object must be the same type as the enum. The type passed in was '${otherType ? runtimeTypeName(otherType) : 'null'}'; the enum type was '${runtimeTypeName(enumType)}'.`
      );
    const a = BigInt(unboxed(receiver) as number | bigint);
    const b = BigInt(unboxed(other as Value) as number | bigint);
    return a < b ? -1 : a > b ? 1 : 0;
  },
  'System.Enum.GetName': (call, _receiver, [value]) => {
    const type = call.typeArgs[0] as NamedType;
    const member = type.symbol.fields.find((field) => field.isConst && field.constantValue === unboxed(value as Value));
    return member ? call.frame.runtime.enumString(type, member.name) : undefined;
  },
  'System.Enum.GetNames': (call) => {
    const type = call.typeArgs[0] as NamedType;
    return newArray(
      call,
      libraryType(call, 'System.String'),
      enumMembers(type).map((field) => call.frame.runtime.enumString(type, field.name))
    );
  },
  'System.Enum.GetValues': (call) => {
    const type = call.typeArgs[0] as NamedType;
    return newArray(
      call,
      type,
      enumMembers(type).map((field) => field.constantValue as Value)
    );
  },
  'System.Enum.IsDefined': (call, _receiver, [value]) => {
    const type = call.typeArgs[0] as NamedType;
    return type.symbol.fields.some((field) => field.isConst && field.constantValue === unboxed(value as Value));
  },
  'System.Enum.Parse': (call, _receiver, args) =>
    parseEnum(call, args[0] as string, args.length > 1 && (args[1] as boolean), true),
  'System.Enum.TryParse': (call, _receiver, args) => {
    const result = refOf(args.at(-1) as VariableReference);
    const parsed = parseEnum(call, args[0] as string | undefined, args.length > 2 && (args[1] as boolean), false);
    result.set(parsed ?? (call.typeArgs[0].kind === 'named' ? 0 : 0));
    return parsed !== undefined;
  },
});

/** The members of an enum in the order of their values as unsigned numbers, as `GetValues` and `GetNames` list them. */
function enumMembers(type: NamedType): FieldSymbol[] {
  return type.symbol.fields
    .filter((field) => field.isConst)
    .toSorted((a, b) => {
      const [x, y] = [unsignedValue(a), unsignedValue(b)];
      return x < y ? -1 : x > y ? 1 : 0;
    });
}

function unsignedValue(field: FieldSymbol): bigint {
  return BigInt.asUintN(64, BigInt(field.constantValue as number | bigint));
}

// code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
function parseEnum(call: NativeCall, text: string | undefined, ignoreCase: boolean, throws: boolean): Value {
  const type = call.typeArgs[0] as NamedType;
  if (text === undefined) {
    if (throws) failNull('value');
    return undefined;
  }
  // .NET reads a list of names as the bitwise OR of their members, with or without `[Flags]`.
  let combined: bigint | undefined = 0n;
  for (const part of text.split(',')) {
    const trimmed = part.trim();
    const member = type.symbol.fields.find(
      (field) =>
        field.isConst && (ignoreCase ? field.name.toLowerCase() === trimmed.toLowerCase() : field.name === trimmed)
    );
    if (member) combined |= BigInt(member.constantValue as number | bigint);
    else if (/^[+-]?\d+$/.test(trimmed)) combined |= BigInt(trimmed);
    else {
      combined = undefined;
      break;
    }
  }
  if (combined !== undefined) {
    const special = (type.symbol.enumUnderlying as NamedType).symbol.special as SpecialType;
    return special === 'long' || special === 'ulong' ? combined : Number(combined);
  }
  if (throws) fail('System.ArgumentException', `Requested value '${text}' was not found.`);
  return undefined;
}

// ---- Primitives ----

const parsers: Record<string, NativeMethod> = {};
/**
 * An integer's `ToString` with a format: .NET returns its cached text of a small number for the formats that print
 * the plain digits, which are `G` without a precision and `D` with at most one digit, and a new string for others.
 */
function integerString(call: NativeCall, receiver: Value, format: Value, prefix: string): string | CsString {
  const formatText = (format as string | undefined) ?? undefined;
  const text = formatValue(evaluatorOf(call), unboxed(receiver), libraryType(call, prefix), formatText, call.frame);
  return /^(?:[Gg]0*|[Dd]0*1?)?$/.test(formatText ?? '') ? call.frame.runtime.numberString(text) : text;
}

for (const [name, special] of INTEGRAL) {
  const prefix = `System.${name}`;
  const [min, max] = integerRange(special);
  const fromBig = (value: bigint): Value => (isBigIntKind(special) ? value : Number(value));
  const isSigned = min < 0n;
  const width = (max + 1n).toString(2).length - 1 + (isSigned ? 1 : 0);
  const bitsOf = (value: Value): bigint => BigInt.asUintN(width, toBig(value));
  const fromBits = (bits: bigint): Value => fromBig(isSigned ? BigInt.asIntN(width, bits) : bits);
  Object.assign(parsers, {
    [`${prefix}.PopCount`]: (_call: NativeCall, _receiver: Value, [value]: Value[]) =>
      fromBig(BigInt([...bitsOf(value).toString(2)].filter((digit) => digit === '1').length)),
    [`${prefix}.LeadingZeroCount`]: (_call: NativeCall, _receiver: Value, [value]: Value[]) =>
      fromBig(BigInt(width - bitLength(bitsOf(value)))),
    [`${prefix}.TrailingZeroCount`]: (_call: NativeCall, _receiver: Value, [value]: Value[]) => {
      const bits = bitsOf(value);
      return fromBig(BigInt(bits === 0n ? width : bits.toString(2).length - 1 - bits.toString(2).lastIndexOf('1')));
    },
    [`${prefix}.Log2`]: (call: NativeCall, _receiver: Value, [value]: Value[]) => {
      if (toBig(value) < 0n) failOutOfRange(call, 'value', 'Non-negative number required.');
      return fromBig(BigInt(Math.max(0, bitLength(bitsOf(value)) - 1)));
    },
    [`${prefix}.RotateLeft`]: (_call: NativeCall, _receiver: Value, [value, amount]: Value[]) =>
      rotated(bitsOf(value), (amount as number) % width, width, fromBits),
    [`${prefix}.RotateRight`]: (_call: NativeCall, _receiver: Value, [value, amount]: Value[]) =>
      rotated(bitsOf(value), (width - ((amount as number) % width)) % width, width, fromBits),
    [`${prefix}.ToString()`]: (call: NativeCall, receiver: Value) =>
      call.frame.runtime.numberString(String(unboxed(receiver))),
    [`${prefix}.ToString(string?)`]: (call: NativeCall, receiver: Value, [format]: Value[]) =>
      integerString(call, receiver, format, prefix),
    [`${prefix}.ToString(IFormatProvider?)`]: (call: NativeCall, receiver: Value) =>
      call.frame.runtime.numberString(String(unboxed(receiver))),
    [`${prefix}.ToString(string?, IFormatProvider?)`]: (call: NativeCall, receiver: Value, [format]: Value[]) =>
      integerString(call, receiver, format, prefix),
    [`${prefix}.Equals`]: (_call: NativeCall, receiver: Value, [other]: Value[]) => {
      if (other instanceof CsBox) return specialOf(other.type) === special && unboxed(receiver) === other.value;
      return unboxed(receiver) === other;
    },
    [`${prefix}.GetHashCode`]: (_call: NativeCall, receiver: Value) => primitiveHash(unboxed(receiver)) ?? 0,
    [`${prefix}.CompareTo`]: (_call: NativeCall, receiver: Value, [other]: Value[]) => {
      if (other === undefined) return 1;
      // `CompareTo(object)` receives a box, which must hold the same type; `CompareTo(int)` receives the number.
      const isSameType =
        other instanceof CsBox
          ? specialOf(other.type) === special
          : typeof other !== 'object' && typeof other !== 'string';
      if (!isSameType) fail('System.ArgumentException', `Object must be of type ${name}.`);
      const a = toBig(receiver);
      const b = toBig(other);
      // The types narrower than int return the difference, as .NET's `m_value - value`; the others the sign.
      if (NARROW_INTEGRALS.has(special)) return Number(a - b);
      return a < b ? -1 : a > b ? 1 : 0;
    },
    [`${prefix}.Parse`]: (_call: NativeCall, _receiver: Value, [text]: Value[]) => {
      if (text === undefined) failNull('s');
      return fromBig(parseInteger(text as string, min, max, special, true) as bigint);
    },
    [`${prefix}.TryParse`]: (_call: NativeCall, _receiver: Value, [text, result]: (Value | VariableReference)[]) => {
      const parsed = text === undefined ? undefined : parseInteger(text as string, min, max, special, false);
      refOf(result).set(fromBig(parsed ?? 0n));
      return parsed !== undefined;
    },
    [`${prefix}.Abs`]: (_call: NativeCall, _receiver: Value, [value]: Value[]) => {
      const integer = toBig(value);
      if (integer === min && min < 0n)
        fail('System.OverflowException', 'Negating the minimum value of a twos complement number is invalid.');
      return fromBig(integer < 0n ? -integer : integer);
    },
    [`${prefix}.Max`]: (_call: NativeCall, _receiver: Value, [a, b]: Value[]) => (toBig(a) >= toBig(b) ? a : b),
    [`${prefix}.Min`]: (_call: NativeCall, _receiver: Value, [a, b]: Value[]) => (toBig(a) <= toBig(b) ? a : b),
    [`${prefix}.Clamp`]: (_call: NativeCall, _receiver: Value, [value, low, high]: Value[]) =>
      clampInteger(value, low, high, toBig),
    [`${prefix}.Sign`]: (_call: NativeCall, _receiver: Value, [value]: Value[]) => Math.sign(Number(toBig(value))),
    [`${prefix}.IsEvenInteger`]: (_call: NativeCall, _receiver: Value, [value]: Value[]) => toBig(value) % 2n === 0n,
    [`${prefix}.IsOddInteger`]: (_call: NativeCall, _receiver: Value, [value]: Value[]) => toBig(value) % 2n !== 0n,
    [`${prefix}.IsPow2`]: (_call: NativeCall, _receiver: Value, [value]: Value[]) => {
      const integer = toBig(value);
      return integer > 0n && (integer & (integer - 1n)) === 0n;
    },
    [`${prefix}.DivRem`]: (call: NativeCall, _receiver: Value, [left, right]: Value[]) => {
      const [a, b] = [toBig(left), toBig(right)];
      if (b === 0n) fail('System.DivideByZeroException', 'Attempted to divide by zero.');
      if (a / b > max) fail('System.OverflowException', 'Arithmetic operation resulted in an overflow.');
      return new CsStruct(call.method.returnType as NamedType, [fromBig(a / b), fromBig(a % b)]);
    },
    [`${prefix}.CopySign`]: (_call: NativeCall, _receiver: Value, [value, sign]: Value[]) => {
      const magnitude = toBig(value) < 0n ? -toBig(value) : toBig(value);
      const result = toBig(sign) < 0n ? -magnitude : magnitude;
      if (result > max)
        fail('System.OverflowException', 'Negating the minimum value of a twos complement number is invalid.');
      return fromBig(result);
    },
    [`${prefix}.IsNegative`]: (_call: NativeCall, _receiver: Value, [value]: Value[]) => toBig(value) < 0n,
    [`${prefix}.IsPositive`]: (_call: NativeCall, _receiver: Value, [value]: Value[]) => toBig(value) >= 0n,
  });
}
defineNatives(parsers);

function bitLength(bits: bigint): number {
  return bits === 0n ? 0 : bits.toString(2).length;
}

/** The bits of an integer rotated left within its width, as `int.RotateLeft` does. */
function rotated(bits: bigint, amount: number, width: number, fromBits: (bits: bigint) => Value): Value {
  const shift = BigInt((amount + width) % width);
  return fromBits(BigInt.asUintN(width, (bits << shift) | (bits >> (BigInt(width) - shift))));
}

function clampInteger(value: Value, low: Value, high: Value, toBig: (value: Value) => bigint): Value {
  if (toBig(low) > toBig(high))
    fail('System.ArgumentException', `'${String(low)}' cannot be greater than ${String(high)}.`);
  if (toBig(value) < toBig(low)) return low;
  if (toBig(value) > toBig(high)) return high;
  return value;
}

/** Parses an integer as `int.Parse` does: optional whitespace and sign, decimal digits, and a thousands-free number. */
function parseInteger(
  text: string,
  min: bigint,
  max: bigint,
  special: SpecialType,
  throws: boolean
): bigint | undefined {
  const match = /^([+-]?)(\d+)$/.exec(trimNumberText(text));
  if (!match) {
    if (throws) fail('System.FormatException', `The input string '${text}' was not in a correct format.`);
    return undefined;
  }
  const value = BigInt(`${match[1]}${match[2]}`);
  if (value < min || value > max) {
    if (throws)
      fail('System.OverflowException', `Value was either too large or too small for ${OVERFLOW_NAMES[special]}.`);
    return undefined;
  }
  return value;
}

for (const [name, special] of [
  ['Double', 'double'],
  ['Single', 'float'],
] as const) {
  const prefix = `System.${name}`;
  const isFloat = special === 'float';
  const round = (value: number): number => (isFloat ? Math.fround(value) : value);
  defineNatives({
    [`${prefix}.ToString()`]: (call, receiver) =>
      formatValue(evaluatorOf(call), unboxed(receiver), libraryType(call, prefix), undefined, call.frame),
    [`${prefix}.ToString(string?)`]: (call, receiver, [format]) =>
      formatValue(
        evaluatorOf(call),
        unboxed(receiver),
        libraryType(call, prefix),
        (format as string | undefined) ?? undefined,
        call.frame
      ),
    [`${prefix}.ToString(IFormatProvider?)`]: (call, receiver) =>
      formatValue(evaluatorOf(call), unboxed(receiver), libraryType(call, prefix), undefined, call.frame),
    [`${prefix}.ToString(string?, IFormatProvider?)`]: (call, receiver, [format]) =>
      formatValue(
        evaluatorOf(call),
        unboxed(receiver),
        libraryType(call, prefix),
        (format as string | undefined) ?? undefined,
        call.frame
      ),
    [`${prefix}.Equals`]: (_call, receiver, [other]) => {
      const a = unboxed(receiver) as number;
      if (other instanceof CsBox && specialOf(other.type) !== special) return false;
      const b = unboxed(other as Value) as number;
      return a === b || (Number.isNaN(a) && Number.isNaN(b));
    },
    [`${prefix}.GetHashCode`]: (_call, receiver) => primitiveHash(unboxed(receiver)) ?? 0,
    [`${prefix}.CompareTo`]: (_call, receiver, [other]) => {
      if (other === undefined) return 1;
      const a = unboxed(receiver) as number;
      const b = unboxed(other as Value) as number;
      if (Number.isNaN(a)) return Number.isNaN(b) ? 0 : -1;
      if (Number.isNaN(b)) return 1;
      return a < b ? -1 : a > b ? 1 : 0;
    },
    [`${prefix}.Parse`]: (_call, _receiver, [text]) => {
      if (text === undefined) failNull('s');
      const value = parseNumber(text as string);
      if (value === undefined)
        fail('System.FormatException', `The input string '${text}' was not in a correct format.`);
      return round(value);
    },
    [`${prefix}.TryParse`]: (_call, _receiver, [text, result]) => {
      const value = text === undefined ? undefined : parseNumber(text as string);
      refOf(result).set(value === undefined ? 0 : round(value));
      return value !== undefined;
    },
    [`${prefix}.IsNaN`]: (_call, _receiver, [value]) => Number.isNaN(value),
    [`${prefix}.IsInfinity`]: (_call, _receiver, [value]) =>
      value === Number.POSITIVE_INFINITY || value === Number.NEGATIVE_INFINITY,
    [`${prefix}.IsPositiveInfinity`]: (_call, _receiver, [value]) => value === Number.POSITIVE_INFINITY,
    [`${prefix}.IsNegativeInfinity`]: (_call, _receiver, [value]) => value === Number.NEGATIVE_INFINITY,
    [`${prefix}.IsFinite`]: (_call, _receiver, [value]) => Number.isFinite(value),
    [`${prefix}.IsNegative`]: (_call, _receiver, [value]) => (value as number) < 0 || Object.is(value, -0),
    [`${prefix}.IsInteger`]: (_call, _receiver, [value]) => Number.isInteger(value),
    [`${prefix}.Abs`]: (_call, _receiver, [value]) => Math.abs(value as number),
    [`${prefix}.Max`]: (_call, _receiver, [a, b]) => mathMax(a as number, b as number),
    [`${prefix}.Min`]: (_call, _receiver, [a, b]) => mathMin(a as number, b as number),
    [`${prefix}.Clamp`]: (_call, _receiver, [value, low, high]) =>
      Math.min(Math.max(value as number, low as number), high as number),
    [`${prefix}.Round`]: (_call, _receiver, [value]) => roundEven(value as number),
    [`${prefix}.Floor`]: (_call, _receiver, [value]) => Math.floor(value as number),
    [`${prefix}.Ceiling`]: (_call, _receiver, [value]) => Math.ceil(value as number),
    [`${prefix}.Truncate`]: (_call, _receiver, [value]) => Math.trunc(value as number),
    [`${prefix}.Sqrt`]: (_call, _receiver, [value]) => round(Math.sqrt(value as number)),
    [`${prefix}.Pow`]: (_call, _receiver, [a, b]) => round(Math.pow(a as number, b as number)),
  });
}

defineNativesKeepingStrings({
  // `bool.TrueString` and `bool.FalseString`, which are literals and so interned.
  'System.Boolean.ToString': (_call, receiver) => (unboxed(receiver) ? 'True' : 'False'),
});

defineNatives({
  'System.Boolean.Equals': (_call, receiver, [other]) => unboxed(receiver) === unboxed(other as Value),
  'System.Boolean.GetHashCode': (_call, receiver) => (unboxed(receiver) ? 1 : 0),
  'System.Boolean.CompareTo': (_call, receiver, [other]) => {
    if (other === undefined) return 1;
    const a = unboxed(receiver) as boolean;
    const b = unboxed(other as Value) as boolean;
    return a === b ? 0 : a ? 1 : -1;
  },
  'System.Boolean.Parse': (_call, _receiver, [text]) => {
    if (text === undefined) failNull('value');
    const parsed = parseBool(text as string);
    if (parsed === undefined) fail('System.FormatException', `String '${text}' was not recognized as a valid Boolean.`);
    return parsed;
  },
  'System.Boolean.TryParse': (_call, _receiver, [text, result]) => {
    const parsed = text === undefined ? undefined : parseBool(text as string);
    refOf(result).set(parsed ?? false);
    return parsed !== undefined;
  },
});

function parseBool(text: string): boolean | undefined {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return undefined;
}

defineNatives({
  // The numeric conversion to decimal raises .NET's OverflowException for NaN, infinities, and values out of range.
  'System.Decimal..ctor': (call, _receiver, [value]) =>
    convertNumeric(value as NumericValue, specialOf(call.method.parameters[0].type) as SpecialType, 'decimal'),
  'System.Decimal.ToString()': (_call, receiver) => (unboxed(receiver) as CsDecimal).toString(),
  'System.Decimal.ToString(string?)': (call, receiver, [format]) =>
    formatValue(
      evaluatorOf(call),
      unboxed(receiver),
      libraryType(call, 'System.Decimal'),
      (format as string | undefined) ?? undefined,
      call.frame
    ),
  'System.Decimal.ToString(IFormatProvider?)': (_call, receiver) => (unboxed(receiver) as CsDecimal).toString(),
  'System.Decimal.ToString(string?, IFormatProvider?)': (call, receiver, [format]) =>
    formatValue(
      evaluatorOf(call),
      unboxed(receiver),
      libraryType(call, 'System.Decimal'),
      (format as string | undefined) ?? undefined,
      call.frame
    ),
  'System.Decimal.Equals': (_call, receiver, [other]) => {
    const b = unboxed(other as Value);
    return b instanceof CsDecimal && (unboxed(receiver) as CsDecimal).equals(b);
  },
  'System.Decimal.GetHashCode': (_call, receiver) => primitiveHash(unboxed(receiver)) ?? 0,
  'System.Decimal.CompareTo': (_call, receiver, [other]) => {
    if (other === undefined) return 1;
    const value = unboxed(other as Value);
    if (!(value instanceof CsDecimal)) fail('System.ArgumentException', 'Object must be of type Decimal.');
    return (unboxed(receiver) as CsDecimal).compare(value);
  },
  'System.Decimal.Parse': (_call, _receiver, [text]) => {
    if (text === undefined) failNull('s');
    const parsed = parseDecimal(text as string);
    if (!parsed) fail('System.FormatException', `The input string '${text}' was not in a correct format.`);
    return parsed;
  },
  'System.Decimal.TryParse': (_call, _receiver, [text, result]) => {
    const parsed = text === undefined ? undefined : parseDecimal(text as string);
    refOf(result).set(parsed ?? CsDecimal.ZERO);
    return parsed !== undefined;
  },
  'System.Decimal.Abs': (_call, _receiver, [value]) => {
    const decimal = value as CsDecimal;
    return decimal.isNegative ? decimal.negate() : decimal;
  },
  'System.Decimal.Max': (_call, _receiver, [a, b]) =>
    (a as CsDecimal).compare(b as CsDecimal) >= 0 ? (a as CsDecimal) : (b as CsDecimal),
  'System.Decimal.Min': (_call, _receiver, [a, b]) =>
    (a as CsDecimal).compare(b as CsDecimal) <= 0 ? (a as CsDecimal) : (b as CsDecimal),
  'System.Decimal.Add': (_call, _receiver, [a, b]) => decimalOperation(() => (a as CsDecimal).add(b as CsDecimal)),
  'System.Decimal.Subtract': (_call, _receiver, [a, b]) =>
    decimalOperation(() => (a as CsDecimal).subtract(b as CsDecimal)),
  'System.Decimal.Multiply': (_call, _receiver, [a, b]) =>
    decimalOperation(() => (a as CsDecimal).multiply(b as CsDecimal)),
  'System.Decimal.Divide': (_call, _receiver, [a, b]) => {
    if ((b as CsDecimal).isZero()) fail('System.DivideByZeroException', 'Attempted to divide by zero.');
    return decimalOperation(() => (a as CsDecimal).divide(b as CsDecimal));
  },
  'System.Decimal.Remainder': (_call, _receiver, [a, b]) => {
    if ((b as CsDecimal).isZero()) fail('System.DivideByZeroException', 'Attempted to divide by zero.');
    return (a as CsDecimal).remainder(b as CsDecimal);
  },
  'System.Decimal.Negate': (_call, _receiver, [value]) => (value as CsDecimal).negate(),
  'System.Decimal.Floor': (_call, _receiver, [value]) => (value as CsDecimal).round(0, 'floor'),
  'System.Decimal.Ceiling': (_call, _receiver, [value]) => (value as CsDecimal).round(0, 'ceiling'),
  'System.Decimal.Truncate': (_call, _receiver, [value]) => (value as CsDecimal).round(0, 'down'),
  'System.Decimal.Sign': (_call, _receiver, [value]) =>
    (value as CsDecimal).isZero() ? 0 : (value as CsDecimal).isNegative ? -1 : 1,
  'System.Decimal.ToInt32': (_call, _receiver, [value]) => convertNumeric(value as CsDecimal, 'decimal', 'int'),
  'System.Decimal.ToInt64': (_call, _receiver, [value]) => convertNumeric(value as CsDecimal, 'decimal', 'long'),
  'System.Decimal.ToDouble': (_call, _receiver, [value]) => (value as CsDecimal).toDouble(),
});

function decimalOperation(run: () => CsDecimal): CsDecimal {
  try {
    return run();
  } catch (error) {
    if (error instanceof PendingException) throw error;
    fail('System.OverflowException', 'Value was either too large or too small for a Decimal.');
  }
}

const MIDPOINT_MODES = ['even', 'awayFromZero', 'down', 'floor', 'ceiling'] as const;

/** The nullable natives receive the underlying value, or null for a missing one. */
defineNatives({
  'System.Nullable`1..ctor': (_call, _receiver, [value]) => value as Value,
  'System.Nullable`1.get_HasValue': (_call, receiver) => receiver !== undefined,
  'System.Nullable`1.get_Value': (_call, receiver) => {
    if (receiver === undefined) fail('System.InvalidOperationException', 'Nullable object must have a value.');
    return unboxed(receiver);
  },
  'System.Nullable`1.GetValueOrDefault()': (call, receiver) =>
    receiver === undefined
      ? evaluatorOf(call).defaultOf(call.owner?.args[0] ?? libraryType(call, 'System.Int32'))
      : unboxed(receiver),
  'System.Nullable`1.GetValueOrDefault(T)': (_call, receiver, [fallback]) =>
    receiver === undefined ? (fallback as Value) : unboxed(receiver),
  'System.Nullable`1.Equals': (call, receiver, [other]) => {
    if (receiver === undefined) return other === undefined;
    if (other === undefined) return false;
    // The underlying type's Equals(object) holds only for a box of that same type, as `1.Equals(1.0)` is false.
    const underlying = call.owner?.args[0];
    if (other instanceof CsBox && underlying && !sameType(other.type, call.frame.resolve(underlying))) return false;
    return valuesEqual(evaluatorOf(call), unboxed(receiver), unboxed(other as Value), call.frame);
  },
  'System.Nullable`1.GetHashCode': (call, receiver) =>
    receiver === undefined ? 0 : hashOf(evaluatorOf(call), unboxed(receiver), call.frame),
});

defineNativesKeepingStrings({
  'System.Nullable`1.ToString': (call, receiver) =>
    toStringValue(
      evaluatorOf(call),
      unboxed(receiver),
      call.frame.resolve(call.owner?.args[0] ?? libraryType(call, 'System.Object')),
      call.frame
    ),
});

/** Parses a decimal as `decimal.Parse` does, whose number style allows group separators but no exponent. */
function parseDecimal(text: string): CsDecimal | undefined {
  const normalized = normalizeNumberText(text, false);
  return normalized === undefined ? undefined : CsDecimal.parse(normalized);
}

// ---- Math ----

function checkDecimals(digits: number): number {
  if (digits < 0 || digits > 28) {
    fail(
      'System.ArgumentOutOfRangeException',
      'Decimal can only round to between 0 and 28 digits of precision.',
      'decimals'
    );
  }
  return digits;
}

/** `Math.DivRem` with an `out` remainder, which divides as `/` and `%` do, failing alike on zero. */
function divRem(kind: 'int' | 'long', a: NumericValue, b: NumericValue, result: Value | VariableReference): Value {
  const quotient = arithmetic('/', kind, a, b, false);
  refOf(result).set(arithmetic('%', kind, a, b, false));
  return quotient;
}

function divRemTuple(call: NativeCall, kind: 'int' | 'long', a: NumericValue, b: NumericValue): Value {
  const quotient = arithmetic('/', kind, a, b, false);
  return new CsStruct(call.method.returnType as NamedType, [quotient, arithmetic('%', kind, a, b, false)]);
}

/** `Math.Round(double)`, which rounds half to even. */
function roundEven(value: number): number {
  if (!Number.isFinite(value)) return value;
  const floor = Math.floor(value);
  const difference = value - floor;
  const rounded = difference > 0.5 ? floor + 1 : difference < 0.5 ? floor : floor % 2 === 0 ? floor : floor + 1;
  return withSignOf(value, rounded);
}

/** A rounded zero keeps the sign of the number rounded, as `Math.Round(-0.4)` gives -0. */
function withSignOf(value: number, rounded: number): number {
  return rounded === 0 && (value < 0 || Object.is(value, -0)) ? -0 : rounded;
}

function mathMax(a: number, b: number): number {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.NaN;
  if (a === 0 && b === 0) return Object.is(a, -0) ? b : a;
  return a > b ? a : b;
}

function mathMin(a: number, b: number): number {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.NaN;
  if (a === 0 && b === 0) return Object.is(a, -0) ? a : b;
  return a < b ? a : b;
}

const POWERS_OF_TEN = Array.from({ length: 16 }, (_unused, index) => 10 ** index);

/** `Math.Round(double, digits, mode)`, which .NET computes by scaling by a power of ten. */
function roundDouble(value: number, digits: number, mode: number): number {
  if (digits < 0 || digits > 15)
    fail('System.ArgumentOutOfRangeException', 'Rounding digits must be between 0 and 15, inclusive.', 'digits');
  if (Math.abs(value) >= 1e16) return value;
  const power = POWERS_OF_TEN[digits];
  let scaled = value * power;
  switch (mode) {
    case 1: {
      const fraction = scaled - Math.trunc(scaled);
      scaled = Math.trunc(scaled);
      if (Math.abs(fraction) >= 0.5) scaled += Math.sign(fraction);
      break;
    }
    case 2: {
      scaled = Math.trunc(scaled);
      break;
    }
    case 3: {
      scaled = Math.floor(scaled);
      break;
    }
    case 4: {
      scaled = Math.ceil(scaled);
      break;
    }
    default: {
      scaled = roundEven(scaled);
    }
  }
  return withSignOf(value, scaled / power);
}

const numericMath =
  (operation: (call: NativeCall, args: Value[]) => Value): NativeMethod =>
  (call, _receiver, args) =>
    operation(call, args as Value[]);

defineNatives({
  // .NET seeds HashCode per process, so programs rely only on equal values combining to equal hashes.
  'System.HashCode.Combine': (call, _receiver, args) => tupleHash(call, args as Value[]),
  'System.Math.Abs': numericMath((call, [value]) => {
    const type = parameterType(call, 0);
    const special = specialOf(type) as SpecialType;
    if (special === 'decimal') return (value as CsDecimal).isNegative ? (value as CsDecimal).negate() : value;
    if (special === 'double' || special === 'float') return Math.abs(value as number);
    const integer = BigInt(value as number | bigint);
    if (integer === integerRange(special)[0])
      fail('System.OverflowException', 'Negating the minimum value of a twos complement number is invalid.');
    return isBigIntKind(special) ? (integer < 0n ? -integer : integer) : Math.abs(value as number);
  }),
  'System.Math.Max': numericMath((call, [a, b]) => extremum(call, a, b, true)),
  'System.Math.Min': numericMath((call, [a, b]) => extremum(call, a, b, false)),
  'System.Math.Clamp': numericMath((call, [value, low, high]) => {
    const order = (x: Value, y: Value): number => compareNumbers(call, x, y);
    if (order(low, high) > 0)
      fail(
        'System.ArgumentException',
        `'${textOf(call, low, parameterType(call, 1))}' cannot be greater than ${textOf(call, high, parameterType(call, 2))}.`
      );
    if (order(value, low) < 0) return low;
    if (order(value, high) > 0) return high;
    return value;
  }),
  'System.Math.Sign': numericMath((call, [value]) => {
    const special = specialOf(parameterType(call, 0));
    if (special === 'decimal') return (value as CsDecimal).isZero() ? 0 : (value as CsDecimal).isNegative ? -1 : 1;
    if (typeof value === 'number' && Number.isNaN(value))
      fail('System.ArithmeticException', 'Function does not accept floating point Not-a-Number values.');
    return Math.sign(Number(value));
  }),
  // IEEE 754's pow, which .NET follows, gives 1 for a base of 1 and for -1 to an infinite power, where JavaScript gives NaN.
  'System.Math.Pow': (_call, _receiver, [a, b]) =>
    a === 1 || (a === -1 && !Number.isFinite(b as number) && !Number.isNaN(b)) ? 1 : Math.pow(a as number, b as number),
  'System.Math.Sqrt': (_call, _receiver, [value]) => Math.sqrt(value as number),
  'System.Math.Cbrt': (_call, _receiver, [value]) => Math.cbrt(value as number),
  'System.Math.Exp': (_call, _receiver, [value]) => Math.exp(value as number),
  'System.Math.Log(double)': (_call, _receiver, [value]) => Math.log(value as number),
  'System.Math.Log(double, double)': (_call, _receiver, [value, base]) =>
    Math.log(value as number) / Math.log(base as number),
  'System.Math.Log10': (_call, _receiver, [value]) => Math.log10(value as number),
  'System.Math.Log2': (_call, _receiver, [value]) => Math.log2(value as number),
  'System.Math.Sin': (_call, _receiver, [value]) => Math.sin(value as number),
  'System.Math.Cos': (_call, _receiver, [value]) => Math.cos(value as number),
  'System.Math.Tan': (_call, _receiver, [value]) => Math.tan(value as number),
  'System.Math.Asin': (_call, _receiver, [value]) => Math.asin(value as number),
  'System.Math.Acos': (_call, _receiver, [value]) => Math.acos(value as number),
  'System.Math.Atan': (_call, _receiver, [value]) => Math.atan(value as number),
  'System.Math.Atan2': (_call, _receiver, [y, x]) => Math.atan2(y as number, x as number),
  'System.Math.Sinh': (_call, _receiver, [value]) => Math.sinh(value as number),
  'System.Math.Cosh': (_call, _receiver, [value]) => Math.cosh(value as number),
  'System.Math.Tanh': (_call, _receiver, [value]) => Math.tanh(value as number),
  'System.Math.Asinh': (_call, _receiver, [value]) => Math.asinh(value as number),
  'System.Math.Acosh': (_call, _receiver, [value]) => Math.acosh(value as number),
  'System.Math.Atanh': (_call, _receiver, [value]) => Math.atanh(value as number),
  'System.Math.CopySign': (_call, _receiver, [x, y]) =>
    Math.abs(x as number) * (Object.is(y, -0) || (y as number) < 0 ? -1 : 1),
  'System.Math.FusedMultiplyAdd': (_call, _receiver, [x, y, z]) => (x as number) * (y as number) + (z as number),
  'System.Math.IEEERemainder': (_call, _receiver, [x, y]) =>
    (x as number) - (y as number) * roundEven((x as number) / (y as number)),
  'System.Math.BigMul(int, int)': (_call, _receiver, [a, b]) => BigInt(a as number) * BigInt(b as number),
  'System.Math.BigMul(uint, uint)': (_call, _receiver, [a, b]) => BigInt(a as number) * BigInt(b as number),
  // The 128-bit product's high half is returned and its low half stored, each as the operands' type.
  'System.Math.BigMul(long, long, long)': (_call, _receiver, [a, b, low]) => {
    const product = (a as bigint) * (b as bigint);
    refOf(low).set(BigInt.asIntN(64, product));
    return BigInt.asIntN(64, product >> 64n);
  },
  'System.Math.BigMul(ulong, ulong, ulong)': (_call, _receiver, [a, b, low]) => {
    const product = (a as bigint) * (b as bigint);
    refOf(low).set(BigInt.asUintN(64, product));
    return BigInt.asUintN(64, product >> 64n);
  },
  'System.Math.DivRem(int, int, int)': (_call, _receiver, [a, b, result]) =>
    divRem('int', a as number, b as number, result),
  'System.Math.DivRem(long, long, long)': (_call, _receiver, [a, b, result]) =>
    divRem('long', a as bigint, b as bigint, result),
  'System.Math.DivRem(int, int)': (call, _receiver, [a, b]) => divRemTuple(call, 'int', a as number, b as number),
  'System.Math.DivRem(long, long)': (call, _receiver, [a, b]) => divRemTuple(call, 'long', a as bigint, b as bigint),
  'System.Math.Floor(double)': (_call, _receiver, [value]) => Math.floor(value as number),
  'System.Math.Floor(decimal)': (_call, _receiver, [value]) => (value as CsDecimal).round(0, 'floor'),
  'System.Math.Ceiling(double)': (_call, _receiver, [value]) => Math.ceil(value as number),
  'System.Math.Ceiling(decimal)': (_call, _receiver, [value]) => (value as CsDecimal).round(0, 'ceiling'),
  'System.Math.Truncate(double)': (_call, _receiver, [value]) => Math.trunc(value as number),
  'System.Math.Truncate(decimal)': (_call, _receiver, [value]) => (value as CsDecimal).round(0, 'down'),
  'System.Math.Round(double)': (_call, _receiver, [value]) => roundEven(value as number),
  'System.Math.Round(double, int)': (_call, _receiver, [value, digits]) =>
    roundDouble(value as number, digits as number, 0),
  'System.Math.Round(double, int, MidpointRounding)': (_call, _receiver, [value, digits, mode]) =>
    roundDouble(value as number, digits as number, mode as number),
  'System.Math.Round(double, MidpointRounding)': (_call, _receiver, [value, mode]) =>
    roundDouble(value as number, 0, mode as number),
  'System.Math.Round(decimal)': (_call, _receiver, [value]) => (value as CsDecimal).round(0, 'even'),
  'System.Math.Round(decimal, int)': (_call, _receiver, [value, digits]) =>
    (value as CsDecimal).round(checkDecimals(digits as number), 'even'),
  'System.Math.Round(decimal, int, MidpointRounding)': (_call, _receiver, [value, digits, mode]) =>
    (value as CsDecimal).round(checkDecimals(digits as number), MIDPOINT_MODES[mode as number]),
  'System.Math.Round(decimal, MidpointRounding)': (_call, _receiver, [value, mode]) =>
    (value as CsDecimal).round(0, MIDPOINT_MODES[mode as number]),
  'System.Decimal.Round(decimal)': (_call, _receiver, [value]) => (value as CsDecimal).round(0, 'even'),
  'System.Decimal.Round(decimal, int)': (_call, _receiver, [value, digits]) =>
    (value as CsDecimal).round(checkDecimals(digits as number), 'even'),
  'System.Decimal.Round(decimal, int, MidpointRounding)': (_call, _receiver, [value, digits, mode]) =>
    (value as CsDecimal).round(checkDecimals(digits as number), MIDPOINT_MODES[mode as number]),
  'System.Decimal.Round(decimal, MidpointRounding)': (_call, _receiver, [value, mode]) =>
    (value as CsDecimal).round(0, MIDPOINT_MODES[mode as number]),
});

function compareNumbers(call: NativeCall, a: Value, b: Value): number {
  if (a instanceof CsDecimal) return a.compare(b as CsDecimal);
  if (typeof a === 'bigint') return a < (b as bigint) ? -1 : a > (b as bigint) ? 1 : 0;
  void call;
  return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
}

function extremum(call: NativeCall, a: Value, b: Value, isMax: boolean): Value {
  const special = specialOf(parameterType(call, 0));
  if (special === 'double' || special === 'float')
    return isMax ? mathMax(a as number, b as number) : mathMin(a as number, b as number);
  const order = compareNumbers(call, a, b);
  return isMax ? (order >= 0 ? a : b) : order <= 0 ? a : b;
}

// ---- Convert ----

defineNatives({
  'System.Convert.ToInt32': (call, _receiver, args) => convertTo(call, args, 'int'),
  'System.Convert.ToInt64': (call, _receiver, args) => convertTo(call, args, 'long'),
  'System.Convert.ToInt16': (call, _receiver, args) => convertTo(call, args, 'short'),
  'System.Convert.ToByte': (call, _receiver, args) => convertTo(call, args, 'byte'),
  'System.Convert.ToSByte': (call, _receiver, args) => convertTo(call, args, 'sbyte'),
  'System.Convert.ToDouble': (call, _receiver, args) => convertTo(call, args, 'double'),
  'System.Convert.ToSingle': (call, _receiver, args) => convertTo(call, args, 'float'),
  'System.Convert.ToDecimal': (call, _receiver, args) => convertTo(call, args, 'decimal'),
  'System.Convert.ToChar': (call, _receiver, args) => convertTo(call, args, 'char'),
  'System.Convert.ToBoolean': (call, _receiver, [value]) => {
    const type = parameterType(call, 0);
    const special = specialOf(type);
    if (special === 'string') {
      if (value === undefined) return false;
      const parsed = parseBool(value as string);
      if (parsed === undefined)
        fail('System.FormatException', `String '${value}' was not recognized as a valid Boolean.`);
      return parsed;
    }
    const inner = unboxed(value as Value);
    if (inner === undefined) return false;
    if (typeof inner === 'boolean') return inner;
    const source = value instanceof CsBox ? specialOf(value.type) : special;
    if (source === 'char') checkConvertible('char', 'bool');
    if (typeof inner === 'string')
      return (
        parseBool(inner) ?? fail('System.FormatException', `String '${inner}' was not recognized as a valid Boolean.`)
      );
    return Number(inner) !== 0;
  },
});

defineNativesKeepingStrings({
  'System.Convert.ToString(string?)': (_call, _receiver, [value]) => value as Value,
  'System.Convert.ToString(int, int)': (call, _receiver, [value, base]) =>
    radixText(call, BigInt(value as number), base as number, 32),
  'System.Convert.ToString(long, int)': (call, _receiver, [value, base]) =>
    radixText(call, value as bigint, base as number, 64),
  'System.Convert.ToString(short, int)': (call, _receiver, [value, base]) =>
    radixText(call, BigInt(value as number), base as number, 16),
  'System.Convert.ToString(byte, int)': (call, _receiver, [value, base]) =>
    radixText(call, BigInt(value as number), base as number, 8),
  // `ToString()` of the value, as the object it returns.
  'System.Convert.ToString': (call, _receiver, [value]) =>
    toStringValue(evaluatorOf(call), value as Value, parameterType(call, 0), call.frame),
});

/** The digits of an integer in a base, of which base 10 is `ToString()` and its cached text of a small number. */
function radixText(call: NativeCall, value: bigint, base: number, bits: number): string | CsString {
  if (![2, 8, 10, 16].includes(base)) fail('System.ArgumentException', 'Invalid Base.');
  if (base === 10) return call.frame.runtime.numberString(value.toString());
  return freshString(BigInt.asUintN(bits, value).toString(base));
}

function convertTo(call: NativeCall, args: (Value | VariableReference)[], target: SpecialType): Value {
  const [value, fromBase] = args as Value[];
  const declared = specialOf(parameterType(call, 0));
  const isUntyped = declared === 'object' || declared === undefined;
  if (isUntyped && value === undefined) return zeroOf(target);
  const { source, inner } = isUntyped ? convertibleOf(call, value) : { source: declared, inner: value };
  checkConvertible(source, target);
  if (source === 'string') return convertString(inner as string | undefined, fromBase, target);
  if (source === 'bool') return boolNumber(inner as boolean, target);
  if (isIntegral(target)) {
    if (source === 'double' || source === 'float') return floatToInteger(inner as number, target);
    if (source === 'decimal') return convertNumeric((inner as CsDecimal).round(0, 'even'), 'decimal', target);
    checkIntegerRange(BigInt(inner as number | bigint), target);
  }
  return convertNumeric(inner as NumericValue, source, target);
}

/** .NET's IConvertible names, for the conversions between a char and a bool or a non-integral number that it rejects. */
const CONVERTIBLE_NAMES: Partial<Record<SpecialType, string>> = {
  char: 'Char',
  bool: 'Boolean',
  double: 'Double',
  float: 'Single',
  decimal: 'Decimal',
};

function checkConvertible(source: SpecialType, target: SpecialType): void {
  if (source !== 'char' && target !== 'char') return;
  const other = source === 'char' ? target : source;
  if (other === 'char' || CONVERTIBLE_NAMES[other] === undefined) return;
  fail(
    'System.InvalidCastException',
    `Invalid cast from '${CONVERTIBLE_NAMES[source]}' to '${CONVERTIBLE_NAMES[target]}'.`
  );
}

/** Whether `Convert` rounds a value to the type, which every target but the floating ones and decimal needs. */
function isIntegral(type: SpecialType): boolean {
  return type !== 'double' && type !== 'float' && type !== 'decimal';
}

function zeroOf(target: SpecialType): Value {
  if (target === 'decimal') return CsDecimal.ZERO;
  return target === 'long' ? 0n : 0;
}

/** The value inside an `object` argument and its type, which must implement `IConvertible`. */
function convertibleOf(call: NativeCall, value: Value): { source: SpecialType; inner: Value } {
  if (value instanceof CsBox) return { source: specialOf(value.type) ?? 'int', inner: value.value };
  if (isString(value)) return { source: 'string', inner: stringText(value) };
  return fail(
    'System.InvalidCastException',
    `Unable to cast object of type '${runtimeTypeName(call.frame.runtime.runtimeTypeOf(value) ?? libraryType(call, 'System.Object'))}' to type 'System.IConvertible'.`
  );
}

function convertString(text: string | undefined, fromBase: Value, target: SpecialType): Value {
  if (text === undefined) {
    if (target === 'char') fail('System.ArgumentNullException', 'Value cannot be null.', 'value');
    return zeroOf(target);
  }
  if (fromBase !== undefined) return parseRadix(text, fromBase as number, target);
  if (!isIntegral(target)) return parseNonIntegral(text, target);
  if (target === 'char') {
    if (text.length !== 1) fail('System.FormatException', 'String must be exactly one character long.');
    return text.charCodeAt(0);
  }
  const [min, max] = integerRange(target);
  const parsed = parseInteger(text, min, max, target, true) as bigint;
  return isBigIntKind(target) ? parsed : Number(parsed);
}

function parseNonIntegral(text: string, target: SpecialType): Value {
  const parsed = target === 'decimal' ? parseDecimal(text) : parseNumber(text);
  if (parsed === undefined) fail('System.FormatException', `The input string '${text}' was not in a correct format.`);
  return target === 'float' ? Math.fround(parsed as number) : parsed;
}

function boolNumber(value: boolean, target: SpecialType): Value {
  if (target === 'decimal') return value ? CsDecimal.ONE : CsDecimal.ZERO;
  if (target === 'long') return value ? 1n : 0n;
  return value ? 1 : 0;
}

function floatToInteger(number: number, target: SpecialType): Value {
  const rounded = roundEven(number);
  const [min, max] = integerRange(target);
  if (Number.isNaN(number) || rounded < Number(min) || rounded > Number(max)) overflowFor(target);
  return isBigIntKind(target) ? BigInt(rounded) : rounded;
}

function checkIntegerRange(integer: bigint, target: SpecialType): void {
  const [min, max] = integerRange(target);
  if (integer < min || integer > max) overflowFor(target);
}

function overflowFor(target: SpecialType): never {
  return fail('System.OverflowException', `Value was either too large or too small for ${OVERFLOW_NAMES[target]}.`);
}

/**
 * `Convert.ToInt32(text, fromBase)` and its kin, as .NET's `ParseNumbers` reads a string: an optional sign and `0x`,
 * digits up to the end, and for a base other than 10, the bits of an unsigned number that the type reinterprets.
 */
// code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of .NET's rule that the function applies.
// code-gauge-allow functionNcss -- Each branch handles one case of .NET's rule that the function applies.
function parseRadix(text: string, base: number, target: SpecialType): Value {
  if (![2, 8, 10, 16].includes(base)) fail('System.ArgumentException', 'Invalid Base.');
  if (text === '')
    fail(
      'System.ArgumentOutOfRangeException',
      'Specified argument was out of the range of valid values.',
      'Index was out of range. Must be non-negative and less than the size of the collection.'
    );
  let index = 0;
  const isNegative = text[0] === '-';
  if (isNegative && base !== 10)
    fail('System.ArgumentException', 'String cannot contain a minus sign if the base is not 10.');
  if (text[0] === '-' || text[0] === '+') index++;
  if (base === 16 && /^0[xX]/.test(text.slice(index))) index += 2;
  const digitPattern = {
    2: /^[01]+/,
    8: /^[0-7]+/,
    10: /^\d+/,
    16: /^[\dA-Fa-f]+/,
  }[base as 2 | 8 | 10 | 16];
  const digits = digitPattern.exec(text.slice(index))?.[0];
  if (digits === undefined) fail('System.FormatException', 'Could not find any recognizable digits.');
  if (index + digits.length < text.length)
    fail('System.FormatException', 'Additional non-parsable characters are at the end of the string.');
  const prefix = { 2: '0b', 8: '0o', 10: '', 16: '0x' }[base as 2 | 8 | 10 | 16];
  const magnitude = BigInt(`${prefix}${digits}`);
  const bits = target === 'long' ? 64 : 32;
  if (base !== 10) {
    // The digits make an unsigned number of the parse's width, which a narrower type must hold as unsigned.
    if (magnitude >= 1n << BigInt(bits)) overflowFor(target === 'long' ? 'ulong' : 'uint');
    const narrow = { short: 16, byte: 8, sbyte: 8 }[target as 'short' | 'byte' | 'sbyte'];
    if (narrow !== undefined && magnitude >= 1n << BigInt(narrow)) overflowFor(target);
    const value = target === 'byte' ? magnitude : BigInt.asIntN(narrow ?? bits, magnitude);
    return target === 'long' ? value : Number(value);
  }
  if (isNegative && target === 'byte')
    fail(
      'System.OverflowException',
      'The string was being parsed as an unsigned number and could not have a negative sign.'
    );
  const value = isNegative ? -magnitude : magnitude;
  checkIntegerRange(value, target);
  return target === 'long' ? value : Number(value);
}

// ---- Console and TextWriter ----

/** Writes what `Write` and `WriteLine` print for their argument types and composite formats. */
/** The text that a `Write` overload writes for its arguments, as Console and TextWriter format it. */
export function writeText(call: NativeCall, args: Value[]): string {
  const parameters = call.method.parameters;
  if (args.length === 0) return '';
  if (parameters.length >= 2 && specialOf(parameters[0].type) === 'string' && parameters[0].name === 'format') {
    const formatArgs = parameters.at(-1)?.isParams
      ? [...args.slice(1, -1), ...arrayValues(args.at(-1) as Value)]
      : args.slice(1);
    return compositeFormat(
      call,
      args[0] as string,
      formatArgs.map((value, index) => ({
        value,
        type:
          index < parameters.length - 1 && !parameters[index + 1].isParams
            ? parameterType(call, index + 1)
            : libraryType(call, 'System.Object'),
      }))
    );
  }
  if (parameters[0].type.kind === 'array' && parameters.length === 3) return bufferRangeText(call, args);
  if (parameters[0].type.kind === 'array') return args[0] === undefined ? '' : textOfChars((args[0] as CsArray).values);
  return textOf(call, args[0], parameterType(call, 0));
}

/** The text of `Write(char[] buffer, int index, int count)`. */
function bufferRangeText(call: NativeCall, args: Value[]): string {
  const buffer = args[0] as CsArray;
  const [index, count] = [args[1] as number, args[2] as number];
  if (buffer === undefined) failNull('buffer');
  if (index < 0) failNegative(call, 'index', index);
  if (count < 0) failNegative(call, 'count', count);
  if (buffer.values.length - index < count)
    fail(
      'System.ArgumentException',
      'Offset and length were out of bounds for the array or count is greater than the number of elements from index to the end of the source collection.'
    );
  return textOfChars(buffer.values.slice(index, index + count));
}

function textOfChars(chars: readonly Value[]): string {
  return chars.map((char) => String.fromCharCode(char as number)).join('');
}

/** Formats a composite format string with its arguments, as `string.Format` and `Console.WriteLine` do. */
export function compositeFormat(
  call: NativeCall,
  format: string | undefined,
  args: { value: Value; type: Type }[]
): string {
  if (format === undefined) failNull('format');
  const evaluator = evaluatorOf(call);
  const text = new MeteredText(call.frame.runtime);
  text.read(format.length);
  for (const part of parseFormat(format)) {
    if (typeof part === 'string') {
      text.append(part);
      continue;
    }
    const arg = args[part.index];
    if (!arg) throw FORMAT_INDEX();
    text.append(evaluator.formatHole(arg.value, arg.type, part.format, part.alignment, call.frame));
  }
  return text.toString();
}

import { FORMAT_INDEX_ERROR as FORMAT_INDEX, parseCompositeFormat as parseFormat } from '../format';

const writers =
  (stream: 'stdout' | 'stderr', newline: boolean): NativeMethod =>
  (call, _receiver, args) => {
    const text = writeText(call, args as Value[]) + (newline ? '\n' : '');
    call.frame.runtime.io[stream].write(text);
    return;
  };

defineNatives({
  'System.Console.Write': writers('stdout', false),
  'System.Console.WriteLine': writers('stdout', true),
  'System.Environment.Exit': (_call, _receiver, [code]) => {
    throw new ProgramExit(code as number);
  },
});

// .NET's new line on Unix is the literal "\n", which is interned.
defineNativesKeepingStrings({
  'System.IO.TextWriter.get_NewLine': () => '\n',
  'System.Environment.get_NewLine': () => '\n',
});

// ---- Exceptions ----

// code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
const exceptionConstructor: NativeMethod = (call, receiver, args) => {
  const exception = receiver as CsObject;
  const parameters = call.method.parameters.map((parameter) => parameter.name);
  const state: ExceptionState = {
    message: undefined,
    inner: undefined,
    wasThrown: false,
  };
  for (const [index, name] of parameters.entries()) {
    const value = args[index] as Value;
    if (name === 'message' && isString(value)) {
      state.message = stringText(value);
      state.messageString = value;
    }
    if (name === 'innerException') state.inner = value as CsObject | undefined;
    if (name === 'fileName' && isString(value)) state.fileName = stringText(value);
    if (name === 'paramName' && isString(value)) {
      state.paramName = stringText(value);
      state.paramNameString = value;
    }
    if (name === 'actualValue') {
      call.frame.runtime.retainSlots(0, [value as Value]);
      state.actualObject = value;
      state.actualValue = value === undefined ? undefined : textOf(call, value, libraryType(call, 'System.Object'));
    }
  }
  if (state.message === undefined && parameters.includes('paramName') && !parameters.includes('message')) {
    state.message = defaultMessage(
      exception.type.symbol.fullName === 'System.ArgumentNullException'
        ? exception.type
        : (call.method.owner.declaredType as NamedType)
    );
  }
  exception.native = state;
  return;
};

/**
 * `Message`, which returns the stored message itself, and a new string when it makes one from the type's default
 * message or adds the parameter name or the actual value.
 */
function messageString(exception: CsObject): string | CsString {
  const state = exception.native as ExceptionState;
  const text = exceptionMessage(exception);
  if (state.message === undefined || text !== state.message) return freshString(text);
  state.messageString ??= freshString(text);
  return state.messageString;
}

defineNativesKeepingStrings({
  'System.Exception..ctor': exceptionConstructor,
  'System.Exception.get_Message': (_call, receiver) => messageString(receiver as CsObject),
  'System.ArgumentException.get_Message': (_call, receiver) => messageString(receiver as CsObject),
  'System.ArgumentOutOfRangeException.get_Message': (_call, receiver) => messageString(receiver as CsObject),
  'System.ArgumentException.get_ParamName': (_call, receiver) => {
    const state = (receiver as CsObject).native as ExceptionState;
    return state.paramNameString ?? state.paramName;
  },
});

defineNatives({
  'System.ArgumentOutOfRangeException.get_ActualValue': (_call, receiver) => {
    const state = (receiver as CsObject).native as ExceptionState;
    return state.actualObject ?? state.actualValue;
  },
  'System.Exception.get_InnerException': (_call, receiver) => ((receiver as CsObject).native as ExceptionState).inner,
  'System.Exception.ToString': (call, receiver) => exceptionText(evaluatorOf(call), receiver as CsObject),
  'System.Exception.GetBaseException': (_call, receiver) => {
    let current = receiver as CsObject;
    while ((current.native as ExceptionState).inner) current = (current.native as ExceptionState).inner as CsObject;
    return current;
  },
  'System.ArgumentNullException.ThrowIfNull': (_call, _receiver, [value, name]) => {
    if (value === undefined) failNull((name as string | undefined) ?? 'argument');
    return;
  },
  'System.ArgumentException.ThrowIfNullOrEmpty': (_call, _receiver, [value, name]) => {
    if (value === undefined) failNull((name as string | undefined) ?? 'argument');
    if (value === '')
      fail(
        'System.ArgumentException',
        'The value cannot be an empty string.',
        (name as string | undefined) ?? 'argument'
      );
    return;
  },
  'System.ArgumentException.ThrowIfNullOrWhiteSpace': (_call, _receiver, [value, name]) => {
    if (value === undefined) failNull((name as string | undefined) ?? 'argument');
    if ((value as string).trim() === '')
      fail(
        'System.ArgumentException',
        'The value cannot be an empty string or composed entirely of whitespace.',
        (name as string | undefined) ?? 'argument'
      );
    return;
  },
});
const OUT_OF_RANGE_CHECKS: [string, (value: number) => boolean, string][] = [
  ['ThrowIfNegative', (value) => value < 0, 'a non-negative value'],
  ['ThrowIfZero', (value) => value === 0, 'a non-zero value'],
  ['ThrowIfNegativeOrZero', (value) => value <= 0, 'a non-negative and non-zero value'],
];
for (const [name, isOutOfRange, requirement] of OUT_OF_RANGE_CHECKS) {
  defineNatives({
    [`System.ArgumentOutOfRangeException.${name}`]: (call, _receiver, [value, param]) => {
      const paramName = (param as string | undefined) ?? 'value';
      if (isOutOfRange(value as number))
        failOutOfRange(call, paramName, `${paramName} ('${String(value)}') must be ${requirement}.`, String(value));
      return;
    },
  });
}
defineNatives({
  'System.ArgumentOutOfRangeException.ThrowIfGreaterThan': (call, _receiver, [value, other, param]) => {
    if ((value as number) > (other as number))
      failOutOfRange(
        call,
        (param as string | undefined) ?? 'value',
        `${(param as string) ?? 'value'} ('${String(value)}') must be less than or equal to '${String(other)}'.`,
        String(value)
      );
    return;
  },
  'System.ArgumentOutOfRangeException.ThrowIfLessThan': (call, _receiver, [value, other, param]) => {
    if ((value as number) < (other as number))
      failOutOfRange(
        call,
        (param as string | undefined) ?? 'value',
        `${(param as string) ?? 'value'} ('${String(value)}') must be greater than or equal to '${String(other)}'.`,
        String(value)
      );
    return;
  },
});

// ---- Tuples ----

const tupleNatives: Record<string, NativeMethod> = {};

/**
 * The items of a `Tuple`, charged as storage that keeps them, which the turtle collector reaches through `references` as
 * it does other native state.
 */
function tupleItems(call: NativeCall, values: Value[]): Value[] {
  call.frame.runtime.retainSlots(values.length, values);
  const items = values.map((value) => copyValue(value));
  return Object.assign(items, { references: () => items });
}
for (let arity = 1; arity <= MAX_TUPLE_ARITY; arity++) {
  const name = `System.ValueTuple\`${arity}`;
  tupleNatives[`${name}..ctor`] = (_call, receiver, args) => {
    const tuple = receiver as CsStruct;
    for (const [index, value] of args.entries()) tuple.fields[index] = value as Value;
    return;
  };
  tupleNatives[`${name}.ToString`] = (call, receiver) => tupleText(evaluatorOf(call), receiver as CsStruct, call.frame);
  tupleNatives[`${name}.Equals`] = (call, receiver, [other]) =>
    structEquals(evaluatorOf(call), receiver as CsStruct, other as Value, call.frame);
  tupleNatives[`${name}.GetHashCode`] = (call, receiver) =>
    structHash(evaluatorOf(call), receiver as CsStruct, call.frame);
  tupleNatives[`${name}.CompareTo`] = (call, receiver, [other]) => {
    const evaluator = evaluatorOf(call);
    const b = (other as CsStruct).fields;
    for (const [index, value] of (receiver as CsStruct).fields.entries()) {
      const order = defaultCompare(evaluator, value, b[index], call.frame);
      if (order !== 0) return order;
    }
    return 0;
  };
}
tupleNatives['System.ValueTuple.Create'] = (call, _receiver, args) =>
  new CsStruct(
    namedType((call.method.returnType as NamedType).symbol, call.typeArgs),
    (args as Value[]).map((value) => copyValue(value))
  );
for (const arity of [2, 3]) {
  const name = `System.Tuple\`${arity}`;
  tupleNatives[`${name}..ctor`] = (call, receiver, args) => {
    (receiver as CsObject).native = tupleItems(call, args as Value[]);
    return;
  };
  for (let index = 1; index <= arity; index++)
    tupleNatives[`${name}.get_Item${index}`] = (_call, receiver) =>
      ((receiver as CsObject).native as Value[])[index - 1];
  tupleNatives[`${name}.ToString`] = (call, receiver) => {
    const values = (receiver as CsObject).native as Value[];
    const type = (receiver as CsObject).type;
    return `(${values.map((value, index) => textOf(call, value, type.args[index])).join(', ')})`;
  };
  tupleNatives[`${name}.Equals`] = (call, receiver, [other]) => {
    if (!(other instanceof CsObject) || !sameType(other.type, (receiver as CsObject).type)) return false;
    const a = (receiver as CsObject).native as Value[];
    const b = other.native as Value[];
    return a.every((value, index) => valuesEqual(evaluatorOf(call), value, b[index], call.frame));
  };
  tupleNatives[`${name}.GetHashCode`] = (call, receiver) => tupleHash(call, (receiver as CsObject).native as Value[]);
}
tupleNatives['System.TupleExtensions.ToTuple'] = (call, _receiver, [value]) => {
  const tuple = new CsObject(libraryType(call, 'System.Tuple', call.typeArgs), []);
  tuple.native = tupleItems(call, (value as CsStruct).fields);
  return tuple;
};
tupleNatives['System.TupleExtensions.ToValueTuple'] = (call, _receiver, [value]) => {
  if (value === undefined) nullReference();
  return new CsStruct(libraryType(call, 'System.ValueTuple', call.typeArgs), [
    ...((value as CsObject).native as Value[]),
  ]);
};
tupleNatives['System.Tuple.Create'] = (call, _receiver, args) => {
  const type = libraryType(call, 'System.Tuple', call.typeArgs);
  const tuple = new CsObject(type, []);
  tuple.native = tupleItems(call, args as Value[]);
  return tuple;
};
defineNatives(tupleNatives);

// ---- Delegates ----

defineNatives({
  'System.Delegate.Combine': (call, _receiver, [a, b]) => combineDelegates(call.frame.runtime, a as Value, b as Value),
  'System.Delegate.GetInvocationList': (call, receiver) => {
    const source = receiver as CsDelegate;
    return newArray(
      call,
      libraryType(call, 'System.Delegate'),
      source.entries.map((entry) => new CsDelegate(source.type, [entry]))
    );
  },
  // The arguments come as objects and the result goes back as one, so value types are unboxed and boxed across it.
  'System.Delegate.DynamicInvoke': (call, receiver, [args]) => {
    if (!(receiver instanceof CsDelegate)) return nullReference();
    const evaluator = evaluatorOf(call);
    const invoke = receiver.type.symbol.methods.find((method) => method.name === 'Invoke') as MethodSymbol;
    const substitution = substitutionOf(receiver.type);
    const values = args === undefined ? [] : arrayValues(args as Value);
    if (values.length !== invoke.parameters.length) fail('System.ArgumentException', 'Parameter count mismatch.');
    const adapted = values.map((value, index) =>
      evaluator.unbox(value, substitute(invoke.parameters[index].type, substitution))
    );
    const result = evaluator.invokeDelegate(call.frame, receiver, adapted, undefined);
    return invoke.returnType.kind === 'void'
      ? undefined
      : evaluator.box(result, substitute(invoke.returnType, substitution));
  },
  'System.Delegate.Equals': (_call, receiver, [other]) => receiver === other,
  'System.Delegate.GetHashCode': (call, receiver) => identityHash(call.frame.runtime, receiver),
});

// ---- Turtle ----

const turtleNatives: Record<string, NativeMethod> = {
  'Turtle..ctor': (call, receiver, args) => {
    const [x = 0, y = 0, color] = args as Value[];
    if (args.length === 3 && color === undefined) fail('System.InvalidOperationException', 'Invalid color: null');
    const created = call.frame.runtime.world.create(
      x as number,
      y as number,
      (color as string | undefined) ?? undefined
    );
    if ('error' in created) fail('System.InvalidOperationException', created.error);
    (receiver as CsObject).turtle = created;
    return;
  },
};
const turtleOperations: Record<keyof typeof TURTLE_METHOD_NAMES, NativeMethod> = {
  forward: (call, receiver) => move(call, receiver, 1),
  backward: (call, receiver) => move(call, receiver, -1),
  turnRight: (call, receiver) => turn(call, receiver, 1),
  turnLeft: (call, receiver) => turn(call, receiver, 3),
  canMoveForward: (call, receiver) => {
    call.frame.runtime.collectGarbage();
    return call.frame.runtime.world.canMoveForward(call.frame.runtime.turtleOf(receiver));
  },
  isFrontPainted: (call, receiver) => call.frame.runtime.world.isFrontPainted(call.frame.runtime.turtleOf(receiver)),
  remove: (call, receiver) => {
    const turtle = (receiver as CsObject).turtle;
    if (turtle) call.frame.runtime.world.remove(turtle);
    return;
  },
};
for (const [key, names] of Object.entries(TURTLE_METHOD_NAMES)) {
  for (const name of names)
    turtleNatives[`Turtle.${turtleMethodName(name)}`] = turtleOperations[key as keyof typeof TURTLE_METHOD_NAMES];
}
defineNatives(turtleNatives);

function move(call: NativeCall, receiver: Value, sign: number): Value {
  call.frame.runtime.spend();
  const error = call.frame.runtime.world.move(call.frame.runtime.turtleOf(receiver), sign);
  if (error) fail('System.InvalidOperationException', error);
  return undefined;
}

function turn(call: NativeCall, receiver: Value, quarters: number): Value {
  call.frame.runtime.spend();
  call.frame.runtime.world.turn(call.frame.runtime.turtleOf(receiver), quarters);
  return undefined;
}

export { compareCulture, defaultCompare, CsThrow };

function toBig(value: Value): bigint {
  return BigInt(unboxed(value) as number | bigint);
}

function tupleHash(call: NativeCall, values: Value[]): number {
  let hash = 17;
  for (const value of values) hash = Math.imul(hash, 31) + hashOf(evaluatorOf(call), value, call.frame);
  // oxlint-disable-next-line unicorn/prefer-math-trunc -- `| 0` wraps to 32 bits, which Math.trunc does not.
  return hash | 0;
}
