import { decodeRune, encodeRune, runesOf } from '../literals';
import { currentRuntime } from '../native';
import { spendFor } from './support';

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

/** Go's `unicode.caseOrbit` table, mapping each multi-way or self-folding rune to the next rune in its fold cycle. */
const CASE_ORBIT = new Map<number, number>([
  [0x00_4b, 0x00_6b],
  [0x00_53, 0x00_73],
  [0x00_6b, 0x21_2a],
  [0x00_73, 0x01_7f],
  [0x00_b5, 0x03_9c],
  [0x00_c5, 0x00_e5],
  [0x00_df, 0x1e_9e],
  [0x00_e5, 0x21_2b],
  [0x01_30, 0x01_30],
  [0x01_31, 0x01_31],
  [0x01_7f, 0x00_53],
  [0x01_c4, 0x01_c5],
  [0x01_c5, 0x01_c6],
  [0x01_c6, 0x01_c4],
  [0x01_c7, 0x01_c8],
  [0x01_c8, 0x01_c9],
  [0x01_c9, 0x01_c7],
  [0x01_ca, 0x01_cb],
  [0x01_cb, 0x01_cc],
  [0x01_cc, 0x01_ca],
  [0x01_f1, 0x01_f2],
  [0x01_f2, 0x01_f3],
  [0x01_f3, 0x01_f1],
  [0x03_45, 0x03_99],
  [0x03_90, 0x1f_d3],
  [0x03_92, 0x03_b2],
  [0x03_95, 0x03_b5],
  [0x03_98, 0x03_b8],
  [0x03_99, 0x03_b9],
  [0x03_9a, 0x03_ba],
  [0x03_9c, 0x03_bc],
  [0x03_a0, 0x03_c0],
  [0x03_a1, 0x03_c1],
  [0x03_a3, 0x03_c2],
  [0x03_a6, 0x03_c6],
  [0x03_a9, 0x03_c9],
  [0x03_b0, 0x1f_e3],
  [0x03_b2, 0x03_d0],
  [0x03_b5, 0x03_f5],
  [0x03_b8, 0x03_d1],
  [0x03_b9, 0x1f_be],
  [0x03_ba, 0x03_f0],
  [0x03_bc, 0x00_b5],
  [0x03_c0, 0x03_d6],
  [0x03_c1, 0x03_f1],
  [0x03_c2, 0x03_c3],
  [0x03_c3, 0x03_a3],
  [0x03_c6, 0x03_d5],
  [0x03_c9, 0x21_26],
  [0x03_d0, 0x03_92],
  [0x03_d1, 0x03_f4],
  [0x03_d5, 0x03_a6],
  [0x03_d6, 0x03_a0],
  [0x03_f0, 0x03_9a],
  [0x03_f1, 0x03_91],
  [0x03_f4, 0x03_98],
  [0x03_f5, 0x03_95],
  [0x04_12, 0x04_32],
  [0x04_14, 0x04_34],
  [0x04_1e, 0x04_3e],
  [0x04_21, 0x04_41],
  [0x04_22, 0x04_42],
  [0x04_2a, 0x04_4a],
  [0x04_32, 0x1c_80],
  [0x04_34, 0x1c_81],
  [0x04_3e, 0x1c_82],
  [0x04_41, 0x1c_83],
  [0x04_42, 0x1c_84],
  [0x04_4a, 0x1c_86],
  [0x04_62, 0x04_63],
  [0x04_63, 0x1c_87],
  [0x1c_80, 0x04_12],
  [0x1c_81, 0x04_14],
  [0x1c_82, 0x04_1e],
  [0x1c_83, 0x04_21],
  [0x1c_84, 0x1c_85],
  [0x1c_85, 0x04_22],
  [0x1c_86, 0x04_2a],
  [0x1c_87, 0x04_62],
  [0x1c_88, 0xa6_4a],
  [0x1e_60, 0x1e_61],
  [0x1e_61, 0x1e_9b],
  [0x1e_9b, 0x1e_60],
  [0x1e_9e, 0x00_df],
  [0x1f_be, 0x03_45],
  [0x1f_d3, 0x03_90],
  [0x1f_e3, 0x03_b0],
  [0x21_26, 0x03_a9],
  [0x21_2a, 0x00_4b],
  [0x21_2b, 0x00_c5],
  [0xa6_4a, 0xa6_4b],
  [0xa6_4b, 0x1c_88],
  [0xfb_05, 0xfb_06],
  [0xfb_06, 0xfb_05],
]);

/** `unicode.SimpleFold`, matching Go's `unicode/letter.go`. */
export function simpleFold(rune: number): number {
  if (rune < 0 || rune > 0x10_ff_ff) return rune;
  if (rune < 0x80) {
    if (rune >= 0x41 && rune <= 0x5a) return rune + 32;
    if (rune >= 0x61 && rune <= 0x7a) return CASE_ORBIT.get(rune) ?? rune - 32;
    return rune;
  }
  const orbited = CASE_ORBIT.get(rune);
  if (orbited !== undefined) return orbited;
  const lower = toLower(rune);
  return lower !== rune ? lower : toUpper(rune);
}

export function toUpper(rune: number): number {
  return simpleCase(rune, true);
}

export function toLower(rune: number): number {
  return rune === 0x1_30 ? 0x69 : simpleCase(rune, false);
}

export function toTitle(rune: number): number {
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
  return special[rune] ?? toUpper(rune);
}

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

/** Maps every rune of a byte string, as `strings.Map` does; a negative result drops the rune. */
export function mapRunes(bytes: string, map: (rune: number) => number): string {
  const runtime = currentRuntime();
  spendFor(bytes.length);
  let result = '';
  for (let index = 0; index < bytes.length;) {
    const { rune, size } = decodeRune(bytes, index);
    const mapped = map(rune);
    if (mapped >= 0) {
      const encoded = mapped === rune && size === 1 && rune === 0xff_fd ? encodeRune(0xff_fd) : encodeRune(mapped);
      runtime.checkStringLength(result.length + encoded.length);
      result += encoded;
    }
    index += size;
  }
  return result;
}

export { runesOf };
