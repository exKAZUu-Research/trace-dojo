// oxlint-disable unicorn/prefer-code-point -- C# characters are UTF-16 code units, which code points would merge.
import { defineNatives, type NativeCall, type NativeMethod } from '../natives';
import { compareCulture, primitiveHash, unboxed } from '../objects';
import type { NativeState } from '../runtime';
import { specialOf, type Type } from '../types';
import { type CsArray, CsObject, type Value, type VariableReference } from '../values';
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

/** `StringComparison`'s values, of which the odd ones ignore case and those from 4 compare ordinally. */
function compareWith(a: string, b: string, comparison: number): number {
  const ignoreCase = comparison % 2 === 1;
  // An ordinal comparison gives the difference of the first differing characters, as .NET's does.
  if (comparison >= 4)
    return ordinalDifference(ignoreCase ? caseMappedText(a, true) : a, ignoreCase ? caseMappedText(b, true) : b);
  return compareCulture(a, b, ignoreCase);
}

function equalsWith(a: string, b: string, comparison: number): boolean {
  if (comparison % 2 === 1) return a.toUpperCase() === b.toUpperCase();
  if (comparison >= 4) return a === b;
  return compareCulture(a, b) === 0 && a.length === b.length ? a === b || compareCulture(a, b) === 0 : false;
}

function receiverText(receiver: Value): string {
  if (receiver === undefined)
    fail('System.NullReferenceException', 'Object reference not set to an instance of an object.');
  return receiver as string;
}

/** The characters `Trim` removes by default: Unicode whitespace. */
const WHITESPACE = /[\s\u0085]/u;

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
      typeof item === 'number' ? String.fromCodePoint(item) : (item as string)
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
    const piece = trimEntries ? part.trim() : part;
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
  push(text.slice(start));
  return parts;
}

function joinValues(call: NativeCall, separator: string, args: Value[], startIndex = 1): string {
  const parameters = call.method.parameters;
  const last = args[startIndex];
  const parameter = parameters[startIndex];
  const separatorText = separator;
  let items: string[];
  if (parameter.type.kind === 'array') {
    if (args.length > startIndex + 1) {
      const array = (last as CsArray).values.slice(
        args[startIndex + 1] as number,
        (args[startIndex + 1] as number) + (args[startIndex + 2] as number)
      );
      items = array.map((item) => (item === undefined ? '' : (item as string)));
    } else {
      const elementType = parameter.type.element;
      items = arrayValues(last).map((item) => textOf(call, item, elementType));
    }
  } else {
    const elementType = call.typeArgs[0] ?? libraryType(call, STRING);
    items = [];
    for (const item of iterate(call, last)) items.push(textOf(call, item, elementType));
  }
  const text = items.join(separatorText);
  call.frame.runtime.allocateString(text.length);
  return text;
}

