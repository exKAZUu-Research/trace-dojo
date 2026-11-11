// A transcription of CPython's `re._compiler._compile`, which turns the parsed tree into the code that `_sre` runs.
// Character sets go to a side table instead of CPython's bitmaps, which only make them faster.
import { AT, CATEGORY, FLAG, MAXREPEAT, OP, TYPE_FLAGS } from './constants';
import type { AtName, Item, SetItem, SubPattern } from './parser';
import { PatternSyntaxError } from './tokenizer';
import { asciiIsCased, asciiLower, unicodeIsCased, unicodeLower } from './unicodeData';

export type CharsetItem =
  | { op: 'LITERAL'; code: number }
  | { op: 'RANGE' | 'RANGE_UNI_IGNORE'; lo: number; hi: number }
  | { op: 'CATEGORY'; category: number };

export interface Charset {
  negate: boolean;
  /** The lowered characters of the Basic Multilingual Plane that a case-insensitive set contains. */
  lowered?: Set<number>;
  items: CharsetItem[];
}

export interface Program {
  code: number[];
  charsets: Charset[];
  /** The set of the characters a match can start with, by which a search skips positions, as CPython's does. */
  searchCharset?: number;
}

interface CaseFolding {
  iscased: (code: number) => boolean;
  tolower: (code: number) => number;
  fixes?: Map<number, number[]>;
}

/** `re._casefix._EXTRA_CASES`: lowercase characters that share an uppercase with other lowercase characters. */
export const EXTRA_CASES = new Map<number, number[]>([
  [0x69, [0x1_31]],
  [0x73, [0x1_7f]],
  [0xb5, [0x3_bc]],
  [0x1_31, [0x69]],
  [0x1_7f, [0x73]],
  [0x3_45, [0x3_b9, 0x1f_be]],
  [0x3_90, [0x1f_d3]],
  [0x3_b0, [0x1f_e3]],
  [0x3_b2, [0x3_d0]],
  [0x3_b5, [0x3_f5]],
  [0x3_b8, [0x3_d1]],
  [0x3_b9, [0x3_45, 0x1f_be]],
  [0x3_ba, [0x3_f0]],
  [0x3_bc, [0xb5]],
  [0x3_c0, [0x3_d6]],
  [0x3_c1, [0x3_f1]],
  [0x3_c2, [0x3_c3]],
  [0x3_c3, [0x3_c2]],
  [0x3_c6, [0x3_d5]],
  [0x3_d0, [0x3_b2]],
  [0x3_d1, [0x3_b8]],
  [0x3_d5, [0x3_c6]],
  [0x3_d6, [0x3_c0]],
  [0x3_f0, [0x3_ba]],
  [0x3_f1, [0x3_c1]],
  [0x3_f5, [0x3_b5]],
  [0x4_32, [0x1c_80]],
  [0x4_34, [0x1c_81]],
  [0x4_3e, [0x1c_82]],
  [0x4_41, [0x1c_83]],
  [0x4_42, [0x1c_84, 0x1c_85]],
  [0x4_4a, [0x1c_86]],
  [0x4_63, [0x1c_87]],
  [0x1c_80, [0x4_32]],
  [0x1c_81, [0x4_34]],
  [0x1c_82, [0x4_3e]],
  [0x1c_83, [0x4_41]],
  [0x1c_84, [0x4_42, 0x1c_85]],
  [0x1c_85, [0x4_42, 0x1c_84]],
  [0x1c_86, [0x4_4a]],
  [0x1c_87, [0x4_63]],
  [0x1c_88, [0xa6_4b]],
  [0x1e_61, [0x1e_9b]],
  [0x1e_9b, [0x1e_61]],
  [0x1f_be, [0x3_45, 0x3_b9]],
  [0x1f_d3, [0x3_90]],
  [0x1f_e3, [0x3_b0]],
  [0xa6_4b, [0x1c_88]],
  [0xfb_05, [0xfb_06]],
  [0xfb_06, [0xfb_05]],
]);

