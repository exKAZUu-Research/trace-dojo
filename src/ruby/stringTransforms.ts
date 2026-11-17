import { stringEncodingName } from './conversions';
import { argumentError, rubyError } from './errors';
import { validStringEncoding } from './libEncoding';
import { type RNil, RString } from './objects';
import { rt } from './runtime';
import { str, stringBytes, stringCharacters, stringFromBytes } from './values';

// code-gauge-allow functionCognitiveComplexity 20 -- Each transform retains the charset-specific validation and output metadata of the same byte sequence.
export function transformEncodedBytes(self: RString, name: string): RString {
  if (['upcase', 'downcase', 'capitalize', 'swapcase'].includes(name)) {
    if (!self.usAscii) throw argumentError('input string invalid');
    return stringFromBytes(asciiCaseBytes(stringBytes(self), name), false, true);
  }
  if (name === 'strip' || name === 'lstrip') {
    let start = 0;
    while (start < self.s.length && '\t\n\v\f\r '.includes(self.s[start])) start++;
    const point = self.s.codePointAt(start) ?? -1;
    if (!self.usAscii && point >= 0xdc_80 && point <= 0xdc_ff) throw argumentError('invalid byte sequence in UTF-8');
    if (name === 'lstrip') return stringFromBytes(stringBytes(self).slice(start), false, self.usAscii);
  }
  if (name === 'rstrip' || name === 'strip')
    throw rubyError(
      rt().c['Encoding::CompatibilityError'],
      self.usAscii ? 'invalid byte sequence in US-ASCII' : 'invalid byte sequence in UTF-8'
    );
  const bytes = stringBytes(self);
  if (name === 'succ' || name === 'next')
    return stringFromBytes(successorBytes(bytes, false, self.usAscii), false, self.usAscii);
  return chopInvalidBytes(self, bytes);
}

function asciiCaseBytes(bytes: Uint8Array, name: string): Uint8Array {
  return bytes.map((byte, index) => {
    const upper = name === 'upcase' || (name === 'capitalize' && index === 0);
    if (byte >= 97 && byte <= 122 && (upper || name === 'swapcase')) return byte - 32;
    if (byte >= 65 && byte <= 90 && !upper) return byte + 32;
    return byte;
  });
}

function chopInvalidBytes(self: RString, bytes: Uint8Array): RString {
  const width =
    bytes.length >= 2 && bytes.at(-2) === 13 && bytes.at(-1) === 10
      ? 2
      : self.usAscii
        ? 1
        : stringBytes(stringCharacters(self).at(-1) ?? str('')).length;
  return stringFromBytes(bytes.slice(0, bytes.length - width), false, self.usAscii);
}

// code-gauge-allow functionCognitiveComplexity 24 -- Native paragraph, newline, length and encoding stages share ordered suffix boundaries.
export function chompBytes(self: RString, separator: RString | RNil): RString {
  const bytes = stringBytes(self);
  const result = (value: Uint8Array): RString => stringFromBytes(value, self.binary, self.usAscii);
  if (!(separator instanceof RString) || bytes.length === 0) return result(bytes);
  const suffix = stringBytes(separator);
  if (suffix.length === 0) {
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 10) end -= end > 1 && bytes[end - 2] === 13 ? 2 : 1;
    return result(bytes.slice(0, end));
  }
  if (suffix.length > bytes.length) return result(bytes);
  if (suffix.length === 1 && suffix[0] === 10) {
    if (bytes.at(-1) === 13) return result(bytes.slice(0, -1));
    if (bytes.at(-1) === 10) return result(bytes.slice(0, bytes.at(-2) === 13 ? -2 : -1));
  }
  if (
    stringEncodingName(self) !== stringEncodingName(separator) &&
    bytes.some((byte) => byte >= 0x80) &&
    suffix.some((byte) => byte >= 0x80)
  )
    throw rubyError(
      rt().c['Encoding::CompatibilityError'],
      `incompatible character encodings: ${stringEncodingName(self)} and ${stringEncodingName(separator)}`
    );
  if (!validStringEncoding(separator)) return result(bytes);
  const matches = suffix.every((byte, index) => byte === bytes[bytes.length - suffix.length + index]);
  return result(bytes.slice(0, matches ? bytes.length - suffix.length : bytes.length));
}

