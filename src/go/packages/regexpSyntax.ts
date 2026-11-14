// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { decodeRune, RUNE_ERROR } from '../literals';
import {
  appendClass,
  appendLiteral,
  cleanClass,
  MAX_FOLD,
  MAX_RUNE,
  MIN_FOLD,
  type RuneClass,
} from './regexpCharClass';
import { simpleFold } from './unicodeSupport';

/** Go's `syntax.Op`, numbered as Go numbers them since the parser compares them. */
export const Op = {
  NoMatch: 1,
  EmptyMatch: 2,
  Literal: 3,
  CharClass: 4,
  AnyCharNotNL: 5,
  AnyChar: 6,
  BeginLine: 7,
  EndLine: 8,
  BeginText: 9,
  EndText: 10,
  WordBoundary: 11,
  NoWordBoundary: 12,
  Capture: 13,
  Star: 14,
  Plus: 15,
  Quest: 16,
  Repeat: 17,
  Concat: 18,
  Alternate: 19,
} as const;

export const OP_PSEUDO = 128;
export const OP_LEFT_PAREN = OP_PSEUDO;
export const OP_VERTICAL_BAR = OP_PSEUDO + 1;

/** Go's `syntax.Flags` (a uint16). */
export const Flag = {
  FoldCase: 1,
  Literal: 2,
  ClassNL: 4,
  DotNL: 8,
  OneLine: 16,
  NonGreedy: 32,
  PerlX: 64,
  UnicodeGroups: 128,
  WasDollar: 256,
} as const;

export const PERL_FLAGS = Flag.ClassNL | Flag.OneLine | Flag.PerlX | Flag.UnicodeGroups;
export const POSIX_FLAGS = 0;

/** A node of Go's `syntax.Regexp` tree. */
export interface Node {
  op: number;
  flags: number;
  sub: Node[];
  rune: RuneClass;
  min: number;
  max: number;
  cap: number;
  name: string;
}

export function newNode(op: number, flags = 0): Node {
  return { op, flags, sub: [], rune: [], min: 0, max: 0, cap: 0, name: '' };
}

/** Go's `*syntax.Error`, whose `Error()` text is `error parsing regexp: <code>: `<expr>``. */
export class RegexpSyntaxError {
  constructor(
    readonly code: string,
    readonly expr: string
  ) {}

  message(): string {
    return `error parsing regexp: ${this.code}: \`${this.expr}\``;
  }
}

export const ERR_INVALID_CHAR_RANGE = 'invalid character class range';
export const ERR_INVALID_ESCAPE = 'invalid escape sequence';
export const ERR_INVALID_NAMED_CAPTURE = 'invalid named capture';
export const ERR_INVALID_PERL_OP = 'invalid or unsupported Perl syntax';
export const ERR_INVALID_REPEAT_OP = 'invalid nested repetition operator';
export const ERR_INVALID_REPEAT_SIZE = 'invalid repeat count';
export const ERR_INVALID_UTF8 = 'invalid UTF-8';
export const ERR_MISSING_BRACKET = 'missing closing ]';
export const ERR_MISSING_PAREN = 'missing closing )';
export const ERR_MISSING_REPEAT_ARGUMENT = 'missing argument to repetition operator';
export const ERR_TRAILING_BACKSLASH = 'trailing backslash at end of expression';
export const ERR_UNEXPECTED_PAREN = 'unexpected )';
export const ERR_NESTING_DEPTH = 'expression nests too deeply';
export const ERR_LARGE = 'expression too large';

export function fail(code: string, expr: string): never {
  throw new RegexpSyntaxError(code, expr);
}

/** `utf8.DecodeRuneInString(s[at:])`, which yields (RuneError, 0) at the end. */
export function runeAt(s: string, at: number): { rune: number; size: number } {
  return at < s.length ? decodeRune(s, at) : { rune: RUNE_ERROR, size: 0 };
}

export function nextRune(s: string): { c: number; t: string } {
  const { rune, size } = runeAt(s, 0);
  if (rune === RUNE_ERROR && size === 1) fail(ERR_INVALID_UTF8, s);
  return { c: rune, t: s.slice(size) };
}

export function checkUTF8(s: string): void {
  for (let at = 0; at < s.length;) {
    const { rune, size } = decodeRune(s, at);
    if (rune === RUNE_ERROR && size === 1) fail(ERR_INVALID_UTF8, s.slice(at));
    at += size;
  }
}

