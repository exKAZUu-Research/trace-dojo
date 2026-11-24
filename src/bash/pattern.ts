/**
 * Clean-room shell wildcard and POSIX bracket pattern matcher for `case`, `[[ == ]]`, and parameter-expansion
 * pattern operators (`#`, `##`, `%`, `%%`, `/`, `//`, `/#`, `/%`, `^`, `,`, `~`).
 * Backslashes quote the following pattern character; unquoted `*`, `?`, and `[...]` act as wildcards.
 */

import { charactersOf, POSIX_CHARACTER_CLASSES } from './characters';
import { compareCollated, matchesGlobEquivalenceClass, resolveCollatingElement } from './collation';

type BracketSpec =
  | { kind: 'char'; c: string }
  | { kind: 'range'; low: number; high: number }
  | { kind: 'class'; test: ((c: string) => boolean) | undefined };

type GlobAtom =
  | { kind: 'star' }
  | { kind: 'any' }
  | { kind: 'char'; c: string }
  | { kind: 'bracket'; negated: boolean; specs: BracketSpec[] };

export interface CompiledGlob {
  readonly atoms: readonly GlobAtom[];
  readonly hasStar: boolean;
}

const CHARACTER_CLASSES: Record<string, (c: string) => boolean> = {
  ...POSIX_CHARACTER_CLASSES,
  ascii: (c) => (c.codePointAt(0) as number) < 128,
  word: (c) => /^[\p{L}\p{N}_]$/u.test(c),
};

interface BracketScanMemo {
  readonly failedAfterFirst: Uint8Array;
  readonly failedSubbracket: Uint8Array;
}

/** Whether the entire `text` matches `pattern`. */
export function matchesPattern(pattern: string, text: string, spend: () => void, extmatch = false): boolean {
  const chars = charactersOf(text);
  return matchesSlice(compileGlob(pattern, spend, extmatch), chars, 0, chars.length, spend);
}

/** Whether `pattern` contains any unescaped `*`, `?`, or closed `[...]` wildcard. */
export function hasPatternCharacters(pattern: string, spend?: () => void): boolean {
  return compileGlob(pattern, spend).atoms.some((atom) => atom.kind !== 'char');
}

/** Whether `pattern` contains an unescaped extended-glob operator (`?(...)`, `*(...)`, `+(...)`, `@(...)`, `!(...)`) outside `[...]`. */
export function hasExtendedGlob(pattern: string, spend?: () => void): boolean {
  const chars = charactersOf(pattern);
  return scanExtendedGlob(chars, spend, createBracketScanMemo(chars.length)).closed;
}

/** Escapes shell glob and bracket-expression operators so `text` matches literally. */
export function quotePattern(text: string): string {
  return text.replaceAll(/[*?[\]\\!^\-+@():=.]/g, (c) => `\\${c}`);
}

/** Compiles a shell pattern into a sequence of wildcard, literal, and bracket atoms. */
export function compileGlob(pattern: string, spend?: () => void, extmatch = false): CompiledGlob {
  const chars = charactersOf(pattern);
  const memo = createBracketScanMemo(chars.length);
  const literalFrom = extmatch ? scanExtendedGlob(chars, spend, memo).firstUnclosedOpener : undefined;
  const atoms: GlobAtom[] = [];
  let hasStar = false;
  for (let i = 0; i < chars.length;) {
    spend?.();
    if (literalFrom !== undefined && i >= literalFrom) {
      atoms.push({ kind: 'char', c: chars[i] });
      i++;
      continue;
    }
    const { atom, next } = readGlobAtom(chars, i, spend, memo);
    if (atom.kind === 'star') {
      hasStar = true;
      if (atoms.at(-1)?.kind !== 'star') atoms.push(atom);
    } else {
      atoms.push(atom);
    }
    i = next;
  }
  return { atoms, hasStar };
}

function createBracketScanMemo(length: number): BracketScanMemo {
  return {
    failedAfterFirst: new Uint8Array(length + 1),
    failedSubbracket: new Uint8Array(length + 1),
  };
}

