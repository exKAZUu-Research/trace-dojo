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
  if (name === 'succ' || name === 'next') return stringFromBytes(successorBytes(bytes));
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

export function successorBytes(source: Uint8Array): Uint8Array {
  if (source.length === 0) return source;
  const parts: { bytes: Uint8Array; point: number | undefined }[] = stringCharacters(stringFromBytes(source)).map(
    (character) => ({
      bytes: stringBytes(character),
      point: character.rawBytes ? undefined : character.s.codePointAt(0),
    })
  );
  const candidate = (part: (typeof parts)[number]): boolean =>
    part.point !== undefined && characterClass(part.point) !== undefined;
  let index = parts.findLastIndex(candidate);
  if (index < 0) {
    const last = parts.findLast((part) => part.point !== undefined);
    if (!last) return Uint8Array.from([1, ...source]);
    if (last.point === 0x10_ff_ff) {
      last.bytes = stringBytes(str(String.fromCodePoint(0x1_00_00)));
      parts.unshift({ bytes: Uint8Array.of(1), point: undefined });
      return Uint8Array.from(parts.flatMap((part) => [...part.bytes]));
    }
    last.bytes = stringBytes(str(String.fromCodePoint((last.point as number) + 1)));
    return Uint8Array.from(parts.flatMap((part) => [...part.bytes]));
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

function characterClass(point: number): 'digit' | 'letter' | undefined {
  if (point > 0x10_ff_ff) return undefined;
  const character = String.fromCodePoint(point);
  if (/\p{Nd}/u.test(character)) return 'digit';
  if (/[\p{L}\p{Nl}]/u.test(character)) return 'letter';
  return undefined;
}
