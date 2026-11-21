// code-gauge-allow-file fileNcss 541 -- One native per method of the standard library.
import {
  exactCapacity,
  keepVecCapacity,
  reserveVec,
  setIntoIterBuffer,
  setVecCapacity,
  vecCapacity,
} from '../capacity';
import { sliceRange } from '../compiler';
import { normalize } from '../infer';
import {
  cloneValue,
  compareValues,
  copyValue,
  needsCopy,
  testPartialOrder,
  valuesEqual,
  withCloneResults,
} from '../ops';
import { MOVED, RustPanic } from '../runtime';
import { shallow, type Type } from '../types';
import {
  DONE,
  ElementPlace,
  type IterValue,
  RangeValue,
  sliceBase,
  sliceGet,
  sliceItems,
  sliceLength,
  type SliceView,
  swapOwnedElements,
  textOf,
  UNIT_VALUE,
  type Value,
} from '../values';
import { allocVecElements, checkVecCapacity, extendRoom, repeatedLength, withCapacity } from './capacityNatives';
import { cloneInto } from './cloning';
import { dequeDrain, dequeIterator, dequeRange, dequeSlices, withDequeHead } from './dequeHead';
import {
  collectVec,
  extendedValue,
  heapIntoSortedVec,
  heapPop,
  heapPush,
  isTrustedLen,
  nextForFold,
  nextOf,
  ownedIter,
  rebuildHeapTail,
  sliceIter,
} from './iterators';
import { layoutOf, sizeOf } from './layout';
import { checkedRangeBounds } from './ranges';
import { chunksNative, groupedSlice, mutableSlice, splitSlice, windows } from './sliceIterators';
import { compareByKey, dedupBy, lessByKey, lessByPartialOrd, sortByCachedKey, sortSlice } from './sorting';
import {
  call,
  callForEach,
  define,
  deref,
  err,
  libraryPanic,
  type NativeContext,
  none,
  ok,
  option,
  ordering,
  panic,
  placeOf,
  some,
} from './support';

function vec(self: Value): Value[] {
  return deref(self) as Value[];
}

function elemType(ctx: NativeContext): Type {
  return ctx.typeArgs[0];
}

function retainElements(items: Value[], keep: (item: ElementPlace) => boolean): Value {
  keepVecCapacity(items, items.length);
  let write = 0;
  let read = 0;
  try {
    for (; read < items.length; read++) {
      if (keep(new ElementPlace(items, read))) swapOwnedElements(items, write++, read);
      else items[read] = MOVED;
    }
  } finally {
    if (write < read) {
      for (; read < items.length; read++) swapOwnedElements(items, write++, read);
      items.length = write;
    }
  }
  return UNIT_VALUE;
}

function cmpWith(ctx: NativeContext, f: Value): (a: Value, b: Value) => number {
  return (a, b) => {
    ctx.runtime.spend();
    return (deref(call(ctx, f, [a, b])) as { variant: number }).variant - 1;
  };
}

/** `get` with a range: the part of the slice it covers, or `None` when it reaches outside. */
function subslice(ctx: NativeContext, slice: Value, range: Value, mutable = false): Value {
  try {
    const view = sliceRange(slice, deref(range) as RangeValue | undefined, ctx.span);
    return some(ctx, mutable ? mutableSlice(view) : view);
  } catch (error) {
    if (error instanceof RustPanic) return none(ctx);
    throw error;
  }
}

function checkIndex(ctx: NativeContext, index: Value, length: number, what: string): void {
  if ((index as bigint) >= BigInt(length))
    panic(ctx, `${what} index (is ${index as bigint}) should be < len (is ${length})`);
}

function binarySearch(slice: Value, compare: (item: Value) => number): { found: boolean; index: number } {
  // Rust's binary search (1.52+): returns the found index of the search that halves the size.
  let size = sliceLength(slice);
  if (size === 0) return { found: false, index: 0 };
  let base = 0;
  while (size > 1) {
    const half = size >> 1;
    const mid = base + half;
    if (compare(sliceGet(slice, mid)) <= 0) base = mid;
    size -= half;
  }
  const order = compare(sliceGet(slice, base));
  if (order === 0) return { found: true, index: base };
  return { found: false, index: base + (order < 0 ? 1 : 0) };
}