const UNICODE_CATEGORIES: Record<number, number> = {
  [CATEGORY.DIGIT]: CATEGORY.UNI_DIGIT,
  [CATEGORY.NOT_DIGIT]: CATEGORY.UNI_NOT_DIGIT,
  [CATEGORY.SPACE]: CATEGORY.UNI_SPACE,
  [CATEGORY.NOT_SPACE]: CATEGORY.UNI_NOT_SPACE,
  [CATEGORY.WORD]: CATEGORY.UNI_WORD,
  [CATEGORY.NOT_WORD]: CATEGORY.UNI_NOT_WORD,
};

const REPEAT_CODES = {
  MIN_REPEAT: [OP.REPEAT, OP.MIN_UNTIL, OP.MIN_REPEAT_ONE],
  MAX_REPEAT: [OP.REPEAT, OP.MAX_UNTIL, OP.REPEAT_ONE],
  POSSESSIVE_REPEAT: [OP.POSSESSIVE_REPEAT, OP.SUCCESS, OP.POSSESSIVE_REPEAT_ONE],
} as const;

const MAXCODE = 4_294_967_295n;

/** Compiles a parsed pattern whose flags (inline ones included) are `flags`. */
export function compilePattern(pattern: SubPattern, flags: number): Program {
  const program: Program = { code: [], charsets: [] };
  program.searchCharset = searchCharset(program, pattern, flags);
  compileItems(program, pattern.data, flags);
  program.code.push(OP.SUCCESS);
  return program;
}

/**
 * The charset prefix of `re._compiler._compile_info`. Its categories follow the pattern's flags even when a scoped
 * group such as `(?a:\w)` changes them, which CPython's search inherits and this keeps.
 */
function searchCharset(program: Program, pattern: SubPattern, flags: number): number | undefined {
  if (pattern.getwidth()[0] === 0n || literalPrefix(pattern.data, flags).found) return undefined;
  const set = charsetPrefix(pattern, flags);
  if (!set) return undefined;
  const optimized = optimizeCharset(set, flags, undefined);
  if (optimized === 'all' || optimized === 'failure') return undefined;
  return addCharset(program, optimized.charset);
}

function casedFor(flags: number): ((code: number) => boolean) | undefined {
  return caseFolding(flags)?.iscased;
}

/** Whether `_get_literal_prefix` finds a prefix, and whether the items are all literal. */
function literalPrefix(items: Item[], flags: number): { found: boolean; all: boolean } {
  const cased = casedFor(flags);
  let found = false;
  for (const item of items) {
    if (item.op === 'LITERAL' && !cased?.(item.code)) found = true;
    else if (item.op === 'SUBPATTERN') {
      const inner = literalPrefix(item.pattern.data, combineFlags(flags, item.addFlags, item.delFlags));
      found ||= inner.found;
      if (!inner.all) return { found, all: false };
    } else return { found, all: false };
  }
  return { found, all: true };
}

/** `_get_charset_prefix`: the characters the first item matches, when they are known without case folding. */
// code-gauge-allow functionNcss 32 -- Transcribes re._compiler._get_charset_prefix.
// code-gauge-allow functionCognitiveComplexity 23 -- Transcribes re._compiler._get_charset_prefix.
function charsetPrefix(pattern: SubPattern, patternFlags: number): SetItem[] | undefined {
  let flags = patternFlags;
  let items = pattern.data;
  while (items.length > 0 && items[0].op === 'SUBPATTERN') {
    const first = items[0];
    flags = combineFlags(flags, first.addFlags, first.delFlags);
    items = first.pattern.data;
  }
  if (items.length === 0) return undefined;
  const folding = casedFor(flags);
  const cased = folding ?? ((): boolean => false);
  const [first] = items;
  if (first.op === 'LITERAL') return cased(first.code) ? undefined : [{ op: 'LITERAL', code: first.code }];
  if (first.op === 'BRANCH') {
    const set: SetItem[] = [];
    for (const branch of first.branches) {
      const head = branch.data[0];
      if (head?.op !== 'LITERAL' || cased(head.code)) return undefined;
      set.push({ op: 'LITERAL', code: head.code });
    }
    return set;
  }
  if (first.op !== 'IN') return undefined;
  if (!folding) return first.set;
  for (const item of first.set) {
    if (item.op === 'LITERAL' && cased(item.code)) return undefined;
    if (item.op === 'RANGE' && (item.hi > 0xff_ff || rangeHasCased(item.lo, item.hi, cased))) return undefined;
  }
  return first.set;
}

