// oxlint-disable unicorn/prefer-code-point -- PHP strings hold bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

/** Encodes a JavaScript string as the byte string of its UTF-8 encoding. */
export function enc(text: string): string {
  // oxlint-disable-next-line no-control-regex -- ASCII text encodes to itself, which skips the encoder for most text.
  if (/^[\u0000-\u007F]*$/.test(text)) return text;
  return bytesToString(encoder.encode(text));
}

/** Decodes a byte string as UTF-8, replacing invalid sequences as a terminal shows them. */
export function dec(bytes: string): string {
  // oxlint-disable-next-line no-control-regex -- ASCII text decodes to itself.
  if (/^[\u0000-\u007F]*$/.test(bytes)) return bytes;
  return decoder.decode(stringToBytes(bytes));
}

export function bytesToString(bytes: Uint8Array): string {
  let text = '';
  for (let index = 0; index < bytes.length; index += 8192) {
    text += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return text;
}

export function stringToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
  return bytes;
}

/** Lowercases ASCII letters only, as PHP's case-insensitive names and `strtolower` do. */
export function lower(text: string): string {
  return text.replaceAll(/[A-Z]+/g, (match) => match.toLowerCase());
}

export function upper(text: string): string {
  return text.replaceAll(/[a-z]+/g, (match) => match.toUpperCase());
}

/** The code points of a UTF-8 byte string, with each invalid byte standing alone, as mbstring counts them. */
export function utf8Chars(bytes: string): string[] {
  const chars: string[] = [];
  let index = 0;
  while (index < bytes.length) {
    const length = utf8Length(bytes, index);
    chars.push(bytes.slice(index, index + length));
    index += length;
  }
  return chars;
}

/** The length of the valid UTF-8 sequence at `index`, or 1 for an invalid byte. */
export function utf8Length(bytes: string, index: number): number {
  const lead = bytes.charCodeAt(index);
  let length = 1;
  if (lead >= 0xc2 && lead <= 0xdf) length = 2;
  else if (lead >= 0xe0 && lead <= 0xef) length = 3;
  else if (lead >= 0xf0 && lead <= 0xf4) length = 4;
  if (length === 1 || index + length > bytes.length) return 1;
  for (let offset = 1; offset < length; offset++) {
    const byte = bytes.charCodeAt(index + offset);
    if (byte < 0x80 || byte > 0xbf) return 1;
  }
  const second = bytes.charCodeAt(index + 1);
  if (lead === 0xe0 && second < 0xa0) return 1;
  if (lead === 0xed && second > 0x9f) return 1;
  if (lead === 0xf0 && second < 0x90) return 1;
  if (lead === 0xf4 && second > 0x8f) return 1;
  return length;
}

/** Encodes a code point as UTF-8 bytes. */
export function codePointBytes(codePoint: number): string {
  if (codePoint < 0x80) return String.fromCharCode(codePoint);
  if (codePoint < 0x8_00) return String.fromCharCode(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
  if (codePoint < 0x1_00_00) {
    return String.fromCharCode(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
  }
  return String.fromCharCode(
    0xf0 | (codePoint >> 18),
    0x80 | ((codePoint >> 12) & 0x3f),
    0x80 | ((codePoint >> 6) & 0x3f),
    0x80 | (codePoint & 0x3f)
  );
}
