import { CATEGORIES, CATEGORY_ALIASES, FOLD_CATEGORY, FOLD_SCRIPT, SCRIPTS } from './regexpUnicodeTables';
import { simpleFold } from './unicodeSupport';

/** Character classes of Go's `regexp/syntax` (parse.go, perl_groups.go): flat `[lo, hi, lo, hi, ...]` rune lists. */
export type RuneClass = number[];

/** A Unicode range table as flat `[lo, hi, stride, ...]` triples, in the order of Go's R16 and R32 ranges. */
export type RangeTable = readonly number[];

export interface CharGroup {
  sign: number;
  class: RuneClass;
}

export const MAX_RUNE = 0x10_ff_ff;
export const MIN_FOLD = 0x00_41;
export const MAX_FOLD = 0x1_e9_43;

const DIGIT = [0x30, 0x39];
const SPACE = [0x9, 0xa, 0xc, 0xd, 0x20, 0x20];
const WORD = [0x30, 0x39, 0x41, 0x5a, 0x5f, 0x5f, 0x61, 0x7a];

export const PERL_GROUPS: ReadonlyMap<string, CharGroup> = new Map([
  [String.raw`\d`, { sign: 1, class: DIGIT }],
  [String.raw`\D`, { sign: -1, class: DIGIT }],
  [String.raw`\s`, { sign: 1, class: SPACE }],
  [String.raw`\S`, { sign: -1, class: SPACE }],
  [String.raw`\w`, { sign: 1, class: WORD }],
  [String.raw`\W`, { sign: -1, class: WORD }],
]);

const POSIX_CLASSES: Record<string, RuneClass> = {
  alnum: [0x30, 0x39, 0x41, 0x5a, 0x61, 0x7a],
  alpha: [0x41, 0x5a, 0x61, 0x7a],
  ascii: [0x0, 0x7f],
  blank: [0x9, 0x9, 0x20, 0x20],
  cntrl: [0x0, 0x1f, 0x7f, 0x7f],
  digit: [0x30, 0x39],
  graph: [0x21, 0x7e],
  lower: [0x61, 0x7a],
  print: [0x20, 0x7e],
  punct: [0x21, 0x2f, 0x3a, 0x40, 0x5b, 0x60, 0x7b, 0x7e],
  space: [0x9, 0xd, 0x20, 0x20],
  upper: [0x41, 0x5a],
  word: [0x30, 0x39, 0x41, 0x5a, 0x5f, 0x5f, 0x61, 0x7a],
  xdigit: [0x30, 0x39, 0x41, 0x46, 0x61, 0x66],
};

export const POSIX_GROUPS: ReadonlyMap<string, CharGroup> = new Map(
  Object.entries(POSIX_CLASSES).flatMap(([name, runes]) => [
    [`[:${name}:]`, { sign: 1, class: runes }],
    [`[:^${name}:]`, { sign: -1, class: runes }],
  ])
);

/** Sorts the ranges and merges the overlapping or adjacent ones, as Go's `cleanClass`. */
export function cleanClass(runes: RuneClass): RuneClass {
  const pairs: [number, number][] = [];
  for (let i = 0; i < runes.length; i += 2) pairs.push([runes[i], runes[i + 1]]);
  pairs.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const result: RuneClass = [];
  for (const [lo, hi] of pairs) {
    const last = result.length - 1;
    if (last > 0 && lo <= result[last] + 1) {
      if (hi > result[last]) result[last] = hi;
      continue;
    }
    result.push(lo, hi);
  }
  return result;
}

export function inCharClass(rune: number, runes: RuneClass): boolean {
  let lo = 0;
  let hi = runes.length / 2;
  while (lo < hi) {
    const middle = (lo + hi) >>> 1;
    if (rune > runes[2 * middle + 1]) lo = middle + 1;
    else if (rune < runes[2 * middle]) hi = middle;
    else return true;
  }
  return false;
}

export function appendLiteral(runes: RuneClass, rune: number, foldCase: boolean): RuneClass {
  return foldCase ? appendFoldedRange(runes, rune, rune) : appendRange(runes, rune, rune);
}

