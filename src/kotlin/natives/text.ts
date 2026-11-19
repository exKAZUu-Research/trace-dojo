import { formatJava, type FormatValues } from '../../interpreter/javaFormatter';
import { runtimeClassOf } from '../dispatch';
import { charToString, formatPrimitive, hashOf, stringOf } from '../format';
import type { Frame } from '../runtime';
import { Boxed, KObject, UNIT, type Value } from '../values';
import { newList } from './collections';
import { compareStrings, substring } from './core';
import { defineNative, defineNativeProperty, libraryClass, throwError } from './registry';

const TEXT = 'kotlin.text';

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

/** The text of a `CharSequence`: a string or a `StringBuilder`. */
export function sequenceText(frame: Frame, value: Value): string {
  if (typeof value === 'string') return value;
  if (value instanceof KObject && value.builder !== undefined) return value.builder;
  return stringOf(frame, value);
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
  return isJavaWhitespace(code) || code === 0xa0 || code === 0x20_07 || code === 0x20_2f || code === 0x85;
}

function trimWith(value: string, start: boolean, end: boolean): string {
  let from = 0;
  let to = value.length;
  // oxlint-disable-next-line unicorn/prefer-code-point -- Kotlin chars are UTF-16 code units.
  while (start && from < to && isKotlinWhitespace(value.charCodeAt(from))) from++;
  // oxlint-disable-next-line unicorn/prefer-code-point -- Kotlin chars are UTF-16 code units.
  while (end && to > from && isKotlinWhitespace(value.charCodeAt(to - 1))) to--;
  return value.slice(from, to);
}

/** `String.toInt()`, whose errors are `NumberFormatException`s worded as Java's `Integer.parseInt` words them. */
function parseInteger(frame: Frame, value: string, radix: number, bits: 8 | 16 | 32 | 64): bigint | undefined {
  checkRadix(frame, radix);
  const digits = /^[+-]?[\p{Nd}A-Za-z]+$/u.test(value) ? value : undefined;
  if (!digits) return undefined;
  const negative = digits.startsWith('-');
  const body = digits.replace(/^[+-]/, '');
  let parsed = 0n;
  for (const char of codeUnits(body)) {
    const digit = digitOf(char) ?? Number.parseInt(charToString(char), 36);
    if (Number.isNaN(digit) || digit >= radix) return undefined;
    parsed = parsed * BigInt(radix) + BigInt(digit);
  }
  const signed = negative ? -parsed : parsed;
  const limit = 2n ** BigInt(bits - 1);
  if (signed < -limit || signed >= limit) return undefined;
  return signed;
}

/** `Short.parseShort` and `Byte.parseByte`, which name a number out of their range differently from a malformed one. */
function parseNarrow(frame: Frame, value: string, bits: 8 | 16): number {
  const parsed = parseInteger(frame, value, 10, 32);
  if (parsed === undefined) return numberFormatError(frame, value);
  if (BigInt.asIntN(bits, parsed) !== parsed)
    throwError(frame, 'java.lang.NumberFormatException', `Value out of range. Value:"${value}" Radix:10`);
  return Number(parsed);
}

/** Finds a string in a text, ignoring case as Kotlin's `ignoreCase` does when asked, by comparing lowercased copies. */
function search(
  value: string,
  target: string,
  ignoreCase: boolean
): { indexOf: (start: number) => number; lastIndexOf: (start: number) => number } {
  const [haystack, needle] = ignoreCase ? [value.toLowerCase(), target.toLowerCase()] : [value, target];
  return {
    indexOf: (start) => haystack.indexOf(needle, start),
    lastIndexOf: (start) => (start < 0 ? -1 : haystack.lastIndexOf(needle, start)),
  };
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
function parseDouble(value: string): number | undefined {
  const trimmed = trimControls(value);
  if (/^[+-]?(NaN|Infinity)$/.test(trimmed)) return Number(trimmed.replace('NaN', 'NaN'));
  const hex = /^([+-]?)0[xX]([\dA-Fa-f]*)\.?([\dA-Fa-f]*)[pP]([+-]?\d+)[fFdD]?$/.exec(trimmed);
  if (hex && (hex[2] || hex[3])) {
    const [, sign, whole, fraction, exponent] = hex;
    const magnitude = Number.parseInt(`${whole}${fraction}` || '0', 16) * 2 ** (Number(exponent) - 4 * fraction.length);
    return sign === '-' ? -magnitude : magnitude;
  }
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[fFdD]?$/.test(trimmed)) return undefined;
  return Number(trimmed.replace(/[fFdD]$/, ''));
}

