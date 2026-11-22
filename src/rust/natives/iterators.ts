// code-gauge-allow-file fileNcss 989 -- One native per method of the standard library.
import { inPlaceCapacity, reserveVec, setVecCapacity, sizeTable, type TableMap, vecCapacity } from '../capacity';
import type { DebugPart } from '../debugText';
import { floatNumber } from '../floatBits';
import { normalize } from '../infer';
import { type DebugValue, described, fieldsPart, iteratorDebug, numberPart, optionPart } from '../iterDebug';
import { intoIterItem, intoIterShape } from '../iterTypes';
import {
  allocateCollectionSnapshot,
  castValue,
  cloneIterator,
  cloneValue,
  comparePartialValues,
  compareValues,
  copyValue,
  needsCopy,
  testPartialOrder,
  valuesEqual,
  valuesUnequal,
  withCloneResults,
  wrap,
} from '../ops';
import { MOVED } from '../runtime';
import { iteratorCapability } from '../traits';
import { canReachTurtle } from '../turtleTypes';
import { intMax, sameType, shallow, type Type } from '../types';
import {
  CellPlace,
  DONE,
  DynValue,
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
import { checkTableCapacity, checkVecCapacity } from './capacityNatives';
import { defaultValue } from './core';
import { dequeIterator } from './dequeHead';
import { layoutOf, sizeOf } from './layout';
import { outcomeIter } from './options';
import { rangeIterator } from './rangeIterator';
import { lessByPartialOrd, sortSlice } from './sorting';
import { collectString } from './stringBuilder';
import {
  call,
  define,
  deref,
  libraryPanic,
  type NativeContext,
  NATIVES,
  none,
  option,
  ordering,
  placeOf,
  some,
} from './support';

/** An iterator over an array's elements from `start` to `end`, from both ends. */
export function arrayIter(
  array: Value[],
  start = 0,
  end = array.length,
  map: (index: number) => Value = (i) => array[i],
  storageType?: Type
): IterValue {
  let front = start;
  let back = end;
  const iter = new IterValue(
    () => (front < back ? map(front++) : DONE),
    () => (front < back ? map(--back) : DONE),
    () => back - front
  );
  if (!storageType || canReachTurtle(storageType)) iter.borrowedRoots.push(array);
  iter.rest = () => Array.from({ length: Math.max(back - front, 0) }, (_, offset) => map(front + offset));
  iter.frontIndex = () => front;
  iter.fork = () => {
    const copy = arrayIter(array, front, back, map, storageType);
    // A copy keeps alive what the original does, such as the collection a lazy range reads.
    for (const root of iter.borrowedRoots) if (!copy.borrowedRoots.includes(root)) copy.borrowedRoots.push(root);
    return copy;
  };
  return iter;
}

/**
 * An iterator that owns its elements (`into_iter`, `drain`, `for x in v`): it holds only those it has not yielded,
 * so each one it hands out belongs to its receiver alone and disappears when that receiver drops it.
 */
export function ownedIter(
  items: Value[],
  itemType: Type,
  projection?: { map: (item: Value) => Value; storageType: Type }
): IterValue {
  const map = projection?.map ?? ((item: Value) => item);
  let front = 0;
  let back = items.length;
  const take = (index: number): Value => {
    const value = items[index];
    items[index] = MOVED;
    return map(value);
  };
  const iter = new IterValue(
    () => (front < back ? take(front++) : DONE),
    () => (front < back ? take(--back) : DONE),
    () => back - front,
    canReachTurtle(projection?.storageType ?? itemType) ? [items] : []
  );
  iter.rest = () => Array.from({ length: back - front }, (_, offset) => map(items[front + offset]));
  iter.ownedItemType = itemType;
  iter.fork = () => {
    allocateCollectionSnapshot(back - front);
    const cloned = withCloneResults(() =>
      Array.from({ length: back - front }, (_, offset) => cloneValue(itemType, map(items[front + offset])))
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
// code-gauge-allow functionCognitiveComplexity 22 -- One case per kind of iterable type.
export function toIterator(value: Value, from: Type): Value {
  const t = normalize(shallow(from));
  if (value instanceof IterValue) return value;
  const dynamic = deref(value);
  if (dynamic instanceof DynValue) return toIterator(deref(dynamic.value), dynamic.type);
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
function collectionIter(type: Type & { kind: 'adt' }, value: Value, mode: 'value' | 'ref' | 'mut'): Value | undefined {
  switch (type.def.builtin) {
    case 'Vec':
    case 'BinaryHeap': {
      return mode === 'value' ? ownedIter(value as Value[], type.args[0]) : sliceIter(value, mode === 'mut');
    }
    case 'VecDeque': {
      return dequeIterator(value as Value[], type.args[0], mode);
    }
    case 'HashMap':
    case 'BTreeMap': {
      return mapIter(value as MapValue, mode, type.args);
    }
    case 'HashSet':
    case 'BTreeSet': {
      return setIter(value as SetValue, type.args[0], mode === 'value');
    }
    case 'Range':
    case 'RangeInclusive':
    case 'RangeFrom': {
      return mode === 'value' ? rangeIterator(value as RangeValue, type.args[0]) : undefined;
    }
    case 'Option':
    case 'Result': {
      return outcomeIter(value as EnumValue, mode, type.args[0]);
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
  const item: Type = { kind: 'tuple', elems: types };
  if (mode === 'value') return ownedIter(entries, item);
  return snapshotIter(entries, item, (entry) => [entry[0], mode === 'mut' ? new ElementPlace(entry, 1) : entry[1]]);
}

export function snapshotIter<T extends Value>(
  items: T[],
  storageType: Type,
  read: (item: T) => Value = (item) => item
): IterValue {
  return arrayIter(items, 0, items.length, (index) => read(items[index]), storageType);
}

export function setIter(set: SetValue, item: Type, owned = false): IterValue {
  const values = set.entries.snapshot();
  return owned ? ownedIter(values, item) : snapshotIter(values, item);
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

export function extendedValue(target: Type, item: Type): (value: Value) => Value {
  const source = normalize(shallow(item));
  return source.kind === 'ref' && sameType(source.target, target) && needsCopy(target) ? copyValue : (value) => value;
}

function nthBack(ctx: NativeContext, iter: IterValue, n: bigint): Next {
  return iter.nthBack ? iter.nthBack(n) : nthItem(ctx, n, () => iter.nextBack!());
}

function nth(ctx: NativeContext, iter: IterValue, n: bigint): Next {
  if (iter.nth && !iter.peeked?.length) return iter.nth(n);
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

export function iteratorLowerBound(iter: IterValue, shape?: Type): bigint {
  if (iter.sizeHintLower) return shorterLength(iter.sizeHintLower(), intMax('usize'));
  if (!shape || iteratorCapability(shape, 'exact') === 'yes') return lengthOf(iter);
  const t = normalize(shallow(shape));
  if (t.kind !== 'adt') return 0n;
  return shorterLength(lowerBoundOfShape(iter, t), intMax('usize'));
}

function lowerBoundOfShape(iter: IterValue, shape: Extract<Type, { kind: 'adt' }>): bigint {
  const { name } = shape.def;
  if (name === 'RangeShape' || name === 'RangeInclusiveShape') return lengthOf(iter);
  if (name === 'RangeFromShape' || name === 'RepeatShape' || name === 'RepeatWithShape') return intMax('usize');
  if (name === 'CharsShape' || name === 'CharIndicesShape') {
    const bytes = iter.remainingTextBytes?.() ?? 0;
    return BigInt(Math.ceil(bytes / 4)) + BigInt(iter.peeked?.filter((item) => item !== DONE).length ?? 0);
  }
  const source = iter.roots[0];
  if (!(source instanceof IterValue) || (!PRESERVES_LOWER_BOUND.has(name) && !SIZED_ADAPTERS.has(name))) return 0n;
  const first = iteratorLowerBound(source, shape.args[0]);
  return adapterLowerBound(iter, name, first, shape.args[1]);
}

const PRESERVES_LOWER_BOUND = new Set([
  'MapShape',
  'InspectShape',
  'RevShape',
  'EnumerateShape',
  'CopiedShape',
  'ClonedShape',
  'ByRefShape',
  'PeekableShape',
]);

const SIZED_ADAPTERS = new Set(['FuseShape', 'TakeShape', 'SkipShape', 'StepByShape', 'ChainShape', 'ZipShape']);

// code-gauge-allow functionCognitiveComplexity 20 -- The adapters make size-hint adjustments from their current state.
function adapterLowerBound(iter: IterValue, name: string, first: bigint, otherShape?: Type): bigint {
  if (PRESERVES_LOWER_BOUND.has(name)) return first;
  const state = iter.roots[1] as
    | {
        second?: IterValue;
        firstDone?: boolean;
        left?: bigint;
        toSkip?: bigint;
        done?: boolean;
        step?: bigint;
        first?: boolean;
      }
    | undefined;
  if (name === 'FuseShape') return state?.done ? 0n : first;
  if (name === 'TakeShape' && state?.left !== undefined) return shorterLength(first, state.left);
  if (name === 'SkipShape' && state?.toSkip !== undefined) return positiveLength(first - state.toSkip);
  if (name === 'StepByShape' && state?.step) return (first + (state.first ? state.step - 1n : 0n)) / state.step;
  if ((name === 'ChainShape' || name === 'ZipShape') && state?.second) {
    const second = iteratorLowerBound(state.second, otherShape);
    return name === 'ChainShape' ? (state.firstDone ? 0n : first) + second : shorterLength(first, second);
  }
  return 0n;
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
  return ctx.runtime.withRoots(items, () => {
    for (;;) {
      ctx.runtime.spend();
      const item = nextOf(source);
      if (item === DONE) return items;
      items.push(item);
      if (stop?.(item)) return items;
      if (items.length > 1_000_000) ctx.runtime.allocate(items.length);
    }
  });
}

/** The operations of an adapter over its source, which `fork` builds again over a copy of the source. */
interface AdapterParts {
  next: () => Next;
  nextBack?: () => Next;
  remaining?: () => number | bigint;
  sizeHintLower?: () => bigint;
  trustedSizeHint?: boolean;
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
  const { next, nextBack, remaining, sizeHintLower, trustedSizeHint } = parts(source, state);
  const iter = new IterValue(next, nextBack, remaining, [source, state]);
  iter.sizeHintLower = sizeHintLower;
  iter.trustedSizeHint = trustedSizeHint;
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
function flattened(
  ctx: NativeContext,
  source: IterValue,
  inner: (item: Value, callback: Value) => IterValue,
  innerType: Type,
  callback?: IteratorCallback
): IterValue {
  const outerShape = ctx.typeArgs[1];
  const innerShape = intoIterShape(ctx.interp.program, innerType);
  const type = normalize(shallow(innerType));
  const array = type.kind === 'ref' ? normalize(shallow(type.target)) : type;
  const fixed = array.kind === 'array' ? BigInt(array.len) : undefined;
  const lower = (active: IterValue | undefined): bigint => (active ? iteratorLowerBound(active, innerShape) : 0n);
  return adapter<FlattenState>(
    source,
    { front: undefined, back: undefined, outerDone: false, callback },
    (src, state) => ({
      next: () => takeFlattened(ctx, src, state, 'front', inner),
      nextBack: src.nextBack && (() => takeFlattened(ctx, src, state, 'back', inner)),
      sizeHintLower: () =>
        lower(state.front) +
        lower(state.back) +
        (state.outerDone || fixed === undefined ? 0n : fixed * iteratorLowerBound(src, outerShape)),
      trustedSizeHint: fixed !== undefined && (source.trustedSizeHint || isTrustedLen(outerShape)),
    }),
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

function takeFlattened(
  ctx: NativeContext,
  source: IterValue,
  state: FlattenState,
  end: End,
  inner: (item: Value, callback: Value) => IterValue
): Next {
  for (;;) {
    ctx.runtime.spend();
    const item = takeInner(state, end);
    if (item !== DONE) return item;
    const next = state.outerDone ? DONE : fromEnd(source, end);
    if (next === DONE) {
      state.outerDone = true;
      return takeInner(state, end === 'front' ? 'back' : 'front');
    }
    state[end] = inner(next, state.callback?.value);
  }
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
  return ctx.interp.toIter(value, type) as IterValue;
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
      ctx.typeArgs[2],
      new IteratorCallback(f, ctx.typeArgs[3])
    );
    return flattenDebug(ctx, 'FlatMap', iter, ctx.typeArgs[2]);
  },
  'IterImpl<_, _>::flatten': ([self], ctx) => {
    const iter = flattened(ctx, iterOf(self), (item) => innerIter(ctx, item, ctx.typeArgs[0]), ctx.typeArgs[0]);
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
    if (item !== DONE && truthy(call(ctx, f, [item]))) return some(ctx, item);
    // What is not taken, the end included, is what the next call sees.
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
        sizeHintLower: () => (iteratorLowerBound(state.original, ctx.typeArgs[1]) > 0n ? intMax('usize') : 0n),
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
        (indent, sink) =>
          iteratorDebug(from, item, shape, show, indent, sink);
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
      ['state', (indent, sink) => show((target.roots[1] as typeof state).place.value, ctx.typeArgs[2], indent, sink)],
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
      ['iter', (indent, sink) => iteratorDebug(source, item, shape, show, indent, sink)],
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
    const outer: DebugPart = (indent, sink) => iteratorDebug(source, outerItem, outerShape, show, indent, sink);
    const fused = name === 'FlatMap' ? fieldsPart('Map', [['iter', outer]]) : outer;
    const innerPart = (from: IterValue | undefined): DebugPart =>
      optionPart(from && ((indent, sink) => iteratorDebug(from, item, innerShape, show, indent, sink)));
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
      const b = secondOfPair(ctx, a, () => nextOf(state.second));
      return b === DONE ? DONE : [a, b];
    },
    nextBack: () => {
      const lengthA = lengthOf(src);
      const lengthB = lengthOf(state.second);
      if (lengthA > lengthB) skipBack(ctx, src, lengthA - lengthB);
      else if (lengthB > lengthA) skipBack(ctx, state.second, lengthB - lengthA);
      const a = src.nextBack!();
      const b = secondOfPair(ctx, a, state.second.nextBack!);
      return a === DONE || b === DONE ? DONE : [a, b];
    },
    remaining: () => shorterLength(lengthOf(src), lengthOf(state.second)),
  }));
  iter.fork = () => zipped(ctx, cloneIterator(first), cloneIterator(second), shapes, items);
  if (isTrustedLen(...shapes)) iter.foldNext = zipFoldNext(ctx, first, second);
  // `Zip` of two `TrustedRandomAccessNoCoerce` iterators shows nothing of them.
  const isCopy = (type: Type): boolean => ctx.interp.checker.solver.isCopy(type);
  const indexedFormat = trustedRandomAccess(shapes[0], first, isCopy) && trustedRandomAccess(shapes[1], second, isCopy);
  return described(iter, (show) => {
    if (indexedFormat) return () => 'Zip';
    const part =
      (from: IterValue, index: 0 | 1): DebugPart =>
      (indent, sink) =>
        iteratorDebug(from, items[index], shapes[index], show, indent, sink);
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
function zipFoldNext(ctx: NativeContext, first: IterValue, second: IterValue): () => Next {
  return () => {
    if (lengthOf(first) === 0n || lengthOf(second) === 0n) return DONE;
    const a = nextOf(first);
    const b = secondOfPair(ctx, a, () => nextOf(second));
    return a === DONE || b === DONE ? DONE : [a, b];
  };
}

/** The second item of a `Zip`'s pair, whose first item only the unfinished pair holds while the program yields it. */
function secondOfPair(ctx: NativeContext, first: Next, pull: () => Next): Next {
  return first === DONE ? pull() : ctx.runtime.withRoots([first], pull);
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
  const acc = new CellPlace(init);
  return ctx.runtime.withRoots([acc], () => {
    each(
      ctx,
      iter,
      (item) => {
        const previous = acc.value;
        acc.value = undefined;
        acc.value = call(ctx, fn, [previous, item]);
      },
      direction
    );
    return acc.value;
  });
}

function tryFoldItems(ctx: NativeContext, iter: IterValue, accumulator: Value, callback: Value): Value {
  const type = normalize(shallow(ctx.typeArgs[3])) as Type & { kind: 'adt' };
  const success = type.def.builtin === 'Option' ? 1 : 0;
  for (;;) {
    ctx.runtime.spend();
    const result = ctx.runtime.withRoots([accumulator], () => {
      const item = nextOf(iter);
      return item === DONE ? DONE : (deref(call(ctx, callback, [accumulator, item])) as EnumValue);
    });
    if (result === DONE) return new EnumValue(type.def, success, [accumulator]);
    if (result.variant !== success) return result;
    accumulator = result.fields[0];
  }
}

/** `Iterator::eq`, which stops at the first difference. */
function iteratorsEqual(ctx: NativeContext, self: Value, other: Value): boolean {
  const a = iterOf(self);
  const otherType = ctx.typeArgs[2];
  const b = iterOf(toIterator(other, otherType));
  const item = intoIterItem(otherType)!;
  for (;;) {
    ctx.runtime.spend();
    const x = nextOf(a);
    if (x === DONE) return nextOf(b) === DONE;
    const equal = ctx.runtime.withRoots([x], () => {
      const y = nextOf(b);
      return y !== DONE && ctx.runtime.withRoots([y], () => valuesEqual(ctx.typeArgs[0], x, y, item));
    });
    if (!equal) return false;
  }
}

// code-gauge-allow functionCognitiveComplexity 16 -- Exhaustion and unordered pairs terminate lexicographic comparison.
function iteratorOrder(ctx: NativeContext, first: IterValue, second: IterValue, total = false): number | undefined {
  const item = ctx.typeArgs[0];
  const rhs = total ? item : ctx.typeArgs[2];
  for (;;) {
    ctx.runtime.spend();
    const a = nextOf(first);
    if (a === DONE) return nextOf(second) === DONE ? 0 : -1;
    const order = ctx.runtime.withRoots([a], () => {
      const b = nextOf(second);
      if (b === DONE) return 1;
      return ctx.runtime.withRoots([b], () =>
        total ? compareValues(item, a, b) : comparePartialValues(item, a, b, rhs)
      );
    });
    if (order !== 0) return order;
  }
}

define({
  'FromIterator::from_iter': ([source], ctx) => {
    const [target, item, from] = ctx.typeArgs;
    const iter = toIterator(source, from) as IterValue;
    return ctx.runtime.withRoots([iter], () =>
      collectIterator(ctx, iter, target, item, intoIterShape(ctx.interp.program, from))
    );
  },
  'IterImpl<_, _>::collect': ([self], ctx) =>
    collectIterator(ctx, iterOf(self), ctx.typeArgs[2], ctx.typeArgs[0], ctx.typeArgs[1]),
  'IterImpl<_, _>::sum': ([self], ctx) => sumOrProduct(ctx, iterOf(self), ctx.typeArgs[2], '+'),
  'IterImpl<_, _>::product': ([self], ctx) => sumOrProduct(ctx, iterOf(self), ctx.typeArgs[2], '*'),
  'IterImpl<_, _>::count': ([self], ctx) => {
    let count = 0n;
    each(
      ctx,
      iterOf(self),
      () => {
        count++;
      },
      'fold'
    );
    return count;
  },
  'IterImpl<_, _>::len': ([self]) => lengthOf(iterOf(self)),
  'IterImpl<_, _>::last': ([self], ctx) => {
    const last = new CellPlace(none(ctx));
    return ctx.runtime.withRoots([last], () => {
      each(
        ctx,
        iterOf(self),
        (item) => {
          last.value = some(ctx, item);
        },
        'fold'
      );
      return last.value;
    });
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
  'IterImpl<_, _>::try_fold': ([self, init, f], ctx) => tryFoldItems(ctx, iterOf(self), init, f),
  'IterImpl<_, _>::rfold': ([self, init, f], ctx) => foldItems(ctx, iterOf(self), init, f, 'back'),
  'IterImpl<_, _>::reduce': ([self, f], ctx) => {
    const iter = iterOf(self);
    const first = nextOf(iter);
    if (first === DONE) return none(ctx);
    return some(ctx, foldItems(ctx, iter, first, f, 'fold'));
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
    return ctx.runtime.withRoots([yes, no], () => {
      each(ctx, iterOf(self), (item) => void (truthy(call(ctx, f, [item])) ? yes : no).push(item));
      const type = ctx.typeArgs[2];
      return [collectInto(ctx, yes, type, ctx.typeArgs[0]), collectInto(ctx, no, type, ctx.typeArgs[0])];
    });
  },
  'IterImpl<_, _>::eq': ([self, other], ctx) => iteratorsEqual(ctx, self, other),
  'IterImpl<_, _>::ne': ([self, other], ctx) => !iteratorsEqual(ctx, self, other),
  'IterImpl<_, _>::cmp': ([self, other], ctx) =>
    ordering(ctx, iteratorOrder(ctx, iterOf(self), iterOf(other), true) ?? 0),
  'IterImpl<_, _>::partial_cmp': ([self, other], ctx) => {
    const order = iteratorOrder(ctx, iterOf(self), iterOf(other));
    return order === undefined ? none(ctx) : some(ctx, ordering(ctx, order));
  },
  'IterImpl<_, _>::lt': ([self, other], ctx) => iteratorOrder(ctx, iterOf(self), iterOf(other)) === -1,
  'IterImpl<_, _>::le': ([self, other], ctx) => (iteratorOrder(ctx, iterOf(self), iterOf(other)) ?? 1) <= 0,
  'IterImpl<_, _>::gt': ([self, other], ctx) => iteratorOrder(ctx, iterOf(self), iterOf(other)) === 1,
  'IterImpl<_, _>::ge': ([self, other], ctx) => (iteratorOrder(ctx, iterOf(self), iterOf(other)) ?? -1) >= 0,
  'IterImpl<_, _>::is_sorted': ([self], ctx) => {
    // `is_sorted` stops at the first pair out of order.
    const iter = iterOf(self);
    const first = nextOf(iter);
    if (first === DONE) return true;
    const previous = new CellPlace(first);
    return ctx.runtime.withRoots(
      [previous],
      () =>
        each(ctx, iter, (item) => {
          const ordered = ctx.runtime.withRoots([item], () =>
            testPartialOrder('le', ctx.typeArgs[0], previous.value, item)
          );
          previous.value = item;
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
  'IterImpl<_, _>::unzip': ([self], ctx) => unzip(ctx, iterOf(self)),
  'std::iter::repeat': ([value], ctx) => repeated(ctx, value),
  'std::iter::repeat_with': ([f], ctx) => fromFunction(ctx, new IteratorCallback(f, ctx.typeArgs[1]), true),
  'std::iter::repeat_n': ([value, n], ctx) => repeatN(ctx, value, n as bigint),
  'std::iter::once': ([value], ctx) => {
    const iter = ownedIter([value], ctx.typeArgs[0]);
    return described(iter, (show, item, target) => {
      const [left] = target.rest?.() ?? [];
      const opt = optionPart(left === undefined ? undefined : (indent, sink) => show(left, item, indent, sink));
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
  return described(iter, (show, item) =>
    fieldsPart('Repeat', [['element', (indent, sink) => show(value, item, indent, sink)]])
  );
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
    const element: DebugPart = (indent, sink) => show(original, item, indent, sink);
    return fieldsPart('RepeatN', [
      ['count', numberPart(left)],
      ['element', optionPart(left > 0n ? element : undefined)],
    ]);
  });
}

function fromFunction(ctx: NativeContext, callback: IteratorCallback, repeat = false): IterValue {
  const iter = new IterValue(
    () => {
      const value = call(ctx, callback.value, []);
      return repeat ? value : optionValue(value);
    },
    undefined,
    undefined,
    [callback.value]
  );
  iter.fork = () => fromFunction(ctx, callback.clone(), repeat);
  return described(iter, () => () => (repeat ? 'RepeatWith { .. }' : 'FromFn'));
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
      ['next', optionPart(value === undefined ? undefined : (indent, sink) => show(value, item, indent, sink))],
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
  const best = new CellPlace(first);
  const rest = foldingView(iter);
  return ctx.runtime.withRoots([best], () => {
    for (;;) {
      ctx.runtime.spend();
      const item = nextOf(rest);
      if (item === DONE) return some(ctx, best.value);
      const keep = ctx.runtime.withRoots([item], () => keepsBest(compare(best.value, item), sign));
      if (!keep) best.value = item;
    }
  });
}

/** `max_by_key` and `min_by_key`: each key once, in order, compared as `extreme` compares the elements. */
function extremeByKey(ctx: NativeContext, iter: IterValue, f: Value, keyType: Type, sign: 1 | -1): Value {
  const first = nextOf(iter);
  if (first === DONE) return none(ctx);
  let best = first;
  let bestKey = ctx.runtime.withRoots([first], () => call(ctx, f, [first]));
  const rest = foldingView(iter);
  const retained = [best, bestKey];
  return ctx.runtime.withRoots(retained, () => {
    for (;;) {
      ctx.runtime.spend();
      const item = nextOf(rest);
      if (item === DONE) return some(ctx, best);
      const keep = ctx.runtime.withRoots([item], () => {
        const key = call(ctx, f, [item]);
        return ctx.runtime.withRoots([key], () => {
          if (keepsBest(compareValues(keyType, bestKey, key) ?? 0, sign)) return true;
          bestKey = key;
          return false;
        });
      });
      if (!keep) {
        best = item;
        retained[0] = best;
        retained[1] = bestKey;
      }
    }
  });
}

function keepsBest(order: number, sign: 1 | -1): boolean {
  return sign === 1 ? order > 0 : order <= 0;
}

/**
 * The sum or product of `Result`s or `Option`s: of the values in `Ok` or `Some`, or the first `Err` or `None`, after
 * which it takes no more elements.
 */
function sumOfOutcomes(ctx: NativeContext, iter: IterValue, t: Type & { kind: 'adt' }, op: '+' | '*'): Value {
  return consumeOutcomes(ctx, iter, t, (values) => sumOrProduct(ctx, values, t.args[0], op));
}

function consumeOutcomes(
  ctx: NativeContext,
  iter: IterValue,
  target: Type & { kind: 'adt' },
  consume: (values: IterValue) => Value
): Value {
  const success = target.def.builtin === 'Result' ? 0 : 1;
  let failure: EnumValue | undefined;
  const next = (): Next => {
    if (failure) return DONE;
    const item = nextForFold(iter);
    if (item === DONE) return DONE;
    const outcome = deref(item) as EnumValue;
    if (outcome.variant === success) return outcome.fields[0];
    failure = outcome;
    return DONE;
  };
  const values = new IterValue(next, undefined, undefined, [iter]);
  values.stateRoots = () => [failure];
  const value = ctx.runtime.withRoots([values], () => consume(values));
  return failure ?? new EnumValue(target.def, success, [value]);
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
        ? floatStep(t.name, op, floatNumber(total), floatNumber(item))
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
export function collectVec(ctx: NativeContext, iter: IterValue, shape: Type | undefined, elem: Type): Value[] {
  const source = shape && inPlaceSource(iter, shape);
  const inPlace = source && inPlaceCapacity(source, layoutOf(elem));
  const trusted = iter.trustedSizeHint || (shape && isTrustedLen(shape));
  if (trusted || inPlace !== undefined) {
    const items = collectAll(ctx, iter, undefined, !!trusted);
    ctx.runtime.allocate(items.length);
    if (inPlace !== undefined) setVecCapacity(items, inPlace);
    return items;
  }
  const items: Value[] = [];
  const size = sizeOf(elem);
  let capacity = vecCapacity(items, 0, size);
  return ctx.runtime.withRoots(items, () => {
    each(ctx, iter, (item) => {
      if (items.length === capacity) {
        const additional = iteratorLowerBound(iter, shape) + 1n;
        checkVecCapacity(ctx, items.length, additional, size);
        reserveVec(items, items.length, Number(additional), size);
        capacity = vecCapacity(items, items.length, size);
      }
      ctx.runtime.allocate(1);
      items.push(item);
    });
    return items;
  });
}

/** The adapters through which `collect` reuses the buffer of a `Vec`'s `into_iter` (`InPlaceIterable`). */
const IN_PLACE_ADAPTERS = new Set([
  'GenericShuntShape',
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

function unzip(ctx: NativeContext, iter: IterValue): Value {
  const [, shape, typeA, typeB, fromA, fromB] = ctx.typeArgs;
  const left = new CellPlace(undefined);
  const right = new CellPlace(undefined);
  return ctx.runtime.withRoots([left, right], () => {
    left.set(defaultValue(ctx, fromA));
    right.set(defaultValue(ctx, fromB));
    const bound = iteratorLowerBound(iter, shape);
    const first = unzipColumn(ctx, left, fromA, typeA, bound);
    const second = unzipColumn(ctx, right, fromB, typeB, bound);
    each(
      ctx,
      iter,
      (item) => {
        ctx.runtime.withRoots([item], () => {
          const [a, b] = item as Value[];
          first(a);
          second(b);
        });
      },
      'fold'
    );
    return [left.get(), right.get()];
  });
}

function unzipColumn(
  ctx: NativeContext,
  output: CellPlace,
  target: Type,
  item: Type,
  bound: bigint
): (value: Value) => void {
  const t = normalize(shallow(target));
  if (t.kind !== 'adt') throw new Error('unzip into a non-collection');
  const name = t.def.builtin!;
  const prefix = t.args.length === 0 ? name : `${name}<${t.args.map(() => '_').join(', ')}>`;
  const nativeCtx = { ...ctx, typeArgs: t.args };
  const source = normalize(shallow(item));
  const char = source.kind === 'ref' ? normalize(shallow(source.target)).kind === 'char' : source.kind === 'char';
  if (bound > 0n && (!['BTreeMap', 'BTreeSet', 'String'].includes(name) || (name === 'String' && char))) {
    NATIVES[`${prefix}::reserve`]([output, bound], nativeCtx);
  }
  if (name.endsWith('Map')) {
    return (pair) => {
      NATIVES[`${prefix}::insert`]([output, ...(pair as Value[])], nativeCtx);
    };
  }
  if (name.endsWith('Set')) {
    const convert = extendedValue(t.args[0], item);
    return (value) => {
      NATIVES[`${prefix}::insert`]([output, convert(value)], nativeCtx);
    };
  }
  const shape = ctx.interp.program.shapeType('ArrayIntoIterShape');
  const input = { ...ctx, typeArgs: [...t.args, item, shape] };
  return (value) => {
    NATIVES[`${prefix}::extend`]([output, arrayIter([value])], input);
  };
}

export function collectInto(ctx: NativeContext, items: Value[], target: Type, item: Type): Value {
  return ctx.runtime.withRoots(items, () => collectIterator(ctx, arrayIter(items), target, item));
}

function collectIterator(ctx: NativeContext, iter: IterValue, target: Type, item: Type, shape?: Type): Value {
  const t = normalize(shallow(target));
  if (t.kind !== 'adt') throw new Error('collect into a non-collection');
  switch (t.def.builtin) {
    case 'Vec': {
      return collectVec(ctx, iter, shape, item);
    }
    case 'String': {
      return collectString(ctx, iter, item, shape);
    }
    case 'HashSet': {
      return collectHashSet(ctx, iter, t.args[0], shape);
    }
    case 'HashMap': {
      return collectHashMap(ctx, iter, t.args, shape);
    }
    case 'Option':
    case 'Result': {
      return collectOutcome(ctx, iter, t, item, shape);
    }
    case 'Box': {
      if (shallow(t.args[0]).kind === 'str') return textOf(collectString(ctx, iter, item, shape));
      return collectBulk(ctx, iter, t, item);
    }
    default: {
      return collectBulk(ctx, iter, t, item);
    }
  }
}

function collectOutcome(
  ctx: NativeContext,
  iter: IterValue,
  target: Type & { kind: 'adt' },
  item: Type,
  shape?: Type
): Value {
  const input = normalize(shallow(item)) as Type & { kind: 'adt' };
  const shunt = shape && ctx.interp.program.shapeType('GenericShuntShape', [shape]);
  return consumeOutcomes(ctx, iter, target, (values) =>
    collectIterator(ctx, values, target.args[0], input.args[0], shunt)
  );
}

function collectHashMap(ctx: NativeContext, iter: IterValue, types: Type[], shape?: Type): MapValue {
  const map = new MapValue(false);
  sizeTable(map.entries.table, sizeOf({ kind: 'tuple', elems: types }));
  reserveHashInput(ctx, map.entries.table!, iter, shape);
  return collectHash(ctx, iter, map, (item) => {
    const [key, value] = item as Value[];
    const lookup = map.entries.key(types[0], key);
    const existing = map.entries.get(lookup);
    if (existing) existing[1] = value;
    else {
      ctx.runtime.allocate(1);
      map.entries.set(lookup, [key, value]);
    }
  });
}

function collectHashSet(ctx: NativeContext, iter: IterValue, itemType: Type, shape?: Type): SetValue {
  const set = new SetValue(false);
  sizeTable(set.entries.table, sizeOf(itemType));
  reserveHashInput(ctx, set.entries.table!, iter, shape);
  return collectHash(ctx, iter, set, (item) => {
    const lookup = set.entries.key(itemType, item);
    if (set.entries.has(lookup)) return;
    ctx.runtime.allocate(1);
    set.entries.set(lookup, item);
  });
}

function collectHash<T extends MapValue | SetValue>(
  ctx: NativeContext,
  iter: IterValue,
  collection: T,
  insert: (item: Value) => void
): T {
  return ctx.runtime.withRoots([collection], () => {
    each(ctx, iter, (item) => ctx.runtime.withRoots([item], () => insert(item)), 'fold');
    return collection;
  });
}

export function reserveHashInput(
  ctx: NativeContext,
  table: TableMap<unknown, unknown>,
  iter: IterValue,
  shape?: Type
): void {
  const bound = iteratorLowerBound(iter, shape);
  const additional = table.size === 0 ? bound : (bound + 1n) / 2n;
  checkTableCapacity(ctx, table.size, additional, table.entrySize);
  table.reserve(Number(additional));
}

function collectBulk(ctx: NativeContext, iter: IterValue, target: Type & { kind: 'adt' }, item: Type): Value {
  const items = collectAll(ctx, iter, undefined, true);
  ctx.runtime.allocate(items.length);
  return ctx.runtime.withRoots(items, () => {
    switch (target.def.builtin) {
      case 'VecDeque':
      case 'Box': {
        return items;
      }
      case 'BinaryHeap': {
        return heapify(items, target.args[0]);
      }
      case 'BTreeMap': {
        return collectBTreeMap(ctx, items as [Value, Value][], target.args[0], item);
      }
      case 'BTreeSet': {
        return collectBTreeSet(ctx, items, target.args[0]);
      }
      default: {
        throw new Error(`collect into ${target.def.name}`);
      }
    }
  });
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
      // std's dedup of sorted keys asks whether they differ, which may run a user `ne`.
      if (index + 1 === items.length || valuesUnequal(keyType, keyOf(item), keyOf(items[index + 1]))) add(item);
    }
  });
}

/** Builds a max-heap from elements as `BinaryHeap::from(vec)` does: sifting down from the last parent to the root. */
export function heapify(heap: Value[], type: Type): Value[] {
  const end = heap.length;
  for (let index = Math.floor(end / 2) - 1; index >= 0; index--) siftDownRange(heap, index, end, type);
  return heap;
}

export function heapIntoSortedVec(heap: Value[], type: Type): Value[] {
  for (let end = heap.length - 1; end > 0; end--) {
    swapOwnedElements(heap, 0, end);
    siftDownRange(heap, 0, end, type);
  }
  return heap;
}

export function rebuildHeapTail(heap: Value[], start: number, type: Type): void {
  const tail = heap.length - start;
  if (tail === 0) return;
  const levels = heap.length <= 2048 ? Math.floor(Math.log2(start)) : 11;
  if (start < tail || 2 * heap.length < tail * levels) {
    heapify(heap, type);
  } else {
    for (let index = start; index < heap.length; index++) siftUp(heap, index, type);
  }
}

function siftDownRange(heap: Value[], start: number, end: number, type: Type): void {
  let hole = start;
  let child = 2 * hole + 1;
  while (child + 1 < end) {
    if (testPartialOrder('le', type, heap[child], heap[child + 1])) child++;
    if (testPartialOrder('ge', type, heap[hole], heap[child])) return;
    swapOwnedElements(heap, hole, child);
    hole = child;
    child = 2 * hole + 1;
  }
  if (child === end - 1 && testPartialOrder('lt', type, heap[hole], heap[child])) swapOwnedElements(heap, hole, child);
}

export function heapPush(heap: Value[], value: Value, type: Type): void {
  heap.push(value);
  siftUp(heap, heap.length - 1, type);
}

export function heapPop(ctx: NativeContext, heap: Value[], type: Type): Value | undefined {
  if (heap.length === 0) return undefined;
  swapOwnedElements(heap, 0, heap.length - 1);
  const top = heap.pop();
  return ctx.runtime.withRoots([top], () => {
    let hole = 0;
    let child = 1;
    while (child < heap.length) {
      if (child + 1 < heap.length && testPartialOrder('le', type, heap[child], heap[child + 1])) child++;
      swapOwnedElements(heap, hole, child);
      hole = child;
      child = 2 * hole + 1;
    }
    siftUp(heap, hole, type);
    return top;
  });
}

function siftUp(heap: Value[], start: number, type: Type): void {
  let index = start;
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (testPartialOrder('le', type, heap[index], heap[parent])) break;
    swapOwnedElements(heap, index, parent);
    index = parent;
  }
}

export { castValue, needsCopy, placeOf, SliceView };
