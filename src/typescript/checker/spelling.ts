import type { Scope } from './scopes';

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
  for (let i = 1; i <= s1.length; i++) {
    if (fillRow(s1[i - 1], s2, i, max, previous, current) > max) return undefined;
    [previous, current] = [current, previous];
  }
  const result = previous[s2.length];
  return result > max ? undefined : result;
}

/** Fills the distances to `s2`'s prefixes after one more letter of the other string, returning their minimum. */
function fillRow(letter: string, s2: string, i: number, max: number, previous: number[], current: number[]): number {
  const big = max + 0.01;
  const minJ = Math.ceil(i > max ? i - max : 1);
  const maxJ = Math.floor(s2.length > max + i ? max + i : s2.length);
  current[0] = i;
  let minimum = i;
  for (let j = 1; j <= s2.length; j++) {
    if (j < minJ || j > maxJ) {
      current[j] = big;
      continue;
    }
    const substitution = letter.toLowerCase() === s2[j - 1].toLowerCase() ? previous[j - 1] + 0.1 : previous[j - 1] + 2;
    current[j] = letter === s2[j - 1] ? previous[j - 1] : Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
    minimum = Math.min(minimum, current[j]);
  }
  return minimum;
}

/** The hint TypeScript adds to an unknown name: the visible value or type name it may misspell, if any. */
export function nameSuggestionHint(scope: Scope, name: string, meaning: 'value' | 'type'): string {
  const suggestion = spellingSuggestion(name, visibleNames(scope, meaning));
  return suggestion ? `'${suggestion}' のことですか？` : '';
}

/** The names of the values or types a scope and the scopes around it declare, the globals included. */
function visibleNames(scope: Scope, meaning: 'value' | 'type'): Set<string> {
  // `undefined` is a global the checker types without declaring it.
  const names = new Set<string>(meaning === 'value' ? ['undefined'] : []);
  for (let current: Scope | undefined = scope; current; current = current.parent)
    for (const name of (meaning === 'value' ? current.values : current.types).keys()) names.add(name);
  return names;
}
