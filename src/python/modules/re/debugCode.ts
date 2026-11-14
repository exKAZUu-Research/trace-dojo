// The code that CPython's `re._compiler._code` makes, bitmaps and info block included, which `re.DEBUG` shows.
// Matching runs the code of compiler.ts instead, whose character sets need no bitmaps.
import { EXTRA_CASES } from './compiler';
import { FLAG, MAXREPEAT, TYPE_FLAGS } from './constants';
import { compileInfo } from './debugInfo';
import type { AtName, Item, SetItem, SubPattern } from './parser';
import { PatternSyntaxError } from './tokenizer';
import { asciiIsCased, asciiLower, unicodeIsCased, unicodeLower } from './unicodeData';

/** The opcode names of `re._constants.OPCODES`, by number. */
export const OPCODE_NAMES = [
  'FAILURE',
  'SUCCESS',
  'ANY',
  'ANY_ALL',
  'ASSERT',
  'ASSERT_NOT',
  'AT',
  'BRANCH',
  'CATEGORY',
  'CHARSET',
  'BIGCHARSET',
  'GROUPREF',
  'GROUPREF_EXISTS',
  'IN',
  'INFO',
  'JUMP',
  'LITERAL',
  'MARK',
  'MAX_UNTIL',
  'MIN_UNTIL',
  'NOT_LITERAL',
  'NEGATE',
  'RANGE',
  'REPEAT',
  'REPEAT_ONE',
  'SUBPATTERN',
  'MIN_REPEAT_ONE',
  'ATOMIC_GROUP',
  'POSSESSIVE_REPEAT',
  'POSSESSIVE_REPEAT_ONE',
  'GROUPREF_IGNORE',
  'IN_IGNORE',
  'LITERAL_IGNORE',
  'NOT_LITERAL_IGNORE',
  'GROUPREF_LOC_IGNORE',
  'IN_LOC_IGNORE',
  'LITERAL_LOC_IGNORE',
  'NOT_LITERAL_LOC_IGNORE',
  'GROUPREF_UNI_IGNORE',
  'IN_UNI_IGNORE',
  'LITERAL_UNI_IGNORE',
  'NOT_LITERAL_UNI_IGNORE',
  'RANGE_UNI_IGNORE',
] as const;

export const AT_NAMES = [
  'AT_BEGINNING',
  'AT_BEGINNING_LINE',
  'AT_BEGINNING_STRING',
  'AT_BOUNDARY',
  'AT_NON_BOUNDARY',
  'AT_END',
  'AT_END_LINE',
  'AT_END_STRING',
  'AT_LOC_BOUNDARY',
  'AT_LOC_NON_BOUNDARY',
  'AT_UNI_BOUNDARY',
  'AT_UNI_NON_BOUNDARY',
];

export const CATEGORY_NAMES = [
  'CATEGORY_DIGIT',
  'CATEGORY_NOT_DIGIT',
  'CATEGORY_SPACE',
  'CATEGORY_NOT_SPACE',
  'CATEGORY_WORD',
  'CATEGORY_NOT_WORD',
  'CATEGORY_LINEBREAK',
  'CATEGORY_NOT_LINEBREAK',
  'CATEGORY_LOC_WORD',
  'CATEGORY_LOC_NOT_WORD',
  'CATEGORY_UNI_DIGIT',
  'CATEGORY_UNI_NOT_DIGIT',
  'CATEGORY_UNI_SPACE',
  'CATEGORY_UNI_NOT_SPACE',
  'CATEGORY_UNI_WORD',
  'CATEGORY_UNI_NOT_WORD',
  'CATEGORY_UNI_LINEBREAK',
  'CATEGORY_UNI_NOT_LINEBREAK',
];

export const op = (name: (typeof OPCODE_NAMES)[number]): number => OPCODE_NAMES.indexOf(name);
const at = (name: string): number => AT_NAMES.indexOf(name);
export const MAXCODE = 4_294_967_295;

