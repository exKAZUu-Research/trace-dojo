import { CLASS_DATA } from './unicodeClassData';

/**
 * The character classes of str's predicates, as CPython 3.14's Unicode database (16.0.0) decides them rather than the
 * JavaScript engine's, whose Unicode version differs and whose classes leave out numeric ideographs such as 京 and 壹.
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

export function isAlphaChar(char: string): boolean {
  return inRuns(tables().alpha, char);
}

/** Whether `repr()` shows a character as it is and `str.isprintable()` accepts it. */
export function isPrintableChar(char: string): boolean {
  return inRuns(tables().printable, char);
}

/** Whether a character may start an identifier: XID_Start or `_`. */
export function isIdentifierStartChar(char: string): boolean {
  return inRuns(tables().identifierStart, char);
}

/** Whether a text is an identifier, as `str.isidentifier()` decides. */
export function isIdentifierText(text: string): boolean {
  const chars = [...text];
  return chars.length > 0 && isIdentifierStartChar(chars[0]) && chars.slice(1).every(isIdentifierContinueChar);
}

/** Whether a character may follow the first one in an identifier: XID_Continue. */
export function isIdentifierContinueChar(char: string): boolean {
  return inRuns(tables().identifierContinue, char);
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

type ClassName = keyof typeof CLASS_DATA;

let decoded: Record<ClassName, number[]> | undefined;

function tables(): Record<ClassName, number[]> {
  decoded ??= Object.fromEntries(Object.entries(CLASS_DATA).map(([name, runs]) => [name, decodeRuns(runs)])) as Record<
    ClassName,
    number[]
  >;
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
