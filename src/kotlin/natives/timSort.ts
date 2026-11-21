import type { Frame } from '../runtime';
import type { Value } from '../values';

type Compare = (a: Value, b: Value) => number;
interface Run {
  start: number;
  end: number;
}

const MIN_MERGE = 32;
const INITIAL_GALLOP = 7;

export function stableSort(frame: Frame, values: Value[], comparator: Compare, from: number, to: number): void {
  const compare: Compare = (a, b) => {
    frame.runtime.spend();
    return comparator(a, b);
  };
  new TimSort(frame, values, compare).sortValues(from, to);
}

class TimSort {
  private readonly runs: Run[] = [];
  private gallopThreshold = INITIAL_GALLOP;

  constructor(
    private readonly frame: Frame,
    private readonly values: Value[],
    private readonly compare: Compare
  ) {}

  sortValues(from: number, to: number): void {
    const minimum = minRun(to - from);
    for (let start = from; start < to;) {
      const naturalEnd = this.findRun(start, to);
      const end = Math.max(naturalEnd, Math.min(start + minimum, to));
      this.extendRun(start, naturalEnd, end);
      this.runs.push({ start, end });
      this.collapse(false);
      start = end;
    }
    this.collapse(true);
  }

  private findRun(start: number, limit: number): number {
    const { values, compare } = this;
    let end = start + 1;
    if (end === limit) return end;
    const descending = compare(values[end], values[start]) < 0;
    end++;
    while (end < limit && compare(values[end], values[end - 1]) < 0 === descending) end++;
    if (descending) {
      for (let left = start, right = end - 1; left < right; left++, right--) {
        this.frame.runtime.spend();
        [values[left], values[right]] = [values[right], values[left]];
      }
    }
    return end;
  }

  private extendRun(start: number, sortedEnd: number, end: number): void {
    const { values, compare } = this;
    for (let cursor = sortedEnd; cursor < end; cursor++) {
      const pivot = values[cursor];
      let low = start;
      let high = cursor;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (compare(pivot, values[middle]) < 0) high = middle;
        else low = middle + 1;
      }
      values.copyWithin(low + 1, low, cursor);
      values[low] = pivot;
    }
  }

  private collapse(finish: boolean): void {
    while (this.runs.length > 1) {
      const index = this.runs.length - 2;
      const left = this.runLength(index);
      const right = this.runLength(index + 1);
      const previous = this.runLength(index - 1);
      const earlier = this.runLength(index - 2);
      const unbalanced = previous !== 0 && (previous <= left + right || (earlier !== 0 && earlier <= previous + left));
      if (unbalanced || finish) this.merge(index - Number(previous !== 0 && previous < right));
      else if (left <= right) this.merge(index);
      else return;
    }
  }

  private runLength(index: number): number {
    const run = this.runs[index];
    return run ? run.end - run.start : 0;
  }

  private merge(index: number): void {
    const { values, compare } = this;
    const [left, right] = this.runs.splice(index, 2);
    this.runs.splice(index, 0, { start: left.start, end: right.end });
    const start = gallop(values, left, values[right.start], left.start, (a, b) => compare(a, b) >= 0);
    if (start === left.end) return;
    const end = gallop(values, right, values[left.end - 1], right.end - 1, (a, b) => compare(a, b) > 0);
    if (end === right.start) return;
    const forward = left.end - start <= end - right.start;
    const merge = new RunMerge(this.frame, values, { start, end: left.end }, { start: right.start, end }, forward);
    this.gallopThreshold = merge.run(compare, this.gallopThreshold);
  }
}

function minRun(size: number): number {
  let remainder = 0;
  while (size >= MIN_MERGE) {
    remainder |= size % 2;
    size = Math.floor(size / 2);
  }
  return size + remainder;
}

/** Finds the insertion point by probing 1, 3, 7, ... positions from the hint, then searching that interval. */
function gallop(
  values: Value[],
  { start, end }: Run,
  key: Value,
  hint: number,
  precedes: (key: Value, element: Value) => boolean
): number {
  const rightward = precedes(key, values[hint]);
  const step = rightward ? 1 : -1;
  const limit = rightward ? end - hint : hint - start + 1;
  let nearer = 0;
  let farther = 1;
  while (farther < limit && precedes(key, values[hint + step * farther]) === rightward) {
    nearer = farther;
    farther = farther * 2 + 1;
  }
  farther = Math.min(farther, limit);
  let low = rightward ? hint + nearer + 1 : hint - farther + 1;
  let high = rightward ? hint + farther : hint - nearer;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (precedes(key, values[middle])) low = middle + 1;
    else high = middle;
  }
  return low;
}

