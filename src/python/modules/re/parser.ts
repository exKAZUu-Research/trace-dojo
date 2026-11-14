// A transcription of CPython's `re._parser`, which turns a pattern into a tree of (opcode, argument) items.
import { strRepr } from '../../strings';
import { lookupName } from '../../unicodeDatabase';
import { CATEGORY, FLAG, MAXGROUPS, MAXREPEAT } from './constants';
import { parseGroup } from './groups';
import {
  ASCII_LETTER,
  codePointLength,
  DIGITS,
  ESCAPES,
  HEXDIGITS,
  isEscape,
  OCTDIGITS,
  PatternSyntaxError,
  Tokenizer,
} from './tokenizer';

export type SetItem =
  | { op: 'LITERAL'; code: number }
  | { op: 'RANGE'; lo: number; hi: number }
  | { op: 'CATEGORY'; category: number }
  | { op: 'NEGATE' };

export type RepeatOp = 'MAX_REPEAT' | 'MIN_REPEAT' | 'POSSESSIVE_REPEAT';

export type Item =
  | { op: 'LITERAL' | 'NOT_LITERAL'; code: number }
  | { op: 'ANY' }
  | { op: 'IN'; set: SetItem[] }
  | { op: 'AT'; at: AtName }
  | { op: 'BRANCH'; branches: SubPattern[] }
  | { op: RepeatOp; min: number; max: number; item: SubPattern }
  | { op: 'SUBPATTERN'; group: number | undefined; addFlags: number; delFlags: number; pattern: SubPattern }
  | { op: 'ATOMIC_GROUP'; pattern: SubPattern }
  | { op: 'ASSERT' | 'ASSERT_NOT'; dir: 1 | -1; pattern: SubPattern }
  | { op: 'GROUPREF'; group: number }
  | { op: 'GROUPREF_EXISTS'; group: number; yes: SubPattern; no: SubPattern | undefined }
  | { op: 'FAILURE' };

export type AtName = 'BEGINNING' | 'BEGINNING_STRING' | 'BOUNDARY' | 'NON_BOUNDARY' | 'END' | 'END_STRING';

const SPECIAL_CHARS = String.raw`.\[{()*+?^$|`;
const REPEAT_CHARS = '*+?{';
const WHITESPACE = new Set(' \t\n\r\v\f');
const MAXWIDTH = 1n << 64n;
const BIG_MAXREPEAT = BigInt(MAXREPEAT);

const CATEGORIES: Record<string, Item> = {
  '\\A': { op: 'AT', at: 'BEGINNING_STRING' },
  '\\b': { op: 'AT', at: 'BOUNDARY' },
  '\\B': { op: 'AT', at: 'NON_BOUNDARY' },
  '\\d': { op: 'IN', set: [{ op: 'CATEGORY', category: CATEGORY.DIGIT }] },
  '\\D': { op: 'IN', set: [{ op: 'CATEGORY', category: CATEGORY.NOT_DIGIT }] },
  '\\s': { op: 'IN', set: [{ op: 'CATEGORY', category: CATEGORY.SPACE }] },
  '\\S': { op: 'IN', set: [{ op: 'CATEGORY', category: CATEGORY.NOT_SPACE }] },
  '\\w': { op: 'IN', set: [{ op: 'CATEGORY', category: CATEGORY.WORD }] },
  '\\W': { op: 'IN', set: [{ op: 'CATEGORY', category: CATEGORY.NOT_WORD }] },
  '\\z': { op: 'AT', at: 'END_STRING' },
  '\\Z': { op: 'AT', at: 'END_STRING' },
};

const ord = (char: string): number => char.codePointAt(0) as number;

export class ParseState {
  flags = 0;
  readonly groupdict = new Map<string, number>();
  readonly groupwidths: ([bigint, bigint] | undefined)[] = [undefined];
  lookbehindgroups: number | undefined;
  readonly grouprefpos = new Map<number, number>();

  get groups(): number {
    return this.groupwidths.length;
  }

  opengroup(name: string | undefined): number {
    const gid = this.groups;
    this.groupwidths.push(undefined);
    if (this.groups > MAXGROUPS) throw new PatternSyntaxError('pattern', 'too many groups');
    if (name !== undefined) {
      const ogid = this.groupdict.get(name);
      if (ogid !== undefined) {
        throw new PatternSyntaxError(
          'pattern',
          `redefinition of group name ${strRepr(name)} as group ${gid}; was group ${ogid}`
        );
      }
      this.groupdict.set(name, gid);
    }
    return gid;
  }