/** A charset item of `_optimize_charset`: the parser's items, bitmaps, and RANGE_UNI_IGNORE. */
export type CodeSetItem =
  | SetItem
  | { op: 'RANGE_UNI_IGNORE'; lo: number; hi: number }
  | { op: 'CHARSET' | 'BIGCHARSET'; words: number[] };

interface Folding {
  iscased: (code: number) => boolean;
  tolower: (code: number) => number;
  fixes?: Map<number, number[]>;
}

function folding(flags: number): Folding | undefined {
  if (!(flags & FLAG.IGNORECASE) || flags & FLAG.LOCALE) return undefined;
  if (flags & FLAG.UNICODE) return { iscased: unicodeIsCased, tolower: unicodeLower, fixes: EXTRA_CASES };
  return { iscased: asciiIsCased, tolower: asciiLower };
}

export function combineFlags(flags: number, addFlags: number, delFlags: number): number {
  const base = addFlags & TYPE_FLAGS ? flags & ~TYPE_FLAGS : flags;
  return (base | addFlags) & ~delFlags;
}

/** `re._compiler._code`. */
export function debugCode(pattern: SubPattern, flags: number): number[] {
  const code: number[] = [];
  compileInfo(code, pattern, flags);
  compile(code, pattern.data, flags);
  code.push(op('SUCCESS'));
  return code;
}

export function skipFrom(code: number[], extra = 0): () => void {
  const index = code.length;
  code.push(0);
  return () => {
    code[index] = code.length - index + extra;
  };
}

function compile(code: number[], items: Item[], flags: number): void {
  for (const item of items) compileItem(code, item, flags);
}

// code-gauge-allow functionNcss 56 -- Transcribes the opcode dispatch of re._compiler._compile.
function compileItem(code: number[], item: Item, flags: number): void {
  switch (item.op) {
    case 'LITERAL':
    case 'NOT_LITERAL': {
      compileLiteral(code, item.op, item.code, flags);
      break;
    }
    case 'IN': {
      compileIn(code, item.set, flags);
      break;
    }
    case 'ANY': {
      code.push(op(flags & FLAG.DOTALL ? 'ANY_ALL' : 'ANY'));
      break;
    }
    case 'MIN_REPEAT':
    case 'MAX_REPEAT':
    case 'POSSESSIVE_REPEAT': {
      compileRepeat(code, item, flags);
      break;
    }
    case 'SUBPATTERN': {
      if (item.group) code.push(op('MARK'), (item.group - 1) * 2);
      compile(code, item.pattern.data, combineFlags(flags, item.addFlags, item.delFlags));
      if (item.group) code.push(op('MARK'), (item.group - 1) * 2 + 1);
      break;
    }
    case 'ATOMIC_GROUP': {
      code.push(op('ATOMIC_GROUP'));
      const setSkip = skipFrom(code);
      compile(code, item.pattern.data, flags);
      code.push(op('SUCCESS'));
      setSkip();
      break;
    }
    case 'FAILURE': {
      code.push(op('FAILURE'));
      break;
    }
    case 'ASSERT':
    case 'ASSERT_NOT': {
      compileAssert(code, item, flags);
      break;
    }
    case 'AT': {
      code.push(op('AT'), atCode(item.at, flags));
      break;
    }
    case 'BRANCH': {
      compileBranch(code, item.branches, flags);
      break;
    }
    case 'GROUPREF': {
      code.push(op(groupRefOp(flags)), item.group - 1);
      break;
    }
    case 'GROUPREF_EXISTS': {
      compileGroupRefExists(code, item, flags);
      break;
    }
  }
}

