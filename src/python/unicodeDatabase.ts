// CPython's Unicode character database, decoded from the generated strings the first time a program needs each part.
import {
  ALGORITHMIC_NAMES,
  COMPOSITION_EXCLUSIONS,
  DECOMPOSITIONS,
  LOOKUP_ONLY_NAMES,
  NAME_ALIASES,
  NAME_WORDS,
  NAMED_SEQUENCES,
  NAMES,
  NUMERIC_VALUES,
  PROPERTY_RECORDS,
  PROPERTY_RUNS,
} from './data/unicodeData';
import { iterStr } from './strings';

export interface CharacterProperties {
  category: string;
  bidirectional: string;
  eastAsianWidth: string;
  combining: number;
  mirrored: number;
}

/** Decodes a part of the database once, on first use. */
function lazy<T>(build: () => T): () => T {
  let value: T | undefined;
  return () => {
    value ??= build();
    return value;
  };
}

const b36 = (text: string): number => Number.parseInt(text, 36);

// Properties --------------------------------------------------------------------------------------------------------

const propertyTable = lazy(() => {
  const words = PROPERTY_RECORDS.split(' ');
  const records: CharacterProperties[] = [];
  for (let index = 0; index < words.length; index += 5) {
    records.push({
      category: words[index],
      bidirectional: words[index + 1] === '-' ? '' : words[index + 1],
      eastAsianWidth: words[index + 2],
      combining: Number(words[index + 3]),
      mirrored: Number(words[index + 4]),
    });
  }
  const runs = PROPERTY_RUNS.split(',');
  const starts = new Int32Array(runs.length);
  const indices = new Uint16Array(runs.length);
  let start = 0;
  for (const [index, run] of runs.entries()) {
    const [length, record] = run.split('.');
    starts[index] = start;
    indices[index] = b36(record);
    start += b36(length);
  }
  return { records, starts, indices };
});

export function propertiesOf(point: number): CharacterProperties {
  const { records, starts, indices } = propertyTable();
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= point) low = middle;
    else high = middle - 1;
  }
  return records[indices[low]];
}

// Numeric values ----------------------------------------------------------------------------------------------------

const numericTable = lazy(() => {
  const table = new Map<number, { kind: 'd' | 'g' | 'n'; value: number }>();
  let point = -1;
  for (const entry of NUMERIC_VALUES.split(',')) {
    const [distance, kind, value] = entry.split('/');
    point += b36(distance);
    table.set(point, { kind: kind as 'd' | 'g' | 'n', value: Number(value) });
  }
  return table;
});

/** The numeric value of a character, with whether it is also a decimal (`d`) or a digit (`g`) value. */
export function numericValueOf(point: number): { kind: 'd' | 'g' | 'n'; value: number } | undefined {
  return numericTable().get(point);
}

// Decomposition and normalization -----------------------------------------------------------------------------------

const HANGUL = { sBase: 0xac_00, lBase: 0x11_00, vBase: 0x11_61, tBase: 0x11_a7, lCount: 19, vCount: 21, tCount: 28 };
const N_COUNT = HANGUL.vCount * HANGUL.tCount;
const S_COUNT = HANGUL.lCount * N_COUNT;

const decompositionTable = lazy(() => {
  const table = new Map<number, { tag: string; points: number[] }>();
  let point = -1;
  for (const entry of DECOMPOSITIONS.split(',')) {
    const [distance, tag, points] = entry.split('/');
    point += b36(distance);
    table.set(point, { tag, points: points.split('.').map(b36) });
  }
  return table;
});

/** The decomposition of a character, with its compatibility tag, or undefined when it has none. */
export function decompositionOf(point: number): { tag: string; points: number[] } | undefined {
  const sIndex = point - HANGUL.sBase;
  if (sIndex >= 0 && sIndex < S_COUNT) {
    const points = [
      HANGUL.lBase + Math.floor(sIndex / N_COUNT),
      HANGUL.vBase + Math.floor((sIndex % N_COUNT) / HANGUL.tCount),
    ];
    if (sIndex % HANGUL.tCount !== 0) points.push(HANGUL.tBase + (sIndex % HANGUL.tCount));
    return { tag: '', points };
  }
  return decompositionTable().get(point);
}

const compositionTable = lazy(() => {
  const excluded = new Set(COMPOSITION_EXCLUSIONS.split(',').map(b36));
  const table = new Map<string, number>();
  for (const [point, { tag, points }] of decompositionTable()) {
    if (tag === '' && points.length === 2 && !excluded.has(point)) table.set(`${points[0]},${points[1]}`, point);
  }
  return table;
});

