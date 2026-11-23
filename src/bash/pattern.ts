/**
 * Bash's pattern matching (`case`, `[[ == ]]`, and the pattern operators of parameter expansion), ported from
 * `lib/glob/sm_loop.c` of Bash 5.3 without extended patterns. A pattern is a string in which a backslash quotes the
 * character after it, which is how the shell passes the quoted parts of a word to the matcher.
 */

import { charactersOf } from './characters';

/** Whether a whole text matches a pattern. */
export function matchesPattern(pattern: string, text: string, spend: () => void): boolean {
  return gmatch(charactersOf(text), 0, charactersOf(pattern), 0, undefined, spend);
}

/** Whether a pattern has unquoted characters that make it more than a literal string. */
export function hasPatternCharacters(pattern: string): boolean {
  const chars = charactersOf(pattern);
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '*' || c === '?') return true;
    if (c === '[' && bracketEnd(chars, i + 1) !== undefined) return true;
  }
  return false;
}

/** Quotes the characters of a literal string so that a pattern matches only that string. */
export function quotePattern(text: string): string {
  return text.replaceAll(/[*?[\]\\]/g, (c) => `\\${c}`);
}

/** Removes the backslashes that quote characters in a pattern, giving the text it matches literally. */
export function unquotePattern(pattern: string): string {
  return pattern.replaceAll(/\\([\s\S])/g, '$1');
}

/** The index after the `]` that closes a bracket expression whose contents start at `start`, as Bash scans one. */
function bracketEnd(p: string[], start: number): number | undefined {
  let i = start;
  if (p[i] === '!' || p[i] === '^') i++;
  if (p[i] === ']') i++;
  for (; i < p.length; i++) {
    const c = p[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '[' && (p[i + 1] === ':' || p[i + 1] === '=' || p[i + 1] === '.')) {
      const close = parseSubbracket(p, i + 1);
      if (close !== undefined) {
        i = close + 1;
        continue;
      }
    }
    if (c === ']') return i + 1;
  }
  return undefined;
}

interface StarEnd {
  pattern: number | undefined;
  string: number;
}

/**
 * Matches `s` from `start` against `p` from `pstart`, as Bash's GMATCH. With `ends`, a `*` stops the match there and
 * records where, so that the caller resumes from the later `*` instead of backtracking to its own.
 */
function gmatch(
  s: string[],
  start: number,
  p: string[],
  pstart: number,
  ends: StarEnd | undefined,
  spend: () => void
): boolean {
  let n = start;
  let pi = pstart;
  while (pi < p.length) {
    spend();
    const c = p[pi++];
    if (c === '*') {
      if (ends) {
        ends.pattern = pi - 1;
        ends.string = n;
        return true;
      }
      const resumed = matchStar(s, n, p, pi, spend);
      if (typeof resumed === 'boolean') return resumed;
      [pi, n] = resumed;
      continue;
    }
    const next = matchOne(s, n, p, pi, c);
    if (next === undefined) return false;
    pi = next;
    n++;
  }
  return n === s.length;
}

/** Matches one character of `s` at `n` against the pattern character `c` read before `pi`, returning where it ends. */
// code-gauge-allow functionCognitiveComplexity -- A port of the single-character cases of Bash's GMATCH.
function matchOne(s: string[], n: number, p: string[], pi: number, c: string): number | undefined {
  const sc = n < s.length ? s[n] : undefined;
  switch (c) {
    case '?': {
      return sc === undefined ? undefined : pi;
    }
    case '\\': {
      // A trailing backslash matches a backslash that ends the text.
      if (pi === p.length) return sc === '\\' && n + 1 === s.length ? pi : undefined;
      return sc === p[pi] ? pi + 1 : undefined;
    }
    case '[': {
      return sc === undefined ? undefined : brackmatch(p, pi, sc);
    }
    default: {
      return sc === c ? pi : undefined;
    }
  }
}

/**
 * Matches a `*` read before `pi`: consumes the `?`s and `*`s after it, then tries each position for the rest, returning
 * the result or, when a later `*` matched, where the outer loop resumes.
 */
// code-gauge-allow functionCognitiveComplexity -- A port of the star case of Bash's GMATCH, which collapses wildcards and resumes at a later star.
function matchStar(
  s: string[],
  start: number,
  p: string[],
  start2: number,
  spend: () => void
): boolean | [number, number] {
  let n = start;
  let pi = start2;
  if (pi === p.length) return true;
  let c = p[pi++];
  for (; c === '?' || c === '*'; c = p[pi++]) {
    if (c === '?') {
      if (n >= s.length) return false;
      n++;
    }
    if (pi === p.length) return true;
  }
  const first = c === '\\' ? p[pi] : c;
  pi--;
  const end: StarEnd = { pattern: undefined, string: 0 };
  for (; n < s.length; ++n) {
    if (c !== '[' && s[n] !== first) continue;
    if (gmatch(s, n, p, pi, end, spend)) return end.pattern === undefined ? true : [end.pattern, end.string];
  }
  return false;
}

