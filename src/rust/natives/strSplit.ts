// code-gauge-allow-file fileNcss 440 -- Ports std's searchers and splitters of `str` patterns.
import type { DebugPart } from '../debugText';
import { type DebugValue, described, fieldsPart, listPart, numberPart, tuplePart } from '../iterDebug';
import { CHAR, REF_STR } from '../types';
import { decodeUtf8 } from '../utf8';
import { DONE, IterValue, type Next } from '../values';

/**
 * `str::split` and its kin as `core::str` has them: the searchers of patterns (a `char`, a string by the two-way
 * algorithm, chars, or a predicate) and `SplitInternal`, which take the same steps, so that a predicate sees the same
 * calls and `{:?}` shows the same state as std's.
 */

const USIZE_MAX = 18_446_744_073_709_551_615n;
const encoder = new TextEncoder();

/** A searcher over a haystack's UTF-8 bytes: the next match from the front or the back, as byte offsets. */
interface Searcher {
  readonly text: string;
  readonly bytes: Uint8Array;
  nextMatch(): [number, number] | undefined;
  nextMatchBack(): [number, number] | undefined;
  debug(show: DebugValue): DebugPart;
}

/** What the pattern a `str` method takes is, by its type. */
export type PatternKind =
  | { kind: 'char'; char: string }
  | { kind: 'str'; needle: string }
  | { kind: 'chars'; chars: string[]; searcher: 'CharArraySearcher' | 'CharArrayRefSearcher' | 'CharSliceSearcher' }
  | PredicatePattern;

interface PredicatePattern {
  kind: 'predicate';
  matches: (char: string) => boolean;
  fork?: () => PredicatePattern;
}

export function searcherOf(text: string, pattern: PatternKind): Searcher {
  switch (pattern.kind) {
    case 'char': {
      return new CharSearcher(text, pattern.char);
    }
    case 'str': {
      return pattern.needle === '' ? new EmptyNeedleSearcher(text) : new TwoWaySearcher(text, pattern.needle);
    }
    case 'chars': {
      const { chars } = pattern;
      return new MultiCharEqSearcher(text, (char) => chars.includes(char), pattern.searcher, chars);
    }
    case 'predicate': {
      return new MultiCharEqSearcher(text, pattern.matches, 'CharPredicateSearcher', undefined, pattern.fork);
    }
  }
}

class CharSearcher implements Searcher {
  readonly bytes: Uint8Array;
  private finger = 0;
  private fingerBack: number;
  private readonly encoded: Uint8Array;

  constructor(
    readonly text: string,
    private readonly needle: string
  ) {
    this.bytes = encoder.encode(text);
    this.fingerBack = this.bytes.length;
    this.encoded = encoder.encode(needle);
  }

  /** Looks for the needle's last byte, then checks the bytes before it. */
  nextMatch(): [number, number] | undefined {
    const size = this.encoded.length;
    for (;;) {
      if (this.finger > this.fingerBack) return undefined;
      const index = this.bytes.subarray(this.finger, this.fingerBack).indexOf(this.encoded[size - 1]);
      if (index === -1) {
        this.finger = this.fingerBack;
        return undefined;
      }
      this.finger += index + 1;
      if (this.finger >= size && this.matchesAt(this.finger - size)) return [this.finger - size, this.finger];
    }
  }

  nextMatchBack(): [number, number] | undefined {
    const size = this.encoded.length;
    for (;;) {
      if (this.finger > this.fingerBack) return undefined;
      const index = this.bytes.subarray(this.finger, this.fingerBack).lastIndexOf(this.encoded[size - 1]);
      if (index === -1) {
        this.fingerBack = this.finger;
        return undefined;
      }
      const at = this.finger + index;
      if (at >= size - 1 && this.matchesAt(at - (size - 1))) {
        this.fingerBack = at - (size - 1);
        return [this.fingerBack, this.fingerBack + size];
      }
      this.fingerBack = at;
    }
  }

  private matchesAt(start: number): boolean {
    return this.encoded.every((byte, offset) => this.bytes[start + offset] === byte);
  }