export function successorBytes(source: Uint8Array, binary = false, usAscii = false): Uint8Array {
  if (source.length === 0) return source;
  if (
    binary &&
    !source.some((byte) => (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122))
  )
    return incrementBinaryBytes(source);
  const parts: { bytes: Uint8Array; point: number | undefined }[] = stringCharacters(
    stringFromBytes(source, binary, usAscii)
  ).map((character) => ({
    bytes: stringBytes(character),
    point:
      (character.rawBytes && !binary) || (binary && (character.s.codePointAt(0) as number) >= 128)
        ? undefined
        : character.s.codePointAt(0),
  }));
  const candidate = (part: (typeof parts)[number]): boolean =>
    part.point !== undefined && characterClass(part.point) !== undefined;
  let index = parts.findLastIndex(candidate);
  if (index < 0) {
    for (let position = parts.length - 1; position >= 0; position--) {
      const part = parts[position];
      if (part.point === undefined) continue;
      const wrapped =
        part.point === 0x7f
          ? 0
          : part.point === 0x7_ff
            ? 0x80
            : part.point === 0xff_ff
              ? 0x8_00
              : part.point === 0x10_ff_ff
                ? 0x1_00_00
                : undefined;
      if (wrapped !== undefined) {
        part.bytes = stringBytes(str(String.fromCodePoint(wrapped)));
        continue;
      }
      part.bytes = stringBytes(str(String.fromCodePoint(part.point + 1)));
      return Uint8Array.from(parts.flatMap((item) => [...item.bytes]));
    }
    return Uint8Array.from([1, ...parts.flatMap((part) => [...part.bytes])]);
  }
  let carry: Uint8Array = Uint8Array.of(1);
  for (;;) {
    const part = parts[index];
    const kind = characterClass(part.point as number);
    if (part.bytes.length > 1) {
      const point = part.point as number;
      if (characterClass(point + 1) === kind) {
        part.bytes = stringBytes(str(String.fromCodePoint(point + 1)));
        break;
      }
      let start = point;
      while (start > 0 && characterClass(start - 1) === kind) {
        rt().spend();
        start--;
      }
      part.bytes = stringBytes(str(String.fromCodePoint(start)));
      carry = stringBytes(str(String.fromCodePoint(kind === 'digit' ? start + 1 : start)));
    } else {
      const byte = part.bytes[0];
      if (byte !== 57 && byte !== 90 && byte !== 122) {
        part.bytes = Uint8Array.of(byte + 1);
        break;
      }
      carry = Uint8Array.of(byte === 57 ? 49 : byte === 90 ? 65 : 97);
      part.bytes = Uint8Array.of(byte === 57 ? 48 : byte === 90 ? 65 : 97);
    }
    const previous = parts.slice(0, index).findLastIndex(candidate);
    const separated = previous !== -1 && previous < index - 1;
    if (
      previous === -1 ||
      (separated &&
        part.bytes.length === 1 &&
        parts[previous].bytes.length === 1 &&
        characterClass(parts[previous].point as number) !== kind)
    ) {
      parts.splice(index, 0, { bytes: carry, point: undefined });
      break;
    }
    index = previous;
  }
  return Uint8Array.from(parts.flatMap((part) => [...part.bytes]));
}

function incrementBinaryBytes(source: Uint8Array): Uint8Array {
  const bytes = Uint8Array.from(source);
  for (let index = bytes.length - 1; index >= 0; index--) {
    if (bytes[index] < 255) {
      bytes[index]++;
      return bytes;
    }
    bytes[index] = 0;
  }
  return Uint8Array.from([1, ...bytes]);
}

function characterClass(point: number): 'digit' | 'letter' | undefined {
  if (point > 0x10_ff_ff) return undefined;
  const character = String.fromCodePoint(point);
  if (/\p{Nd}/u.test(character)) return 'digit';
  if (/[\p{L}\p{Nl}]/u.test(character)) return 'letter';
  return undefined;
}
