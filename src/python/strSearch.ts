/* oxlint-disable unicorn/prefer-code-point -- The search compares UTF-16 code units, which pairs make code points. */
import { currentRuntime } from './runtimeContext';

/**
 * The longest needle searched with the host's indexOf and lastIndexOf, whose worst case is quadratic in V8 (the
 * running time grows with the product of the lengths), which stays linear for needles this short.
 */
const SHORT_NEEDLE = 8;

/**
 * The UTF-16 offsets of the non-overlapping occurrences of a non-empty `needle` in `text` between the offsets `from`
 * and `to`, at most `limit` of them, found from the start or, with `fromEnd`, from the end. Both offsets must fall
 * between code points, and so must each occurrence: a needle that starts or ends with a lone surrogate does not match
 * half of a surrogate pair, which is one code point. The work is linear in the lengths, and charged.
 */
export function occurrences(
  text: string,
  needle: string,
  { from = 0, to = text.length, fromEnd = false, limit = Number.POSITIVE_INFINITY } = {}
): number[] {
  const region = from === 0 && to === text.length ? text : text.slice(from, to);
  // Comparing the lengths settles these without reading either string.
  if (needle.length > region.length || limit <= 0) return [];
  const found =
    needle.length <= SHORT_NEEDLE
      ? hostOccurrences(region, needle, fromEnd, limit)
      : kmpOccurrences(region, needle, fromEnd, limit);
  currentRuntime().scan(examined(region.length, needle.length, found, fromEnd, limit) + needle.length);
  return from === 0 ? found : found.map((offset) => offset + from);
}

/**
 * How much of a region a search read: all of it, unless it stopped at its `limit`-th match, when it read up to the end
 * of that match from the end it started at.
 */
function examined(length: number, needleLength: number, found: number[], fromEnd: boolean, limit: number): number {
  if (found.length < limit) return length;
  const last = found.at(-1) as number;
  return fromEnd ? length - last : last + needleLength;
}

/** Whether `text` contains `needle` as a sequence of whole code points. */
export function containsStr(text: string, needle: string): boolean {
  return needle === '' || occurrences(text, needle, { limit: 1 }).length > 0;
}

/** Whether `text` has `needle` as whole code points at the UTF-16 offset `offset`. */
export function hasAt(text: string, needle: string, offset: number): boolean {
  return offset >= 0 && text.startsWith(needle, offset) && isAligned(text, offset, needle.length);
}

function hostOccurrences(region: string, needle: string, fromEnd: boolean, limit: number): number[] {
  const found: number[] = [];
  let position = fromEnd ? region.length - needle.length : 0;
  while (found.length < limit && position >= 0) {
    const offset = fromEnd ? region.lastIndexOf(needle, position) : region.indexOf(needle, position);
    if (offset === -1) break;
    const isMatch = isAligned(region, offset, needle.length);
    if (isMatch) found.push(offset);
    const step = isMatch ? needle.length : 1;
    position = fromEnd ? offset - step : offset + step;
  }
  return found;
}

/** Searches with the Knuth-Morris-Pratt algorithm, from the end by searching the reversed strings. */
// code-gauge-allow functionCognitiveComplexity 16 -- Transcribes the Knuth-Morris-Pratt search, whose failure links make the loop.
function kmpOccurrences(region: string, needle: string, fromEnd: boolean, limit: number): number[] {
  const text = fromEnd ? reverseUnits(region) : region;
  const pattern = fromEnd ? reverseUnits(needle) : needle;
  const fail = failureTable(pattern);
  const found: number[] = [];
  let matched = 0;
  for (let index = 0; index < text.length && found.length < limit; index++) {
    const unit = text.charCodeAt(index);
    while (matched > 0 && pattern.charCodeAt(matched) !== unit) matched = fail[matched - 1];
    if (pattern.charCodeAt(matched) === unit) matched++;
    if (matched < pattern.length) continue;
    const start = index + 1 - pattern.length;
    const offset = fromEnd ? region.length - start - pattern.length : start;
    if (isAligned(region, offset, pattern.length)) {
      found.push(offset);
      matched = 0;
    } else {
      matched = fail[matched - 1];
    }
  }
  return found;
}

/** For each prefix of `pattern`, the length of its longest proper prefix that is also its suffix. */
function failureTable(pattern: string): Int32Array {
  const fail = new Int32Array(pattern.length);
  let length = 0;
  for (let index = 1; index < pattern.length; index++) {
    const unit = pattern.charCodeAt(index);
    while (length > 0 && pattern.charCodeAt(length) !== unit) length = fail[length - 1];
    if (pattern.charCodeAt(length) === unit) length++;
    fail[index] = length;
  }
  return fail;
}

function reverseUnits(text: string): string {
  const units: string[] = Array.from({ length: text.length });
  for (let index = 0; index < text.length; index++) units[text.length - 1 - index] = text[index];
  return units.join('');
}

function isAligned(text: string, offset: number, length: number): boolean {
  return !isPairAt(text, offset - 1) && !isPairAt(text, offset + length - 1);
}

/** Whether a surrogate pair starts at the UTF-16 offset `offset`. */
function isPairAt(text: string, offset: number): boolean {
  if (offset < 0 || offset + 1 >= text.length) return false;
  const high = text.charCodeAt(offset);
  const low = text.charCodeAt(offset + 1);
  return high >= 0xd8_00 && high <= 0xdb_ff && low >= 0xdc_00 && low <= 0xdf_ff;
}
