// The unicode_escape codec, which `ast.unparse` writes f-strings with.
import { type ErrorHandling, registerCodec } from './codecs';
import { lookupName } from './unicodeDatabase';

registerCodec('unicode_escape', () => ({ name: 'unicodeescape', encode, decode }));

const ENCODED_ESCAPES: Record<number, string> = {
  0x09: String.raw`\t`,
  0x0a: String.raw`\n`,
  0x0d: String.raw`\r`,
  0x5c: String.raw`\\`,
};
const DECODED_ESCAPES: Record<string, string> = {
  '\n': '',
  '\\': '\\',
  "'": "'",
  '"': '"',
  a: '\u0007',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
};

const hex = (value: number, width: number): string => value.toString(16).padStart(width, '0');

/** Writes printable ASCII as itself and every other code point as a Python escape sequence. */
function encode(points: readonly number[]): Uint8Array {
  let text = '';
  for (const point of points) {
    if (ENCODED_ESCAPES[point] !== undefined) text += ENCODED_ESCAPES[point];
    else if (point >= 0x20 && point < 0x7f) text += String.fromCodePoint(point);
    else if (point < 0x1_00) text += `\\x${hex(point, 2)}`;
    else if (point < 0x1_00_00) text += `\\u${hex(point, 4)}`;
    else text += `\\U${hex(point, 8)}`;
  }
  return Uint8Array.from(text, (char) => char.codePointAt(0) as number);
}

/** Reads the bytes as latin-1 text, decoding the escape sequences of a Python string literal. */
function decode(data: Uint8Array, errors: ErrorHandling): string {
  let text = '';
  let index = 0;
  while (index < data.length) {
    const byte = data[index++];
    if (byte !== 0x5c) {
      text += String.fromCodePoint(byte);
      continue;
    }
    if (index >= data.length) {
      const { text: replacement, resume } = errors.decodeError(index - 1, index, String.raw`\ at end of string`);
      text += replacement;
      index = resume;
      continue;
    }
    const decoded = decodeEscape(data, index, errors);
    text += decoded.text;
    index = decoded.resume;
  }
  return text;
}

/** Decodes the escape sequence whose letter is at `start`, just after its backslash. */
function decodeEscape(data: Uint8Array, start: number, errors: ErrorHandling): { text: string; resume: number } {
  const char = String.fromCodePoint(data[start]);
  if (DECODED_ESCAPES[char] !== undefined) return { text: DECODED_ESCAPES[char], resume: start + 1 };
  if (/[0-7]/.test(char)) {
    let end = start;
    while (end < Math.min(data.length, start + 3) && /[0-7]/.test(String.fromCodePoint(data[end]))) end++;
    return {
      text: String.fromCodePoint(Number.parseInt(String.fromCodePoint(...data.subarray(start, end)), 8)),
      resume: end,
    };
  }
  const width = { x: 2, u: 4, U: 8 }[char];
  if (width !== undefined) return hexEscape(data, start, width, errors);
  if (char === 'N') return namedEscape(data, start, errors);
  return { text: `\\${char}`, resume: start + 1 };
}

function hexEscape(
  data: Uint8Array,
  start: number,
  width: number,
  errors: ErrorHandling
): { text: string; resume: number } {
  let end = start + 1;
  while (end < Math.min(data.length, start + 1 + width) && /[\da-f]/i.test(String.fromCodePoint(data[end]))) end++;
  const label = { 2: 'xXX', 4: 'uXXXX', 8: 'UXXXXXXXX' }[width] as string;
  if (end - start - 1 < width) return errors.decodeError(start - 1, end, `truncated \\${label} escape`);
  const value = Number.parseInt(String.fromCodePoint(...data.subarray(start + 1, end)), 16);
  if (value > 0x10_ff_ff) return errors.decodeError(start - 1, end, 'illegal Unicode character');
  return { text: String.fromCodePoint(value), resume: end };
}

function namedEscape(data: Uint8Array, start: number, errors: ErrorHandling): { text: string; resume: number } {
  const close = data.indexOf(0x7d, start);
  if (data[start + 1] !== 0x7b || close === -1)
    return errors.decodeError(start - 1, start + 1, String.raw`malformed \N character escape`);
  const point = lookupName(String.fromCodePoint(...data.subarray(start + 2, close)), false);
  if (typeof point !== 'number') return errors.decodeError(start - 1, close + 1, 'unknown Unicode character name');
  return { text: String.fromCodePoint(point), resume: close + 1 };
}
