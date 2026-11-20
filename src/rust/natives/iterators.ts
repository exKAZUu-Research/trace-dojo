// code-gauge-allow-file fileNcss 800 -- One native per method of the standard library.
import { collectedVecCapacity, inPlaceCapacity, setVecCapacity, sizeTable } from '../capacity';
import type { DebugPart } from '../debugText';
import { normalize } from '../infer';
import { type DebugValue, described, fieldsPart, iteratorDebug, numberPart, optionPart } from '../iterDebug';
import { intoIterShape } from '../iterTypes';
import {
  allocateCollectionSnapshot,
  castValue,
  cloneIterator,
  cloneValue,
  compareValues,
  copyValue,
  needsCopy,
  testPartialOrder,
  valuesEqual,
  wrap,
} from '../ops';
import { MOVED } from '../runtime';
import { iteratorCapability } from '../traits';
import { shallow, type Type } from '../types';
import {
  CellPlace,
  DONE,
  ElementPlace,
  EnumValue,
  IterValue,
  MapValue,
  type Next,
  type RangeValue,
  SetValue,
  sliceBase,
  sliceItems,
  sliceLength,
  SliceView,
  swapOwnedElements,
  textOf,
  type Value,
} from '../values';
import { layoutOf, sizeOf } from './layout';
import { rangeIterator } from './rangeIterator';
import { lessByPartialOrd, sortSlice } from './sorting';
import { collectString } from './stringBuilder';
import { call, define, deref, libraryPanic, type NativeContext, none, option, placeOf, some } from './support';

/** An iterator over an array's elements from `start` to `end`, from both ends. */
export function arrayIter(
  array: Value[],
  start = 0,
  end = array.length,
  map: (index: number) => Value = (i) => array[i]
): IterValue {
  let front = start;
  let back = end;
  const iter = new IterValue(
    () => (front < back ? map(front++) : DONE),
    () => (front < back ? map(--back) : DONE),
    () => back - front,
    [array]
  );
  iter.rest = () => Array.from({ length: Math.max(back - front, 0) }, (_, offset) => map(front + offset));
  iter.frontIndex = () => front;
  iter.fork = () => arrayIter(array, front, back, map);
  return iter;
}

/**
 * An iterator that owns its elements (`into_iter`, `drain`, `for x in v`): it holds only those it has not yielded,
 * so each one it hands out belongs to its receiver alone and disappears when that receiver drops it.
 */
export function ownedIter(items: Value[], itemType: Type, project: (item: Value) => Value = (item) => item): IterValue {
  let front = 0;
  let back = items.length;
  const take = (index: number): Value => {
    const value = items[index];
    items[index] = MOVED;
    return project(value);
  };
  const iter = new IterValue(
    () => (front < back ? take(front++) : DONE),
    () => (front < back ? take(--back) : DONE),
    () => back - front,
    [items]
  );
  iter.rest = () => Array.from({ length: back - front }, (_, offset) => project(items[front + offset]));
  iter.ownedItemType = itemType;
  iter.fork = () => {
    allocateCollectionSnapshot(back - front);
    const cloned = Array.from({ length: back - front }, (_, offset) =>
      cloneValue(itemType, project(items[front + offset]))
    );
    return ownedIter(cloned, itemType);
  };
  return iter;
}

/** An iterator of a slice's elements; `places` yields places for `iter_mut`. */
export function sliceIter(slice: Value, places: boolean): IterValue {
  const { base, start } = sliceBase(slice);
  const length = sliceLength(slice);
  return arrayIter(base, start, start + length, places ? (i) => new ElementPlace(base, i) : (i) => base[i]);
}

/** The iterator `for` uses for a value of a type, as `IntoIterator` makes it. */
// code-gauge-allow functionCognitiveComplexity 21 -- One case per kind of iterable type.
export function toIterator(value: Value, from: Type): Value {
  const t = normalize(shallow(from));
  if (value instanceof IterValue) return value;
  if (t.kind === 'opaque' && t.opaque.hidden) return toIterator(value, t.opaque.hidden);
  if (t.kind === 'array') return ownedIter(sliceItems(value), t.elem);
  if (t.kind === 'ref') {
    const target = normalize(shallow(t.target));
    const v = t.mutable ? (deref(value) as Value) : value;
    if (target.kind === 'array' || target.kind === 'slice') return sliceIter(v, t.mutable);
    if (target.kind === 'adt') {
      const iter = collectionIter(target, v, t.mutable ? 'mut' : 'ref');
      if (iter) return iter;
    }
  }
  if (t.kind === 'adt') {
    const iter = collectionIter(t, value, 'value');
    if (iter) return iter;
  }
  throw new Error(`Cannot iterate ${t.kind}`);
}

/** The iterator of a standard collection, of its elements (`value`) or of references to them (`ref`, `mut`). */
// code-gauge-allow functionCognitiveComplexity 18 -- Each collection determines its yielded values and borrow mode.
function collectionIter(type: Type & { kind: 'adt' }, value: Value, mode: 'value' | 'ref' | 'mut'): Value | undefined {
  switch (type.def.builtin) {
    case 'Vec':
    case 'VecDeque':
    case 'BinaryHeap': {
      return mode === 'value' ? ownedIter(value as Value[], type.args[0]) : sliceIter(value, mode === 'mut');
    }
    case 'HashMap':
    case 'BTreeMap': {
      return mapIter(value as MapValue, mode, type.args);
    }
    case 'HashSet':
    case 'BTreeSet': {
      return setIter(value as SetValue, mode === 'value' ? type.args[0] : undefined);
    }
    case 'Range':
    case 'RangeInclusive':
    case 'RangeFrom': {
      return mode === 'value' ? rangeIterator(value as RangeValue, type.args[0]) : undefined;
    }
    case 'Option':
    case 'Result': {
      // `Some` and `Ok` hold the one element.
      const option = value as EnumValue;
      if (option.variant !== (type.def.builtin === 'Option' ? 1 : 0)) return arrayIter([]);
      const items = [mode === 'mut' ? new ElementPlace(option.fields, 0) : option.fields[0]];
      return mode === 'value' ? ownedIter(items, type.args[0]) : arrayIter(items);
    }
    case 'Iter': {
      return mode === 'value' ? undefined : value;
    }
    default: {
      return undefined;
    }
  }
}

/** A map's entries as tuples, in key order for a `BTreeMap`; `mut` yields places for the values. */
export function mapIter(map: MapValue, mode: 'value' | 'ref' | 'mut', types: Type[]): IterValue {
  const entries = map.entries.snapshot();
  if (mode === 'value') return ownedIter(entries, { kind: 'tuple', elems: types });
  const iter = arrayIter(entries, 0, entries.length, (i) => {
    const entry = entries[i];
    return mode === 'mut' ? [entry[0], new ElementPlace(entry, 1)] : [entry[0], entry[1]];
  });
  iter.roots.push(map);
  return iter;
}

export function setIter(set: SetValue, owned?: Type): IterValue {
  const values = set.entries.snapshot();
  if (owned) return ownedIter(values, owned);
  const iter = arrayIter(values);
  iter.roots.push(set);
  return iter;
}

function iterOf(value: Value): IterValue {
  return deref(value) as IterValue;
}

/** Takes the next element, honoring elements that `peek` looked at. */
export function nextOf(iter: IterValue): Next {
  if (iter.peeked && iter.peeked.length > 0) return iter.peeked.shift() as Next;
  return iter.next();
}

export function nextForFold(iter: IterValue): Next {
  if (iter.peeked?.length) return iter.peeked.shift() as Next;
  return (iter.foldNext ?? iter.next)();
}

function nthBack(ctx: NativeContext, iter: IterValue, n: bigint): Next {
  return nthItem(ctx, n, () => iter.nextBack!());
}

