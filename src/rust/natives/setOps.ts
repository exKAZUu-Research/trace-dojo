import type { DebugPart } from '../debugText';
import { type DebugValue, described, fieldsPart, listPart, optionPart, tuplePart } from '../iterDebug';
import { compareValues, spendCollectionWork } from '../ops';
import type { Type } from '../types';
import { DONE, IterValue, type Next, type SetValue, type Value } from '../values';

/**
 * The iterators of `BTreeSet`'s `union`, `intersection`, `difference`, and `symmetric_difference`, which take the
 * steps std's do (`MergeIterInner`, and `Stitch`, `Search`, or `Answer` chosen by the sets' ends and sizes), so that
 * `{:?}` shows the state std's shows and a printing `Ord` sees the same comparisons.
 */

export type SetOp = 'union' | 'intersection' | 'difference' | 'symmetric_difference';

export function* hashSetMembers(op: SetOp, left: SetValue, right: SetValue, type: Type): IterableIterator<Value> {
  const a = left.entries;
  const b = right.entries;
  spendCollectionWork(a.size);
  for (const value of a.values()) {
    if (op === 'union' || b.has(b.key(type, value)) === (op === 'intersection')) yield value;
  }
  if (op === 'union' || op === 'symmetric_difference') {
    spendCollectionWork(b.size);
    for (const value of b.values()) if (!a.has(a.key(type, value))) yield value;
  }
}

const ITER_PERFORMANCE_TIPPING_SIZE_DIFF = 16;

/** A `btree_set::Iter`: the elements left between its front and its back. */
class SortedIter {
  constructor(
    private readonly items: Value[],
    private front = 0,
    private back = items.length
  ) {}

  next(): Next {
    return this.front < this.back ? this.items[this.front++] : DONE;
  }

  nextBack(): Next {
    return this.front < this.back ? this.items[--this.back] : DONE;
  }

  fork(): SortedIter {
    return new SortedIter(this.items, this.front, this.back);
  }

  get rest(): Value[] {
    return this.items.slice(this.front, this.back);
  }
}

interface Context {
  /** The order of two elements, by their type's `Ord`. */
  cmp: (a: Value, b: Value) => number;
  contains: (set: SetValue, value: Value) => boolean;
  /** The type of the sets, which `Search` shows. */
  setType: Type;
}

/** An iterator of `op` on two `BTreeSet`s, given their elements in order. */
export function btreeSetOp(op: SetOp, sets: [SetValue, SetValue], elem: Type, setType: Type): IterValue {
  const items: [Value[], Value[]] = [sets[0].entries.snapshot(), sets[1].entries.snapshot()];
  const context: Context = {
    cmp: orderOf(elem),
    contains: (set, value) => set.entries.has(set.entries.key(elem, value)),
    setType,
  };
  const step =
    op === 'union' || op === 'symmetric_difference'
      ? merged(op, new SortedIter(items[0]), new SortedIter(items[1]), context.cmp)
      : searched(op, sets, items, context);
  return setOpIter(op, step);
}

function setOpIter(op: SetOp, step: Step): IterValue {
  const iter = new IterValue(step.next);
  iter.fork = () => setOpIter(op, step.fork());
  return described(iter, (show, item) => tuplePart(TUPLE_NAMES[op], [step.debug(show, item)]));
}

const TUPLE_NAMES: Record<SetOp, string> = {
  union: 'Union',
  intersection: 'Intersection',
  difference: 'Difference',
  symmetric_difference: 'SymmetricDifference',
};

interface Step {
  next: () => Next;
  debug: (show: DebugValue, item: Type) => DebugPart;
  fork: () => Step;
}

function iterPart(iter: SortedIter, show: DebugValue, item: Type): DebugPart {
  return tuplePart('Iter', [listPart(iter.rest, item, show)]);
}

/** `MergeIterInner`: both sets in order, keeping the greater of two heads (`peeked`) for the next step. */
// code-gauge-allow functionCognitiveComplexity 22 -- Follows std's `MergeIterInner::nexts`.
// code-gauge-allow functionNcss 34 -- Follows std's `MergeIterInner::nexts`.
function merged(
  op: SetOp,
  a: SortedIter,
  b: SortedIter,
  cmp: Context['cmp'],
  peeked?: { side: 'A' | 'B'; value: Value }
): Step {
  const nexts = (): [Next, Next] => {
    let aNext: Next;
    let bNext: Next;
    if (peeked?.side === 'A') [aNext, bNext] = [peeked.value, b.next()];
    else if (peeked?.side === 'B') [aNext, bNext] = [a.next(), peeked.value];
    else [aNext, bNext] = [a.next(), b.next()];
    peeked = undefined;
    if (aNext !== DONE && bNext !== DONE) {
      const order = cmp(aNext, bNext);
      if (order < 0) {
        peeked = { side: 'B', value: bNext };
        bNext = DONE;
      } else if (order > 0) {
        peeked = { side: 'A', value: aNext };
        aNext = DONE;
      }
    }
    return [aNext, bNext];
  };
  const next = (): Next => {
    for (;;) {
      const [aNext, bNext] = nexts();
      // `symmetric_difference` skips the elements both sets have.
      if (op === 'union' || aNext === DONE || bNext === DONE) return aNext === DONE ? bNext : aNext;
    }
  };
  const debug = (show: DebugValue, item: Type): DebugPart => {
    const peekedPart = optionPart(peeked && tuplePart(peeked.side, [(indent) => show(peeked!.value, item, indent)]));
    return tuplePart('MergeIterInner', [iterPart(a, show, item), iterPart(b, show, item), peekedPart]);
  };
  return { next, debug, fork: () => merged(op, a.fork(), b.fork(), cmp, peeked) };
}