class RunMerge {
  private readonly left: MergeCursor;
  private readonly right: MergeCursor;
  private destination: number;

  constructor(
    private readonly frame: Frame,
    private readonly values: Value[],
    left: Run,
    right: Run,
    private readonly forward: boolean
  ) {
    this.left = new MergeCursor(values, left, forward, forward);
    this.right = new MergeCursor(values, right, forward, !forward);
    this.destination = forward ? left.start : right.end - 1;
  }

  run(compare: Compare, threshold: number): number {
    const buffer = (this.forward ? this.left : this.right).values;
    return this.frame.runtime.withNativeRoots([buffer], () => this.merge(compare, threshold));
  }

  private merge(compare: Compare, threshold: number): number {
    const last = this.forward ? this.left : this.right;
    const first = this.forward ? this.right : this.left;
    this.move(first, 1);
    if (last.length > 1 && first.length > 0) threshold = this.interleave(compare, last, first, threshold);
    if (last.length === 0) {
      this.frame.runtime.throwError(
        this.frame,
        'java.lang.IllegalArgumentException',
        'Comparison method violates its general contract!'
      );
    }
    if (last.length === 1) this.move(first, first.length);
    this.move(last, last.length);
    return threshold;
  }

  // The JVM alternates pairwise comparisons with batches and carries the adjusted threshold into the next merge.
  private interleave(compare: Compare, last: MergeCursor, first: MergeCursor, threshold: number): number {
    const { left, right } = this;
    let winner: MergeCursor | undefined;
    let streak = 0;
    while (last.length > 1 && first.length > 0) {
      const comparison = compare(right.value, left.value);
      const next = comparison < 0 === this.forward ? right : left;
      this.move(next, 1);
      streak = next === winner ? streak + 1 : 1;
      winner = next;
      if (streak < threshold || last.length <= 1 || first.length === 0) continue;
      threshold = this.gallopMerge(compare, last, first, threshold);
      winner = undefined;
      streak = 0;
    }
    return Math.max(1, threshold);
  }

  // code-gauge-allow functionCognitiveComplexity 16 -- both batches and their early exits preserve the JVM comparator order.
  private gallopMerge(compare: Compare, last: MergeCursor, first: MergeCursor, threshold: number): number {
    const { left, right } = this;
    while (true) {
      const countLeft = left.batch(right.value, (a, b) => compare(a, b) >= 0);
      this.move(left, countLeft);
      if (last.length <= 1 || first.length === 0) return threshold;
      this.move(right, 1);
      if (last.length <= 1 || first.length === 0) return threshold;
      const countRight = right.batch(left.value, (a, b) => compare(a, b) > 0);
      this.move(right, countRight);
      if (last.length <= 1 || first.length === 0) return threshold;
      this.move(left, 1);
      if (last.length <= 1 || first.length === 0) return threshold;
      threshold--;
      if (countLeft < INITIAL_GALLOP && countRight < INITIAL_GALLOP) return Math.max(0, threshold) + 2;
    }
  }

  private move(cursor: MergeCursor, count: number): void {
    const step = this.forward ? 1 : -1;
    for (let index = 0; index < count; index++) {
      this.frame.runtime.spend();
      this.values[this.destination] = cursor.take();
      this.destination += step;
    }
  }
}

class MergeCursor {
  readonly values: Value[];
  private low: number;
  private high: number;

  constructor(
    values: Value[],
    run: Run,
    private readonly forward: boolean,
    buffered: boolean
  ) {
    this.values = buffered ? values.slice(run.start, run.end) : values;
    this.low = buffered ? 0 : run.start;
    this.high = buffered ? this.values.length : run.end;
  }

  get length(): number {
    return this.high - this.low;
  }

  get value(): Value {
    return this.values[this.forward ? this.low : this.high - 1];
  }

  take(): Value {
    return this.values[this.forward ? this.low++ : --this.high];
  }

  batch(key: Value, precedes: (key: Value, element: Value) => boolean): number {
    const { low, high } = this;
    const boundary = gallop(this.values, { start: low, end: high }, key, this.forward ? low : high - 1, precedes);
    return this.forward ? boundary - low : high - boundary;
  }
}
