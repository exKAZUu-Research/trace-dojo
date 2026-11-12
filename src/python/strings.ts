import { chargeScan, chargeStep, runningProgram } from './runtimeContext';
import { isPrintableChar } from './unicodeClasses';

/** Python strings are sequences of code points, while JavaScript strings are UTF-16; these helpers bridge the two. */

const SURROGATE = /[\uD800-\uDFFF]/;

/** Strings shorter than this are scanned again each time; longer ones keep an index of what a scan found. */
const CACHED_LENGTH = 1024;
/** The code units the cached strings may hold together, since the cache keeps them alive; the oldest go first. */
const CACHED_UNITS = 1 << 22;
/** An index keeps the UTF-16 offset of every this many code points, so a lookup walks at most this many. */
const STRIDE = 64;

/** What scanning a long string found: its length in code points and, when it holds surrogates, where they lie. */
interface Scan {
  length: number;
  /** The string's hash, once a program hashed it. */
  hash?: bigint;
  /** The UTF-16 offset of every STRIDE-th code point, for a string holding surrogates. */
  offsets?: Int32Array;
}

/** The scans each run keeps, which go with the run, and the code units of the strings they keep alive. */
const runScans = new WeakMap<object, { scans: Map<string, Scan>; units: number }>();

export function hasSurrogates(text: string): boolean {
  if (text.length < CACHED_LENGTH) return SURROGATE.test(text);
  return scanOf(text).offsets !== undefined;
}

/**
 * The scan of a long string, kept for the strings this run read last, so that a program reading the same long string
 * over and over does not scan it, or pay for it, each time.
 */
function scanOf(text: string): Scan {
  const run = runningProgram();
  let cache = run && runScans.get(run);
  if (run && !cache) {
    cache = { scans: new Map(), units: 0 };
    runScans.set(run, cache);
  }
  const known = cache?.scans.get(text);
  if (cache && known) {
    cache.scans.delete(text);
    cache.scans.set(text, known);
    return known;
  }
  chargeScan(text.length);
  const scan = scanText(text);
  if (!cache) return scan;
  cache.scans.set(text, scan);
  cache.units += text.length;
  for (const [oldest] of cache.scans) {
    if (cache.units <= CACHED_UNITS || oldest === text) break;
    cache.scans.delete(oldest);
    cache.units -= oldest.length;
  }
  return scan;
}

function scanText(text: string): Scan {
  if (!SURROGATE.test(text)) return { length: text.length };
  const offsets: number[] = [];
  let length = 0;
  for (let offset = 0; offset < text.length; length++) {
    if (length % STRIDE === 0) offsets.push(offset);
    offset += (text.codePointAt(offset) as number) > 0xff_ff ? 2 : 1;
  }
  return { length, offsets: Int32Array.from(offsets) };
}

/** The UTF-16 offset of the code point at `index` of a long string holding surrogates. */
function unitOffset(text: string, offsets: Int32Array, index: number): number {
  let offset = offsets[Math.floor(index / STRIDE)] ?? text.length;
  for (let step = index % STRIDE; step > 0; step--) offset += (text.codePointAt(offset) as number) > 0xff_ff ? 2 : 1;
  return offset;
}

/** A string's hash, computed by `compute` once for a long string read again and again, and each time for a short one. */
export function rememberedHash(text: string, compute: () => bigint): bigint {
  if (text.length < CACHED_LENGTH) return compute();
  const scan = scanOf(text);
  scan.hash ??= compute();
  return scan.hash;
}

/** The UTF-16 offset of the code point at `index`, or of the end of the text for an index at or past its end. */
export function codePointOffset(text: string, index: number): number {
  const offsets = text.length >= CACHED_LENGTH ? scanOf(text).offsets : undefined;
  if (offsets) {
    const sample = Math.min(Math.floor(index / STRIDE), offsets.length - 1);
    return walkUnits(text, offsets[sample], index - sample * STRIDE);
  }
  if (!hasSurrogates(text)) return Math.min(index, text.length);
  chargeScan(index);
  return walkUnits(text, 0, index);
}

