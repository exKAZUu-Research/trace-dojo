import { reserveMemory } from '../memoryAccounting';

export interface SearchSequence<T> {
  length: bigint;
  get: (index: bigint) => T;
}

export function findSequence<T>(
  text: SearchSequence<T>,
  pattern: SearchSequence<T>,
  from: bigint,
  equal: (a: T, b: T) => boolean
): bigint | undefined {
  if (pattern.length === 0n) return from;
  return sequenceMatches(text, pattern, from, equal).next().value;
}

// code-gauge-allow functionCognitiveComplexity 19 -- Keeps scalar matching and the non-overlapping search loop together.
export function* sequenceMatches<T>(
  text: SearchSequence<T>,
  pattern: SearchSequence<T>,
  from: bigint,
  equal: (a: T, b: T) => boolean
): Generator<bigint, undefined> {
  if (pattern.length === 0n || from + pattern.length > text.length) return undefined;
  if (pattern.length === 1n) {
    const expected = pattern.get(0n);
    for (let index = from; index < text.length; index++) if (equal(text.get(index), expected)) yield index;
    return undefined;
  }
  const length = Number(pattern.length);
  reserveMemory(length * 2);
  const values = Array.from({ length }, (_, index) => pattern.get(BigInt(index)));
  const prefix = prefixTable(values, equal);
  let matched = 0;
  for (let index = from; index < text.length; index++) {
    const value = text.get(index);
    for (;;) {
      if (equal(value, values[matched])) {
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

function prefixTable<T>(pattern: readonly T[], equal: (a: T, b: T) => boolean): Float64Array {
  const prefix = new Float64Array(pattern.length);
  let matched = 0;
  for (let index = 1; index < prefix.length;) {
    if (equal(pattern[index], pattern[matched])) prefix[index++] = ++matched;
    else if (matched > 0) matched = prefix[matched - 1];
    else index++;
  }
  return prefix;
}