/** Appends a range, merging it into one of the last two ranges when they touch, as Go's `appendRange`. */
export function appendRange(runes: RuneClass, lo: number, hi: number): RuneClass {
  const n = runes.length;
  for (let i = 2; i <= 4; i += 2) {
    if (n >= i) {
      const rlo = runes[n - i];
      const rhi = runes[n - i + 1];
      if (lo <= rhi + 1 && rlo <= hi + 1) {
        if (lo < rlo) runes[n - i] = lo;
        if (hi > rhi) runes[n - i + 1] = hi;
        return runes;
      }
    }
  }
  runes.push(lo, hi);
  return runes;
}

export function appendFoldedRange(runes: RuneClass, from: number, to: number): RuneClass {
  let lo = from;
  let hi = to;
  if ((lo <= MIN_FOLD && hi >= MAX_FOLD) || hi < MIN_FOLD || lo > MAX_FOLD) return appendRange(runes, lo, hi);
  let result = runes;
  if (lo < MIN_FOLD) {
    result = appendRange(result, lo, MIN_FOLD - 1);
    lo = MIN_FOLD;
  }
  if (hi > MAX_FOLD) {
    result = appendRange(result, MAX_FOLD + 1, hi);
    hi = MAX_FOLD;
  }
  for (let c = lo; c <= hi; c++) {
    result = appendRange(result, c, c);
    for (let f = simpleFold(c); f !== c; f = simpleFold(f)) result = appendRange(result, f, f);
  }
  return result;
}

export function appendClass(runes: RuneClass, other: RuneClass): RuneClass {
  let result = runes;
  for (let i = 0; i < other.length; i += 2) result = appendRange(result, other[i], other[i + 1]);
  return result;
}

export function appendFoldedClass(runes: RuneClass, other: RuneClass): RuneClass {
  let result = runes;
  for (let i = 0; i < other.length; i += 2) result = appendFoldedRange(result, other[i], other[i + 1]);
  return result;
}

export function appendNegatedClass(runes: RuneClass, other: RuneClass): RuneClass {
  let result = runes;
  let nextLo = 0;
  for (let i = 0; i < other.length; i += 2) {
    if (nextLo <= other[i] - 1) result = appendRange(result, nextLo, other[i] - 1);
    nextLo = other[i + 1] + 1;
  }
  if (nextLo <= MAX_RUNE) result = appendRange(result, nextLo, MAX_RUNE);
  return result;
}

export function appendTable(runes: RuneClass, table: RangeTable): RuneClass {
  let result = runes;
  for (let i = 0; i < table.length; i += 3) {
    const [lo, hi, stride] = [table[i], table[i + 1], table[i + 2]];
    if (stride === 1) {
      result = appendRange(result, lo, hi);
      continue;
    }
    for (let c = lo; c <= hi; c += stride) result = appendRange(result, c, c);
  }
  return result;
}

export function appendNegatedTable(runes: RuneClass, table: RangeTable): RuneClass {
  let result = runes;
  let nextLo = 0;
  for (let i = 0; i < table.length; i += 3) {
    const [lo, hi, stride] = [table[i], table[i + 1], table[i + 2]];
    if (stride === 1) {
      if (nextLo <= lo - 1) result = appendRange(result, nextLo, lo - 1);
      nextLo = hi + 1;
      continue;
    }
    for (let c = lo; c <= hi; c += stride) {
      if (nextLo <= c - 1) result = appendRange(result, nextLo, c - 1);
      nextLo = c + 1;
    }
  }
  if (nextLo <= MAX_RUNE) result = appendRange(result, nextLo, MAX_RUNE);
  return result;
}

export function negateClass(runes: RuneClass): RuneClass {
  const result: RuneClass = [];
  let nextLo = 0;
  for (let i = 0; i < runes.length; i += 2) {
    if (nextLo <= runes[i] - 1) result.push(nextLo, runes[i] - 1);
    nextLo = runes[i + 1] + 1;
  }
  if (nextLo <= MAX_RUNE) result.push(nextLo, MAX_RUNE);
  return result;
}