/** The index of the code point that starts at the UTF-16 offset `offset`. */
export function codePointIndex(text: string, offset: number): number {
  const offsets = text.length >= CACHED_LENGTH ? scanOf(text).offsets : undefined;
  if (!offsets) {
    if (!hasSurrogates(text)) return offset;
    chargeScan(offset);
    return countPoints(text, 0, offset);
  }
  // The last sampled code point at or before the offset, found by bisection, then a walk of at most STRIDE.
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (offsets[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low * STRIDE + countPoints(text, offsets[low], offset);
}

/** The offset `count` code points after `offset`, stopping at the end of the text. */
function walkUnits(text: string, offset: number, count: number): number {
  let unit = offset;
  for (let point = 0; point < count && unit < text.length; point++) unit += isPairAt(text, unit) ? 2 : 1;
  return unit;
}

/** The code points that start from `from` up to `to`. */
function countPoints(text: string, from: number, to: number): number {
  let count = 0;
  for (let unit = from; unit < to; unit += isPairAt(text, unit) ? 2 : 1) count++;
  return count;
}

function isPairAt(text: string, offset: number): boolean {
  return (text.codePointAt(offset) as number) > 0xff_ff;
}

export function strLength(text: string): number {
  if (text.length >= CACHED_LENGTH) return scanOf(text).length;
  return hasSurrogates(text) ? iterStr(text).length : text.length;
}

/** The code points of a string, each as a string. */
export function iterStr(text: string): string[] {
  // oxlint-disable-next-line typescript/no-misused-spread -- Python iterates strings by code point.
  return hasSurrogates(text) ? [...text] : text.split('');
}

/** The first `count` code points of a string, read from no more of it than they can occupy. */
export function headStr(text: string, count: number): string {
  // Each code point takes at most two UTF-16 units.
  const units = text.slice(0, count * 2);
  return hasSurrogates(units) ? iterStr(units).slice(0, count).join('') : units.slice(0, count);
}

export function codePointAt(text: string, index: number): string {
  const offsets = text.length >= CACHED_LENGTH ? scanOf(text).offsets : undefined;
  if (offsets) return String.fromCodePoint(text.codePointAt(unitOffset(text, offsets, index)) as number);
  return hasSurrogates(text) ? iterStr(text)[index] : text[index];
}

/** The code points from `start` up to `stop` stepping by `step`, with indices already clamped to the string. */
export function sliceStr(text: string, start: number, stop: number, step: number): string {
  const offsets = text.length >= CACHED_LENGTH ? scanOf(text).offsets : undefined;
  if (offsets && step === 1) return text.slice(unitOffset(text, offsets, start), unitOffset(text, offsets, stop));
  if (step === 1 && !offsets && !hasSurrogates(text)) return text.slice(start, stop);
  const pointAt = pointReader(text, offsets);
  let result = '';
  if (step > 0) for (let index = start; index < stop; index += step) result += pointAt(index);
  else for (let index = start; index > stop; index += step) result += pointAt(index);
  return result;
}

/** Reads a string's code points by index: through the index of a long one, or from its code points split once. */
function pointReader(text: string, offsets: Int32Array | undefined): (index: number) => string {
  if (offsets) return (index) => codePointAt(text, index);
  const points = hasSurrogates(text) ? iterStr(text) : text;
  return (index) => points[index];
}

/**
 * The characters `str.isspace()`, `split()`, and `strip()` treat as whitespace: Python's set, which, unlike JavaScript's
 * `\s`, includes U+001C to U+001F and U+0085 and excludes U+FEFF.
 */
export const PYTHON_WHITESPACE =
  // oxlint-disable-next-line eslint/no-control-regex -- Python counts these separators as whitespace.
  /[\t\n\v\f\r\u001C-\u001F \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/u;

const NUMBER_SPACE = String.raw`[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]`;
const NUMBER_SPACE_AROUND = new RegExp(`^${NUMBER_SPACE}+|${NUMBER_SPACE}+$`, 'gu');

/**
 * Strips the whitespace `int()`, `float()`, and `complex()` ignore around a number: ASCII's C whitespace and the
 * non-ASCII Python whitespace, which CPython turns into spaces first.
 */
export function stripNumberSpace(text: string): string {
  return text.replaceAll(NUMBER_SPACE_AROUND, '');
}

/**
 * Compares strings by code point, as Python does, rather than by UTF-16 code unit, walking both from the start and
 * charging the code points it examines.
 */
export function compareStr(a: string, b: string): number {
  // Equal strings are often the same host string, which compares at once; one step still lets the clock check catch
  // equal copies, whose comparison scans them.
  if (a === b) {
    chargeStep();
    return 0;
  }
  let index = 0;
  for (let steps = 0; index < a.length && index < b.length; steps++) {
    if ((steps & 63) === 0) chargeStep();
    const left = a.codePointAt(index) as number;
    const right = b.codePointAt(index) as number;
    if (left !== right) return left - right;
    index += left > 0xff_ff ? 2 : 1;
  }
  return (index < a.length ? 1 : 0) - (index < b.length ? 1 : 0);
}

function escapeCodePoint(code: number): string {
  if (code < 0x1_00) return `\\x${code.toString(16).padStart(2, '0')}`;
  if (code < 0x1_00_00) return `\\u${code.toString(16).padStart(4, '0')}`;
  return `\\U${code.toString(16).padStart(8, '0')}`;
}

/** `repr()` of a string. */
export function strRepr(text: string, asciiOnly = false): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let result = quote;
  for (const char of iterStr(text)) {
    const code = char.codePointAt(0) as number;
    if (char === quote || char === '\\') result += `\\${char}`;
    else if (char === '\n') result += String.raw`\n`;
    else if (char === '\r') result += String.raw`\r`;
    else if (char === '\t') result += String.raw`\t`;
    else if (code < 0x20 || code === 0x7f) result += escapeCodePoint(code);
    else if (code < 0x7f) result += char;
    else if (asciiOnly || !isPrintableChar(char)) result += escapeCodePoint(code);
    else result += char;
  }
  return result + quote;
}

/** Escapes the non-ASCII characters of a text, as `ascii()` does to a repr. */
export function asciiEscape(text: string): string {
  let result = '';
  for (const char of iterStr(text)) {
    const code = char.codePointAt(0) as number;
    result += code < 0x80 ? char : escapeCodePoint(code);
  }
  return result;
}