  debug(show: DebugValue): DebugPart {
    const encoded = [...this.encoded, 0, 0, 0, 0].slice(0, 4);
    return fieldsPart('CharSearcher', [
      ['haystack', (indent) => show(this.text, REF_STR, indent)],
      ['finger', numberPart(this.finger)],
      ['finger_back', numberPart(this.fingerBack)],
      ['needle', (indent) => show(this.needle, CHAR, indent)],
      ['utf8_size', numberPart(this.encoded.length)],
      ['utf8_encoded', () => `[${encoded.join(', ')}]`],
    ]);
  }
}

/** Searches char by char, through `CharIndices`, for one that `matches` accepts. */
class MultiCharEqSearcher implements Searcher {
  readonly bytes: Uint8Array;
  private readonly chars: { offset: number; char: string; size: number }[] = [];
  private front = 0;
  private back: number;
  /** `CharIndices`'s `front_offset`, which only taking from the front advances. */
  private frontOffset = 0;

  constructor(
    readonly text: string,
    private readonly matches: (char: string) => boolean,
    private readonly name: string,
    private readonly charEq?: string[],
    private readonly forkPredicate?: () => PredicatePattern
  ) {
    this.bytes = encoder.encode(text);
    let offset = 0;
    for (const char of text) {
      const size = encoder.encode(char).length;
      this.chars.push({ offset, char, size });
      offset += size;
    }
    this.back = this.chars.length;
  }

  fork(): MultiCharEqSearcher {
    const copy = shallowState(this);
    const predicate = this.forkPredicate?.();
    return predicate ? Object.assign(copy, { matches: predicate.matches, forkPredicate: predicate.fork }) : copy;
  }

  nextMatch(): [number, number] | undefined {
    while (this.front < this.back) {
      const { offset, char, size } = this.chars[this.front++];
      this.frontOffset = offset + size;
      if (this.matches(char)) return [offset, offset + size];
    }
    return undefined;
  }

  nextMatchBack(): [number, number] | undefined {
    while (this.front < this.back) {
      const { offset, char, size } = this.chars[--this.back];
      if (this.matches(char)) return [offset, offset + size];
    }
    return undefined;
  }

  debug(show: DebugValue): DebugPart {
    const left = this.chars.slice(this.front, this.back).map(({ char }) => char);
    const charIndices = fieldsPart('CharIndices', [
      ['front_offset', numberPart(this.frontOffset)],
      ['iter', tuplePart('Chars', [listPart(left, CHAR, show)])],
    ]);
    const haystack: DebugPart = (indent) => show(this.text, REF_STR, indent);
    if (!this.charEq) {
      return fieldsPart(this.name, [
        ['haystack', haystack],
        ['char_indices', charIndices],
      ]);
    }
    const searcher = fieldsPart('MultiCharEqSearcher', [
      ['char_eq', listPart(this.charEq, CHAR, show)],
      ['haystack', haystack],
      ['char_indices', charIndices],
    ]);
    return tuplePart(this.name, [searcher]);
  }
}

/** The empty string, which matches at every char boundary, alternating with rejecting the char after it. */
class EmptyNeedleSearcher implements Searcher {
  readonly bytes: Uint8Array;
  private position = 0;
  private end: number;
  private isMatchFw = true;
  private isMatchBw = true;
  private isFinished = false;

  constructor(readonly text: string) {
    this.bytes = encoder.encode(text);
    this.end = this.bytes.length;
  }

  nextMatch(): [number, number] | undefined {
    for (;;) {
      if (this.isFinished) return undefined;
      const isMatch = this.isMatchFw;
      this.isMatchFw = !this.isMatchFw;
      const at = this.position;
      if (isMatch) return [at, at];
      const size = this.charSizeAt(at);
      if (size === 0) {
        this.isFinished = true;
        return undefined;
      }
      this.position += size;
    }
  }

  nextMatchBack(): [number, number] | undefined {
    for (;;) {
      if (this.isFinished) return undefined;
      const isMatch = this.isMatchBw;
      this.isMatchBw = !this.isMatchBw;
      const at = this.end;
      if (isMatch) return [at, at];
      if (at === 0) {
        this.isFinished = true;
        return undefined;
      }
      let start = at - 1;
      while (start > 0 && (this.bytes[start] & 0xc0) === 0x80) start--;
      this.end = start;
    }
  }

