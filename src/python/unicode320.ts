// The Unicode 3.2.0 database of `unicodedata.ucd_3_2_0`, which CPython keeps as changes to the current one, as
// data/unicode320.ts lists them, for the IDNA codec and stringprep.
import {
  NORMALIZATION_CORRECTIONS,
  OLD_BIDIRECTIONAL,
  OLD_CATEGORY,
  OLD_COMBINING,
  OLD_DECIMAL,
  OLD_DECOMPOSITION,
  OLD_EAST_ASIAN_WIDTH,
  OLD_MIRRORED,
  OLD_NUMERIC,
} from './data/unicode320';
import { type CharacterProperties, decompositionOf, numericValueOf, propertiesOf } from './unicodeDatabase';

/** Runs of code points with the value they have instead, sorted by their first code point. */
interface Runs {
  firsts: number[];
  lasts: number[];
  values: string[];
}

const cache = new Map<string, Runs>();

function runsOf(text: string): Runs {
  const cached = cache.get(text);
  if (cached) return cached;
  const runs: Runs = { firsts: [], lasts: [], values: [] };
  for (const entry of text.split(',')) {
    if (entry === '') continue;
    const [first, last, ...value] = entry.split('.');
    runs.firsts.push(Number.parseInt(first, 36));
    runs.lasts.push(Number.parseInt(last, 36));
    runs.values.push(value.join('.'));
  }
  cache.set(text, runs);
  return runs;
}

/** The Unicode 3.2.0 value of a code point when it differs from the current one, by binary search. */
function changed(text: string, point: number): string | undefined {
  const { firsts, lasts, values } = runsOf(text);
  let low = 0;
  let high = firsts.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (point < firsts[middle]) high = middle - 1;
    else if (point > lasts[middle]) low = middle + 1;
    else return values[middle];
  }
  return undefined;
}

export function oldProperties(point: number): CharacterProperties {
  const now = propertiesOf(point);
  const bidirectional = changed(OLD_BIDIRECTIONAL, point);
  const combining = changed(OLD_COMBINING, point);
  const mirrored = changed(OLD_MIRRORED, point);
  return {
    category: changed(OLD_CATEGORY, point) ?? now.category,
    bidirectional: bidirectional ?? now.bidirectional,
    eastAsianWidth: changed(OLD_EAST_ASIAN_WIDTH, point) ?? now.eastAsianWidth,
    combining: combining === undefined ? now.combining : Number(combining),
    mirrored: mirrored === undefined ? now.mirrored : Number(mirrored),
  };
}

/** Whether Unicode 3.2.0 leaves a code point unassigned, which then has no name and no decomposition. */
export function isOldUnassigned(point: number): boolean {
  return oldProperties(point).category === 'Cn';
}

/** The decimal, digit, or numeric value of a character in Unicode 3.2.0, whose digit values are the current ones. */
export function oldNumericValue(point: number, kind: 'decimal' | 'digit' | 'numeric'): number | undefined {
  const now = numericValueOf(point);
  const current =
    now === undefined || (kind === 'decimal' && now.kind !== 'd') || (kind === 'digit' && now.kind === 'n')
      ? undefined
      : now.value;
  if (kind === 'digit') return current;
  const before = changed(kind === 'decimal' ? OLD_DECIMAL : OLD_NUMERIC, point);
  if (before === undefined) return current;
  return before === '-' ? undefined : Number(before);
}

/** The decomposition of a character in Unicode 3.2.0, as `decomposition()` shows it. */
export function oldDecomposition(point: number): { tag: string; points: number[] } | undefined {
  return changed(OLD_DECOMPOSITION, point) === undefined ? decompositionOf(point) : undefined;
}

const corrections = new Map(NORMALIZATION_CORRECTIONS);

/** The decomposition that normalizing in Unicode 3.2.0 follows, with CPython's corrections to a few of them. */
export function oldNormalizationDecomposition(point: number): { tag: string; points: number[] } | undefined {
  const correction = corrections.get(point);
  if (correction !== undefined) return { tag: '', points: [correction] };
  return isOldUnassigned(point) ? undefined : decompositionOf(point);
}