  closegroup(gid: number, pattern: SubPattern): void {
    this.groupwidths[gid] = pattern.getwidth();
  }

  checkgroup(gid: number): boolean {
    return gid < this.groups && this.groupwidths[gid] !== undefined;
  }

  checklookbehindgroup(gid: number, source: Tokenizer): void {
    if (this.lookbehindgroups === undefined) return;
    if (!this.checkgroup(gid)) throw source.error('cannot refer to an open group');
    if (gid >= this.lookbehindgroups)
      throw source.error('cannot refer to group defined in the same lookbehind subpattern');
  }
}

export class SubPattern {
  private width: [bigint, bigint] | undefined;

  constructor(
    readonly state: ParseState,
    public data: Item[] = []
  ) {}

  /** The minimum and maximum widths of what this subpattern matches. */
  getwidth(): [bigint, bigint] {
    if (this.width) return this.width;
    let lo = 0n;
    let hi = 0n;
    for (const item of this.data) {
      const [itemLo, itemHi] = this.itemWidth(item);
      lo += itemLo;
      hi += itemHi;
    }
    this.width = [lo < MAXWIDTH ? lo : MAXWIDTH, hi < MAXWIDTH ? hi : MAXWIDTH];
    return this.width;
  }

  // code-gauge-allow functionNcss 41 -- Transcribes re._parser.SubPattern.getwidth, one case per opcode.
  // code-gauge-allow functionCognitiveComplexity 21 -- Transcribes re._parser.SubPattern.getwidth, one case per opcode.
  private itemWidth(item: Item): [bigint, bigint] {
    switch (item.op) {
      case 'BRANCH': {
        let lo = MAXWIDTH;
        let hi = 0n;
        for (const branch of item.branches) {
          const [l, h] = branch.getwidth();
          if (l < lo) lo = l;
          if (h > hi) hi = h;
        }
        return [lo, hi];
      }
      case 'ATOMIC_GROUP':
      case 'SUBPATTERN': {
        return item.pattern.getwidth();
      }
      case 'MAX_REPEAT':
      case 'MIN_REPEAT':
      case 'POSSESSIVE_REPEAT': {
        const [l, h] = item.item.getwidth();
        const max = BigInt(item.max);
        return [l * BigInt(item.min), max === BIG_MAXREPEAT && h > 0n ? MAXWIDTH : h * max];
      }
      case 'ANY':
      case 'IN':
      case 'LITERAL':
      case 'NOT_LITERAL': {
        return [1n, 1n];
      }
      case 'GROUPREF': {
        return this.state.groupwidths[item.group] as [bigint, bigint];
      }
      case 'GROUPREF_EXISTS': {
        let [lo, hi] = item.yes.getwidth();
        if (item.no) {
          const [l, h] = item.no.getwidth();
          if (l < lo) lo = l;
          if (h > hi) hi = h;
        } else lo = 0n;
        return [lo, hi];
      }
      default: {
        return [0n, 0n];
      }
    }
  }
}

/** Parses a pattern, as `re._parser.parse` does, raising PatternSyntaxError. */
export function parse(pattern: string, flags: number, isText = true): SubPattern {
  const source = new Tokenizer(pattern, isText);
  const state = new ParseState();
  state.flags = flags;
  const parsed = parseSub(source, state, (flags & FLAG.VERBOSE) !== 0, 0);
  state.flags = isText ? fixFlags(state.flags) : fixBytesFlags(state.flags);
  if (source.next !== undefined) throw source.error('unbalanced parenthesis');
  for (const [group, position] of state.grouprefpos) {
    if (group >= state.groups) throw new PatternSyntaxError('pattern', `invalid group reference ${group}`, position);
  }
  return parsed;
}

function fixBytesFlags(flags: number): number {
  if (flags & FLAG.UNICODE) throw new PatternSyntaxError('value', 'cannot use UNICODE flag with a bytes pattern');
  if (flags & FLAG.LOCALE && flags & FLAG.ASCII) {
    throw new PatternSyntaxError('value', 'ASCII and LOCALE flags are incompatible');
  }
  return flags;
}

function fixFlags(flags: number): number {
  if (flags & FLAG.LOCALE) throw new PatternSyntaxError('value', 'cannot use LOCALE flag with a str pattern');
  if (!(flags & FLAG.ASCII)) return flags | FLAG.UNICODE;
  if (flags & FLAG.UNICODE) throw new PatternSyntaxError('value', 'ASCII and UNICODE flags are incompatible');
  return flags;
}

