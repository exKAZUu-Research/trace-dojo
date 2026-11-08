import type { Candidate } from './types';

/** Merge by source range, not spelling or selector. Contained ranges remain separate. Sorting makes selector order irrelevant. */
export function uniqueCandidates(candidates: readonly Candidate[]): Candidate[] {
  const ranges = new Map<string, Candidate>();
  for (const candidate of candidates) {
    if (candidate.start >= candidate.end) continue;
    const key = `${candidate.start}:${candidate.end}`;
    const prior = ranges.get(key);
    ranges.set(key, {
      start: candidate.start,
      end: candidate.end,
      replacements: [...new Set([...(prior?.replacements ?? []), ...candidate.replacements])].toSorted(),
    });
  }
  return [...ranges.values()].toSorted((a, b) => a.start - b.start || a.end - b.end);
}