  private charSizeAt(at: number): number {
    if (at >= this.bytes.length) return 0;
    const byte = this.bytes[at];
    if (byte < 0x80) return 1;
    if (byte < 0xe0) return 2;
    return byte < 0xf0 ? 3 : 4;
  }

  debug(show: DebugValue): DebugPart {
    const empty = fieldsPart('EmptyNeedle', [
      ['position', numberPart(this.position)],
      ['end', numberPart(this.end)],
      ['is_match_fw', numberPart(this.isMatchFw)],
      ['is_match_bw', numberPart(this.isMatchBw)],
      ['is_finished', numberPart(this.isFinished)],
    ]);
    return strSearcherPart(this.text, '', tuplePart('Empty', [empty]), show);
  }
}

function strSearcherPart(text: string, needle: string, searcher: DebugPart, show: DebugValue): DebugPart {
  return fieldsPart('StrSearcher', [
    ['haystack', (indent) => show(text, REF_STR, indent)],
    ['needle', (indent) => show(needle, REF_STR, indent)],
    ['searcher', searcher],
  ]);
}

/** Crochemore and Perrin's two-way string matching, as std's `TwoWaySearcher` runs it from either end. */
class TwoWaySearcher implements Searcher {
  readonly bytes: Uint8Array;
  private readonly needleBytes: Uint8Array;
  private readonly critPos: number;
  private readonly critPosBack: number;
  private readonly period: number;
  private readonly byteset: bigint;
  private position = 0;
  private end: number;
  /** -1 for `usize::MAX`, which marks a long period. */
  private memory: number;
  private memoryBack: number;

  constructor(
    readonly text: string,
    private readonly needle: string
  ) {
    this.bytes = encoder.encode(text);
    const n = encoder.encode(needle);
    this.needleBytes = n;
    this.end = this.bytes.length;
    const [critFalse, periodFalse] = maximalSuffix(n, false);
    const [critTrue, periodTrue] = maximalSuffix(n, true);
    const [critPos, period] = critFalse > critTrue ? [critFalse, periodFalse] : [critTrue, periodTrue];
    this.critPos = critPos;
    const shortPeriod = n.subarray(0, critPos).every((byte, index) => byte === n[period + index]);
    if (shortPeriod) {
      this.critPosBack =
        n.length - Math.max(maximalSuffix(n, false, true, period)[0], maximalSuffix(n, true, true, period)[0]);
      this.period = period;
      this.byteset = bytesetOf(n.subarray(0, period));
      this.memory = 0;
      this.memoryBack = n.length;
    } else {
      this.critPosBack = critPos;
      this.period = Math.max(critPos, n.length - critPos) + 1;
      this.byteset = bytesetOf(n);
      this.memory = -1;
      this.memoryBack = -1;
    }
  }

  private contains(byte: number): boolean {
    return ((this.byteset >> BigInt(byte & 0x3f)) & 1n) !== 0n;
  }

  /** `TwoWaySearcher::next` as std runs it to find the next match. */
  // code-gauge-allow functionCognitiveComplexity 25 -- Follows std's `TwoWaySearcher::next` step by step.
  nextMatch(): [number, number] | undefined {
    const size = this.needleBytes.length;
    const longPeriod = this.memory === -1;
    for (;;) {
      const at = this.position;
      if (at + size - 1 >= this.bytes.length) {
        this.position = this.bytes.length;
        return undefined;
      }
      if (!this.contains(this.bytes[at + size - 1])) {
        this.position += size;
        if (!longPeriod) this.memory = 0;
        continue;
      }
      const right = this.mismatch(at, longPeriod ? this.critPos : Math.max(this.critPos, this.memory), size, false);
      if (right !== -1) {
        this.position += right - this.critPos + 1;
        if (!longPeriod) this.memory = 0;
        continue;
      }
      if (this.mismatch(at, longPeriod ? 0 : this.memory, this.critPos, true) !== -1) {
        this.position += this.period;
        if (!longPeriod) this.memory = size - this.period;
        continue;
      }
      this.position += size;
      if (!longPeriod) this.memory = 0;
      return [at, at + size];
    }
  }

