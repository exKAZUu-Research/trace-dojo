// The str-like methods that bytes and bytearray share.
import {
  bytearrayClass,
  bytesClass,
  bytesLikeData,
  latin1Bytes,
  latin1Text,
  PyBytes,
  requireBytesLike,
  sameKind,
} from './bytesValues';
import { method } from './define';
import { argument } from './nativeArgs';
import { toIndex } from './numbers';
import { lookupSpecial, toArray } from './objects';
import { currentRuntime } from './runtimeContext';
import { byteValue } from './typeBytes';
import { newList, newTuple, None, typeError, typeName, valueError } from './types';
import { expandTabs, padText, replaceText, splitLinesOf, splitOn, splitWhitespace, stripBounds } from './typeStr';
import { PyTuple, type PyValue } from './values';

const dataOf = (self: PyValue): Uint8Array => (self as PyBytes).data;
const textOf = (self: PyValue): string => latin1Text((self as PyBytes).data);
const wrap = (self: PyValue, text: string): PyBytes => sameKind(self as PyBytes, latin1Bytes(text));

type MethodArgs = Parameters<typeof method> extends [unknown, ...infer Rest] ? Rest : never;

/** Defines a method on both bytes and bytearray. */
export function shared(...args: MethodArgs): void {
  for (const cls of [bytesClass, bytearrayClass]) method(cls, ...args);
}

// Searching ---------------------------------------------------------------------------------------------------------

/** The subsequence a search method looks for: an int byte value or a bytes-like object, as one char per byte. */
function needleOf(sub: PyValue): string {
  const data = bytesLikeData(sub);
  if (data !== undefined) return latin1Text(data);
  if (typeof sub !== 'bigint' && typeof sub !== 'boolean' && lookupSpecial(sub, '__index__') === undefined) {
    throw typeError(`argument should be integer or bytes-like object, not '${typeName(sub)}'`);
  }
  return String.fromCodePoint(byteValue(sub));
}

function bounds(length: number, start: PyValue | undefined, end: PyValue | undefined): { from: number; to: number } {
  const limit = BigInt(length);
  let from = start === undefined || start === None ? 0n : toIndex(start);
  let to = end === undefined || end === None ? limit : toIndex(end);
  if (from < 0n) {
    from += limit;
    if (from < 0n) from = 0n;
  }
  if (to < 0n) {
    to += limit;
    if (to < 0n) to = 0n;
  } else if (to > limit) {
    to = limit;
  }
  return { from: from > limit ? length + 1 : Number(from), to: Number(to) };
}

function findIn(
  text: string,
  needle: string,
  start: PyValue | undefined,
  end: PyValue | undefined,
  fromEnd: boolean
): number {
  currentRuntime().scan(text.length);
  const { from, to } = bounds(text.length, start, end);
  if (from > to || to - from < needle.length) return -1;
  if (needle === '') return fromEnd ? to : from;
  const region = text.slice(from, to);
  const index = fromEnd ? region.lastIndexOf(needle) : region.indexOf(needle);
  return index === -1 ? -1 : index + from;
}

for (const [name, fromEnd, raises] of [
  ['find', false, false],
  ['rfind', true, false],
  ['index', false, true],
  ['rindex', true, true],
] as const) {
  shared(name, 'expected', 1, 3, (self, [sub, start, end]) => {
    const index = findIn(textOf(self), needleOf(sub), start, end, fromEnd);
    if (index === -1 && raises) throw valueError('subsection not found');
    return BigInt(index);
  });
}

shared('count', 'expected', 1, 3, (self, [sub, start, end]) => {
  const text = textOf(self);
  const needle = needleOf(sub);
  currentRuntime().scan(text.length);
  const { from, to } = bounds(text.length, start, end);
  if (from > to) return 0n;
  if (needle === '') return BigInt(to - from + 1);
  const region = text.slice(from, to);
  let count = 0n;
  for (let index = region.indexOf(needle); index !== -1; index = region.indexOf(needle, index + needle.length)) count++;
  return count;
});

for (const [name, atEnd] of [
  ['startswith', false],
  ['endswith', true],
] as const) {
  shared(name, 'expected', 1, 3, (self, [prefix, start, end]) => {
    const text = textOf(self);
    const { from, to } = bounds(text.length, start, end);
    const singleData = prefix instanceof PyTuple ? undefined : bytesLikeData(prefix);
    if (!(prefix instanceof PyTuple) && singleData === undefined) {
      throw typeError(`${name} first arg must be bytes or a tuple of bytes, not ${typeName(prefix)}`);
    }
    const region = from > to ? '' : text.slice(from, to);
    const candidates = prefix instanceof PyTuple ? prefix.items : [prefix];
    return candidates.some((candidate) => {
      const affix = latin1Text(singleData ?? requireBytesLike(candidate));
      if (from > to) return false;
      return atEnd ? region.endsWith(affix) : region.startsWith(affix);
    });
  });
}

// Splitting and joining ---------------------------------------------------------------------------------------------

const ASCII_SPACE = new Set([0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d]);
const isSpaceByte = (code: number): boolean => ASCII_SPACE.has(code);

const isSpaceChar = (char: string): boolean => isSpaceByte(char.codePointAt(0) as number);

