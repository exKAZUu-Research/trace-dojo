import { shared } from './bytesMethods';
// The ASCII case methods and predicates, hex conversions, and translation that bytes and bytearray share.
import {
  bytearrayClass,
  bytesClass,
  bytesLikeData,
  bytesPayload,
  latin1Text,
  PyBytes,
  requireBytesLike,
  sameKind,
} from './bytesValues';
import { method } from './define';
import { argument } from './nativeArgs';
import { toIndex } from './numbers';
import { callValue, lengthOf } from './objects';
import { currentRuntime } from './runtimeContext';
import { iterStr } from './strings';
import { None, stringValue, typeError, typeName, unbox, valueError } from './types';
import { isTitleSequence } from './unicodeCase';
import type { PyValue } from './values';

const dataOf = (self: PyValue): Uint8Array => bytesPayload(self).data;
const textOfBytes = (self: PyValue): string[] => latin1Text(dataOf(self)).split('');

const isUpper = (code: number): boolean => code >= 0x41 && code <= 0x5a;
const isLower = (code: number): boolean => code >= 0x61 && code <= 0x7a;
const isAlpha = (code: number): boolean => isUpper(code) || isLower(code);
const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;
const isSpace = (code: number): boolean => code === 0x20 || (code >= 0x09 && code <= 0x0d);
const toUpper = (code: number): number => (isLower(code) ? code - 0x20 : code);
const toLower = (code: number): number => (isUpper(code) ? code + 0x20 : code);

function mapBytes(self: PyValue, map: (code: number, index: number, data: Uint8Array) => number): PyBytes {
  const data = dataOf(self);
  currentRuntime().scan(data.length);
  return sameKind(
    bytesPayload(self),
    data.map((code, index) => map(code, index, data))
  );
}

// Case --------------------------------------------------------------------------------------------------------------

shared('upper', 'none', 0, 0, (self) => mapBytes(self, toUpper));
shared('lower', 'none', 0, 0, (self) => mapBytes(self, toLower));
shared('swapcase', 'none', 0, 0, (self) => mapBytes(self, (code) => (isUpper(code) ? toLower(code) : toUpper(code))));
shared('capitalize', 'none', 0, 0, (self) =>
  mapBytes(self, (code, index) => (index === 0 ? toUpper(code) : toLower(code)))
);
shared('title', 'none', 0, 0, (self) => {
  let previousCased = false;
  return mapBytes(self, (code) => {
    const result = previousCased ? toLower(code) : toUpper(code);
    previousCased = isAlpha(code);
    return result;
  });
});

// Predicates --------------------------------------------------------------------------------------------------------

function all(self: PyValue, test: (code: number) => boolean): boolean {
  const data = dataOf(self);
  return data.length > 0 && data.every(test);
}

shared('isalpha', 'none', 0, 0, (self) => all(self, isAlpha));
shared('isdigit', 'none', 0, 0, (self) => all(self, isDigit));
shared('isalnum', 'none', 0, 0, (self) => all(self, (code) => isAlpha(code) || isDigit(code)));
shared('isspace', 'none', 0, 0, (self) => all(self, isSpace));
shared('isascii', 'none', 0, 0, (self) => dataOf(self).every((code) => code < 0x80));
shared('islower', 'none', 0, 0, (self) => dataOf(self).some(isLower) && !dataOf(self).some(isUpper));
shared('isupper', 'none', 0, 0, (self) => dataOf(self).some(isUpper) && !dataOf(self).some(isLower));
shared('istitle', 'none', 0, 0, (self) =>
  isTitleSequence(
    textOfBytes(self),
    (char) => isUpper(char.codePointAt(0) as number),
    (char) => isLower(char.codePointAt(0) as number)
  )
);

// Hexadecimal -------------------------------------------------------------------------------------------------------

