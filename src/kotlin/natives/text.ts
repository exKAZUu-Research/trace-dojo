// code-gauge-allow-file fileNcss 410 -- the text and character natives share string, casing, and parsing operations.
import { formatJava, type FormatValues } from '../../interpreter/javaFormatter';
import { callFunction, getPropertyValue, runtimeClassOf } from '../dispatch';
import { float32FromText } from '../float32';
import { charToString, formatPrimitive, hashOf, stringOf } from '../format';
import { toInt32 } from '../operators';
import type { Frame } from '../runtime';
import { Boxed, KObject, UNIT, type Value } from '../values';
import { newList } from './collections';
import { compareStrings, substring } from './core';
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
import { defineNative, defineNativeProperty, libraryClass, throwError } from './registry';
import { type TextSearch, textSearch } from './textSearch';

const TEXT = 'kotlin.text';
const LINE_ENDINGS = /\r\n|\n|\r/;

/** The UTF-16 code units of a string, which Kotlin's chars are. */
function codeUnits(value: string): number[] {
  // oxlint-disable-next-line unicorn/prefer-code-point -- Kotlin chars are UTF-16 code units.
  return Array.from({ length: value.length }, (_, index) => value.charCodeAt(index));
}

/** Reverses a string as `StringBuilder.reverse` does, which keeps each surrogate pair in order. */
function reverseKeepingPairs(value: string): string {
  // oxlint-disable-next-line typescript/no-misused-spread -- Spreading splits at code points, which keeps surrogate pairs together as Java does.
  return [...value].toReversed().join('');
}

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

export function sequenceText(frame: Frame, value: Value): string {
  if (typeof value === 'string') return value;
  if (value instanceof KObject && value.builder !== undefined) return value.builder;
  const owner = libraryClass('kotlin.CharSequence');
  const length = owner.members.get('length')?.find((member) => member.kind === 'property');
  const get = owner.members.get('get')?.find((member) => member.kind === 'function');
  if (!length || !get) throw new Error('Missing CharSequence members');
  const size = getPropertyValue(length, frame, value) as number;
  frame.runtime.allocateString(frame, size);
  const characters: string[] = [];
  for (let index = 0; index < size; index++) {
    characters.push(charToString(callFunction(get, frame, value, [index], undefined) as number));
  }
  return characters.join('');
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
function parseInteger(frame: Frame, value: string, radix: number, bits: 8 | 16 | 32 | 64): bigint | undefined {
  checkRadix(frame, radix);
  const negative = value.startsWith('-');
  const first = negative || value.startsWith('+') ? 1 : 0;
  if (first === value.length) return undefined;
  const base = BigInt(radix);
  const limit = (1n << BigInt(bits - 1)) - (negative ? 0n : 1n);
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
function parseNarrow(frame: Frame, value: string, bits: 8 | 16): number {
  const parsed = parseInteger(frame, value, 10, 32);
  if (parsed === undefined) return numberFormatError(frame, value);
  if (BigInt.asIntN(bits, parsed) !== parsed)
    throwError(frame, 'java.lang.NumberFormatException', `Value out of range. Value:"${value}" Radix:10`);
  return Number(parsed);
}

function search(frame: Frame, receiver: Value, target: string, ignoreCase: boolean, codeUnitsOnly = false): TextSearch {
  return textSearch(
    frame,
    sequenceText(frame, receiver),
    target,
    ignoreCase,
    codeUnitsOnly || typeof receiver !== 'string'
  );
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
  const hex = /^([+-]?)0[xX]([\dA-Fa-f]*)(?:\.([\dA-Fa-f]*))?[pP]([+-]?\d+)[fFdD]?$/.exec(trimmed);
  if (hex && (hex[2] || hex[3])) {
    if (asFloat) return float32FromText(trimmed);
    const [, sign, whole, fraction, exponent] = hex;
    const magnitude =
      Number.parseInt(`${whole}${fraction ?? ''}` || '0', 16) * 2 ** (Number(exponent) - 4 * (fraction?.length ?? 0));
    return sign === '-' ? -magnitude : magnitude;
  }
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)([eE][+-]?\d+)?[fFdD]?$/.test(trimmed)) return undefined;
  return asFloat ? float32FromText(trimmed) : Number(trimmed.replace(/[fFdD]$/, ''));
}

