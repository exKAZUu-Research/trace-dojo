// The raw_unicode_escape codec, which pickles of str for protocol 0 use.
import { type ErrorHandling, registerCodec } from './codecs';

registerCodec('raw_unicode_escape', () => ({ name: 'rawunicodeescape', encode, decode }));

/** Writes the code points below 256 as bytes, and the others as `\uXXXX` or `\UXXXXXXXX`. */
function encode(points: readonly number[]): Uint8Array {
  const out: number[] = [];
  for (const point of points) {
    if (point < 0x1_00) {
      out.push(point);
      continue;
    }
    const text =
      point < 0x1_00_00
        ? String.raw`\u${point.toString(16).padStart(4, '0')}`
        : String.raw`\U${point.toString(16).padStart(8, '0')}`;
    for (const char of text) out.push(char.codePointAt(0) as number);
  }
  return Uint8Array.from(out);
}

/** Reads the bytes as latin-1, except the escapes that a backslash not itself escaped starts. */
function decode(data: Uint8Array, errors: ErrorHandling): string {
  let text = '';
  let index = 0;
  while (index < data.length) {
    const byte = data[index++];
    if (byte !== 0x5c || index >= data.length) {
      text += String.fromCodePoint(byte);
      continue;
    }
    const marker = data[index++];
    if (marker !== 0x75 && marker !== 0x55) {
      text += `\\${String.fromCodePoint(marker)}`;
      continue;
    }
    const decoded = decodeEscape(data, index, marker === 0x75 ? 4 : 8, errors);
    text += decoded.text;
    index = decoded.resume;
  }
  return text;
}

/** Decodes the hex digits of one `\u` or `\U` escape, whose digits start at `start`. */
function decodeEscape(
  data: Uint8Array,
  start: number,
  count: number,
  errors: ErrorHandling
): { text: string; resume: number } {
  const value = hexDigits(data, start, count);
  if (value !== undefined && value <= 0x10_ff_ff) return { text: String.fromCodePoint(value), resume: start + count };
  if (value !== undefined) return errors.decodeError(start - 2, start + count, String.raw`\Uxxxxxxxx out of range`);
  let end = start;
  while (end < Math.min(data.length, start + count) && /[\da-f]/i.test(String.fromCodePoint(data[end]))) end++;
  const reason = count === 4 ? String.raw`truncated \uXXXX escape` : String.raw`truncated \UXXXXXXXX escape`;
  return errors.decodeError(start - 2, end, reason);
}

function hexDigits(data: Uint8Array, start: number, count: number): number | undefined {
  if (start + count > data.length) return undefined;
  let value = 0;
  for (let index = start; index < start + count; index++) {
    const digit = Number.parseInt(String.fromCodePoint(data[index]), 16);
    if (Number.isNaN(digit)) return undefined;
    value = value * 16 + digit;
  }
  return value;
}