function rangeHasCased(lo: number, hi: number, cased: (code: number) => boolean): boolean {
  for (let code = lo; code <= hi; code++) if (cased(code)) return true;
  return false;
}

function caseFolding(flags: number): CaseFolding | undefined {
  if (!(flags & FLAG.IGNORECASE)) return undefined;
  if (flags & FLAG.UNICODE) return { iscased: unicodeIsCased, tolower: unicodeLower, fixes: EXTRA_CASES };
  return { iscased: asciiIsCased, tolower: asciiLower };
}

function combineFlags(flags: number, addFlags: number, delFlags: number): number {
  const base = addFlags & TYPE_FLAGS ? flags & ~TYPE_FLAGS : flags;
  return (base | addFlags) & ~delFlags;
}

function compileItems(program: Program, items: Item[], flags: number): void {
  for (const item of items) compileItem(program, item, flags);
}

/** Emits a placeholder for a skip and returns a function that sets it to the distance to the current end. */
function emitSkip(code: number[], extra = 0): () => void {
  const at = code.length;
  code.push(0);
  return () => {
    code[at] = code.length - at + extra;
  };
}

// code-gauge-allow functionNcss 53 -- Transcribes the opcode dispatch of re._compiler._compile.
function compileItem(program: Program, item: Item, flags: number): void {
  const { code } = program;
  switch (item.op) {
    case 'LITERAL':
    case 'NOT_LITERAL': {
      compileLiteral(program, item.op, item.code, flags);
      break;
    }
    case 'IN': {
      compileIn(program, item.set, flags);
      break;
    }
    case 'ANY': {
      code.push(flags & FLAG.DOTALL ? OP.ANY_ALL : OP.ANY);
      break;
    }
    case 'MIN_REPEAT':
    case 'MAX_REPEAT':
    case 'POSSESSIVE_REPEAT': {
      compileRepeat(program, item, flags);
      break;
    }
    case 'SUBPATTERN': {
      if (item.group) code.push(OP.MARK, (item.group - 1) * 2);
      compileItems(program, item.pattern.data, combineFlags(flags, item.addFlags, item.delFlags));
      if (item.group) code.push(OP.MARK, (item.group - 1) * 2 + 1);
      break;
    }
    case 'ATOMIC_GROUP': {
      code.push(OP.ATOMIC_GROUP);
      const setSkip = emitSkip(code);
      compileItems(program, item.pattern.data, flags);
      code.push(OP.SUCCESS);
      setSkip();
      break;
    }
    case 'FAILURE': {
      code.push(OP.FAILURE);
      break;
    }
    case 'ASSERT':
    case 'ASSERT_NOT': {
      compileAssert(program, item, flags);
      break;
    }
    case 'AT': {
      code.push(OP.AT, atCode(item.at, flags));
      break;
    }
    case 'BRANCH': {
      compileBranch(program, item.branches, flags);
      break;
    }
    case 'GROUPREF': {
      const fold = caseFolding(flags);
      const op = !fold ? OP.GROUPREF : fold.fixes ? OP.GROUPREF_UNI_IGNORE : OP.GROUPREF_IGNORE;
      code.push(op, item.group - 1);
      break;
    }
    case 'GROUPREF_EXISTS': {
      compileGroupRefExists(program, item, flags);
      break;
    }
  }
}