const sliceNatives: Record<string, (args: Value[], ctx: NativeContext) => Value> = {
  len: ([self]) => BigInt(sliceLength(deref(self))),
  is_empty: ([self]) => sliceLength(deref(self)) === 0,
  first: ([self], ctx) => {
    const slice = deref(self);
    return option(ctx, sliceGet(slice, 0), sliceLength(slice) > 0);
  },
  last: ([self], ctx) => {
    const slice = deref(self);
    return option(ctx, sliceGet(slice, sliceLength(slice) - 1), sliceLength(slice) > 0);
  },
  first_mut: ([self], ctx) => {
    const slice = deref(self);
    const { base, start } = sliceBase(slice);
    return option(ctx, new ElementPlace(base, start), sliceLength(slice) > 0);
  },
  last_mut: ([self], ctx) => {
    const slice = deref(self);
    const { base, start } = sliceBase(slice);
    return option(ctx, new ElementPlace(base, start + sliceLength(slice) - 1), sliceLength(slice) > 0);
  },
  get: ([self, index], ctx) => {
    const slice = deref(self);
    if (typeof index !== 'bigint') return subslice(ctx, slice, index);
    const position = Number(index);
    return option(ctx, sliceGet(slice, position), position < sliceLength(slice));
  },
  get_mut: ([self, index], ctx) => {
    const slice = deref(self);
    if (typeof index !== 'bigint') return subslice(ctx, slice, index, true);
    const position = Number(index);
    const { base, start } = sliceBase(slice);
    return option(ctx, new ElementPlace(base, start + position), position < sliceLength(slice));
  },
  iter: ([self]) => sliceIter(deref(self), false),
  iter_mut: ([self]) => sliceIter(deref(self), true),
  contains: ([self, x], ctx) => sliceItems(deref(self)).some((item) => valuesEqual(elemType(ctx), item, x)),
  starts_with: ([self, needle], ctx) => {
    const items = sliceItems(deref(self));
    const prefix = sliceItems(deref(needle));
    return (
      prefix.length <= items.length && prefix.every((item, index) => valuesEqual(elemType(ctx), item, items[index]))
    );
  },
  ends_with: ([self, needle], ctx) => {
    const items = sliceItems(deref(self));
    const suffix = sliceItems(deref(needle));
    const offset = items.length - suffix.length;
    return offset >= 0 && suffix.every((item, index) => valuesEqual(elemType(ctx), item, items[offset + index]));
  },
  sort: ([self], ctx) => {
    sortSlice(ctx, deref(self), true, lessByPartialOrd(elemType(ctx)));
    return UNIT_VALUE;
  },
  sort_unstable: ([self], ctx) => {
    sortSlice(ctx, deref(self), false, lessByPartialOrd(elemType(ctx)));
    return UNIT_VALUE;
  },
  sort_by: ([self, f], ctx) => {
    const compare = cmpWith(ctx, f);
    sortSlice(ctx, deref(self), true, (a, b) => compare(a, b) < 0);
    return UNIT_VALUE;
  },
  sort_unstable_by: ([self, f], ctx) => {
    const compare = cmpWith(ctx, f);
    sortSlice(ctx, deref(self), false, (a, b) => compare(a, b) < 0);
    return UNIT_VALUE;
  },
  sort_by_key: ([self, f], ctx) => {
    sortSlice(ctx, deref(self), true, lessByKey(ctx, f));
    return UNIT_VALUE;
  },
  sort_unstable_by_key: ([self, f], ctx) => {
    sortSlice(ctx, deref(self), false, lessByKey(ctx, f));
    return UNIT_VALUE;
  },
  sort_by_cached_key: ([self, f], ctx) => {
    sortByCachedKey(ctx, deref(self), f);
    return UNIT_VALUE;
  },
  is_sorted: ([self], ctx) => sliceIsSorted(sliceItems(deref(self)), elemType(ctx)),
  reverse: ([self], ctx) => {
    const slice = deref(self);
    const length = sliceLength(slice);
    ctx.runtime.spend(Math.ceil(length / 64));
    const { base, start } = sliceBase(slice);
    reverseElements(base, start, start + length);
    return UNIT_VALUE;
  },
  binary_search: ([self, x], ctx) => {
    const result = binarySearch(deref(self), (item) => compareValues(elemType(ctx), item, x) ?? 0);
    return result.found ? ok(ctx, BigInt(result.index)) : err(ctx, BigInt(result.index));
  },
  binary_search_by_key: ([self, b, f], ctx) => {
    const keyType = ctx.typeArgs[1];
    const result = binarySearch(deref(self), (item) => compareValues(keyType, call(ctx, f, [item]), b) ?? 0);
    return result.found ? ok(ctx, BigInt(result.index)) : err(ctx, BigInt(result.index));
  },
  binary_search_by: ([self, f], ctx) => {
    const result = binarySearch(
      deref(self),
      (item) => (deref(call(ctx, f, [item])) as { variant: number }).variant - 1
    );
    return result.found ? ok(ctx, BigInt(result.index)) : err(ctx, BigInt(result.index));
  },
  partition_point: ([self, f], ctx) =>
    BigInt(binarySearch(deref(self), (item) => (call(ctx, f, [item]) ? -1 : 1)).index),
  swap: ([self, a, b], ctx) => {
    const slice = deref(self);
    const i = Number(a as bigint);
    const j = Number(b as bigint);
    const length = sliceLength(slice);
    // A `usize` is formatted from the argument itself, which a number rounds above 2^53.
    for (const index of [a, b] as bigint[]) {
      if (index >= BigInt(length)) panic(ctx, `index out of bounds: the len is ${length} but the index is ${index}`);
    }
    const { base, start } = sliceBase(slice);
    swapOwnedElements(base, start + i, start + j);
    return UNIT_VALUE;
  },
  split_at: ([self, mid], ctx) => splitAt(ctx, deref(self), Number(mid as bigint)),
  split_at_mut: ([self, mid], ctx) => {
    return splitAt(ctx, deref(self), Number(mid as bigint)).map(mutableSlice);
  },
  split_first: ([self], ctx) => splitEnd(ctx, deref(self), true, false),
  split_last: ([self], ctx) => splitEnd(ctx, deref(self), false, false),
  split_first_mut: ([self], ctx) => splitEnd(ctx, deref(self), true, true),
  split_last_mut: ([self], ctx) => splitEnd(ctx, deref(self), false, true),
  copy_within: ([self, source, destination], ctx) => copyWithin(ctx, deref(self), source, destination as bigint),
  windows: ([self, size], ctx) => windows(ctx, deref(self), size as bigint),
  split: ([self, predicate], ctx) => splitSlice(ctx, deref(self), predicate),
  splitn: ([self, count, predicate], ctx) => splitSlice(ctx, deref(self), predicate, count as bigint),
  rsplitn: ([self, count, predicate], ctx) => splitSlice(ctx, deref(self), predicate, count as bigint, true),
  chunks: chunksNative(false, false, false),
  chunks_exact: chunksNative(true, false, false),
  chunks_mut: chunksNative(false, false, true),
  chunks_exact_mut: chunksNative(true, false, true),
  rchunks: chunksNative(false, true, false),
  rchunks_exact: chunksNative(true, true, false),
  rchunks_mut: chunksNative(false, true, true),
  rchunks_exact_mut: chunksNative(true, true, true),
  chunk_by: ([self, predicate], ctx) => groupedSlice(ctx, deref(self), predicate),
  fill: ([self, value], ctx) => fillSlice(ctx, deref(self), value, elemType(ctx)),
  to_vec: ([self], ctx) => clonedItems(ctx, sliceItems(deref(self))),
  to_owned: ([self], ctx) => clonedItems(ctx, sliceItems(deref(self))),
  into_vec: ([self]) => exactCapacity(sliceItems(deref(self))),
  rotate_left: ([self, mid], ctx) => {
    const slice = deref(self);
    if (Number(mid as bigint) > sliceLength(slice)) {
      libraryPanic(ctx, 'assertion failed: mid <= self.len()', 'core/src/slice/mod.rs:3904:9');
    }
    return rotate(slice, Number(mid as bigint), ctx);
  },
  rotate_right: ([self, k], ctx) => {
    const slice = deref(self);
    if (Number(k as bigint) > sliceLength(slice)) {
      libraryPanic(ctx, 'assertion failed: k <= self.len()', 'core/src/slice/mod.rs:3950:9');
    }
    return rotate(slice, sliceLength(slice) - Number(k as bigint), ctx);
  },
  copy_from_slice: ([self, src], ctx) => copyFrom(ctx, deref(self), deref(src)),
  clone_from_slice: ([self, src], ctx) => copyFrom(ctx, deref(self), deref(src), elemType(ctx)),
  repeat: ([self, n], ctx) => {
    const items = sliceItems(deref(self));
    const count = repeatedLength(ctx, items.length, n as bigint);
    const length = allocVecElements(ctx, 0, count, sizeOf(elemType(ctx)));
    return Array.from({ length }, (_, index) => copyValue(items[index % items.length]));
  },
};

