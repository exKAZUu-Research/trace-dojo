// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { decodeRune, encodeRune, RUNE_ERROR } from './literals';

/** Go's `unicode.IsPrint`: letters, marks, numbers, punctuation, symbols, and the ASCII space. */
export function isPrint(rune: number): boolean {
  if (rune === 0x20) return true;
  if (rune < 0 || rune > 0x10_ff_ff) return false;
  return /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u.test(String.fromCodePoint(rune));
}

/** Go's `strconv.IsGraphic`: the printable runes plus the spaces of category Zs. */
export function isGraphic(rune: number): boolean {
  return isPrint(rune) || GRAPHIC_SPACES.has(rune);
}

/** The runes of category Zs that `IsPrint` excludes, as `isGraphic` in Go's strconv/isprint.go lists them. */
const GRAPHIC_SPACES = new Set([
  0xa0, 0x16_80, 0x20_00, 0x20_01, 0x20_02, 0x20_03, 0x20_04, 0x20_05, 0x20_06, 0x20_07, 0x20_08, 0x20_09, 0x20_0a,
  0x20_2f, 0x20_5f, 0x30_00,
]);

/** `strconv.Quote` of a byte string, or `QuoteToASCII` when `asciiOnly`; the result holds UTF-8 bytes. */
export function quote(bytes: string, quoteChar = '"', asciiOnly = false, graphicOnly = false): string {
  return quoteChunks(bytes, quoteChar, asciiOnly, graphicOnly).join('');
}

/**
 * The pieces that Go's `appendQuotedWith` appends with one `append` call each,
 * which decide how an `AppendQuote` destination grows.
 */
export function quoteChunks(bytes: string, quoteChar = '"', asciiOnly = false, graphicOnly = false): string[] {
  const chunks = [quoteChar];
  for (let index = 0; index < bytes.length;) {
    const { rune, size } = decodeRune(bytes, index);
    if (size === 1 && rune === RUNE_ERROR) {
      const byte = bytes.charCodeAt(index);
      chunks.push(String.raw`\x`, HEX[byte >> 4], HEX[byte & 15]);
      index++;
      continue;
    }
    chunks.push(...escapedRuneChunks(rune, quoteChar, asciiOnly, graphicOnly));
    index += size;
  }
  chunks.push(quoteChar);
  return chunks;
}

/** `strconv.QuoteRune`. */
export function quoteRune(rune: number, asciiOnly = false, graphicOnly = false): string {
  return quoteRuneChunks(rune, asciiOnly, graphicOnly).join('');
}

/** The pieces that Go's `appendQuotedRuneWith` appends with one `append` call each. */
export function quoteRuneChunks(rune: number, asciiOnly = false, graphicOnly = false): string[] {
  const valid = rune >= 0 && rune <= 0x10_ff_ff && !(rune >= 0xd8_00 && rune <= 0xdf_ff);
  return ["'", ...escapedRuneChunks(valid ? rune : RUNE_ERROR, "'", asciiOnly, graphicOnly), "'"];
}

const HEX = '0123456789abcdef';

const ESCAPES: Record<number, string> = {
  7: String.raw`\a`,
  8: String.raw`\b`,
  12: String.raw`\f`,
  10: String.raw`\n`,
  13: String.raw`\r`,
  9: String.raw`\t`,
  11: String.raw`\v`,
};

function escapedRuneChunks(rune: number, quoteChar: string, asciiOnly: boolean, graphicOnly: boolean): string[] {
  if (rune === quoteChar.charCodeAt(0) || rune === 0x5c) return ['\\', String.fromCharCode(rune)];
  if (asciiOnly ? rune < 0x80 && isPrint(rune) : isPrint(rune) || (graphicOnly && GRAPHIC_SPACES.has(rune))) {
    return [encodeRune(rune)];
  }
  if (ESCAPES[rune]) return [ESCAPES[rune]];
  if (rune < 0x20 || rune === 0x7f) return [String.raw`\x`, HEX[rune >> 4], HEX[rune & 15]];
  if (rune < 0x1_00_00) return [String.raw`\u`, ...rune.toString(16).padStart(4, '0').split('')];
  return [String.raw`\U`, ...rune.toString(16).padStart(8, '0').split('')];
}

/** Whether `strconv.CanBackquote` holds: a single line without control characters other than tab, or a backquote. */
export function canBackquote(bytes: string): boolean {
  for (let index = 0; index < bytes.length;) {
    const { rune, size } = decodeRune(bytes, index);
    index += size;
    if (size > 1) {
      if (rune === 0xfe_ff) return false;
      continue;
    }
    if (rune === RUNE_ERROR) return false;
    if ((rune < 0x20 && rune !== 9) || rune === 0x60 || rune === 0x7f) return false;
  }
  return true;
}
