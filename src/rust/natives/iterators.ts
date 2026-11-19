// code-gauge-allow-file fileNcss 760 -- One native per method of the standard library.
import { collectedVecCapacity, inPlaceCapacity, setVecCapacity, sizeTable } from '../capacity';
import { normalize } from '../infer';
import type { Interpreter } from '../interpreter';
import { castValue, cloneValue, compareValues, copyValue, hashKey, needsCopy, valuesEqual, wrap } from '../ops';
import { RustPanic } from '../runtime';
import { iteratorCapability } from '../traits';
import { shallow, type Type } from '../types';
import {
  DONE,
  ElementPlace,
  EnumValue,
  IterValue,
  MapValue,
  type Next,
  RangeValue,
  SetValue,
  sliceBase,
  sliceItems,
  sliceLength,
  SliceView,
  type Value,
} from '../values';
import { layoutOf, sizeOf } from './layout';
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
  iter.fork = () => arrayIter(array, front, back, map);
  return iter;
}

/**
 * An iterator that owns its elements (`into_iter`, `drain`, `for x in v`): it holds only those it has not yielded,
 * so each one it hands out belongs to its receiver alone and disappears when that receiver drops it.
 */
export function ownedIter(items: Value[]): IterValue {
  const rest = [...items];
  const iter = new IterValue(
    () => (rest.length > 0 ? (rest.shift() as Value) : DONE),
    () => (rest.length > 0 ? (rest.pop() as Value) : DONE),
    () => rest.length,
    [rest]
  );
  iter.rest = () => [...rest];
  iter.fork = (cloneItem) => ownedIter(rest.map(cloneItem));
  return iter;
}

/** An iterator of a slice's elements; `places` yields places for `iter_mut`. */
export function sliceIter(slice: Value, places: boolean): IterValue {
  const { base, start } = sliceBase(slice);
  const length = sliceLength(slice);
  return arrayIter(base, start, start + length, places ? (i) => new ElementPlace(base, i) : (i) => base[i]);
}

/** The iterator `for` uses for a value of a type, as `IntoIterator` makes it. */
export function toIterator(interp: Interpreter, value: Value, from: Type): Value {
  const t = normalize(shallow(from));
  if (value instanceof IterValue) return value;
  if (t.kind === 'opaque' && t.opaque.hidden) return toIterator(interp, value, t.opaque.hidden);
  if (t.kind === 'array') return ownedIter(sliceItems(value));
  if (t.kind === 'ref') {
    const target = normalize(shallow(t.target));
    const v = t.mutable ? (deref(value) as Value) : value;
    if (target.kind === 'array' || target.kind === 'slice') return sliceIter(v, t.mutable);
    if (target.kind === 'adt') {
      switch (target.def.builtin) {
        case 'Vec':
        case 'VecDeque':
        case 'BinaryHeap': {
          return sliceIter(v, t.mutable);
        }
        case 'HashMap':
        case 'BTreeMap': {
          return mapIter(interp, v as MapValue, target.args[0], t.mutable ? 'mut' : 'ref');
        }
        case 'HashSet':
        case 'BTreeSet': {
          return setIter(v as SetValue, target.args[0]);
        }
        case 'Option':
        case 'Result': {
          // `Some` and `Ok` hold the one element.
          const option = v as EnumValue;
          if (option.variant !== (target.def.builtin === 'Option' ? 1 : 0)) return arrayIter([]);
          return arrayIter([t.mutable ? new ElementPlace(option.fields, 0) : option.fields[0]]);
        }
        case 'Iter': {
          return v;
        }
        default: {
          break;
        }
      }
    }
  }
  if (t.kind === 'adt') {
    switch (t.def.builtin) {
      case 'Vec':
      case 'VecDeque':
      case 'BinaryHeap': {
        return ownedIter(value as Value[]);
      }
      case 'HashMap':
      case 'BTreeMap': {
        return mapIter(interp, value as MapValue, t.args[0], 'value');
      }
      case 'HashSet':
      case 'BTreeSet': {
        return setIter(value as SetValue, t.args[0]);
      }
      case 'Range':
      case 'RangeInclusive':
      case 'RangeFrom': {
        return rangeIterator(value as RangeValue, t.args[0]);
      }
      case 'Option':
      case 'Result': {
        const option = value as EnumValue;
        const present = t.def.builtin === 'Option' ? option.variant === 1 : option.variant === 0;
        return arrayIter(present ? [option.fields[0]] : []);
      }
      case 'CaseIter': {
        return arrayIter([...(value as unknown as { text: string }).text]);
      }
      default: {
        break;
      }
    }
  }
  throw new Error(`Cannot iterate ${t.kind}`);
}

