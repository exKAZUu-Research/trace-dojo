import { type Collections } from './builtinCollections';
import { stringify } from './builtins';
import { addConstructor, addMethod, newString, type Registry, requireString, text } from './builtinSupport';
import { type Frame, throwBuiltin } from './runtime';
import { BOOLEAN, CHAR, type ClassInfo, DOUBLE, FLOAT, INT, type JavaType, LONG, VOID } from './types';
import {
  charCodeOf,
  charToString,
  floatToShortestDouble,
  JavaArray,
  JavaObject,
  JavaString,
  type Value,
} from './values';

const CHAR_ARRAY: JavaType = { kind: 'array', element: CHAR };

export function defineText(
  registry: Registry,
  objectClass: ClassInfo,
  stringClass: ClassInfo,
  printStreamClass: ClassInfo,
  collections: Collections
): void {
  const objectType = objectClass.type;
  const stringType = stringClass.type;
  const objectArray: JavaType = { kind: 'array', element: objectType };
  defineStringBuilder(registry, objectClass, stringClass);
  defineStringExtras(stringClass, collections);
  const format = addMethod(
    stringClass,
    'format',
    [stringType, objectArray],
    stringType,
    true,
    (frame, _, [pattern, args]) =>
      newString(
        frame,
        formatText(frame, requireString(frame, pattern), (args as JavaArray | undefined)?.values ?? [undefined])
      )
  );
  format.isVarargs = true;
  const formatted = addMethod(stringClass, 'formatted', [objectArray], stringType, false, (frame, receiver, [args]) =>
    newString(frame, formatText(frame, text(receiver), (args as JavaArray | undefined)?.values ?? [undefined]))
  );
  formatted.isVarargs = true;
  for (const name of ['printf', 'format']) {
    const method = addMethod(
      printStreamClass,
      name,
      [stringType, objectArray],
      printStreamClass.type,
      false,
      (frame, receiver, [pattern, args]) => {
        frame.runtime.budget.print(
          formatText(frame, requireString(frame, pattern), (args as JavaArray | undefined)?.values ?? [undefined])
        );
        return receiver;
      }
    );
    method.isVarargs = true;
  }
}

function builderOf(receiver: Value): string {
  return (receiver as JavaObject).builder as string;
}

function setBuilder(frame: Frame, receiver: Value, value: string): Value {
  frame.runtime.allocateString(frame, value.length);
  (receiver as JavaObject).builder = value;
  return receiver;
}

function defineStringBuilder(registry: Registry, objectClass: ClassInfo, stringClass: ClassInfo): void {
  const stringType = stringClass.type;
  const cls = registry.define('StringBuilder', objectClass);
  cls.isFinal = true;
  const builderType = cls.type;
  addConstructor(cls, [], (_, receiver) => {
    (receiver as JavaObject).builder = '';
  });
  addConstructor(cls, [INT], (frame, receiver, [capacity]) => {
    if ((capacity as number) < 0) throwBuiltin(frame, 'NegativeArraySizeException', String(capacity as number));
    (receiver as JavaObject).builder = '';
  });
  addConstructor(cls, [stringType], (frame, receiver, [initial]) => {
    setBuilder(frame, receiver, requireString(frame, initial));
  });
  addConstructor(stringClass, [builderType], (frame, _, [builder]) => {
    if (!(builder instanceof JavaObject)) return throwBuiltin(frame, 'NullPointerException');
    return newString(frame, builderOf(builder));
  });
  for (const type of [stringType, CHAR, INT, LONG, DOUBLE, FLOAT, BOOLEAN, objectClass.type, CHAR_ARRAY]) {
    addMethod(cls, 'append', [type], builderType, false, (frame, receiver, [value]) => {
      const appended = type === CHAR_ARRAY ? arrayOfChars(frame, value) : stringify(frame, value, type);
      return setBuilder(frame, receiver, builderOf(receiver) + appended);
    });
    if (type === CHAR_ARRAY) continue;
    addMethod(cls, 'insert', [INT, type], builderType, false, (frame, receiver, [offset, value]) => {
      checkOffset(frame, offset as number, builderOf(receiver).length);
      return spliceBuilder(frame, receiver, offset as number, offset as number, stringify(frame, value, type));
    });
  }
  defineBuilderEdits(cls, stringType);
  defineBuilderQueries(cls, stringType);
}

