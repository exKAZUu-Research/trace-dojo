/**
 * The candidate TypeScript suggests for a misspelled name, as its `getSpellingSuggestion` picks one: the closest within
 * a distance that grows with the name's length, where changing only a letter's case costs little.
 */
export function spellingSuggestion(name: string, candidates: Iterable<string>): string | undefined {
  const maximumLengthDifference = Math.max(2, Math.floor(name.length * 0.34));
  let bestDistance = Math.floor(name.length * 0.4) + 1;
  let best: string | undefined;
  for (const candidate of candidates) {
    if (candidate === name || Math.abs(candidate.length - name.length) > maximumLengthDifference) continue;
    if (candidate.length < 3 && candidate.toLowerCase() !== name.toLowerCase()) continue;
    const distance = levenshteinWithMax(name, candidate, bestDistance - 0.1);
    if (distance === undefined) continue;
    bestDistance = distance;
    best = candidate;
  }
  return best;
}

/** TypeScript's `levenshteinWithMax`: substituting a letter costs 2, or 0.1 for only its case; undefined past `max`. */
function levenshteinWithMax(s1: string, s2: string, max: number): number | undefined {
  let previous: number[] = Array.from({ length: s2.length + 1 }, (_, index) => index);
  let current: number[] = Array.from({ length: s2.length + 1 }, () => 0);
  const big = max + 0.01;
  for (let i = 1; i <= s1.length; i++) {
    const minJ = Math.ceil(i > max ? i - max : 1);
    const maxJ = Math.floor(s2.length > max + i ? max + i : s2.length);
    current[0] = i;
    let columnMinimum = i;
    for (let j = 1; j < minJ; j++) current[j] = big;
    for (let j = minJ; j <= maxJ; j++) {
      const substitution =
        s1[i - 1].toLowerCase() === s2[j - 1].toLowerCase() ? previous[j - 1] + 0.1 : previous[j - 1] + 2;
      const distance =
        s1[i - 1] === s2[j - 1] ? previous[j - 1] : Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
      current[j] = distance;
      columnMinimum = Math.min(columnMinimum, distance);
    }
    for (let j = maxJ + 1; j <= s2.length; j++) current[j] = big;
    if (columnMinimum > max) return undefined;
    [previous, current] = [current, previous];
  }
  const result = previous[s2.length];
  return result > max ? undefined : result;
}