function scanExtendedGlob(
  chars: readonly string[],
  spend: (() => void) | undefined,
  memo: BracketScanMemo
): { closed: boolean; firstUnclosedOpener: number | undefined } {
  const stack: (number | undefined)[] = [];
  for (let i = 0; i < chars.length;) {
    spend?.();
    const c = chars[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '[') {
      const bracket = readBracketExpression(chars, i + 1, spend, memo);
      if (bracket) {
        i = bracket.next;
        continue;
      }
    } else if ('?*+@!'.includes(c) && chars[i + 1] === '(') {
      stack.push(i);
      i += 2;
      continue;
    } else if (c === '(') {
      stack.push(undefined);
    } else if (c === ')' && stack.length > 0 && stack.pop() !== undefined) {
      return { closed: true, firstUnclosedOpener: undefined };
    }
    i++;
  }
  return { closed: false, firstUnclosedOpener: stack.find((opener) => opener !== undefined) };
}

function readGlobAtom(
  chars: readonly string[],
  i: number,
  spend: (() => void) | undefined,
  memo: BracketScanMemo
): { atom: GlobAtom; next: number } {
  const c = chars[i];
  if (c === '*') return { atom: { kind: 'star' }, next: i + 1 };
  if (c === '?') return { atom: { kind: 'any' }, next: i + 1 };
  if (c === '\\') return { atom: { kind: 'char', c: i + 1 < chars.length ? chars[i + 1] : '\\' }, next: i + 2 };
  if (c === '[') {
    const bracket = readBracketExpression(chars, i + 1, spend, memo);
    if (bracket)
      return { atom: { kind: 'bracket', negated: bracket.negated, specs: bracket.specs }, next: bracket.next };
  }
  return { atom: { kind: 'char', c }, next: i + 1 };
}

/** End index of the shortest prefix of `chars[start..]` matching `glob`, or `undefined` if none matches. */
export function shortestPrefixMatch(
  glob: CompiledGlob,
  chars: readonly string[],
  start: number,
  spend: () => void
): number | undefined {
  if (!glob.hasStar) {
    const end = start + glob.atoms.length;
    return end <= chars.length && matchesFixed(glob.atoms, chars, start, spend) ? end : undefined;
  }
  return scanStates(glob.atoms, chars, start, chars.length, true, spend);
}

/** End index of the longest prefix of `chars[start..]` matching `glob`, or `undefined` if none matches. */
export function longestPrefixMatch(
  glob: CompiledGlob,
  chars: readonly string[],
  start: number,
  spend: () => void
): number | undefined {
  if (!glob.hasStar) {
    const end = start + glob.atoms.length;
    return end <= chars.length && matchesFixed(glob.atoms, chars, start, spend) ? end : undefined;
  }
  return scanStates(glob.atoms, chars, start, chars.length, false, spend);
}

/** Start index of the shortest suffix of `chars` matching `glob`, or `undefined` if none matches. */
export function shortestSuffixMatch(
  glob: CompiledGlob,
  chars: readonly string[],
  spend: () => void
): number | undefined {
  const reversedEnd = shortestPrefixMatch(reverseGlob(glob), chars.toReversed(), 0, spend);
  return reversedEnd === undefined ? undefined : chars.length - reversedEnd;
}

/** Start index of the longest suffix of `chars` matching `glob`, or `undefined` if none matches. */
export function longestSuffixMatch(
  glob: CompiledGlob,
  chars: readonly string[],
  spend: () => void
): number | undefined {
  const reversedEnd = longestPrefixMatch(reverseGlob(glob), chars.toReversed(), 0, spend);
  return reversedEnd === undefined ? undefined : chars.length - reversedEnd;
}

/**
 * Finds the leftmost-longest substring `chars[start..end]` with `start >= from` matching `glob` in one pass,
 * or `undefined` when no match exists in `chars[from..]`.
 */
