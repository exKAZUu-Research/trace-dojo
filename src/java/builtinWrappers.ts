import {
  addAbstractMethod,
  addConstant,
  addInterface,
  addMethod,
  addTypeParameters,
  defineInterface,
  newString,
  type Registry,
} from './builtinSupport';
import { type Frame, throwBuiltin } from './runtime';
import {
  BOOLEAN,
  BYTE,
  CHAR,
  type ClassInfo,
  type ClassType,
  DOUBLE,
  FLOAT,
  INT,
  type JavaType,
  LONG,
  type MethodInfo,
  type NumericKind,
  SHORT,
} from './types';
import {
  charToString,
  convertNumber,
  formatDouble,
  formatFloat,
  JavaObject,
  JavaString,
  toInt32,
  toInt64,
  type Value,
} from './values';

export type BoxableKind = NumericKind | 'boolean';

export interface Wrappers {
  /** The wrapper class of each primitive kind, such as `Integer` for `int`. */
  byKind: Map<BoxableKind, ClassInfo>;
  numberClass: ClassInfo;
  comparableClass: ClassInfo;
  /** `Comparable.compareTo`, which sorting and ordered collections call. */
  compareTo: MethodInfo;
}

const WRAPPER_NAMES: Record<BoxableKind, string> = {
  byte: 'Byte',
  short: 'Short',
  int: 'Integer',
  long: 'Long',
  float: 'Float',
  double: 'Double',
  char: 'Character',
  boolean: 'Boolean',
};

/** The boxes that `valueOf` returns for small values, shared by every run since boxes never change. */
const boxCache = new Map<string, JavaObject>();

/** Boxes a primitive value as `valueOf` does, reusing the cached boxes Java keeps for small values. */
export function box(frame: Frame | undefined, cls: ClassInfo, value: Value): JavaObject {
  const kind = cls.unboxedType?.kind as BoxableKind;
  const isCached =
    kind === 'boolean' ||
    (kind === 'char' && (value as number) <= 127) ||
    (['byte', 'short', 'int', 'long'].includes(kind) && Number(value) >= -128 && Number(value) <= 127);
  const key = `${kind}:${String(value as number | bigint | boolean)}`;
  if (isCached) {
    const cached = boxCache.get(key);
    if (cached) return cached;
  }
  const object = frame ? frame.runtime.allocateObject(frame, cls) : new JavaObject(cls);
  object.boxed = value as number | bigint | boolean;
  if (isCached) boxCache.set(key, object);
  return object;
}

/** Unboxes a wrapper object, throwing `NullPointerException` for null. */
export function unbox(frame: Frame, value: Value): Value {
  if (!(value instanceof JavaObject)) return throwBuiltin(frame, 'NullPointerException');
  return value.boxed;
}

export function defineWrappers(registry: Registry, objectClass: ClassInfo, stringType: JavaType): Wrappers {
  const comparableClass = defineInterface(registry, 'Comparable', 'java.lang');
  const [comparedType] = addTypeParameters(comparableClass, ['T'], objectClass.type);
  const compareTo = addAbstractMethod(comparableClass, 'compareTo', [comparedType], INT);
  const numberClass = registry.define('Number', objectClass);
  numberClass.isAbstract = true;
  for (const [name, type] of [
    ['byteValue', BYTE],
    ['shortValue', SHORT],
    ['intValue', INT],
    ['longValue', LONG],
    ['floatValue', FLOAT],
    ['doubleValue', DOUBLE],
  ] as const) {
    addMethod(numberClass, name, [], type, false, (_, receiver) =>
      convertNumber(
        (receiver as JavaObject).boxed,
        (receiver as JavaObject).cls.unboxedType?.kind as NumericKind,
        type.kind as NumericKind
      )
    );
  }
  const byKind = new Map<BoxableKind, ClassInfo>();
  for (const [kind, name] of Object.entries(WRAPPER_NAMES) as [BoxableKind, string][]) {
    const isNumber = kind !== 'char' && kind !== 'boolean';
    const cls = registry.define(name, isNumber ? numberClass : objectClass);
    cls.isFinal = true;
    cls.unboxedType = { kind } as JavaType;
    addInterface(cls, { kind: 'class', cls: comparableClass, args: [cls.type] });
    defineWrapperMembers(cls, kind, stringType, objectClass, compareTo);
    byKind.set(kind, cls);
  }
  defineIntegerMembers(byKind.get('int') as ClassInfo, stringType);
  defineLongMembers(byKind.get('long') as ClassInfo, stringType);
  defineDoubleMembers(byKind.get('double') as ClassInfo, stringType);
  defineCharacterMembers(byKind.get('char') as ClassInfo);
  defineBooleanMembers(byKind.get('boolean') as ClassInfo, stringType);
  return { byKind, numberClass, comparableClass, compareTo };
}