for (const [name, fromEnd] of [
  ['split', false],
  ['rsplit', true],
] as const) {
  shared(
    name,
    'takes',
    0,
    2,
    (self, args, kwargs) => {
      const sep = argument(args, kwargs, 0, 'sep') ?? None;
      const limit = Number(toIndex(argument(args, kwargs, 1, 'maxsplit') ?? -1n));
      const text = textOf(self);
      currentRuntime().scan(text.length);
      const make = (parts: string[]): PyValue => currentRuntime().listOf(parts.map((part) => wrap(self, part)));
      if (sep === None) return make(splitWhitespace(text, limit, fromEnd, isSpaceChar));
      const separator = latin1Text(requireBytesLike(sep));
      if (separator === '') throw valueError('empty separator');
      return make(splitOn(text, separator, limit, fromEnd));
    },
    { keywords: ['sep', 'maxsplit'] }
  );
}

shared(
  'splitlines',
  'takes',
  0,
  1,
  (self, args, kwargs) => {
    const keepends = currentRuntime().truthy(argument(args, kwargs, 0, 'keepends') ?? false);
    const lines = splitLinesOf(textOf(self).split(''), (char) => char === '\n' || char === '\r', keepends);
    return newList(lines.map((line) => wrap(self, line)));
  },
  { keywords: ['keepends'] }
);

shared('join', 'one', 1, 1, (self, [iterable]) => {
  const items = toArray(iterable);
  const separator = dataOf(self);
  const parts = items.map((item, index) => {
    const data = bytesLikeData(item);
    if (data === undefined) {
      throw typeError(`sequence item ${index}: expected a bytes-like object, ${typeName(item)} found`);
    }
    return data;
  });
  const total = parts.reduce((sum, part) => sum + part.length, 0) + separator.length * Math.max(parts.length - 1, 0);
  currentRuntime().buildString(total);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const [index, part] of parts.entries()) {
    if (index > 0) {
      result.set(separator, offset);
      offset += separator.length;
    }
    result.set(part, offset);
    offset += part.length;
  }
  return sameKind(self as PyBytes, result);
});

for (const [name, fromEnd] of [
  ['partition', false],
  ['rpartition', true],
] as const) {
  shared(name, 'one', 1, 1, (self, [sep]) => {
    const text = textOf(self);
    const separator = latin1Text(requireBytesLike(sep));
    if (separator === '') throw valueError('empty separator');
    const index = fromEnd ? text.lastIndexOf(separator) : text.indexOf(separator);
    const parts =
      index === -1
        ? fromEnd
          ? ['', '', text]
          : [text, '', '']
        : [text.slice(0, index), separator, text.slice(index + separator.length)];
    return newTuple(parts.map((part) => wrap(self, part)));
  });
}

// Stripping, padding, and replacing ---------------------------------------------------------------------------------

for (const [name, left, right] of [
  ['strip', true, true],
  ['lstrip', true, false],
  ['rstrip', false, true],
] as const) {
  shared(name, 'expected', 0, 1, (self, [chars]) => {
    const data = dataOf(self);
    const stripped = chars === undefined || chars === None ? undefined : new Set(requireBytesLike(chars));
    const [start, end] = stripBounds(data, stripped ? (code) => stripped.has(code) : isSpaceByte, left, right);
    return sameKind(self as PyBytes, data.slice(start, end));
  });
}

for (const [name, place] of [
  ['center', 'center'],
  ['ljust', 'left'],
  ['rjust', 'right'],
] as const) {
  shared(name, 'expected', 1, 2, (self, [width, fill]) => {
    const text = textOf(self);
    const fillChar = fill === undefined ? ' ' : fillByte(name, fill);
    return wrap(self, padText(text, text.length, Number(toIndex(width)), fillChar, place));
  });
}

function fillByte(name: string, fill: PyValue): string {
  if (!(fill instanceof PyBytes)) {
    throw typeError(`${name}() argument 2 must be a byte string of length 1, not ${typeName(fill)}`);
  }
  if (fill.length !== 1) {
    throw typeError(
      `${name}(): argument 2 must be a byte string of length 1, not a ${typeName(fill)} object of length ${fill.length}`
    );
  }
  return String.fromCodePoint(fill.data[0]);
}

shared('zfill', 'one', 1, 1, (self, [width]) => {
  const text = textOf(self);
  const target = Number(toIndex(width));
  if (text.length >= target) return sameKind(self as PyBytes, new Uint8Array(dataOf(self)));
  currentRuntime().buildString(target);
  const sign = text.startsWith('+') || text.startsWith('-') ? text[0] : '';
  return wrap(self, sign + '0'.repeat(target - text.length) + text.slice(sign.length));
});

shared(
  'expandtabs',
  'takes',
  0,
  1,
  (self, args, kwargs) => {
    const size = Number(toIndex(argument(args, kwargs, 0, 'tabsize') ?? 8n));
    return wrap(self, expandTabs(textOf(self).split(''), size));
  },
  { keywords: ['tabsize'] }
);

shared('replace', 'expected', 2, 3, (self, [oldValue, newValue, countValue]) => {
  const text = textOf(self);
  const old = latin1Text(requireBytesLike(oldValue));
  const replacement = latin1Text(requireBytesLike(newValue));
  return wrap(self, replaceText(text, old, replacement, Number(toIndex(countValue ?? -1n))));
});

for (const [name, atEnd] of [
  ['removeprefix', false],
  ['removesuffix', true],
] as const) {
  shared(name, 'one', 1, 1, (self, [affixValue]) => {
    const text = textOf(self);
    const affix = latin1Text(requireBytesLike(affixValue));
    if (affix === '' || !(atEnd ? text.endsWith(affix) : text.startsWith(affix))) {
      return sameKind(self as PyBytes, new Uint8Array(dataOf(self)));
    }
    return wrap(self, atEnd ? text.slice(0, text.length - affix.length) : text.slice(affix.length));
  });
}
