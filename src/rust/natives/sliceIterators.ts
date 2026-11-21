import type { DebugPart } from '../debugText';
import { normalize } from '../infer';
import { described, fieldsPart, listPart, numberPart } from '../iterDebug';
import { cloneValue } from '../ops';
import { shallow, type Type } from '../types';
import {
  AccessorPlace,
  DONE,
  IterValue,
  type Next,
  sliceBase,
  sliceItems,
  sliceLength,
  SliceView,
  type Value,
} from '../values';
import { arrayIter } from './iterators';
import { call, deref, type NativeContext, panic } from './support';

export function windows(ctx: NativeContext, slice: Value, size: bigint): IterValue {
  // The width is shown as it was given, and used as a number, which rounds above 2^53 where no window fits anyway.
  const width = Number(size);
  if (width === 0) panic(ctx, 'window size must be non-zero');
  const { base, start } = sliceBase(slice);
  return windowsCursor(base, start, start + sliceLength(slice), width, size);
}

function windowsCursor(base: Value[], front: number, back: number, width: number, size: bigint): IterValue {
  const remaining = (): number => Math.max(0, back - front - width + 1);
  const view = (start: number): SliceView => new SliceView(base, start, start + width);
  const take = (n: bigint, reverse: boolean): ReturnType<IterValue['next']> => {
    if (n >= BigInt(remaining())) {
      back = front;
      return DONE;
    }
    const step = Number(n);
    if (!reverse) {
      front += step + 1;
      return view(front - 1);
    }
    back -= step + 1;
    return view(back + 1 - width);
  };
  const iter = new IterValue(
    () => (remaining() === 0 ? DONE : take(0n, false)),
    () => take(0n, true),
    remaining
  );
  iter.borrowedRoots.push(base);
  iter.nth = (n) => take(n, false);
  iter.nthBack = (n) => take(n, true);
  iter.rest = () => Array.from({ length: remaining() }, (_, index) => view(front + index));
  iter.fork = () => windowsCursor(base, front, back, width, size);
  return described(iter, (show, item) =>
    fieldsPart('Windows', [
      ['v', listPart(base.slice(front, back), sliceElem(item), show)],
      ['size', numberPart(size)],
    ])
  );
}

/**
 * `{:?}` of `Chunks`, `RChunks`, and `ChunksExact`: `v`, the part of the slice their elements left cover
 * (`done` once none is left), then their other fields; `ChunksExact` also shows the remainder `rem`.
 */
function chunkDebug(
  iter: IterValue,
  name: string,
  done: (target: IterValue) => SliceView,
  fields: (part: (values: Value[]) => DebugPart) => [string, DebugPart][]
): IterValue {
  return described(iter, (show, item, target) => {
    const elem = sliceElem(item);
    const views = (target.rest?.() ?? []) as SliceView[];
    let from = Number.POSITIVE_INFINITY;
    let to = 0;
    for (const view of views) {
      from = Math.min(from, view.start);
      to = Math.max(to, view.end);
    }
    const covered = views.length > 0 ? sliceItems(new SliceView(views[0].base, from, to)) : sliceItems(done(target));
    const part = (values: Value[]): DebugPart => listPart(values, elem, show);
    return fieldsPart(name, [['v', part(covered)], ...fields(part)]);
  });
}

/** The element type of the slices an iterator yields (`&[T]`). */
function sliceElem(item: Type): Type {
  let t = normalize(shallow(item));
  if (t.kind === 'ref') t = normalize(shallow(t.target));
  return t.kind === 'slice' || t.kind === 'array' ? t.elem : t;
}

// code-gauge-allow functionCognitiveComplexity 17 -- All six chunk methods share the same window and remainder calculations.
export function chunksNative(
  exact: boolean,
  reverse: boolean,
  mutable: boolean
): (args: Value[], ctx: NativeContext) => IterValue {
  return ([self, size], ctx) => {
    const width = Number(size as bigint);
    if (width === 0) panic(ctx, 'chunk size must be non-zero');
    const slice = deref(self);
    const { base, start } = sliceBase(slice);
    const length = sliceLength(slice);
    const count = exact ? Math.floor(length / width) : Math.ceil(length / width);
    const iter = arrayIter(base, 0, count, (index) => {
      const [from, to] = chunkBounds(length, width, index, reverse);
      const view = new SliceView(base, start + from, start + to);
      return mutable ? mutableSlice(view) : view;
    });
    if (mutable) return iter;
    const name = `${reverse ? 'RChunks' : 'Chunks'}${exact ? 'Exact' : ''}`;
    const done = (): SliceView => new SliceView(base, start, start);
    const chunkSize: [string, DebugPart] = ['chunk_size', numberPart(size as bigint)];
    if (!exact) return chunkDebug(iter, name, done, () => [chunkSize]);
    const remainder = length % width;
    const offset = reverse ? start : start + length - remainder;
    const rem = new SliceView(base, offset, offset + remainder);
    return chunkDebug(iter, name, done, (part) => [['rem', part(sliceItems(rem))], chunkSize]);
  };
}

