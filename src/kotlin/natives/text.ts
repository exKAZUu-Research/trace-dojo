import { formatJava, type FormatValues } from '../../interpreter/javaFormatter';
import { parseHexFloat } from '../../java/hexFloat';
import { callFunction, runtimeClassOf } from '../dispatch';
import { float32FromText } from '../float32';
import { charToString, hashOf, stringOf } from '../format';
import { toInt32, UNSIGNED_NUMBER_KINDS } from '../operators';
import type { Frame } from '../runtime';
import { Boxed, KObject, UNIT, type Value } from '../values';
import {
  sequenceAll,
  sequenceContentEquals,
  sequenceFindAnyString,
  sequenceIndexOf,
  sequenceIndexOfAnyChar,
  sequenceIndexOfChar,
  sequenceLines,
  sequenceMatchesAt,
  sequenceRegionMatches,
  sequenceSplit,
} from './charSequences';
import { elementsOf, newList } from './collections';
import { compareStrings, reverseKeepingPairs, stringRangeError, substring } from './core';
import {
  compareJdkCase,
  foldJdkCodePoint,
  isJdkLowerCase,
  isJdkUpperCase,
  lowerJdkChar,
  titleJdkChar,
  titleJdkText,
  upperJdkChar,
} from './jdkCase';
import { isJdkDefined, isJdkDigit, isJdkLetter, isJdkLetterOrDigit } from './jdkCharacter';
import { defineNative, libraryClass, throwError } from './registry';
import { defineStringBuilders } from './stringBuilders';
import { textSearch } from './textSearch';

const TEXT = 'kotlin.text';
const LINE_ENDINGS = /\r\n|\n|\r/;

/** Removes the characters up to U+0020 at both ends, as `Double.parseDouble` trims its input. */
function trimControls(value: string): string {
  let start = 0;
  let end = value.length;
  // oxlint-disable-next-line unicorn/prefer-code-point -- Java compares UTF-16 code units.
  while (start < end && value.charCodeAt(start) <= 0x20) start++;
  // oxlint-disable-next-line unicorn/prefer-code-point -- Java compares UTF-16 code units.
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end--;
  return value.slice(start, end);
}

function text(value: Value): string {
  return value as string;
}

function result(frame: Frame, value: string): string {
  frame.runtime.allocateString(frame, value.length);
  return value;
}

/** Java's `Character.isWhitespace`, which `isBlank` and `trim` use, unlike JavaScript's `\s`. */
function isJavaWhitespace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    (code >= 0x1c && code <= 0x20) ||
    code === 0x16_80 ||
    (code >= 0x20_00 && code <= 0x20_06) ||
    (code >= 0x20_08 && code <= 0x20_0a) ||
    code === 0x20_28 ||
    code === 0x20_29 ||
    code === 0x20_5f ||
    code === 0x30_00
  );
}

/** Kotlin's `Char.isWhitespace`, which also counts the no-break spaces. */
function isKotlinWhitespace(code: number): boolean {
  return isJavaWhitespace(code) || code === 0xa0 || code === 0x20_07 || code === 0x20_2f;
}

function trimWith(value: string, start: boolean, end: boolean): string {
  const from = start ? leadingWhitespace(value) : 0;
  let to = value.length;
  // oxlint-disable-next-line unicorn/prefer-code-point -- Kotlin chars are UTF-16 code units.
  while (end && to > from && isKotlinWhitespace(value.charCodeAt(to - 1))) to--;
  return value.slice(from, to);
}

/** `String.toInt()`, whose errors are `NumberFormatException`s worded as Java's `Integer.parseInt` words them. */
function parseInteger(
  frame: Frame,
  value: string,
  radix: number,
  bits: 8 | 16 | 32 | 64,
  unsigned = false
): bigint | undefined {
  checkRadix(frame, radix);
  const negative = value.startsWith('-');
  const first = negative || value.startsWith('+') ? 1 : 0;
  if (first === value.length || (unsigned && negative)) return undefined;
  const base = BigInt(radix);
  const limit = (1n << BigInt(unsigned ? bits : bits - 1)) - (negative ? 0n : 1n);
  const beforeLast = limit / base;
  const lastDigit = Number(limit % base);
  let parsed = 0n;
  for (let index = first; index < value.length; index++) {
    if ((index - first) % 64 === 0) frame.runtime.spend();
    // oxlint-disable-next-line unicorn/prefer-code-point -- JVM integer parsing reads UTF-16 code units.
    const char = value.charCodeAt(index);
    const digit = digitInRadix(char, radix);
    if (digit === undefined || parsed > beforeLast || (parsed === beforeLast && digit > lastDigit)) return undefined;
    parsed = parsed * base + BigInt(digit);
  }
  return negative ? -parsed : parsed;
}