function fillSlice(ctx: NativeContext, slice: Value, value: Value, type: Type): Value {
  const length = sliceLength(slice);
  if (length === 0) return UNIT_VALUE;
  const { base, start } = sliceBase(slice);
  const last = start + length - 1;
  for (let index = start; index < last; index++) {
    cloneInto(ctx, type, new ElementPlace(base, index), value);
  }
  base[last] = value;
  return UNIT_VALUE;
}

function rangeFrom(start: number): RangeValue {
  return new RangeValue(BigInt(start), undefined, false);
}

function rangeTo(end: number): RangeValue {
  return new RangeValue(undefined, BigInt(end), false);
}

function splitAt(ctx: NativeContext, slice: Value, mid: number): [SliceView, SliceView] {
  if (mid > sliceLength(slice)) panic(ctx, 'mid > len');
  return [sliceRange(slice, rangeTo(mid), ctx.span), sliceRange(slice, rangeFrom(mid), ctx.span)];
}

function splitEnd(ctx: NativeContext, slice: Value, first: boolean, mutable: boolean): Value {
  const length = sliceLength(slice);
  if (length === 0) return none(ctx);
  const index = first ? 0 : length - 1;
  const rest = sliceRange(slice, first ? rangeFrom(1) : rangeTo(index), ctx.span);
  if (!mutable) return some(ctx, [sliceGet(slice, index), rest]);
  const { base, start } = sliceBase(slice);
  return some(ctx, [new ElementPlace(base, start + index), mutableSlice(rest)]);
}