export type NormalizationForm = 'NFC' | 'NFD' | 'NFKC' | 'NFKD';

type Decomposer = (point: number) => { tag: string; points: number[] } | undefined;

/**
 * `unicodedata.normalize(form, text)`, as Unicode Standard Annex #15 defines it, decomposing as `decomposition` gives,
 * which an older version of the database changes.
 */
export function normalize(form: NormalizationForm, text: string, decomposition: Decomposer = decompositionOf): string {
  const points = decompose(
    iterStr(text).map((char) => char.codePointAt(0) as number),
    form.includes('K'),
    decomposition
  );
  return String.fromCodePoint(...(form.endsWith('C') ? compose(points) : points));
}

function decompose(points: number[], compatibility: boolean, decomposer: Decomposer): number[] {
  const result: number[] = [];
  const add = (point: number): void => {
    const decomposition = decomposer(point);
    if (decomposition && (compatibility || decomposition.tag === ''))
      for (const each of decomposition.points) add(each);
    else result.push(point);
  };
  for (const point of points) add(point);
  // Canonical ordering: a stable sort of each run of non-starters by combining class.
  for (let index = 1; index < result.length; index++) {
    const current = result[index];
    const ccc = propertiesOf(current).combining;
    if (ccc === 0) continue;
    let position = index;
    while (position > 0 && propertiesOf(result[position - 1]).combining > ccc) {
      result[position] = result[position - 1];
      position--;
    }
    result[position] = current;
  }
  return result;
}

/** Canonical composition, as UAX #15 defines it: a character joins the last starter unless something blocks it. */
function compose(points: number[]): number[] {
  if (points.length === 0) return points;
  const result = [points[0]];
  let starter = 0;
  // A leading non-starter blocks composition until a starter appears.
  let lastClass = propertiesOf(points[0]).combining === 0 ? 0 : 256;
  for (const point of points.slice(1)) {
    const ccc = propertiesOf(point).combining;
    const composite = lastClass < ccc || lastClass === 0 ? composePair(result[starter], point) : undefined;
    if (composite !== undefined) {
      result[starter] = composite;
      continue;
    }
    if (ccc === 0) starter = result.length;
    lastClass = ccc;
    result.push(point);
  }
  return result;
}

function composePair(first: number, second: number): number | undefined {
  const lIndex = first - HANGUL.lBase;
  const vIndex = second - HANGUL.vBase;
  if (lIndex >= 0 && lIndex < HANGUL.lCount && vIndex >= 0 && vIndex < HANGUL.vCount) {
    return HANGUL.sBase + (lIndex * HANGUL.vCount + vIndex) * HANGUL.tCount;
  }
  const sIndex = first - HANGUL.sBase;
  const tIndex = second - HANGUL.tBase;
  if (sIndex >= 0 && sIndex < S_COUNT && sIndex % HANGUL.tCount === 0 && tIndex > 0 && tIndex < HANGUL.tCount) {
    return first + tIndex;
  }
  return compositionTable().get(`${first},${second}`);
}

// Names -------------------------------------------------------------------------------------------------------------

const JAMO_L = ['G', 'GG', 'N', 'D', 'DD', 'R', 'M', 'B', 'BB', 'S', 'SS', '', 'J', 'JJ', 'C', 'K', 'T', 'P', 'H'];
const JAMO_V = [
  'A',
  'AE',
  'YA',
  'YAE',
  'EO',
  'E',
  'YEO',
  'YE',
  'O',
  'WA',
  'WAE',
  'OE',
  'YO',
  'U',
  'WEO',
  'WE',
  'WI',
  'YU',
  'EU',
  'YI',
  'I',
];
const JAMO_T = [
  '',
  'G',
  'GG',
  'GS',
  'N',
  'NJ',
  'NH',
  'D',
  'L',
  'LG',
  'LM',
  'LB',
  'LS',
  'LT',
  'LP',
  'LH',
  'M',
  'B',
  'BS',
  'S',
  'SS',
  'NG',
  'J',
  'C',
  'K',
  'T',
  'P',
  'H',
];
const HANGUL_PREFIX = 'HANGUL SYLLABLE ';
/** The characters of the word codes in NAMES: printable ASCII but the gap markers, quotes, and digits. */
const CODE_ALPHABET = Array.from({ length: 94 }, (_, index) => String.fromCodePoint(0x21 + index))
  .filter((char) => !`!"'\\0123456789`.includes(char))
  .join('');

function nameRanges(text: string): { start: number; end: number; prefix: string }[] {
  return text.split(',').map((entry) => {
    const [start, end, prefix] = entry.split('.');
    return { start: b36(start), end: b36(end), prefix };
  });
}