const stringNatives: Record<string, NativeMethod> = {
  [`${STRING}..ctor(char, int)`]: (call, _receiver, [char, count]) => {
    if ((count as number) < 0) failNegative(call, 'count', count as number);
    call.frame.runtime.allocateString(count as number);
    return String.fromCodePoint(char as number).repeat(count as number);
  },
  [`${STRING}..ctor(char[]?)`]: (_call, _receiver, [chars]) => charsOf(chars as Value).join(''),
  [`${STRING}..ctor(char[], int, int)`]: (_call, _receiver, [chars, start, length]) =>
    charsOf(chars as Value)
      .slice(start as number, (start as number) + (length as number))
      .join(''),
  [`${STRING}.get_Length`]: (_call, receiver) => receiverText(receiver).length,
  [`${STRING}.get_Item`]: (_call, receiver, [index]) => {
    const text = receiverText(receiver);
    const position = index as number;
    if (position < 0 || position >= text.length)
      fail('System.IndexOutOfRangeException', 'Index was outside the bounds of the array.');
    return text.charCodeAt(position);
  },
  [`${STRING}.Clone`]: (_call, receiver) => receiver,
  [`${STRING}.CompareTo`]: (_call, receiver, [other]) =>
    other === undefined ? 1 : compareCulture(receiverText(receiver), unboxed(other as Value) as string),
  [`${STRING}.Contains(string)`]: (_call, receiver, [value]) => {
    if (value === undefined) failNull('value');
    return receiverText(receiver).includes(value as string);
  },
  [`${STRING}.Contains(char)`]: (_call, receiver, [value]) =>
    receiverText(receiver).includes(String.fromCodePoint(value as number)),
  [`${STRING}.Contains(string, StringComparison)`]: (_call, receiver, [value, comparison]) =>
    (comparison as number) % 2 === 1
      ? receiverText(receiver)
          .toUpperCase()
          .includes((value as string).toUpperCase())
      : receiverText(receiver).includes(value as string),
  [`${STRING}.Contains(char, StringComparison)`]: (_call, receiver, [value, comparison]) =>
    (comparison as number) % 2 === 1
      ? receiverText(receiver)
          .toUpperCase()
          .includes(String.fromCodePoint(value as number).toUpperCase())
      : receiverText(receiver).includes(String.fromCodePoint(value as number)),
  [`${STRING}.StartsWith(string)`]: (_call, receiver, [value]) => {
    if (value === undefined) failNull('value');
    return receiverText(receiver).startsWith(value as string);
  },
  [`${STRING}.StartsWith(char)`]: (_call, receiver, [value]) =>
    receiverText(receiver).startsWith(String.fromCodePoint(value as number)),
  [`${STRING}.StartsWith(string, StringComparison)`]: (_call, receiver, [value, comparison]) =>
    (comparison as number) % 2 === 1
      ? receiverText(receiver)
          .toUpperCase()
          .startsWith((value as string).toUpperCase())
      : receiverText(receiver).startsWith(value as string),
  [`${STRING}.EndsWith(string)`]: (_call, receiver, [value]) => {
    if (value === undefined) failNull('value');
    return receiverText(receiver).endsWith(value as string);
  },
  [`${STRING}.EndsWith(char)`]: (_call, receiver, [value]) =>
    receiverText(receiver).endsWith(String.fromCodePoint(value as number)),
  [`${STRING}.EndsWith(string, StringComparison)`]: (_call, receiver, [value, comparison]) =>
    (comparison as number) % 2 === 1
      ? receiverText(receiver)
          .toUpperCase()
          .endsWith((value as string).toUpperCase())
      : receiverText(receiver).endsWith(value as string),
  [`${STRING}.Equals(object?)`]: (_call, receiver, [other]) => receiver === other,
  [`${STRING}.Equals(string?)`]: (_call, receiver, [other]) => receiver === other,
  [`${STRING}.Equals(string?, StringComparison)`]: (_call, receiver, [other, comparison]) =>
    other !== undefined && equalsWith(receiverText(receiver), other as string, comparison as number),
  [`${STRING}.Equals(string?, string?)`]: (_call, _receiver, [a, b]) => a === b,
  [`${STRING}.Equals(string?, string?, StringComparison)`]: (_call, _receiver, [a, b, comparison]) =>
    a === undefined || b === undefined ? a === b : equalsWith(a as string, b as string, comparison as number),
  [`${STRING}.GetHashCode`]: (_call, receiver) => primitiveHash(receiver as string) ?? 0,
  [`${STRING}.GetEnumerator`]: (call, receiver) => {
    const enumerator = new CsObject(libraryType(call, 'System.CharEnumerator'), []);
    enumerator.native = new CharEnumeratorState(receiverText(receiver));
    return enumerator;
  },
  [`${STRING}.IndexOf`]: (call, receiver, args) => indexOf(call, receiverText(receiver), args as Value[], false),
  [`${STRING}.LastIndexOf`]: (call, receiver, args) => indexOf(call, receiverText(receiver), args as Value[], true),
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
    return text.slice(0, index as number) + (value as string) + text.slice(index as number);
  },
  [`${STRING}.PadLeft`]: (call, receiver, [width, char = 32]) => {
    if ((width as number) < 0) failNegative(call, 'totalWidth', width as number);
    return receiverText(receiver).padStart(width as number, String.fromCodePoint(char as number));
  },
  [`${STRING}.PadRight`]: (call, receiver, [width, char = 32]) => {
    if ((width as number) < 0) failNegative(call, 'totalWidth', width as number);
    return receiverText(receiver).padEnd(width as number, String.fromCodePoint(char as number));
  },
  [`${STRING}.Remove(int)`]: (call, receiver, [start]) => {
    const text = receiverText(receiver);
    if ((start as number) < 0) failOutOfRange(call, 'startIndex', 'StartIndex cannot be less than zero.');
    if ((start as number) > text.length)
      failOutOfRange(call, 'startIndex', 'startIndex cannot be larger than length of string.');
    if ((start as number) === text.length)
      failOutOfRange(call, 'startIndex', 'startIndex must be less than length of string.');
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
    const text = receiverText(receiver).replaceAll(from as string, (to as string | undefined) ?? '');
    call.frame.runtime.allocateString(text.length);
    return text;
  },
  [`${STRING}.Replace(string, string?, StringComparison)`]: (_call, receiver, [from, to, comparison]) => {
    const text = receiverText(receiver);
    if ((comparison as number) % 2 === 0) return text.replaceAll(from as string, (to as string | undefined) ?? '');
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
      [...receiverText(receiver)].flatMap((char) => [...char].map((unit) => unit.charCodeAt(0)))
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
  [`${STRING}.ToUpperInvariant`]: (_call, receiver) => caseMappedText(receiverText(receiver), true),
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
  [`${STRING}.TrimEnd(char[]?)`]: (_call, receiver, [chars]) =>
    trimWith(receiverText(receiver), charsOf(chars as Value), false, true),
  [`${STRING}.IsNormalized`]: (_call, receiver) => receiverText(receiver) === receiverText(receiver).normalize(),
  [`${STRING}.Compare`]: (_call, _receiver, args) => {
    const [a, b] = args as (string | undefined)[];
    if (args.length === 5) {
      const [strA, indexA, strB, indexB, length] = args as [string, number, string, number, number];
      return compareCulture(strA.slice(indexA, indexA + length), strB.slice(indexB, indexB + length));
    }
    if (a === undefined) return b === undefined ? 0 : -1;
    if (b === undefined) return 1;
    if (typeof args[2] === 'boolean') return compareCulture(a, b, args[2]);
    if (typeof args[2] === 'number') return compareWith(a, b, args[2]);
    return compareCulture(a, b);
  },
  [`${STRING}.CompareOrdinal`]: (_call, _receiver, [a, b]) => {
    if (a === undefined) return b === undefined ? 0 : -1;
    if (b === undefined) return 1;
    return ordinalDifference(a as string, b as string);
  },
  [`${STRING}.Concat`]: (call, _receiver, args) => {
    const parameters = call.method.parameters;
    let text = '';
    if (parameters.length === 1 && (parameters[0].type.kind === 'array' || parameters[0].isParams)) {
      for (const item of arrayValues(args[0] as Value))
        text += textOf(
          call,
          item,
          (parameters[0].type as { element?: Type }).element ?? libraryType(call, 'System.Object')
        );
    } else if (
      parameters.length === 1 &&
      parameters[0].type.kind === 'named' &&
      specialOf(parameters[0].type) !== 'object'
    ) {
      const elementType = call.typeArgs[0] ?? libraryType(call, STRING);
      for (const item of iterate(call, args[0] as Value)) text += textOf(call, item, elementType);
    } else {
      for (const [index, arg] of args.entries()) text += textOf(call, arg as Value, parameterType(call, index));
    }
    call.frame.runtime.allocateString(text.length);
    return text;
  },
  [`${STRING}.Copy`]: (_call, _receiver, [text]) => text as string,
  [`${STRING}.Format`]: (call, _receiver, args) => formatCall(call, args as Value[]),
  [`${STRING}.IsNullOrEmpty`]: (_call, _receiver, [value]) => value === undefined || value === '',
  [`${STRING}.IsNullOrWhiteSpace`]: (_call, _receiver, [value]) =>
    value === undefined || trimWith(value as string, undefined, true, true) === '',
  [`${STRING}.Join`]: (call, _receiver, args) => {
    if (args.length === 2 && args[1] === undefined) failNull('value');
    const separator =
      args[0] === undefined ? '' : typeof args[0] === 'number' ? String.fromCodePoint(args[0]) : (args[0] as string);
    return joinValues(call, separator, args as Value[]);
  },
  [`${STRING}.op_Equality`]: (_call, _receiver, [a, b]) => a === b,
  [`${STRING}.op_Inequality`]: (_call, _receiver, [a, b]) => a !== b,
};
defineNatives(stringNatives);

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