  /** `TwoWaySearcher::next_back` as std runs it to find the previous match. */
  // code-gauge-allow functionCognitiveComplexity 25 -- Follows std's `TwoWaySearcher::next_back` step by step.
  nextMatchBack(): [number, number] | undefined {
    const size = this.needleBytes.length;
    const longPeriod = this.memory === -1;
    for (;;) {
      const at = this.end - size;
      if (at < 0) {
        this.end = 0;
        return undefined;
      }
      if (!this.contains(this.bytes[at])) {
        this.end -= size;
        if (!longPeriod) this.memoryBack = size;
        continue;
      }
      const crit = longPeriod ? this.critPosBack : Math.min(this.critPosBack, this.memoryBack);
      const left = this.mismatch(at, 0, crit, true);
      if (left !== -1) {
        this.end -= this.critPosBack - left;
        if (!longPeriod) this.memoryBack = size;
        continue;
      }
      if (this.mismatch(at, this.critPosBack, longPeriod ? size : this.memoryBack, false) !== -1) {
        this.end -= this.period;
        if (!longPeriod) this.memoryBack = this.period;
        continue;
      }
      this.end -= size;
      if (!longPeriod) this.memoryBack = size;
      return [at, at + size];
    }
  }

  /** The first (or, `fromEnd`, the last) needle index in `from..to` whose byte differs from the haystack's at `at`. */
  private mismatch(at: number, from: number, to: number, fromEnd: boolean): number {
    for (let step = 0; step < to - from; step++) {
      const i = fromEnd ? to - 1 - step : from + step;
      if (this.needleBytes[i] !== this.bytes[at + i]) return i;
    }
    return -1;
  }

  debug(show: DebugValue): DebugPart {
    const twoWay = fieldsPart('TwoWaySearcher', [
      ['crit_pos', numberPart(this.critPos)],
      ['crit_pos_back', numberPart(this.critPosBack)],
      ['period', numberPart(this.period)],
      ['byteset', numberPart(this.byteset)],
      ['position', numberPart(this.position)],
      ['end', numberPart(this.end)],
      ['memory', () => usizeText(this.memory)],
      ['memory_back', () => usizeText(this.memoryBack)],
    ]);
    return strSearcherPart(this.text, this.needle, tuplePart('TwoWay', [twoWay]), show);
  }
}

/** A `usize` field, of which -1 stands for `usize::MAX`. */
function usizeText(value: number): string {
  return value === -1 ? String(USIZE_MAX) : String(value);
}

function bytesetOf(bytes: Uint8Array): bigint {
  let set = 0n;
  for (const byte of bytes) set |= 1n << BigInt(byte & 0x3f);
  return set;
}

/**
 * The critical position and period of the maximal suffix by one order of bytes or the other, as std's
 * `maximal_suffix` finds them, or as `reverse_maximal_suffix` does over the reversed bytes, stopping at a known period.
 */
// code-gauge-allow functionCognitiveComplexity 16 -- Follows std's `maximal_suffix`.
function maximalSuffix(arr: Uint8Array, orderGreater: boolean, reverse = false, knownPeriod = 0): [number, number] {
  const n = arr.length;
  const byteAt = (i: number): number => (reverse ? arr[n - 1 - i] : arr[i]);
  let left = 0;
  let right = 1;
  let offset = 0;
  let period = 1;
  while (right + offset < n) {
    const a = byteAt(right + offset);
    const b = byteAt(left + offset);
    if ((a < b && !orderGreater) || (a > b && orderGreater)) {
      right += offset + 1;
      offset = 0;
      period = right - left;
    } else if (a === b) {
      if (offset + 1 === period) {
        right += offset + 1;
        offset = 0;
      } else offset++;
    } else {
      left = right;
      right++;
      offset = 0;
      period = 1;
    }
    if (period === knownPeriod) break;
  }
  return [left, period];
}

/** std's `SplitInternal`: the pieces between the matches, from either end. */
class SplitInternal {
  private start = 0;
  private end: number;
  private finished = false;

  constructor(
    private readonly matcher: Searcher,
    private allowTrailingEmpty: boolean
  ) {
    this.end = matcher.bytes.length;
  }

  fork(): SplitInternal {
    return Object.assign(shallowState(this), { matcher: forkSearcher(this.matcher) });
  }

  private piece(from: number, to: number): string {
    return decodeUtf8(this.matcher.bytes.subarray(from, to));
  }