export function parseSub(source: Tokenizer, state: ParseState, verbose: boolean, nested: number): SubPattern {
  const items: SubPattern[] = [];
  let isVerbose = verbose;
  for (;;) {
    items.push(parseSequence(source, state, isVerbose, nested + 1, nested === 0 && items.length === 0));
    if (!source.match('|')) break;
    if (nested === 0) isVerbose = (state.flags & FLAG.VERBOSE) !== 0;
  }
  if (items.length === 1) return items[0];
  const subpattern = new SubPattern(state);
  for (let prefix = commonPrefix(items); prefix !== undefined; prefix = commonPrefix(items)) {
    for (const item of items) item.data.splice(0, 1);
    subpattern.data.push(prefix);
  }
  const set = branchAsSet(items);
  subpattern.data.push(set ? { op: 'IN', set: uniqueSetItems(set) } : { op: 'BRANCH', branches: items });
  return subpattern;
}

function commonPrefix(items: SubPattern[]): Item | undefined {
  let prefix: Item | undefined;
  for (const item of items) {
    if (item.data.length === 0) return undefined;
    if (prefix === undefined) prefix = item.data[0];
    else if (!itemsEqual(item.data[0], prefix)) return undefined;
  }
  return prefix;
}

/** Whether two items are equal as Python tuples are, where subpatterns compare by identity. */
function itemsEqual(left: Item, right: Item): boolean {
  if (left.op !== right.op) return false;
  const rightRecord = right as Record<string, unknown>;
  return Object.entries(left).every(([key, value]) => {
    const other = rightRecord[key];
    if (key === 'set') return JSON.stringify(value) === JSON.stringify(other);
    if (key === 'branches') {
      const [mine, theirs] = [value as SubPattern[], other as SubPattern[]];
      return mine.length === theirs.length && mine.every((branch, index) => branch === theirs[index]);
    }
    return value === other;
  });
}

function branchAsSet(items: SubPattern[]): SetItem[] | undefined {
  const set: SetItem[] = [];
  for (const item of items) {
    if (item.data.length !== 1) return undefined;
    const [only] = item.data;
    if (only.op === 'LITERAL') set.push({ op: 'LITERAL', code: only.code });
    else if (only.op === 'IN' && only.set[0].op !== 'NEGATE') set.push(...only.set);
    else return undefined;
  }
  return set;
}

function uniqueSetItems(set: SetItem[]): SetItem[] {
  const seen = new Map<string, SetItem>();
  for (const item of set) {
    const key = JSON.stringify(item);
    if (!seen.has(key)) seen.set(key, item);
  }
  return [...seen.values()];
}

// code-gauge-allow functionNcss 39 -- Transcribes the main loop of re._parser._parse in its order.
// code-gauge-allow functionCognitiveComplexity 24 -- Transcribes the main loop of re._parser._parse in its order.
export function parseSequence(
  source: Tokenizer,
  state: ParseState,
  verbose: boolean,
  nested: number,
  first = false
): SubPattern {
  const subpattern = new SubPattern(state);
  let isVerbose = verbose;
  for (;;) {
    const current = source.next;
    if (current === undefined || current === '|' || current === ')') break;
    source.get();
    if (isVerbose && skipVerbose(source, current)) continue;
    if (current.length > 1 && current.startsWith('\\')) subpattern.data.push(parseEscape(source, current, state));
    else if (!SPECIAL_CHARS.includes(current)) subpattern.data.push({ op: 'LITERAL', code: ord(current) });
    else if (current === '[') subpattern.data.push(parseClass(source));
    else if (REPEAT_CHARS.includes(current)) parseRepeat(source, subpattern, current);
    else if (current === '.') subpattern.data.push({ op: 'ANY' });
    else if (current === '(') {
      const verboseAfter = parseGroup(source, state, subpattern, { verbose: isVerbose, nested, first });
      if (verboseAfter !== undefined) isVerbose = verboseAfter;
    } else if (current === '^') subpattern.data.push({ op: 'AT', at: 'BEGINNING' });
    else subpattern.data.push({ op: 'AT', at: 'END' });
  }
  for (let index = subpattern.data.length - 1; index >= 0; index--) {
    const item = subpattern.data[index];
    if (item.op === 'SUBPATTERN' && item.group === undefined && !item.addFlags && !item.delFlags)
      subpattern.data.splice(index, 1, ...item.pattern.data);
  }
  return subpattern;
}