function copyWithin(ctx: NativeContext, slice: Value, range: Value, dest: bigint): Value {
  const length = sliceLength(slice);
  const [from, to] = checkedRangeBounds(ctx, range, length);
  const count = to - from;
  if (dest > BigInt(length - count)) panic(ctx, 'dest is out of bounds');
  const { base, start } = sliceBase(slice);
  const target = start + Number(dest);
  ctx.runtime.spend(count);
  if (needsCopy(elemType(ctx))) {
    const copied = base.slice(start + from, start + to).map(copyValue);
    for (const [offset, value] of copied.entries()) base[target + offset] = value;
  } else base.copyWithin(target, start + from, start + to);
  return UNIT_VALUE;
}

function sliceIsSorted(items: Value[], type: Type): boolean {
  let index = 0;
  const pairsPerChunk = 32;
  while (index + pairsPerChunk + 1 < items.length) {
    let sorted = true;
    for (const end = index + pairsPerChunk; index < end; index++) {
      sorted = testPartialOrder('le', type, items[index], items[index + 1]) && sorted;
    }
    if (!sorted) return false;
  }
  for (; index + 1 < items.length; index++) {
    if (!testPartialOrder('le', type, items[index], items[index + 1])) return false;
  }
  return true;
}

function rotate(slice: Value, mid: number, ctx: NativeContext): Value {
  const length = sliceLength(slice);
  if (length === 0) return UNIT_VALUE;
  const shift = ((mid % length) + length) % length;
  if (shift === 0) return UNIT_VALUE;
  ctx.runtime.spend(Math.ceil(length / 64));
  const { base, start } = sliceBase(slice);
  reverseElements(base, start, start + shift);
  reverseElements(base, start + shift, start + length);
  reverseElements(base, start, start + length);
  return UNIT_VALUE;
}

function reverseElements(items: Value[], start: number, end: number): void {
  for (let left = start, right = end - 1; left < right; left++, right--) swapOwnedElements(items, left, right);
}

function copyFrom(ctx: NativeContext, target: Value, source: Value, cloneType?: Type): Value {
  const items = sliceItems(source);
  const length = sliceLength(target);
  const trivial = !cloneType || isTrivialClone(cloneType);
  if (items.length !== length) {
    panic(
      ctx,
      trivial
        ? `copy_from_slice: source slice length (${items.length}) does not match destination slice length (${length})`
        : 'destination and source slices have different lengths'
    );
  }
  const { base, start } = sliceBase(target);
  for (const [index, item] of items.entries()) {
    if (trivial) base[start + index] = copyValue(item);
    else cloneInto(ctx, cloneType, new ElementPlace(base, start + index), item);
  }
  return UNIT_VALUE;
}

function isTrivialClone(type: Type): boolean {
  const t = shallow(type);
  switch (t.kind) {
    case 'int':
    case 'float':
    case 'bool':
    case 'char':
    case 'fn':
    case 'never': {
      return true;
    }
    case 'ref': {
      return !t.mutable;
    }
    case 'tuple': {
      return t.elems.every(isTrivialClone);
    }
    case 'array': {
      return isTrivialClone(t.elem);
    }
    case 'adt': {
      if (t.def.builtin === 'Option') return isTrivialClone(t.args[0]);
      return t.def.params.length === 0 && t.def.derives.has('Copy') && t.def.derives.has('Clone');
    }
    default: {
      return false;
    }
  }
}