function nth(ctx: NativeContext, iter: IterValue, n: bigint): Next {
  return nthItem(ctx, n, () => nextOf(iter));
}

function nthItem(ctx: NativeContext, n: bigint, next: () => Next): Next {
  for (let index = 0n; index < n; index++) {
    ctx.runtime.spend();
    if (next() === DONE) return DONE;
  }
  return next();
}

/** The number of elements left, counting those `peek` looked at. */
export function lengthOf(iter: IterValue): bigint {
  return BigInt(iter.remaining?.() ?? 0) + BigInt(iter.peeked?.filter((item) => item !== DONE).length ?? 0);
}

function positiveLength(length: bigint): bigint {
  return length > 0n ? length : 0n;
}

function shorterLength(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/** Takes the elements left, up to and including one that `stop` picks. */
function collectAll(ctx: NativeContext, iter: IterValue, stop?: (item: Value) => boolean, fold = false): Value[] {
  const items: Value[] = [];
  const source = fold ? foldingView(iter) : iter;
  for (;;) {
    ctx.runtime.spend();
    const item = nextOf(source);
    if (item === DONE) return items;
    items.push(item);
    if (stop?.(item)) return items;
    if (items.length > 1_000_000) ctx.runtime.allocate(items.length);
  }
}

/** The operations of an adapter over its source, which `fork` builds again over a copy of the source. */
interface AdapterParts {
  next: () => Next;
  nextBack?: () => Next;
  remaining?: () => number | bigint;
}

class IteratorCallback {
  constructor(
    readonly value: Value,
    private readonly type: Type
  ) {}

  clone(): IteratorCallback {
    return new IteratorCallback(cloneValue(this.type, this.value), this.type);
  }
}

/**
 * An adapter of a source iterator whose own state (`state`, copied for clones) and the source decide its elements;
 * `forkState` copies state that holds iterators.
 */
function adapter<S extends object>(
  source: IterValue,
  state: S,
  parts: (source: IterValue, state: S) => AdapterParts,
  forkState: (state: S) => S = forkAdapterState,
  folds = false
): IterValue {
  const { next, nextBack, remaining } = parts(source, state);
  const iter = new IterValue(next, nextBack, remaining, [source, state]);
  iter.stateRoots = () =>
    Object.values(state).map((value: unknown) => (value instanceof IteratorCallback ? value.value : value));
  // An adapter whose `fold` folds its source (`Map`, `Filter`, ...) takes its source's elements as it folds.
  if (folds && source.foldNext) iter.foldNext = parts(foldingView(source), state).next;
  iter.fork = () => adapter(cloneIterator(source), forkState(state), parts, forkState, folds);
  return iter;
}

function forkAdapterState<S extends object>(state: S): S {
  if ('callback' in state && state.callback instanceof IteratorCallback) {
    return { ...state, callback: state.callback.clone() };
  }
  return { ...state };
}

/** The iterator as a fold takes it: its pushed-back elements, then its `foldNext`. */
function foldingView(iter: IterValue): IterValue {
  return new IterValue(
    () => nextForFold(iter),
    iter.nextBack,
    () => lengthOf(iter)
  );
}

/** An adapter that maps each element, from either end. */
function mapped(
  source: IterValue,
  map: (item: Value, callback: Value) => Next,
  callback?: IteratorCallback
): IterValue {
  return adapter(
    source,
    { callback },
    (src, state) => {
      const take = (item: Next): Next => (item === DONE ? DONE : map(item, state.callback?.value));
      return {
        next: () => take(nextOf(src)),
        nextBack: src.nextBack && (() => take(src.nextBack!())),
        remaining: src.remaining,
      };
    },
    undefined,
    true
  );
}

/** An adapter that finds the next element `pick` keeps (mapped), from either end. */
function picked(
  ctx: NativeContext,
  source: IterValue,
  callback: IteratorCallback,
  pick: (item: Value, callback: Value) => Next
): IterValue {
  const find = (take: () => Next, f: Value): Next => {
    for (;;) {
      ctx.runtime.spend();
      const item = take();
      if (item === DONE) return DONE;
      const result = pick(item, f);
      if (result !== DONE) return result;
    }
  };
  return adapter(
    source,
    { callback },
    (src, state) => ({
      next: () => find(() => nextOf(src), state.callback.value),
      nextBack: src.nextBack && (() => find(src.nextBack!, state.callback.value)),
    }),
    undefined,
    true
  );
}

function takeWhile(ctx: NativeContext, source: IterValue, callback: IteratorCallback): IterValue {
  return adapter(source, { callback, done: false }, (src, state) => ({
    next: () => {
      if (state.done) return DONE;
      const item = nextOf(src);
      if (item === DONE) return DONE;
      if (truthy(call(ctx, state.callback.value, [item]))) return item;
      state.done = true;
      return DONE;
    },
  }));
}

function truthy(value: Value): boolean {
  return deref(value) as boolean;
}

function optionValue(value: Value): Next {
  const result = deref(value) as EnumValue;
  return result.variant === 1 ? result.fields[0] : DONE;
}

/**
 * Flattens an iterator of iterables as `flat_map` and `flatten` do: an inner iterator for the front and one for the
 * back, which each end falls back on once the outer iterator runs out.
 */
// code-gauge-allow functionCognitiveComplexity 23 -- Walks the inner iterators from either end, as `FlattenCompat` does.
function flattened(
  ctx: NativeContext,
  source: IterValue,
  inner: (item: Value, callback: Value) => IterValue,
  callback?: IteratorCallback
): IterValue {
  return adapter<FlattenState>(
    source,
    { front: undefined, back: undefined, outerDone: false, callback },
    (src, state) => {
      const take = (end: End): Next => {
        for (;;) {
          ctx.runtime.spend();
          const item = takeInner(state, end);
          if (item !== DONE) return item;
          // The outer iterator is fused: once it runs out, `flatten` no longer asks it.
          const next = state.outerDone ? DONE : fromEnd(src, end);
          if (next === DONE) {
            state.outerDone = true;
            return takeInner(state, end === 'front' ? 'back' : 'front');
          }
          state[end] = inner(next, state.callback?.value);
        }
      };
      return { next: () => take('front'), nextBack: src.nextBack && (() => take('back')) };
    },
    (state) => ({
      front: state.front && cloneIterator(state.front),
      back: state.back && cloneIterator(state.back),
      outerDone: state.outerDone,
      callback: state.callback?.clone(),
    })
  );
}

type End = 'front' | 'back';

/** The inner iterators of a flattening adapter, at its front and its back. */
interface FlattenState {
  front: IterValue | undefined;
  back: IterValue | undefined;
  outerDone: boolean;
  callback: IteratorCallback | undefined;
}

function fromEnd(iter: IterValue, end: End): Next {
  return end === 'front' ? nextOf(iter) : iter.nextBack!();
}

/** Takes an element of the inner iterator at an end, dropping the iterator once it runs out. */
function takeInner(state: FlattenState, end: End): Next {
  const current = state[end];
  if (!current) return DONE;
  const item = fromEnd(current, end);
  if (item === DONE) state[end] = undefined;
  return item;
}

/** The iterator an element of `flatten` (or a result of `flat_map`'s function) makes, as `IntoIterator` does. */
function innerIter(ctx: NativeContext, value: Value, type: Type): IterValue {
  return toIterator(value, type) as IterValue;
}

define({
  'IterImpl<_, _>::next': ([self], ctx) => {
    const item = nextOf(iterOf(self));
    return option(ctx, item === DONE ? undefined : item, item !== DONE);
  },
  'IterImpl<_, _>::next_back': ([self], ctx) => {
    const item = iterOf(self).nextBack!();
    return option(ctx, item === DONE ? undefined : item, item !== DONE);
  },
  'IterImpl<_, _>::map': ([self, f], ctx) =>
    mapped(iterOf(self), (item, callback) => call(ctx, callback, [item]), new IteratorCallback(f, ctx.typeArgs[3])),
  'IterImpl<_, _>::filter': ([self, f], ctx) =>
    picked(ctx, iterOf(self), new IteratorCallback(f, ctx.typeArgs[2]), (item, callback) =>
      truthy(call(ctx, callback, [item])) ? item : DONE
    ),
  'IterImpl<_, _>::filter_map': ([self, f], ctx) =>
    adapterDebug(
      ctx,
      'FilterMap',
      picked(ctx, iterOf(self), new IteratorCallback(f, ctx.typeArgs[3]), (item, callback) =>
        optionValue(call(ctx, callback, [item]))
      )
    ),
  'IterImpl<_, _>::map_while': ([self, f], ctx) =>
    adapterDebug(
      ctx,
      'MapWhile',
      mapped(
        iterOf(self),
        (item, callback) => optionValue(call(ctx, callback, [item])),
        new IteratorCallback(f, ctx.typeArgs[3])
      )
    ),
  'IterImpl<_, _>::take_while': ([self, f], ctx) => {
    const iter = takeWhile(ctx, iterOf(self), new IteratorCallback(f, ctx.typeArgs[2]));
    return adapterDebug(ctx, 'TakeWhile', iter, (_show, target) => [
      ['flag', numberPart((target.roots[1] as { done: boolean }).done)],
    ]);
  },
  'IterImpl<_, _>::flat_map': ([self, f], ctx) => {
    const iter = flattened(
      ctx,
      iterOf(self),
      (item, callback) => innerIter(ctx, call(ctx, callback, [item]), ctx.typeArgs[2]),
      new IteratorCallback(f, ctx.typeArgs[3])
    );
    return flattenDebug(ctx, 'FlatMap', iter, ctx.typeArgs[2]);
  },
  'IterImpl<_, _>::flatten': ([self], ctx) => {
    const iter = flattened(ctx, iterOf(self), (item) => innerIter(ctx, item, ctx.typeArgs[0]));
    return flattenDebug(ctx, 'Flatten', iter, ctx.typeArgs[0]);
  },
  'IterImpl<_, _>::enumerate': ([self]) =>
    adapter(
      iterOf(self),
      { index: 0n },
      (src, state) => ({
        next: () => {
          const item = nextOf(src);
          return item === DONE ? DONE : [state.index++, item];
        },
        nextBack: () => {
          const total = state.index + lengthOf(src);
          const item = src.nextBack!();
          return item === DONE ? DONE : [total - 1n, item];
        },
        remaining: () => lengthOf(src),
      }),
      undefined,
      true
    ),
  'IterImpl<_, _>::zip': ([self, other], ctx) =>
    zipped(ctx, iterOf(self), iterOf(other), [ctx.typeArgs[1], ctx.typeArgs[3]], [ctx.typeArgs[0], ctx.typeArgs[2]]),
  'std::iter::zip': ([a, b], ctx) =>
    zipped(ctx, iterOf(a), iterOf(b), [ctx.typeArgs[2], ctx.typeArgs[3]], [ctx.typeArgs[0], ctx.typeArgs[1]]),
  'IterImpl<_, _>::chain': ([self, other]) =>
    adapter(
      iterOf(self),
      { second: iterOf(other), firstDone: false },
      (src, state) => ({
        next: () => {
          if (!state.firstDone) {
            const item = nextOf(src);
            if (item !== DONE) return item;
            state.firstDone = true;
          }
          return nextOf(state.second);
        },
        nextBack: () => {
          const item = state.second.nextBack!();
          return item === DONE ? src.nextBack!() : item;
        },
      }),
      (state) => ({ ...state, second: cloneIterator(state.second) })
    ),
  'IterImpl<_, _>::rev': ([self]) =>
    adapter(iterOf(self), {}, (src) => ({
      next: () => src.nextBack!(),
      nextBack: () => nextOf(src),
      remaining: src.remaining,
    })),
  'IterImpl<_, _>::take': ([self, n], ctx) =>
    adapter(iterOf(self), { left: n as bigint }, (src, state) => ({
      next: () => {
        if (state.left <= 0n) return DONE;
        state.left--;
        return nextOf(src);
      },
      // `Take::next_back` drops the elements past its count from the back first.
      nextBack: () => {
        if (state.left <= 0n) return DONE;
        const left = state.left--;
        return nthBack(ctx, src, positiveLength(lengthOf(src) - left));
      },
      remaining: () => shorterLength(state.left, lengthOf(src)),
    })),
  'IterImpl<_, _>::skip': ([self, n], ctx) =>
    adapter(iterOf(self), { toSkip: n as bigint }, (src, state) => ({
      next: () => {
        if (state.toSkip > 0n) {
          const skip = state.toSkip;
          state.toSkip = 0n;
          return nth(ctx, src, skip);
        }
        return nextOf(src);
      },
      nextBack: () => (lengthOf(src) > state.toSkip ? src.nextBack!() : DONE),
      remaining: () => positiveLength(lengthOf(src) - state.toSkip),
    })),
  'IterImpl<_, _>::skip_while': ([self, f], ctx) => {
    const state = { skipping: true, callback: new IteratorCallback(f, ctx.typeArgs[2]) };
    const iter = adapter(iterOf(self), state, (src, st) => ({
      next: () => {
        for (;;) {
          ctx.runtime.spend();
          const item = nextOf(src);
          if (item === DONE) return DONE;
          if (st.skipping && truthy(call(ctx, st.callback.value, [item]))) continue;
          st.skipping = false;
          return item;
        }
      },
    }));
    return adapterDebug(ctx, 'SkipWhile', iter, (_show, target) => [
      ['flag', numberPart(!(target.roots[1] as typeof state).skipping)],
    ]);
  },
  'IterImpl<_, _>::step_by': ([self, n], ctx) => {
    const step = n as bigint;
    if (step === 0n) libraryPanic(ctx, 'assertion failed: step != 0', 'core/src/iter/adapters/step_by.rs:36:9');
    return adapter(iterOf(self), { first: true, step }, (src, state) => ({
      next: () => {
        const skip = state.first ? 0n : step - 1n;
        state.first = false;
        return nth(ctx, src, skip);
      },
      // `StepBy::next_back_index`: the elements after the last one the steps reach are dropped from the back.
      nextBack: () => {
        const rem = lengthOf(src) % step;
        const index = state.first ? (rem === 0n ? step - 1n : rem - 1n) : rem;
        return nthBack(ctx, src, index);
      },
      remaining: () => {
        const length = lengthOf(src);
        return (length + (state.first ? step - 1n : 0n)) / step;
      },
    }));
  },
  'IterImpl<_, _>::peekable': ([self]) =>
    adapter(iterOf(self), {}, (src) => ({
      next: () => nextOf(src),
      nextBack: () => {
        // `Peekable::next_back` takes from the back of what it has not peeked, then the peeked element.
        const peeked = src.peeked;
        if (peeked && peeked.length > 0 && peeked[0] === DONE) return DONE;
        const item = src.nextBack!();
        if (item !== DONE || !peeked || peeked.length === 0) return item;
        return peeked.shift() as Next;
      },
      remaining: () => lengthOf(src),
    })),
  'IterImpl<_, _>::fuse': ([self]) =>
    adapter(iterOf(self), { done: false }, (src, state) => ({
      next: () => {
        if (state.done) return DONE;
        const item = nextOf(src);
        if (item === DONE) state.done = true;
        return item;
      },
      nextBack: () => {
        if (state.done) return DONE;
        const item = src.nextBack!();
        if (item === DONE) state.done = true;
        return item;
      },
      remaining: () => (state.done ? 0 : lengthOf(src)),
    })),
  // `&mut I` iterates as `I` does, so the adapters after `by_ref` advance the same iterator.
  'IterImpl<_, _>::by_ref': ([self]) => deref(self),
  'IterImpl<_, _>::into_iter': ([self]) => iterOf(self),
  'IterImpl<_, PeekableShape<_, _>>::peek': ([self], ctx) => {
    const iter = peekSource(self);
    iter.peekedType = ctx.typeArgs[0];
    iter.peeked ??= [];
    if (iter.peeked.length === 0) iter.peeked.push(iter.next());
    const item = iter.peeked[0];
    return option(ctx, item === DONE ? undefined : item, item !== DONE);
  },
  'IterImpl<_, PeekableShape<_, _>>::next_if': ([self, f], ctx) => {
    const iter = peekSource(self);
    const item = nextOf(iter);
    if (item === DONE) return none(ctx);
    if (truthy(call(ctx, f, [item]))) return some(ctx, item);
    iter.peekedType = ctx.typeArgs[0];
    iter.peeked ??= [];
    iter.peeked.unshift(item);
    return none(ctx);
  },
  'IterImpl<_, _>::inspect': ([self, f], ctx) =>
    adapterDebug(
      ctx,
      'Inspect',
      mapped(
        iterOf(self),
        (item, callback) => {
          call(ctx, callback, [item]);
          return item;
        },
        new IteratorCallback(f, ctx.typeArgs[2])
      )
    ),
  'IterImpl<_, _>::cycle': ([self], ctx) => {
    // `Cycle` keeps a clone of the iterator as it was, which it clones again to go round once more.
    const iter = adapter(
      iterOf(self),
      { original: cloneIterator(iterOf(self)), current: undefined as IterValue | undefined },
      (src, state) => ({
        next: () => {
          ctx.runtime.spend();
          const item = nextOf(state.current ?? src);
          if (item !== DONE) return item;
          state.current = cloneIterator(state.original);
          return nextOf(state.current);
        },
      }),
      (state) => ({
        original: cloneIterator(state.original),
        current: state.current && cloneIterator(state.current),
      })
    );
    // `Cycle` shows the iterator as it was and the one it takes from now.
    const [item, shape] = ctx.typeArgs;
    return described(iter, (show, _item, target) => {
      const state = target.roots[1] as { original: IterValue; current: IterValue | undefined };
      const current = state.current ?? (target.roots[0] as IterValue);
      const part =
        (from: IterValue): DebugPart =>
        (indent) =>
          iteratorDebug(from, item, shape, show, indent);
      return fieldsPart('Cycle', [
        ['orig', part(state.original)],
        ['iter', part(current)],
      ]);
    });
  },
  'IterImpl<_, _>::scan': ([self, initial, f], ctx) => {
    const state = { place: new CellPlace(initial), callback: new IteratorCallback(f, ctx.typeArgs[4]) };
    const iter = adapter(
      iterOf(self),
      state,
      (src, current) => ({
        next: () => {
          const item = nextOf(src);
          return item === DONE ? DONE : optionValue(call(ctx, current.callback.value, [current.place, item]));
        },
      }),
      (current) => ({
        place: new CellPlace(cloneValue(ctx.typeArgs[2], current.place.value)),
        callback: current.callback.clone(),
      })
    );
    return adapterDebug(ctx, 'Scan', iter, (show, target) => [
      ['state', (indent) => show((target.roots[1] as typeof state).place.value, ctx.typeArgs[2], indent)],
    ]);
  },
});

/**
 * Sets how `{:?}` writes an adapter of the iterator its method was called on (`T` and `S` of `IterImpl<T, S>`): its
 * name, the iterator it adapts as `iter`, then its own fields.
 */
function adapterDebug(
  ctx: NativeContext,
  name: string,
  iter: IterValue,
  fields: (show: DebugValue, target: IterValue) => [string, DebugPart][] = () => []
): IterValue {
  const [item, shape] = ctx.typeArgs;
  return described(iter, (show, _item, target) => {
    const source = target.roots[0] as IterValue;
    return fieldsPart(name, [
      ['iter', (indent) => iteratorDebug(source, item, shape, show, indent)],
      ...fields(show, target),
    ]);
  });
}

/**
 * `{:?}` of `Flatten` and `FlatMap`: their `FlattenCompat` of the fused outer iterator (in a `Map` for `FlatMap`) and
 * the inner iterators at the front and the back, of the iterables of type `inner`.
 */
function flattenDebug(ctx: NativeContext, name: string, iter: IterValue, inner: Type): IterValue {
  const [outerItem, outerShape] = ctx.typeArgs;
  const innerShape = intoIterShape(ctx.interp.program, inner) as Type;
  return described(iter, (show, item, target) => {
    const source = target.roots[0] as IterValue;
    const state = target.roots[1] as FlattenState;
    const outer: DebugPart = (indent) => iteratorDebug(source, outerItem, outerShape, show, indent);
    const fused = name === 'FlatMap' ? fieldsPart('Map', [['iter', outer]]) : outer;
    const innerPart = (from: IterValue | undefined): DebugPart =>
      optionPart(from && ((indent) => iteratorDebug(from, item, innerShape, show, indent)));
    const compat = fieldsPart('FlattenCompat', [
      ['iter', fieldsPart('Fuse', [['iter', optionPart(state.outerDone ? undefined : fused)]])],
      ['frontiter', innerPart(state.front)],
      ['backiter', innerPart(state.back)],
    ]);
    return fieldsPart(name, [['inner', compat]]);
  });
}

/** The iterator a `Peekable` wraps, which keeps the elements `peek` looked at. */
function peekSource(self: Value): IterValue {
  return iterOf(self).roots[0] as IterValue;
}

/**
 * Zips two iterators. From the back, it first drops the longer one's extra elements from its back, as `Zip`'s
 * `next_back` does. When both are `TrustedRandomAccess`, `next` stops at the shorter one's end without taking from the
 * longer one, as `Zip`'s specialization for them reads by index.
 */
// code-gauge-allow functionCognitiveComplexity 24 -- Follows `Zip`'s `next` and `next_back`.
function zipped(
  ctx: NativeContext,
  first: IterValue,
  second: IterValue,
  shapes: [Type, Type],
  items: [Type, Type]
): IterValue {
  const trusted = isTrustedRandomAccess(...shapes);
  const iter = adapter(first, { second }, (src, state) => ({
    next: () => {
      if (trusted && (lengthOf(src) === 0n || lengthOf(state.second) === 0n)) return DONE;
      const a = nextOf(src);
      if (a === DONE) return DONE;
      const b = nextOf(state.second);
      return b === DONE ? DONE : [a, b];
    },
    nextBack: () => {
      const lengthA = lengthOf(src);
      const lengthB = lengthOf(state.second);
      if (lengthA > lengthB) skipBack(ctx, src, lengthA - lengthB);
      else if (lengthB > lengthA) skipBack(ctx, state.second, lengthB - lengthA);
      const a = src.nextBack!();
      const b = state.second.nextBack!();
      return a === DONE || b === DONE ? DONE : [a, b];
    },
    remaining: () => shorterLength(lengthOf(src), lengthOf(state.second)),
  }));
  iter.fork = () => zipped(ctx, cloneIterator(first), cloneIterator(second), shapes, items);
  if (isTrustedLen(...shapes)) iter.foldNext = zipFoldNext(first, second);
  // `Zip` of two `TrustedRandomAccessNoCoerce` iterators shows nothing of them.
  const isCopy = (type: Type): boolean => ctx.interp.checker.solver.isCopy(type);
  const indexedFormat = trustedRandomAccess(shapes[0], first, isCopy) && trustedRandomAccess(shapes[1], second, isCopy);
  return described(iter, (show) => {
    if (indexedFormat) return () => 'Zip';
    const part =
      (from: IterValue, index: 0 | 1): DebugPart =>
      (indent) =>
        iteratorDebug(from, items[index], shapes[index], show, indent);
    return fieldsPart('Zip', [
      ['a', part(first, 0)],
      ['b', part(second, 1)],
    ]);
  });
}

function skipBack(ctx: NativeContext, iter: IterValue, count: bigint): void {
  for (let skipped = 0n; skipped < count; skipped++) {
    ctx.runtime.spend();
    iter.nextBack!();
  }
}

/** `Zip`'s `fold` of two `TrustedLen` iterators: as many pairs as its size hint, and no more from the longer. */
function zipFoldNext(first: IterValue, second: IterValue): () => Next {
  return () => {
    if (lengthOf(first) === 0n || lengthOf(second) === 0n) return DONE;
    const a = nextOf(first);
    const b = nextOf(second);
    return a === DONE || b === DONE ? DONE : [a, b];
  };
}

/** The shapes of the iterators that are `TrustedRandomAccess` themselves. */
const RANDOM_ACCESS_SHAPES = new Set([
  'SliceIterShape',
  'SliceIterMutShape',
  'WindowsShape',
  'ChunksShape',
  'RChunksShape',
  'ChunksExactShape',
  'BytesShape',
  'VecDequeIterShape',
  'VecDequeIterMutShape',
  'CaseMappingShape',
]);

/** The adapters that are `TrustedRandomAccess` when what they adapt is. */
const RANDOM_ACCESS_ADAPTERS = new Set([
  'MapShape',
  'EnumerateShape',
  'CopiedShape',
  'ClonedShape',
  'SkipShape',
  'FuseShape',
  'ZipShape',
]);

/** The shapes of the iterators that are `TrustedLen` themselves, whose size hint is exact. */
const TRUSTED_LEN_SHAPES = new Set([
  ...RANDOM_ACCESS_SHAPES,
  'RangeInclusiveShape',
  'VecIntoIterShape',
  'ArrayIntoIterShape',
  'VecDrainShape',
  'OptionIterShape',
  'VecDequeIntoIterShape',
  'BTreeMapIterShape',
  'BTreeMapIterMutShape',
  'BTreeMapKeysShape',
  'BTreeMapValuesShape',
  'BTreeMapValuesMutShape',
  'BTreeMapIntoIterShape',
  'BTreeMapIntoKeysShape',
  'BTreeMapIntoValuesShape',
  'BTreeSetIterShape',
  'BTreeSetIntoIterShape',
  'RepeatNShape',
  'OnceShape',
  'EmptyShape',
]);

/** The adapters that are `TrustedLen` when what they adapt is; `Skip` and `StepBy` when it is `TrustedRandomAccess`. */
const TRUSTED_LEN_ADAPTERS = new Set([
  'MapShape',
  'EnumerateShape',
  'CopiedShape',
  'ClonedShape',
  'FuseShape',
  'PeekableShape',
  'RevShape',
  'TakeShape',
  'ByRefShape',
  'ZipShape',
  'ChainShape',
]);

/** Whether iterators of these shapes are all `TrustedLen`, which `collect` and `extend` size exactly. */
// code-gauge-allow functionCognitiveComplexity 16 -- Follows std's `TrustedLen` impls case by case.
export function isTrustedLen(...shapes: Type[]): boolean {
  return shapes.every((shape) => {
    const t = normalize(shallow(shape));
    if (t.kind !== 'adt') return false;
    const { name } = t.def;
    if (name === 'RangeShape' || name === 'RangeInclusiveShape') {
      const idx = normalize(shallow(t.args[0]));
      return idx.kind === 'int' || idx.kind === 'char';
    }
    if (TRUSTED_LEN_SHAPES.has(name)) return true;
    if (name === 'SkipShape' || name === 'StepByShape') return isTrustedRandomAccess(t.args[0]);
    if (!TRUSTED_LEN_ADAPTERS.has(name)) return false;
    return isTrustedLen(...(name === 'ZipShape' || name === 'ChainShape' ? t.args : [t.args[0]]));
  });
}

/** Whether iterators of these shapes are all `TrustedRandomAccess`, as std implements it. */
function isTrustedRandomAccess(...shapes: Type[]): boolean {
  return shapes.every((shape) => trustedRandomAccess(shape));
}

function trustedRandomAccess(shape: Type, source?: IterValue, isCopy?: (type: Type) => boolean): boolean {
  const t = normalize(shallow(shape));
  if (t.kind !== 'adt') return false;
  const { name } = t.def;
  if (RANDOM_ACCESS_SHAPES.has(name)) return true;
  if (name === 'RangeShape') {
    const idx = normalize(shallow(t.args[0]));
    return idx.kind === 'int' && !idx.name.endsWith('128');
  }
  // Zip uses TrustedRandomAccessNoCoerce. The owned iterators implement it only for Copy items.
  if (name === 'VecIntoIterShape' || name === 'ArrayIntoIterShape') {
    return Boolean(source?.ownedItemType && isCopy?.(source.ownedItemType));
  }
  if (!RANDOM_ACCESS_ADAPTERS.has(name)) return false;
  const inner = source?.roots[0] as IterValue | undefined;
  if (!trustedRandomAccess(t.args[0], inner, isCopy)) return false;
  if (name !== 'ZipShape') return true;
  const other = (source?.roots[1] as { second: IterValue } | undefined)?.second;
  return trustedRandomAccess(t.args[1], other, isCopy);
}

/** Calls `f` on the elements in order until it returns a value, which it returns; undefined at the end. */
function each<T>(
  ctx: NativeContext,
  iter: IterValue,
  f: (item: Value, index: number) => T | undefined,
  direction: 'next' | 'fold' | 'back' = 'next'
): T | undefined {
  const source = direction === 'fold' ? foldingView(iter) : iter;
  for (let index = 0; ; index++) {
    ctx.runtime.spend();
    const item = direction === 'back' ? source.nextBack!() : nextOf(source);
    if (item === DONE) return undefined;
    const result = f(item, index);
    if (result !== undefined) return result;
  }
}

function foldItems(ctx: NativeContext, iter: IterValue, init: Value, fn: Value, direction: 'fold' | 'back'): Value {
  let acc = init;
  each(ctx, iter, (item) => void (acc = call(ctx, fn, [acc, item])), direction);
  return acc;
}

define({
  'IterImpl<_, _>::collect': ([self], ctx) => {
    // Collecting into a `Result` or an `Option` stops at the first `Err` or `None`, taking nothing after it.
    const target = normalize(shallow(ctx.typeArgs[2]));
    const builtin = target.kind === 'adt' ? target.def.builtin : undefined;
    const stopVariant = builtin === 'Result' ? 1 : builtin === 'Option' ? 0 : undefined;
    const stop =
      stopVariant === undefined ? undefined : (item: Value) => (deref(item) as EnumValue).variant === stopVariant;
    if (builtin === 'Vec') return collectVec(ctx, iterOf(self), ctx.typeArgs[1], ctx.typeArgs[0]);
    if (builtin === 'String') return collectString(ctx, iterOf(self), ctx.typeArgs[0], ctx.typeArgs[1]);
    return collectInto(ctx, collectAll(ctx, iterOf(self), stop, !stop), ctx.typeArgs[2], ctx.typeArgs[0]);
  },
  'IterImpl<_, _>::sum': ([self], ctx) => sumOrProduct(ctx, iterOf(self), ctx.typeArgs[2], '+'),
  'IterImpl<_, _>::product': ([self], ctx) => sumOrProduct(ctx, iterOf(self), ctx.typeArgs[2], '*'),
  'IterImpl<_, _>::count': ([self], ctx) => BigInt(collectAll(ctx, iterOf(self), undefined, true).length),
  'IterImpl<_, _>::len': ([self]) => lengthOf(iterOf(self)),
  'IterImpl<_, _>::last': ([self], ctx) => {
    const items = collectAll(ctx, iterOf(self), undefined, true);
    return option(ctx, items.at(-1), items.length > 0);
  },
  'IterImpl<_, _>::nth': ([self, n], ctx) => {
    const item = nth(ctx, iterOf(self), n as bigint);
    return option(ctx, item === DONE ? undefined : item, item !== DONE);
  },
  'IterImpl<_, _>::nth_back': ([self, n], ctx) => {
    const item = nthBack(ctx, iterOf(self), n as bigint);
    return option(ctx, item === DONE ? undefined : item, item !== DONE);
  },
  'IterImpl<_, _>::fold': ([self, init, f], ctx) => foldItems(ctx, iterOf(self), init, f, 'fold'),
  'IterImpl<_, _>::rfold': ([self, init, f], ctx) => foldItems(ctx, iterOf(self), init, f, 'back'),
  'IterImpl<_, _>::reduce': ([self, f], ctx) => {
    const iter = iterOf(self);
    const first = nextOf(iter);
    if (first === DONE) return none(ctx);
    let acc = first;
    each(ctx, iter, (item) => void (acc = call(ctx, f, [acc, item])), 'fold');
    return some(ctx, acc);
  },
  'IterImpl<_, _>::for_each': ([self, f], ctx) => {
    each(ctx, iterOf(self), (item) => void call(ctx, f, [item]), 'fold');
    return [];
  },
  'IterImpl<_, _>::any': ([self, f], ctx) =>
    each(ctx, iterOf(self), (item) => (truthy(call(ctx, f, [item])) ? true : undefined)) ?? false,
  'IterImpl<_, _>::all': ([self, f], ctx) =>
    each(ctx, iterOf(self), (item) => (truthy(call(ctx, f, [item])) ? undefined : false)) ?? true,
  'IterImpl<_, _>::find': ([self, f], ctx) =>
    each(ctx, iterOf(self), (item) => (truthy(call(ctx, f, [item])) ? some(ctx, item) : undefined)) ?? none(ctx),
  'IterImpl<_, _>::rfind': ([self, f], ctx) =>
    each(ctx, iterOf(self), (item) => (truthy(call(ctx, f, [item])) ? some(ctx, item) : undefined), 'back') ??
    none(ctx),
  'IterImpl<_, _>::find_map': ([self, f], ctx) =>
    each(ctx, iterOf(self), (item) => {
      const result = deref(call(ctx, f, [item])) as EnumValue;
      return result.variant === 1 ? result : undefined;
    }) ?? none(ctx),
  'IterImpl<_, _>::position': ([self, f], ctx) =>
    each(ctx, iterOf(self), (item, index) => (truthy(call(ctx, f, [item])) ? some(ctx, BigInt(index)) : undefined)) ??
    none(ctx),
  'IterImpl<_, _>::rposition': ([self, f], ctx) => {
    // `rposition` counts down from the length, taking the elements from the back.
    const iter = iterOf(self);
    let index = lengthOf(iter);
    for (;;) {
      ctx.runtime.spend();
      const item = iter.nextBack!();
      if (item === DONE) return none(ctx);
      index--;
      if (truthy(call(ctx, f, [item]))) return some(ctx, index);
    }
  },
  'IterImpl<_, _>::max': ([self], ctx) =>
    extreme(ctx, iterOf(self), (a, b) => compareValues(ctx.typeArgs[0], a, b) ?? 0, 1),
  'IterImpl<_, _>::min': ([self], ctx) =>
    extreme(ctx, iterOf(self), (a, b) => compareValues(ctx.typeArgs[0], a, b) ?? 0, -1),
  'IterImpl<_, _>::max_by_key': ([self, f], ctx) => extremeByKey(ctx, iterOf(self), f, ctx.typeArgs[2], 1),
  'IterImpl<_, _>::min_by_key': ([self, f], ctx) => extremeByKey(ctx, iterOf(self), f, ctx.typeArgs[2], -1),
  'IterImpl<_, _>::max_by': ([self, f], ctx) =>
    extreme(ctx, iterOf(self), (a, b) => (deref(call(ctx, f, [a, b])) as EnumValue).variant - 1, 1),
  'IterImpl<_, _>::min_by': ([self, f], ctx) =>
    extreme(ctx, iterOf(self), (a, b) => (deref(call(ctx, f, [a, b])) as EnumValue).variant - 1, -1),
  'IterImpl<_, _>::partition': ([self, f], ctx) => {
    const yes: Value[] = [];
    const no: Value[] = [];
    each(ctx, iterOf(self), (item) => void (truthy(call(ctx, f, [item])) ? yes : no).push(item));
    const type = ctx.typeArgs[2];
    return [collectInto(ctx, yes, type, ctx.typeArgs[0]), collectInto(ctx, no, type, ctx.typeArgs[0])];
  },
  'IterImpl<_, _>::eq': ([self, other], ctx) => {
    // `eq` stops at the first difference.
    const a = iterOf(self);
    const b = iterOf(other);
    for (;;) {
      ctx.runtime.spend();
      const x = nextOf(a);
      const y = nextOf(b);
      if (x === DONE || y === DONE) return x === y;
      if (!valuesEqual(ctx.typeArgs[0], x, y)) return false;
    }
  },
  'IterImpl<_, _>::is_sorted': ([self], ctx) => {
    // `is_sorted` stops at the first pair out of order.
    const iter = iterOf(self);
    let previous = nextOf(iter);
    if (previous === DONE) return true;
    return (
      each(ctx, iter, (item) => {
        const ordered = testPartialOrder('le', ctx.typeArgs[0], previous as Value, item);
        previous = item;
        return ordered ? undefined : false;
      }) ?? true
    );
  },
  'IterImpl<char, CharsShape>::as_str': ([self]) => {
    const iter = iterOf(self);
    const peeked = (iter.peeked ?? []).filter((next) => next !== DONE) as Value[];
    return [...peeked, ...(iter.rest?.() ?? [])].join('');
  },
  'IterImpl<&_, _>::copied': ([self]) => mapped(iterOf(self), (item) => copyValue(deref(item))),
  'IterImpl<&_, _>::cloned': ([self], ctx) => mapped(iterOf(self), (item) => cloneValue(ctx.typeArgs[0], deref(item))),
  'IterImpl<&mut _, _>::copied': ([self]) => mapped(iterOf(self), (item) => copyValue(deref(item))),
  'IterImpl<&mut _, _>::cloned': ([self], ctx) =>
    mapped(iterOf(self), (item) => cloneValue(ctx.typeArgs[0], deref(item))),
  'IterImpl<(_, _), _>::unzip': ([self], ctx) => {
    const items = collectAll(ctx, iterOf(self)) as Value[][];
    const [typeA, typeB, , fromA, fromB] = ctx.typeArgs;
    const firsts = items.map((item) => item[0]);
    const seconds = items.map((item) => item[1]);
    return [collectInto(ctx, firsts, fromA, typeA), collectInto(ctx, seconds, fromB, typeB)];
  },
  'std::iter::repeat': ([value], ctx) => repeated(ctx, value),
  'std::iter::repeat_n': ([value, n], ctx) => repeatN(ctx, value, n as bigint),
  'std::iter::once': ([value], ctx) => {
    const iter = ownedIter([value], ctx.typeArgs[0]);
    return described(iter, (show, item, target) => {
      const [left] = target.rest?.() ?? [];
      const opt = optionPart(left === undefined ? undefined : (indent) => show(left, item, indent));
      const intoIter = fieldsPart('IntoIter', [['inner', fieldsPart('Item', [['opt', opt]])]]);
      return fieldsPart('Once', [['inner', intoIter]]);
    });
  },
  'std::iter::empty': (_args, ctx) => described(ownedIter([], ctx.typeArgs[0]), () => () => 'Empty'),
  'std::iter::from_fn': ([f], ctx) => fromFunction(ctx, new IteratorCallback(f, ctx.typeArgs[1])),
  'std::iter::successors': ([first, f], ctx) =>
    successors(ctx, deref(first) as EnumValue, new IteratorCallback(f, ctx.typeArgs[1])),
});

function repeated(ctx: NativeContext, value: Value): IterValue {
  const type = ctx.typeArgs[0];
  const take = (): Next => cloneValue(type, value);
  const iter = new IterValue(take, take, undefined, [value]);
  iter.fork = () => repeated(ctx, cloneValue(type, value));
  return described(iter, (show, item) => fieldsPart('Repeat', [['element', (indent) => show(value, item, indent)]]));
}

function repeatN(ctx: NativeContext, value: Value, count: bigint): IterValue {
  const type = ctx.typeArgs[0];
  let left = count;
  let original = count > 0n ? value : undefined;
  const take = (): Next => {
    if (left === 0n) return DONE;
    if (--left > 0n) return cloneValue(type, original);
    const result = original;
    original = undefined;
    return result;
  };
  const iter = new IterValue(take, take, () => left);
  iter.stateRoots = () => [original];
  iter.fork = () => repeatN(ctx, left > 0n ? cloneValue(type, original) : undefined, left);
  return described(iter, (show, item) => {
    const element: DebugPart = (indent) => show(original, item, indent);
    return fieldsPart('RepeatN', [
      ['count', numberPart(left)],
      ['element', optionPart(left > 0n ? element : undefined)],
    ]);
  });
}

function fromFunction(ctx: NativeContext, callback: IteratorCallback): IterValue {
  const iter = new IterValue(() => optionValue(call(ctx, callback.value, [])), undefined, undefined, [callback.value]);
  iter.fork = () => fromFunction(ctx, callback.clone());
  return described(iter, () => () => 'FromFn');
}

function successors(ctx: NativeContext, start: EnumValue, callback: IteratorCallback): IterValue {
  const next = new CellPlace(start);
  const iter = new IterValue(
    () => {
      const current = next.value as EnumValue;
      if (current.variant === 0) return DONE;
      const value = current.fields[0];
      next.value = deref(call(ctx, callback.value, [value])) as EnumValue;
      return value;
    },
    undefined,
    undefined,
    [callback.value, next]
  );
  iter.fork = () => {
    const current = next.value as EnumValue;
    const cloned =
      current.variant === 0
        ? current
        : new EnumValue(current.def, current.variant, [cloneValue(ctx.typeArgs[0], current.fields[0])]);
    return successors(ctx, cloned, callback.clone());
  };
  return described(iter, (show, item) => {
    const current = next.value as EnumValue;
    const value = current.variant === 0 ? undefined : current.fields[0];
    return fieldsPart('Successors', [
      ['next', optionPart(value === undefined ? undefined : (indent) => show(value, item, indent))],
    ]);
  });
}

/**
 * `max_by` and `min_by`: `compare(the best so far, the next)` for each next element, as `cmp::max_by` and
 * `cmp::min_by` call it; `max` keeps the next on `Equal` and `min` keeps the best so far.
 */
function extreme(ctx: NativeContext, iter: IterValue, compare: (a: Value, b: Value) => number, sign: 1 | -1): Value {
  const first = nextOf(iter);
  if (first === DONE) return none(ctx);
  let best = first;
  const rest = foldingView(iter);
  for (;;) {
    ctx.runtime.spend();
    const item = nextOf(rest);
    if (item === DONE) return some(ctx, best);
    if (!keepsBest(compare(best, item), sign)) best = item;
  }
}

/** `max_by_key` and `min_by_key`: each key once, in order, compared as `extreme` compares the elements. */
function extremeByKey(ctx: NativeContext, iter: IterValue, f: Value, keyType: Type, sign: 1 | -1): Value {
  const first = nextOf(iter);
  if (first === DONE) return none(ctx);
  let best = first;
  let bestKey = call(ctx, f, [first]);
  const rest = foldingView(iter);
  for (;;) {
    ctx.runtime.spend();
    const item = nextOf(rest);
    if (item === DONE) return some(ctx, best);
    const key = call(ctx, f, [item]);
    if (!keepsBest(compareValues(keyType, bestKey, key) ?? 0, sign)) {
      best = item;
      bestKey = key;
    }
  }
}

function keepsBest(order: number, sign: 1 | -1): boolean {
  return sign === 1 ? order > 0 : order <= 0;
}

/**
 * The sum or product of `Result`s or `Option`s: of the values in `Ok` or `Some`, or the first `Err` or `None`, after
 * which it takes no more elements.
 */
function sumOfOutcomes(ctx: NativeContext, iter: IterValue, t: Type & { kind: 'adt' }, op: '+' | '*'): Value {
  const success = t.def.builtin === 'Result' ? 0 : 1;
  let failure: EnumValue | undefined;
  const source = foldingView(iter);
  const values = new IterValue(() => {
    if (failure) return DONE;
    const item = nextOf(source);
    if (item === DONE) return DONE;
    const outcome = deref(item) as EnumValue;
    if (outcome.variant !== success) {
      failure = outcome;
      return DONE;
    }
    return outcome.fields[0];
  });
  const total = sumOrProduct(ctx, values, t.args[0], op);
  return failure ?? new EnumValue(t.def, success, [total]);
}

function sumOrProduct(ctx: NativeContext, iter: IterValue, type: Type, op: '+' | '*'): Value {
  const t = normalize(shallow(type));
  if (t.kind === 'adt' && (t.def.builtin === 'Result' || t.def.builtin === 'Option')) {
    return sumOfOutcomes(ctx, iter, t, op);
  }
  let total: Value = op === '+' ? (t.kind === 'float' ? -0 : 0n) : t.kind === 'float' ? 1 : 1n;
  const source = foldingView(iter);
  for (;;) {
    ctx.runtime.spend();
    const item = nextOf(source);
    if (item === DONE) return total;
    total =
      t.kind === 'float'
        ? floatStep(t.name, op, total as number, deref(item) as number)
        : intStep(ctx, t, op, total as bigint, deref(item) as bigint);
  }
}

function floatStep(name: 'f32' | 'f64', op: '+' | '*', total: number, value: number): number {
  const result = op === '+' ? total + value : total * value;
  return name === 'f32' ? Math.fround(result) : result;
}

/** One step of an integer sum or product, which panics inside the library's `Sum` and `Product` impls on overflow. */
function intStep(ctx: NativeContext, type: Type, op: '+' | '*', total: bigint, value: bigint): bigint {
  const result = op === '+' ? total + value : total * value;
  if (result !== wrap((type as { name: 'i32' }).name, result)) {
    libraryPanic(
      ctx,
      `attempt to ${op === '+' ? 'add' : 'multiply'} with overflow`,
      'core/src/iter/traits/accum.rs:206:1'
    );
  }
  return result;
}

/**
 * `Vec::from_iter`: the elements, with the exact capacity a `TrustedLen` iterator's size hint gives, and otherwise
 * what growth by the size hint's lower bound gives, which is exact for an `ExactSizeIterator` and 0 for others.
 */
export function collectVec(ctx: NativeContext, iter: IterValue, shape: Type, elem: Type): Value[] {
  const exact = iteratorCapability(shape, 'exact') === 'yes' ? lengthOf(iter) : undefined;
  const source = inPlaceSource(iter, shape);
  // `Vec::from_iter` folds a `TrustedLen` iterator and calls `next` on others.
  const items = collectAll(ctx, iter, undefined, isTrustedLen(shape));
  ctx.runtime.allocate(items.length);
  const inPlace = source && inPlaceCapacity(source, layoutOf(elem));
  if (inPlace !== undefined) setVecCapacity(items, inPlace);
  else if (!isTrustedLen(shape)) {
    const lowerAfter = (taken: number): number => (exact === undefined ? 0 : Number(exact - BigInt(taken)));
    setVecCapacity(items, collectedVecCapacity(items.length, sizeOf(elem), lowerAfter));
  }
  return items;
}

/** The adapters through which `collect` reuses the buffer of a `Vec`'s `into_iter` (`InPlaceIterable`). */
const IN_PLACE_ADAPTERS = new Set([
  'MapShape',
  'FilterShape',
  'FilterMapShape',
  'EnumerateShape',
  'CopiedShape',
  'ClonedShape',
  'TakeShape',
  'SkipShape',
  'TakeWhileShape',
  'SkipWhileShape',
  'MapWhileShape',
  'InspectShape',
  'ScanShape',
  'ZipShape',
]);

/** The `into_iter` of a `Vec` under adapters that let `collect` reuse its buffer, if the iterator is one. */
function inPlaceSource(iter: IterValue, shape: Type): IterValue | undefined {
  let t = normalize(shallow(shape));
  let source: IterValue | undefined = iter;
  while (t.kind === 'adt' && IN_PLACE_ADAPTERS.has(t.def.name)) {
    t = normalize(shallow(t.args[0]));
    source = source?.roots[0] instanceof IterValue ? source.roots[0] : undefined;
  }
  return t.kind === 'adt' && t.def.name === 'VecIntoIterShape' ? source : undefined;
}

/** Collects elements into a collection of the type `collect` was asked for. */
// code-gauge-allow functionCognitiveComplexity 25 -- One native per method of the standard library.
// code-gauge-allow functionNcss 56 -- One case per collection type.
export function collectInto(ctx: NativeContext, items: Value[], target: Type, item: Type): Value {
  const t = normalize(shallow(target));
  if (t.kind !== 'adt') throw new Error('collect into a non-collection');
  ctx.runtime.allocate(items.length);
  switch (t.def.builtin) {
    case 'Vec':
    case 'VecDeque': {
      return items;
    }
    case 'Box': {
      // A `Box<str>` collects text, as `String` does; a `Box<[T]>` the elements.
      return shallow(t.args[0]).kind === 'str' ? items.map(textOf).join('') : items;
    }
    case 'BinaryHeap': {
      return heapify([...items], t.args[0]);
    }
    case 'String': {
      return collectString(ctx, arrayIter(items), item);
    }
    case 'BTreeMap': {
      return collectBTreeMap(ctx, items as [Value, Value][], t.args[0], item);
    }
    case 'HashMap': {
      const map = new MapValue(false);
      sizeTable(map.entries.table, sizeOf({ kind: 'tuple', elems: t.args }));
      for (const entry of items as Value[][]) {
        const hash = map.entries.key(t.args[0], entry[0]);
        const existing = map.entries.get(hash);
        if (existing) existing[1] = entry[1];
        else map.entries.set(hash, [entry[0], entry[1]]);
      }
      return map;
    }
    case 'BTreeSet': {
      return collectBTreeSet(ctx, items, t.args[0]);
    }
    case 'HashSet': {
      const set = new SetValue(false);
      sizeTable(set.entries.table, sizeOf(t.args[0]));
      for (const element of items) {
        const hash = set.entries.key(t.args[0], element);
        if (!set.entries.has(hash)) set.entries.set(hash, element);
      }
      return set;
    }
    case 'Result': {
      const values: Value[] = [];
      for (const element of items as EnumValue[]) {
        if (element.variant === 1) return element;
        values.push(element.fields[0]);
      }
      const inner = normalize(shallow(item)) as { args: Type[] };
      return new EnumValue(ctx.interp.program.adtDef('Result'), 0, [
        collectInto(ctx, values, t.args[0], inner.args[0]),
      ]);
    }
    case 'Option': {
      const values: Value[] = [];
      for (const element of items as EnumValue[]) {
        if (element.variant === 0) return element;
        values.push(element.fields[0]);
      }
      const inner = normalize(shallow(item)) as { args: Type[] };
      return some(ctx, collectInto(ctx, values, t.args[0], inner.args[0]));
    }
    default: {
      throw new Error(`collect into ${t.def.name}`);
    }
  }
}

function collectBTreeMap(ctx: NativeContext, pairs: [Value, Value][], key: Type, item: Type): MapValue {
  const map = new MapValue(true);
  sortSlice(ctx, pairs, true, (a, b) => (compareValues(key, (a as Value[])[0], (b as Value[])[0]) ?? 0) < 0, item);
  addLastOfEqualKeys(
    ctx,
    pairs,
    (entry) => entry[0],
    key,
    (entry) => map.entries.appendOrdered(entry)
  );
  return map;
}

function collectBTreeSet(ctx: NativeContext, items: Value[], elem: Type): SetValue {
  const set = new SetValue(true);
  sortSlice(ctx, items, true, lessByPartialOrd(elem), elem);
  addLastOfEqualKeys(
    ctx,
    items,
    (value) => value,
    elem,
    (value) => set.entries.appendOrdered(value)
  );
  return set;
}

function addLastOfEqualKeys<T extends Value>(
  ctx: NativeContext,
  items: T[],
  keyOf: (item: T) => Value,
  keyType: Type,
  add: (item: T) => void
): void {
  ctx.runtime.withRoots(items, () => {
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      if (index + 1 === items.length || !valuesEqual(keyType, keyOf(item), keyOf(items[index + 1]))) add(item);
    }
  });
}