function compileAssert(code: number[], item: Extract<Item, { op: 'ASSERT' | 'ASSERT_NOT' }>, flags: number): void {
  code.push(op(item.op));
  const setSkip = skipFrom(code);
  if (item.dir >= 0) code.push(0);
  else {
    const [lo, hi] = item.pattern.getwidth();
    if (lo > BigInt(MAXCODE)) throw new PatternSyntaxError('pattern', 'looks too much behind');
    if (lo !== hi) throw new PatternSyntaxError('pattern', 'look-behind requires fixed-width pattern');
    code.push(Number(lo));
  }
  compile(code, item.pattern.data, flags);
  code.push(op('SUCCESS'));
  setSkip();
}

function groupRefOp(flags: number): (typeof OPCODE_NAMES)[number] {
  if (!(flags & FLAG.IGNORECASE)) return 'GROUPREF';
  if (flags & FLAG.LOCALE) return 'GROUPREF_LOC_IGNORE';
  return flags & FLAG.UNICODE ? 'GROUPREF_UNI_IGNORE' : 'GROUPREF_IGNORE';
}

function compileLiteral(code: number[], name: 'LITERAL' | 'NOT_LITERAL', value: number, flags: number): void {
  const fold = folding(flags);
  if (!(flags & FLAG.IGNORECASE)) code.push(op(name), value);
  else if (flags & FLAG.LOCALE) code.push(op(`${name}_LOC_IGNORE`), value);
  else if (!fold?.iscased(value)) code.push(op(name), value);
  else {
    const lowered = fold.tolower(value);
    if (!fold.fixes) code.push(op(`${name}_IGNORE`), lowered);
    else if (!fold.fixes.has(lowered)) code.push(op(`${name}_UNI_IGNORE`), lowered);
    else {
      code.push(op('IN_UNI_IGNORE'));
      const setSkip = skipFrom(code);
      if (name === 'NOT_LITERAL') code.push(op('NEGATE'));
      for (const each of [lowered, ...(fold.fixes.get(lowered) ?? [])]) code.push(op('LITERAL'), each);
      code.push(op('FAILURE'));
      setSkip();
    }
  }
}

function compileIn(code: number[], set: SetItem[], flags: number): void {
  const fold = folding(flags);
  const [charset, hascased] = optimizeCharset(set, fold);
  if (charset.length === 0) {
    code.push(op('FAILURE'));
    return;
  }
  if (charset.length === 1 && charset[0].op === 'NEGATE') {
    code.push(op('ANY_ALL'));
    return;
  }
  if (flags & FLAG.IGNORECASE && flags & FLAG.LOCALE) code.push(op('IN_LOC_IGNORE'));
  else if (!hascased) code.push(op('IN'));
  else code.push(op(fold?.fixes ? 'IN_UNI_IGNORE' : 'IN_IGNORE'));
  const setSkip = skipFrom(code);
  compileCharset(code, charset, flags);
  setSkip();
}

const UNICODE_CATEGORY_OFFSET = 10;
const LOCALE_CATEGORIES: Record<number, number> = { 4: 8, 5: 9 };

function categoryCode(category: number, flags: number): number {
  if (flags & FLAG.LOCALE) return LOCALE_CATEGORIES[category] ?? category;
  return flags & FLAG.UNICODE ? category + UNICODE_CATEGORY_OFFSET : category;
}

export function compileCharset(code: number[], charset: CodeSetItem[], flags: number): void {
  for (const item of charset) {
    code.push(op(item.op));
    if (item.op === 'LITERAL') code.push(item.code);
    else if (item.op === 'RANGE' || item.op === 'RANGE_UNI_IGNORE') code.push(item.lo, item.hi);
    else if (item.op === 'CHARSET' || item.op === 'BIGCHARSET') code.push(...item.words);
    else if (item.op === 'CATEGORY') code.push(categoryCode(item.category, flags));
  }
  code.push(op('FAILURE'));
}