export function isAlnum(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

export function unhex(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  return -1;
}

export const SIMPLE_ESCAPES = new Map([
  [0x61, 7],
  [0x66, 12],
  [0x6e, 10],
  [0x72, 13],
  [0x74, 9],
  [0x76, 11],
]);

/** Go's `parseEscape`: the rune of the escape sequence at the start of `s`, and the rest. */
export function parseEscape(s: string): { r: number; rest: string } {
  let t = s.slice(1);
  if (t === '') fail(ERR_TRAILING_BACKSLASH, '');
  const { c, t: after } = nextRune(t);
  t = after;
  const isOctal = (): boolean => t !== '' && t[0] >= '0' && t[0] <= '7';
  if (c >= 0x30 && c <= 0x37 && (c === 0x30 || isOctal())) {
    let r = c - 0x30;
    for (let i = 1; i < 3 && isOctal(); i++) {
      r = r * 8 + t.charCodeAt(0) - 0x30;
      t = t.slice(1);
    }
    return { r, rest: t };
  }
  if (c === 0x78) return parseHexEscape(s, t);
  const simple = SIMPLE_ESCAPES.get(c);
  if (simple !== undefined) return { r: simple, rest: t };
  if (c < 0x80 && !isAlnum(c)) return { r: c, rest: t };
  return fail(ERR_INVALID_ESCAPE, s.slice(0, s.length - t.length));
}

/** Parses the hex digits of the escape `s` after its `\x`, which `text` starts at. */
// code-gauge-allow functionNcss 32 -- Transcribes Go's parseHexEscape step by step.
export function parseHexEscape(s: string, text: string): { r: number; rest: string } {
  let t = text;
  const invalid = (): never => fail(ERR_INVALID_ESCAPE, s.slice(0, s.length - t.length));
  if (t === '') return invalid();
  let c: number;
  ({ c, t } = nextRune(t));
  if (c !== 0x7b) {
    const x = unhex(c);
    ({ c, t } = nextRune(t));
    const y = unhex(c);
    if (x < 0 || y < 0) return invalid();
    return { r: x * 16 + y, rest: t };
  }
  let nhex = 0;
  let r = 0;
  for (;;) {
    if (t === '') return invalid();
    ({ c, t } = nextRune(t));
    if (c === 0x7d) break;
    const v = unhex(c);
    if (v < 0) return invalid();
    r = r * 16 + v;
    if (r > MAX_RUNE) return invalid();
    nhex++;
  }
  if (nhex === 0) return invalid();
  return { r, rest: t };
}

export function minFoldRune(rune: number): number {
  if (rune < MIN_FOLD || rune > MAX_FOLD) return rune;
  let m = rune;
  for (let r = simpleFold(rune); r !== rune; r = simpleFold(r)) m = Math.min(m, r);
  return m;
}

export function repeatIsValid(re: Node, limit: number): boolean {
  let n = limit;
  if (re.op === Op.Repeat) {
    let m = re.max;
    if (m === 0) return true;
    if (m < 0) m = re.min;
    if (m > n) return false;
    if (m > 0) n = Math.trunc(n / m);
  }
  return re.sub.every((sub) => repeatIsValid(sub, n));
}

// code-gauge-allow functionCognitiveComplexity 19 -- Transcribes Go's parseRepeat step by step.
// code-gauge-allow functionNcss 31 -- Transcribes Go's parseRepeat step by step.
export function parseRepeat(text: string): { min: number; max: number; rest: string } | undefined {
  if (text === '' || text[0] !== '{') return undefined;
  let s = text.slice(1);
  const minimum = parseInt(s);
  if (!minimum) return undefined;
  let min = minimum.n;
  s = minimum.rest;
  if (s === '') return undefined;
  let max: number;
  if (s[0] === ',') {
    s = s.slice(1);
    if (s === '') return undefined;
    if (s[0] === '}') {
      max = -1;
    } else {
      const maximum = parseInt(s);
      if (!maximum) return undefined;
      max = maximum.n;
      s = maximum.rest;
      if (max < 0) min = -1;
    }
  } else {
    max = min;
  }
  if (s === '' || s[0] !== '}') return undefined;
  return { min, max, rest: s.slice(1) };
}

export function parseInt(s: string): { n: number; rest: string } | undefined {
  if (s === '' || s[0] < '0' || s[0] > '9') return undefined;
  if (s.length >= 2 && s[0] === '0' && s[1] >= '0' && s[1] <= '9') return undefined;
  let end = 0;
  while (end < s.length && s[end] >= '0' && s[end] <= '9') end++;
  let n = 0;
  for (let i = 0; i < end; i++) {
    if (n >= 1e8) {
      n = -1;
      break;
    }
    n = n * 10 + s.charCodeAt(i) - 0x30;
  }
  return { n, rest: s.slice(end) };
}

export function isValidCaptureName(name: string): boolean {
  if (name === '') return false;
  for (let at = 0; at < name.length;) {
    const { rune, size } = decodeRune(name, at);
    if (rune !== 0x5f && !isAlnum(rune)) return false;
    at += size;
  }
  return true;
}

export function isCharClass(re: Node): boolean {
  return (
    (re.op === Op.Literal && re.rune.length === 1) ||
    re.op === Op.CharClass ||
    re.op === Op.AnyCharNotNL ||
    re.op === Op.AnyChar
  );
}

export function matchRune(re: Node, r: number): boolean {
  switch (re.op) {
    case Op.Literal: {
      return re.rune.length === 1 && re.rune[0] === r;
    }
    case Op.CharClass: {
      for (let i = 0; i < re.rune.length; i += 2) if (re.rune[i] <= r && r <= re.rune[i + 1]) return true;
      return false;
    }
    case Op.AnyCharNotNL: {
      return r !== 10;
    }
    case Op.AnyChar: {
      return true;
    }
  }
  return false;
}

export function mergeCharClass(dst: Node, src: Node): void {
  switch (dst.op) {
    case Op.AnyCharNotNL: {
      if (matchRune(src, 10)) dst.op = Op.AnyChar;
      break;
    }
    case Op.CharClass: {
      dst.rune =
        src.op === Op.Literal
          ? appendLiteral(dst.rune, src.rune[0], (src.flags & Flag.FoldCase) !== 0)
          : appendClass(dst.rune, src.rune);
      break;
    }
    case Op.Literal: {
      if (src.rune[0] === dst.rune[0] && src.flags === dst.flags) break;
      dst.op = Op.CharClass;
      const runes = appendLiteral([], dst.rune[0], (dst.flags & Flag.FoldCase) !== 0);
      dst.rune = appendLiteral(runes, src.rune[0], (src.flags & Flag.FoldCase) !== 0);
      break;
    }
  }
}

export function cleanAlt(re: Node): void {
  if (re.op !== Op.CharClass) return;
  re.rune = cleanClass(re.rune);
  const r = re.rune;
  if (r.length === 2 && r[0] === 0 && r[1] === MAX_RUNE) {
    re.rune = [];
    re.op = Op.AnyChar;
  } else if (r.length === 4 && r[0] === 0 && r[1] === 9 && r[2] === 11 && r[3] === MAX_RUNE) {
    re.rune = [];
    re.op = Op.AnyCharNotNL;
  }
}

/** Round 4 of Go's `factor`: collapses runs of empty matches into one. */
export function removeEmptyRepeats(sub: Node[]): Node[] {
  return sub.filter((node, i) => !(i + 1 < sub.length && node.op === Op.EmptyMatch && sub[i + 1].op === Op.EmptyMatch));
}

export function leadingString(re: Node): { runes: number[]; flags: number } {
  const node = re.op === Op.Concat && re.sub.length > 0 ? re.sub[0] : re;
  if (node.op !== Op.Literal) return { runes: [], flags: 0 };
  return { runes: node.rune, flags: node.flags & Flag.FoldCase };
}

export function leadingRegexp(re: Node): Node | undefined {
  if (re.op === Op.EmptyMatch) return undefined;
  if (re.op === Op.Concat && re.sub.length > 0) {
    const sub = re.sub[0];
    return sub.op === Op.EmptyMatch ? undefined : sub;
  }
  return re;
}

/** Go's `(*Regexp).Equal`. */
export function equal(x: Node | undefined, y: Node | undefined): boolean {
  if (!x || !y) return x === y;
  if (x.op !== y.op) return false;
  switch (x.op) {
    case Op.EndText: {
      return (x.flags & Flag.WasDollar) === (y.flags & Flag.WasDollar);
    }
    case Op.Literal:
    case Op.CharClass: {
      return (
        (x.flags & Flag.FoldCase) === (y.flags & Flag.FoldCase) &&
        x.rune.length === y.rune.length &&
        x.rune.every((rune, i) => rune === y.rune[i])
      );
    }
    case Op.Alternate:
    case Op.Concat: {
      return x.sub.length === y.sub.length && x.sub.every((sub, i) => equal(sub, y.sub[i]));
    }
    case Op.Star:
    case Op.Plus:
    case Op.Quest: {
      return (x.flags & Flag.NonGreedy) === (y.flags & Flag.NonGreedy) && equal(x.sub[0], y.sub[0]);
    }
    case Op.Repeat: {
      return (
        (x.flags & Flag.NonGreedy) === (y.flags & Flag.NonGreedy) &&
        x.min === y.min &&
        x.max === y.max &&
        equal(x.sub[0], y.sub[0])
      );
    }
    case Op.Capture: {
      return x.cap === y.cap && x.name === y.name && equal(x.sub[0], y.sub[0]);
    }
  }
  return true;
}

/** Go's `MaxCap`. */
export function maxCap(re: Node): number {
  let m = re.op === Op.Capture ? re.cap : 0;
  for (const sub of re.sub) m = Math.max(m, maxCap(sub));
  return m;
}

/** Go's `CapNames`. */
export function capNames(re: Node): string[] {
  const names = Array.from<string>({ length: maxCap(re) + 1 }).fill('');
  const visit = (node: Node): void => {
    if (node.op === Op.Capture) names[node.cap] = node.name;
    for (const sub of node.sub) visit(sub);
  };
  visit(re);
  return names;
}