/** The position of the terminating `.]`, `=]`, or `:]` of a symbol whose type character is at `start`. */
function parseSubbracket(p: string[], start: number): number | undefined {
  const type = p[start];
  for (let i = start + 1; i < p.length; i++) {
    if (type !== '.' && p[i] === ']') return undefined;
    if (p[i] === type && p[i + 1] === ']') return i;
  }
  return undefined;
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
  print: (c) => /^[^\p{C}]$/u.test(c) && c !== ' ' && c !== ' ',
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

function collatingSymbol(name: string): string {
  if (charactersOf(name).length === 1) return name;
  return COLLATING_SYMBOLS[name] ?? name;
}

const codeOf = (c: string): number => c.codePointAt(0) as number;

type BracketItem =
  | { kind: 'char'; c: string }
  | { kind: 'range'; low: number; high: number }
  | { kind: 'class'; test: ((c: string) => boolean) | undefined };

/**
 * Matches `test` against the bracket expression whose contents start at `start`, returning the position after it on a
 * match. An unterminated bracket matches only a literal `[`, after which matching continues from its contents. The
 * expression is read whole before `test` is checked, which gives what Bash's BRACKMATCH gives while it reads.
 */
function brackmatch(p: string[], start: number, test: string): number | undefined {
  const parsed = parseBracket(p, start);
  if (!parsed) return test === '[' ? start : undefined;
  const code = codeOf(test);
  const matched = parsed.items.some((item) => {
    if (item.kind === 'char') return item.c === test;
    if (item.kind === 'range') return code >= item.low && code <= item.high;
    return item.test?.(test) ?? false;
  });
  return matched === parsed.negated ? undefined : parsed.end;
}

/** The items of a bracket expression and the position after its `]`, or `undefined` when no `]` closes it. */
// code-gauge-allow functionCognitiveComplexity -- A port of Bash's BRACKMATCH scan, whose symbols, characters, and ranges share the position.
function parseBracket(p: string[], start: number): { items: BracketItem[]; negated: boolean; end: number } | undefined {
  let pi = start;
  const negated = p[pi] === '!' || p[pi] === '^';
  if (negated) pi++;
  const items: BracketItem[] = [];
  let c = p[pi++];
  for (;;) {
    if (c === undefined) return undefined;
    const item = c === '[' && (p[pi] === '=' || p[pi] === ':') ? readSymbolItem(p, pi) : undefined;
    if (item) {
      items.push(item.item);
      pi = item.next;
      c = p[pi++];
    } else {
      const read = readCharacterItem(p, pi, c);
      if (!read) return undefined;
      if (read.item) items.push(read.item);
      pi = read.next;
      c = p[read.next - 1];
    }
    if (c === ']') return { items, negated, end: pi };
  }
}

/** `[=c=]` or `[:class:]` starting at the `=` or `:` at `pi`, with the position after its closing `]`. */
function readSymbolItem(p: string[], pi: number): { item: BracketItem; next: number } | undefined {
  const close = parseSubbracket(p, pi);
  if (close === undefined) return undefined;
  const name = p.slice(pi + 1, close).join('');
  const item: BracketItem =
    p[pi] === '='
      ? { kind: 'char', c: collatingSymbol(name) }
      : { kind: 'class', test: CHARACTER_CLASSES[name.replaceAll(/\\(.)/g, '$1')] };
  return { item, next: close + 2 };
}

/**
 * A character or a range that `c`, read before `pi`, starts, with the position after the character that follows it,
 * or `undefined` at the end of the pattern. A range whose end comes before its start gives no item.
 */
function readCharacterItem(
  p: string[],
  pi: number,
  c: string
): { item: BracketItem | undefined; next: number } | undefined {
  const first = readBracketChar(p, pi, c);
  if (!first || p[first.next] === undefined) return undefined;
  if (p[first.next] !== '-' || p[first.next + 1] === ']')
    return { item: { kind: 'char', c: first.c }, next: first.next + 1 };
  const endChar = p[first.next + 1];
  const last = endChar === undefined ? undefined : readBracketChar(p, first.next + 2, endChar);
  if (!last || p[last.next] === undefined) return undefined;
  const [low, high] = [codeOf(first.c), codeOf(last.c)];
  return { item: low <= high ? { kind: 'range', low, high } : undefined, next: last.next + 1 };
}

/** A character of a bracket expression that `c`, read before `pi`, starts: itself, a quoted one, or `[.name.]`. */
function readBracketChar(p: string[], pi: number, c: string): { c: string; next: number } | undefined {
  if (c === '[' && p[pi] === '.') {
    const close = parseSubbracket(p, pi);
    if (close !== undefined) return { c: collatingSymbol(p.slice(pi + 1, close).join('')), next: close + 2 };
  }
  if (c === '\\') return p[pi] === undefined ? undefined : { c: p[pi], next: pi + 1 };
  return { c, next: pi };
}