/** The digraphs whose title case differs from their upper case, which JavaScript has no function for. */
const TITLECASE_DIGRAPHS = new Map(
  ['ǅǄǆ', 'ǈǇǉ', 'ǋǊǌ', 'ǲǱǳ'].flatMap(([title, upper, lower]) => [
    [title, title],
    [upper, title],
    [lower, title],
  ])
);

function defineStrings(): void {
  const natives: Record<string, (frame: Frame, receiver: Value, args: Value[]) => Value> = {
    'CharSequence.isBlank()': (frame, receiver) => codeUnits(sequenceText(frame, receiver)).every(isKotlinWhitespace),
    'String.uppercase()': (frame, receiver) => result(frame, text(receiver).toUpperCase()),
    'String.lowercase()': (frame, receiver) => result(frame, text(receiver).toLowerCase()),
    'String.trim()': (frame, receiver) => result(frame, trimWith(text(receiver), true, true)),
    'String.trimStart()': (frame, receiver) => result(frame, trimWith(text(receiver), true, false)),
    'String.trimEnd()': (frame, receiver) => result(frame, trimWith(text(receiver), false, true)),
    'String.trimIndent()': (frame, receiver) => result(frame, trimIndent(text(receiver))),
    'String.trimMargin(String)': (frame, receiver, [prefix]) => result(frame, trimMargin(text(receiver), text(prefix))),
    'String.substring(Int)': (frame, receiver, [start]) =>
      substring(frame, text(receiver), start as number, text(receiver).length),
    'String.substring(Int, Int)': (frame, receiver, [start, end]) =>
      substring(frame, text(receiver), start as number, end as number),
    'String.startsWith(String, Boolean)': (_frame, receiver, [prefix, ignoreCase]) =>
      ignoreCase
        ? text(receiver).toLowerCase().startsWith(text(prefix).toLowerCase())
        : text(receiver).startsWith(text(prefix)),
    'String.endsWith(String, Boolean)': (_frame, receiver, [suffix, ignoreCase]) =>
      ignoreCase
        ? text(receiver).toLowerCase().endsWith(text(suffix).toLowerCase())
        : text(receiver).endsWith(text(suffix)),
    'CharSequence.contains(CharSequence)': (frame, receiver, [other]) =>
      sequenceText(frame, receiver).includes(sequenceText(frame, other)),
    'CharSequence.indexOf(String, Int, Boolean)': (frame, receiver, [other, start, ignoreCase]) =>
      search(sequenceText(frame, receiver), text(other), ignoreCase === true).indexOf(Math.max(0, start as number)),
    'CharSequence.indexOf(Char, Int, Boolean)': (frame, receiver, [char, start, ignoreCase]) =>
      search(sequenceText(frame, receiver), charToString(char as number), ignoreCase === true).indexOf(
        Math.max(0, start as number)
      ),
    'CharSequence.lastIndexOf(String, Int, Boolean)': (frame, receiver, [other, start, ignoreCase]) =>
      search(sequenceText(frame, receiver), text(other), ignoreCase === true).lastIndexOf(start as number),
    'CharSequence.lastIndexOf(Char, Int, Boolean)': (frame, receiver, [char, start, ignoreCase]) =>
      search(sequenceText(frame, receiver), charToString(char as number), ignoreCase === true).lastIndexOf(
        start as number
      ),
    'String.replace(String, String, Boolean)': (frame, receiver, [oldValue, newValue, ignoreCase]) =>
      result(frame, replaceAll(text(receiver), text(oldValue), text(newValue), ignoreCase === true)),
    'String.replace(Char, Char)': (frame, receiver, [oldChar, newChar]) =>
      result(frame, text(receiver).replaceAll(charToString(oldChar as number), charToString(newChar as number))),
    'String.replaceFirst(String, String)': (frame, receiver, [oldValue, newValue]) =>
      result(
        frame,
        text(receiver).replace(text(oldValue), () => text(newValue))
      ),
    'String.repeat(Int)': (frame, receiver, [count]) => {
      const times = count as number;
      if (times < 0)
        throwError(frame, 'java.lang.IllegalArgumentException', `Count 'n' must be non-negative, but was ${times}.`);
      frame.runtime.allocateString(frame, text(receiver).length * times);
      return text(receiver).repeat(times);
    },
    'CharSequence.split(vararg String, Boolean, Int)': (frame, receiver, [delimiters, ignoreCase, limit]) =>
      splitText(frame, sequenceText(frame, receiver), ((delimiters as KObject).items as Value[]).map(text), {
        ignoreCase: ignoreCase === true,
        limit: limit as number,
      }),
    'CharSequence.split(vararg Char, Boolean, Int)': (frame, receiver, [delimiters, ignoreCase, limit]) =>
      splitText(
        frame,
        sequenceText(frame, receiver),
        ((delimiters as KObject).items as Value[]).map((char) => charToString(char as number)),
        { ignoreCase: ignoreCase === true, limit: limit as number }
      ),
    'CharSequence.lines()': (frame, receiver) =>
      newList(frame, 'ArrayList', sequenceText(frame, receiver).split(/\r\n|\n|\r/)),
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
        throwError(
          frame,
          'java.lang.IllegalArgumentException',
          `Desired length ${length as number} is less than zero.`
        );
      // The padded text is charged before it is built, as its length may be far beyond the limit.
      frame.runtime.allocateString(frame, length as number);
      return text(receiver).padStart(length as number, charToString(char as number));
    },
    'String.padEnd(Int, Char)': (frame, receiver, [length, char]) => {
      if ((length as number) < 0)
        throwError(
          frame,
          'java.lang.IllegalArgumentException',
          `Desired length ${length as number} is less than zero.`
        );
      // The padded text is charged before it is built, as its length may be far beyond the limit.
      frame.runtime.allocateString(frame, length as number);
      return text(receiver).padEnd(length as number, charToString(char as number));
    },
    'String.equals(String?, Boolean)': (_frame, receiver, [other, ignoreCase]) => {
      if (other === undefined) return false;
      return ignoreCase ? text(receiver).toLowerCase() === text(other).toLowerCase() : receiver === other;
    },
    'String.compareTo(String, Boolean)': (_frame, receiver, [other, ignoreCase]) =>
      ignoreCase
        ? compareStrings(text(receiver).toLowerCase(), text(other).toLowerCase())
        : compareStrings(text(receiver), text(other)),
    'String.format(vararg Any?)': (frame, receiver, [args]) =>
      result(frame, formatText(frame, text(receiver), (args as KObject).items as Value[])),
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
    'String.toDouble()': (frame, receiver) => parseDouble(text(receiver)) ?? doubleFormatError(frame, text(receiver)),
    'String.toDoubleOrNull()': (_frame, receiver) => {
      const parsed = parseDouble(text(receiver));
      return parsed === undefined ? undefined : new Boxed('Double', parsed);
    },
    'String.toFloat()': (frame, receiver) => {
      const parsed = parseDouble(text(receiver));
      return parsed === undefined ? numberFormatError(frame, text(receiver)) : Math.fround(parsed);
    },
    'String.toBoolean()': (_frame, receiver) => text(receiver).toLowerCase() === 'true',
    'String.toBooleanStrict()': (frame, receiver) => {
      if (receiver === 'true') return true;
      if (receiver === 'false') return false;
      return throwError(
        frame,
        'java.lang.IllegalArgumentException',
        `The string doesn't represent a boolean value: ${text(receiver)}`
      );
    },
    'String.capitalize()': (_frame, receiver) => text(receiver).charAt(0).toUpperCase() + text(receiver).slice(1),
    'String.decapitalize()': (_frame, receiver) => text(receiver).charAt(0).toLowerCase() + text(receiver).slice(1),
    'Char.isDigit()': (_frame, receiver) => /\p{Nd}/u.test(charToString(receiver as number)),
    'Char.isLetter()': (_frame, receiver) => /\p{L}/u.test(charToString(receiver as number)),
    'Char.isLetterOrDigit()': (_frame, receiver) => /[\p{L}\p{Nd}]/u.test(charToString(receiver as number)),
    'Char.isWhitespace()': (_frame, receiver) => isKotlinWhitespace(receiver as number),
    'Char.isUpperCase()': (_frame, receiver) => /\p{Lu}/u.test(charToString(receiver as number)),
    'Char.isLowerCase()': (_frame, receiver) => /\p{Ll}/u.test(charToString(receiver as number)),
    'Char.uppercaseChar()': (_frame, receiver) => upperChar(receiver as number),
    'Char.lowercaseChar()': (_frame, receiver) => lowerChar(receiver as number),
    'Char.toUpperCase()': (_frame, receiver) => upperChar(receiver as number),
    'Char.toLowerCase()': (_frame, receiver) => lowerChar(receiver as number),
    'Char.uppercase()': (_frame, receiver) => charToString(receiver as number).toUpperCase(),
    'Char.lowercase()': (_frame, receiver) => charToString(receiver as number).toLowerCase(),
    'Char.titlecase()': (_frame, receiver) => {
      const char = charToString(receiver as number);
      return TITLECASE_DIGRAPHS.get(char) ?? char.toUpperCase();
    },
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
  for (const [signature, native] of Object.entries(natives)) defineNative(`${TEXT}.${signature}`, native);
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

function isDecimalDigit(code: number): boolean {
  return /^\p{Nd}$/u.test(charToString(code));
}

function upperChar(code: number): number {
  const upper = charToString(code).toUpperCase();
  // oxlint-disable-next-line unicorn/prefer-code-point -- Kotlin chars are UTF-16 code units.
  return upper.length === 1 ? upper.charCodeAt(0) : code;
}

function lowerChar(code: number): number {
  const lower = charToString(code).toLowerCase();
  // oxlint-disable-next-line unicorn/prefer-code-point -- Kotlin chars are UTF-16 code units.
  return lower.length === 1 ? lower.charCodeAt(0) : code;
}

function replaceAll(value: string, oldValue: string, newValue: string, ignoreCase: boolean): string {
  if (!ignoreCase) {
    if (oldValue === '')
      return `${newValue}${codeUnits(value).map(charToString).join(newValue)}${value === '' ? '' : newValue}`;
    return value.split(oldValue).join(newValue);
  }
  const lower = value.toLowerCase();
  const search = oldValue.toLowerCase();
  let built = '';
  let index = 0;
  for (;;) {
    const found = lower.indexOf(search, index);
    if (found === -1 || search === '') break;
    built += value.slice(index, found) + newValue;
    index = found + search.length;
  }
  return built + value.slice(index);
}

/** `split`, which splits at the first delimiter that matches at each position, keeping empty parts. */
function splitText(
  frame: Frame,
  value: string,
  delimiters: string[],
  { ignoreCase, limit }: { ignoreCase: boolean; limit: number }
): KObject {
  if (limit < 0)
    throwError(frame, 'java.lang.IllegalArgumentException', `Limit must be non-negative, but was ${limit}`);
  if (delimiters.length === 1 && delimiters[0] !== '' && !ignoreCase && limit === 0)
    return newList(frame, 'ArrayList', value.split(delimiters[0]));
  const [haystack, needles] = ignoreCase
    ? [value.toLowerCase(), delimiters.map((delimiter) => delimiter.toLowerCase())]
    : [value, delimiters];
  const parts: string[] = [];
  let start = 0;
  let index = 0;
  while (index <= value.length && (limit === 0 || parts.length < limit - 1)) {
    const delimiter = needles.find((candidate) => candidate !== '' && haystack.startsWith(candidate, index));
    if (delimiter === undefined) {
      if (delimiters.includes('') && index > start && index < value.length) {
        parts.push(value.slice(start, index));
        start = index;
      }
      index++;
      continue;
    }
    parts.push(value.slice(start, index));
    index += delimiter.length;
    start = index;
  }
  parts.push(value.slice(start));
  if (delimiters.includes('')) {
    return newList(frame, 'ArrayList', ['', ...codeUnits(value).map(charToString), '']);
  }
  return newList(frame, 'ArrayList', parts);
}

function trimIndent(value: string): string {
  const lines = value.split('\n');
  const indents = lines.filter((line) => line.trim() !== '').map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0);
  const minimum = indents.length > 0 ? Math.min(...indents) : 0;
  const trimmed = lines.map((line) => (line.trim() === '' ? '' : line.slice(minimum)));
  if (trimmed.length > 0 && trimmed[0].trim() === '') trimmed.shift();
  if (trimmed.length > 0 && trimmed.at(-1)?.trim() === '') trimmed.pop();
  return trimmed.join('\n');
}