function indexOf(call: NativeCall, text: string, args: Value[], fromEnd: boolean): number {
  const value = args[0];
  if (value === undefined) failNull('value');
  const needle = typeof value === 'number' ? String.fromCodePoint(value) : (value as string);
  const { start, count, ignoreCase } = searchArguments(call, args, fromEnd ? text.length - 1 : 0);
  const haystack = ignoreCase ? text.toUpperCase() : text;
  const target = ignoreCase ? needle.toUpperCase() : needle;
  if (fromEnd) return lastIndexFrom(call, text, haystack, target, start);
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
  const found = haystack.indexOf(target, start);
  if (found === -1 || (count !== undefined && found + target.length > start + count)) return -1;
  return found;
}

function searchArguments(
  call: NativeCall,
  args: Value[],
  defaultStart: number
): { start: number; count: number | undefined; ignoreCase: boolean } {
  let start = defaultStart;
  let count: number | undefined;
  let ignoreCase = false;
  for (const [index, parameter] of call.method.parameters.entries()) {
    if (index === 0) continue;
    if (parameter.name === 'startIndex') start = args[index] as number;
    else if (parameter.name === 'count') count = args[index] as number;
    else if (parameter.name === 'comparisonType') ignoreCase = (args[index] as number) % 2 === 1;
  }
  return { start, count, ignoreCase };
}