/** `Short.parseShort` and `Byte.parseByte`, which name a number out of their range differently from a malformed one. */
function parseNarrow(frame: Frame, value: string, bits: 8 | 16, radix = 10): number {
  const parsed = parseInteger(frame, value, radix, 32);
  if (parsed === undefined) return numberFormatError(frame, value, radix);
  if (BigInt.asIntN(bits, parsed) !== parsed)
    throwError(frame, 'java.lang.NumberFormatException', `Value out of range. Value:"${value}" Radix:${radix}`);
  return Number(parsed);
}

function parseNarrowOrNull(frame: Frame, value: string, kind: 'Byte' | 'Short', radix = 10): Boxed | undefined {
  const parsed = parseInteger(frame, value, radix, kind === 'Byte' ? 8 : 16);
  return parsed === undefined ? undefined : new Boxed(kind, Number(parsed));
}

function numberFormatError(frame: Frame, value: string, radix = 10): never {
  const suffix = radix === 10 ? '' : ` under radix ${radix}`;
  return throwError(frame, 'java.lang.NumberFormatException', `For input string: "${value}"${suffix}`);
}

/** The error of Java's `Double.parseDouble`, which names an empty string and a second decimal point. */
function doubleFormatError(frame: Frame, value: string): never {
  const trimmed = trimControls(value);
  if (trimmed === '') return throwError(frame, 'java.lang.NumberFormatException', 'empty String');
  if (/^[+-]?\d*\.\d*\./.test(trimmed)) return throwError(frame, 'java.lang.NumberFormatException', 'multiple points');
  return numberFormatError(frame, value);
}

/** `String.toDouble()`, which accepts Java's floating-point syntax, such as `1e3`, `1.5f`, and surrounding blanks. */
function parseFloating(value: string, asFloat = false): number | undefined {
  const trimmed = trimControls(value);
  if (/^[+-]?(NaN|Infinity)$/.test(trimmed)) return Number(trimmed);
  const hex = parseHexFloat(trimmed, asFloat ? 'float' : 'double');
  if (hex !== undefined) return hex;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)([eE][+-]?\d+)?[fFdD]?$/.test(trimmed)) return undefined;
  return asFloat ? float32FromText(trimmed) : Number(trimmed.replace(/[fFdD]$/, ''));
}

/** The natives of strings and characters, by signature without the package. */
type TextNative = (frame: Frame, receiver: Value, args: Value[]) => Value;

/** Case conversion, trimming, and substrings. */
const TEXT_CASE_AND_TRIM_NATIVES: Record<string, TextNative> = {
  'CharSequence.isBlank()': (frame, receiver) => sequenceAll(frame, receiver, isKotlinWhitespace),
  'CharSequence.hasTextAt(CharSequence, Int, Boolean)': (frame, receiver, [other, index, ignoreCase]) =>
    sequenceMatchesAt(frame, receiver, other, index as number, ignoreCase === true),
  'String.uppercase()': (frame, receiver) => result(frame, text(receiver).toUpperCase()),
  'String.lowercase()': (frame, receiver) => result(frame, text(receiver).toLowerCase()),
  'String.trim()': (frame, receiver) => result(frame, trimWith(text(receiver), true, true)),
  'String.trimStart()': (frame, receiver) => result(frame, trimWith(text(receiver), true, false)),
  'String.trimEnd()': (frame, receiver) => result(frame, trimWith(text(receiver), false, true)),
  'String.trimIndent()': (frame, receiver) => result(frame, trimIndent(text(receiver))),
  'String.trimMargin(String)': (frame, receiver, [prefix]) =>
    result(frame, trimMargin(frame, text(receiver), text(prefix))),
  'String.substring(Int)': (frame, receiver, [start]) =>
    substring(frame, text(receiver), start as number, text(receiver).length),
  'String.substring(Int, Int)': (frame, receiver, [start, end]) =>
    substring(frame, text(receiver), start as number, end as number),
  'String.startsWith(String, Boolean)': (frame, receiver, [prefix, ignoreCase]) =>
    textSearch(frame, text(receiver), text(prefix), ignoreCase === true).matchesAt(0),
  'String.endsWith(String, Boolean)': (frame, receiver, [suffix, ignoreCase]) =>
    textSearch(frame, text(receiver), text(suffix), ignoreCase === true).matchesAt(
      text(receiver).length - text(suffix).length
    ),
};