function chunkBounds(length: number, width: number, index: number, reverse: boolean): [number, number] {
  if (reverse) {
    const end = length - index * width;
    return [Math.max(0, end - width), end];
  }
  const start = index * width;
  return [start, Math.min(length, start + width)];
}

export function mutableSlice(view: SliceView): AccessorPlace {
  return new AccessorPlace(
    () => view,
    () => {}
  );
}

interface SplitState {
  front: number;
  back: number;
  count?: bigint;
  finished: boolean;
}

export function splitSlice(
  ctx: NativeContext,
  slice: Value,
  predicate: Value,
  count?: bigint,
  reverse = false
): IterValue {
  const { base, start } = sliceBase(slice);
  return splitCursor(
    ctx,
    base,
    { front: start, back: start + sliceLength(slice), count, finished: false },
    predicate,
    reverse
  );
}

function splitCursor(
  ctx: NativeContext,
  base: Value[],
  state: SplitState,
  predicate: Value,
  reverse: boolean
): IterValue {
  const take = (backwards: boolean): Next => {
    if (state.finished || state.count === 0n) return DONE;
    if (state.count !== undefined && --state.count === 0n) return finishSplit(base, state);
    const separator = nextSeparator(ctx, base, state, predicate, backwards);
    if (separator === undefined) return finishSplit(base, state);
    if (backwards) {
      const item = new SliceView(base, separator + 1, state.back);
      state.back = separator;
      return item;
    }
    const item = new SliceView(base, state.front, separator);
    state.front = separator + 1;
    return item;
  };
  const iter = new IterValue(
    () => take(reverse),
    state.count === undefined ? () => take(!reverse) : undefined,
    undefined,
    [predicate]
  );
  iter.borrowedRoots.push(base);
  iter.fork = () => splitCursor(ctx, base, { ...state }, cloneValue(ctx.typeArgs[1], predicate), reverse);
  return described(iter, (show, item) =>
    splitDebug(state, reverse, (indent, sink) => show(new SliceView(base, state.front, state.back), item, indent, sink))
  );
}

function splitDebug(state: SplitState, reverse: boolean, view: DebugPart): DebugPart {
  const inner = fieldsPart(reverse ? 'RSplit' : 'Split', [
    ['v', view],
    ['finished', numberPart(state.finished)],
  ]);
  if (state.count === undefined) return inner;
  return fieldsPart(reverse ? 'RSplitN' : 'SplitN', [
    [
      'inner',
      fieldsPart('GenericSplitN', [
        ['iter', inner],
        ['count', numberPart(state.count)],
      ]),
    ],
  ]);
}

function finishSplit(base: Value[], state: SplitState): SliceView {
  state.finished = true;
  return new SliceView(base, state.front, state.back);
}

function nextSeparator(
  ctx: NativeContext,
  base: Value[],
  state: SplitState,
  predicate: Value,
  reverse: boolean
): number | undefined {
  const start = reverse ? state.back - 1 : state.front;
  const end = reverse ? state.front - 1 : state.back;
  for (let index = start; index !== end; index += reverse ? -1 : 1) {
    ctx.runtime.spend();
    if (call(ctx, predicate, [base[index]])) return index;
  }
}

export function groupedSlice(ctx: NativeContext, slice: Value, predicate: Value): IterValue {
  const { base, start } = sliceBase(slice);
  return groupedCursor(ctx, base, start, start + sliceLength(slice), predicate);
}

function groupedCursor(ctx: NativeContext, base: Value[], front: number, back: number, predicate: Value): IterValue {
  const equal = (left: number, right: number): boolean => {
    ctx.runtime.spend();
    return !!deref(call(ctx, predicate, [base[left], base[right]]));
  };
  const next = (): Next => {
    if (front === back) return DONE;
    const start = front++;
    while (front < back && equal(front - 1, front)) front++;
    return new SliceView(base, start, front);
  };
  const nextBack = (): Next => {
    if (front === back) return DONE;
    const end = back--;
    while (front < back && equal(back - 1, back)) back--;
    return new SliceView(base, back, end);
  };
  const iter = new IterValue(next, nextBack, undefined, [predicate]);
  iter.borrowedRoots.push(base);
  iter.fork = () => groupedCursor(ctx, base, front, back, cloneValue(ctx.typeArgs[1], predicate));
  return described(iter, (show, item) =>
    fieldsPart('ChunkBy', [['slice', (indent, sink) => show(new SliceView(base, front, back), item, indent, sink)]])
  );
}
