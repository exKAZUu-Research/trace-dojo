/**
 * POSIX extended regular expressions as macOS's `regcomp` reads them for `[[ s =~ re ]]`: the leftmost match that is
 * longest, `.` matching any character, a backslash quoting the character after it, and no `\d`-style classes.
 */

import { charactersOf } from './characters';

type RegexNode =
  | { kind: 'char'; c: string }
  | { kind: 'any' }
  | { kind: 'set'; negated: boolean; test: (c: string) => boolean }
  | { kind: 'start' }
  | { kind: 'end' }
  | { kind: 'group'; index: number; body: RegexNode }
  | { kind: 'concat'; items: RegexNode[] }
  | { kind: 'alternation'; options: RegexNode[] }
  | { kind: 'repeat'; body: RegexNode; min: number; max: number };

/** A pattern that macOS rejects, with the message `regerror` gives. */
export class RegexSyntaxError extends Error {}

export interface CompiledRegex {
  root: RegexNode;
  groups: number;
}

const CLASSES: Record<string, (c: string) => boolean> = {
  alnum: (c) => /^[\p{L}\p{N}]$/u.test(c),
  alpha: (c) => /^\p{L}$/u.test(c),
  blank: (c) => c === ' ' || c === '\t',
  cntrl: (c) => /^\p{Cc}$/u.test(c),
  digit: (c) => /^[0-9]$/.test(c),
  graph: (c) => /^[^\p{C}\p{Z}]$/u.test(c),
  lower: (c) => /^\p{Ll}$/u.test(c),
  print: (c) => /^[^\p{C}]$/u.test(c),
  punct: (c) => /^[!-/:-@[-`{-~]$/.test(c),
  space: (c) => /^[ \t\n\v\f\r]$/.test(c),
  upper: (c) => /^\p{Lu}$/u.test(c),
  xdigit: (c) => /^[0-9A-Fa-f]$/.test(c),
};

export function compileRegex(source: string): CompiledRegex {
  const parser = new RegexParser(charactersOf(source));
  const root = parser.parseAlternation();
  if (parser.position < parser.chars.length) throw new RegexSyntaxError('parentheses not balanced');
  return { root, groups: parser.groups };
}

class RegexParser {
  position = 0;
  groups = 0;

  constructor(readonly chars: string[]) {}

  parseAlternation(): RegexNode {
    const options = [this.parseConcat()];
    while (this.chars[this.position] === '|') {
      this.position++;
      options.push(this.parseConcat());
    }
    return options.length === 1 ? options[0] : { kind: 'alternation', options };
  }

  private parseConcat(): RegexNode {
    const items: RegexNode[] = [];
    for (;;) {
      const c = this.chars[this.position];
      if (c === undefined || c === '|' || c === ')') break;
      items.push(this.parseRepeat());
    }
    if (items.length === 0) throw new RegexSyntaxError('empty (sub)expression');
    return items.length === 1 ? items[0] : { kind: 'concat', items };
  }

  private parseRepeat(): RegexNode {
    let node = this.parseAtom();
    for (;;) {
      const c = this.chars[this.position];
      if (c === '*' || c === '+' || c === '?') {
        this.position++;
        node = { kind: 'repeat', body: node, min: c === '+' ? 1 : 0, max: c === '?' ? 1 : Infinity };
        continue;
      }
      if (c === '{') {
        const interval = this.interval();
        if (!interval) break;
        node = { kind: 'repeat', body: node, ...interval };
        continue;
      }
      break;
    }
    return node;
  }

  /** Reads `{n}`, `{n,}`, or `{n,m}`, or leaves a `{` that starts none of them as a literal character. */
  private interval(): { min: number; max: number } | undefined {
    const rest = this.chars.slice(this.position).join('');
    const match = /^\{(\d+)(,(\d*))?\}/.exec(rest);
    if (!match) {
      if (/^\{\d/.test(rest)) throw new RegexSyntaxError('braces not balanced');
      return undefined;
    }
    this.position += charactersOf(match[0]).length;
    const min = Number(match[1]);
    const max = match[2] === undefined ? min : match[3] === '' ? Infinity : Number(match[3]);
    if (max < min || min > 255 || (max !== Infinity && max > 255))
      throw new RegexSyntaxError('invalid repetition count(s)');
    return { min, max };
  }

  // code-gauge-allow functionNcss -- One case per atom of a POSIX extended regular expression.
  private parseAtom(): RegexNode {
    const c = this.chars[this.position++];
    switch (c) {
      case '(': {
        const index = ++this.groups;
        if (this.chars[this.position] === ')') throw new RegexSyntaxError('empty (sub)expression');
        const body = this.parseAlternation();
        if (this.chars[this.position] !== ')') throw new RegexSyntaxError('parentheses not balanced');
        this.position++;
        return { kind: 'group', index, body };
      }
      case '*':
      case '+':
      case '?': {
        throw new RegexSyntaxError('repetition-operator operand invalid');
      }
      case '.': {
        return { kind: 'any' };
      }
      case '^': {
        return { kind: 'start' };
      }
      case '$': {
        return { kind: 'end' };
      }
      case '[': {
        return this.parseSet();
      }
      case '\\': {
        const next = this.chars[this.position++];
        if (next === undefined) throw new RegexSyntaxError(String.raw`trailing backslash (\)`);
        return { kind: 'char', c: next };
      }
      default: {
        return { kind: 'char', c: c as string };
      }
    }
  }

  // code-gauge-allow functionCognitiveComplexity -- POSIX bracket expressions with classes, equivalence classes, collating symbols, and ranges.
  // code-gauge-allow functionNcss -- POSIX bracket expressions with classes, equivalence classes, collating symbols, and ranges.
  private parseSet(): RegexNode {
    const tests: ((c: string) => boolean)[] = [];
    let negated = false;
    if (this.chars[this.position] === '^') {
      negated = true;
      this.position++;
    }
    let first = true;
    for (;;) {
      const c = this.chars[this.position];
      if (c === undefined) throw new RegexSyntaxError('brackets ([ ]) not balanced');
      if (c === ']' && !first) {
        this.position++;
        break;
      }
      first = false;
      if (
        c === '[' &&
        (this.chars[this.position + 1] === ':' ||
          this.chars[this.position + 1] === '=' ||
          this.chars[this.position + 1] === '.')
      ) {
        const type = this.chars[this.position + 1];
        const rest = this.chars.slice(this.position + 2).join('');
        const close = rest.indexOf(`${type}]`);
        if (close === -1) throw new RegexSyntaxError('brackets ([ ]) not balanced');
        const name = rest.slice(0, close);
        this.position += 2 + charactersOf(name).length + 2;
        if (type === ':') {
          const test = Object.hasOwn(CLASSES, name) ? CLASSES[name] : undefined;
          if (!test) throw new RegexSyntaxError('invalid character class');
          tests.push(test);
        } else tests.push((ch) => ch === name);
        continue;
      }
      this.position++;
      if (
        this.chars[this.position] === '-' &&
        this.chars[this.position + 1] !== undefined &&
        this.chars[this.position + 1] !== ']'
      ) {
        const end = this.chars[this.position + 1];
        this.position += 2;
        const low = c.codePointAt(0) as number;
        const high = end.codePointAt(0) as number;
        if (low > high) throw new RegexSyntaxError('invalid character range');
        tests.push((ch) => {
          const code = ch.codePointAt(0) as number;
          return code >= low && code <= high;
        });
        continue;
      }
      tests.push((ch) => ch === c);
    }
    return { kind: 'set', negated, test: (ch) => tests.some((test) => test(ch)) };
  }
}

/** A match: the start and end of the whole match and of each group, by character index, or -1 when unset. */
export type RegexMatch = [number, number][];

/** Finds the leftmost-longest match, choosing among equally long ones the one whose earlier groups are longer. */
export function searchRegex(regex: CompiledRegex, text: string, spend: () => void): RegexMatch | undefined {
  const chars = charactersOf(text);
  for (let start = 0; start <= chars.length; start++) {
    let best: RegexMatch | undefined;
    const captures: [number, number][] = Array.from({ length: regex.groups + 1 }, () => [-1, -1]);
    const accept = (end: number): void => {
      const candidate: RegexMatch = captures.map(([s, e]) => [s, e]);
      candidate[0] = [start, end];
      if (!best || isBetter(candidate, best)) best = candidate;
    };
    matchNode(regex.root, chars, start, captures, accept, spend);
    if (best) return best;
  }
  return undefined;
}

function isBetter(candidate: RegexMatch, best: RegexMatch): boolean {
  if (candidate[0][1] !== best[0][1]) return candidate[0][1] > best[0][1];
  for (let i = 1; i < candidate.length; i++) {
    const [cs, ce] = candidate[i];
    const [bs, be] = best[i];
    if (cs === bs && ce === be) continue;
    if (bs === -1) return cs !== -1;
    if (cs === -1) return false;
    if (cs !== bs) return cs < bs;
    return ce > be;
  }
  return false;
}

/** Tries every way `node` matches at `position`, calling `next` with the position after each. */
// code-gauge-allow functionCognitiveComplexity -- One case per regex node kind, each enumerating its matches for the leftmost-longest search.
// code-gauge-allow functionNcss -- One case per regex node kind, each enumerating its matches for the leftmost-longest search.
function matchNode(
  node: RegexNode,
  chars: string[],
  position: number,
  captures: [number, number][],
  next: (position: number) => void,
  spend: () => void
): void {
  spend();
  switch (node.kind) {
    case 'char': {
      if (chars[position] === node.c) next(position + 1);
      return;
    }
    case 'any': {
      if (position < chars.length) next(position + 1);
      return;
    }
    case 'set': {
      if (position < chars.length && node.test(chars[position]) !== node.negated) next(position + 1);
      return;
    }
    case 'start': {
      if (position === 0) next(position);
      return;
    }
    case 'end': {
      if (position === chars.length) next(position);
      return;
    }
    case 'group': {
      const saved = captures[node.index];
      matchNode(
        node.body,
        chars,
        position,
        captures,
        (end) => {
          const previous = captures[node.index];
          captures[node.index] = [position, end];
          next(end);
          captures[node.index] = previous;
        },
        spend
      );
      captures[node.index] = saved;
      return;
    }
    case 'concat': {
      const step = (index: number, at: number): void => {
        if (index === node.items.length) {
          next(at);
          return;
        }
        matchNode(node.items[index], chars, at, captures, (after) => step(index + 1, after), spend);
      };
      step(0, position);
      return;
    }
    case 'alternation': {
      for (const option of node.options) matchNode(option, chars, position, captures, next, spend);
      return;
    }
    case 'repeat': {
      const iterate = (count: number, at: number): void => {
        if (count >= node.min) next(at);
        if (count >= node.max) return;
        matchNode(
          node.body,
          chars,
          at,
          captures,
          (after) => {
            // An iteration that matches nothing cannot help a longer match, and would repeat forever.
            if (after === at && count >= node.min) return;
            iterate(count + 1, after);
          },
          spend
        );
      };
      iterate(0, position);
    }
  }
}