/** `re._compiler._optimize_charset`, with its bytearray charmap and the IndexErrors that grow it. */
export function optimizeCharset(charset: SetItem[], fold?: Folding): [CodeSetItem[], boolean] {
  const optimizer = new CharsetOptimizer(fold);
  const out: CodeSetItem[] = [];
  for (const item of charset) {
    if (item.op === 'LITERAL') optimizer.addLiteral(item.code);
    else if (item.op === 'RANGE') optimizer.addRange(item);
    else if (item.op === 'NEGATE') out.push(item);
    else if (optimizer.tail.some((each) => each.op === 'CATEGORY' && each.category === (item.category ^ 1))) {
      return [out.length > 0 ? [] : [{ op: 'NEGATE' }], false];
    } else optimizer.tail.push(item);
  }
  const { charmap, tail, hascased } = optimizer;
  return [compressCharmap(charset, charmap, out, tail, hascased), hascased];
}

class CharsetOptimizer {
  charmap = new Uint8Array(256);
  readonly tail: CodeSetItem[] = [];
  hascased = false;

  constructor(private readonly fold: Folding | undefined) {}

  /** Sets a character in the charmap, which grows past the Latin-1 range, or returns false past the BMP. */
  private mark(index: number): boolean {
    if (index >= this.charmap.length && this.charmap.length === 256) {
      const grown = new Uint8Array(65_536);
      grown.set(this.charmap);
      this.charmap = grown;
    }
    if (index >= this.charmap.length) return false;
    this.charmap[index] = 1;
    return true;
  }

  /** Marks a lowered character and the other lowercase characters that share its uppercase. */
  private markFolded(value: number): boolean {
    if (!this.mark(value)) return false;
    for (const extra of this.fold?.fixes?.get(value) ?? []) this.mark(extra);
    return true;
  }

  addLiteral(code: number): void {
    const { fold } = this;
    const value = fold ? fold.tolower(code) : code;
    if (!this.markFolded(value)) this.tail.push({ op: 'LITERAL', code: value });
    if (fold?.iscased(value)) this.hascased = true;
  }

  addRange(item: Extract<SetItem, { op: 'RANGE' }>): void {
    const { fold } = this;
    for (let code = item.lo; code <= item.hi; code++) {
      if (this.markFolded(fold ? fold.tolower(code) : code)) continue;
      if (fold) this.hascased = true;
      this.tail.push(fold?.fixes ? { op: 'RANGE_UNI_IGNORE', lo: item.lo, hi: item.hi } : item);
      return;
    }
    if (!fold) return;
    for (let code = item.lo; code <= item.hi && !this.hascased; code++) this.hascased = fold.iscased(code);
  }
}

// code-gauge-allow functionCognitiveComplexity 17 -- Transcribes the charmap compression of _optimize_charset.
function compressCharmap(
  charset: SetItem[],
  charmap: Uint8Array,
  out: CodeSetItem[],
  tail: CodeSetItem[],
  hascased: boolean
): CodeSetItem[] {
  const runs: [number, number][] = [];
  let tooMany = false;
  for (let q = 0; ;) {
    const p = charmap.indexOf(1, q);
    if (p === -1) break;
    if (runs.length >= 2) {
      tooMany = true;
      break;
    }
    q = charmap.indexOf(0, p);
    if (q < 0) {
      runs.push([p, charmap.length]);
      break;
    }
    runs.push([p, q]);
  }
  if (!tooMany) {
    for (const [p, q] of runs) out.push(q - p === 1 ? { op: 'LITERAL', code: p } : { op: 'RANGE', lo: p, hi: q - 1 });
    out.push(...tail);
    return hascased || out.length < charset.length ? out : charset;
  }
  if (charmap.length === 256) return [...out, { op: 'CHARSET', words: bitmap(charmap) }, ...tail];
  return [...out, { op: 'BIGCHARSET', words: bigCharset(charmap) }, ...tail];
}

/** `_mk_bitmap`: 32 bits per word, the lowest bit first. */
function bitmap(bits: Uint8Array): number[] {
  const words: number[] = [];
  for (let start = 0; start < bits.length; start += 32) {
    let word = 0;
    for (let bit = 31; bit >= 0; bit--) word = word * 2 + bits[start + bit];
    words.push(word);
  }
  return words;
}