/** Builds a max-heap from elements as `BinaryHeap::from(vec)` does: sifting down from the last parent to the root. */
export function heapify(heap: Value[], type: Type): Value[] {
  const end = heap.length;
  for (let index = Math.floor(end / 2) - 1; index >= 0; index--) siftDownRange(heap, index, end, type);
  return heap;
}

function siftDownRange(heap: Value[], start: number, end: number, type: Type): void {
  let hole = start;
  let child = 2 * hole + 1;
  while (child < end) {
    if (child + 1 < end && (compareValues(type, heap[child], heap[child + 1]) ?? 0) <= 0) child++;
    if ((compareValues(type, heap[hole], heap[child]) ?? 0) >= 0) return;
    swapOwnedElements(heap, hole, child);
    hole = child;
    child = 2 * hole + 1;
  }
}

export function heapPush(heap: Value[], value: Value, type: Type): void {
  heap.push(value);
  siftUp(heap, heap.length - 1, type);
}

export function heapPop(heap: Value[], type: Type): Value | undefined {
  if (heap.length === 0) return undefined;
  swapOwnedElements(heap, 0, heap.length - 1);
  const top = heap.pop();
  let hole = 0;
  let child = 1;
  while (child < heap.length) {
    if (child + 1 < heap.length && (compareValues(type, heap[child], heap[child + 1]) ?? 0) <= 0) child++;
    swapOwnedElements(heap, hole, child);
    hole = child;
    child = 2 * hole + 1;
  }
  siftUp(heap, hole, type);
  return top;
}

function siftUp(heap: Value[], start: number, type: Type): void {
  let index = start;
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if ((compareValues(type, heap[index], heap[parent]) ?? 0) <= 0) break;
    swapOwnedElements(heap, index, parent);
    index = parent;
  }
}

export { castValue, needsCopy, placeOf, SliceView };