const algorithmicRanges = lazy(() => nameRanges(ALGORITHMIC_NAMES));
const lookupOnlyRanges = lazy(() => nameRanges(LOOKUP_ONLY_NAMES));

const nameTable = lazy(() => {
  const words = NAME_WORDS.split(' ');
  const table = new Map<number, string>();
  let point = -1;
  let previous: string[] = [];
  let index = 0;
  const wordAt = (): string => {
    const first = CODE_ALPHABET.indexOf(NAMES[index++]);
    if (first < 40) return words[first];
    const second = CODE_ALPHABET.indexOf(NAMES[index++]);
    if (first < 70) return words[40 + (first - 40) * 80 + second];
    const third = CODE_ALPHABET.indexOf(NAMES[index++]);
    return words[40 + 30 * 80 + (first - 70) * 6400 + second * 80 + third];
  };
  while (index < NAMES.length) {
    if (NAMES[index] === '!') {
      const end = NAMES.indexOf('"', index);
      point += b36(NAMES.slice(index + 1, end));
      index = end + 1;
    } else {
      point++;
    }
    const current = previous.slice(0, Number(NAMES[index++]));
    while (index < NAMES.length && !/[0-9!]/.test(NAMES[index])) current.push(wordAt());
    table.set(point, current.join(' '));
    previous = current;
  }
  return table;
});

const aliasTable = lazy(() => NAME_ALIASES.split(',').map((entry) => entry.split(':')));

/**
 * The name of a character, as `unicodedata.name()` gives it. With `withAliases`, the private use code points from
 * U+F0000 give the name aliases and named sequences, as the namereplace error handler shows them.
 */
export function characterName(point: number, withAliases = false): string | undefined {
  const sIndex = point - HANGUL.sBase;
  if (sIndex >= 0 && sIndex < S_COUNT) {
    const l = Math.floor(sIndex / N_COUNT);
    const v = Math.floor((sIndex % N_COUNT) / HANGUL.tCount);
    return HANGUL_PREFIX + JAMO_L[l] + JAMO_V[v] + JAMO_T[sIndex % HANGUL.tCount];
  }
  const range = algorithmicRanges().find(({ start, end }) => start <= point && point <= end);
  if (range) return `${range.prefix}-${point.toString(16).toUpperCase().padStart(4, '0')}`;
  if (withAliases && point >= 0xf_00_00 && point < 0xf_04_00) {
    const entries = point < 0xf_02_00 ? aliasTable() : sequenceTable();
    return entries[point - (point < 0xf_02_00 ? 0xf_00_00 : 0xf_02_00)]?.[0];
  }
  return nameTable().get(point);
}

const sequenceTable = lazy(() => NAMED_SEQUENCES.split(',').map((entry) => entry.split(':')));

const reverseNames = lazy(() => {
  const table = new Map<string, number>();
  for (const [point, name] of nameTable()) table.set(name, point);
  return table;
});

/**
 * The character a name stands for, matched case-insensitively as `unicodedata.lookup()` and `\N{...}` do: a code
 * point, the code points of a named sequence when `withSequences` is set, or undefined. An older database, which
 * `isAssigned` stands for, has no name aliases and no named sequences, and leaves out the names of the characters it
 * lacks, though not their algorithmic names.
 */
export function lookupName(
  text: string,
  withSequences: boolean,
  isAssigned?: (point: number) => boolean
): number | number[] | undefined {
  const name = text.replaceAll(/[a-z]/g, (char) => char.toUpperCase());
  const official = reverseNames().get(name);
  if (official !== undefined && (isAssigned?.(official) ?? true)) return official;
  const algorithmic = algorithmicPoint(name);
  if (algorithmic !== undefined) return algorithmic;
  if (isAssigned) return undefined;
  const alias = aliasTable().find(([each]) => each === name);
  if (alias) return b36(alias[1]);
  const sequence = withSequences ? sequenceTable().find(([each]) => each === name) : undefined;
  return sequence?.[1].split('.').map(b36);
}

function algorithmicPoint(name: string): number | undefined {
  if (name.startsWith(HANGUL_PREFIX)) {
    for (let point = HANGUL.sBase; point < HANGUL.sBase + S_COUNT; point++) {
      if (characterName(point) === name) return point;
    }
    return undefined;
  }
  const match = /^(.*)-([0-9A-F]{4,6})$/.exec(name);
  if (!match) return undefined;
  const point = Number.parseInt(match[2], 16);
  if (characterName(point) === name) return point;
  const range = lookupOnlyRanges().find(({ start, end }) => start <= point && point <= end);
  return range && `${range.prefix}-${point.toString(16).toUpperCase()}` === name ? point : undefined;
}