/** `data.hex(sep, bytes_per_sep)`, which bytes, bytearray, and memoryview share. */
export function hexOf(data: Uint8Array, sepValue: PyValue | undefined, groupValue: PyValue | undefined): string {
  const groupSize = Number(toIndex(groupValue ?? 1n));
  const sep = sepValue === undefined ? undefined : unbox(sepValue);
  const separator = sep === undefined || sep === None ? undefined : hexSeparator(sep);
  const group = separator === undefined ? 0 : groupSize;
  const size = Math.abs(group);
  const groupCount = group === 0 ? 1 : Math.ceil(data.length / size);
  currentRuntime().buildString(data.length * 2 + Math.max(0, groupCount - 1));
  const digits = [...data].map((byte) => byte.toString(16).padStart(2, '0'));
  if (separator === undefined || group === 0 || digits.length === 0) return digits.join('');
  const groups: string[] = [];
  if (group > 0) {
    for (let end = digits.length; end > 0; end -= size)
      groups.unshift(digits.slice(Math.max(0, end - size), end).join(''));
  } else {
    for (let start = 0; start < digits.length; start += size) groups.push(digits.slice(start, start + size).join(''));
  }
  return groups.join(separator);
}

function hexSeparator(sep: PyValue): string {
  const separator = stringValue(sep) ?? (sep instanceof PyBytes ? latin1Text(sep.data) : undefined);
  if (separator === undefined) lengthOf(sep);
  if (iterStr(separator ?? '').length !== 1) throw valueError('sep must be length 1.');
  if (((separator as string).codePointAt(0) as number) >= 0x80) throw valueError('sep must be ASCII.');
  return separator as string;
}

shared(
  'hex',
  'takes',
  0,
  2,
  (self, args, kwargs) =>
    hexOf(dataOf(self), argument(args, kwargs, 0, 'sep'), argument(args, kwargs, 1, 'bytes_per_sep')),
  { keywords: ['sep', 'bytes_per_sep'] }
);

for (const cls of [bytesClass, bytearrayClass]) {
  method(
    cls,
    'fromhex',
    'one',
    1,
    1,
    (owner, [text]) => {
      const value = new PyBytes(cls, fromHex(text));
      // A subclass gets the base type's value passed to its constructor, as CPython's fromhex does.
      return owner === cls ? value : callValue(owner, [value]);
    },
    { binding: 'class' }
  );
}

const HEX_DIGIT = /^[0-9a-fA-F]$/;

function fromHex(argumentValue: PyValue): Uint8Array {
  const value = unbox(argumentValue);
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    const data = bytesLikeData(value);
    if (data === undefined) throw typeError(`fromhex() argument must be str or bytes-like, not ${typeName(value)}`);
    text = latin1Text(data);
  }
  const chars = iterStr(text);
  const result: number[] = [];
  let index = 0;
  while (index < chars.length) {
    if (isSpace(chars[index].codePointAt(0) as number)) {
      index++;
      continue;
    }
    if (!HEX_DIGIT.test(chars[index])) throw nonHex(index);
    if (index + 1 >= chars.length) throw valueError('fromhex() arg must contain an even number of hexadecimal digits');
    if (!HEX_DIGIT.test(chars[index + 1])) throw nonHex(index + 1);
    result.push(Number.parseInt(chars[index] + chars[index + 1], 16));
    index += 2;
  }
  currentRuntime().buildString(result.length);
  return Uint8Array.from(result);
}

function nonHex(position: number): Error {
  return valueError(`non-hexadecimal number found in fromhex() arg at position ${position}`);
}

// Translation -------------------------------------------------------------------------------------------------------

for (const cls of [bytesClass, bytearrayClass]) {
  method(
    cls,
    'maketrans',
    'expected',
    2,
    2,
    (_self, [from, to]) => {
      const source = requireBytesLike(from);
      const target = requireBytesLike(to);
      if (source.length !== target.length) throw valueError('maketrans arguments must have same length');
      const table = Uint8Array.from({ length: 256 }, (_, index) => index);
      for (const [index, byte] of source.entries()) table[byte] = target[index];
      return new PyBytes(bytesClass, table);
    },
    { binding: 'static' }
  );
}

shared(
  'translate',
  'takes',
  1,
  2,
  (self, args, kwargs) => {
    const tableValue = args[0];
    const table = tableValue === None ? undefined : requireBytesLike(tableValue);
    if (table && table.length !== 256) throw valueError('translation table must be 256 characters long');
    const deleteValue = argument(args, kwargs, 1, 'delete');
    const deleted = new Set(deleteValue === undefined ? [] : requireBytesLike(deleteValue));
    const result: number[] = [];
    for (const byte of dataOf(self)) if (!deleted.has(byte)) result.push(table ? table[byte] : byte);
    return sameKind(bytesPayload(self), Uint8Array.from(result));
  },
  { keywords: ['delete'] }
);