/** Clones of a slice's elements, as a new `Vec` holds them. */
function clonedItems(ctx: NativeContext, items: Value[]): Value[] {
  ctx.runtime.allocate(items.length);
  return withCloneResults(() => items.map((item) => cloneValue(elemType(ctx), item)));
}

function joinSlices(ctx: NativeContext, slices: Value, separator: Value): Value[] {
  const count = sliceLength(slices);
  const separatorSize = BigInt(sliceLength(separator));
  let length = BigInt(Math.max(0, count - 1)) * separatorSize;
  for (let i = 0; i < count; i++) {
    ctx.runtime.spend();
    length += BigInt(sliceLength(deref(sliceGet(slices, i))));
  }
  const elem = elemType(ctx);
  const size = sizeOf(elem);
  checkVecCapacity(ctx, 0, length, size);
  ctx.runtime.allocate(Number(length), length * BigInt(size));
  const joined: Value[] = [];
  return ctx.runtime.withRoots(joined, () => {
    for (let i = 0; i < count; i++) {
      ctx.runtime.spend();
      if (i > 0) appendClones(ctx, joined, elem, separator);
      appendClones(ctx, joined, elem, deref(sliceGet(slices, i)));
    }
    return joined;
  });
}

function appendClones(ctx: NativeContext, dest: Value[], elem: Type, source: Value): void {
  const length = sliceLength(source);
  for (let i = 0; i < length; i++) {
    ctx.runtime.spend();
    dest.push(cloneValue(elem, sliceGet(source, i)));
  }
}

function joinStrings(ctx: NativeContext, self: Value, sep: Value): string {
  const parts = sliceItems(deref(self)).map(textOf);
  const separator = textOf(sep);
  const length = parts.reduce((sum, part) => sum + part.length, 0) + separator.length * Math.max(0, parts.length - 1);
  ctx.runtime.allocateString(length);
  return parts.join(separator);
}

const vecNatives: Record<string, (args: Value[], ctx: NativeContext) => Value> = {
  new: () => [],
  from_iter: ([iter], ctx) => collectVec(ctx, deref(iter) as IterValue, ctx.typeArgs[1], elemType(ctx)),
  push: ([self, value], ctx) => {
    ctx.runtime.allocate(1);
    vec(self).push(value);
    return UNIT_VALUE;
  },
  pop: ([self], ctx) => {
    const items = vec(self);
    return items.length === 0 ? none(ctx) : some(ctx, items.pop());
  },
  insert: ([self, index, element], ctx) => {
    const items = vec(self);
    const position = Number(index as bigint);
    if (position > items.length) {
      panic(ctx, `insertion index (is ${index as bigint}) should be <= len (is ${items.length})`);
    }
    ctx.runtime.allocate(1);
    items.splice(position, 0, element);
    return UNIT_VALUE;
  },
  remove: ([self, index], ctx) => {
    const items = vec(self);
    const position = Number(index as bigint);
    checkIndex(ctx, index, items.length, 'removal');
    return items.splice(position, 1)[0];
  },
  swap_remove: ([self, index], ctx) => {
    const items = vec(self);
    const position = Number(index as bigint);
    if (position >= items.length) {
      libraryPanic(
        ctx,
        `swap_remove index (is ${index as bigint}) should be < len (is ${items.length})`,
        'alloc/src/vec/mod.rs:2258:13'
      );
    }
    swapOwnedElements(items, position, items.length - 1);
    return items.pop();
  },
  truncate: ([self, len]) => {
    const items = vec(self);
    const length = Number(len as bigint);
    if (length < items.length) items.length = length;
    return UNIT_VALUE;
  },
  clear: ([self]) => {
    vec(self).length = 0;
    return UNIT_VALUE;
  },
  extend: ([self, iter], ctx) => {
    const items = vec(self);
    const iterator = deref(iter) as IterValue;
    const next = isTrustedLen(ctx.typeArgs[2]) ? nextForFold : nextOf;
    const convert = extendedValue(elemType(ctx), ctx.typeArgs[1]);
    const room = extendRoom(ctx, items, iterator, ctx.typeArgs[2]);
    for (;;) {
      ctx.runtime.spend();
      const item = next(iterator);
      if (item === DONE) break;
      room();
      ctx.runtime.allocate(1);
      items.push(convert(item));
    }
    return UNIT_VALUE;
  },
  extend_from_slice: ([self, other], ctx) => {
    const items = vec(self);
    for (const item of clonedItems(ctx, sliceItems(deref(other)))) items.push(item);
    return UNIT_VALUE;
  },
  append: ([self, other]) => {
    const target = vec(self);
    const source = vec(other);
    keepVecCapacity(source, source.length);
    for (const item of source) target.push(item);
    source.length = 0;
    return UNIT_VALUE;
  },
  drain: ([self, range], ctx) => {
    const items = vec(self);
    const [start, end] = checkedRangeBounds(ctx, range, items.length);
    return ownedIter(items.splice(start, end - start), elemType(ctx));
  },
  retain: ([self, f], ctx) => retainElements(vec(self), (item) => deref(call(ctx, f, [item.get()])) as boolean),
  retain_mut: ([self, f], ctx) => retainElements(vec(self), (item) => deref(call(ctx, f, [item])) as boolean),
  dedup: ([self], ctx) => dedupBy(vec(self), (current, kept) => valuesEqual(elemType(ctx), current.get(), kept.get())),
  dedup_by: ([self, f], ctx) => dedupBy(vec(self), (current, kept) => call(ctx, f, [current, kept]) as boolean),
  dedup_by_key: ([self, f], ctx) => dedupBy(vec(self), compareByKey(ctx, f, valuesEqual)),
  resize: ([self, newLen, value], ctx) =>
    resizeVec(ctx, vec(self), newLen as bigint, (last) => (last ? value : cloneValue(elemType(ctx), value))),
  resize_with: ([self, newLen, f], ctx) => resizeVec(ctx, vec(self), newLen as bigint, () => call(ctx, f, [])),
  split_off: ([self, at], ctx) => {
    const items = vec(self);
    const position = Number(at as bigint);
    if (position > items.length)
      panic(ctx, `\`at\` split index (is ${at as bigint}) should be <= len (is ${items.length})`);
    return items.splice(position);
  },
  as_slice: ([self]) => vec(self),
  as_mut_slice: ([self]) => self,
  into_boxed_slice: ([self]) => exactCapacity(vec(self)),
  is_empty: ([self]) => vec(self).length === 0,
  len: ([self]) => BigInt(vec(self).length),
  into_iter: ([self], ctx) => {
    const items = vec(self);
    const iter = ownedIter(items, elemType(ctx));
    const elem = layoutOf(elemType(ctx));
    setIntoIterBuffer(iter, vecCapacity(items, items.length, elem.size), elem);
    return iter;
  },
};