/** The members every wrapper has: boxing and unboxing, comparisons, and conversions to text. */
function defineWrapperMembers(
  cls: ClassInfo,
  kind: BoxableKind,
  stringType: JavaType,
  objectClass: ClassInfo,
  compareTo: MethodInfo
): void {
  const primitive = { kind } as JavaType;
  addMethod(cls, 'valueOf', [primitive], cls.type, true, (frame, _, [value]) => box(frame, cls, value));
  addMethod(cls, `${kind}Value`, [], primitive, false, (_, receiver) => valueOf(receiver));
  addMethod(cls, 'toString', [], stringType, false, (frame, receiver) =>
    newString(frame, formatPrimitive(valueOf(receiver), kind))
  );
  addMethod(cls, 'toString', [primitive], stringType, true, (frame, _, [value]) =>
    newString(frame, formatPrimitive(value, kind))
  );
  addMethod(cls, 'hashCode', [], INT, false, (_, receiver) => hashOf(valueOf(receiver), kind));
  addMethod(cls, 'hashCode', [primitive], INT, true, (_, __, [value]) => hashOf(value, kind));
  addMethod(
    cls,
    'equals',
    [objectClass.type],
    BOOLEAN,
    false,
    (_, receiver, [other]) =>
      other instanceof JavaObject && other.cls === cls && sameValue(valueOf(receiver), other.boxed)
  );
  addMethod(cls, 'compare', [primitive, primitive], INT, true, (_, __, [a, b]) => compareValues(a, b));
  const compare = addMethod(cls, 'compareTo', [cls.type], INT, false, (frame, receiver, [other]) =>
    compareValues(valueOf(receiver), unbox(frame, other))
  );
  compare.overrides = new Set([compareTo]);
}

function valueOf(receiver: Value): Value {
  return (receiver as JavaObject).boxed;
}

function formatPrimitive(value: Value, kind: BoxableKind): string {
  if (kind === 'double') return formatDouble(value as number);
  if (kind === 'float') return formatFloat(value as number);
  if (kind === 'char') return charToString(value as number);
  return String(value as number | bigint | boolean);
}

/** `Double.equals` and the like compare bits, so NaN equals itself and 0.0 differs from -0.0. */
function sameValue(a: Value, b: Value): boolean {
  return Object.is(a, b);
}

/** Compares as `Double.compare` does, ordering -0.0 before 0.0 and NaN after everything else. */
// code-gauge-allow functionCognitiveComplexity 23 -- Java's order puts -0.0 before 0.0 and NaN last, which takes one branch per case.
function compareValues(a: Value, b: Value): number {
  if (typeof a === 'boolean') return a === b ? 0 : a ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number' && (Number.isNaN(a) || Number.isNaN(b))) {
    return Number.isNaN(a) ? (Number.isNaN(b) ? 0 : 1) : -1;
  }
  if (a === b) return Object.is(a, -0) && Object.is(b, 0) ? -1 : Object.is(a, 0) && Object.is(b, -0) ? 1 : 0;
  return (a as number) < (b as number) ? -1 : 1;
}

const view = new DataView(new ArrayBuffer(8));

/** The hash code each wrapper's `hashCode` computes from its value. */
export function hashOf(value: Value, kind: BoxableKind): number {
  switch (kind) {
    case 'boolean': {
      return value ? 1231 : 1237;
    }
    case 'long': {
      const bits = BigInt.asUintN(64, value as bigint);
      return Number(BigInt.asIntN(32, bits ^ (bits >> 32n)));
    }
    case 'double': {
      view.setFloat64(0, Number.isNaN(value) ? Number.NaN : (value as number));
      return toInt32(view.getInt32(0) ^ view.getInt32(4));
    }
    case 'float': {
      view.setFloat32(0, Number.isNaN(value) ? Number.NaN : (value as number));
      return view.getInt32(0);
    }
    default: {
      return value as number;
    }
  }
}