export function nextLeftmostLongestMatch(
  glob: CompiledGlob,
  chars: readonly string[],
  from: number,
  spend: () => void
): { start: number; end: number } | undefined {
  const count = glob.atoms.length;
  if (from >= chars.length) {
    return chars.length === 0 && from === 0 && glob.atoms.every((atom) => atom.kind === 'star')
      ? { start: 0, end: 0 }
      : undefined;
  }
  let starts = new Int32Array(count + 1).fill(-1);
  let next = new Int32Array(count + 1).fill(-1);
  let best: { start: number; end: number } | undefined;
  for (let pos = from; pos < chars.length; pos++) {
    spend();
    if (!best && starts[0] === -1) {
      starts[0] = pos;
      closeStarStarts(glob.atoms, starts);
      best = pickBetterMatch(best, starts[count], pos);
    }
    stepAtomStarts(glob.atoms, starts, next, chars[pos]);
    [starts, next] = [next, starts];
    next.fill(-1);
    best = pickBetterMatch(best, starts[count], pos + 1);
    if (best && !hasActiveStartAtOrBefore(starts, count, best.start)) break;
  }
  return best;
}

function reverseGlob(glob: CompiledGlob): CompiledGlob {
  return { atoms: glob.atoms.toReversed(), hasStar: glob.hasStar };
}

/** Whether `chars[start..end]` as a whole matches `glob`. */
export function matchesSlice(
  glob: CompiledGlob,
  chars: readonly string[],
  start: number,
  end: number,
  spend: () => void
): boolean {
  if (!glob.hasStar) {
    return end - start === glob.atoms.length && matchesFixed(glob.atoms, chars, start, spend);
  }
  return scanSlice(glob.atoms, chars, start, end, spend);
}

function matchesFixed(atoms: readonly GlobAtom[], chars: readonly string[], start: number, spend: () => void): boolean {
  spend();
  for (const [offset, atom] of atoms.entries()) {
    if (!matchesAtom(atom, chars[start + offset])) return false;
  }
  return true;
}

/** Advances an NFA state-set across `chars[start..limit]`, returning the shortest or longest matching end index. */
function scanStates(
  atoms: readonly GlobAtom[],
  chars: readonly string[],
  start: number,
  limit: number,
  stopAtFirst: boolean,
  spend: () => void
): number | undefined {
  const count = atoms.length;
  let current = new Uint8Array(count + 1);
  let next = new Uint8Array(count + 1);
  current[0] = 1;
  closeStars(atoms, current);
  let matchedEnd: number | undefined = current[count] ? start : undefined;
  if (stopAtFirst && matchedEnd !== undefined) return matchedEnd;
  for (let pos = start; pos < limit; pos++) {
    spend();
    if (!stepAtoms(atoms, current, next, chars[pos])) break;
    [current, next] = [next, current];
    next.fill(0);
    if (current[count]) {
      if (stopAtFirst) return pos + 1;
      matchedEnd = pos + 1;
    }
  }
  return matchedEnd;
}

function scanSlice(
  atoms: readonly GlobAtom[],
  chars: readonly string[],
  start: number,
  end: number,
  spend: () => void
): boolean {
  const count = atoms.length;
  let current = new Uint8Array(count + 1);
  let next = new Uint8Array(count + 1);
  current[0] = 1;
  closeStars(atoms, current);
  for (let pos = start; pos < end; pos++) {
    spend();
    if (!stepAtoms(atoms, current, next, chars[pos])) return false;
    [current, next] = [next, current];
    next.fill(0);
  }
  return current[count] === 1;
}

function closeStars(atoms: readonly GlobAtom[], state: Uint8Array): void {
  for (let i = 0; i < atoms.length; i++) {
    if (state[i] && atoms[i].kind === 'star') state[i + 1] = 1;
  }
}

function stepAtoms(atoms: readonly GlobAtom[], current: Uint8Array, next: Uint8Array, ch: string): boolean {
  let anyActive = false;
  for (let i = 0; i < atoms.length; i++) {
    if (!current[i]) continue;
    const atom = atoms[i];
    if (atom.kind === 'star') {
      next[i] = 1;
      anyActive = true;
    } else if (matchesAtom(atom, ch)) {
      next[i + 1] = 1;
      anyActive = true;
    }
  }
  if (anyActive) closeStars(atoms, next);
  return anyActive;
}