/** Searching, replacing, splitting, padding, and comparing. */
const TEXT_SEARCH_NATIVES: Record<string, TextNative> = {
  'CharSequence.contains(CharSequence)': (frame, receiver, [other]) =>
    sequenceIndexOf(frame, receiver, other, 0, false) !== -1,
  'CharSequence.contains(CharSequence, Boolean)': (frame, receiver, [other, ignoreCase]) =>
    sequenceIndexOf(frame, receiver, other, 0, ignoreCase === true) !== -1,
  'CharSequence.indexOf(String, Int, Boolean)': (frame, receiver, [other, start, ignoreCase]) =>
    sequenceIndexOf(frame, receiver, other, start as number, ignoreCase === true),
  'CharSequence.indexOf(Char, Int, Boolean)': (frame, receiver, [char, start, ignoreCase]) =>
    sequenceIndexOfChar(frame, receiver, char as number, start as number, ignoreCase === true),
  'CharSequence.lastIndexOf(String, Int, Boolean)': (frame, receiver, [other, start, ignoreCase]) =>
    sequenceIndexOf(frame, receiver, other, start as number, ignoreCase === true, true),
  'CharSequence.lastIndexOf(Char, Int, Boolean)': (frame, receiver, [char, start, ignoreCase]) =>
    sequenceIndexOfChar(frame, receiver, char as number, start as number, ignoreCase === true, true),
  'CharSequence.indexOfAny(CharArray, Int, Boolean)': (frame, receiver, [chars, start, ignoreCase]) =>
    sequenceIndexOfAnyChar(
      frame,
      receiver,
      (chars as KObject).items as number[],
      start as number,
      ignoreCase === true,
      false
    ),
  'CharSequence.lastIndexOfAny(CharArray, Int, Boolean)': (frame, receiver, [chars, start, ignoreCase]) =>
    sequenceIndexOfAnyChar(
      frame,
      receiver,
      (chars as KObject).items as number[],
      start as number,
      ignoreCase === true,
      true
    ),
  'CharSequence.indexOfAny(Collection<String>, Int, Boolean)': (frame, receiver, [strings, start, ignoreCase]) =>
    sequenceFindAnyString(
      frame,
      receiver,
      elementsOf(frame, strings).map(text),
      start as number,
      ignoreCase === true,
      false
    )?.index ?? -1,
  'CharSequence.lastIndexOfAny(Collection<String>, Int, Boolean)': (frame, receiver, [strings, start, ignoreCase]) =>
    sequenceFindAnyString(
      frame,
      receiver,
      elementsOf(frame, strings).map(text),
      start as number,
      ignoreCase === true,
      true
    )?.index ?? -1,
  'CharSequence.findAnyOf(Collection<String>, Int, Boolean)': (frame, receiver, [strings, start, ignoreCase]) =>
    delimiterPair(frame, receiver, strings, start as number, ignoreCase === true, false),
  'CharSequence.findLastAnyOf(Collection<String>, Int, Boolean)': (frame, receiver, [strings, start, ignoreCase]) =>
    delimiterPair(frame, receiver, strings, start as number, ignoreCase === true, true),
  'CharSequence.regionMatches(Int, CharSequence, Int, Int, Boolean)': (
    frame,
    receiver,
    [from, other, otherFrom, count, ignoreCase]
  ) =>
    sequenceRegionMatches(frame, receiver, other, {
      from: from as number,
      otherFrom: otherFrom as number,
      count: count as number,
      ignoreCase: ignoreCase === true,
    }),
  'CharSequence?.contentEquals(CharSequence?)': (frame, receiver, [other]) =>
    sequenceContentEquals(frame, receiver, other, false),
  'CharSequence?.contentEquals(CharSequence?, Boolean)': (frame, receiver, [other, ignoreCase]) =>
    sequenceContentEquals(frame, receiver, other, ignoreCase === true),
  'String.replace(String, String, Boolean)': (frame, receiver, [oldValue, newValue, ignoreCase]) =>
    replaceAll(frame, text(receiver), text(oldValue), text(newValue), ignoreCase === true),
  'String.replace(Char, Char, Boolean)': (frame, receiver, [oldChar, newChar, ignoreCase]) =>
    replaceAll(
      frame,
      text(receiver),
      charToString(oldChar as number),
      charToString(newChar as number),
      ignoreCase === true,
      true
    ),
  'String.replaceFirst(String, String, Boolean)': (frame, receiver, [oldValue, newValue, ignoreCase]) =>
    replaceFirst(frame, text(receiver), text(oldValue), text(newValue), ignoreCase === true),
  'String.replaceFirst(Char, Char, Boolean)': (frame, receiver, [oldChar, newChar, ignoreCase]) =>
    replaceFirst(
      frame,
      text(receiver),
      charToString(oldChar as number),
      charToString(newChar as number),
      ignoreCase === true,
      true
    ),
  'String.repeat(Int)': (frame, receiver, [count]) => {
    const times = count as number;
    if (times < 0)
      throwError(frame, 'java.lang.IllegalArgumentException', `Count 'n' must be non-negative, but was ${times}.`);
    const { length } = text(receiver);
    // Kotlin's repeat sizes its StringBuilder with `n * length` in Int arithmetic, which overflows for a long result.
    const capacity = toInt32(length * times);
    if (times > 1 && length > 1 && capacity < 0)
      throwError(frame, 'java.lang.NegativeArraySizeException', String(capacity));
    frame.runtime.allocateString(frame, length * times);
    return text(receiver).repeat(times);
  },
  'CharSequence.split(vararg String, Boolean, Int)': (frame, receiver, [delimiters, ignoreCase, limit]) =>
    splitSequence(frame, receiver, ((delimiters as KObject).items as Value[]).map(text), {
      ignoreCase: ignoreCase === true,
      byChar: false,
      limit: limit as number,
    }),
  'CharSequence.split(vararg Char, Boolean, Int)': (frame, receiver, [delimiters, ignoreCase, limit]) =>
    splitSequence(
      frame,
      receiver,
      ((delimiters as KObject).items as Value[]).map((char) => charToString(char as number)),
      { ignoreCase: ignoreCase === true, byChar: true, limit: limit as number }
    ),
  'CharSequence.lines()': (frame, receiver) =>
    newList(
      frame,
      'ArrayList',
      typeof receiver === 'string' ? receiver.split(LINE_ENDINGS) : sequenceLines(frame, receiver)
    ),
  'String.reversed()': (frame, receiver) => result(frame, reverseKeepingPairs(text(receiver))),
  'String(CharArray, Int, Int)': (frame, _receiver, [chars, offset, length]) =>
    stringFromChars(frame, (chars as KObject).items as number[], offset as number, length as number),
  'String.toCharArray()': (frame, receiver) => stringCharArray(frame, text(receiver), 0, text(receiver).length),
  'String.toCharArray(Int, Int)': (frame, receiver, [start, end]) =>
    stringCharArray(frame, text(receiver), start as number, end as number),
  'String.toCharArray(CharArray, Int, Int, Int)': (frame, receiver, [chars, offset, start, end]) =>
    copyStringChars(frame, text(receiver), chars as KObject, offset as number, start as number, end as number),
  'String.padStart(Int, Char)': (frame, receiver, [length, char]) => {
    if ((length as number) < 0)
      throwError(frame, 'java.lang.IllegalArgumentException', `Desired length ${length as number} is less than zero.`);
    // The padded text is charged before it is built, as its length may be far beyond the limit.
    frame.runtime.allocateString(frame, length as number);
    return text(receiver).padStart(length as number, charToString(char as number));
  },
  'String.padEnd(Int, Char)': (frame, receiver, [length, char]) => {
    if ((length as number) < 0)
      throwError(frame, 'java.lang.IllegalArgumentException', `Desired length ${length as number} is less than zero.`);
    // The padded text is charged before it is built, as its length may be far beyond the limit.
    frame.runtime.allocateString(frame, length as number);
    return text(receiver).padEnd(length as number, charToString(char as number));
  },
  'String?.equals(String?, Boolean)': (frame, receiver, [other, ignoreCase]) => {
    if (receiver === other) return true;
    if (receiver === undefined || other === undefined || ignoreCase !== true) return false;
    const left = text(receiver);
    const right = text(other);
    return left.length === right.length && textSearch(frame, left, right, true).matchesAt(0);
  },
  'String.compareTo(String, Boolean)': (frame, receiver, [other, ignoreCase]) => {
    const left = text(receiver);
    const right = text(other);
    if (ignoreCase !== true) return compareStrings(left, right);
    frame.runtime.spend(1 + Math.floor((left.length + right.length) / 64));
    return compareJdkCase(left, right);
  },
  'String.format(vararg Any?)': (frame, receiver, [args]) =>
    result(frame, formatText(frame, text(receiver), (args as KObject).items as Value[])),
  'String.format(Locale?, vararg Any?)': (frame, receiver, [, args]) =>
    result(frame, formatText(frame, text(receiver), (args as KObject).items as Value[])),
};

