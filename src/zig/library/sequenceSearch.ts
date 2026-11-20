import { reserveMemory } from '../memoryAccounting';

export interface SearchSequence<T> {
  length: bigint;
  get: (index: bigint) => T;
  sameRange?: (other: SearchSequence<T>) => boolean;
}

const MAX_CACHED_PATTERN = 256;

export function findSequence<T>(
  text: SearchSequence<T>,
  pattern: SearchSequence<T>,
  from: bigint,
  equal: (a: T, b: T) => boolean
): bigint | undefined {
  if (pattern.length === 0n) return from;
  return sequenceMatches(text, pattern, from, equal).next().value;
}

// code-gauge-allow functionCognitiveComplexity 23 -- Keeps short search paths and the non-overlapping scan together.
// code-gauge-allow functionNcss 33 -- Keeps edge cases and per-match scan state with the matcher.
export function* sequenceMatches<T>(
  text: SearchSequence<T>,
  pattern: SearchSequence<T>,
  from: bigint,
  equal: (a: T, b: T) => boolean
): Generator<bigint, undefined> {
  if (pattern.length === 0n || from + pattern.length > text.length) return undefined;
  if (text.sameRange?.(pattern)) {
    yield 0n;
    return undefined;
  }
  if (from + pattern.length === text.length) {
    if (matchesAt(text, pattern, from, equal)) yield from;
    return undefined;
  }
  if (pattern.length === 1n) {
    const expected = pattern.get(0n);
    for (let index = from; index < text.length; index++) if (equal(text.get(index), expected)) yield index;
    return undefined;
  }
  const length = Number(pattern.length);
  const values = patternReader(pattern, length);
  const prefix = prefixTable(length, values, equal);
  let matched = 0;
  for (let index = from; index < text.length; index++) {
    const value = text.get(index);
    for (;;) {
      if (equal(value, values(matched))) {
        matched++;
        break;
      }
      if (matched === 0) break;
      matched = prefix[matched - 1];
    }
    if (matched === prefix.length) {
      yield index + 1n - pattern.length;
      matched = 0;
    }
  }
  return undefined;
}

function patternReader<T>(pattern: SearchSequence<T>, length: number): (index: number) => T {
  if (length > MAX_CACHED_PATTERN) return (index) => pattern.get(BigInt(index));
  reserveMemory(length);
  const values = Array.from({ length }, (_, index) => pattern.get(BigInt(index)));
  return (index) => values[index];
}

function prefixTable<T>(length: number, read: (index: number) => T, equal: (a: T, b: T) => boolean): Float64Array {
  reserveMemory(length);
  const prefix = new Float64Array(length);
  let matched = 0;
  for (let index = 1; index < prefix.length;) {
    if (equal(read(index), read(matched))) prefix[index++] = ++matched;
    else if (matched > 0) matched = prefix[matched - 1];
    else index++;
  }
  return prefix;
}

function matchesAt<T>(
  text: SearchSequence<T>,
  pattern: SearchSequence<T>,
  from: bigint,
  equal: (a: T, b: T) => boolean
): boolean {
  for (let index = 0n; index < pattern.length; index++)
    if (!equal(text.get(from + index), pattern.get(index))) return false;
  return true;
}