/** A map's entries as tuples, in key order for a `BTreeMap`; `mut` yields places for the values. */
export function mapIter(interp: Interpreter, map: MapValue, keyType: Type, mode: 'value' | 'ref' | 'mut'): IterValue {
  const entries = interp.formatter.mapEntries(map, keyType);
  const iter = arrayIter(entries, 0, entries.length, (i) => {
    const entry = entries[i];
    return mode === 'mut' ? [entry[0], new ElementPlace(entry, 1)] : [entry[0], entry[1]];
  });
  iter.roots.push(map);
  return iter;
}

export function setIter(set: SetValue, elemType: Type): IterValue {
  const values = [...set.entries.values()];
  if (set.sorted) values.sort((a, b) => compareValues(elemType, a, b) ?? 0);
  const iter = arrayIter(values);
  iter.roots.push(set);
  return iter;
}

/**
 * An iterator over a range that advances the range itself, as `Range`'s `Iterator` impl does: integers, or `char`s
 * (which skip the surrogates).
 */
export function rangeIterator(range: RangeValue, elem: Type): IterValue {
  const t = normalize(shallow(elem));
  const isChar = t.kind === 'char';
  const name = t.kind === 'int' ? t.name : 'i32';
  const toNumber = (value: Value): bigint => (isChar ? BigInt((value as string).codePointAt(0)!) : (value as bigint));
  const fromNumber = (value: bigint): Value => (isChar ? String.fromCodePoint(Number(value)) : value);
  const step = (value: bigint, delta: bigint): bigint => {
    let next = value + delta;
    if (isChar && next >= 0xd8_00n && next <= 0xdf_ffn) next = delta > 0n ? 0xe0_00n : 0xd7_ffn;
    return next;
  };
  const next = (): Next => {
    if (range.exhausted) return DONE;
    const start = toNumber(range.start);
    if (range.end === undefined) {
      if (!isChar && start === wrap(name as never, start) && start + 1n !== wrap(name as never, start + 1n)) {
        // `RangeFrom` overflows past the type's maximum, as a debug build panics.
        range.start = fromNumber(start);
        throw new RustPanic('attempt to add with overflow', { row: 0, col: 0 });
      }
      range.start = fromNumber(step(start, 1n));
      return fromNumber(start);
    }
    const end = toNumber(range.end);
    if (range.inclusive) {
      if (start > end) return DONE;
      if (start === end) {
        range.exhausted = true;
        return fromNumber(start);
      }
    } else if (start >= end) {
      return DONE;
    }
    range.start = fromNumber(step(start, 1n));
    return fromNumber(start);
  };
  const nextBack = (): Next => {
    if (range.exhausted || range.end === undefined) return DONE;
    const start = toNumber(range.start);
    const end = toNumber(range.end);
    if (range.inclusive) {
      if (start > end) return DONE;
      if (start === end) {
        range.exhausted = true;
        return fromNumber(end);
      }
      range.end = fromNumber(step(end, -1n));
      return fromNumber(end);
    }
    if (start >= end) return DONE;
    const last = step(end, -1n);
    range.end = fromNumber(last);
    return fromNumber(last);
  };
  const remaining = (): number => {
    if (range.exhausted || range.end === undefined) return 0;
    const count = Number(toNumber(range.end) - toNumber(range.start)) + (range.inclusive ? 1 : 0);
    return Math.max(0, count);
  };
  const iter = new IterValue(next, nextBack, remaining, [range]);
  iter.fork = () => rangeIterator(new RangeValue(range.start, range.end, range.inclusive, range.exhausted), elem);
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

/** Takes the element `n` places from the back, dropping those after it, as `nth_back` does. */
function nthBack(iter: IterValue, n: number): Next {
  for (let index = 0; index < n; index++) if (iter.nextBack!() === DONE) return DONE;
  return iter.nextBack!();
}

/** Takes the element `n` places from the front, dropping those before it, as `nth` does. */
function nth(iter: IterValue, n: number): Next {
  for (let index = 0; index < n; index++) if (nextOf(iter) === DONE) return DONE;
  return nextOf(iter);
}

/** The number of elements left, counting those `peek` looked at. */
function lengthOf(iter: IterValue): number {
  return (iter.remaining?.() ?? 0) + (iter.peeked?.filter((item) => item !== DONE).length ?? 0);
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
  remaining?: () => number;
}

/**
 * An adapter of a source iterator whose own state (`state`, copied for clones) and the source decide its elements;
 * `forkState` copies state that holds iterators.
 */
function adapter<S extends object>(
  source: IterValue,
  state: S,
  parts: (source: IterValue, state: S) => AdapterParts,
  forkState: (state: S, cloneItem: (value: Value) => Value) => S = (s) => ({ ...s }),
  folds = false
): IterValue {
  const { next, nextBack, remaining } = parts(source, state);
  const iter = new IterValue(next, nextBack, remaining, [source, state]);
  // An adapter whose `fold` folds its source (`Map`, `Filter`, ...) takes its source's elements as it folds.
  if (folds && source.foldNext) iter.foldNext = parts(foldingView(source), state).next;
  iter.fork = (cloneItem) => adapter(forkIter(source, cloneItem), forkState(state, cloneItem), parts, forkState, folds);
  return iter;
}

/** The iterator as a fold takes it: its pushed-back elements, then its `foldNext`. */
function foldingView(iter: IterValue): IterValue {
  return new IterValue(
    () => (iter.peeked && iter.peeked.length > 0 ? (iter.peeked.shift() as Next) : (iter.foldNext ?? iter.next)()),
    iter.nextBack,
    iter.remaining
  );
}

/** An independent copy of an iterator, with the elements `peek` looked at. */
function forkIter(iter: IterValue, cloneItem: (value: Value) => Value): IterValue {
  if (!iter.fork) throw new Error('This iterator cannot be cloned');
  const copy = iter.fork(cloneItem);
  if (iter.peeked) copy.peeked = iter.peeked.map((item) => (item === DONE ? DONE : cloneItem(item)));
  return copy;
}

/** An adapter that maps each element, from either end. */
function mapped(source: IterValue, map: (item: Value) => Value): IterValue {
  const take = (item: Next): Next => (item === DONE ? DONE : map(item));
  return adapter(
    source,
    {},
    (src) => ({
      next: () => take(nextOf(src)),
      nextBack: src.nextBack && (() => take(src.nextBack!())),
      remaining: src.remaining,
    }),
    undefined,
    true
  );
}

/** An adapter that finds the next element `pick` keeps (mapped), from either end. */
function picked(ctx: NativeContext, source: IterValue, pick: (item: Value) => Next): IterValue {
  const find = (take: () => Next): Next => {
    for (;;) {
      ctx.runtime.spend();
      const item = take();
      if (item === DONE) return DONE;
      const result = pick(item);
      if (result !== DONE) return result;
    }
  };
  return adapter(
    source,
    {},
    (src) => ({
      next: () => find(() => nextOf(src)),
      nextBack: src.nextBack && (() => find(src.nextBack!)),
    }),
    undefined,
    true
  );
}

/** An adapter that yields the elements until `stop` (given each element) returns DONE for one, then nothing. */
function until(source: IterValue, map: (item: Value) => Next): IterValue {
  return adapter(source, { done: false }, (src, state) => ({
    next: () => {
      if (state.done) return DONE;
      const item = nextOf(src);
      const result = item === DONE ? DONE : map(item);
      if (result === DONE) state.done = true;
      return result;
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
// code-gauge-allow functionCognitiveComplexity 19 -- Walks the inner iterators from either end, as `FlattenCompat` does.
function flattened(ctx: NativeContext, source: IterValue, inner: (item: Value) => IterValue): IterValue {
  return adapter<FlattenState>(
    source,
    { front: undefined, back: undefined },
    (src, state) => {
      const take = (end: End): Next => {
        for (;;) {
          ctx.runtime.spend();
          const item = takeInner(state, end);
          if (item !== DONE) return item;
          const next = fromEnd(src, end);
          if (next === DONE) return takeInner(state, end === 'front' ? 'back' : 'front');
          state[end] = inner(next);
        }
      };
      return { next: () => take('front'), nextBack: src.nextBack && (() => take('back')) };
    },
    (state, cloneItem) => ({
      front: state.front && forkIter(state.front, cloneItem),
      back: state.back && forkIter(state.back, cloneItem),
    })
  );
}

type End = 'front' | 'back';

/** The inner iterators of a flattening adapter, at its front and its back. */
interface FlattenState {
  front: IterValue | undefined;
  back: IterValue | undefined;
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
  return toIterator(ctx.interp, value, type) as IterValue;
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
  'IterImpl<_, _>::map': ([self, f], ctx) => mapped(iterOf(self), (item) => call(ctx, f, [item])),
  'IterImpl<_, _>::filter': ([self, f], ctx) =>
    picked(ctx, iterOf(self), (item) => (truthy(call(ctx, f, [item])) ? item : DONE)),
  'IterImpl<_, _>::filter_map': ([self, f], ctx) =>
    picked(ctx, iterOf(self), (item) => optionValue(call(ctx, f, [item]))),
  'IterImpl<_, _>::map_while': ([self, f], ctx) => until(iterOf(self), (item) => optionValue(call(ctx, f, [item]))),
  'IterImpl<_, _>::take_while': ([self, f], ctx) =>
    until(iterOf(self), (item) => (truthy(call(ctx, f, [item])) ? item : DONE)),
  'IterImpl<_, _>::flat_map': ([self, f], ctx) =>
    flattened(ctx, iterOf(self), (item) => innerIter(ctx, call(ctx, f, [item]), ctx.typeArgs[2])),
  'IterImpl<_, _>::flatten': ([self], ctx) =>
    flattened(ctx, iterOf(self), (item) => innerIter(ctx, item, ctx.typeArgs[0])),
  'IterImpl<_, _>::enumerate': ([self]) =>
    adapter(
      iterOf(self),
      { index: 0 },
      (src, state) => ({
        next: () => {
          const item = nextOf(src);
          return item === DONE ? DONE : [BigInt(state.index++), item];
        },
        nextBack: () => {
          const total = state.index + lengthOf(src);
          const item = src.nextBack!();
          return item === DONE ? DONE : [BigInt(total - 1), item];
        },
        remaining: () => lengthOf(src),
      }),
      undefined,
      true
    ),
  'IterImpl<_, _>::zip': ([self, other], ctx) =>
    zipped(iterOf(self), iterOf(other), [ctx.typeArgs[1], ctx.typeArgs[3]]),
  'std::iter::zip': ([a, b], ctx) => zipped(iterOf(a), iterOf(b), [ctx.typeArgs[2], ctx.typeArgs[3]]),
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
      (state, cloneItem) => ({ ...state, second: forkIter(state.second, cloneItem) })
    ),
  'IterImpl<_, _>::rev': ([self]) =>
    adapter(iterOf(self), {}, (src) => ({
      next: () => src.nextBack!(),
      nextBack: () => nextOf(src),
      remaining: src.remaining,
    })),
  'IterImpl<_, _>::take': ([self, n]) =>
    adapter(iterOf(self), { left: Number(n as bigint) }, (src, state) => ({
      next: () => {
        if (state.left <= 0) return DONE;
        state.left--;
        return nextOf(src);
      },
      // `Take::next_back` drops the elements past its count from the back first.
      nextBack: () => {
        if (state.left <= 0) return DONE;
        const left = state.left--;
        return nthBack(src, Math.max(lengthOf(src) - left, 0));
      },
      remaining: () => Math.min(state.left, lengthOf(src)),
    })),
  'IterImpl<_, _>::skip': ([self, n]) =>
    adapter(iterOf(self), { toSkip: Number(n as bigint) }, (src, state) => ({
      next: () => {
        if (state.toSkip > 0) {
          const skip = state.toSkip;
          state.toSkip = 0;
          return nth(src, skip);
        }
        return nextOf(src);
      },
      nextBack: () => (lengthOf(src) > state.toSkip ? src.nextBack!() : DONE),
      remaining: () => Math.max(0, lengthOf(src) - state.toSkip),
    })),
  'IterImpl<_, _>::skip_while': ([self, f], ctx) =>
    adapter(iterOf(self), { skipping: true }, (src, state) => ({
      next: () => {
        for (;;) {
          ctx.runtime.spend();
          const item = nextOf(src);
          if (item === DONE) return DONE;
          if (state.skipping && truthy(call(ctx, f, [item]))) continue;
          state.skipping = false;
          return item;
        }
      },
    })),
  // code-gauge-allow functionCognitiveComplexity 18 -- Follows `StepBy`'s arithmetic from either end.
  'IterImpl<_, _>::step_by': ([self, n], ctx) => {
    const step = Number(n as bigint);
    if (step === 0) libraryPanic(ctx, 'assertion failed: step != 0', 'core/src/iter/adapters/step_by.rs:36:9');
    return adapter(iterOf(self), { first: true, step }, (src, state) => ({
      next: () => {
        const skip = state.first ? 0 : step - 1;
        state.first = false;
        return nth(src, skip);
      },
      // `StepBy::next_back_index`: the elements after the last one the steps reach are dropped from the back.
      nextBack: () => {
        const rem = lengthOf(src) % step;
        const index = state.first ? (rem === 0 ? step - 1 : rem - 1) : rem;
        return nthBack(src, index);
      },
      remaining: () => {
        const length = lengthOf(src);
        if (state.first) return length === 0 ? 0 : 1 + Math.floor((length - 1) / step);
        return Math.floor(length / step);
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
  'IterImpl<_, PeekableShape<_>>::peek': ([self], ctx) => {
    const iter = peekSource(self);
    iter.peeked ??= [];
    if (iter.peeked.length === 0) iter.peeked.push(iter.next());
    const item = iter.peeked[0];
    return option(ctx, item === DONE ? undefined : item, item !== DONE);
  },
  'IterImpl<_, PeekableShape<_>>::next_if': ([self, f], ctx) => {
    const iter = peekSource(self);
    const item = nextOf(iter);
    if (item === DONE) return none(ctx);
    if (truthy(call(ctx, f, [item]))) return some(ctx, item);
    iter.peeked ??= [];
    iter.peeked.unshift(item);
    return none(ctx);
  },
  'IterImpl<_, _>::inspect': ([self, f], ctx) =>
    mapped(iterOf(self), (item) => {
      call(ctx, f, [item]);
      return item;
    }),
  'IterImpl<_, _>::cycle': ([self], ctx) => {
    // `Cycle` keeps a clone of the iterator as it was, which it clones again to go round once more.
    const clone = (value: Value): Value => cloneValue(ctx.typeArgs[0], value);
    const original = forkIter(iterOf(self), clone);
    return adapter(
      iterOf(self),
      { current: undefined as IterValue | undefined },
      (src, state) => ({
        next: () => {
          ctx.runtime.spend();
          const item = nextOf(state.current ?? src);
          if (item !== DONE) return item;
          state.current = forkIter(original, clone);
          return nextOf(state.current);
        },
      }),
      (state, cloneItem) => ({ current: state.current && forkIter(state.current, cloneItem) })
    );
  },
  'IterImpl<_, _>::scan': ([self, initial, f], ctx) => {
    const state = { value: initial, done: false };
    const place = { isPlace: true as const, get: () => state.value, set: (v: Value) => void (state.value = v) };
    return adapter(iterOf(self), state, (src, st) => ({
      next: () => {
        if (st.done) return DONE;
        const item = nextOf(src);
        if (item === DONE) return DONE;
        const result = optionValue(call(ctx, f, [place, item]));
        if (result === DONE) st.done = true;
        return result;
      },
    }));
  },
});

/** The iterator a `Peekable` wraps, which keeps the elements `peek` looked at. */
function peekSource(self: Value): IterValue {
  return iterOf(self).roots[0] as IterValue;
}

/**
 * Zips two iterators. From the back, it first drops the longer one's extra elements from its back, as `Zip`'s
 * `next_back` does. When both are `TrustedRandomAccess`, `next` stops at the shorter one's end without taking from the
 * longer one, as `Zip`'s specialization for them reads by index.
 */
// code-gauge-allow functionCognitiveComplexity 21 -- Follows `Zip`'s `next` and `next_back`.
function zipped(first: IterValue, second: IterValue, shapes: [Type, Type]): IterValue {
  const trusted = isTrustedRandomAccess(...shapes);
  const iter = adapter(
    first,
    { second },
    (src, state) => ({
      next: () => {
        if (trusted && Math.min(lengthOf(src), lengthOf(state.second)) === 0) return DONE;
        const a = nextOf(src);
        if (a === DONE) return DONE;
        const b = nextOf(state.second);
        return b === DONE ? DONE : [a, b];
      },
      nextBack: () => {
        const lengthA = lengthOf(src);
        const lengthB = lengthOf(state.second);
        for (let index = lengthB; index < lengthA; index++) src.nextBack!();
        for (let index = lengthA; index < lengthB; index++) state.second.nextBack!();
        const a = src.nextBack!();
        const b = state.second.nextBack!();
        return a === DONE || b === DONE ? DONE : [a, b];
      },
      remaining: () => Math.min(lengthOf(src), lengthOf(state.second)),
    }),
    (state, cloneItem) => ({ second: forkIter(state.second, cloneItem) })
  );
  if (isTrustedLen(...shapes)) iter.foldNext = zipFoldNext(first, second);
  return iter;
}

/** `Zip`'s `fold` of two `TrustedLen` iterators: as many pairs as its size hint, and no more from the longer. */
function zipFoldNext(first: IterValue, second: IterValue): () => Next {
  return () => {
    if (Math.min(lengthOf(first), lengthOf(second)) === 0) return DONE;
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
  return shapes.every((shape) => {
    const t = normalize(shallow(shape));
    if (t.kind !== 'adt') return false;
    const { name } = t.def;
    if (RANDOM_ACCESS_SHAPES.has(name)) return true;
    // `Range` of every integer type but the 128-bit ones.
    if (name === 'RangeShape') {
      const idx = normalize(shallow(t.args[0]));
      return idx.kind === 'int' && !idx.name.endsWith('128');
    }
    if (!RANDOM_ACCESS_ADAPTERS.has(name)) return false;
    return isTrustedRandomAccess(...(name === 'ZipShape' ? t.args : [t.args[0]]));
  });
}

/** Calls `f` on the elements in order until it returns a value, which it returns; undefined at the end. */
function each<T>(
  ctx: NativeContext,
  iter: IterValue,
  f: (item: Value, index: number) => T | undefined,
  fold = false
): T | undefined {
  const source = fold ? foldingView(iter) : iter;
  for (let index = 0; ; index++) {
    ctx.runtime.spend();
    const item = nextOf(source);
    if (item === DONE) return undefined;
    const result = f(item, index);
    if (result !== undefined) return result;
  }
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
    return collectInto(ctx, collectAll(ctx, iterOf(self), stop, !stop), ctx.typeArgs[2], ctx.typeArgs[0]);
  },
  'IterImpl<_, _>::sum': ([self], ctx) => sumOrProduct(ctx, iterOf(self), ctx.typeArgs[2], '+'),
  'IterImpl<_, _>::product': ([self], ctx) => sumOrProduct(ctx, iterOf(self), ctx.typeArgs[2], '*'),
  'IterImpl<_, _>::count': ([self], ctx) => BigInt(collectAll(ctx, iterOf(self), undefined, true).length),
  'IterImpl<_, _>::len': ([self]) => BigInt(lengthOf(iterOf(self))),
  'IterImpl<_, _>::last': ([self], ctx) => {
    const items = collectAll(ctx, iterOf(self), undefined, true);
    return option(ctx, items.at(-1), items.length > 0);
  },
  'IterImpl<_, _>::nth': ([self, n], ctx) => {
    const item = nth(iterOf(self), Number(n as bigint));
    return option(ctx, item === DONE ? undefined : item, item !== DONE);
  },
  'IterImpl<_, _>::nth_back': ([self, n], ctx) => {
    const item = nthBack(iterOf(self), Number(n as bigint));
    return option(ctx, item === DONE ? undefined : item, item !== DONE);
  },
  'IterImpl<_, _>::fold': ([self, init, f], ctx) => {
    let acc = init;
    each(ctx, iterOf(self), (item) => void (acc = call(ctx, f, [acc, item])), true);
    return acc;
  },
  'IterImpl<_, _>::reduce': ([self, f], ctx) => {
    const iter = iterOf(self);
    const first = nextOf(iter);
    if (first === DONE) return none(ctx);
    let acc = first;
    each(ctx, iter, (item) => void (acc = call(ctx, f, [acc, item])), true);
    return some(ctx, acc);
  },
  'IterImpl<_, _>::for_each': ([self, f], ctx) => {
    each(ctx, iterOf(self), (item) => void call(ctx, f, [item]), true);
    return [];
  },
  'IterImpl<_, _>::any': ([self, f], ctx) =>
    each(ctx, iterOf(self), (item) => (truthy(call(ctx, f, [item])) ? true : undefined)) ?? false,
  'IterImpl<_, _>::all': ([self, f], ctx) =>
    each(ctx, iterOf(self), (item) => (truthy(call(ctx, f, [item])) ? undefined : false)) ?? true,
  'IterImpl<_, _>::find': ([self, f], ctx) =>
    each(ctx, iterOf(self), (item) => (truthy(call(ctx, f, [item])) ? some(ctx, item) : undefined)) ?? none(ctx),
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
      if (truthy(call(ctx, f, [item]))) return some(ctx, BigInt(index));
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
        const order = compareValues(ctx.typeArgs[0], previous as Value, item);
        previous = item;
        return order === undefined || order > 0 ? false : undefined;
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
  'std::iter::repeat': ([value], ctx) => repeated(ctx, value, Number.POSITIVE_INFINITY),
  'std::iter::repeat_n': ([value, n], ctx) => repeated(ctx, value, Number(n as bigint)),
  'std::iter::once': ([value]) => ownedIter([value]),
  'std::iter::empty': () => ownedIter([]),
  'std::iter::from_fn': ([f], ctx) => {
    const iter = new IterValue(() => optionValue(call(ctx, f, [])));
    iter.fork = () => iter;
    return iter;
  },
  'std::iter::successors': ([first, f], ctx) => successors(ctx, deref(first) as EnumValue, f),
});

/** `repeat` and `repeat_n`: clones of a value, `count` of them. */
function repeated(ctx: NativeContext, value: Value, count: number): IterValue {
  let left = count;
  const take = (): Next => (left-- > 0 ? cloneValue(ctx.typeArgs[0], value) : DONE);
  const iter = new IterValue(take, take, Number.isFinite(count) ? () => Math.max(left, 0) : undefined);
  iter.fork = () => repeated(ctx, value, left);
  return iter;
}

function successors(ctx: NativeContext, start: EnumValue, f: Value): IterValue {
  let current = start;
  const iter = new IterValue(() => {
    if (current.variant === 0) return DONE;
    const value = current.fields[0];
    current = deref(call(ctx, f, [value])) as EnumValue;
    return value;
  });
  iter.fork = () => successors(ctx, current, f);
  return iter;
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
  const values: Value[] = [];
  each(ctx, iter, (item) => {
    const outcome = deref(item) as EnumValue;
    if (outcome.variant !== success) {
      failure = outcome;
      return true;
    }
    values.push(outcome.fields[0]);
    return;
  });
  if (failure) return failure;
  const total = sumOrProduct(ctx, arrayIter(values), t.args[0], op);
  return new EnumValue(t.def, success, [total]);
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
    const lowerAfter = (taken: number): number => (exact === undefined ? 0 : exact - taken);
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
// code-gauge-allow functionNcss 54 -- One native per method of the standard library.
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
      return shallow(t.args[0]).kind === 'str' ? items.map((element) => deref(element) as string).join('') : items;
    }
    case 'BinaryHeap': {
      return heapify([...items], t.args[0]);
    }
    case 'String': {
      return items.map((element) => deref(element) as string).join('');
    }
    case 'HashMap':
    case 'BTreeMap': {
      const map = new MapValue(t.def.builtin === 'BTreeMap');
      sizeTable(map.entries, sizeOf({ kind: 'tuple', elems: t.args }));
      for (const entry of items as Value[][]) {
        const hash = hashKey(t.args[0], entry[0]);
        const existing = map.entries.get(hash);
        if (existing) existing[1] = entry[1];
        else map.entries.set(hash, [entry[0], entry[1]]);
      }
      return map;
    }
    case 'HashSet':
    case 'BTreeSet': {
      const set = new SetValue(t.def.builtin === 'BTreeSet');
      sizeTable(set.entries, sizeOf(t.args[0]));
      for (const element of items) {
        const hash = hashKey(t.args[0], element);
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

/** Builds a max-heap from elements as `BinaryHeap::from(vec)` does: sifting down from the last parent to the root. */
export function heapify(heap: Value[], type: Type): Value[] {
  const end = heap.length;
  for (let index = Math.floor(end / 2) - 1; index >= 0; index--) siftDownRange(heap, index, end, type);
  return heap;
}

function siftDownRange(heap: Value[], start: number, end: number, type: Type): void {
  const element = heap[start];
  let hole = start;
  let child = 2 * hole + 1;
  while (child <= end - 2) {
    if ((compareValues(type, heap[child], heap[child + 1]) ?? 0) <= 0) child++;
    if ((compareValues(type, element, heap[child]) ?? 0) >= 0) {
      heap[hole] = element;
      return;
    }
    heap[hole] = heap[child];
    hole = child;
    child = 2 * hole + 1;
  }
  if (child === end - 1 && (compareValues(type, element, heap[child]) ?? 0) < 0) {
    heap[hole] = heap[child];
    hole = child;
  }
  heap[hole] = element;
}

/** Pushes onto a binary max-heap as `BinaryHeap::push` does (sift up), so that its order matches Rust's. */
export function heapPush(heap: Value[], value: Value, type: Type): void {
  heap.push(value);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if ((compareValues(type, heap[index], heap[parent]) ?? 0) <= 0) break;
    [heap[index], heap[parent]] = [heap[parent], heap[index]];
    index = parent;
  }
}

/** Pops a binary max-heap's top as `BinaryHeap::pop` does: swap with the last, sift down to the bottom, then up. */
export function heapPop(heap: Value[], type: Type): Value | undefined {
  if (heap.length === 0) return undefined;
  const last = heap.pop() as Value;
  if (heap.length === 0) return last;
  const top = heap[0];
  heap[0] = last;
  // sift_down_to_bottom: move the hole to the bottom, then sift up.
  const end = heap.length;
  let hole = 0;
  let child = 1;
  while (child <= end - 2) {
    if ((compareValues(type, heap[child], heap[child + 1]) ?? 0) <= 0) child++;
    heap[hole] = heap[child];
    hole = child;
    child = 2 * hole + 1;
  }
  if (child === end - 1) {
    heap[hole] = heap[child];
    hole = child;
  }
  heap[hole] = last;
  let index = hole;
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if ((compareValues(type, heap[index], heap[parent]) ?? 0) <= 0) break;
    [heap[index], heap[parent]] = [heap[parent], heap[index]];
    index = parent;
  }
  return top;
}

export { castValue, needsCopy, placeOf, SliceView };
