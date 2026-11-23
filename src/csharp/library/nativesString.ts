// code-gauge-allow-file fileNcss -- The nativesString module keeps one stage of the C# interpreter together.
// oxlint-disable unicorn/prefer-code-point -- C# characters are UTF-16 code units, which code points would merge.
import {
  compareCulture,
  type CultureComparison,
  cultureEndsWith,
  cultureHashKey,
  cultureIndexOf,
  cultureLastIndexOf,
  cultureStartsWith,
  equalsCulture,
} from '../culture';
import { defineNatives, defineNativesKeepingStrings, type NativeCall, type NativeMethod } from '../natives';
import { primitiveHash, toStringValue, unboxed } from '../objects';
import type { NativeState } from '../runtime';
import { specialOf, type Type } from '../types';
import {
  type CsArray,
  CsBox,
  CsObject,
  type CsString,
  freshString,
  plainString,
  stringText,
  type Value,
  type VariableReference,
} from '../values';
import { BuilderChunks } from './builderChunks';
import { iterate } from './iteration';
import { compositeFormat } from './nativesCore';
import {
  arrayValues,
  evaluatorOf,
  fail,
  failGreater,
  failNegative,
  failNull,
  failOutOfRange,
  libraryType,
  newArray,
  parameterType,
  textOf,
} from './support';

const STRING = 'System.String';

/**
 * `StringComparison`'s values: 0 and 1 the current culture, 2 and 3 the invariant one, 4 and 5 ordinal, of which the
 * odd ones ignore case.
 */
function compareWith(call: NativeCall, a: string, b: string, comparison: number): number {
  const ignoreCase = comparison % 2 === 1;
  // An ordinal comparison gives the difference of the first differing characters, as .NET's does.
  if (comparison >= 4) return ordinalDifference(ignoreCase ? ordinalUpper(a) : a, ignoreCase ? ordinalUpper(b) : b);
  return compareCulture(a, b, cultureOf(call, comparison));
}

function equalsWith(call: NativeCall, a: string, b: string, comparison: number): boolean {
  if (comparison === 4) return a === b;
  if (comparison === 5) return ordinalUpper(a) === ordinalUpper(b);
  return equalsCulture(a, b, cultureOf(call, comparison));
}

/** A culture comparison of a `StringComparison`, whose work counts against the run's budget. */
function cultureOf(call: NativeCall, comparison: number): CultureComparison {
  return {
    isInvariant: comparison >= 2,
    ignoreCase: comparison % 2 === 1,
    spend: (cost) => call.frame.runtime.spend(cost),
  };
}

/** Whether a string contains, starts with, or ends with another under a `StringComparison`. */
function searchWith(
  call: NativeCall,
  text: string,
  value: string,
  comparison: number,
  how: 'contains' | 'starts' | 'ends'
): boolean {
  if (comparison >= 4) {
    const [haystack, needle] = comparison === 5 ? [ordinalUpper(text), ordinalUpper(value)] : [text, value];
    if (how === 'starts') return haystack.startsWith(needle);
    return how === 'ends' ? haystack.endsWith(needle) : haystack.includes(needle);
  }
  const culture = cultureOf(call, comparison);
  if (how === 'starts') return cultureStartsWith(text, value, culture);
  if (how === 'ends') return cultureEndsWith(text, value, culture);
  return cultureIndexOf(text, value, 0, text.length, culture) !== -1;
}

function receiverText(receiver: Value): string {
  if (receiver === undefined)
    fail('System.NullReferenceException', 'Object reference not set to an instance of an object.');
  return receiver as string;
}

/** The characters `Trim` removes by default: Unicode whitespace. */
// .NET's `char.IsWhiteSpace`: the space separators, the line and paragraph separators, and the controls from tab to
// carriage return and U+0085, but not U+FEFF, which JavaScript's `\s` includes.
const WHITESPACE = /[\t-\r\u0085\p{Zs}\u2028\u2029]/u;

function trimWith(text: string, chars: string[] | undefined, start: boolean, end: boolean): string {
  const isTrimmed = (char: string): boolean =>
    chars && chars.length > 0 ? chars.includes(char) : WHITESPACE.test(char);
  let first = 0;
  let last = text.length;
  if (start) while (first < last && isTrimmed(text[first])) first++;
  if (end) while (last > first && isTrimmed(text[last - 1])) last--;
  return text.slice(first, last);
}

function charsOf(value: Value): string[] {
  if (value === undefined) return [];
  if (typeof value === 'number') return [String.fromCodePoint(value)];
  return (value as CsArray).values.map((code) => String.fromCodePoint(code as number));
}

function split(call: NativeCall, text: string, args: Value[]): CsArray {
  const { separators, count, options } = splitArguments(call, args);
  if (count < 0) failNegative(call, 'count', count);
  const isWhitespaceSplit =
    separators.length === 0 &&
    !(call.method.parameters.some((parameter) => specialOf(parameter.type) === 'string') && args[0] === '');
  if (count === 0) return newArray(call, libraryType(call, STRING), []);
  if (separators.length === 0 && !isWhitespaceSplit) return newArray(call, libraryType(call, STRING), [text]);
  const separatorLengthAt = (index: number): number => {
    if (isWhitespaceSplit) return WHITESPACE.test(text[index] ?? '') ? 1 : 0;
    return separators.find((separator) => separator !== '' && text.startsWith(separator, index))?.length ?? 0;
  };
  return newArray(call, libraryType(call, STRING), splitParts(text, count, options, separatorLengthAt));
}

function splitArguments(call: NativeCall, args: Value[]): { separators: string[]; count: number; options: number } {
  let separators: string[] = [];
  let count = Number.MAX_SAFE_INTEGER;
  let options = 0;
  for (const [index, parameter] of call.method.parameters.entries()) {
    const value = args[index];
    if (parameter.name === 'count') count = value as number;
    else if (parameter.name === 'options') options = value as number;
    else separators = separatorsOf(value, parameter.type) ?? separators;
  }
  return { separators, count, options };
}

function separatorsOf(value: Value, type: Type): string[] | undefined {
  if (type.kind === 'array') {
    if (value === undefined) return [];
    return (value as CsArray).values.map((item) =>
      typeof item === 'number' ? String.fromCodePoint(item) : (plainString(item) as string)
    );
  }
  const special = specialOf(type);
  if (special === 'char') return [String.fromCodePoint(value as number)];
  if (special === 'string') return value === undefined || value === '' ? [] : [value as string];
  return undefined;
}

/** Splits a text at its separators into at most `count` parts, as `StringSplitOptions` filter and trim them. */
function splitParts(
  text: string,
  count: number,
  options: number,
  separatorLengthAt: (index: number) => number
): string[] {
  const removeEmpty = (options & 1) !== 0;
  const trimEntries = (options & 2) !== 0;
  const parts: string[] = [];
  const push = (part: string): void => {
    const piece = trimEntries ? trimWith(part, undefined, true, true) : part;
    if (removeEmpty && piece === '') return;
    parts.push(piece);
  };
  let start = 0;
  let index = 0;
  while (index <= text.length && parts.length !== count - 1) {
    const length = separatorLengthAt(index);
    if (length === 0) {
      index++;
      continue;
    }
    push(text.slice(start, index));
    index += length;
    start = index;
  }
  // .NET skips the entries the options remove before it takes the rest as the last part.
  while (removeEmpty && count > 1 && parts.length === count - 1) {
    let next = start;
    while (next < text.length && separatorLengthAt(next) === 0) next++;
    if (next >= text.length) break;
    const piece = text.slice(start, next);
    if ((trimEntries ? trimWith(piece, undefined, true, true) : piece) !== '') break;
    start = next + separatorLengthAt(next);
  }
  push(text.slice(start));
  return parts;
}

