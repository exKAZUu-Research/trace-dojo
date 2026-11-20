import { normalize } from '../infer';
import { wrap } from '../ops';
import { RustPanic } from '../runtime';
import { shallow, type Type } from '../types';
import { DONE, IterValue, type Next, RangeValue, type Value } from '../values';

interface RangeElem {
  isChar: boolean;
  name: string;
}

/**
 * An iterator over a range that advances the range itself, as `Range`'s `Iterator` impl does: integers, or `char`s
 * (which skip the surrogates).
 */
export function rangeIterator(range: RangeValue, elem: Type): IterValue {
  const t = normalize(shallow(elem));
  const kind: RangeElem = { isChar: t.kind === 'char', name: t.kind === 'int' ? t.name : 'i32' };
  const iter = new IterValue(
    () => rangeNext(range, kind),
    () => rangeNextBack(range, kind),
    () => rangeRemaining(range, kind),
    [range]
  );
  iter.fork = () => rangeIterator(new RangeValue(range.start, range.end, range.inclusive, range.exhausted), elem);
  return iter;
}

function rangeNext(range: RangeValue, kind: RangeElem): Next {
  if (range.exhausted) return DONE;
  const start = toNumber(kind, range.start);
  if (range.end === undefined) return rangeFromNext(range, kind, start);
  const end = toNumber(kind, range.end);
  if (range.inclusive) {
    if (start > end) return DONE;
    if (start === end) {
      range.exhausted = true;
      return fromNumber(kind, start);
    }
  } else if (start >= end) {
    return DONE;
  }
  range.start = fromNumber(kind, step(kind, start, 1n));
  return fromNumber(kind, start);
}

function rangeFromNext(range: RangeValue, kind: RangeElem, start: bigint): Next {
  if (
    !kind.isChar &&
    start === wrap(kind.name as never, start) &&
    start + 1n !== wrap(kind.name as never, start + 1n)
  ) {
    throw new RustPanic('attempt to add with overflow', { row: 0, col: 0 }, 'core/src/iter/range.rs:548:1');
  }
  range.start = fromNumber(kind, step(kind, start, 1n));
  return fromNumber(kind, start);
}

function rangeNextBack(range: RangeValue, kind: RangeElem): Next {
  if (range.exhausted || range.end === undefined) return DONE;
  const start = toNumber(kind, range.start);
  const end = toNumber(kind, range.end);
  if (range.inclusive) {
    if (start > end) return DONE;
    if (start === end) {
      range.exhausted = true;
      return fromNumber(kind, end);
    }
    range.end = fromNumber(kind, step(kind, end, -1n));
    return fromNumber(kind, end);
  }
  if (start >= end) return DONE;
  const last = step(kind, end, -1n);
  range.end = fromNumber(kind, last);
  return fromNumber(kind, last);
}

function rangeRemaining(range: RangeValue, kind: RangeElem): number {
  if (range.exhausted || range.end === undefined) return 0;
  const count = Number(toNumber(kind, range.end) - toNumber(kind, range.start)) + (range.inclusive ? 1 : 0);
  return Math.max(0, count);
}

function toNumber(kind: RangeElem, value: Value): bigint {
  return kind.isChar ? BigInt((value as string).codePointAt(0)!) : (value as bigint);
}

function fromNumber(kind: RangeElem, value: bigint): Value {
  return kind.isChar ? String.fromCodePoint(Number(value)) : value;
}

function step(kind: RangeElem, value: bigint, delta: bigint): bigint {
  let next = value + delta;
  if (kind.isChar && next >= 0xd8_00n && next <= 0xdf_ffn) next = delta > 0n ? 0xe0_00n : 0xd7_ffn;
  return next;
}
