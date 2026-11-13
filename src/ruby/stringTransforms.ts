import { argumentError, rubyError } from './errors';
import { NIL, type RNil, RString } from './objects';
import { rt } from './runtime';
import { str, stringBytes, stringCharacters, stringFromBytes } from './values';

export function transformInvalid(self: RString, name: string, separator: RString | RNil | undefined): RString {
  if (['upcase', 'downcase', 'capitalize', 'swapcase'].includes(name)) throw argumentError('input string invalid');
  if (name === 'strip' || name === 'lstrip') {
    let start = 0;
    while (start < self.s.length && '\t\n\v\f\r '.includes(self.s[start])) start++;
    const point = self.s.codePointAt(start) ?? -1;
    if (point >= 0xdc_80 && point <= 0xdc_ff) throw argumentError('invalid byte sequence in UTF-8');
    if (name === 'lstrip') return str(self.s.slice(start));
  }
  if (name === 'rstrip' || name === 'strip')
    throw rubyError(rt().c['Encoding::CompatibilityError'], 'invalid byte sequence in UTF-8');
  const bytes = stringBytes(self);
  if (name === 'succ' || name === 'next') return stringFromBytes(succInvalidBytes(bytes));
  if (name === 'chop') return chopInvalidBytes(self, bytes);
  return chompInvalidBytes(bytes, separator);
}

function chopInvalidBytes(self: RString, bytes: Uint8Array): RString {
  const width =
    bytes.length >= 2 && bytes.at(-2) === 13 && bytes.at(-1) === 10
      ? 2
      : stringBytes(stringCharacters(self).at(-1) ?? str('')).length;
  return stringFromBytes(bytes.slice(0, bytes.length - width));
}

function chompInvalidBytes(bytes: Uint8Array, separator: RString | RNil | undefined): RString {
  if (separator === NIL) return stringFromBytes(bytes);
  const suffix = separator instanceof RString ? stringBytes(separator) : Uint8Array.of(10);
  if (suffix.length === 0) {
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 10) end -= end > 1 && bytes[end - 2] === 13 ? 2 : 1;
    return stringFromBytes(bytes.slice(0, end));
  }
  if (suffix.length === 1 && suffix[0] === 10) {
    if (bytes.at(-1) === 13) return stringFromBytes(bytes.slice(0, -1));
    if (bytes.at(-1) === 10) return stringFromBytes(bytes.slice(0, bytes.at(-2) === 13 ? -2 : -1));
  }
  const matches =
    bytes.length >= suffix.length &&
    suffix.every((byte, index) => byte === bytes[bytes.length - suffix.length + index]);
  return stringFromBytes(bytes.slice(0, matches ? bytes.length - suffix.length : bytes.length));
}

function succInvalidBytes(source: Uint8Array): Uint8Array {
  if (source.length === 0) return source;
  const bytes = [...source];
  let index = bytes.findLastIndex(isAsciiAlnum);
  let offset = 0;
  let multibyte: { offset: number; width: number; point: number } | undefined;
  for (const character of stringCharacters(stringFromBytes(source))) {
    const width = stringBytes(character).length;
    if (width > 1 && !character.rawBytes) multibyte = { offset, width, point: character.s.codePointAt(0) as number };
    offset += width;
  }
  if (multibyte && multibyte.offset > index) {
    const next = stringBytes(str(String.fromCodePoint(multibyte.point + 1)));
    return Uint8Array.from([
      ...bytes.slice(0, multibyte.offset),
      ...next,
      ...bytes.slice(multibyte.offset + multibyte.width),
    ]);
  }
  if (index < 0) return Uint8Array.from([1, ...bytes]);
  for (;;) {
    const byte = bytes[index];
    if (byte !== 57 && byte !== 90 && byte !== 122) {
      bytes[index]++;
      return Uint8Array.from(bytes);
    }
    const carry = byte === 57 ? 49 : byte === 90 ? 65 : 97;
    bytes[index] = byte === 57 ? 48 : byte === 90 ? 65 : 97;
    const previous = bytes.slice(0, index).findLastIndex(isAsciiAlnum);
    if (previous === -1) {
      bytes.splice(index, 0, carry);
      return Uint8Array.from(bytes);
    }
    index = previous;
  }
}

function isAsciiAlnum(byte: number): boolean {
  return (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122);
}
