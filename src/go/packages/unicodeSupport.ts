import { decodeRune, encodeRune, runesOf } from '../literals';
import { currentRuntime } from '../native';
import { spendFor } from './support';
import { CASE_ORBIT, CASE_RANGES, UPPER_LOWER } from './unicodeCaseTables';

/** `unicode.IsSpace`. */
export function isSpace(rune: number): boolean {
  if (rune <= 0xff) return rune === 0x20 || (rune >= 0x09 && rune <= 0x0d) || rune === 0x85 || rune === 0xa0;
  return isWhiteSpace(rune);
}

const test =
  (pattern: RegExp) =>
  (rune: number): boolean =>
    rune >= 0 && rune <= 0x10_ff_ff && pattern.test(String.fromCodePoint(rune));

const isWhiteSpace = test(/^\p{White_Space}$/u);

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
export const isGraphic = test(/^[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}]$/u);

const UPPER_CASE = 0;
const LOWER_CASE = 1;
const TITLE_CASE = 2;

/** `unicode.SimpleFold`, matching Go's `unicode/letter.go`. */
export function simpleFold(rune: number): number {
  if (rune < 0 || rune > 0x10_ff_ff) return rune;
  const orbited = orbitOf(rune);
  if (orbited !== undefined) return orbited;
  if (rune < 0x80) {
    if (rune >= 0x41 && rune <= 0x5a) return rune + 32;
    if (rune >= 0x61 && rune <= 0x7a) return rune - 32;
    return rune;
  }
  const range = caseRangeOf(rune);
  if (range < 0) return rune;
  const lower = convertCase(LOWER_CASE, rune, range);
  return lower === rune ? convertCase(UPPER_CASE, rune, range) : lower;
}

export function toUpper(rune: number): number {
  return toCase(UPPER_CASE, rune);
}

export function toLower(rune: number): number {
  return toCase(LOWER_CASE, rune);
}

export function toTitle(rune: number): number {
  return toCase(TITLE_CASE, rune);
}

function toCase(kind: number, rune: number): number {
  if (rune < 0x80) {
    if (kind !== LOWER_CASE && rune >= 0x61 && rune <= 0x7a) return rune - 32;
    if (kind === LOWER_CASE && rune >= 0x41 && rune <= 0x5a) return rune + 32;
    return rune;
  }
  const range = caseRangeOf(rune);
  return range < 0 ? rune : convertCase(kind, rune, range);
}

function orbitOf(rune: number): number | undefined {
  let lo = 0;
  let hi = CASE_ORBIT.length / 2;
  while (lo < hi) {
    const middle = (lo + hi) >>> 1;
    if (CASE_ORBIT[middle * 2] < rune) lo = middle + 1;
    else hi = middle;
  }
  return CASE_ORBIT[lo * 2] === rune ? CASE_ORBIT[lo * 2 + 1] : undefined;
}

/** Returns the offset of the `CASE_RANGES` row containing the rune, or -1. */
function caseRangeOf(rune: number): number {
  let lo = 0;
  let hi = CASE_RANGES.length / 5;
  while (lo < hi) {
    const middle = (lo + hi) >>> 1;
    const offset = middle * 5;
    if (rune < CASE_RANGES[offset]) hi = middle;
    else if (rune > CASE_RANGES[offset + 1]) lo = middle + 1;
    else return offset;
  }
  return -1;
}

function convertCase(kind: number, rune: number, offset: number): number {
  const delta = CASE_RANGES[offset + 2 + kind];
  if (delta !== UPPER_LOWER) return rune + delta;
  const lo = CASE_RANGES[offset];
  return lo + (((rune - lo) & ~1) | (kind & 1));
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
