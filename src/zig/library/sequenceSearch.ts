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
  if (from + pattern.length > text.length) return undefined;
  reserveMemory(Number(pattern.length));
  const prefix = new Float64Array(Number(pattern.length));
  let matched = 0;
  for (let index = 1; index < prefix.length;) {
    if (equal(pattern.get(BigInt(index)), pattern.get(BigInt(matched)))) prefix[index++] = ++matched;
    else if (matched > 0) matched = prefix[matched - 1];
    else index++;
  }
  matched = 0;
  for (let index = from; index < text.length;) {
    if (equal(text.get(index), pattern.get(BigInt(matched)))) {
      index++;
      if (++matched === prefix.length) return index - BigInt(matched);
    } else if (matched > 0) matched = prefix[matched - 1];
    else index++;
  }
  return undefined;
}