function parseIntegral(frame: Frame, text: Value, bits: 32 | 64): bigint {
  const value = (text as JavaString | undefined)?.value;
  frame.runtime.scanString(value?.length ?? 0);
  const parsed = value !== undefined && /^[+-]?\d+$/.test(value) ? BigInt(value) : undefined;
  if (parsed === undefined || parsed !== BigInt.asIntN(bits, parsed)) {
    return throwBuiltin(
      frame,
      'NumberFormatException',
      value === undefined ? 'Cannot parse null string: null' : `For input string: "${value}"`
    );
  }
  return parsed;
}

function parseRadix(frame: Frame, text: Value, radix: number): number {
  const value = (text as JavaString | undefined)?.value;
  const digits = '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, Math.max(radix, 0));
  const isValid =
    value !== undefined && radix >= 2 && radix <= 36 && new RegExp(`^[+-]?[${digits}]+$`, 'i').test(value);
  const parsed = isValid ? Number.parseInt(value, radix) : Number.NaN;
  if (!isValid || parsed > 2_147_483_647 || parsed < -2_147_483_648) {
    return throwBuiltin(
      frame,
      'NumberFormatException',
      value === undefined
        ? 'Cannot parse null string: null'
        : `For input string: "${value}"${radix === 10 ? '' : ` under radix ${radix}`}`
    );
  }
  return parsed;
}

function defineIntegerMembers(integerClass: ClassInfo, stringType: JavaType): void {
  addConstant(integerClass, 'MAX_VALUE', INT, 2_147_483_647);
  addConstant(integerClass, 'MIN_VALUE', INT, -2_147_483_648);
  addMethod(integerClass, 'parseInt', [stringType], INT, true, (frame, _, [text]) =>
    Number(parseIntegral(frame, text, 32))
  );
  addMethod(integerClass, 'valueOf', [stringType], integerClass.type, true, (frame, _, [text]) =>
    box(frame, integerClass, Number(parseIntegral(frame, text, 32)))
  );
  addMethod(integerClass, 'parseInt', [stringType, INT], INT, true, (frame, _, [text, radix]) =>
    parseRadix(frame, text, radix as number)
  );
  addMethod(integerClass, 'toString', [INT, INT], stringType, true, (frame, _, [value, radix]) => {
    const base = (radix as number) >= 2 && (radix as number) <= 36 ? (radix as number) : 10;
    return newString(frame, (value as number).toString(base));
  });
  addMethod(integerClass, 'sum', [INT, INT], INT, true, (_, __, [a, b]) => toInt32((a as number) + (b as number)));
  addMethod(integerClass, 'max', [INT, INT], INT, true, (_, __, [a, b]) => Math.max(a as number, b as number));
  addMethod(integerClass, 'min', [INT, INT], INT, true, (_, __, [a, b]) => Math.min(a as number, b as number));
  for (const [name, radix] of [
    ['toBinaryString', 2],
    ['toOctalString', 8],
    ['toHexString', 16],
  ] as const) {
    addMethod(integerClass, name, [INT], stringType, true, (frame, _, [value]) =>
      newString(frame, ((value as number) >>> 0).toString(radix))
    );
  }
}

function defineLongMembers(longClass: ClassInfo, stringType: JavaType): void {
  addConstant(longClass, 'MAX_VALUE', LONG, 2n ** 63n - 1n);
  addConstant(longClass, 'MIN_VALUE', LONG, -(2n ** 63n));
  addMethod(longClass, 'parseLong', [stringType], LONG, true, (frame, _, [text]) => parseIntegral(frame, text, 64));
  addMethod(longClass, 'valueOf', [stringType], longClass.type, true, (frame, _, [text]) =>
    box(frame, longClass, parseIntegral(frame, text, 64))
  );
  addMethod(longClass, 'sum', [LONG, LONG], LONG, true, (_, __, [a, b]) => toInt64((a as bigint) + (b as bigint)));
}

function parseDouble(frame: Frame, text: Value): number {
  const value = (text as JavaString | undefined)?.value;
  if (value === undefined) return throwBuiltin(frame, 'NullPointerException');
  frame.runtime.scanString(value.length);
  const trimmed = value.trim();
  const isNumber = /^[+-]?(?:NaN|Infinity|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[fFdD]?)$/.test(trimmed);
  if (!isNumber) throwBuiltin(frame, 'NumberFormatException', `For input string: "${value}"`);
  return Number(trimmed.replace(/[fFdD]$/, ''));
}