function resizeVec(ctx: NativeContext, items: Value[], newLen: bigint, create: (last: boolean) => Value): Value {
  const additional = newLen - BigInt(items.length);
  if (additional < 0n) items.length = Number(newLen);
  else if (additional > 0n) {
    const length = items.length + allocVecElements(ctx, items.length, additional, sizeOf(elemType(ctx)));
    while (items.length < length) {
      ctx.runtime.spend();
      items.push(create(items.length === length - 1));
    }
  }
  return UNIT_VALUE;
}

const dequeNatives: Record<string, (args: Value[], ctx: NativeContext) => Value> = {
  new: () => [],
  with_capacity: () => [],
  push_back: ([self, value], ctx) => {
    ctx.runtime.allocate(1);
    vec(self).push(value);
    return UNIT_VALUE;
  },
  push_front: ([self, value], ctx) => {
    ctx.runtime.allocate(1);
    vec(self).unshift(value);
    return UNIT_VALUE;
  },
  pop_back: ([self], ctx) => {
    const items = vec(self);
    return items.length === 0 ? none(ctx) : some(ctx, items.pop());
  },
  pop_front: ([self], ctx) => {
    const items = vec(self);
    return items.length === 0 ? none(ctx) : some(ctx, items.shift());
  },
  split_off: ([self, at], ctx) => {
    const items = vec(self);
    const index = at as bigint;
    if (index > BigInt(items.length)) {
      libraryPanic(ctx, '`at` out of bounds', 'alloc/src/collections/vec_deque/mod.rs:2672:9');
    }
    const count = items.length - Number(index);
    ctx.runtime.allocate(count, BigInt(count) * BigInt(sizeOf(elemType(ctx))));
    const tail = items.splice(Number(index));
    setVecCapacity(tail, count);
    return tail;
  },
  front: ([self], ctx) => option(ctx, vec(self)[0], vec(self).length > 0),
  back: ([self], ctx) => option(ctx, vec(self).at(-1), vec(self).length > 0),
  front_mut: ([self], ctx) => option(ctx, new ElementPlace(vec(self), 0), vec(self).length > 0),
  back_mut: ([self], ctx) => option(ctx, new ElementPlace(vec(self), vec(self).length - 1), vec(self).length > 0),
  get: ([self, index], ctx) => sliceNatives.get([self, index], ctx),
  get_mut: ([self, index], ctx) => sliceNatives.get_mut([self, index], ctx),
  len: ([self]) => BigInt(vec(self).length),
  is_empty: ([self]) => vec(self).length === 0,
  clear: ([self]) => {
    vec(self).length = 0;
    return UNIT_VALUE;
  },
  contains: ([self, x], ctx) => sliceNatives.contains([self, x], ctx),
  iter: ([self], ctx) => dequeIterator(vec(self), elemType(ctx), 'ref'),
  range: ([self, range], ctx) => {
    const items = vec(self);
    const [start, end] = checkedRangeBounds(ctx, range, items.length);
    return dequeRange(items, dequeCapacity(items, ctx), start, end);
  },
  iter_mut: ([self], ctx) => dequeIterator(vec(self), elemType(ctx), 'mut'),
  as_slices: ([self], ctx) => dequeSlices(vec(self), dequeCapacity(vec(self), ctx)),
  insert: ([self, index, value], ctx) => {
    const items = vec(self);
    const position = Number(index as bigint);
    if (position > items.length) {
      libraryPanic(ctx, 'index out of bounds', 'alloc/src/collections/vec_deque/mod.rs:2564:9');
    }
    ctx.runtime.allocate(1);
    items.splice(position, 0, value);
    return UNIT_VALUE;
  },
  remove: ([self, index], ctx) => {
    const items = vec(self);
    const position = Number(index as bigint);
    if (position >= items.length) return none(ctx);
    return some(ctx, items.splice(position, 1)[0]);
  },
  extend: ([self, iter], ctx) => vecNatives.extend([self, iter], ctx),
  retain: ([self, f], ctx) => retainDeque(vec(self), (item) => deref(call(ctx, f, [item.get()])) as boolean),
  retain_mut: ([self, f], ctx) => retainDeque(vec(self), (item) => deref(call(ctx, f, [item])) as boolean),
  truncate: ([self, len], ctx) => vecNatives.truncate([self, len], ctx),
  swap: ([self, a, b], ctx) => {
    const items = vec(self);
    const i = Number(a as bigint);
    const j = Number(b as bigint);
    const location = 'alloc/src/collections/vec_deque/mod.rs';
    if (i >= items.length) libraryPanic(ctx, 'assertion failed: i < self.len()', `${location}:1030:9`);
    if (j >= items.length) libraryPanic(ctx, 'assertion failed: j < self.len()', `${location}:1031:9`);
    swapOwnedElements(items, i, j);
    return UNIT_VALUE;
  },
  rotate_left: ([self, n], ctx) => rotateDeque(ctx, vec(self), n as bigint, false),
  rotate_right: ([self, n], ctx) => rotateDeque(ctx, vec(self), n as bigint, true),
  make_contiguous: ([self]) => self,
  drain: ([self, range], ctx) => {
    const items = vec(self);
    const [start, end] = checkedRangeBounds(ctx, range, items.length);
    return dequeDrain(items, start, end, dequeCapacity(items, ctx), elemType(ctx));
  },
  into_iter: ([self], ctx) => dequeIterator(vec(self), elemType(ctx), 'value'),
};

