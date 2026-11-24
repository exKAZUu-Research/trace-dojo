/**
 * Clean-room shell wildcard and POSIX bracket pattern matcher for `case`, `[[ == ]]`, and parameter-expansion
 * pattern operators (`#`, `##`, `%`, `%%`, `/`, `//`, `/#`, `/%`, `^`, `,`, `~`).
 * Backslashes quote the following pattern character; unquoted `*`, `?`, and `[...]` act as wildcards.
 */

import { charactersOf } from './characters';

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
  alnum: (c) => /^[\p{L}\p{N}]$/u.test(c),
  alpha: (c) => /^\p{L}$/u.test(c),
  ascii: (c) => (c.codePointAt(0) as number) < 128,
  blank: (c) => c === ' ' || c === '\t',
  cntrl: (c) => /^\p{Cc}$/u.test(c),
  digit: (c) => /^[0-9]$/.test(c),
  graph: (c) => /^[^\p{C}\p{Z}]$/u.test(c),
  lower: (c) => /^\p{Ll}$/u.test(c),
  print: (c) => /^[^\p{C}]$/u.test(c) && c !== '\u2028' && c !== '\u2029',
  punct: (c) => /^[!-/:-@[-`{-~]$/.test(c),
  space: (c) => /^[ \t\n\v\f\r]$/.test(c),
  upper: (c) => /^\p{Lu}$/u.test(c),
  word: (c) => /^[\p{L}\p{N}_]$/u.test(c),
  xdigit: (c) => /^[0-9A-Fa-f]$/.test(c),
};

const COLLATING_SYMBOLS: Record<string, string> = {
  NUL: '\0',
  tab: '\t',
  newline: '\n',
  'vertical-tab': '\v',
  'form-feed': '\f',
  'carriage-return': '\r',
  space: ' ',
  hyphen: '-',
  period: '.',
  slash: '/',
  backslash: '\\',
  underscore: '_',
  'left-square-bracket': '[',
  'right-square-bracket': ']',
};

/** Whether the entire `text` matches `pattern`. */
export function matchesPattern(pattern: string, text: string, spend: () => void): boolean {
  const chars = charactersOf(text);
  return matchesSlice(compileGlob(pattern), chars, 0, chars.length, spend);
}

/** Whether `pattern` contains any unescaped `*`, `?`, or closed `[...]` wildcard. */
export function hasPatternCharacters(pattern: string): boolean {
  return compileGlob(pattern).atoms.some((atom) => atom.kind !== 'char');
}

/** Escapes shell glob metacharacters so `text` matches literally. */
export function quotePattern(text: string): string {
  return text.replaceAll(/[*?[\]\\]/g, (c) => `\\${c}`);
}

/** Strips pattern-quoting backslashes from `pattern`. */
export function unquotePattern(pattern: string): string {
  return pattern.replaceAll(/\\([\s\S])/g, '$1');
}

/** Compiles a shell pattern into a sequence of wildcard, literal, and bracket atoms. */
export function compileGlob(pattern: string): CompiledGlob {
  const chars = charactersOf(pattern);
  const atoms: GlobAtom[] = [];
  let hasStar = false;
  for (let i = 0; i < chars.length;) {
    const c = chars[i];
    if (c === '*') {
      if (atoms.at(-1)?.kind !== 'star') atoms.push({ kind: 'star' });
      hasStar = true;
      i++;
    } else if (c === '?') {
      atoms.push({ kind: 'any' });
      i++;
    } else if (c === '\\') {
      atoms.push({ kind: 'char', c: i + 1 < chars.length ? chars[i + 1] : '\\' });
      i += 2;
    } else if (c === '[') {
      const bracket = readBracketExpression(chars, i + 1);
      if (bracket) {
        atoms.push({ kind: 'bracket', negated: bracket.negated, specs: bracket.specs });
        i = bracket.next;
      } else {
        atoms.push({ kind: 'char', c: '[' });
        i++;
      }
    } else {
      atoms.push({ kind: 'char', c });
      i++;
    }
  }
  return { atoms, hasStar };
}

/** Fixed character length of a star-free pattern, or `undefined` when `*` allows variable lengths. */
export function fixedGlobLength(glob: CompiledGlob): number | undefined {
  return glob.hasStar ? undefined : glob.atoms.length;
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
// code-gauge-allow functionCognitiveComplexity -- Single-pass state-set simulation with early exit when no active state remains.
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

/** Parses `[...]` starting just after `[`, or returns `undefined` if unclosed. */
// code-gauge-allow functionCognitiveComplexity -- POSIX bracket syntax: optional negation, initial `]`, character classes, equivalence classes, collating symbols, and ranges.
function readBracketExpression(
  chars: readonly string[],
  start: number
): { negated: boolean; specs: BracketSpec[]; next: number } | undefined {
  let pos = start;
  const negated = chars[pos] === '!' || chars[pos] === '^';
  if (negated) pos++;
  const specs: BracketSpec[] = [];
  let first = true;
  while (pos < chars.length) {
    if (chars[pos] === ']' && !first) return { negated, specs, next: pos + 1 };
    first = false;
    if (chars[pos] === '[' && (chars[pos + 1] === ':' || chars[pos + 1] === '=')) {
      const kind = chars[pos + 1];
      const end = findSubbracketClose(chars, pos + 2, kind);
      if (end !== undefined) {
        const rawName = chars.slice(pos + 2, end).join('');
        if (kind === ':') {
          const className = rawName.replaceAll(/\\(.)/g, '$1');
          const test = Object.hasOwn(CHARACTER_CLASSES, className) ? CHARACTER_CLASSES[className] : undefined;
          specs.push({ kind: 'class', test });
        } else {
          specs.push({ kind: 'char', c: resolveCollatingSymbol(rawName) });
        }
        pos = end + 2;
        continue;
      }
    }
    const startAtom = readBracketAtom(chars, pos);
    if (!startAtom) return undefined;
    pos = startAtom.next;
    if (chars[pos] === '-' && pos + 1 < chars.length && chars[pos + 1] !== ']') {
      const endAtom = readBracketAtom(chars, pos + 1);
      if (!endAtom) return undefined;
      pos = endAtom.next;
      const low = startAtom.c.codePointAt(0) as number;
      const high = endAtom.c.codePointAt(0) as number;
      if (low <= high) specs.push({ kind: 'range', low, high });
      continue;
    }
    specs.push({ kind: 'char', c: startAtom.c });
  }
  return undefined;
}

function readBracketAtom(chars: readonly string[], pos: number): { c: string; next: number } | undefined {
  if (pos >= chars.length) return undefined;
  if (chars[pos] === '[' && chars[pos + 1] === '.') {
    const end = findSubbracketClose(chars, pos + 2, '.');
    if (end !== undefined) {
      return { c: resolveCollatingSymbol(chars.slice(pos + 2, end).join('')), next: end + 2 };
    }
  }
  if (chars[pos] === '\\') {
    return pos + 1 < chars.length ? { c: chars[pos + 1], next: pos + 2 } : undefined;
  }
  return { c: chars[pos], next: pos + 1 };
}

function findSubbracketClose(chars: readonly string[], from: number, delimiter: string): number | undefined {
  for (let i = from; i + 1 < chars.length; i++) {
    if (delimiter !== '.' && chars[i] === ']') return undefined;
    if (chars[i] === delimiter && chars[i + 1] === ']') return i;
  }
  return undefined;
}

function resolveCollatingSymbol(name: string): string {
  if (charactersOf(name).length === 1) return name;
  return Object.hasOwn(COLLATING_SYMBOLS, name) ? COLLATING_SYMBOLS[name] : name;
}