/** Removing and extracting the parts around a delimiter. */
const TEXT_EXTRACTION_NATIVES: Record<string, TextNative> = {
  'String.substringBefore(String, String)': (_frame, receiver, [delimiter, missing]) => {
    const index = text(receiver).indexOf(text(delimiter));
    return index === -1 ? missing : text(receiver).slice(0, index);
  },
  'String.substringAfter(String, String)': (_frame, receiver, [delimiter, missing]) => {
    const index = text(receiver).indexOf(text(delimiter));
    return index === -1 ? missing : text(receiver).slice(index + text(delimiter).length);
  },
  'String.substringBeforeLast(String, String)': (_frame, receiver, [delimiter, missing]) => {
    const index = text(receiver).lastIndexOf(text(delimiter));
    return index === -1 ? missing : text(receiver).slice(0, index);
  },
  'String.substringAfterLast(String, String)': (_frame, receiver, [delimiter, missing]) => {
    const index = text(receiver).lastIndexOf(text(delimiter));
    return index === -1 ? missing : text(receiver).slice(index + text(delimiter).length);
  },
};

/** Parsing numbers and booleans, worded as Java and Kotlin word their errors. */
const TEXT_PARSING_NATIVES: Record<string, TextNative> = {
  'String.toInt()': (frame, receiver) => {
    const parsed = parseInteger(frame, text(receiver), 10, 32);
    return parsed === undefined ? numberFormatError(frame, text(receiver)) : Number(parsed);
  },
  'String.toInt(Int)': (frame, receiver, [radix]) => {
    const parsed = parseInteger(frame, text(receiver), radix as number, 32);
    return parsed === undefined ? numberFormatError(frame, text(receiver), radix as number) : Number(parsed);
  },
  'String.toIntOrNull()': (frame, receiver) => {
    const parsed = parseInteger(frame, text(receiver), 10, 32);
    return parsed === undefined ? undefined : new Boxed('Int', Number(parsed));
  },
  'String.toIntOrNull(Int)': (frame, receiver, [radix]) => {
    const parsed = parseInteger(frame, text(receiver), radix as number, 32);
    return parsed === undefined ? undefined : new Boxed('Int', Number(parsed));
  },
  'String.toLong()': (frame, receiver) =>
    parseInteger(frame, text(receiver), 10, 64) ?? numberFormatError(frame, text(receiver)),
  'String.toLong(Int)': (frame, receiver, [radix]) =>
    parseInteger(frame, text(receiver), radix as number, 64) ??
    numberFormatError(frame, text(receiver), radix as number),
  'String.toLongOrNull(Int)': (frame, receiver, [radix]) => {
    const parsed = parseInteger(frame, text(receiver), radix as number, 64);
    return parsed === undefined ? undefined : new Boxed('Long', parsed);
  },
  'String.toShort()': (frame, receiver) => parseNarrow(frame, text(receiver), 16),
  'String.toShort(Int)': (frame, receiver, [radix]) => parseNarrow(frame, text(receiver), 16, radix as number),
  'String.toShortOrNull()': (frame, receiver) => parseNarrowOrNull(frame, text(receiver), 'Short'),
  'String.toShortOrNull(Int)': (frame, receiver, [radix]) =>
    parseNarrowOrNull(frame, text(receiver), 'Short', radix as number),
  'String.toByte()': (frame, receiver) => parseNarrow(frame, text(receiver), 8),
  'String.toByte(Int)': (frame, receiver, [radix]) => parseNarrow(frame, text(receiver), 8, radix as number),
  'String.toByteOrNull()': (frame, receiver) => parseNarrowOrNull(frame, text(receiver), 'Byte'),
  'String.toByteOrNull(Int)': (frame, receiver, [radix]) =>
    parseNarrowOrNull(frame, text(receiver), 'Byte', radix as number),
  'String.toLongOrNull()': (frame, receiver) => {
    const parsed = parseInteger(frame, text(receiver), 10, 64);
    return parsed === undefined ? undefined : new Boxed('Long', parsed);
  },
  'String.toDouble()': (frame, receiver) => parseFloating(text(receiver)) ?? doubleFormatError(frame, text(receiver)),
  'String.toDoubleOrNull()': (_frame, receiver) => {
    const parsed = parseFloating(text(receiver));
    return parsed === undefined ? undefined : new Boxed('Double', parsed);
  },
  'String.toFloat()': (frame, receiver) =>
    parseFloating(text(receiver), true) ?? doubleFormatError(frame, text(receiver)),
  'String.toFloatOrNull()': (_frame, receiver) => {
    const parsed = parseFloating(text(receiver), true);
    return parsed === undefined ? undefined : new Boxed('Float', parsed);
  },
  'String?.toBoolean()': (_frame, receiver) => typeof receiver === 'string' && receiver.toLowerCase() === 'true',
  'String.toBooleanStrict()': (frame, receiver) => {
    if (receiver === 'true') return true;
    if (receiver === 'false') return false;
    return throwError(
      frame,
      'java.lang.IllegalArgumentException',
      `The string doesn't represent a boolean value: ${text(receiver)}`
    );
  },
};