function joinValues(call: NativeCall, separator: string, args: Value[], startIndex = 1): string {
  return joinedText(
    call,
    elementStrings(call, args, startIndex).map((item) => stringText(item)),
    separator
  );
}

/**
 * The strings that `Concat`, `Join`, and `AppendJoin` combine from their arguments from an index on, as the objects
 * that the elements' `ToString()` return: an array or a sequence of elements, or the separate arguments.
 */
function elementStrings(call: NativeCall, args: Value[], startIndex: number): (string | CsString)[] {
  const parameter = call.method.parameters[startIndex];
  const evaluator = evaluatorOf(call);
  const toText = (item: Value, type: Type): string | CsString => toStringValue(evaluator, item, type, call.frame);
  const last = args[startIndex];
  if (parameter.type.kind === 'array') {
    const elementType = parameter.type.element;
    const values = arrayValues(last);
    const items =
      args.length > startIndex + 1
        ? values.slice(
            args[startIndex + 1] as number,
            (args[startIndex + 1] as number) + (args[startIndex + 2] as number)
          )
        : values;
    return items.map((item) => toText(item, elementType));
  }
  if (
    parameter.type.kind === 'named' &&
    specialOf(parameter.type) !== 'object' &&
    specialOf(parameter.type) !== 'string'
  ) {
    const elementType = call.typeArgs[0] ?? libraryType(call, STRING);
    return [...iterate(call, last)].map((item) => toText(item, elementType));
  }
  return args.slice(startIndex).map((arg, index) => toText(arg, parameterType(call, startIndex + index)));
}

/**
 * The string `Concat` or `Join` returns: an only element itself, the one non-empty string of `Concat`'s overloads
 * for two to four strings or objects, or a new string.
 */
function combinedString(call: NativeCall, strings: (string | CsString)[], separator: string): string | CsString {
  if (strings.length === 1) return strings[0];
  const nonEmpty = strings.filter((item) => stringText(item) !== '');
  const isSeparateArguments = call.method.parameters.every(
    (parameter) => !parameter.isParams && ['object', 'string'].includes(specialOf(parameter.type) ?? '')
  );
  if (call.method.name === 'Concat' && isSeparateArguments && nonEmpty.length === 1) return nonEmpty[0];
  return freshString(
    joinedText(
      call,
      strings.map((item) => stringText(item)),
      separator
    )
  );
}

/** Joins texts after checking the length of the result, which repeated references to one string can make huge. */
function joinedText(call: NativeCall, texts: string[], separator: string): string {
  let length = Math.max(0, texts.length - 1) * separator.length;
  for (const text of texts) length += text.length;
  call.frame.runtime.allocateString(length);
  return texts.join(separator);
}