/** The StringBuilder methods that change characters in place. */
function defineBuilderEdits(cls: ClassInfo, stringType: JavaType): void {
  const builderType = cls.type;
  addMethod(cls, 'setCharAt', [INT, CHAR], VOID, false, (frame, receiver, [index, code]) => {
    checkIndex(frame, index as number, builderOf(receiver).length);
    spliceBuilder(frame, receiver, index as number, (index as number) + 1, charToString(code as number));
  });
  addMethod(cls, 'deleteCharAt', [INT], builderType, false, (frame, receiver, [index]) => {
    checkIndex(frame, index as number, builderOf(receiver).length);
    return spliceBuilder(frame, receiver, index as number, (index as number) + 1, '');
  });
  addMethod(cls, 'delete', [INT, INT], builderType, false, (frame, receiver, [start, end]) => {
    const stop = Math.min(end as number, builderOf(receiver).length);
    checkSpan(frame, start as number, end as number, builderOf(receiver).length, (start as number) > stop);
    return spliceBuilder(frame, receiver, start as number, stop, '');
  });
  addMethod(
    cls,
    'replace',
    [INT, INT, stringType],
    builderType,
    false,
    (frame, receiver, [start, end, replacement]) => {
      const { length } = builderOf(receiver);
      checkSpan(
        frame,
        start as number,
        end as number,
        length,
        (start as number) > length || (start as number) > (end as number)
      );
      return spliceBuilder(
        frame,
        receiver,
        start as number,
        Math.min(end as number, length),
        requireString(frame, replacement)
      );
    }
  );
  addMethod(cls, 'reverse', [], builderType, false, (frame, receiver) =>
    // Reversing keeps surrogate pairs together, as StringBuilder.reverse does.
    // oxlint-disable-next-line typescript/no-misused-spread -- Splitting into code points is what keeps the pairs.
    setBuilder(frame, receiver, [...builderOf(receiver)].toReversed().join(''))
  );
  addMethod(cls, 'setLength', [INT], VOID, false, (frame, receiver, [length]) => {
    if ((length as number) < 0) {
      throwBuiltin(frame, 'StringIndexOutOfBoundsException', `String index out of range: ${length as number}`);
    }
    setBuilder(
      frame,
      receiver,
      builderOf(receiver)
        .slice(0, length as number)
        .padEnd(length as number, '\0')
    );
  });
}

/** The StringBuilder methods that read its characters. */
function defineBuilderQueries(cls: ClassInfo, stringType: JavaType): void {
  addMethod(cls, 'toString', [], stringType, false, (frame, receiver) => newString(frame, builderOf(receiver)));
  addMethod(cls, 'length', [], INT, false, (_, receiver) => builderOf(receiver).length);
  addMethod(cls, 'isEmpty', [], BOOLEAN, false, (_, receiver) => builderOf(receiver).length === 0);
  addMethod(cls, 'charAt', [INT], CHAR, false, (frame, receiver, [index]) => {
    checkIndex(frame, index as number, builderOf(receiver).length);
    return charCodeOf(builderOf(receiver), index as number);
  });
  addMethod(cls, 'indexOf', [stringType], INT, false, (frame, receiver, [pattern]) =>
    builderOf(receiver).indexOf(requireString(frame, pattern))
  );
  addMethod(cls, 'lastIndexOf', [stringType], INT, false, (frame, receiver, [pattern]) =>
    builderOf(receiver).lastIndexOf(requireString(frame, pattern))
  );
  for (const parameterTypes of [[INT], [INT, INT]]) {
    addMethod(cls, 'substring', parameterTypes, stringType, false, (frame, receiver, [begin, end]) => {
      const current = builderOf(receiver);
      const stop = end === undefined ? current.length : (end as number);
      checkRange(frame, begin as number, stop, current.length);
      return newString(frame, current.slice(begin as number, stop));
    });
  }
}