/** Skips whitespace and a comment in verbose mode, returning whether `current` was skipped. */
function skipVerbose(source: Tokenizer, current: string): boolean {
  if (WHITESPACE.has(current)) return true;
  if (current !== '#') return false;
  for (;;) {
    const char = source.get();
    if (char === undefined || char === '\n') return true;
  }
}

function parseClass(source: Tokenizer): Item {
  const here = source.tell() - 1;
  const set: SetItem[] = [];
  const negate = source.match('^');
  while (parseClassMember(source, set, here));
  const unique = uniqueSetItems(set);
  if (unique.length === 1 && unique[0].op === 'LITERAL')
    return { op: negate ? 'NOT_LITERAL' : 'LITERAL', code: unique[0].code };
  if (negate) unique.unshift({ op: 'NEGATE' });
  return { op: 'IN', set: unique };
}

/** Parses a character or a range of a character set into `set`, returning false once the set closes. */
function parseClassMember(source: Tokenizer, set: SetItem[], here: number): boolean {
  const current = source.get();
  if (current === undefined) throw source.error('unterminated character set', source.tell() - here);
  if (current === ']' && set.length > 0) return false;
  const code1 = isEscape(current) ? classEscape(source, current) : literal(current);
  if (!source.match('-')) {
    set.push(code1.op === 'IN' ? code1.set[0] : code1);
    return true;
  }
  const that = source.get();
  if (that === undefined) throw source.error('unterminated character set', source.tell() - here);
  if (that === ']') {
    set.push(code1.op === 'IN' ? code1.set[0] : code1, { op: 'LITERAL', code: 0x2d });
    return false;
  }
  const code2 = isEscape(that) ? classEscape(source, that) : literal(that);
  const message = `bad character range ${current}-${that}`;
  const offset = codePointLength(current) + 1 + codePointLength(that);
  if (code1.op !== 'LITERAL' || code2.op !== 'LITERAL' || code2.code < code1.code) throw source.error(message, offset);
  set.push({ op: 'RANGE', lo: code1.code, hi: code2.code });
  return true;
}

const literal = (char: string): { op: 'LITERAL'; code: number } => ({ op: 'LITERAL', code: ord(char) });

type ClassCode = { op: 'LITERAL'; code: number } | { op: 'IN'; set: SetItem[] };

function classEscape(source: Tokenizer, escape: string): ClassCode {
  const simple = ESCAPES[escape];
  if (simple !== undefined) return { op: 'LITERAL', code: simple };
  const category = CATEGORIES[escape];
  if (category?.op === 'IN') return category;
  const char = escape.slice(1);
  const numeric = numericEscape(source, escape, char);
  if (numeric !== undefined) return { op: 'LITERAL', code: numeric };
  if (OCTDIGITS.has(char)) {
    const full = escape + source.getwhile(2, OCTDIGITS);
    const code = Number.parseInt(full.slice(1), 8);
    if (code > 0o377) throw source.error(`octal escape value ${full} outside of range 0-0o377`, codePointLength(full));
    return { op: 'LITERAL', code };
  }
  if (DIGITS.has(char) || ASCII_LETTER.test(char)) throw source.error(`bad escape ${escape}`, codePointLength(escape));
  return { op: 'LITERAL', code: ord(char) };
}

/** The `\x`, `\u`, `\U`, and `\N` escapes, which both contexts share, or undefined for other escapes. */
function numericEscape(source: Tokenizer, escape: string, char: string): number | undefined {
  // A bytes pattern has no \u and \U escapes.
  const digits = char === 'x' || source.isText ? { x: 2, u: 4, U: 8 }[char] : undefined;
  if (digits !== undefined) {
    const full = escape + source.getwhile(digits, HEXDIGITS);
    if (full.length !== digits + 2) throw source.error(`incomplete escape ${full}`, full.length);
    const code = Number.parseInt(full.slice(2), 16);
    if (code > 0x10_ff_ff) throw source.error(`bad escape ${full}`, full.length);
    return code;
  }
  if (char !== 'N' || !source.isText) return undefined;
  if (!source.match('{')) throw source.error('missing {');
  const name = source.getuntil('}', 'character name');
  // CPython looks the name up with unicodedata.lookup(), whose named sequences ord() then rejects.
  const code = name.length > 256 ? undefined : lookupName(name, true);
  if (typeof code !== 'number') {
    throw source.error(
      `undefined character name ${strRepr(name)}`,
      codePointLength(name) + codePointLength(String.raw`\N{}`)
    );
  }
  return code;
}

