// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { currentRuntime } from '../native';
import { LibError, TextError } from './jsonWire';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DECODE_MAP = new Map(Array.from(ALPHABET, (char, index) => [char.charCodeAt(0), index]));

/** `base64.StdEncoding.EncodeToString`. */
export function base64Encode(bytes: string): string {
  currentRuntime().spend(1 + Math.floor(bytes.length / 16));
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes.charCodeAt(i);
    const b1 = i + 1 < bytes.length ? bytes.charCodeAt(i + 1) : 0;
    const b2 = i + 2 < bytes.length ? bytes.charCodeAt(i + 2) : 0;
    const value = (b0 << 16) | (b1 << 8) | b2;
    out += ALPHABET[(value >> 18) & 63] + ALPHABET[(value >> 12) & 63];
    out += i + 1 < bytes.length ? ALPHABET[(value >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? ALPHABET[value & 63] : '=';
  }
  return out;
}

/** `base64.CorruptInputError`. */
function corrupt(offset: number): LibError {
  return new TextError(`illegal base64 data at input byte ${offset}`);
}

function isNewline(c: number): boolean {
  return c === 0x0a || c === 0x0d;
}

/** `base64.StdEncoding.DecodeString`, which skips newlines: the decoded bytes, or the error at the bad byte. */
export function base64Decode(src: string): [string, LibError | undefined] {
  currentRuntime().spend(1 + Math.floor(src.length / 16));
  let out = '';
  let si = 0;
  while (si < src.length) {
    const [nextSi, bytes, err] = decodeQuantum(src, si);
    out += bytes;
    if (err) return [out, err];
    if (nextSi === si) break;
    si = nextSi;
  }
  return [out, undefined];
}

/** Go's `decodeQuantum`: up to four characters into up to three bytes. */
function decodeQuantum(src: string, start: number): [number, string, LibError | undefined] {
  const dbuf = [0, 0, 0, 0];
  let dlen = 4;
  let si = start;
  let err: LibError | undefined;
  for (let j = 0; j < 4; j++) {
    if (src.length === si) return [si, '', j === 0 ? undefined : corrupt(si - j)];
    const c = src.charCodeAt(si);
    si++;
    const out = DECODE_MAP.get(c);
    if (out !== undefined) {
      dbuf[j] = out;
    } else if (isNewline(c)) {
      j--;
    } else {
      if (c !== 0x3d || j < 2) return [si, '', corrupt(si - 1)];
      const padded = consumePadding(src, si, j);
      if (padded instanceof LibError) return [si, '', padded];
      [si, err, dlen] = [padded[0], padded[1], j];
      break;
    }
  }
  const value = (dbuf[0] << 18) | (dbuf[1] << 12) | (dbuf[2] << 6) | dbuf[3];
  const bytes = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff].slice(0, dlen - 1);
  return [si, String.fromCharCode(...bytes), err];
}

/** The rest of the padding after the first `=` of a quantum with `j` characters, then any trailing garbage. */
function consumePadding(src: string, start: number, j: number): [number, LibError | undefined] | LibError {
  let si = skipNewlines(src, start);
  if (j === 2) {
    if (si === src.length) return corrupt(src.length);
    if (src.charCodeAt(si) !== 0x3d) return corrupt(si - 1);
    si = skipNewlines(src, si + 1);
  }
  return [si, si < src.length ? corrupt(si) : undefined];
}

function skipNewlines(src: string, start: number): number {
  let si = start;
  while (si < src.length && isNewline(src.charCodeAt(si))) si++;
  return si;
}