/** Replaces the characters from `start` to `end` with `inserted`. */
function spliceBuilder(frame: Frame, receiver: Value, start: number, end: number, inserted: string): Value {
  const current = builderOf(receiver);
  return setBuilder(frame, receiver, current.slice(0, start) + inserted + current.slice(end));
}

function checkSpan(frame: Frame, start: number, end: number, length: number, isInvalid: boolean): void {
  if (start < 0 || isInvalid)
    throwBuiltin(frame, 'StringIndexOutOfBoundsException', `start ${start}, end ${end}, length ${length}`);
}

function arrayOfChars(frame: Frame, value: Value): string {
  if (!(value instanceof JavaArray)) return throwBuiltin(frame, 'NullPointerException');
  return value.values.map((code) => charToString(code as number)).join('');
}

// code-gauge-allow functionNcss 45 -- One registration per String method, each charging the characters it reads.
function defineStringExtras(stringClass: ClassInfo, collections: Collections): void {
  const stringType = stringClass.type;
  const stringArray: JavaType = { kind: 'array', element: stringType };
  addMethod(stringClass, 'split', [stringType], stringArray, false, (frame, receiver, [regex]) =>
    splitText(frame, text(receiver), requireString(frame, regex), 0)
  );
  addMethod(stringClass, 'split', [stringType, INT], stringArray, false, (frame, receiver, [regex, limit]) =>
    splitText(frame, text(receiver), requireString(frame, regex), limit as number)
  );
  const join = addMethod(
    stringClass,
    'join',
    [stringType, stringArray],
    stringType,
    true,
    (frame, _, [delimiter, parts]) => joinText(frame, requireString(frame, delimiter), (parts as JavaArray).values)
  );
  join.isVarargs = true;
  addMethod(
    stringClass,
    'join',
    [
      stringType,
      {
        kind: 'class',
        cls: collections.iterableClass,
        args: [{ kind: 'wildcard', bound: stringType, isSuper: false }],
      },
    ],
    stringType,
    true,
    (frame, _, [delimiter, parts]) => {
      if (!(parts instanceof JavaObject)) return throwBuiltin(frame, 'NullPointerException');
      const items = parts.elements ?? parts.store?.ordered().map((entry) => entry.key) ?? [];
      return joinText(frame, requireString(frame, delimiter), items);
    }
  );
  addMethod(stringClass, 'replace', [CHAR, CHAR], stringType, false, (frame, receiver, [from, to]) =>
    newString(frame, text(receiver).replaceAll(charToString(from as number), charToString(to as number)))
  );
  addMethod(stringClass, 'replace', [stringType, stringType], stringType, false, (frame, receiver, [from, to]) => {
    frame.runtime.scanString(text(receiver).length);
    return newString(
      frame,
      text(receiver).replaceAll(requireString(frame, from), () => requireString(frame, to))
    );
  });
  addMethod(
    stringClass,
    'replaceAll',
    [stringType, stringType],
    stringType,
    false,
    (frame, receiver, [regex, replacement]) => {
      frame.runtime.scanString(text(receiver).length);
      const pattern = compileRegex(frame, requireString(frame, regex), 'g');
      return newString(frame, text(receiver).replace(pattern, javaReplacement(requireString(frame, replacement))));
    }
  );
  addMethod(stringClass, 'matches', [stringType], BOOLEAN, false, (frame, receiver, [regex]) => {
    frame.runtime.scanString(text(receiver).length);
    return compileRegex(frame, `^(?:${requireString(frame, regex)})$`, '').test(text(receiver));
  });
  addMethod(stringClass, 'lastIndexOf', [stringType], INT, false, (frame, receiver, [pattern]) => {
    frame.runtime.scanString(text(receiver).length);
    return text(receiver).lastIndexOf(requireString(frame, pattern));
  });
  addMethod(stringClass, 'lastIndexOf', [INT], INT, false, (frame, receiver, [code]) => {
    frame.runtime.scanString(text(receiver).length);
    return (code as number) < 0 || (code as number) > 0x10_ff_ff
      ? -1
      : text(receiver).lastIndexOf(String.fromCodePoint(code as number));
  });
  addMethod(stringClass, 'indexOf', [stringType, INT], INT, false, (frame, receiver, [pattern, from]) => {
    frame.runtime.scanString(text(receiver).length);
    return text(receiver).indexOf(requireString(frame, pattern), Math.max(from as number, 0));
  });
  addMethod(stringClass, 'indexOf', [INT, INT], INT, false, (frame, receiver, [code, from]) => {
    frame.runtime.scanString(text(receiver).length);
    if ((code as number) < 0 || (code as number) > 0x10_ff_ff) return -1;
    return text(receiver).indexOf(String.fromCodePoint(code as number), Math.max(from as number, 0));
  });
  addMethod(stringClass, 'strip', [], stringType, false, (frame, receiver) => newString(frame, text(receiver).trim()));
  addMethod(stringClass, 'isBlank', [], BOOLEAN, false, (_, receiver) => text(receiver).trim() === '');
  addMethod(stringClass, 'compareToIgnoreCase', [stringType], INT, false, (frame, receiver, [other]) => {
    const left = text(receiver).toUpperCase().toLowerCase();
    const right = requireString(frame, other).toUpperCase().toLowerCase();
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
      if (left[index] !== right[index]) return charCodeOf(left, index) - charCodeOf(right, index);
    }
    return left.length - right.length;
  });
  addMethod(stringClass, 'valueOf', [CHAR_ARRAY], stringType, true, (frame, _, [chars]) =>
    newString(frame, arrayOfChars(frame, chars))
  );
}