/** The natives of strings and characters, by signature without the package. */
type TextNative = (frame: Frame, receiver: Value, args: Value[]) => Value;

/** Case conversion, trimming, and substrings. */
const TEXT_CASE_AND_TRIM_NATIVES: Record<string, TextNative> = {
  'CharSequence.isBlank()': (frame, receiver) => codeUnits(sequenceText(frame, receiver)).every(isKotlinWhitespace),
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
    sequenceText(frame, receiver).includes(sequenceText(frame, other)),
  'CharSequence.contains(CharSequence, Boolean)': (frame, receiver, [other, ignoreCase]) =>
    search(frame, receiver, sequenceText(frame, other), ignoreCase === true, typeof other !== 'string').includes(),
  'CharSequence.indexOf(String, Int, Boolean)': (frame, receiver, [other, start, ignoreCase]) =>
    search(frame, receiver, text(other), ignoreCase === true).indexOf(Math.max(0, start as number)),
  'CharSequence.indexOf(Char, Int, Boolean)': (frame, receiver, [char, start, ignoreCase]) =>
    search(frame, receiver, charToString(char as number), ignoreCase === true, true).indexOf(
      Math.max(0, start as number)
    ),
  'CharSequence.lastIndexOf(String, Int, Boolean)': (frame, receiver, [other, start, ignoreCase]) =>
    search(frame, receiver, text(other), ignoreCase === true).lastIndexOf(start as number),
  'CharSequence.lastIndexOf(Char, Int, Boolean)': (frame, receiver, [char, start, ignoreCase]) =>
    search(frame, receiver, charToString(char as number), ignoreCase === true, true).lastIndexOf(start as number),
  'String.replace(String, String, Boolean)': (frame, receiver, [oldValue, newValue, ignoreCase]) =>
    replaceAll(frame, text(receiver), text(oldValue), text(newValue), ignoreCase === true),
  'String.replace(Char, Char)': (frame, receiver, [oldChar, newChar]) =>
    replaceAll(frame, text(receiver), charToString(oldChar as number), charToString(newChar as number), false),
  'String.replaceFirst(String, String)': (frame, receiver, [oldValue, newValue]) => {
    const value = text(receiver);
    const old = text(oldValue);
    const replacement = text(newValue);
    const position = value.indexOf(old);
    if (position === -1) return value;
    frame.runtime.allocateString(frame, value.length - old.length + replacement.length, value.length);
    return value.slice(0, position) + replacement + value.slice(position + old.length);
  },
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
    splitText(frame, sequenceText(frame, receiver), ((delimiters as KObject).items as Value[]).map(text), {
      ignoreCase: ignoreCase === true,
      supplementary: typeof receiver === 'string',
      limit: limit as number,
    }),
  'CharSequence.split(vararg Char, Boolean, Int)': (frame, receiver, [delimiters, ignoreCase, limit]) =>
    splitText(
      frame,
      sequenceText(frame, receiver),
      ((delimiters as KObject).items as Value[]).map((char) => charToString(char as number)),
      { ignoreCase: ignoreCase === true, supplementary: false, limit: limit as number }
    ),
  'CharSequence.lines()': (frame, receiver) =>
    newList(frame, 'ArrayList', sequenceText(frame, receiver).split(LINE_ENDINGS)),
  'String.reversed()': (frame, receiver) => result(frame, reverseKeepingPairs(text(receiver))),
  'String.toCharArray()': (frame, receiver) => {
    const array = new KObject(libraryClass('kotlin.CharArray'), 0);
    // oxlint-disable-next-line unicorn/prefer-code-point -- Kotlin chars are UTF-16 code units.
    array.items = Array.from({ length: text(receiver).length }, (_, index) => text(receiver).charCodeAt(index));
    frame.runtime.allocate(frame, array.items.length);
    return array;
  },
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
  'String.removePrefix(CharSequence)': (frame, receiver, [prefix]) => {
    const value = text(receiver);
    const start = sequenceText(frame, prefix);
    return value.startsWith(start) ? value.slice(start.length) : value;
  },
  'String.removeSuffix(CharSequence)': (frame, receiver, [suffix]) => {
    const value = text(receiver);
    const end = sequenceText(frame, suffix);
    return end.length > 0 && value.endsWith(end) ? value.slice(0, -end.length) : value;
  },
  'String.removeSurrounding(CharSequence)': (frame, receiver, [delimiter]) => {
    const value = text(receiver);
    const around = sequenceText(frame, delimiter);
    return value.length >= 2 * around.length && value.startsWith(around) && value.endsWith(around)
      ? value.slice(around.length, value.length - around.length)
      : value;
  },
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
  'String.toShortOrNull()': (frame, receiver) => {
    const parsed = parseInteger(frame, text(receiver), 10, 16);
    return parsed === undefined ? undefined : new Boxed('Short', Number(parsed));
  },
  'String.toByte()': (frame, receiver) => parseNarrow(frame, text(receiver), 8),
  'String.toByteOrNull()': (frame, receiver) => {
    const parsed = parseInteger(frame, text(receiver), 10, 8);
    return parsed === undefined ? undefined : new Boxed('Byte', Number(parsed));
  },
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

/** Characters, and the conversions between characters, numbers, and text. */
const CHAR_NATIVES: Record<string, TextNative> = {
  'String.capitalize()': (_frame, receiver) => text(receiver).charAt(0).toUpperCase() + text(receiver).slice(1),
  'String.decapitalize()': (_frame, receiver) => text(receiver).charAt(0).toLowerCase() + text(receiver).slice(1),
  'Char.isDigit()': (_frame, receiver) => /\p{Nd}/u.test(charToString(receiver as number)),
  'Char.isLetter()': (_frame, receiver) => /\p{L}/u.test(charToString(receiver as number)),
  'Char.isLetterOrDigit()': (_frame, receiver) => /[\p{L}\p{Nd}]/u.test(charToString(receiver as number)),
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
  'Char.isDefined()': () => true,
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
  if (!isDecimalDigit(code)) return undefined;
  let start = code;
  while (start > 0 && isDecimalDigit(start - 1)) start--;
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

function isDecimalDigit(code: number): boolean {
  return /^\p{Nd}$/u.test(charToString(code));
}

function replaceAll(frame: Frame, value: string, oldValue: string, replacement: string, ignoreCase: boolean): string {
  const { indexOf } = textSearch(frame, value, oldValue, ignoreCase);
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

/** `split`, which splits at the first delimiter that matches at each position, keeping empty parts. */
function splitText(
  frame: Frame,
  value: string,
  delimiters: string[],
  { ignoreCase, supplementary, limit }: { ignoreCase: boolean; supplementary: boolean; limit: number }
): KObject {
  if (limit < 0)
    throwError(frame, 'java.lang.IllegalArgumentException', `Limit must be non-negative, but was ${limit}`);
  if (delimiters.length === 1 && delimiters[0] !== '' && !ignoreCase && limit === 0)
    return newList(frame, 'ArrayList', value.split(delimiters[0]));
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
  return newList(frame, 'ArrayList', parts);
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
export function formatText(frame: Frame, pattern: string, args: Value[]): string {
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
  return formatJava(pattern, args, values);
}

// StringBuilder.

const BUILDER = `${TEXT}.StringBuilder`;

function builder(value: Value): KObject {
  return value as KObject;
}

function setBuilder(frame: Frame, receiver: Value, value: string, work = value.length): Value {
  frame.runtime.allocateString(frame, value.length, work);
  builder(receiver).builder = value;
  return receiver;
}

function appendText(frame: Frame, receiver: Value, added: string): Value {
  return setBuilder(frame, receiver, (builder(receiver).builder as string) + added, added.length);
}

function defineBuilder(): void {
  defineBuilderReading();
  defineBuilderAppending();
  defineBuilderEditing();
}

/** StringBuilder's constructors and what reads it. */
// code-gauge-allow functionNcss 38 -- registers the natives of one class together, in the order the prelude declares them.
function defineBuilderReading(): void {
  defineNative(`${BUILDER}.<init>()`, (_frame, instance) => {
    builder(instance).builder = '';
    return UNIT;
  });
  defineNative(`${BUILDER}.<init>(Int)`, (frame, instance, [capacity]) => {
    if ((capacity as number) < 0) throwError(frame, 'java.lang.NegativeArraySizeException', String(capacity as number));
    builder(instance).builder = '';
    return UNIT;
  });
  defineNative(`${BUILDER}.<init>(String)`, (_frame, instance, [content]) => {
    builder(instance).builder = text(content);
    return UNIT;
  });
  defineNative(`${BUILDER}.<init>(CharSequence)`, (frame, instance, [content]) => {
    builder(instance).builder = sequenceText(frame, content);
    return UNIT;
  });
  defineNativeProperty(`${BUILDER}.length`, (_frame, receiver) => (builder(receiver).builder as string).length);
  defineNative(`${BUILDER}.get(Int)`, (frame, receiver, [index]) => {
    const value = builder(receiver).builder as string;
    const position = index as number;
    checkIndex(frame, position, value.length);
    // oxlint-disable-next-line unicorn/prefer-code-point -- Kotlin chars are UTF-16 code units.
    return value.charCodeAt(position);
  });
  defineNative(`${BUILDER}.subSequence(Int, Int)`, (frame, receiver, [start, end]) =>
    substring(frame, builder(receiver).builder as string, start as number, end as number)
  );
  defineNative(`${BUILDER}.indexOf(String)`, (_frame, receiver, [value]) =>
    (builder(receiver).builder as string).indexOf(text(value))
  );
  defineNative(`${BUILDER}.lastIndexOf(String)`, (_frame, receiver, [value]) =>
    (builder(receiver).builder as string).lastIndexOf(text(value))
  );
  defineNative(`${BUILDER}.substring(Int)`, (frame, receiver, [start]) => {
    const current = builder(receiver).builder as string;
    return substring(frame, current, start as number, current.length);
  });
  defineNative(`${BUILDER}.substring(Int, Int)`, (frame, receiver, [start, end]) =>
    substring(frame, builder(receiver).builder as string, start as number, end as number)
  );
  defineNative(`${BUILDER}.replace(Int, Int, String)`, (frame, receiver, [start, end, value]) => {
    const current = builder(receiver).builder as string;
    const from = start as number;
    const to = Math.min(end as number, current.length);
    if (from < 0 || from > current.length || from > to) rangeError(frame, from, to, current.length);
    const added = text(value);
    return setBuilder(
      frame,
      receiver,
      current.slice(0, from) + added + current.slice(to),
      current.length - to + added.length
    );
  });
  defineNative(`${BUILDER}.compareTo(StringBuilder)`, (_frame, receiver, [other]) =>
    compareStrings(builder(receiver).builder as string, builder(other).builder as string)
  );
  defineNative(`${BUILDER}.toString()`, (frame, receiver) => result(frame, builder(receiver).builder as string));
}

function defineBuilderAppending(): void {
  defineNative(`${BUILDER}.append(Any?)`, (frame, receiver, [value]) =>
    appendText(frame, receiver, stringOf(frame, value))
  );
  defineNative(`${BUILDER}.append(String?)`, (frame, receiver, [value]) =>
    appendText(frame, receiver, value === undefined ? 'null' : text(value))
  );
  defineNative(`${BUILDER}.append(CharSequence?)`, (frame, receiver, [value]) =>
    appendText(frame, receiver, value === undefined ? 'null' : sequenceText(frame, value))
  );
  defineNative(`${BUILDER}.append(Char)`, (frame, receiver, [value]) =>
    appendText(frame, receiver, charToString(value as number))
  );
  defineNative(`${BUILDER}.append(Int)`, (frame, receiver, [value]) =>
    appendText(frame, receiver, String(value as number))
  );
  defineNative(`${BUILDER}.append(Long)`, (frame, receiver, [value]) =>
    appendText(frame, receiver, String(value as bigint))
  );
  defineNative(`${BUILDER}.append(Double)`, (frame, receiver, [value]) =>
    appendText(frame, receiver, formatPrimitive('Double', value as number))
  );
  defineNative(`${BUILDER}.append(Boolean)`, (frame, receiver, [value]) =>
    appendText(frame, receiver, String(value as boolean))
  );
  defineNative(`${BUILDER}.append(CharArray)`, (frame, receiver, [value]) =>
    appendText(frame, receiver, ((value as KObject).items as number[]).map(charToString).join(''))
  );
}

/** What changes a StringBuilder in place. */
// code-gauge-allow functionNcss 35 -- registers the natives of one class together, in the order the prelude declares them.
function defineBuilderEditing(): void {
  defineNative(`${BUILDER}.insert(Int, Any?)`, (frame, receiver, [index, value]) => {
    const current = builder(receiver).builder as string;
    const position = index as number;
    if (position < 0 || position > current.length) rangeError(frame, position, current.length, current.length);
    const added = stringOf(frame, value);
    return setBuilder(
      frame,
      receiver,
      current.slice(0, position) + added + current.slice(position),
      current.length - position + added.length
    );
  });
  defineNative(`${BUILDER}.reverse()`, (frame, receiver) =>
    setBuilder(frame, receiver, reverseKeepingPairs(builder(receiver).builder as string))
  );
  defineNative(`${BUILDER}.deleteCharAt(Int)`, (frame, receiver, [index]) => {
    const current = builder(receiver).builder as string;
    const position = index as number;
    checkIndex(frame, position, current.length);
    return setBuilder(
      frame,
      receiver,
      current.slice(0, position) + current.slice(position + 1),
      current.length - position - 1
    );
  });
  defineNative(`${BUILDER}.delete(Int, Int)`, (frame, receiver, [start, end]) => {
    const current = builder(receiver).builder as string;
    const from = start as number;
    const to = Math.min(end as number, current.length);
    if (from < 0 || from > to) rangeError(frame, from, to, current.length);
    return setBuilder(frame, receiver, current.slice(0, from) + current.slice(to), current.length - to);
  });
  defineNative(`${BUILDER}.setLength(Int)`, (frame, receiver, [length]) => {
    const current = builder(receiver).builder as string;
    const size = length as number;
    if (size < 0) throwError(frame, 'java.lang.StringIndexOutOfBoundsException', `String index out of range: ${size}`);
    frame.runtime.allocateString(frame, size, Math.max(0, size - current.length));
    builder(receiver).builder = size <= current.length ? current.slice(0, size) : current.padEnd(size, '\0');
    return UNIT;
  });
  defineNative(`${BUILDER}.setCharAt(Int, Char)`, (frame, receiver, [index, char]) => {
    const current = builder(receiver).builder as string;
    const position = index as number;
    checkIndex(frame, position, current.length);
    setBuilder(
      frame,
      receiver,
      current.slice(0, position) + charToString(char as number) + current.slice(position + 1),
      1
    );
    return UNIT;
  });
}

/** The check of `StringBuilder`'s indexes in the JDK, worded as its `Preconditions.checkIndex` words it. */
function checkIndex(frame: Frame, position: number, length: number): void {
  if (position < 0 || position >= length) {
    throwError(
      frame,
      'java.lang.StringIndexOutOfBoundsException',
      `Index ${position} out of bounds for length ${length}`
    );
  }
}

function rangeError(frame: Frame, start: number, end: number, length: number): never {
  return throwError(
    frame,
    'java.lang.StringIndexOutOfBoundsException',
    `Range [${start}, ${end}) out of bounds for length ${length}`
  );
}

defineStrings();
defineBuilder();
