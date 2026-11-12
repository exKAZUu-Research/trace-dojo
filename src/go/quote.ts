// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { decodeRune, encodeRune, RUNE_ERROR } from './literals';

/** Go's `unicode.IsPrint`: letters, marks, numbers, punctuation, symbols, and the ASCII space. */
export function isPrint(rune: number): boolean {
  if (rune === 0x20) return true;
  if (rune < 0 || rune > 0x10_ff_ff) return false;
  return /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u.test(String.fromCodePoint(rune));
}

/** `strconv.Quote` of a byte string, or `QuoteToASCII` when `asciiOnly`; the result holds UTF-8 bytes. */
export function quote(bytes: string, quoteChar = '"', asciiOnly = false): string {
  let result = quoteChar;
  for (let index = 0; index < bytes.length;) {
    const { rune, size } = decodeRune(bytes, index);
    if (size === 1 && rune === RUNE_ERROR) {
      result += `\\x${bytes.charCodeAt(index).toString(16).padStart(2, '0')}`;
      index++;
      continue;
    }
    result += escapeRune(rune, quoteChar, asciiOnly);
    index += size;
  }
  return result + quoteChar;
}

/** `strconv.QuoteRune`. */
export function quoteRune(rune: number, asciiOnly = false): string {
  const valid = rune >= 0 && rune <= 0x10_ff_ff && !(rune >= 0xd8_00 && rune <= 0xdf_ff);
  return `'${escapeRune(valid ? rune : RUNE_ERROR, "'", asciiOnly)}'`;
}

const ESCAPES: Record<number, string> = {
  7: String.raw`\a`,
  8: String.raw`\b`,
  12: String.raw`\f`,
  10: String.raw`\n`,
  13: String.raw`\r`,
  9: String.raw`\t`,
  11: String.raw`\v`,
};

function escapeRune(rune: number, quoteChar: string, asciiOnly: boolean): string {
  if (rune === quoteChar.charCodeAt(0) || rune === 0x5c) return `\\${String.fromCharCode(rune)}`;
  if (asciiOnly ? rune < 0x80 && isPrint(rune) : isPrint(rune)) return encodeRune(rune);
  if (ESCAPES[rune]) return ESCAPES[rune];
  if (rune < 0x20 || rune === 0x7f) return `\\x${rune.toString(16).padStart(2, '0')}`;
  if (rune < 0x1_00_00) return `\\u${rune.toString(16).padStart(4, '0')}`;
  return `\\U${rune.toString(16).padStart(8, '0')}`;
}

/** Whether `strconv.CanBackquote` holds: a single line without control characters other than tab, or a backquote. */
export function canBackquote(bytes: string): boolean {
  for (let index = 0; index < bytes.length;) {
    const { rune, size } = decodeRune(bytes, index);
    if (size === 1 && rune === RUNE_ERROR && bytes.charCodeAt(index) !== 0xef) return false;
    if (rune === 0x60 || rune === 0xfe_ff) return false;
    if (rune < 0x20 && rune !== 9) return false;
    if (rune === 0x7f) return false;
    index += size;
  }
  return true;
}