function compileRegex(frame: Frame, pattern: string, flags: string): RegExp {
  try {
    return new RegExp(pattern, flags);
  } catch {
    return throwBuiltin(frame, 'PatternSyntaxException', pattern);
  }
}

/** Converts Java's replacement syntax, where `$1` names a group and a backslash escapes, to JavaScript's. */
function javaReplacement(replacement: string): string {
  return replacement.replaceAll(/\\(.)|\$(\d)|\$/g, (_, escaped: string | undefined, group: string | undefined) => {
    if (escaped !== undefined) return escaped === '$' ? '$$' : escaped;
    return group === undefined ? '$$' : `$${group}`;
  });
}

/** Splits as `String.split` does: trailing empty strings go when `limit` is 0, and at most `limit` parts remain when positive. */
function splitText(frame: Frame, value: string, regex: string, limit: number): JavaArray {
  frame.runtime.scanString(value.length);
  const pattern = compileRegex(frame, regex, 'g');
  const parts: string[] = [];
  let start = 0;
  for (const match of value.matchAll(pattern)) {
    if (limit > 0 && parts.length === limit - 1) break;
    const index = match.index;
    // A zero-width match at the start produces no leading empty string.
    if (match[0].length === 0 && (index === 0 || index >= value.length)) continue;
    parts.push(value.slice(start, index));
    start = index + match[0].length;
  }
  parts.push(value.slice(start));
  if (limit === 0) while (parts.length > 1 && parts.at(-1) === '') parts.pop();
  if (limit === 0 && parts.length === 1 && parts[0] === '' && value.length > 0) parts.pop();
  frame.runtime.allocateArray(frame, parts.length);
  return new JavaArray(
    frame.runtime.builtins.stringClass.type,
    parts.map((part) => new JavaString(part))
  );
}

function joinText(frame: Frame, delimiter: string, parts: Value[]): JavaString {
  const texts = parts.map((part) => (part instanceof JavaString ? part.value : 'null'));
  return newString(frame, texts.join(delimiter));
}

function checkIndex(frame: Frame, index: number, length: number): void {
  if (index < 0 || index >= length) {
    throwBuiltin(frame, 'StringIndexOutOfBoundsException', `index ${index},length ${length}`);
  }
}

function checkOffset(frame: Frame, offset: number, length: number): void {
  if (offset < 0 || offset > length)
    throwBuiltin(frame, 'StringIndexOutOfBoundsException', `offset ${offset}, length ${length}`);
}

