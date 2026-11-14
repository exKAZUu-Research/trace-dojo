import { chargeScan, currentRuntime } from './runtimeContext';
import { CASE_DATA } from './unicodeCaseData';

/**
 * The case operations of str as CPython's unicodeobject.c performs them, on the case tables of CPython 3.14's Unicode
 * database rather than the JavaScript engine's, whose Unicode version and titlecase handling differ.
 */

type Mapping = Map<number, string>;

let tables:
  | {
      upper: Mapping;
      lower: Mapping;
      title: Mapping;
      fold: Mapping;
      isUpper: Set<number>;
      isLower: Set<number>;
      isTitle: Set<number>;
      isCased: Set<number>;
      isCaseIgnorable: Set<number>;
    }
  | undefined;

function loadTables(): NonNullable<typeof tables> {
  tables ??= {
    upper: decodeMapping(CASE_DATA.upper),
    lower: decodeMapping(CASE_DATA.lower),
    title: decodeMapping(CASE_DATA.title),
    fold: decodeMapping(CASE_DATA.fold),
    isUpper: decodeRanges(CASE_DATA.isUpper),
    isLower: decodeRanges(CASE_DATA.isLower),
    isTitle: decodeRanges(CASE_DATA.isTitle),
    isCased: decodeRanges(CASE_DATA.isCased),
    isCaseIgnorable: decodeRanges(CASE_DATA.isCaseIgnorable),
  };
  return tables;
}

function decodeMapping([runs, special]: readonly [string, string]): Mapping {
  const mapping: Mapping = new Map();
  let code = 0;
  for (const run of runs.split(';')) {
    const [offset, count, step, delta] = run.split(',').map((part) => Number.parseInt(part, 16));
    code += offset;
    for (let index = 0; index < count; index++) {
      const source = code + index * step;
      mapping.set(source, String.fromCodePoint(source + delta));
    }
    code += (count - 1) * step;
  }
  for (const entry of special.split(';')) {
    const [source, target] = entry.split(':');
    mapping.set(
      Number.parseInt(source, 16),
      String.fromCodePoint(...target.split(' ').map((part) => Number.parseInt(part, 16)))
    );
  }
  return mapping;
}

function decodeRanges(encoded: string): Set<number> {
  const set = new Set<number>();
  let code = 0;
  for (const range of encoded.split(';')) {
    const [offset, length] = range.split(',').map((part) => Number.parseInt(part, 16));
    code += offset;
    for (let index = 0; index < length; index++) set.add(code + index);
    code += length;
  }
  return set;
}

const codesOf = (text: string): number[] => Array.from(text, (char) => char.codePointAt(0) as number);
const map = (mapping: Mapping, code: number): string => mapping.get(code) ?? String.fromCodePoint(code);

export function isUpperCode(code: number): boolean {
  return hasCase(code, UPPER, 'isUpper');
}

export function isLowerCode(code: number): boolean {
  return hasCase(code, LOWER, 'isLower');
}

export function isTitleCode(code: number): boolean {
  return hasCase(code, TITLE, 'isTitle');
}

export function isCasedCode(code: number): boolean {
  return hasCase(code, CASED, 'isCased');
}

const UPPER = 1;
const LOWER = 2;
const TITLE = 4;
const CASED = 8;
/** The code points below this have their case classes in a bit table, since most text consists of them. */
const TABLED_CODES = 0x1_00;
let tabledCases: Uint8Array | undefined;

function hasCase(code: number, bit: number, set: 'isUpper' | 'isLower' | 'isTitle' | 'isCased'): boolean {
  if (code >= TABLED_CODES) return loadTables()[set].has(code);
  tabledCases ??= Uint8Array.from({ length: TABLED_CODES }, (_, each) => {
    const { isUpper, isLower, isTitle, isCased } = loadTables();
    return (
      (isUpper.has(each) ? UPPER : 0) |
      (isLower.has(each) ? LOWER : 0) |
      (isTitle.has(each) ? TITLE : 0) |
      (isCased.has(each) ? CASED : 0)
    );
  });
  return (tabledCases[code] & bit) !== 0;
}

export function upper(text: string): string {
  return converted(text, (codes) => {
    const { upper: mapping } = loadTables();
    return codes.map((code) => map(mapping, code)).join('');
  });
}

export function lower(text: string): string {
  return converted(text, (codes) => codes.map((_, index) => lowerAt(codes, index)).join(''));
}

export function casefold(text: string): string {
  return converted(text, (codes) => {
    const { fold } = loadTables();
    return codes.map((code) => map(fold, code)).join('');
  });
}

