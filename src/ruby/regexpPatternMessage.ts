import { LIMITS } from '../interpreter/limits';
import type { RString } from './objects';
import { rt } from './runtime';
import { stringBytes, stringFromBytes } from './values';

export interface RegexpOptions {
  ignoreCase?: boolean;
  multiline?: boolean;
  extended?: boolean;
  sourceBinary?: boolean;
  fixedEncoding?: boolean;
}

/** Ruby's message for a pattern whose bytes are invalid in its encoding, with those bytes shown as escapes. */
// code-gauge-allow functionCognitiveComplexity 16 -- One pass copies verbatim bytes and escapes the others into a shared bounded buffer.
export function invalidPatternMessage(pattern: RString, options: RegexpOptions): RString {
  const source = stringBytes(pattern);
  const result = new Uint8Array(LIMITS.maxStringLength);
  const decoder = pattern.usAscii ? undefined : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let length = 0;
  const appendByte = (byte: number): void => {
    rt().checkStringLength(length + 1);
    result[length++] = byte;
  };
  const appendAscii = (text: string): void => {
    for (const char of text) appendByte(char.codePointAt(0) ?? 0);
  };
  appendAscii('invalid multibyte character: /');
  rt().spend(Math.ceil(source.length / 256));
  for (let index = 0; index < source.length;) {
    const first = source[index];
    if (first === 92 || first < 0x80) {
      const count = first === 92 ? escapeLength(source, index, decoder) : 1;
      for (let offset = 0; offset < count; offset++) appendByte(source[index + offset]);
      index += count;
      continue;
    }
    const character = decoder && utf8CharacterAt(source, index, decoder);
    appendAscii(character ? unicodeEscape(character.point) : `\\x${first.toString(16).toUpperCase().padStart(2, '0')}`);
    index += character?.width ?? 1;
  }
  appendAscii(`/${regexpSuffix(options)}`);
  return stringFromBytes(result.subarray(0, length), false, pattern.usAscii);
}

export function regexpSuffix(options: RegexpOptions): string {
  return `${options.multiline ? 'm' : ''}${options.ignoreCase ? 'i' : ''}${options.extended ? 'x' : ''}`;
}

/** The bytes that a backslash at `index` keeps verbatim: itself and an escaped backslash or non-ASCII character. */
function escapeLength(source: Uint8Array, index: number, decoder: TextDecoder | undefined): number {
  const escaped = source[index + 1] ?? 0;
  if (escaped === 92) return 2;
  if (escaped < 0x80) return 1;
  return 1 + ((decoder && utf8CharacterAt(source, index + 1, decoder)?.width) ?? 1);
}

function utf8CharacterAt(
  source: Uint8Array,
  index: number,
  decoder: TextDecoder
): { point: number; width: number } | undefined {
  const first = source[index];
  const width = first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
  try {
    const point = decoder.decode(source.subarray(index, index + width)).codePointAt(0);
    return point === undefined ? undefined : { point, width };
  } catch {
    return undefined;
  }
}

function unicodeEscape(point: number): string {
  const digits = point.toString(16).toUpperCase();
  return point <= 0xff_ff ? `\\u${digits.padStart(4, '0')}` : `\\u{${digits}}`;
}