// Unicode tables --------------------------------------------------------------------------------------------------

const ANY_TABLE: RangeTable = [0, 0xff_ff, 1, 0x1_00_00, MAX_RUNE, 1];
const ASCII_TABLE: RangeTable = [0, 0x7f, 1];
const ASCII_FOLD_TABLE: RangeTable = [0, 0x7f, 1, 0x01_7f, 0x01_7f, 1, 0x21_2a, 0x21_2a, 1];

const CONTINUATION_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ()*+,-';
const FINAL_DIGITS = '0123456789abcdefghijklmnopqrstuv';
const decoded = new Map<string, RangeTable>();

function decodeTable(encoded: string): RangeTable {
  const cached = decoded.get(encoded);
  if (cached) return cached;
  let at = 0;
  const next = (): number => {
    let value = 0;
    for (;;) {
      const char = encoded[at++];
      const final = FINAL_DIGITS.indexOf(char);
      if (final !== -1) return value * 32 + final;
      value = value * 32 + CONTINUATION_DIGITS.indexOf(char);
    }
  };
  const table: number[] = [];
  let previous = -1;
  while (at < encoded.length) {
    const lo = previous + next();
    const spanAndStride = next();
    const hi = lo + Math.floor(spanAndStride / 2);
    table.push(lo, hi, spanAndStride % 2 === 1 ? next() : 1);
    previous = hi;
  }
  decoded.set(encoded, table);
  return table;
}

function table(tables: Readonly<Record<string, string>>, name: string): RangeTable | undefined {
  return Object.hasOwn(tables, name) ? decodeTable(tables[name]) : undefined;
}

/** Go's `canonicalName` in regexp/syntax: drops `_`, `-` and spaces, and capitalizes only the first letter. */
function canonicalName(name: string): string {
  let result = '';
  let first = true;
  for (const char of name) {
    if (char === '_' || char === '-' || char === ' ') continue;
    if (first) {
      result += char >= 'a' && char <= 'z' ? char.toUpperCase() : char;
      first = false;
    } else {
      result += char >= 'A' && char <= 'Z' ? char.toLowerCase() : char;
    }
  }
  return result;
}

let aliases: { categories: Map<string, string>; scripts: Map<string, string> } | undefined;

/** The table of a `\p{name}` class, the table of its case variants, and whether the class is negated. */
export function unicodeTable(name: string): { tab?: RangeTable; fold?: RangeTable; sign: number } {
  const canonical = canonicalName(name);
  switch (canonical) {
    case 'Any': {
      return { tab: ANY_TABLE, fold: ANY_TABLE, sign: 1 };
    }
    case 'Assigned': {
      return { tab: table(CATEGORIES, 'Cn'), fold: table(CATEGORIES, 'Cn'), sign: -1 };
    }
    case 'ascii': {
      return { tab: ASCII_TABLE, fold: ASCII_FOLD_TABLE, sign: 1 };
    }
    case 'Lc': {
      return { tab: table(CATEGORIES, 'LC'), fold: table(FOLD_CATEGORY, 'LC'), sign: 1 };
    }
  }
  const category = table(CATEGORIES, canonical);
  if (category) return { tab: category, fold: table(FOLD_CATEGORY, canonical), sign: 1 };
  const script = table(SCRIPTS, canonical);
  if (script) return { tab: script, fold: table(FOLD_SCRIPT, canonical), sign: 1 };
  aliases ??= {
    categories: new Map(Object.entries(CATEGORY_ALIASES).map(([alias, actual]) => [canonicalName(alias), actual])),
    scripts: new Map(Object.keys(SCRIPTS).map((script) => [canonicalName(script), script])),
  };
  const actualCategory = aliases.categories.get(canonical);
  if (actualCategory) {
    return { tab: table(CATEGORIES, actualCategory), fold: table(FOLD_CATEGORY, actualCategory), sign: 1 };
  }
  const actualScript = aliases.scripts.get(canonical);
  if (actualScript) return { tab: table(SCRIPTS, actualScript), fold: table(FOLD_SCRIPT, actualScript), sign: 1 };
  return { sign: 0 };
}