export function swapcase(text: string): string {
  return converted(text, (codes) => {
    const { upper: mapping } = loadTables();
    return codes
      .map((code, index) => {
        if (isUpperCode(code)) return lowerAt(codes, index);
        if (isLowerCode(code)) return map(mapping, code);
        return String.fromCodePoint(code);
      })
      .join('');
  });
}

export function capitalize(text: string): string {
  return converted(text, (codes) => {
    const { title: mapping } = loadTables();
    return codes.map((code, index) => (index === 0 ? map(mapping, code) : lowerAt(codes, index))).join('');
  });
}

export function title(text: string): string {
  return converted(text, (codes) => {
    const { title: mapping } = loadTables();
    let previousCased = false;
    let result = '';
    for (const [index, code] of codes.entries()) {
      result += previousCased ? lowerAt(codes, index) : map(mapping, code);
      previousCased = isCasedCode(code);
    }
    return result;
  });
}

/** Converts the code points of a text, charging the running program for the text it reads before and builds after. */
function converted(text: string, convert: (codes: number[]) => string): string {
  chargeScan(text.length);
  const result = convert(codesOf(text));
  currentRuntime().buildString(result.length);
  return result;
}

/** `str.isupper()`: a cased character and no lowercase or titlecase one. */
export function isUpperText(text: string): boolean {
  let cased = false;
  const complete = everyCode(text, (code) => {
    cased ||= isUpperCode(code);
    return !isLowerCode(code) && !isTitleCode(code);
  });
  return complete && cased;
}

/** `str.islower()`: a cased character and no uppercase or titlecase one. */
export function isLowerText(text: string): boolean {
  let cased = false;
  const complete = everyCode(text, (code) => {
    cased ||= isLowerCode(code);
    return !isUpperCode(code) && !isTitleCode(code);
  });
  return complete && cased;
}

/** `str.istitle()`: uppercase and titlecase characters only start words, lowercase ones only follow cased ones. */
export function isTitleText(text: string): boolean {
  let previousCased = false;
  let cased = false;
  const complete = everyCode(text, (code) => {
    const isCapital = isUpperCode(code) || isTitleCode(code);
    if (isCapital || isLowerCode(code)) {
      if (isCapital === previousCased) return false;
      previousCased = true;
      cased = true;
    } else {
      previousCased = false;
    }
    return true;
  });
  return complete && cased;
}

/** Whether a text is titlecased: uppercase only after uncased characters and lowercase only after cased ones. */
export function isTitleSequence<T>(
  chars: Iterable<T>,
  isUpper: (char: T) => boolean,
  isLower: (char: T) => boolean
): boolean {
  let previousCased = false;
  let sawCased = false;
  for (const char of chars) {
    if (isUpper(char)) {
      if (previousCased) return false;
      previousCased = true;
      sawCased = true;
    } else if (isLower(char)) {
      if (!previousCased) return false;
      previousCased = true;
      sawCased = true;
    } else {
      previousCased = false;
    }
  }
  return sawCased;
}

/**
 * Whether every code point of a text passes a test, reading them in order up to the first that fails, as CPython's
 * predicates do, and charging the running program for the code points read.
 */
export function everyCode(text: string, test: (code: number) => boolean): boolean {
  let read = 0;
  try {
    for (let index = 0; index < text.length; index++) {
      const code = text.codePointAt(index) as number;
      if (code > 0xff_ff) index++;
      read++;
      if (!test(code)) return false;
    }
    return true;
  } finally {
    chargeScan(read);
  }
}

const CAPITAL_SIGMA = 0x3_a3;

/** The lowercase of the character at `index`, where a capital sigma ending a word becomes the final sigma. */
function lowerAt(codes: number[], index: number): string {
  const code = codes[index];
  if (code === CAPITAL_SIGMA) return isFinalSigma(codes, index) ? 'ς' : 'σ';
  return map(loadTables().lower, code);
}

/** Whether a capital sigma follows a cased character and precedes none, case-ignorable characters aside. */
function isFinalSigma(codes: number[], index: number): boolean {
  const { isCaseIgnorable } = loadTables();
  let before = index - 1;
  while (before >= 0 && isCaseIgnorable.has(codes[before])) before--;
  if (before < 0 || !isCasedCode(codes[before])) return false;
  let after = index + 1;
  while (after < codes.length && isCaseIgnorable.has(codes[after])) after++;
  return after === codes.length || !isCasedCode(codes[after]);
}