/** The BIGCHARSET data: the number of distinct chunks, the chunk of each 256 characters, and the chunks' bitmaps. */
function bigCharset(charmap: Uint8Array): number[] {
  const chunks = new Map<string, number>();
  const mapping = new Uint8Array(256);
  const data: number[] = [];
  for (let index = 0; index < 65_536; index += 256) {
    const chunk = charmap.subarray(index, index + 256);
    const key = chunk.join('');
    let block = chunks.get(key);
    if (block === undefined) {
      block = chunks.size;
      chunks.set(key, block);
      data.push(...chunk);
    }
    mapping[index / 256] = block;
  }
  const mappingWords: number[] = [];
  for (let index = 0; index < 256; index += 4) {
    mappingWords.push(
      mapping[index] + mapping[index + 1] * 256 + mapping[index + 2] * 65_536 + mapping[index + 3] * 16_777_216
    );
  }
  return [chunks.size, ...mappingWords, ...bitmap(Uint8Array.from(data))];
}

function compileRepeat(
  code: number[],
  item: Extract<Item, { op: 'MIN_REPEAT' | 'MAX_REPEAT' | 'POSSESSIVE_REPEAT' }>,
  flags: number
): void {
  const names = {
    MIN_REPEAT: ['REPEAT', 'MIN_UNTIL', 'MIN_REPEAT_ONE'],
    MAX_REPEAT: ['REPEAT', 'MAX_UNTIL', 'REPEAT_ONE'],
    POSSESSIVE_REPEAT: ['POSSESSIVE_REPEAT', 'SUCCESS', 'POSSESSIVE_REPEAT_ONE'],
  } as const;
  const [repeat, until, single] = names[item.op];
  const simple = isSimple(item.item.data);
  code.push(op(simple ? single : repeat));
  const setSkip = skipFrom(code);
  code.push(item.min, item.max);
  compile(code, item.item.data, flags);
  if (simple) code.push(op('SUCCESS'));
  setSkip();
  if (!simple) code.push(op(until));
}

function isSimple(items: Item[]): boolean {
  if (items.length !== 1) return false;
  const [only] = items;
  if (only.op === 'SUBPATTERN') return only.group === undefined && isSimple(only.pattern.data);
  return only.op === 'LITERAL' || only.op === 'NOT_LITERAL' || only.op === 'ANY' || only.op === 'IN';
}

function atCode(name: AtName, flags: number): number {
  let code = `AT_${name}`;
  if (flags & FLAG.MULTILINE && (name === 'BEGINNING' || name === 'END')) code = `AT_${name}_LINE`;
  if (name === 'BOUNDARY' || name === 'NON_BOUNDARY') {
    if (flags & FLAG.LOCALE) code = `AT_LOC_${name}`;
    else if (flags & FLAG.UNICODE) code = `AT_UNI_${name}`;
  }
  return at(code);
}

function compileBranch(code: number[], branches: SubPattern[], flags: number): void {
  code.push(op('BRANCH'));
  const tails: (() => void)[] = [];
  for (const branch of branches) {
    const setSkip = skipFrom(code);
    compile(code, branch.data, flags);
    code.push(op('JUMP'));
    tails.push(skipFrom(code));
    setSkip();
  }
  code.push(op('FAILURE'));
  for (const setTail of tails) setTail();
}

function compileGroupRefExists(code: number[], item: Extract<Item, { op: 'GROUPREF_EXISTS' }>, flags: number): void {
  code.push(op('GROUPREF_EXISTS'), item.group - 1);
  const setYes = skipFrom(code, 1);
  compile(code, item.yes.data, flags);
  if (item.no) {
    code.push(op('JUMP'));
    const setNo = skipFrom(code);
    setYes();
    compile(code, item.no.data, flags);
    setNo();
  } else setYes();
}

export { MAXREPEAT };