function trimMargin(value: string, prefix: string): string {
  const lines = value.split('\n');
  const trimmed = lines.map((line) => {
    const start = line.search(/\S/);
    return start !== -1 && line.startsWith(prefix, start) ? line.slice(start + prefix.length) : line;
  });
  if (trimmed.length > 0 && trimmed[0].trim() === '') trimmed.shift();
  if (trimmed.length > 0 && trimmed.at(-1)?.trim() === '') trimmed.pop();
  return trimmed.join('\n');
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

function setBuilder(frame: Frame, receiver: Value, value: string): Value {
  frame.runtime.allocateString(frame, value.length);
  builder(receiver).builder = value;
  return receiver;
}

function appendText(frame: Frame, receiver: Value, added: string): Value {
  return setBuilder(frame, receiver, (builder(receiver).builder as string) + added);
}

function defineBuilder(): void {
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
  defineNative(`${BUILDER}.insert(Int, Any?)`, (frame, receiver, [index, value]) => {
    const current = builder(receiver).builder as string;
    const position = index as number;
    if (position < 0 || position > current.length) rangeError(frame, position, current.length, current.length);
    return setBuilder(frame, receiver, current.slice(0, position) + stringOf(frame, value) + current.slice(position));
  });
  defineNative(`${BUILDER}.reverse()`, (frame, receiver) =>
    setBuilder(frame, receiver, reverseKeepingPairs(builder(receiver).builder as string))
  );
  defineNative(`${BUILDER}.deleteCharAt(Int)`, (frame, receiver, [index]) => {
    const current = builder(receiver).builder as string;
    const position = index as number;
    checkIndex(frame, position, current.length);
    return setBuilder(frame, receiver, current.slice(0, position) + current.slice(position + 1));
  });
  defineNative(`${BUILDER}.delete(Int, Int)`, (frame, receiver, [start, end]) => {
    const current = builder(receiver).builder as string;
    const from = start as number;
    const to = Math.min(end as number, current.length);
    if (from < 0 || from > to) rangeError(frame, from, to, current.length);
    return setBuilder(frame, receiver, current.slice(0, from) + current.slice(to));
  });
  defineNative(`${BUILDER}.setLength(Int)`, (frame, receiver, [length]) => {
    const current = builder(receiver).builder as string;
    const size = length as number;
    if (size < 0) throwError(frame, 'java.lang.StringIndexOutOfBoundsException', `String index out of range: ${size}`);
    frame.runtime.allocateString(frame, size);
    setBuilder(frame, receiver, size <= current.length ? current.slice(0, size) : current.padEnd(size, '\0'));
    return UNIT;
  });
  defineNative(`${BUILDER}.setCharAt(Int, Char)`, (frame, receiver, [index, char]) => {
    const current = builder(receiver).builder as string;
    const position = index as number;
    checkIndex(frame, position, current.length);
    setBuilder(
      frame,
      receiver,
      current.slice(0, position) + charToString(char as number) + current.slice(position + 1)
    );
    return UNIT;
  });
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
    return setBuilder(frame, receiver, current.slice(0, from) + text(value) + current.slice(to));
  });
  defineNative(`${BUILDER}.compareTo(StringBuilder)`, (_frame, receiver, [other]) =>
    compareStrings(builder(receiver).builder as string, builder(other).builder as string)
  );
  defineNative(`${BUILDER}.toString()`, (frame, receiver) => result(frame, builder(receiver).builder as string));
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