function lastIndexFrom(call: NativeCall, text: string, haystack: string, target: string, start: number): number {
  if (text.length === 0) return target === '' ? 0 : -1;
  if (start < 0 || start >= text.length)
    failOutOfRange(
      call,
      'startIndex',
      'Index was out of range. Must be non-negative and less than the size of the collection.'
    );
  const last = start - target.length + 1;
  if (last >= 0) return haystack.lastIndexOf(target, last);
  return haystack.lastIndexOf(target, target === '' ? start : -1);
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
    const [value, index] = args as Value[];
    if (typeof value === 'string') return test(value.charAt(index as number));
    return test(String.fromCodePoint(value as number));
  };

defineNatives({
  [`${CHAR}.ToString()`]: (_call, receiver) => String.fromCodePoint(unboxed(receiver) as number),
  [`${CHAR}.ToString(char)`]: (_call, _receiver, [value]) => String.fromCodePoint(value as number),
  [`${CHAR}.Equals`]: (_call, receiver, [other]) => unboxed(receiver) === unboxed(other as Value),
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
  [`${CHAR}.IsWhiteSpace`]: charTest((char) => /[\s\u0085]/u.test(char)),
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
  [`${CHAR}.ToUpperInvariant`]: (_call, _receiver, [value]) => caseMapped(value as number, true),
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
  [`${CHAR}.ConvertToUtf32`]: (_call, _receiver, [high, low]) =>
    ((high as number) - 0xd8_00) * 0x4_00 + ((low as number) - 0xdc_00) + 0x1_00_00,
});

/** A character's case mapping, which keeps characters whose mapping is longer than one character. */
/**
 * .NET's simple case mapping of a character, which keeps one character: `ß` stays as JavaScript's `SS` would expand
 * it, and `İ` lowers to `i` without JavaScript's combining dot.
 */
function caseMapped(code: number, upper: boolean): number {
  const char = String.fromCharCode(code);
  const mapped = upper ? char.toUpperCase() : char.toLowerCase();
  if (mapped.length === 1) return mapped.charCodeAt(0);
  return !upper && /^.\p{M}+$/u.test(mapped) ? mapped.charCodeAt(0) : code;
}