function checkRange(frame: Frame, begin: number, end: number, length: number): void {
  if (begin < 0 || end > length || begin > end) {
    throwBuiltin(frame, 'StringIndexOutOfBoundsException', `start ${begin}, end ${end}, length ${length}`);
  }
}

const SPECIFIER = /%(\d+\$)?([-#+ 0,(]*)(\d+)?(\.\d+)?([a-zA-Z%])/g;

/** Formats as `String.format` does for the conversions learners use: d, s, f, e, x, o, c, b, n, and %. */
export function formatText(frame: Frame, pattern: string, args: Value[]): string {
  let nextArg = 0;
  frame.runtime.scanString(pattern.length);
  const result = pattern.replaceAll(
    SPECIFIER,
    (
      specifier,
      index: string | undefined,
      flags: string,
      width: string | undefined,
      precision: string | undefined,
      conversion: string
    ) => {
      if (conversion === 'n') return '\n';
      if (conversion === '%') return pad('%', flags, width);
      const position = index ? Number(index.slice(0, -1)) - 1 : nextArg++;
      if (position >= args.length)
        throwBuiltin(frame, 'MissingFormatArgumentException', `Format specifier '${specifier}'`);
      const formatted = formatArgument(
        frame,
        args[position],
        flags,
        precision ? Number(precision.slice(1)) : undefined,
        conversion
      );
      return pad(formatted, flags, width);
    }
  );
  // A lone % that starts no specifier is an error in Java.
  if (pattern.replaceAll(SPECIFIER, '').includes('%')) {
    throwBuiltin(frame, 'UnknownFormatConversionException', "Conversion = '%'");
  }
  return result;
}

function pad(text: string, flags: string, width: string | undefined): string {
  if (!width) return text;
  const size = Number(width);
  if (flags.includes('-')) return text.padEnd(size);
  if (flags.includes('0') && /^[+-]?\d/.test(text)) {
    const sign = /^[+-]/.test(text) ? text[0] : '';
    return sign + text.slice(sign.length).padStart(size - sign.length, '0');
  }
  return text.padStart(size);
}

/** The kinds of boxed values that each numeric or character conversion accepts. */
const ACCEPTED_KINDS: Record<string, readonly string[]> = {
  c: ['char', 'int', 'byte', 'short'],
  d: ['int', 'long', 'short', 'byte'],
  x: ['int', 'long', 'short', 'byte'],
  o: ['int', 'long', 'short', 'byte'],
  f: ['double', 'float'],
  e: ['double', 'float'],
};

const INTEGER_BITS: Record<string, number> = { byte: 8, short: 16, int: 32, long: 64 };

function formatArgument(
  frame: Frame,
  arg: Value,
  flags: string,
  precision: number | undefined,
  conversion: string
): string {
  const lower = conversion.toLowerCase();
  const formatted = formatLower(frame, arg, flags, precision, lower, conversion);
  return conversion === lower ? formatted : formatted.toUpperCase();
}

function formatLower(
  frame: Frame,
  arg: Value,
  flags: string,
  precision: number | undefined,
  lower: string,
  conversion: string
): string {
  if (lower === 's') {
    const text = arg === undefined ? 'null' : stringify(frame, arg, { kind: 'null' });
    return precision === undefined ? text : text.slice(0, precision);
  }
  if (lower === 'b')
    return String(arg instanceof JavaObject && typeof arg.boxed === 'boolean' ? arg.boxed : arg !== undefined);
  const accepted = ACCEPTED_KINDS[lower] as readonly string[] | undefined;
  if (!accepted) return throwBuiltin(frame, 'UnknownFormatConversionException', `Conversion = '${conversion}'`);
  if (arg === undefined) return 'null';
  const kind = arg instanceof JavaObject ? arg.cls.unboxedType?.kind : undefined;
  if (!kind || !accepted.includes(kind)) {
    const typeName =
      arg instanceof JavaObject
        ? (frame.runtime.builtins.qualifiedNames.get(arg.cls) ?? arg.cls.name)
        : 'java.lang.String';
    return throwBuiltin(frame, 'IllegalFormatConversionException', `${conversion} != ${typeName}`);
  }
  const boxed = (arg as JavaObject).boxed as number | bigint;
  switch (lower) {
    case 'c': {
      return String.fromCodePoint(boxed as number);
    }
    case 'd': {
      return formatInteger(BigInt(boxed), flags);
    }
    case 'x':
    case 'o': {
      return BigInt.asUintN(INTEGER_BITS[kind], BigInt(boxed)).toString(lower === 'x' ? 16 : 8);
    }
    default: {
      const value = kind === 'float' ? floatToShortestDouble(boxed as number) : (boxed as number);
      return formatDecimal(value, precision ?? 6, lower, flags);
    }
  }
}

function withSign(digits: string, isNegative: boolean, flags: string): string {
  if (isNegative) return flags.includes('(') ? `(${digits})` : `-${digits}`;
  if (flags.includes('+')) return `+${digits}`;
  if (flags.includes(' ')) return ` ${digits}`;
  return digits;
}

function group(digits: string): string {
  return digits.replaceAll(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatInteger(value: bigint, flags: string): string {
  const magnitude = (value < 0n ? -value : value).toString();
  return withSign(flags.includes(',') ? group(magnitude) : magnitude, value < 0n, flags);
}

/**
 * Formats a double with `%f` or `%e`, rounding half up from the shortest decimal digits that `Double.toString` gives,
 * as Java's Formatter does.
 */
function formatDecimal(value: number, precision: number, conversion: string, flags: string): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return withSign('Infinity', value < 0, flags);
  const isNegative = value < 0 || Object.is(value, -0);
  const [mantissa, exponentText] = Math.abs(value).toExponential().split('e');
  const digits = mantissa.replace('.', '');
  const exponent = Number(exponentText);
  if (conversion === 'e') {
    const { digits: rounded, carried } = roundDigits(digits, precision + 1);
    const finalExponent = exponent + carried;
    const fraction = rounded.slice(1).padEnd(precision, '0');
    const body = `${rounded[0]}${precision > 0 ? `.${fraction}` : ''}e${finalExponent < 0 ? '-' : '+'}${String(Math.abs(finalExponent)).padStart(2, '0')}`;
    return withSign(body, isNegative, flags);
  }
  // Digits before the point number exponent + 1, which may be zero or negative for small values.
  const integerDigits = exponent + 1;
  const kept = integerDigits + precision;
  let integerPart: string;
  let fractionPart: string;
  if (kept < 0) {
    integerPart = '0';
    fractionPart = '0'.repeat(precision);
  } else {
    const padded = integerDigits <= 0 ? '0'.repeat(1 - integerDigits) + digits : digits;
    const shift = integerDigits <= 0 ? 1 : integerDigits;
    const { digits: rounded, carried } = roundDigits(padded, shift + precision);
    const all = rounded.padEnd(shift + precision, '0');
    const totalInteger = shift + carried;
    integerPart = all.slice(0, totalInteger).replace(/^0+(?=\d)/, '') || '0';
    fractionPart = all.slice(totalInteger, totalInteger + precision);
  }
  const integerText = flags.includes(',') ? group(integerPart) : integerPart;
  return withSign(
    precision > 0 ? `${integerText}.${fractionPart}` : integerText,
    isNegative && /[1-9]/.test(integerPart + fractionPart),
    flags
  );
}

/** Rounds a digit string half up to `count` digits, telling whether rounding added a leading digit. */
function roundDigits(digits: string, count: number): { digits: string; carried: number } {
  if (digits.length <= count) return { digits, carried: 0 };
  const kept = digits.slice(0, count).split('').map(Number);
  if (Number(digits[count]) >= 5) {
    let index = kept.length - 1;
    while (index >= 0 && kept[index] === 9) kept[index--] = 0;
    if (index < 0) return { digits: `1${kept.join('')}`, carried: 1 };
    kept[index]++;
  }
  return { digits: kept.join(''), carried: 0 };
}
