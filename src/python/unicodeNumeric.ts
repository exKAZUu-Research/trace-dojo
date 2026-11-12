import { NUMERIC_DATA } from './unicodeNumericData';

/**
 * Whether characters are decimal, digits, or numeric, as str.isdecimal, isdigit, and isnumeric decide on CPython 3.14's
 * Unicode database rather than the JavaScript engine's, whose Unicode version differs and whose classes leave out
 * numeric ideographs such as 京 and 壹.
 */
export function isDecimalChar(char: string): boolean {
  return inRuns(tables().decimal, char);
}

export function isDigitChar(char: string): boolean {
  return inRuns(tables().digit, char);
}

export function isNumericChar(char: string): boolean {
  return inRuns(tables().numeric, char);
}

/**
 * The value of a decimal character, or undefined for another one. Decimal digits come in blocks from 0 to 9, which
 * adjacent blocks extend into one longer run, so a digit's value is its offset from the run's start modulo ten.
 */
export function decimalDigitValue(char: string): number | undefined {
  const bounds = tables().decimal;
  const index = runIndex(bounds, char.codePointAt(0) as number);
  return index % 2 === 1 ? ((char.codePointAt(0) as number) - bounds[index - 1]) % 10 : undefined;
}

let decoded: { decimal: number[]; digit: number[]; numeric: number[] } | undefined;

function tables(): { decimal: number[]; digit: number[]; numeric: number[] } {
  decoded ??= {
    decimal: decodeRuns(NUMERIC_DATA.decimal),
    digit: decodeRuns(NUMERIC_DATA.digit),
    numeric: decodeRuns(NUMERIC_DATA.numeric),
  };
  return decoded;
}

/** The runs as a sorted list of first code points and the code points just after them. */
function decodeRuns(text: string): number[] {
  const bounds: number[] = [];
  let end = 0;
  for (const run of text.split(';')) {
    const [gap, length] = run.split(',').map((part) => Number.parseInt(part, 16));
    const start = end + gap;
    end = start + length;
    bounds.push(start, end);
  }
  return bounds;
}

function inRuns(bounds: number[], char: string): boolean {
  // An odd count of bounds at or below the code point places it inside a run.
  return runIndex(bounds, char.codePointAt(0) as number) % 2 === 1;
}

/** The count of bounds at or below a code point. */
function runIndex(bounds: number[], code: number): number {
  let low = 0;
  let high = bounds.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (bounds[middle] <= code) low = middle + 1;
    else high = middle;
  }
  return low;
}