function retainDeque(items: Value[], keep: (item: ElementPlace) => boolean): Value {
  let retained = 0;
  for (let read = 0; read < items.length; read++) {
    if (keep(new ElementPlace(items, read))) swapOwnedElements(items, retained++, read);
  }
  items.length = retained;
  return UNIT_VALUE;
}

function rotateDeque(ctx: NativeContext, items: Value[], amount: bigint, right: boolean): Value {
  if (amount > BigInt(items.length)) {
    libraryPanic(
      ctx,
      'assertion failed: n <= self.len()',
      `alloc/src/collections/vec_deque/mod.rs:${right ? 3180 : 3137}:9`
    );
  }
  const count = Number(amount);
  return rotate(items, right ? items.length - count : count, ctx);
}

function dequeCapacity(items: Value[], ctx: NativeContext): number {
  return vecCapacity(items, items.length, sizeOf(elemType(ctx)));
}

const heapNatives: Record<string, (args: Value[], ctx: NativeContext) => Value> = {
  new: () => [],
  drain: ([self], ctx) => ownedIter(vec(self).splice(0), elemType(ctx)),
  with_capacity: () => [],
  push: ([self, item], ctx) => {
    ctx.runtime.allocate(1);
    heapPush(vec(self), item, elemType(ctx));
    return UNIT_VALUE;
  },
  pop: ([self], ctx) => {
    const items = vec(self);
    if (items.length === 0) return none(ctx);
    return some(ctx, heapPop(ctx, items, elemType(ctx)));
  },
  peek: ([self], ctx) => option(ctx, vec(self)[0], vec(self).length > 0),
  len: ([self]) => BigInt(vec(self).length),
  is_empty: ([self]) => vec(self).length === 0,
  clear: ([self]) => {
    vec(self).length = 0;
    return UNIT_VALUE;
  },
  iter: ([self]) => sliceIter(vec(self), false),
  into_vec: ([self]) => vec(self),
  into_sorted_vec: ([self], ctx) => {
    const items = vec(self);
    return heapIntoSortedVec(items, elemType(ctx));
  },
  extend: ([self, iter], ctx) => {
    const items = vec(self);
    const start = items.length;
    const type = elemType(ctx);
    try {
      vecNatives.extend([self, iter], ctx);
    } catch (error) {
      if (error instanceof RustPanic) rebuildHeapTail(items, start, type);
      throw error;
    }
    rebuildHeapTail(items, start, type);
    return UNIT_VALUE;
  },
  into_iter: ([self], ctx) => ownedIter(vec(self), elemType(ctx)),
};