const stringNatives: Record<string, NativeMethod> = {
  [`${STRING}..ctor(char, int)`]: (call, _receiver, [char, count]) => {
    if ((count as number) < 0) failNegative(call, 'count', count as number);
    call.frame.runtime.allocateString(count as number);
    return String.fromCodePoint(char as number).repeat(count as number);
  },
  [`${STRING}..ctor(char[]?)`]: (_call, _receiver, [chars]) => charsOf(chars as Value).join(''),
  [`${STRING}..ctor(char[], int, int)`]: (call, _receiver, [chars, start, length]) => {
    if (chars === undefined) failNull('value');
    if ((start as number) < 0) failNegative(call, 'startIndex', start as number);
    if ((length as number) < 0) failNegative(call, 'length', length as number);
    const all = charsOf(chars as Value);
    if ((start as number) > all.length - (length as number))
      failOutOfRange(
        call,
        'startIndex',
        'Index was out of range. Must be non-negative and less than or equal to the size of the collection.'
      );
    call.frame.runtime.allocateString(length as number);
    return all.slice(start as number, (start as number) + (length as number)).join('');
  },
  [`${STRING}.get_Length`]: (_call, receiver) => receiverText(receiver).length,
  [`${STRING}.get_Item`]: (_call, receiver, [index]) => {
    const text = receiverText(receiver);
    const position = index as number;
    if (position < 0 || position >= text.length)
      fail('System.IndexOutOfRangeException', 'Index was outside the bounds of the array.');
    return text.charCodeAt(position);
  },
  [`${STRING}.Clone`]: (_call, receiver) => receiver,
  [`${STRING}.CompareTo`]: (call, receiver, [other]) =>
    other === undefined
      ? 1
      : compareCulture(receiverText(receiver), unboxed(other as Value) as string, cultureOf(call, 0)),
  [`${STRING}.Contains(string)`]: (_call, receiver, [value]) => {
    if (value === undefined) failNull('value');
    return receiverText(receiver).includes(value as string);
  },
  [`${STRING}.Contains(char)`]: (_call, receiver, [value]) =>
    receiverText(receiver).includes(String.fromCodePoint(value as number)),
  [`${STRING}.Contains(string, StringComparison)`]: (call, receiver, [value, comparison]) => {
    if (value === undefined) failNull('value');
    return searchWith(call, receiverText(receiver), value as string, comparison as number, 'contains');
  },
  [`${STRING}.Contains(char, StringComparison)`]: (call, receiver, [value, comparison]) =>
    searchWith(call, receiverText(receiver), String.fromCodePoint(value as number), comparison as number, 'contains'),
  [`${STRING}.StartsWith(string)`]: (call, receiver, [value]) => {
    if (value === undefined) failNull('value');
    return cultureStartsWith(receiverText(receiver), value as string, cultureOf(call, 0));
  },
  [`${STRING}.StartsWith(char)`]: (_call, receiver, [value]) =>
    receiverText(receiver).startsWith(String.fromCodePoint(value as number)),
  [`${STRING}.StartsWith(string, StringComparison)`]: (call, receiver, [value, comparison]) => {
    if (value === undefined) failNull('value');
    return searchWith(call, receiverText(receiver), value as string, comparison as number, 'starts');
  },
  [`${STRING}.EndsWith(string)`]: (call, receiver, [value]) => {
    if (value === undefined) failNull('value');
    return cultureEndsWith(receiverText(receiver), value as string, cultureOf(call, 0));
  },
  [`${STRING}.EndsWith(char)`]: (_call, receiver, [value]) =>
    receiverText(receiver).endsWith(String.fromCodePoint(value as number)),
  [`${STRING}.EndsWith(string, StringComparison)`]: (call, receiver, [value, comparison]) => {
    if (value === undefined) failNull('value');
    return searchWith(call, receiverText(receiver), value as string, comparison as number, 'ends');
  },
  [`${STRING}.Equals(object?)`]: (_call, receiver, [other]) => receiver === plainString(other as Value),
  [`${STRING}.Equals(string?)`]: (_call, receiver, [other]) => receiver === other,
  [`${STRING}.Equals(string?, StringComparison)`]: (call, receiver, [other, comparison]) =>
    other !== undefined && equalsWith(call, receiverText(receiver), other as string, comparison as number),
  [`${STRING}.Equals(string?, string?)`]: (_call, _receiver, [a, b]) => a === b,
  [`${STRING}.Equals(string?, string?, StringComparison)`]: (call, _receiver, [a, b, comparison]) =>
    a === undefined || b === undefined ? a === b : equalsWith(call, a as string, b as string, comparison as number),
  [`${STRING}.GetHashCode`]: (_call, receiver) => primitiveHash(receiver as string) ?? 0,
  [`${STRING}.GetEnumerator`]: (call, receiver) => {
    const enumerator = new CsObject(libraryType(call, 'System.CharEnumerator'), []);
    enumerator.native = new CharEnumeratorState(receiverText(receiver));
    return enumerator;
  },
  [`${STRING}.IndexOf`]: (call, receiver, args) => indexOf(call, receiverText(receiver), args as Value[]),
  [`${STRING}.LastIndexOf`]: (call, receiver, args) => lastIndexOf(call, receiverText(receiver), args as Value[]),
  [`${STRING}.IndexOfAny`]: (_call, receiver, [chars, start = 0]) => {
    const text = receiverText(receiver);
    const set = charsOf(chars as Value);
    for (let index = start as number; index < text.length; index++) if (set.includes(text[index])) return index;
    return -1;
  },
  [`${STRING}.LastIndexOfAny`]: (_call, receiver, [chars]) => {
    const text = receiverText(receiver);
    const set = charsOf(chars as Value);
    for (let index = text.length - 1; index >= 0; index--) if (set.includes(text[index])) return index;
    return -1;
  },
  [`${STRING}.Insert`]: (call, receiver, [index, value]) => {
    const text = receiverText(receiver);
    if (value === undefined) failNull('value');
    // .NET compares the index as an unsigned number, so a negative one shows as a large one.
    if ((index as number) < 0 || (index as number) > text.length)
      failGreater(call, 'startIndex', (index as number) >>> 0, text.length);
    call.frame.runtime.allocateString(text.length + (value as string).length);
    return text.slice(0, index as number) + (value as string) + text.slice(index as number);
  },
  [`${STRING}.PadLeft`]: (call, receiver, [width, char = 32]) => {
    if ((width as number) < 0) failNegative(call, 'totalWidth', width as number);
    call.frame.runtime.allocateString(width as number);
    return receiverText(receiver).padStart(width as number, String.fromCodePoint(char as number));
  },
  [`${STRING}.PadRight`]: (call, receiver, [width, char = 32]) => {
    if ((width as number) < 0) failNegative(call, 'totalWidth', width as number);
    call.frame.runtime.allocateString(width as number);
    return receiverText(receiver).padEnd(width as number, String.fromCodePoint(char as number));
  },
  [`${STRING}.Remove(int)`]: (call, receiver, [start]) => {
    const text = receiverText(receiver);
    if ((start as number) < 0) failOutOfRange(call, 'startIndex', 'StartIndex cannot be less than zero.');
    if ((start as number) > text.length)
      failOutOfRange(call, 'startIndex', 'startIndex cannot be larger than length of string.');
    return text.slice(0, start as number);
  },
  [`${STRING}.Remove(int, int)`]: (call, receiver, [start, count]) => {
    const text = receiverText(receiver);
    if ((start as number) < 0) failNegative(call, 'startIndex', start as number);
    if ((count as number) < 0) failNegative(call, 'count', count as number);
    if ((start as number) + (count as number) > text.length)
      failGreater(call, 'count', count as number, text.length - (start as number));
    return text.slice(0, start as number) + text.slice((start as number) + (count as number));
  },
  [`${STRING}.Replace(char, char)`]: (_call, receiver, [from, to]) =>
    receiverText(receiver).replaceAll(String.fromCodePoint(from as number), String.fromCodePoint(to as number)),
  [`${STRING}.Replace(string, string?)`]: (call, receiver, [from, to]) => {
    if (from === undefined) failNull('oldValue');
    if (from === '') fail('System.ArgumentException', 'The value cannot be an empty string.', 'oldValue');
    // A callback keeps the replacement literal, which JavaScript would read for `$&` and other substitutions.
    const text = receiverText(receiver).replaceAll(from as string, () => (to as string | undefined) ?? '');
    call.frame.runtime.allocateString(text.length);
    return text;
  },
  [`${STRING}.Replace(string, string?, StringComparison)`]: (_call, receiver, [from, to, comparison]) => {
    const text = receiverText(receiver);
    if ((comparison as number) % 2 === 0)
      return text.replaceAll(from as string, () => (to as string | undefined) ?? '');
    return text.replaceAll(
      new RegExp((from as string).replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`), 'gi'),
      () => (to as string | undefined) ?? ''
    );
  },
  [`${STRING}.Split`]: (call, receiver, args) => split(call, receiverText(receiver), args as Value[]),
  [`${STRING}.Substring(int)`]: (call, receiver, [start]) => {
    const text = receiverText(receiver);
    if ((start as number) < 0) failNegative(call, 'startIndex', start as number);
    if ((start as number) > text.length)
      failOutOfRange(call, 'startIndex', 'startIndex cannot be larger than length of string.');
    return text.slice(start as number);
  },
  [`${STRING}.Substring(int, int)`]: (call, receiver, [start, length]) => {
    const text = receiverText(receiver);
    if ((start as number) < 0) failNegative(call, 'startIndex', start as number);
    if ((start as number) > text.length)
      failOutOfRange(call, 'startIndex', 'startIndex cannot be larger than length of string.');
    if ((length as number) < 0) failNegative(call, 'length', length as number);
    if ((start as number) + (length as number) > text.length)
      failOutOfRange(call, 'length', 'Index and length must refer to a location within the string.');
    return text.slice(start as number, (start as number) + (length as number));
  },
  [`${STRING}.ToCharArray()`]: (call, receiver) =>
    newArray(
      call,
      libraryType(call, 'System.Char'),
      Array.from({ length: receiverText(receiver).length }, (_unused, index) =>
        receiverText(receiver).charCodeAt(index)
      )
    ),
  [`${STRING}.ToCharArray(int, int)`]: (call, receiver, [start, length]) => {
    const text = receiverText(receiver);
    if ((start as number) < 0) failNegative(call, 'startIndex', start as number);
    if ((length as number) < 0) failNegative(call, 'length', length as number);
    if ((start as number) > text.length - (length as number))
      failGreater(call, 'startIndex', start as number, text.length - (length as number));
    return newArray(
      call,
      libraryType(call, 'System.Char'),
      text
        .slice(start as number, (start as number) + (length as number))
        .split('')
        .map((unit) => unit.charCodeAt(0))
    );
  },
  [`${STRING}.ToLower`]: (_call, receiver) => caseMappedText(receiverText(receiver), false),
  [`${STRING}.ToLowerInvariant`]: (_call, receiver) => caseMappedText(receiverText(receiver), false),
  [`${STRING}.ToUpper`]: (_call, receiver) => caseMappedText(receiverText(receiver), true),
  [`${STRING}.ToUpperInvariant`]: (_call, receiver) => caseMappedText(receiverText(receiver), true, true),
  [`${STRING}.ToString`]: (_call, receiver) => receiverText(receiver),
  [`${STRING}.Trim()`]: (_call, receiver) => trimWith(receiverText(receiver), undefined, true, true),
  [`${STRING}.Trim(char)`]: (_call, receiver, [char]) =>
    trimWith(receiverText(receiver), charsOf(char as Value), true, true),
  [`${STRING}.Trim(char[]?)`]: (_call, receiver, [chars]) =>
    trimWith(receiverText(receiver), charsOf(chars as Value), true, true),
  [`${STRING}.TrimStart()`]: (_call, receiver) => trimWith(receiverText(receiver), undefined, true, false),
  [`${STRING}.TrimStart(char)`]: (_call, receiver, [char]) =>
    trimWith(receiverText(receiver), charsOf(char as Value), true, false),
  [`${STRING}.TrimStart(char[]?)`]: (_call, receiver, [chars]) =>
    trimWith(receiverText(receiver), charsOf(chars as Value), true, false),
  [`${STRING}.TrimEnd()`]: (_call, receiver) => trimWith(receiverText(receiver), undefined, false, true),
  [`${STRING}.TrimEnd(char)`]: (_call, receiver, [char]) =>
    trimWith(receiverText(receiver), charsOf(char as Value), false, true),
  [`${STRING}.TrimEnd(char[]?)`]: (call, receiver, [chars]) =>
    trimWith(receiverText(receiver), charsOf(chars as Value), false, true),
  [`${STRING}.IsNormalized`]: (call, receiver) => receiverText(receiver) === receiverText(receiver).normalize(),
  [`${STRING}.Compare`]: (call, _receiver, args) => {
    const [a, b] = args as (string | undefined)[];
    if (args.length === 5) {
      const [strA, indexA, strB, indexB, length] = args as [string, number, string, number, number];
      return compareCulture(
        strA.slice(indexA, indexA + length),
        strB.slice(indexB, indexB + length),
        cultureOf(call, 0)
      );
    }
    if (a === undefined) return b === undefined ? 0 : -1;
    if (b === undefined) return 1;
    if (typeof args[2] === 'boolean') return compareCulture(a, b, cultureOf(call, args[2] ? 1 : 0));
    if (typeof args[2] === 'number') return compareWith(call, a, b, args[2]);
    return compareCulture(a, b, cultureOf(call, 0));
  },
  [`${STRING}.CompareOrdinal(string?, string?)`]: (_call, _receiver, [a, b]) => {
    if (a === undefined) return b === undefined ? 0 : -1;
    if (b === undefined) return 1;
    return ordinalDifference(a as string, b as string);
  },
  [`${STRING}.CompareOrdinal(string?, int, string?, int, int)`]: (call, _receiver, args) => {
    const [a, indexA, b, indexB, length] = args as [string | undefined, number, string | undefined, number, number];
    if (a === undefined) return b === undefined ? 0 : -1;
    if (b === undefined) return 1;
    const message =
      'Index was out of range. Must be non-negative and less than or equal to the size of the collection.';
    if (length < 0) failOutOfRange(call, 'length', 'Count cannot be less than zero.');
    if (indexA < 0 || indexB < 0) failOutOfRange(call, indexA < 0 ? 'indexA' : 'indexB', message);
    const lengthA = Math.min(length, a.length - indexA);
    const lengthB = Math.min(length, b.length - indexB);
    if (lengthA < 0 || lengthB < 0) failOutOfRange(call, lengthA < 0 ? 'indexA' : 'indexB', message);
    return ordinalDifference(a.slice(indexA, indexA + lengthA), b.slice(indexB, indexB + lengthB));
  },
  [`${STRING}.Copy`]: (_call, _receiver, [text]) => text as string,
  [`${STRING}.Format`]: (call, _receiver, args) => formatCall(call, args as Value[]),
  [`${STRING}.IsNullOrEmpty`]: (_call, _receiver, [value]) => value === undefined || value === '',
  [`${STRING}.IsNullOrWhiteSpace`]: (_call, _receiver, [value]) =>
    value === undefined || trimWith(value as string, undefined, true, true) === '',
  [`${STRING}.op_Equality`]: (_call, _receiver, [a, b]) => a === b,
  [`${STRING}.op_Inequality`]: (_call, _receiver, [a, b]) => a !== b,
};
defineNatives(stringNatives);

/** Whether a string has only ASCII characters, whose case mapping .NET returns the string itself from when unchanged. */
const isAscii = (text: string): boolean => /^[\0-\u007F]*$/u.test(text);

/**
 * The methods that return the string itself when they leave its text as it is, with what else .NET requires of the
 * call; `Replace` makes a new string whenever it finds what it replaces, except for one character by another.
 */
const RETURNING_RECEIVER: [string, (text: string, args: Value[]) => boolean][] = [
  ...['Clone', 'ToString', 'PadLeft', 'PadRight', 'Remove(int)', 'Remove(int, int)', 'Replace(char, char)'].map(
    (name): [string, () => boolean] => [name, () => true]
  ),
  ...['Substring(int)', 'Substring(int, int)'].map((name): [string, () => boolean] => [name, () => true]),
  ...['Trim', 'TrimStart', 'TrimEnd'].flatMap((name) =>
    ['()', '(char)', '(char[]?)'].map((parameters): [string, () => boolean] => [`${name}${parameters}`, () => true])
  ),
  ...['ToLower', 'ToLowerInvariant', 'ToUpper', 'ToUpperInvariant'].map((name): [string, (text: string) => boolean] => [
    name,
    isAscii,
  ]),
  [
    'Replace(string, string?)',
    (text, [from, to]) =>
      ((from as string).length === 1 && ((to as string | undefined) ?? '').length === 1) ||
      !text.includes(from as string),
  ],
  [
    'Replace(string, string?, StringComparison)',
    (text, [from, _to, comparison]) =>
      (comparison as number) % 2 === 0
        ? !text.includes(from as string)
        : !text.toLowerCase().includes((from as string).toLowerCase()),
  ],
];

defineNativesKeepingStrings({
  ...Object.fromEntries(
    RETURNING_RECEIVER.map(([name, isReceiverKept]) => {
      const native = stringNatives[`${STRING}.${name}`];
      const kept: NativeMethod = (call, receiver, args) => {
        const plainArgs = args.map((arg) => plainString(arg as Value));
        const text = plainString(receiver);
        const result = native(call, text, plainArgs) as string;
        return result === text && isReceiverKept(result, plainArgs) ? receiver : freshString(result);
      };
      return [`${STRING}.${name}`, kept];
    })
  ),
  [`${STRING}.Insert`]: (call, receiver, args) => {
    const [index, value] = args as Value[];
    const result = stringNatives[`${STRING}.Insert`](call, plainString(receiver), [
      index,
      plainString(value),
    ]) as string;
    // .NET returns the inserted string itself into an empty one, and the string itself for an empty insertion.
    if (plainString(receiver) === '') return value;
    return plainString(value) === '' ? receiver : freshString(result);
  },
  [`${STRING}.Split`]: (call, receiver, args) => {
    const text = plainString(receiver);
    const parts = stringNatives[`${STRING}.Split`](
      call,
      text,
      args.map((arg) => plainString(arg as Value))
    ) as CsArray;
    // A string that the separators do not split is its own only part.
    for (const [index, part] of parts.values.entries())
      parts.values[index] = part === text ? receiver : freshString(part as string);
    return parts;
  },
  [`${STRING}.Concat`]: (call, _receiver, args) => combinedString(call, elementStrings(call, args as Value[], 0), ''),
  [`${STRING}.Join`]: (call, _receiver, args) => {
    if (args.length === 2 && args[1] === undefined) failNull('value');
    const separator = plainString(args[0] as Value);
    const separatorText =
      separator === undefined
        ? ''
        : typeof separator === 'number'
          ? String.fromCodePoint(separator)
          : (separator as string);
    return combinedString(call, elementStrings(call, args as Value[], 1), separatorText);
  },
});

function ordinalDifference(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const difference = a.charCodeAt(index) - b.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

/** `string.Format`, whose first argument may be a format provider that the ja-JP culture ignores. */
export function formatCall(call: NativeCall, args: Value[]): string {
  const parameters = call.method.parameters;
  const offset = parameters[0].name === 'provider' ? 1 : 0;
  const format = args[offset] as string | undefined;
  const rest = parameters.slice(offset + 1);
  const values = rest.at(-1)?.isParams
    ? [...args.slice(offset + 1, -1), ...arrayValues(args.at(-1) as Value)]
    : args.slice(offset + 1);
  const object = libraryType(call, 'System.Object');
  const items = values.map((value, index) => ({
    value,
    type: rest[index] && !rest[index].isParams ? parameterType(call, offset + 1 + index) : object,
  }));
  const text = compositeFormat(call, format, items);
  call.frame.runtime.allocateString(text.length);
  return text;
}

function lastIndexOf(call: NativeCall, text: string, args: Value[]): number {
  const { needle, isChar, start, count = start + 1, comparison } = searchOf(call, args, text.length - 1);
  return isChar
    ? lastCharIndex(call, text, needle, start, count)
    : lastStringIndex(call, text, needle, { start, count }, comparison);
}

function indexOf(call: NativeCall, text: string, args: Value[]): number {
  const { needle, start, count, comparison } = searchOf(call, args, 0);
  if (start < 0 || start > text.length)
    failOutOfRange(
      call,
      'startIndex',
      'Index was out of range. Must be non-negative and less than or equal to the size of the collection.'
    );
  if (count !== undefined && (count < 0 || start + count > text.length))
    failOutOfRange(
      call,
      'count',
      'Count must be positive and count must refer to a location within the string/array/collection.'
    );
  const end = count === undefined ? text.length : start + count;
  if (comparison < 4 && needle !== '') return cultureIndexOf(text, needle, start, end, cultureOf(call, comparison));
  const [haystack, target] = ordinalForms(text, needle, comparison);
  const found = haystack.indexOf(target, start);
  if (found === -1 || found + target.length > end) return -1;
  return found;
}

/**
 * The value that `IndexOf` and `LastIndexOf` search for, and how: a char ordinally and a string with the current
 * culture, unless a `StringComparison` says otherwise.
 */
function searchOf(
  call: NativeCall,
  args: Value[],
  defaultStart: number
): { needle: string; isChar: boolean; start: number; count: number | undefined; comparison: number } {
  const value = args[0];
  if (value === undefined) failNull('value');
  const isChar = typeof value === 'number';
  const needle = isChar ? String.fromCodePoint(value) : (value as string);
  return { needle, isChar, ...searchArguments(call, args, defaultStart, isChar ? 4 : 0) };
}

/** The texts an ordinal search compares: as they are, or case-mapped for `OrdinalIgnoreCase`. */
function ordinalForms(text: string, needle: string, comparison: number): [string, string] {
  return comparison % 2 === 1 ? [ordinalUpper(text), ordinalUpper(needle)] : [text, needle];
}

function searchArguments(
  call: NativeCall,
  args: Value[],
  defaultStart: number,
  defaultComparison: number
): { start: number; count: number | undefined; comparison: number } {
  let start = defaultStart;
  let count: number | undefined;
  let comparison = defaultComparison;
  for (const [index, parameter] of call.method.parameters.entries()) {
    if (index === 0) continue;
    if (parameter.name === 'startIndex') start = args[index] as number;
    else if (parameter.name === 'count') count = args[index] as number;
    else if (parameter.name === 'comparisonType') comparison = args[index] as number;
  }
  return { start, count, comparison };
}

/** `string.LastIndexOf(char, int, int)`: the last occurrence in the `count` characters that end at `start`. */
function lastCharIndex(call: NativeCall, text: string, char: string, start: number, count: number): number {
  if (text.length === 0) return -1;
  if (start < 0 || start >= text.length) failLastStart(call);
  if (count < 0 || count > start + 1) failLastCount(call);
  const found = text.slice(start + 1 - count, start + 1).lastIndexOf(char);
  return found === -1 ? -1 : start + 1 - count + found;
}

/**
 * `CompareInfo.LastIndexOf`, which `string.LastIndexOf(string, ...)` calls: the last occurrence in the `count`
 * characters that end at `start`, which may be the length to search the whole string.
 */
function lastStringIndex(
  call: NativeCall,
  text: string,
  needle: string,
  range: { start: number; count: number },
  comparison: number
): number {
  let { start, count } = range;
  if (start === text.length) {
    start--;
    if (count > 0) count--;
  }
  if (start === -1 && text.length === 0) count = 0;
  else if (start < 0 || start >= text.length) failLastStart(call);
  const first = start - count + 1;
  if (first < 0 || count < 0 || first + count > text.length) failLastCount(call);
  // An empty value occurs at the end of the part searched.
  if (needle === '') return first + count;
  if (comparison < 4) return cultureLastIndexOf(text, needle, first, first + count, cultureOf(call, comparison));
  const [haystack, target] = ordinalForms(text.slice(first, first + count), needle, comparison);
  const found = haystack.lastIndexOf(target);
  return found === -1 ? -1 : first + found;
}

function failLastStart(call: NativeCall): never {
  return failOutOfRange(
    call,
    'startIndex',
    'Index was out of range. Must be non-negative and less than the size of the collection.'
  );
}

function failLastCount(call: NativeCall): never {
  return failOutOfRange(
    call,
    'count',
    'Count must be positive and count must refer to a location within the string/array/collection.'
  );
}

/** `CharEnumerator`'s state: the text and the position before the current character. */
class CharEnumeratorState implements NativeState {
  position = -1;

  constructor(readonly text: string) {}

  references(): Value[] {
    return [];
  }
}

defineNatives({
  'System.CharEnumerator.MoveNext': (_call, receiver) => {
    const state = (receiver as CsObject).native as CharEnumeratorState;
    if (state.position < state.text.length) state.position++;
    return state.position < state.text.length;
  },
  'System.CharEnumerator.get_Current': (_call, receiver) => {
    const state = (receiver as CsObject).native as CharEnumeratorState;
    if (state.position < 0) fail('System.InvalidOperationException', 'Enumeration has not started. Call MoveNext.');
    if (state.position >= state.text.length) fail('System.InvalidOperationException', 'Enumeration already finished.');
    return state.text.charCodeAt(state.position);
  },
  'System.CharEnumerator.Reset': (_call, receiver) => {
    ((receiver as CsObject).native as CharEnumeratorState).position = -1;
    return;
  },
  'System.CharEnumerator.Dispose': () => {},
  'System.CharEnumerator.Clone': (_call, receiver) => receiver,
});

// ---- Char ----

const CHAR = 'System.Char';
const charTest =
  (test: (char: string) => boolean): NativeMethod =>
  (_call, _receiver, args) => {
    if (args.length === 1) return test(String.fromCodePoint(args[0] as number));
    return test(charOfString(args[0] as Value, args[1] as number));
  };

/** The character at an index of a string that `char.IsDigit(s, index)` and its kin test. */
function charOfString(text: Value, index: number): string {
  if (text === undefined) failNull('s');
  if (index < 0 || index >= (text as string).length)
    fail('System.ArgumentOutOfRangeException', 'Specified argument was out of the range of valid values.', 'index');
  return (text as string).charAt(index);
}

defineNatives({
  [`${CHAR}.ToString()`]: (_call, receiver) => String.fromCodePoint(unboxed(receiver) as number),
  [`${CHAR}.ToString(char)`]: (_call, _receiver, [value]) => String.fromCodePoint(value as number),
  // `Equals(object)` receives a box, which must hold a char.
  [`${CHAR}.Equals`]: (_call, receiver, [other]) =>
    other instanceof CsBox
      ? specialOf(other.type) === 'char' && unboxed(receiver) === other.value
      : unboxed(receiver) === other,
  [`${CHAR}.GetHashCode`]: (_call, receiver) => {
    const code = unboxed(receiver) as number;
    return code | (code << 16);
  },
  [`${CHAR}.CompareTo`]: (_call, receiver, [other]) =>
    other === undefined ? 1 : (unboxed(receiver) as number) - (unboxed(other as Value) as number),
  [`${CHAR}.IsDigit`]: charTest((char) => /\p{Nd}/u.test(char)),
  [`${CHAR}.IsLetter`]: charTest((char) => /\p{L}/u.test(char)),
  [`${CHAR}.IsLetterOrDigit`]: charTest((char) => /[\p{L}\p{Nd}]/u.test(char)),
  [`${CHAR}.IsLower`]: charTest((char) => /\p{Ll}/u.test(char)),
  [`${CHAR}.IsUpper`]: charTest((char) => /\p{Lu}/u.test(char)),
  [`${CHAR}.IsNumber`]: charTest((char) => /\p{N}/u.test(char)),
  [`${CHAR}.IsPunctuation`]: charTest((char) => /\p{P}/u.test(char)),
  [`${CHAR}.IsSymbol`]: charTest((char) => /\p{S}/u.test(char)),
  [`${CHAR}.IsSeparator`]: charTest((char) => /\p{Z}/u.test(char)),
  [`${CHAR}.IsControl`]: charTest((char) => /\p{Cc}/u.test(char)),
  [`${CHAR}.IsWhiteSpace`]: charTest((char) => WHITESPACE.test(char)),
  [`${CHAR}.IsSurrogate`]: charTest((char) => /[\uD800-\uDFFF]/.test(char)),
  [`${CHAR}.IsHighSurrogate`]: charTest((char) => /[\uD800-\uDBFF]/.test(char)),
  [`${CHAR}.IsLowSurrogate`]: charTest((char) => /[\uDC00-\uDFFF]/.test(char)),
  [`${CHAR}.IsAscii`]: charTest((char) => char.charCodeAt(0) < 128),
  [`${CHAR}.IsAsciiDigit`]: charTest((char) => /[0-9]/.test(char)),
  [`${CHAR}.IsAsciiLetter`]: charTest((char) => /[A-Za-z]/.test(char)),
  [`${CHAR}.IsAsciiLetterOrDigit`]: charTest((char) => /[A-Za-z0-9]/.test(char)),
  [`${CHAR}.IsAsciiLetterLower`]: charTest((char) => /[a-z]/.test(char)),
  [`${CHAR}.IsAsciiLetterUpper`]: charTest((char) => /[A-Z]/.test(char)),
  [`${CHAR}.IsAsciiHexDigit`]: charTest((char) => /[0-9A-Fa-f]/.test(char)),
  [`${CHAR}.IsBetween`]: (_call, _receiver, [value, low, high]) =>
    (value as number) >= (low as number) && (value as number) <= (high as number),
  [`${CHAR}.ToUpper`]: (_call, _receiver, [value]) => caseMapped(value as number, true),
  [`${CHAR}.ToUpperInvariant`]: (_call, _receiver, [value]) => caseMapped(value as number, true, true),
  [`${CHAR}.ToLower`]: (_call, _receiver, [value]) => caseMapped(value as number, false),
  [`${CHAR}.ToLowerInvariant`]: (_call, _receiver, [value]) => caseMapped(value as number, false),
  [`${CHAR}.GetNumericValue`]: (_call, _receiver, args) => {
    const [value, index] = args as Value[];
    const char = typeof value === 'string' ? value.charAt(index as number) : String.fromCharCode(value as number);
    return numericValueOf(char.charCodeAt(0));
  },
  [`${CHAR}.Parse`]: (_call, _receiver, [text]) => {
    if (text === undefined) failNull('s');
    if ((text as string).length !== 1) fail('System.FormatException', 'String must be exactly one character long.');
    return (text as string).charCodeAt(0);
  },
  [`${CHAR}.TryParse`]: (_call, _receiver, [text, result]) => {
    const ok = typeof text === 'string' && text.length === 1;
    (result as VariableReference).set(ok ? (text as string).charCodeAt(0) : 0);
    return ok;
  },
  [`${CHAR}.ConvertFromUtf32`]: (_call, _receiver, [code]) => String.fromCodePoint(code as number),
  [`${CHAR}.ConvertToUtf32(char, char)`]: (_call, _receiver, [high, low]) =>
    ((high as number) - 0xd8_00) * 0x4_00 + ((low as number) - 0xdc_00) + 0x1_00_00,
  [`${CHAR}.ConvertToUtf32(string, int)`]: (call, _receiver, [text, index]) => {
    if (text === undefined) failNull('s');
    const value = text as string;
    const position = index as number;
    if (position < 0 || position >= value.length)
      failOutOfRange(
        call,
        'index',
        'Index was out of range. Must be non-negative and less than the size of the collection.'
      );
    const code = value.charCodeAt(position);
    const invalid = (what: string): never =>
      fail(
        'System.ArgumentException',
        `Found a ${what} at index: ${position}. The input may not be in this encoding, or may not contain valid Unicode (UTF-16) characters.`,
        's'
      );
    if (code >= 0xdc_00 && code <= 0xdf_ff) invalid('low surrogate char without a preceding high surrogate');
    if (code < 0xd8_00 || code > 0xdb_ff) return code;
    const next = value.charCodeAt(position + 1);
    if (!(next >= 0xdc_00 && next <= 0xdf_ff)) invalid('high surrogate char without a following low surrogate');
    return (code - 0xd8_00) * 0x4_00 + (next - 0xdc_00) + 0x1_00_00;
  },
});

/**
 * .NET's simple case mapping of a character, which keeps one character: `ß` stays as JavaScript's `SS` would expand
 * it, and `İ` lowers to `i` without JavaScript's combining dot.
 */
function caseMapped(code: number, upper: boolean, isInvariant = false): number {
  // The invariant culture keeps the dotless i, whose uppercase `I` belongs to Turkish.
  if (isInvariant && upper && code === DOTLESS_I) return code;
  const char = String.fromCharCode(code);
  const mapped = upper ? char.toUpperCase() : char.toLowerCase();
  if (mapped.length === 1) return mapped.charCodeAt(0);
  return !upper && /^.\p{M}+$/u.test(mapped) ? mapped.charCodeAt(0) : code;
}

/** Maps each character of a text as `ToUpper` and `ToLower` do, without JavaScript's context-sensitive rules. */
function caseMappedText(text: string, upper: boolean, isInvariant = false): string {
  let result = '';
  for (let index = 0; index < text.length; index++)
    result += String.fromCharCode(caseMapped(text.charCodeAt(index), upper, isInvariant));
  return result;
}

const DOTLESS_I = 0x1_31;
const LONG_S = 0x1_7f;

/** A text as `OrdinalIgnoreCase` compares it: uppercased, except that no other letter becomes an ASCII one. */
function ordinalUpper(text: string): string {
  let result = '';
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    result += String.fromCharCode(code === DOTLESS_I || code === LONG_S ? code : caseMapped(code, true));
  }
  return result;
}

/**
 * The Unicode numeric value of a character that `char.GetNumericValue` gives: a decimal digit of any script, and the
 * common fractions, Roman numerals, circled numbers, superscripts, and subscripts; -1 for others.
 */
function numericValueOf(code: number): number {
  const char = String.fromCharCode(code);
  if (/\p{Nd}/u.test(char)) {
    // Each script's digits run from 0 to 9 in consecutive code units.
    let zero = code;
    while (zero > code - 9 && /\p{Nd}/u.test(String.fromCharCode(zero - 1))) zero--;
    return (code - zero) % 10;
  }
  const special = NUMERIC_VALUES.get(code);
  if (special !== undefined) return special;
  for (const [start, end, first] of NUMERIC_RANGES) if (code >= start && code <= end) return first + code - start;
  return -1;
}

const NUMERIC_VALUES = new Map<number, number>([
  [0xbc, 0.25],
  [0xbd, 0.5],
  [0xbe, 0.75],
  [0xb9, 1],
  [0xb2, 2],
  [0xb3, 3],
  [0x20_70, 0],
  [0x30_07, 0],
  [0x21_50, 1 / 7],
  [0x21_51, 1 / 9],
  [0x21_52, 0.1],
  [0x21_53, 1 / 3],
  [0x21_54, 2 / 3],
  [0x21_55, 0.2],
  [0x21_56, 0.4],
  [0x21_57, 0.6],
  [0x21_58, 0.8],
  [0x21_59, 1 / 6],
  [0x21_5a, 5 / 6],
  [0x21_5b, 0.125],
  [0x21_5c, 0.375],
  [0x21_5d, 0.625],
  [0x21_5e, 0.875],
  [0x21_6c, 50],
  [0x21_6d, 100],
  [0x21_6e, 500],
  [0x21_6f, 1000],
  [0x21_7c, 50],
  [0x21_7d, 100],
  [0x21_7e, 500],
  [0x21_7f, 1000],
]);

/** Runs of characters whose values count up from a first value: [first code, last code, first value]. */
const NUMERIC_RANGES: [number, number, number][] = [
  [0x20_74, 0x20_79, 4],
  [0x20_80, 0x20_89, 0],
  [0x21_60, 0x21_6b, 1],
  [0x21_70, 0x21_7b, 1],
  [0x24_60, 0x24_73, 1],
  [0x24_74, 0x24_87, 1],
  [0x24_88, 0x24_9b, 1],
  [0x27_76, 0x27_7f, 1],
];

// ---- StringComparer ----

const STRING_COMPARER = 'System.StringComparer';

/** The StringComparer of each StringComparison, one object per kind as .NET's properties return. */
const stringComparers = new WeakMap<object, Map<number, CsObject>>();

function stringComparer(call: NativeCall, comparison: number): CsObject {
  let byKind = stringComparers.get(call.frame.runtime);
  if (!byKind) {
    byKind = new Map();
    stringComparers.set(call.frame.runtime, byKind);
  }
  let comparer = byKind.get(comparison);
  if (!comparer) {
    comparer = new CsObject(libraryType(call, STRING_COMPARER), []);
    comparer.native = comparison;
    byKind.set(comparison, comparer);
  }
  return comparer;
}

const comparisonOfComparer = (receiver: Value): number => (receiver as CsObject).native as number;

defineNatives({
  [`${STRING_COMPARER}.get_CurrentCulture`]: (call) => stringComparer(call, 0),
  [`${STRING_COMPARER}.get_CurrentCultureIgnoreCase`]: (call) => stringComparer(call, 1),
  [`${STRING_COMPARER}.get_InvariantCulture`]: (call) => stringComparer(call, 2),
  [`${STRING_COMPARER}.get_InvariantCultureIgnoreCase`]: (call) => stringComparer(call, 3),
  [`${STRING_COMPARER}.get_Ordinal`]: (call) => stringComparer(call, 4),
  [`${STRING_COMPARER}.get_OrdinalIgnoreCase`]: (call) => stringComparer(call, 5),
  [`${STRING_COMPARER}.Compare`]: (call, receiver, [a, b]) => {
    if (a === undefined) return b === undefined ? 0 : -1;
    if (b === undefined) return 1;
    return compareWith(call, a as string, b as string, comparisonOfComparer(receiver));
  },
  [`${STRING_COMPARER}.Equals`]: (call, receiver, [a, b]) => {
    if (a === undefined || b === undefined) return a === b;
    return equalsWith(call, a as string, b as string, comparisonOfComparer(receiver));
  },
  [`${STRING_COMPARER}.GetHashCode`]: (_call, receiver, [text]) => {
    if (text === undefined) failNull('obj');
    const comparison = comparisonOfComparer(receiver);
    if (comparison === 4) return primitiveHash(text as string) ?? 0;
    if (comparison === 5) return primitiveHash(ordinalUpper(text as string)) ?? 0;
    return primitiveHash(cultureHashKey(text as string)) ?? 0;
  },
});

// ---- StringBuilder ----

const BUILDER = 'System.Text.StringBuilder';

/** A StringBuilder's text, which `Append` and the other methods change in place, and the chunks that hold it in .NET. */
class BuilderState implements NativeState {
  readonly chunks: BuilderChunks;

  constructor(
    public text: string,
    capacity: number
  ) {
    this.chunks = new BuilderChunks(capacity, text.length);
  }

  references(): Value[] {
    return [];
  }

  append(text: string): void {
    this.text += text;
    this.chunks.append(text.length);
  }

  insert(index: number, text: string): void {
    this.text = this.text.slice(0, index) + text + this.text.slice(index);
    this.chunks.insert(index, text.length);
  }

  remove(start: number, length: number): void {
    this.text = this.text.slice(0, start) + this.text.slice(start + length);
    this.chunks.remove(start, length);
  }

  setLength(length: number): void {
    this.text = this.text.slice(0, length).padEnd(length, '\0');
    this.chunks.setLength(length);
  }

  replace(oldValue: string, newValue: string, start: number, count: number): void {
    this.text = this.chunks.replace(this.text, oldValue, newValue, start, count);
  }
}

function builder(receiver: Value): BuilderState {
  return (receiver as CsObject).native as BuilderState;
}

function append(call: NativeCall, receiver: Value, text: string): Value {
  const state = builder(receiver);
  reserve(call, state, text.length);
  state.append(text);
  return receiver;
}

/** Checks the length a builder grows to and charges its work before the new text is built, as .NET checks first. */
function reserve(call: NativeCall, state: BuilderState, added: number, work = added): void {
  call.frame.runtime.allocateString(state.text.length + added, work);
}

/** The non-overlapping occurrences of a text in a range of a builder's text. */
function occurrencesIn(text: string, value: string, start: number, count: number): number {
  const range = text.slice(start, start + count);
  let occurrences = 0;
  for (let index = range.indexOf(value); index !== -1; index = range.indexOf(value, index + value.length))
    occurrences++;
  return occurrences;
}

defineNatives({
  [`${BUILDER}..ctor()`]: (_call, receiver) => setBuilder(receiver, '', 0),
  [`${BUILDER}..ctor(int)`]: (call, receiver, [capacity]) => {
    if ((capacity as number) < 0) failNegative(call, 'capacity', capacity as number);
    return setBuilder(receiver, '', capacity as number);
  },
  [`${BUILDER}..ctor(string?)`]: (_call, receiver, [text]) =>
    setBuilder(receiver, (text as string | undefined) ?? '', 0),
  [`${BUILDER}..ctor(string?, int)`]: (call, receiver, [text, capacity]) => {
    if ((capacity as number) < 0) failNegative(call, 'capacity', capacity as number);
    return setBuilder(receiver, (text as string | undefined) ?? '', capacity as number);
  },
  [`${BUILDER}.get_Length`]: (_call, receiver) => builder(receiver).text.length,
  [`${BUILDER}.set_Length`]: (call, receiver, [length]) => {
    if ((length as number) < 0) failNegative(call, 'value', length as number);
    const state = builder(receiver);
    reserve(call, state, Math.max(0, (length as number) - state.text.length));
    state.setLength(length as number);
    return;
  },
  [`${BUILDER}.get_Capacity`]: (_call, receiver) => builder(receiver).chunks.capacity,
  [`${BUILDER}.set_Capacity`]: (call, receiver, [capacity]) => {
    const state = builder(receiver);
    if ((capacity as number) < 0) failNegative(call, 'value', capacity as number);
    if ((capacity as number) < state.text.length)
      failOutOfRange(call, 'value', 'capacity was less than the current size.');
    state.chunks.setCapacity(capacity as number);
    return;
  },
  [`${BUILDER}.get_Item`]: (_call, receiver, [index]) => {
    const { text } = builder(receiver);
    if ((index as number) < 0 || (index as number) >= text.length)
      fail('System.IndexOutOfRangeException', 'Index was outside the bounds of the array.');
    return text.charCodeAt(index as number);
  },
  [`${BUILDER}.set_Item`]: (call, receiver, [index, char]) => {
    const state = builder(receiver);
    if ((index as number) < 0 || (index as number) >= state.text.length)
      failOutOfRange(
        call,
        'index',
        'Index was out of range. Must be non-negative and less than the size of the collection.'
      );
    state.text =
      state.text.slice(0, index as number) +
      String.fromCodePoint(char as number) +
      state.text.slice((index as number) + 1);
    return;
  },
  [`${BUILDER}.Append`]: (call, receiver, args) => {
    const parameters = call.method.parameters;
    if (parameters.length === 2 && specialOf(parameters[0].type) === 'char') {
      const count = args[1] as number;
      if (count < 0) failNegative(call, 'repeatCount', count);
      reserve(call, builder(receiver), count, 0);
      return append(call, receiver, String.fromCodePoint(args[0] as number).repeat(count));
    }
    if (parameters.length === 3) {
      const [start, count] = [args[1] as number, args[2] as number];
      if (start < 0) failNegative(call, 'startIndex', start);
      if (count < 0) failNegative(call, 'count', count);
      if (args[0] === undefined) {
        if (start === 0 && count === 0) return receiver;
        failNull('value');
      }
      const value = args[0] as string;
      if (count === 0) return receiver;
      if (start > value.length - count)
        failOutOfRange(call, 'startIndex', 'Index and length must refer to a location within the string.');
      return append(call, receiver, value.slice(start, start + count));
    }
    const value = args[0] as Value;
    if (parameters[0].type.kind === 'array') return append(call, receiver, charsOf(value).join(''));
    if (value instanceof CsObject && value.native instanceof BuilderState)
      return append(call, receiver, value.native.text);
    return append(call, receiver, textOf(call, value, parameterType(call, 0)));
  },
  // `AppendLine` appends its text and the new line separately, which the chunks can tell apart.
  [`${BUILDER}.AppendLine`]: (call, receiver, args) =>
    append(call, append(call, receiver, (args[0] as string | undefined) ?? ''), '\n'),
  [`${BUILDER}.AppendFormat`]: (call, receiver, args) => append(call, receiver, formatCall(call, args as Value[])),
  [`${BUILDER}.AppendJoin`]: (call, receiver, args) => {
    const separator =
      typeof args[0] === 'number' ? String.fromCodePoint(args[0]) : ((args[0] as string | undefined) ?? '');
    return append(call, receiver, joinValues(call, separator, args as Value[]));
  },
  [`${BUILDER}.Clear`]: (_call, receiver) => {
    builder(receiver).setLength(0);
    return receiver;
  },
  [`${BUILDER}.Equals`]: (_call, receiver, [other]) =>
    other instanceof CsObject && other.native instanceof BuilderState && other.native.text === builder(receiver).text,
  [`${BUILDER}.Insert`]: (call, receiver, args) => {
    const state = builder(receiver);
    const index = args[0] as number;
    const isRepeated = call.method.parameters.length === 3;
    if (isRepeated && (args[2] as number) < 0) failNegative(call, 'count', args[2] as number);
    if (index < 0 || index > state.text.length)
      failOutOfRange(
        call,
        'index',
        'Index was out of range. Must be non-negative and less than or equal to the size of the collection.'
      );
    let text: string;
    if (isRepeated) {
      const value = (args[1] as string | undefined) ?? '';
      reserve(call, state, value.length * (args[2] as number), 0);
      text = value.repeat(args[2] as number);
    } else if (
      call.method.parameters[1].type.kind === 'named' &&
      specialOf(call.method.parameters[1].type) === 'char'
    ) {
      text = String.fromCodePoint(args[1] as number);
    } else {
      text = textOf(call, args[1] as Value, parameterType(call, 1));
    }
    reserve(call, state, text.length);
    state.insert(index, text);
    return receiver;
  },
  [`${BUILDER}.Remove`]: (call, receiver, [start, length]) => {
    const state = builder(receiver);
    if ((start as number) < 0) failNegative(call, 'startIndex', start as number);
    if ((length as number) < 0) failNegative(call, 'length', length as number);
    if ((start as number) + (length as number) > state.text.length)
      failOutOfRange(
        call,
        'length',
        'Index was out of range. Must be non-negative and less than or equal to the size of the collection.'
      );
    state.remove(start as number, length as number);
    return receiver;
  },
  [`${BUILDER}.Replace(char, char)`]: (call, receiver, [from, to]) => {
    const state = builder(receiver);
    reserve(call, state, 0, state.text.length);
    state.text = state.text.replaceAll(String.fromCodePoint(from as number), String.fromCodePoint(to as number));
    return receiver;
  },
  [`${BUILDER}.Replace(string, string?)`]: (call, receiver, [from, to]) => {
    if (from === undefined) failNull('oldValue');
    if (from === '') fail('System.ArgumentException', 'The value cannot be an empty string.', 'oldValue');
    const state = builder(receiver);
    replaceIn(call, state, from as string, (to as string | undefined) ?? '', 0, state.text.length);
    return receiver;
  },
  [`${BUILDER}.Replace(char, char, int, int)`]: (call, receiver, [from, to, start, count]) => {
    const state = builder(receiver);
    const [before, middle, after] = builderRange(call, state.text, start as number, count as number);
    reserve(call, state, 0, middle.length);
    state.text = `${before}${middle.replaceAll(String.fromCodePoint(from as number), String.fromCodePoint(to as number))}${after}`;
    return receiver;
  },
  [`${BUILDER}.Replace(string, string?, int, int)`]: (call, receiver, [from, to, start, count]) => {
    const state = builder(receiver);
    builderRange(call, state.text, start as number, count as number);
    if (from === undefined) failNull('oldValue');
    if (from === '') fail('System.ArgumentException', 'The value cannot be an empty string.', 'oldValue');
    replaceIn(call, state, from as string, (to as string | undefined) ?? '', start as number, count as number);
    return receiver;
  },
  [`${BUILDER}.ToString()`]: (_call, receiver) => builder(receiver).text,
  [`${BUILDER}.ToString(int, int)`]: (call, receiver, [start, length]) => {
    const { text } = builder(receiver);
    if ((start as number) < 0) failOutOfRange(call, 'startIndex', 'StartIndex cannot be less than zero.');
    if ((length as number) < 0) failOutOfRange(call, 'length', 'Length cannot be less than zero.');
    if ((start as number) + (length as number) > text.length)
      failOutOfRange(call, 'length', 'Index and length must refer to a location within the string.');
    return text.slice(start as number, (start as number) + (length as number));
  },
});

function replaceIn(
  call: NativeCall,
  state: BuilderState,
  from: string,
  to: string,
  start: number,
  count: number
): void {
  // The scan of the range is charged before it runs, and the growth it finds before the text is built.
  reserve(call, state, 0, count);
  const growth = occurrencesIn(state.text, from, start, count) * (to.length - from.length);
  reserve(call, state, Math.max(0, growth));
  state.replace(from, to, start, count);
}

function setBuilder(receiver: Value, text: string, capacity: number): Value {
  (receiver as CsObject).native = new BuilderState(text, capacity);
  return undefined;
}

export { evaluatorOf };

/** The text before, inside, and after the range of `StringBuilder.Replace`, whose occurrences must lie inside it. */
function builderRange(call: NativeCall, text: string, start: number, count: number): [string, string, string] {
  const message = 'Index was out of range. Must be non-negative and less than or equal to the size of the collection.';
  if (start < 0 || start > text.length) failOutOfRange(call, 'startIndex', message);
  if (count < 0 || start + count > text.length) failOutOfRange(call, 'count', message);
  return [text.slice(0, start), text.slice(start, start + count), text.slice(start + count)];
}