function capitalize(value: string): string {
  const first = value.charAt(0);
  const code = first.codePointAt(0) ?? 0;
  if (!isJdkLowerCase(code)) return value;
  const title = titleJdkChar(code);
  return (title === upperJdkChar(code) ? first.toUpperCase() : charToString(title)) + value.slice(1);
}

/** Characters, and the conversions between characters, numbers, and text. */
const CHAR_NATIVES: Record<string, TextNative> = {
  'String.capitalize()': (_frame, receiver) => capitalize(text(receiver)),
  'String.decapitalize()': (_frame, receiver) => text(receiver).charAt(0).toLowerCase() + text(receiver).slice(1),
  'Char.isDigit()': (_frame, receiver) => isJdkDigit(receiver as number),
  'Char.isLetter()': (_frame, receiver) => isJdkLetter(receiver as number),
  'Char.isLetterOrDigit()': (_frame, receiver) => isJdkLetterOrDigit(receiver as number),
  'Char.isWhitespace()': (_frame, receiver) => isKotlinWhitespace(receiver as number),
  'Char.isUpperCase()': (_frame, receiver) => isJdkUpperCase(receiver as number),
  'Char.isLowerCase()': (_frame, receiver) => isJdkLowerCase(receiver as number),
  'Char.equals(Char, Boolean)': (_frame, receiver, [other, ignoreCase]) =>
    receiver === other ||
    (ignoreCase === true && foldJdkCodePoint(receiver as number) === foldJdkCodePoint(other as number)),
  'Char.uppercaseChar()': (_frame, receiver) => upperJdkChar(receiver as number),
  'Char.lowercaseChar()': (_frame, receiver) => lowerJdkChar(receiver as number),
  'Char.toUpperCase()': (_frame, receiver) => upperJdkChar(receiver as number),
  'Char.toLowerCase()': (_frame, receiver) => lowerJdkChar(receiver as number),
  'Char.uppercase()': (_frame, receiver) => charToString(receiver as number).toUpperCase(),
  'Char.lowercase()': (_frame, receiver) => charToString(receiver as number).toLowerCase(),
  'Char.titlecase()': (_frame, receiver) => titleJdkText(receiver as number),
  'Char.titlecaseChar()': (_frame, receiver) => titleJdkChar(receiver as number),
  'Char.digitToInt()': (frame, receiver) => {
    const digit = digitOf(receiver as number);
    return (
      digit ??
      throwError(
        frame,
        'java.lang.IllegalArgumentException',
        `Char ${charToString(receiver as number)} is not a decimal digit`
      )
    );
  },
  'Char.digitToIntOrNull()': (_frame, receiver) => {
    const digit = digitOf(receiver as number);
    return digit === undefined ? undefined : new Boxed('Int', digit);
  },
  'Char.digitToInt(Int)': (frame, receiver, [radix]) =>
    digitInRadix(receiver as number, checkRadix(frame, radix as number)) ??
    throwError(
      frame,
      'java.lang.IllegalArgumentException',
      `Char ${charToString(receiver as number)} is not a digit in the given radix=${radix as number}`
    ),
  'Char.digitToIntOrNull(Int)': (frame, receiver, [radix]) => {
    const digit = digitInRadix(receiver as number, checkRadix(frame, radix as number));
    return digit === undefined ? undefined : new Boxed('Int', digit);
  },
  'Char.isDefined()': (_frame, receiver) => isJdkDefined(receiver as number),
  'Char.plus(String)': (frame, receiver, [other]) => result(frame, charToString(receiver as number) + text(other)),
  'Int.toString(Int)': (frame, receiver, [radix]) =>
    result(frame, (receiver as number).toString(checkRadix(frame, radix as number))),
  'Long.toString(Int)': (frame, receiver, [radix]) =>
    result(frame, (receiver as bigint).toString(checkRadix(frame, radix as number))),
  'Char(Int)': (frame, _receiver, [code]) => {
    const value = code as number;
    if (value < 0 || value > 0xff_ff)
      throwError(frame, 'java.lang.IllegalArgumentException', `Invalid Char code: ${value}`);
    return value;
  },
};

