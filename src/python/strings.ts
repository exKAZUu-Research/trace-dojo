import { chargeStep } from './runtimeContext';

/** Python strings are sequences of code points, while JavaScript strings are UTF-16; these helpers bridge the two. */

const SURROGATE = /[\uD800-\uDFFF]/;

export function hasSurrogates(text: string): boolean {
  return SURROGATE.test(text);
}

export function strLength(text: string): number {
  if (!hasSurrogates(text)) return text.length;
  return iterStr(text).length;
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
  if (!hasSurrogates(text)) return text[index];
  return iterStr(text)[index];
}

/** The code points from `start` up to `stop` stepping by `step`, with indices already clamped to the string. */
export function sliceStr(text: string, start: number, stop: number, step: number): string {
  const surrogates = hasSurrogates(text);
  if (step === 1 && !surrogates) return text.slice(start, stop);
  const points = surrogates ? iterStr(text) : text;
  let result = '';
  if (step > 0) for (let index = start; index < stop; index += step) result += points[index];
  else for (let index = start; index > stop; index += step) result += points[index];
  return result;
}

/**
 * The characters `str.isspace()`, `split()`, and `strip()` treat as whitespace: Python's set, which, unlike JavaScript's
 * `\s`, includes U+001C to U+001F and U+0085 and excludes U+FEFF.
 */
// oxlint-disable-next-line eslint/no-control-regex -- Python counts these separators as whitespace.
export const PYTHON_WHITESPACE =
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

const NON_PRINTABLE = /[\p{C}\p{Z}]/u;

/** Whether a code point is printable, as `str.isprintable()` decides: not a control, format, or separator other than space. */
export function isPrintable(char: string): boolean {
  return char === ' ' || !NON_PRINTABLE.test(char);
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
    else if (asciiOnly || !isPrintable(char)) result += escapeCodePoint(code);
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