/** `intersection` and `difference`: by their sets' ends, an answer at once, or a search, or a stitch of both. */
// code-gauge-allow functionCognitiveComplexity 20 -- Follows std's choices for `intersection` and `difference`.
function searched(
  op: SetOp,
  [aSet, bSet]: [SetValue, SetValue],
  [aItems, bItems]: [Value[], Value[]],
  context: Context
): Step {
  const { cmp } = context;
  const self = new SortedIter(aItems);
  if (aItems.length === 0 || bItems.length === 0) return op === 'intersection' ? answer(undefined) : iterate(self);
  const low = cmp(aItems[0], bItems.at(-1));
  const high = cmp(aItems.at(-1), bItems[0]);
  if (low > 0 || high < 0) return op === 'intersection' ? answer(undefined) : iterate(self);
  if (low === 0) {
    if (op === 'intersection') return answer(aItems[0]);
    self.next();
    return iterate(self);
  }
  if (high === 0) {
    if (op === 'intersection') return answer(aItems.at(-1));
    self.nextBack();
    return iterate(self);
  }
  const aSmall = aItems.length <= Math.floor(bItems.length / ITER_PERFORMANCE_TIPPING_SIZE_DIFF);
  const bSmall = bItems.length <= Math.floor(aItems.length / ITER_PERFORMANCE_TIPPING_SIZE_DIFF);
  if (op === 'difference') {
    return aSmall
      ? search(self, bSet, false, context, ['self_iter', 'other_iter'])
      : stitchDifference(self, new SortedIter(bItems), cmp);
  }
  if (aSmall) return search(self, bSet, true, context, ['small_iter', 'large_set']);
  if (bSmall) return search(new SortedIter(bItems), aSet, true, context, ['small_iter', 'large_set']);
  return stitchIntersection(self, new SortedIter(bItems), cmp);
}

function answer(value: Value | undefined): Step {
  let left = value;
  return {
    next: () => {
      const result = left;
      left = undefined;
      return result ?? DONE;
    },
    debug: (show, item) => tuplePart('Answer', [optionPart(valuePart(left, item, show))]),
    fork: () => answer(left),
  };
}

function iterate(iter: SortedIter): Step {
  return {
    next: () => iter.next(),
    debug: (show, item) => tuplePart('Iterate', [iterPart(iter, show, item)]),
    fork: () => iterate(iter.fork()),
  };
}

/** Each element of the small set that the large one has (`intersection`), or does not have (`difference`). */
function search(
  small: SortedIter,
  large: SetValue,
  wanted: boolean,
  context: Context,
  [iterName, setName]: [string, string]
): Step {
  const { contains, setType } = context;
  return {
    next: () => {
      for (;;) {
        const value = small.next();
        if (value === DONE || contains(large, value) === wanted) return value;
      }
    },
    debug: (show, item) =>
      fieldsPart('Search', [
        [iterName, iterPart(small, show, item)],
        [setName, (indent) => show(large, setType, indent)],
      ]),
    fork: () => search(small.fork(), large, wanted, context, [iterName, setName]),
  };
}

// code-gauge-allow functionCognitiveComplexity 17 -- Follows std's `Intersection::next`.
function stitchIntersection(a: SortedIter, b: SortedIter, cmp: Context['cmp']): Step {
  return {
    next: () => {
      let aNext = a.next();
      if (aNext === DONE) return DONE;
      let bNext = b.next();
      if (bNext === DONE) return DONE;
      for (;;) {
        const order = cmp(aNext, bNext);
        if (order === 0) return aNext;
        if (order < 0) aNext = a.next();
        else bNext = b.next();
        if (aNext === DONE || bNext === DONE) return DONE;
      }
    },
    debug: (show, item) =>
      fieldsPart('Stitch', [
        ['a', iterPart(a, show, item)],
        ['b', iterPart(b, show, item)],
      ]),
    fork: () => stitchIntersection(a.fork(), b.fork(), cmp),
  };
}

/** `difference` of similar sets: the elements of `self` that `other`, walked alongside with `peek`, does not have. */
// code-gauge-allow functionCognitiveComplexity 24 -- Follows std's `Difference::next`.
function stitchDifference(self: SortedIter, other: SortedIter, cmp: Context['cmp'], peeked?: Next): Step {
  const peek = (): Next => (peeked ??= other.next());
  const advance = (): void => void (peeked === undefined ? other.next() : (peeked = undefined));
  return {
    next: () => {
      let selfNext = self.next();
      if (selfNext === DONE) return DONE;
      for (;;) {
        const otherNext = peek();
        const order = otherNext === DONE ? -1 : cmp(selfNext, otherNext);
        if (order < 0) return selfNext;
        if (order === 0) {
          selfNext = self.next();
          if (selfNext === DONE) return DONE;
        }
        advance();
      }
    },
    debug: (show, item) => {
      const peekedPart = optionPart(
        peeked === undefined
          ? undefined
          : optionPart(peeked === DONE ? undefined : (indent) => show(peeked as Value, item, indent))
      );
      return fieldsPart('Stitch', [
        ['self_iter', iterPart(self, show, item)],
        [
          'other_iter',
          fieldsPart('Peekable', [
            ['iter', iterPart(other, show, item)],
            ['peeked', peekedPart],
          ]),
        ],
      ]);
    },
    fork: () => stitchDifference(self.fork(), other.fork(), cmp, peeked),
  };
}

/** A value of a type, if there is one. */
function valuePart(value: Value | undefined, item: Type, show: DebugValue): DebugPart | undefined {
  if (value === undefined) return undefined;
  return (indent) => show(value, item, indent);
}

/** The order of two elements of a type, by its `Ord`. */
function orderOf(type: Type): Context['cmp'] {
  return (a, b) => compareValues(type, a, b) ?? 0;
}