function defineStrings(): void {
  for (const natives of [
    TEXT_CASE_AND_TRIM_NATIVES,
    TEXT_SEARCH_NATIVES,
    TEXT_EXTRACTION_NATIVES,
    TEXT_PARSING_NATIVES,
    CHAR_NATIVES,
  ]) {
    for (const [signature, native] of Object.entries(natives)) defineNative(`${TEXT}.${signature}`, native);
  }
  defineUnsignedParsers();
}

function defineUnsignedParsers(): void {
  const widths = { UByte: 8, UShort: 16, UInt: 32, ULong: 64 } as const;
  for (const kind of UNSIGNED_NUMBER_KINDS) {
    const convert = kind === 'ULong' ? (value: bigint) => value : Number;
    const parse = (frame: Frame, value: Value, radix: Value): bigint | undefined =>
      parseInteger(frame, text(value), radix as number, widths[kind], true);
    defineNative(`${TEXT}.String.to${kind}(Int)`, (frame, receiver, [radix]) => {
      const value = parse(frame, receiver, radix);
      if (value !== undefined) return convert(value);
      return throwError(frame, 'java.lang.NumberFormatException', `Invalid number format: '${text(receiver)}'`);
    });
    defineNative(`${TEXT}.String.to${kind}OrNull(Int)`, (frame, receiver, [radix]) => {
      const value = parse(frame, receiver, radix);
      return value === undefined ? undefined : new Boxed(kind, convert(value));
    });
  }
}

function checkRadix(frame: Frame, radix: number): number {
  if (radix < 2 || radix > 36)
    throwError(frame, 'java.lang.IllegalArgumentException', `radix ${radix} was not in valid range 2..36`);
  return radix;
}

/**
 * The value of a decimal digit of any script, as Java's `Character.digit` gives it: Unicode puts each script's digits
 * zero to nine in a row, so a digit's value is its distance from the start of its row, modulo ten for adjacent rows.
 */
function digitOf(code: number): number | undefined {
  if (!isJdkDigit(code)) return undefined;
  let start = code;
  while (start > 0 && isJdkDigit(start - 1)) start--;
  return (code - start) % 10;
}