function compileLiteral(program: Program, op: 'LITERAL' | 'NOT_LITERAL', value: number, flags: number): void {
  const { code } = program;
  const fold = caseFolding(flags);
  if (!fold || !fold.iscased(value)) {
    code.push(op === 'LITERAL' ? OP.LITERAL : OP.NOT_LITERAL, value);
    return;
  }
  const lowered = fold.tolower(value);
  if (!fold.fixes) code.push(op === 'LITERAL' ? OP.LITERAL_IGNORE : OP.NOT_LITERAL_IGNORE, lowered);
  else if (!fold.fixes.has(lowered))
    code.push(op === 'LITERAL' ? OP.LITERAL_UNI_IGNORE : OP.NOT_LITERAL_UNI_IGNORE, lowered);
  else {
    const items: CharsetItem[] = [lowered, ...(fold.fixes.get(lowered) ?? [])].map((each) => ({
      op: 'LITERAL',
      code: each,
    }));
    code.push(OP.IN_UNI_IGNORE, 2, addCharset(program, { negate: op === 'NOT_LITERAL', items }));
  }
}

function addCharset(program: Program, charset: Charset): number {
  program.charsets.push(charset);
  return program.charsets.length - 1;
}

function compileIn(program: Program, set: SetItem[], flags: number): void {
  const { code } = program;
  const fold = caseFolding(flags);
  const optimized = optimizeCharset(set, flags, fold);
  if (optimized === 'failure') code.push(OP.FAILURE);
  else if (optimized === 'all') code.push(OP.ANY_ALL);
  else {
    const op = !optimized.hascased ? OP.IN : fold?.fixes ? OP.IN_UNI_IGNORE : OP.IN_IGNORE;
    code.push(op, 2, addCharset(program, optimized.charset));
  }
}

/** `re._compiler._optimize_charset` with the categories mapped as `_compile_charset` maps them. */
// code-gauge-allow functionNcss 31 -- Transcribes re._compiler._optimize_charset item by item.
// code-gauge-allow functionCognitiveComplexity 24 -- Transcribes re._compiler._optimize_charset item by item.
function optimizeCharset(
  set: SetItem[],
  flags: number,
  fold: CaseFolding | undefined
): 'failure' | 'all' | { charset: Charset; hascased: boolean } {
  const charset: Charset = { negate: false, items: [] };
  const categories: number[] = [];
  let hascased = false;
  if (fold) charset.lowered = new Set();
  for (const item of set) {
    switch (item.op) {
      case 'LITERAL': {
        if (fold) hascased = addLoweredLiteral(charset, item.code, fold) || hascased;
        else charset.items.push(item);
        break;
      }
      case 'RANGE': {
        if (fold) hascased = addLoweredRange(charset, item.lo, item.hi, fold) || hascased;
        else charset.items.push(item);
        break;
      }
      case 'NEGATE': {
        charset.negate = true;
        break;
      }
      case 'CATEGORY': {
        if (categories.includes(item.category ^ 1)) return charset.negate ? 'failure' : 'all';
        categories.push(item.category);
        const category = flags & FLAG.UNICODE ? UNICODE_CATEGORIES[item.category] : item.category;
        charset.items.push({ op: 'CATEGORY', category });
        break;
      }
    }
  }
  return { charset, hascased };
}

/** Adds a lowered literal to a case-insensitive set, returning whether it is cased. */
function addLoweredLiteral(charset: Charset, value: number, fold: CaseFolding): boolean {
  const lowered = fold.tolower(value);
  if (lowered > 0xff_ff) {
    charset.items.push({ op: 'LITERAL', code: lowered });
    return fold.iscased(lowered);
  }
  charset.lowered?.add(lowered);
  for (const extra of fold.fixes?.get(lowered) ?? []) charset.lowered?.add(extra);
  return fold.iscased(lowered);
}