function pickBetterMatch(
  best: { start: number; end: number } | undefined,
  candidateStart: number,
  candidateEnd: number
): { start: number; end: number } | undefined {
  if (candidateStart === -1) return best;
  if (!best || candidateStart < best.start || (candidateStart === best.start && candidateEnd > best.end)) {
    return { start: candidateStart, end: candidateEnd };
  }
  return best;
}

function closeStarStarts(atoms: readonly GlobAtom[], state: Int32Array): void {
  for (let i = 0; i < atoms.length; i++) {
    if (state[i] !== -1 && atoms[i].kind === 'star') state[i + 1] = minStart(state[i + 1], state[i]);
  }
}

function stepAtomStarts(atoms: readonly GlobAtom[], current: Int32Array, next: Int32Array, ch: string): void {
  for (let i = 0; i < atoms.length; i++) {
    const origin = current[i];
    if (origin === -1) continue;
    const atom = atoms[i];
    if (atom.kind === 'star') next[i] = minStart(next[i], origin);
    else if (matchesAtom(atom, ch)) next[i + 1] = minStart(next[i + 1], origin);
  }
  closeStarStarts(atoms, next);
}

function minStart(existing: number, candidate: number): number {
  return existing === -1 || candidate < existing ? candidate : existing;
}

function hasActiveStartAtOrBefore(state: Int32Array, count: number, limitStart: number): boolean {
  for (let i = 0; i < count; i++) {
    if (state[i] !== -1 && state[i] <= limitStart) return true;
  }
  return false;
}

function matchesAtom(atom: GlobAtom, ch: string): boolean {
  if (atom.kind === 'any') return true;
  if (atom.kind === 'char') return ch === atom.c;
  if (atom.kind === 'star') return true;
  const code = ch.codePointAt(0) as number;
  const hit = atom.specs.some((spec) => {
    if (spec.kind === 'char') return ch === spec.c;
    if (spec.kind === 'range') return code >= spec.low && code <= spec.high;
    return spec.test?.(ch) ?? false;
  });
  return hit !== atom.negated;
}

interface BracketAtom {
  c: string | undefined;
  collating: boolean;
  next: number;
}

/** Parses `[...]` starting just after `[`, or returns `undefined` if unclosed. */
// code-gauge-allow functionCognitiveComplexity -- Parses optional negation, leading `]`, POSIX sub-brackets, and character ranges with linear failure memoization.
// code-gauge-allow functionNcss -- Parses optional negation, leading `]`, POSIX sub-brackets, and character ranges.
function readBracketExpression(
  chars: readonly string[],
  start: number,
  spend: (() => void) | undefined,
  memo: BracketScanMemo
): { negated: boolean; specs: BracketSpec[]; next: number } | undefined {
  let pos = start;
  const negated = chars[pos] === '!' || chars[pos] === '^';
  if (negated) pos++;
  const specs: BracketSpec[] = [];
  const visited: number[] = [];
  let first = true;
  while (pos < chars.length) {
    spend?.();
    if (!first) {
      if (memo.failedAfterFirst[pos]) return markBracketFailure(memo, visited);
      visited.push(pos);
    }
    if (chars[pos] === ']' && !first) return { negated, specs, next: pos + 1 };
    first = false;
    const subbracket = tryReadSubbracketSpec(chars, pos, spend, memo);
    if (subbracket) {
      specs.push(subbracket.spec);
      pos = subbracket.next;
      continue;
    }
    const startAtom = readBracketAtom(chars, pos, spend, memo);
    if (!startAtom) return markBracketFailure(memo, visited);
    pos = startAtom.next;
    if (chars[pos] === '-' && pos + 1 < chars.length && chars[pos + 1] !== ']') {
      const endAtom = readBracketAtom(chars, pos + 1, spend, memo);
      if (!endAtom) return markBracketFailure(memo, visited);
      pos = endAtom.next;
      const rangeSpec = buildRangeSpec(startAtom, endAtom);
      if (rangeSpec) specs.push(rangeSpec);
      continue;
    }
    if (startAtom.c !== undefined) specs.push({ kind: 'char', c: startAtom.c });
  }
  return markBracketFailure(memo, visited);
}