function digitInRadix(code: number, radix: number): number | undefined {
  const lowercase = code | 0x20;
  const asciiLetter = lowercase - 0x61;
  const fullwidthLetter = code >= 0xff_41 ? code - 0xff_41 : code - 0xff_21;
  const letter = asciiLetter >= 0 && asciiLetter < 26 ? asciiLetter : fullwidthLetter;
  const digit = digitOf(code) ?? (letter >= 0 && letter < 26 ? letter + 10 : radix);
  return digit < radix ? digit : undefined;
}

function replaceAll(
  frame: Frame,
  value: string,
  oldValue: string,
  replacement: string,
  ignoreCase: boolean,
  codeUnitsOnly = false
): string {
  const { indexOf } = textSearch(frame, value, oldValue, ignoreCase, codeUnitsOnly);
  frame.runtime.spend(1 + Math.floor((value.length + oldValue.length) / 64));
  let matchCount = 0;
  if (oldValue === '') matchCount = value.length + 1;
  else {
    for (let index = indexOf(0); index >= 0; index = indexOf(index + oldValue.length)) matchCount++;
  }
  if (matchCount === 0) return value;
  const length = value.length + matchCount * (replacement.length - oldValue.length);
  frame.runtime.allocateString(frame, length);
  if (oldValue === '' || !ignoreCase) return value.replaceAll(oldValue, () => replacement);
  const parts: string[] = [];
  let offset = 0;
  for (let index = indexOf(0); index >= 0; index = indexOf(offset)) {
    parts.push(value.slice(offset, index), replacement);
    offset = index + oldValue.length;
  }
  parts.push(value.slice(offset));
  return parts.join('');
}

function replaceFirst(
  frame: Frame,
  value: string,
  oldValue: string,
  replacement: string,
  ignoreCase: boolean,
  codeUnitsOnly = false
): string {
  frame.runtime.spend(1 + Math.floor((value.length + oldValue.length) / 64));
  const position = textSearch(frame, value, oldValue, ignoreCase, codeUnitsOnly).indexOf(0);
  if (position === -1) return value;
  frame.runtime.allocateString(frame, value.length - oldValue.length + replacement.length, value.length);
  return value.slice(0, position) + replacement + value.slice(position + oldValue.length);
}

function delimiterPair(
  frame: Frame,
  receiver: Value,
  strings: Value,
  from: number,
  ignoreCase: boolean,
  backwards: boolean
): Value {
  const match = sequenceFindAnyString(
    frame,
    receiver,
    elementsOf(frame, strings).map(text),
    from,
    ignoreCase,
    backwards
  );
  if (!match) return undefined;
  const constructor = libraryClass('kotlin.Pair').constructors[0];
  return callFunction(constructor, frame, undefined, [new Boxed('Int', match.index), match.delimiter], undefined);
}

function stringFromChars(frame: Frame, chars: number[], offset: number, length: number): string {
  if (offset < 0 || length < 0 || offset + length > chars.length) {
    throwError(
      frame,
      'java.lang.StringIndexOutOfBoundsException',
      `Range [${offset}, ${offset} + ${length}) out of bounds for length ${chars.length}`
    );
  }
  frame.runtime.allocateString(frame, length);
  return chars
    .slice(offset, offset + length)
    .map(charToString)
    .join('');
}

function stringCharArray(frame: Frame, value: string, from: number, to: number): KObject {
  if (from < 0 || to > value.length)
    throwError(
      frame,
      'java.lang.IndexOutOfBoundsException',
      `fromIndex: ${from}, toIndex: ${to}, size: ${value.length}`
    );
  if (from > to) throwError(frame, 'java.lang.IllegalArgumentException', `fromIndex: ${from} > toIndex: ${to}`);
  frame.runtime.allocate(frame, to - from);
  const array = new KObject(libraryClass('kotlin.CharArray'), 0);
  // oxlint-disable-next-line unicorn/prefer-code-point -- a Char array holds UTF-16 code units.
  array.items = Array.from({ length: to - from }, (_, index) => value.charCodeAt(from + index));
  return array;
}

function copyStringChars(
  frame: Frame,
  value: string,
  array: KObject,
  offset: number,
  from: number,
  to: number
): KObject {
  if (from < 0 || from > to || to > value.length) stringRangeError(frame, from, to, value.length);
  const chars = array.items as Value[];
  if (offset < 0 || offset > chars.length - (to - from))
    stringRangeError(frame, offset, offset + to - from, chars.length);
  for (let index = from; index < to; index++) {
    // oxlint-disable-next-line unicorn/prefer-code-point -- a Char array holds UTF-16 code units.
    chars[offset + index - from] = value.charCodeAt(index);
  }
  return array;
}