/** Adds a range to a case-insensitive set, returning whether any of its characters is cased. */
function addLoweredRange(charset: Charset, lo: number, hi: number, fold: CaseFolding): boolean {
  for (let code = lo; code <= hi; code++) {
    const lowered = fold.tolower(code);
    if (lowered > 0xff_ff) {
      charset.items.push({ op: fold.fixes ? 'RANGE_UNI_IGNORE' : 'RANGE', lo, hi });
      return true;
    }
    charset.lowered?.add(lowered);
    for (const extra of fold.fixes?.get(lowered) ?? []) charset.lowered?.add(extra);
  }
  for (let code = lo; code <= hi; code++) if (fold.iscased(code)) return true;
  return false;
}

function compileRepeat(
  program: Program,
  item: Extract<Item, { op: 'MIN_REPEAT' | 'MAX_REPEAT' | 'POSSESSIVE_REPEAT' }>,
  flags: number
): void {
  const { code } = program;
  const [repeatOp, untilOp, singleOp] = REPEAT_CODES[item.op];
  if (isSimple(item.item.data)) {
    code.push(singleOp);
    const setSkip = emitSkip(code);
    code.push(item.min, item.max);
    compileItems(program, item.item.data, flags);
    code.push(OP.SUCCESS);
    setSkip();
    return;
  }
  code.push(repeatOp);
  const setSkip = emitSkip(code);
  code.push(item.min, item.max);
  compileItems(program, item.item.data, flags);
  setSkip();
  code.push(untilOp);
}

function isSimple(items: Item[]): boolean {
  if (items.length !== 1) return false;
  const [only] = items;
  if (only.op === 'SUBPATTERN') return only.group === undefined && isSimple(only.pattern.data);
  return only.op === 'LITERAL' || only.op === 'NOT_LITERAL' || only.op === 'ANY' || only.op === 'IN';
}

function compileAssert(program: Program, item: Extract<Item, { op: 'ASSERT' | 'ASSERT_NOT' }>, flags: number): void {
  const { code } = program;
  code.push(item.op === 'ASSERT' ? OP.ASSERT : OP.ASSERT_NOT);
  const setSkip = emitSkip(code);
  if (item.dir >= 0) code.push(0);
  else {
    const [lo, hi] = item.pattern.getwidth();
    if (lo > MAXCODE) throw new PatternSyntaxError('pattern', 'looks too much behind');
    if (lo !== hi) throw new PatternSyntaxError('pattern', 'look-behind requires fixed-width pattern');
    code.push(Number(lo));
  }
  compileItems(program, item.pattern.data, flags);
  code.push(OP.SUCCESS);
  setSkip();
}

function atCode(at: AtName, flags: number): number {
  if (flags & FLAG.MULTILINE) {
    if (at === 'BEGINNING') return AT.BEGINNING_LINE;
    if (at === 'END') return AT.END_LINE;
  }
  if (flags & FLAG.UNICODE) {
    if (at === 'BOUNDARY') return AT.UNI_BOUNDARY;
    if (at === 'NON_BOUNDARY') return AT.UNI_NON_BOUNDARY;
  }
  return AT[at];
}

function compileBranch(program: Program, branches: SubPattern[], flags: number): void {
  const { code } = program;
  code.push(OP.BRANCH);
  const tails: (() => void)[] = [];
  for (const branch of branches) {
    const setSkip = emitSkip(code);
    compileItems(program, branch.data, flags);
    code.push(OP.JUMP);
    tails.push(emitSkip(code));
    setSkip();
  }
  code.push(OP.FAILURE);
  for (const setTail of tails) setTail();
}

function compileGroupRefExists(program: Program, item: Extract<Item, { op: 'GROUPREF_EXISTS' }>, flags: number): void {
  const { code } = program;
  code.push(OP.GROUPREF_EXISTS, item.group - 1);
  const setYes = emitSkip(code, 1);
  compileItems(program, item.yes.data, flags);
  if (item.no) {
    code.push(OP.JUMP);
    const setNo = emitSkip(code);
    setYes();
    compileItems(program, item.no.data, flags);
    setNo();
  } else setYes();
}

export { MAXREPEAT };