  getEnd(): string | undefined {
    if (this.finished) return undefined;
    this.finished = true;
    return this.allowTrailingEmpty || this.end - this.start > 0 ? this.piece(this.start, this.end) : undefined;
  }

  next(inclusive = false): string | undefined {
    if (this.finished) return undefined;
    const found = this.matcher.nextMatch();
    if (!found) return this.getEnd();
    const piece = this.piece(this.start, inclusive ? found[1] : found[0]);
    this.start = found[1];
    return piece;
  }

  nextBack(inclusive = false): string | undefined {
    if (this.finished) return undefined;
    if (!this.allowTrailingEmpty) {
      this.allowTrailingEmpty = true;
      const last = this.nextBack(inclusive);
      if (last !== undefined && last !== '') return last;
      if (this.finished) return undefined;
    }
    const found = this.matcher.nextMatchBack();
    if (!found) {
      this.finished = true;
      return this.piece(this.start, this.end);
    }
    const piece = this.piece(found[1], this.end);
    this.end = inclusive ? found[1] : found[0];
    return piece;
  }

  debug(show: DebugValue): DebugPart {
    return fieldsPart('SplitInternal', [
      ['start', numberPart(this.start)],
      ['end', numberPart(this.end)],
      ['matcher', this.matcher.debug(show)],
      ['allow_trailing_empty', numberPart(this.allowTrailingEmpty)],
      ['finished', numberPart(this.finished)],
    ]);
  }
}

export type SplitKind = 'Split' | 'RSplit' | 'SplitTerminator' | 'SplitInclusive';

/** `split`, `rsplit`, `split_terminator`, and `split_inclusive` of a text by a pattern. */
export function splitIter(text: string, pattern: PatternKind, kind: SplitKind): IterValue {
  return splitFrom(new SplitInternal(searcherOf(text, pattern), kind === 'Split' || kind === 'RSplit'), kind);
}

function splitFrom(inner: SplitInternal, kind: SplitKind): IterValue {
  const inclusive = kind === 'SplitInclusive';
  const forward = (): Next => inner.next(inclusive) ?? DONE;
  const backward = (): Next => inner.nextBack(inclusive) ?? DONE;
  const iter = kind === 'RSplit' ? new IterValue(backward, forward) : new IterValue(forward, backward);
  iter.fork = () => splitFrom(inner.fork(), kind);
  return described(iter, (show) =>
    inclusive ? fieldsPart(kind, [['0', inner.debug(show)]]) : tuplePart(kind, [inner.debug(show)])
  );
}

/** `splitn` and `rsplitn`: at most `count` pieces, the last of them the rest of the text. */
export function splitNIter(text: string, pattern: PatternKind, count: number, reverse: boolean): IterValue {
  return splitNFrom(new SplitInternal(searcherOf(text, pattern), true), count, reverse);
}

function splitNFrom(inner: SplitInternal, count: number, reverse: boolean): IterValue {
  let left = count;
  const iter = new IterValue(() => {
    if (left === 0) return DONE;
    left--;
    return (left === 0 ? inner.getEnd() : reverse ? inner.nextBack() : inner.next()) ?? DONE;
  });
  iter.fork = () => splitNFrom(inner.fork(), left, reverse);
  return described(iter, (show) =>
    tuplePart(reverse ? 'RSplitN' : 'SplitN', [
      fieldsPart('SplitNInternal', [
        ['iter', inner.debug(show)],
        ['count', numberPart(left)],
      ]),
    ])
  );
}

/** `lines`: the pieces up to and including each `\n`, without it or a `\r\n`. */
export function linesIter(text: string): IterValue {
  return linesFrom(new SplitInternal(searcherOf(text, { kind: 'char', char: '\n' }), false));
}

function linesFrom(inner: SplitInternal): IterValue {
  const iter = new IterValue(
    () => lineOf(inner.next(true)),
    () => lineOf(inner.nextBack(true))
  );
  iter.fork = () => linesFrom(inner.fork());
  return described(iter, (show) =>
    tuplePart('Lines', [fieldsPart('Map', [['iter', fieldsPart('SplitInclusive', [['0', inner.debug(show)]])]])])
  );
}