function splitSequence(
  frame: Frame,
  value: Value,
  delimiters: string[],
  options: { ignoreCase: boolean; byChar: boolean; limit: number }
): KObject {
  if (typeof value === 'string') {
    return splitText(frame, value, delimiters, { ...options, supplementary: !options.byChar });
  }
  const { singleton, parts } = sequenceSplit(frame, value, delimiters, options);
  return newList(frame, singleton ? 'SingletonList' : 'ArrayList', parts);
}

/** `split`, which splits at the first delimiter that matches at each position, keeping empty parts. */
// code-gauge-allow functionCognitiveComplexity 17 -- split result type depends on the delimiter family and the traversal result.
function splitText(
  frame: Frame,
  value: string,
  delimiters: string[],
  { ignoreCase, supplementary, limit }: { ignoreCase: boolean; supplementary: boolean; limit: number }
): KObject {
  if (limit < 0)
    throwError(frame, 'java.lang.IllegalArgumentException', `Limit must be non-negative, but was ${limit}`);
  const singleDelimiter = delimiters.length === 1 && delimiters[0] !== '';
  if (singleDelimiter && limit === 1) return newList(frame, 'SingletonList', [value]);
  if (singleDelimiter && !ignoreCase && limit === 0) {
    const parts = value.split(delimiters[0]);
    return newList(frame, parts.length === 1 ? 'SingletonList' : 'ArrayList', parts);
  }
  const matchers = delimiters.map((delimiter) => textSearch(frame, value, delimiter, ignoreCase, !supplementary));
  const parts: string[] = [];
  let start = 0;
  let index = 0;
  while (index <= value.length && (limit === 0 || parts.length < limit - 1)) {
    const matching = matchers.findIndex((matcher) => matcher.matchesAt(index));
    if (matching === -1) {
      index++;
      continue;
    }
    parts.push(value.slice(start, index));
    const { length } = delimiters[matching];
    start = index + length;
    index = start + (length === 0 ? 1 : 0);
  }
  parts.push(value.slice(start));
  return newList(frame, singleDelimiter && parts.length === 1 ? 'SingletonList' : 'ArrayList', parts);
}

function trimIndent(value: string): string {
  const lines = trimBlankEdges(value.split(LINE_ENDINGS));
  let indent = Infinity;
  for (const line of lines) {
    const size = leadingWhitespace(line);
    if (size < line.length) indent = Math.min(indent, size);
  }
  const common = indent === Infinity ? 0 : indent;
  return lines.map((line) => line.slice(common)).join('\n');
}

function trimMargin(frame: Frame, value: string, prefix: string): string {
  if (leadingWhitespace(prefix) === prefix.length) {
    return throwError(frame, 'java.lang.IllegalArgumentException', 'marginPrefix must be non-blank string.');
  }
  return trimBlankEdges(value.split(LINE_ENDINGS))
    .map((line) => {
      const start = leadingWhitespace(line);
      return line.startsWith(prefix, start) ? line.slice(start + prefix.length) : line;
    })
    .join('\n');
}

function trimBlankEdges(lines: string[]): string[] {
  const first = lines[0];
  const last = lines.at(-1) as string;
  return lines.slice(
    Number(leadingWhitespace(first) === first.length),
    lines.length - Number(leadingWhitespace(last) === last.length)
  );
}

function leadingWhitespace(line: string): number {
  let end = 0;
  // oxlint-disable-next-line unicorn/prefer-code-point -- Kotlin treats whitespace as UTF-16 chars.
  while (end < line.length && isKotlinWhitespace(line.charCodeAt(end))) end++;
  return end;
}

const JAVA_KINDS: Record<string, string> = {
  Int: 'int',
  Long: 'long',
  Short: 'short',
  Byte: 'byte',
  Double: 'double',
  Float: 'float',
  Char: 'char',
};

/** `String.format`, with Kotlin's values. */
export function formatText(frame: Frame, pattern: string, args: Value[], sink?: (text: string) => void): string {
  const values: FormatValues<Value> = {
    isNull: (value) => value === undefined,
    stringify: (value) => stringOf(frame, value),
    hash: (value) => hashOf(frame, value),
    booleanOf: (value) => (typeof value === 'boolean' ? value : value !== undefined),
    numberOf: (value) =>
      value instanceof Boxed && JAVA_KINDS[value.kind]
        ? { kind: JAVA_KINDS[value.kind], value: value.value }
        : undefined,
    typeName: (value) => runtimeClassOf(value).qualifiedName,
    fail: (name, message) => throwError(frame, `java.util.${name}`, message),
    scan: (length) => frame.runtime.spend(1 + Math.floor(length / 64)),
  };
  return formatJava(pattern, args, values, sink);
}

defineStrings();
defineStringBuilders();

defineNative(
  'java.lang.formatStream(Boolean, String, Array<out Any?>)',
  (frame, _receiver, [isError, pattern, args]) => {
    const stream = isError ? frame.runtime.io.stderr : frame.runtime.io.stdout;
    formatText(frame, text(pattern), (args as KObject).items as Value[], (part) => stream.write(part));
    return UNIT;
  }
);