/** Maps each character of a text as `ToUpper` and `ToLower` do, without JavaScript's context-sensitive rules. */
function caseMappedText(text: string, upper: boolean): string {
  let result = '';
  for (let index = 0; index < text.length; index++)
    result += String.fromCharCode(caseMapped(text.charCodeAt(index), upper));
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

// ---- StringBuilder ----

const BUILDER = 'System.Text.StringBuilder';

/** A StringBuilder's text, which `Append` and the other methods change in place. */
class BuilderState implements NativeState {
  constructor(public text: string) {}

  references(): Value[] {
    return [];
  }
}

function builder(receiver: Value): BuilderState {
  return (receiver as CsObject).native as BuilderState;
}

function append(call: NativeCall, receiver: Value, text: string): Value {
  const state = builder(receiver);
  call.frame.runtime.allocateString(state.text.length + text.length, text.length);
  state.text += text;
  return receiver;
}

defineNatives({
  [`${BUILDER}..ctor()`]: (_call, receiver) => setBuilder(receiver, ''),
  [`${BUILDER}..ctor(int)`]: (_call, receiver) => setBuilder(receiver, ''),
  [`${BUILDER}..ctor(string?)`]: (_call, receiver, [text]) => setBuilder(receiver, (text as string | undefined) ?? ''),
  [`${BUILDER}.get_Length`]: (_call, receiver) => builder(receiver).text.length,
  [`${BUILDER}.set_Length`]: (call, receiver, [length]) => {
    if ((length as number) < 0) failNegative(call, 'value', length as number);
    const state = builder(receiver);
    state.text = state.text.slice(0, length as number).padEnd(length as number, '\0');
    return;
  },
  [`${BUILDER}.get_Capacity`]: (_call, receiver) => Math.max(16, builder(receiver).text.length),
  [`${BUILDER}.set_Capacity`]: () => {},
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
      return append(call, receiver, String.fromCodePoint(args[0] as number).repeat(count));
    }
    if (parameters.length === 3)
      return append(
        call,
        receiver,
        ((args[0] as string | undefined) ?? '').slice(args[1] as number, (args[1] as number) + (args[2] as number))
      );
    const value = args[0] as Value;
    if (parameters[0].type.kind === 'array') return append(call, receiver, charsOf(value).join(''));
    if (value instanceof CsObject && value.native instanceof BuilderState)
      return append(call, receiver, value.native.text);
    return append(call, receiver, textOf(call, value, parameterType(call, 0)));
  },
  [`${BUILDER}.AppendLine`]: (call, receiver, args) =>
    append(call, receiver, `${(args[0] as string | undefined) ?? ''}\n`),
  [`${BUILDER}.AppendFormat`]: (call, receiver, args) => append(call, receiver, formatCall(call, args as Value[])),
  [`${BUILDER}.AppendJoin`]: (call, receiver, args) => {
    const separator =
      typeof args[0] === 'number' ? String.fromCodePoint(args[0]) : ((args[0] as string | undefined) ?? '');
    return append(call, receiver, joinValues(call, separator, args as Value[]));
  },
  [`${BUILDER}.Clear`]: (_call, receiver) => {
    builder(receiver).text = '';
    return receiver;
  },
  [`${BUILDER}.Equals`]: (_call, receiver, [other]) =>
    other instanceof CsObject && other.native instanceof BuilderState && other.native.text === builder(receiver).text,
  [`${BUILDER}.Insert`]: (call, receiver, args) => {
    const state = builder(receiver);
    const index = args[0] as number;
    if (index < 0 || index > state.text.length)
      failOutOfRange(
        call,
        'index',
        'Index was out of range. Must be non-negative and less than or equal to the size of the collection.'
      );
    let text =
      call.method.parameters.length === 3
        ? ((args[1] as string | undefined) ?? '').repeat(args[2] as number)
        : textOf(call, args[1] as Value, parameterType(call, 1));
    if (call.method.parameters[1].type.kind === 'named' && specialOf(call.method.parameters[1].type) === 'char')
      text = String.fromCodePoint(args[1] as number);
    state.text = state.text.slice(0, index) + text + state.text.slice(index);
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
    state.text = state.text.slice(0, start as number) + state.text.slice((start as number) + (length as number));
    return receiver;
  },
  [`${BUILDER}.Replace(char, char)`]: (_call, receiver, [from, to]) => {
    const state = builder(receiver);
    state.text = state.text.replaceAll(String.fromCodePoint(from as number), String.fromCodePoint(to as number));
    return receiver;
  },
  [`${BUILDER}.Replace(string, string?)`]: (_call, receiver, [from, to]) => {
    if (from === undefined) failNull('oldValue');
    if (from === '') fail('System.ArgumentException', 'The value cannot be an empty string.', 'oldValue');
    const state = builder(receiver);
    state.text = state.text.replaceAll(from as string, (to as string | undefined) ?? '');
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

function setBuilder(receiver: Value, text: string): Value {
  (receiver as CsObject).native = new BuilderState(text);
  return undefined;
}

export { evaluatorOf };