function appendHeap(ctx: NativeContext, destination: Value, source: Value): Value {
  let into = vec(destination);
  let from = vec(source);
  if (into.length < from.length) {
    [into, from] = [from, into];
    placeOf(destination).set(into);
    placeOf(source).set(from);
  }
  if (from.length === 0) return UNIT_VALUE;
  const start = into.length;
  const elem = elemType(ctx);
  const size = sizeOf(elem);
  checkVecCapacity(ctx, start, BigInt(from.length), size);
  reserveVec(into, start, from.length, size);
  ctx.runtime.allocate(from.length);
  keepVecCapacity(from, from.length);
  for (const item of from) into.push(item);
  from.length = 0;
  rebuildHeapTail(into, start, elem);
  return UNIT_VALUE;
}

const natives: Record<string, (args: Value[], ctx: NativeContext) => Value> = {};
for (const [name, native] of Object.entries(sliceNatives)) natives[`[_]::${name}`] = native;
for (const [name, native] of Object.entries(withCapacity(vecNatives))) natives[`Vec<_>::${name}`] = native;
const dequeTracked = withDequeHead(withCapacity(dequeNatives), dequeCapacity);
for (const [name, native] of Object.entries(dequeTracked)) natives[`VecDeque<_>::${name}`] = native;
for (const [name, native] of Object.entries(withCapacity(heapNatives))) natives[`BinaryHeap<_>::${name}`] = native;
natives['BinaryHeap<_>::append'] = ([self, other], ctx) => appendHeap(ctx, self, other);
natives['[_]::into_iter'] = ([self], ctx) => ownedIter(sliceItems(deref(self)), elemType(ctx));
natives['[_]::map'] = ([self, f], ctx) => callForEach(ctx, sliceItems(deref(self)), (item) => call(ctx, f, [item]));
natives['&[_]::into_iter'] = ([self]) => sliceIter(deref(self), false);
natives['&mut [_]::into_iter'] = ([self]) => sliceIter(deref(self), true);
natives['&Vec<_>::into_iter'] = ([self]) => sliceIter(deref(self), false);
natives['&mut Vec<_>::into_iter'] = ([self]) => sliceIter(deref(self), true);
natives['&VecDeque<_>::into_iter'] = ([self], ctx) => dequeIterator(vec(self), elemType(ctx), 'ref');
natives['&mut VecDeque<_>::into_iter'] = ([self], ctx) => dequeIterator(vec(self), elemType(ctx), 'mut');
natives['&BinaryHeap<_>::into_iter'] = ([self]) => sliceIter(deref(self), false);
natives['[String]::join'] = ([self, sep], ctx) => joinStrings(ctx, self, sep);
natives['[String]::concat'] = ([self], ctx) => joinStrings(ctx, self, '');
natives['[&str]::join'] = ([self, sep], ctx) => joinStrings(ctx, self, sep);
natives['[&str]::concat'] = ([self], ctx) => joinStrings(ctx, self, '');
natives['[SliceOf]::concat'] = ([self], ctx) => joinSlices(ctx, deref(self), UNIT_VALUE);
natives['[SliceOf]::join'] = ([self, sep], ctx) => {
  const separator = normalize(shallow((normalize(shallow(ctx.typeArgs[2])) as Type & { kind: 'ref' }).target));
  return joinSlices(ctx, deref(self), separator.kind === 'slice' ? deref(sep) : [deref(sep)]);
};
void ordering;
void placeOf;
define(natives);