/** A line without its `\n` or `\r\n`. */
function lineOf(line: string | undefined): Next {
  if (line === undefined) return DONE;
  if (line.endsWith('\r\n')) return line.slice(0, -2);
  return line.endsWith('\n') ? line.slice(0, -1) : line;
}

/** `split_whitespace`: the pieces between whitespace that are not empty. */
export function splitWhitespaceIter(text: string, isWhitespace: (char: string) => boolean): IterValue {
  return splitWhitespaceFrom(new SplitInternal(searcherOf(text, { kind: 'predicate', matches: isWhitespace }), true));
}

function splitWhitespaceFrom(inner: SplitInternal): IterValue {
  const take = (end: 'next' | 'nextBack'): Next => {
    for (;;) {
      const piece = end === 'next' ? inner.next() : inner.nextBack();
      if (piece === undefined) return DONE;
      if (piece !== '') return piece;
    }
  };
  const iter = new IterValue(
    () => take('next'),
    () => take('nextBack')
  );
  iter.fork = () => splitWhitespaceFrom(inner.fork());
  return described(iter, (show) =>
    fieldsPart('SplitWhitespace', [
      ['inner', fieldsPart('Filter', [['iter', tuplePart('Split', [inner.debug(show)])]])],
    ])
  );
}

function isAsciiSpace(byte: number): boolean {
  return [0x20, 0x09, 0x0a, 0x0c, 0x0d].includes(byte);
}

/** `split_ascii_whitespace`: a byte slice's `Split` at ASCII whitespace, without the empty pieces. */
export function splitAsciiWhitespaceIter(text: string): IterValue {
  return splitAsciiWhitespaceFrom(encoder.encode(text), false);
}

function splitAsciiWhitespaceFrom(bytes: Uint8Array, done: boolean): IterValue {
  let v = bytes;
  let finished = done;
  const take = (fromBack: boolean): Next => {
    while (!finished) {
      const piece = cut(fromBack);
      if (piece.length > 0) return decodeUtf8(piece);
    }
    return DONE;
  };
  const cut = (fromBack: boolean): Uint8Array => {
    const index = fromBack ? v.findLastIndex(isAsciiSpace) : v.findIndex(isAsciiSpace);
    if (index === -1) {
      finished = true;
      return v;
    }
    const piece = fromBack ? v.subarray(index + 1) : v.subarray(0, index);
    v = fromBack ? v.subarray(0, index) : v.subarray(index + 1);
    return piece;
  };
  const iter = new IterValue(
    () => take(false),
    () => take(true)
  );
  iter.fork = () => splitAsciiWhitespaceFrom(v, finished);
  return described(iter, () => {
    const split = fieldsPart('Split', [
      ['v', () => `[${[...v].join(', ')}]`],
      ['finished', numberPart(finished)],
    ]);
    return fieldsPart('SplitAsciiWhitespace', [
      ['inner', fieldsPart('Map', [['iter', fieldsPart('Filter', [['iter', split]])]])],
    ]);
  });
}

/** `matches` and `match_indices`: each match, with its byte offset for `match_indices`. */
export function matchesIter(text: string, pattern: PatternKind, indexed: boolean): IterValue {
  return matchesFrom(searcherOf(text, pattern), indexed);
}

function matchesFrom(searcher: Searcher, indexed: boolean): IterValue {
  const item = (found: [number, number] | undefined): Next => {
    if (!found) return DONE;
    const piece = decodeUtf8(searcher.bytes.subarray(found[0], found[1]));
    return indexed ? [BigInt(found[0]), piece] : piece;
  };
  const iter = new IterValue(
    () => item(searcher.nextMatch()),
    () => item(searcher.nextMatchBack())
  );
  iter.fork = () => matchesFrom(forkSearcher(searcher), indexed);
  const [outer, inner] = indexed ? ['MatchIndices', 'MatchIndicesInternal'] : ['Matches', 'MatchesInternal'];
  return described(iter, (show) => tuplePart(outer, [tuplePart(inner, [searcher.debug(show)])]));
}

function forkSearcher(searcher: Searcher): Searcher {
  return searcher instanceof MultiCharEqSearcher ? searcher.fork() : shallowState(searcher);
}

function shallowState<T extends object>(state: T): T {
  return Object.assign(Object.create(Object.getPrototypeOf(state)) as T, state);
}