function parseEscape(source: Tokenizer, escape: string, state: ParseState): Item {
  const category = CATEGORIES[escape];
  if (category) return category;
  const simple = ESCAPES[escape];
  if (simple !== undefined) return { op: 'LITERAL', code: simple };
  const char = escape.slice(1);
  const numeric = numericEscape(source, escape, char);
  if (numeric !== undefined) return { op: 'LITERAL', code: numeric };
  if (char === '0') return { op: 'LITERAL', code: Number.parseInt(source.getwhile(2, OCTDIGITS) || '0', 8) };
  if (DIGITS.has(char)) return parseGroupReference(source, escape, state);
  if (ASCII_LETTER.test(char)) throw source.error(`bad escape ${escape}`, codePointLength(escape));
  return { op: 'LITERAL', code: ord(char) };
}

function parseGroupReference(source: Tokenizer, escape: string, state: ParseState): Item {
  let full = escape;
  if (source.next !== undefined && DIGITS.has(source.next)) {
    full += source.get();
    if (OCTDIGITS.has(full[1]) && OCTDIGITS.has(full[2]) && source.next !== undefined && OCTDIGITS.has(source.next)) {
      full += source.get();
      const code = Number.parseInt(full.slice(1), 8);
      if (code > 0o377) throw source.error(`octal escape value ${full} outside of range 0-0o377`, full.length);
      return { op: 'LITERAL', code };
    }
  }
  const group = Number.parseInt(full.slice(1), 10);
  if (group < state.groups) {
    if (!state.checkgroup(group)) throw source.error('cannot refer to an open group', full.length);
    state.checklookbehindgroup(group, source);
    return { op: 'GROUPREF', group };
  }
  throw source.error(`invalid group reference ${group}`, full.length - 1);
}

function parseRepeat(source: Tokenizer, subpattern: SubPattern, current: string): void {
  const here = source.tell();
  const bounds = repeatBounds(source, current, here);
  if (bounds === undefined) {
    subpattern.data.push(literal(current));
    return;
  }
  const last = subpattern.data.at(-1);
  const offset = source.tell() - here + current.length;
  if (last === undefined || last.op === 'AT') throw source.error('nothing to repeat', offset);
  if (last.op === 'MAX_REPEAT' || last.op === 'MIN_REPEAT' || last.op === 'POSSESSIVE_REPEAT')
    throw source.error('multiple repeat', offset);
  const item =
    last.op === 'SUBPATTERN' && last.group === undefined && !last.addFlags && !last.delFlags
      ? last.pattern
      : new SubPattern(subpattern.state, [last]);
  const op: RepeatOp = source.match('?') ? 'MIN_REPEAT' : source.match('+') ? 'POSSESSIVE_REPEAT' : 'MAX_REPEAT';
  subpattern.data[subpattern.data.length - 1] = { op, min: bounds[0], max: bounds[1], item };
}

/** The bounds of a repeat, or undefined when a `{` turns out to be a literal. */
// code-gauge-allow functionCognitiveComplexity 16 -- Transcribes the `{m,n}` branch of re._parser._parse.
function repeatBounds(source: Tokenizer, current: string, here: number): [number, number] | undefined {
  if (current === '?') return [0, 1];
  if (current === '*') return [0, MAXREPEAT];
  if (current === '+') return [1, MAXREPEAT];
  if (source.next === '}') return undefined;
  let lo = '';
  let hi = '';
  while (source.next !== undefined && DIGITS.has(source.next)) lo += source.get();
  if (source.match(',')) {
    while (source.next !== undefined && DIGITS.has(source.next)) hi += source.get();
  } else hi = lo;
  if (!source.match('}')) {
    source.seek(here);
    return undefined;
  }
  let min = 0;
  let max = MAXREPEAT;
  if (lo) min = repeatNumber(lo);
  if (hi) {
    max = repeatNumber(hi);
    if (max < min) throw source.error('min repeat greater than max repeat', source.tell() - here);
  }
  return [min, max];
}

function repeatNumber(digits: string): number {
  if (BigInt(digits) >= BIG_MAXREPEAT) throw new PatternSyntaxError('overflow', 'the repetition number is too large');
  return Number(digits);
}
