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

/** Compares strings by code point, as Python does, rather than by UTF-16 code unit. */
export function compareStr(a: string, b: string): number {
  if (a === b) return 0;
  if (!hasSurrogates(a) && !hasSurrogates(b)) return a < b ? -1 : 1;
  const left = iterStr(a);
  const right = iterStr(b);
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const difference = (left[index].codePointAt(0) as number) - (right[index].codePointAt(0) as number);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
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
