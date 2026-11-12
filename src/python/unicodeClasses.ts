import { CLASS_DATA } from './unicodeClassData';

/**
 * The character classes of str's predicates, as CPython 3.14's Unicode database (16.0.0) decides them rather than the
 * JavaScript engine's, whose Unicode version differs and whose classes leave out numeric ideographs such as 京 and 壹.
 */
export function isDecimalCode(code: number): boolean {
  return isInClass('decimal', code);
}

export function isDigitCode(code: number): boolean {
  return isInClass('digit', code);
}

export function isNumericCode(code: number): boolean {
  return isInClass('numeric', code);
}

export function isAlphaCode(code: number): boolean {
  return isInClass('alpha', code);
}

/** Whether `repr()` shows a code point as it is and `str.isprintable()` accepts it. */
export function isPrintableCode(code: number): boolean {
  return isInClass('printable', code);
}

/** Whether a code point may start an identifier: XID_Start or `_`. */
export function isIdentifierStartCode(code: number): boolean {
  return isInClass('identifierStart', code);
}

/** Whether a text is an identifier, as `str.isidentifier()` decides. */
export function isIdentifierText(text: string): boolean {
  const codes = Array.from(text, (char) => char.codePointAt(0) as number);
  return codes.length > 0 && isIdentifierStartCode(codes[0]) && codes.slice(1).every(isIdentifierContinueCode);
}

/** Whether a code point may follow the first one in an identifier: XID_Continue. */
export function isIdentifierContinueCode(code: number): boolean {
  return isInClass('identifierContinue', code);
}

/**
 * The value of a decimal code point, or undefined for another one. Decimal digits come in blocks from 0 to 9, which
 * adjacent blocks extend into one longer run, so a digit's value is its offset from the run's start modulo ten.
 */
export function decimalDigitValue(code: number): number | undefined {
  const bounds = tables().runs.decimal;
  const index = runIndex(bounds, code);
  return index % 2 === 1 ? (code - bounds[index - 1]) % 10 : undefined;
}

type ClassName = keyof typeof CLASS_DATA;

const CLASS_NAMES = Object.keys(CLASS_DATA) as ClassName[];
const CLASS_BITS = Object.fromEntries(CLASS_NAMES.map((name, index) => [name, 1 << index])) as Record<
  ClassName,
  number
>;
/** The code points below this have their classes in a bit table, since most text consists of them. */
const TABLED_CODES = 0x1_00;

let decoded: { runs: Record<ClassName, number[]>; tabled: Uint8Array } | undefined;

function isInClass(name: ClassName, code: number): boolean {
  const { runs, tabled } = tables();
  if (code < TABLED_CODES) return (tabled[code] & CLASS_BITS[name]) !== 0;
  // An odd count of bounds at or below the code point places it inside a run.
  return runIndex(runs[name], code) % 2 === 1;
}

function tables(): { runs: Record<ClassName, number[]>; tabled: Uint8Array } {
  if (decoded) return decoded;
  const runs = Object.fromEntries(CLASS_NAMES.map((name) => [name, decodeRuns(CLASS_DATA[name])])) as Record<
    ClassName,
    number[]
  >;
  const tabled = new Uint8Array(TABLED_CODES);
  for (const name of CLASS_NAMES) {
    for (let code = 0; code < TABLED_CODES; code++)
      if (runIndex(runs[name], code) % 2 === 1) tabled[code] |= CLASS_BITS[name];
  }
  decoded = { runs, tabled };
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