function defineDoubleMembers(doubleClass: ClassInfo, stringType: JavaType): void {
  addConstant(doubleClass, 'MAX_VALUE', DOUBLE, Number.MAX_VALUE);
  addConstant(doubleClass, 'MIN_VALUE', DOUBLE, Number.MIN_VALUE);
  addConstant(doubleClass, 'POSITIVE_INFINITY', DOUBLE, Number.POSITIVE_INFINITY);
  addConstant(doubleClass, 'NEGATIVE_INFINITY', DOUBLE, Number.NEGATIVE_INFINITY);
  addConstant(doubleClass, 'NaN', DOUBLE, Number.NaN);
  addMethod(doubleClass, 'parseDouble', [stringType], DOUBLE, true, (frame, _, [text]) => parseDouble(frame, text));
  addMethod(doubleClass, 'valueOf', [stringType], doubleClass.type, true, (frame, _, [text]) =>
    box(frame, doubleClass, parseDouble(frame, text))
  );
  addMethod(doubleClass, 'isNaN', [DOUBLE], BOOLEAN, true, (_, __, [value]) => Number.isNaN(value));
  addMethod(doubleClass, 'isNaN', [], BOOLEAN, false, (_, receiver) => Number.isNaN((receiver as JavaObject).boxed));
  addMethod(doubleClass, 'sum', [DOUBLE, DOUBLE], DOUBLE, true, (_, __, [a, b]) => (a as number) + (b as number));
}

const CHARACTER_TESTS = {
  isDigit: /^\p{Nd}$/u,
  isLetter: /^\p{L}$/u,
  isLetterOrDigit: /^[\p{L}\p{Nd}]$/u,
  isAlphabetic: /^\p{Alphabetic}$/u,
  isUpperCase: /^\p{Lu}$/u,
  isLowerCase: /^\p{Ll}$/u,
  // oxlint-disable-next-line no-control-regex -- Character.isWhitespace accepts these control characters.
  isWhitespace: /^[\t\n\v\f\r\u001C-\u001F \u1680\u2000-\u2006\u2008-\u200A\u2028\u2029\u205F\u3000]$/u,
} as const;

function codePointToString(code: Value): string {
  const point = code as number;
  return point >= 0 && point <= 0x10_ff_ff ? String.fromCodePoint(point) : '';
}

function defineCharacterMembers(characterClass: ClassInfo): void {
  addConstant(characterClass, 'MAX_VALUE', CHAR, 0xff_ff);
  addConstant(characterClass, 'MIN_VALUE', CHAR, 0);
  // Each method takes a char or an int code point, as `str.chars()` gives.
  for (const type of [CHAR, INT]) {
    for (const [name, pattern] of Object.entries(CHARACTER_TESTS)) {
      addMethod(characterClass, name, [type], BOOLEAN, true, (_, __, [code]) => pattern.test(codePointToString(code)));
    }
    for (const [name, convert] of [
      ['toUpperCase', (text: string) => text.toUpperCase()],
      ['toLowerCase', (text: string) => text.toLowerCase()],
    ] as const) {
      addMethod(characterClass, name, [type], type, true, (_, __, [code]) => {
        const converted = convert(codePointToString(code));
        // A character whose case mapping takes several characters stays unchanged, as Character's methods leave it.
        return [...converted].length === 1 ? converted.codePointAt(0) : code;
      });
    }
  }
  addMethod(characterClass, 'getNumericValue', [CHAR], INT, true, (_, __, [code]) => {
    const character = charToString(code as number);
    if (/^\d$/.test(character)) return Number(character);
    if (/^[a-z]$/i.test(character)) return Number.parseInt(character, 36);
    return -1;
  });
}

function defineBooleanMembers(booleanClass: ClassInfo, stringType: JavaType): void {
  addMethod(booleanClass, 'logicalXor', [BOOLEAN, BOOLEAN], BOOLEAN, true, (_, __, [a, b]) => a !== b);
  addConstant(booleanClass, 'TRUE', booleanClass.type, box(undefined, booleanClass, true));
  addConstant(booleanClass, 'FALSE', booleanClass.type, box(undefined, booleanClass, false));
  addMethod(
    booleanClass,
    'parseBoolean',
    [stringType],
    BOOLEAN,
    true,
    (_, __, [text]) => text instanceof JavaString && text.value.toLowerCase() === 'true'
  );
}

/** The wrapper type of a primitive type, as boxing converts it. */
export function boxedTypeOf(wrappers: Wrappers, type: JavaType): ClassType | undefined {
  return wrappers.byKind.get(type.kind as BoxableKind)?.type as ClassType | undefined;
}
