// The info block of CPython's `re._compiler._compile_info`, which `re.DEBUG` shows at the start of the code.
import { FLAG } from './constants';
import { type CodeSetItem, combineFlags, compileCharset, MAXCODE, op, optimizeCharset, skipFrom } from './debugCode';
import type { Item, SetItem, SubPattern } from './parser';
import { asciiIsCased, unicodeIsCased } from './unicodeData';

const SRE_INFO_PREFIX = 1;
const SRE_INFO_LITERAL = 2;
const SRE_INFO_CHARSET = 4;

/** `_compile_info`: the widths and the literal prefix or the set of first characters that searching uses. */
// code-gauge-allow functionCognitiveComplexity 26 -- Transcribes re._compiler._compile_info.
// code-gauge-allow functionNcss 38 -- Transcribes re._compiler._compile_info.
export function compileInfo(code: number[], pattern: SubPattern, flags: number): void {
  const [lo, hiWidth] = pattern.getwidth();
  const hi = hiWidth > BigInt(MAXCODE) ? MAXCODE : Number(hiWidth);
  if (lo === 0n) {
    code.push(op('INFO'), 4, 0, 0, hi);
    return;
  }
  let prefix: number[] = [];
  let prefixSkip: number | undefined;
  let gotAll = false;
  let charset: CodeSetItem[] | undefined;
  if (!(flags & FLAG.IGNORECASE && flags & FLAG.LOCALE)) {
    ({ prefix, prefixSkip, gotAll } = literalPrefix(pattern.data, flags));
    if (prefix.length === 0) {
      const set = charsetPrefix(pattern, flags);
      if (set && set.length > 0) {
        const [optimized] = optimizeCharset(set);
        charset = optimized.length === 1 && optimized[0].op === 'NEGATE' ? undefined : optimized;
      }
    }
  }
  code.push(op('INFO'));
  const setSkip = skipFrom(code);
  let mask = 0;
  if (prefix.length > 0)
    mask = prefixSkip === undefined && gotAll ? SRE_INFO_PREFIX | SRE_INFO_LITERAL : SRE_INFO_PREFIX;
  else if (charset && charset.length > 0) mask = SRE_INFO_CHARSET;
  code.push(mask);
  if (lo < BigInt(MAXCODE)) code.push(Number(lo));
  else {
    code.push(MAXCODE);
    prefix = prefix.slice(0, MAXCODE);
  }
  code.push(hi);
  if (prefix.length > 0) {
    code.push(prefix.length, prefixSkip ?? prefix.length, ...prefix, ...overlapTable(prefix));
  } else if (charset && charset.length > 0) compileCharset(code, charset, flags);
  setSkip();
}

function casedFor(flags: number): ((code: number) => boolean) | undefined {
  if (!(flags & FLAG.IGNORECASE)) return undefined;
  return flags & FLAG.UNICODE ? unicodeIsCased : asciiIsCased;
}

/** `_get_literal_prefix`. */
// code-gauge-allow functionCognitiveComplexity 23 -- Transcribes re._compiler._get_literal_prefix.
function literalPrefix(items: Item[], flags: number): { prefix: number[]; prefixSkip?: number; gotAll: boolean } {
  const prefix: number[] = [];
  let prefixSkip: number | undefined;
  const cased = casedFor(flags);
  for (const item of items) {
    if (item.op === 'LITERAL') {
      if (cased?.(item.code)) return { prefix, prefixSkip, gotAll: false };
      prefix.push(item.code);
    } else if (item.op === 'SUBPATTERN') {
      const inner = combineFlags(flags, item.addFlags, item.delFlags);
      if (inner & FLAG.IGNORECASE && inner & FLAG.LOCALE) return { prefix, prefixSkip, gotAll: false };
      const nested = literalPrefix(item.pattern.data, inner);
      if (prefixSkip === undefined) {
        if (item.group !== undefined) prefixSkip = prefix.length;
        else if (nested.prefixSkip !== undefined) prefixSkip = prefix.length + nested.prefixSkip;
      }
      prefix.push(...nested.prefix);
      if (!nested.gotAll) return { prefix, prefixSkip, gotAll: false };
    } else return { prefix, prefixSkip, gotAll: false };
  }
  return { prefix, prefixSkip, gotAll: true };
}

/** `_get_charset_prefix`. */
// code-gauge-allow functionCognitiveComplexity 22 -- Transcribes re._compiler._get_charset_prefix.
function charsetPrefix(pattern: SubPattern, patternFlags: number): SetItem[] | undefined {
  let flags = patternFlags;
  let items = pattern.data;
  while (items.length > 0 && items[0].op === 'SUBPATTERN') {
    const first = items[0];
    flags = combineFlags(flags, first.addFlags, first.delFlags);
    if (flags & FLAG.IGNORECASE && flags & FLAG.LOCALE) return undefined;
    items = first.pattern.data;
  }
  if (items.length === 0) return undefined;
  const cased = casedFor(flags);
  const [first] = items;
  if (first.op === 'LITERAL') return cased?.(first.code) ? undefined : [{ op: 'LITERAL', code: first.code }];
  if (first.op === 'BRANCH') {
    const set: SetItem[] = [];
    for (const branch of first.branches) {
      const head = branch.data[0];
      if (head?.op !== 'LITERAL' || cased?.(head.code)) return undefined;
      set.push({ op: 'LITERAL', code: head.code });
    }
    return set;
  }
  if (first.op !== 'IN') return undefined;
  return cased && first.set.some((item) => isCasedSetItem(item, cased)) ? undefined : first.set;
}

/** Whether a set member keeps a case-insensitive set out of the info block: a cased character or a wide range. */
function isCasedSetItem(item: SetItem, cased: (code: number) => boolean): boolean {
  if (item.op === 'LITERAL') return cased(item.code);
  if (item.op !== 'RANGE') return false;
  if (item.hi > 0xff_ff) return true;
  for (let code = item.lo; code <= item.hi; code++) if (cased(code)) return true;
  return false;
}

/** `_generate_overlap_table`. */
function overlapTable(prefix: number[]): number[] {
  const table = Array.from({ length: prefix.length }, () => 0);
  for (let index = 1; index < prefix.length; index++) {
    let idx = table[index - 1];
    for (;;) {
      if (prefix[index] === prefix[idx]) {
        table[index] = idx + 1;
        break;
      }
      if (idx === 0) {
        table[index] = 0;
        break;
      }
      idx = table[idx - 1];
    }
  }
  return table;
}