function markBracketFailure(memo: BracketScanMemo, visited: readonly number[]): undefined {
  for (const pos of visited) memo.failedAfterFirst[pos] = 1;
  return undefined;
}

function buildRangeSpec(startAtom: BracketAtom, endAtom: BracketAtom): BracketSpec | undefined {
  const startChar = startAtom.c;
  const endChar = endAtom.c;
  if (startChar === undefined || endChar === undefined) return undefined;
  if (startAtom.collating || endAtom.collating) {
    if (compareCollated(startChar, endChar) > 0) return undefined;
    return {
      kind: 'class',
      test: (ch) => compareCollated(startChar, ch) <= 0 && compareCollated(ch, endChar) <= 0,
    };
  }
  const low = startChar.codePointAt(0) as number;
  const high = endChar.codePointAt(0) as number;
  return low <= high ? { kind: 'range', low, high } : undefined;
}

function tryReadSubbracketSpec(
  chars: readonly string[],
  pos: number,
  spend: (() => void) | undefined,
  memo: BracketScanMemo
): { spec: BracketSpec; next: number } | undefined {
  const kind = chars[pos + 1];
  if (chars[pos] !== '[' || (kind !== ':' && kind !== '=')) return undefined;
  const end = findSubbracketClose(chars, pos + 2, kind, spend, memo);
  if (end === undefined) return undefined;
  const name = chars
    .slice(pos + 2, end)
    .join('')
    .replaceAll(/\\(.)/g, '$1');
  if (kind === ':') {
    const test = Object.hasOwn(CHARACTER_CLASSES, name) ? CHARACTER_CLASSES[name] : undefined;
    return { spec: { kind: 'class', test }, next: end + 2 };
  }
  const target = resolveCollatingElement(name);
  const test = target === undefined ? undefined : (ch: string): boolean => matchesGlobEquivalenceClass(target, ch);
  return { spec: { kind: 'class', test }, next: end + 2 };
}

function readBracketAtom(
  chars: readonly string[],
  pos: number,
  spend: (() => void) | undefined,
  memo: BracketScanMemo
): BracketAtom | undefined {
  if (pos >= chars.length) return undefined;
  if (chars[pos] === '[' && chars[pos + 1] === '.') {
    const end = findSubbracketClose(chars, pos + 2, '.', spend, memo);
    if (end !== undefined) {
      const name = chars
        .slice(pos + 2, end)
        .join('')
        .replaceAll(/\\(.)/g, '$1');
      return { c: resolveCollatingElement(name), collating: true, next: end + 2 };
    }
  }
  if (chars[pos] === '\\') {
    return pos + 1 < chars.length ? { c: chars[pos + 1], collating: false, next: pos + 2 } : undefined;
  }
  return { c: chars[pos], collating: false, next: pos + 1 };
}

function findSubbracketClose(
  chars: readonly string[],
  from: number,
  delimiter: ':' | '=' | '.',
  spend: (() => void) | undefined,
  memo: BracketScanMemo
): number | undefined {
  const bit = delimiter === ':' ? 1 : delimiter === '=' ? 2 : 4;
  if (memo.failedSubbracket[from] & bit) return undefined;
  for (let i = from; i + 1 < chars.length; i++) {
    spend?.();
    if (i > from && delimiter !== '.' && chars[i] === ']') {
      return markSubbracketFailure(memo.failedSubbracket, from, i, bit);
    }
    if (chars[i] === delimiter && chars[i + 1] === ']') return i;
  }
  return markSubbracketFailure(memo.failedSubbracket, from, chars.length, bit);
}

function markSubbracketFailure(failed: Uint8Array, from: number, to: number, bit: number): undefined {
  for (let k = from; k <= to; k++) failed[k] |= bit;
  return undefined;
}
