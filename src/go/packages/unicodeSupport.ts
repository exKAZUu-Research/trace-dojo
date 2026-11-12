import { decodeRune, encodeRune, runesOf } from '../literals';

/** `unicode.IsSpace`. */
export function isSpace(rune: number): boolean {
  if (rune <= 0xff) return rune === 0x20 || (rune >= 0x09 && rune <= 0x0d) || rune === 0x85 || rune === 0xa0;
  return /^\p{White_Space}$/u.test(String.fromCodePoint(rune));
}

const test =
  (pattern: RegExp) =>
  (rune: number): boolean =>
    rune >= 0 && rune <= 0x10_ff_ff && pattern.test(String.fromCodePoint(rune));

export const isLetter = test(/^\p{L}$/u);
export const isDigit = test(/^\p{Nd}$/u);
export const isNumber = test(/^\p{N}$/u);
export const isUpper = test(/^\p{Lu}$/u);
export const isLower = test(/^\p{Ll}$/u);
export const isTitle = test(/^\p{Lt}$/u);
export const isPunct = test(/^\p{P}$/u);
export const isSymbol = test(/^\p{S}$/u);
export const isMark = test(/^\p{M}$/u);
export const isControl = test(/^\p{Cc}$/u);
export const isGraphic = (rune: number): boolean =>
  rune === 0x20 || /^[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}]$/u.test(String.fromCodePoint(rune));

/** Go's simple case mapping, which maps one rune to one rune, unlike JavaScript's full mapping ('ß' stays 'ß'). */
function simpleCase(rune: number, upper: boolean): number {
  if (rune < 0 || rune > 0x10_ff_ff || (rune >= 0xd8_00 && rune <= 0xdf_ff)) return rune;
  if (rune < 0x80) {
    if (upper && rune >= 0x61 && rune <= 0x7a) return rune - 32;
    if (!upper && rune >= 0x41 && rune <= 0x5a) return rune + 32;
    return rune;
  }
  const char = String.fromCodePoint(rune);
  const mapped = upper ? char.toUpperCase() : char.toLowerCase();
  const points = [...mapped];
  if (points.length !== 1) return rune;
  // The Turkish dotted capital I lowers to 'i' plus a combining dot in full mapping; its simple mapping is 'i'.
  return points[0].codePointAt(0) as number;
}

export const toUpper = (rune: number): number => simpleCase(rune, true);
export const toLower = (rune: number): number => (rune === 0x1_30 ? 0x69 : simpleCase(rune, false));
export const toTitle = (rune: number): number => {
  const titled = String.fromCodePoint(rune);
  // Unicode's titlecase forms of digraphs (ǆ → ǅ) differ from their uppercase.
  const special: Record<number, number> = {
    0x1_c4: 0x1_c5,
    0x1_c5: 0x1_c5,
    0x1_c6: 0x1_c5,
    0x1_c7: 0x1_c8,
    0x1_c8: 0x1_c8,
    0x1_c9: 0x1_c8,
    0x1_ca: 0x1_cb,
    0x1_cb: 0x1_cb,
    0x1_cc: 0x1_cb,
    0x1_f1: 0x1_f2,
    0x1_f2: 0x1_f2,
    0x1_f3: 0x1_f2,
  };
  void titled;
  return special[rune] ?? toUpper(rune);
};

/** Maps every rune of a byte string, as `strings.Map` does; a negative result drops the rune. */
export function mapRunes(bytes: string, map: (rune: number) => number): string {
  let result = '';
  for (let index = 0; index < bytes.length;) {
    const { rune, size } = decodeRune(bytes, index);
    const mapped = map(rune);
    if (mapped >= 0)
      result += mapped === rune && size === 1 && rune === 0xff_fd ? encodeRune(0xff_fd) : encodeRune(mapped);
    index += size;
  }
  return result;
}

export { runesOf };
