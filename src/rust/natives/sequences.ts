// code-gauge-allow-file fileNcss 500 -- One native per method of the standard library.
import { keepVecCapacity, setIntoIterBuffer, vecCapacity } from '../capacity';
import { sliceRange } from '../compiler';
import { type DebugPart } from '../debugText';
import { normalize } from '../infer';
import { described, fieldsPart, listPart, numberPart } from '../iterDebug';
import { cloneValue, compareValues, copyValue, testPartialOrder, valuesEqual } from '../ops';
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
  SliceView,
  swapOwnedElements,
  textOf,
  UNIT_VALUE,
  type Value,
} from '../values';
import { extendRoom, withCapacity } from './capacityNatives';
import { cloneInto } from './cloning';
import { dequeDrain, dequeIter, dequeSlices, withDequeHead } from './dequeHead';
import {
  arrayIter,
  collectVec,
  heapPop,
  heapPush,
  isTrustedLen,
  nextForFold,
  nextOf,
  ownedIter,
  sliceIter,
} from './iterators';
import { layoutOf, sizeOf } from './layout';
import { checkedRangeBounds } from './ranges';
import { dedupBy, intoSortedVec, lessByKey, lessByPartialOrd, sortByCachedKey, sortSlice } from './sorting';
import {
  call,
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

/** The array a `&mut self` or `&self` receiver of a `Vec` holds. */
function isRefType(type: Type | undefined): boolean {
  return type !== undefined && shallow(type).kind === 'ref';
}

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
function subslice(ctx: NativeContext, slice: Value, range: Value): Value {
  try {
    return some(ctx, sliceRange(slice, deref(range) as RangeValue | undefined, ctx.span));
  } catch (error) {
    if (error instanceof RustPanic) return none(ctx);
    throw error;
  }
}

function checkIndex(ctx: NativeContext, index: number, length: number, what: string): void {
  if (index >= length) panic(ctx, `${what} index (is ${index}) should be < len (is ${length})`);
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
    if (typeof index !== 'bigint') return subslice(ctx, slice, index);
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
  swap: ([self, a, b], ctx) => {
    const slice = deref(self);
    const i = Number(a as bigint);
    const j = Number(b as bigint);
    const length = sliceLength(slice);
    for (const index of [i, j]) {
      if (index >= length) panic(ctx, `index out of bounds: the len is ${length} but the index is ${index}`);
    }
    const { base, start } = sliceBase(slice);
    swapOwnedElements(base, start + i, start + j);
    return UNIT_VALUE;
  },
  split_at: ([self, mid], ctx) => splitAt(ctx, deref(self), Number(mid as bigint)),
  split_at_mut: ([self, mid], ctx) => {
    const [left, right] = splitAt(ctx, deref(self), Number(mid as bigint)) as Value[];
    return [
      { isPlace: true, get: () => left, set: () => {} },
      { isPlace: true, get: () => right, set: () => {} },
    ] as unknown as Value;
  },
  split_first: ([self], ctx) => {
    const slice = deref(self);
    if (sliceLength(slice) === 0) return none(ctx);
    return some(ctx, [sliceGet(slice, 0), sliceRange(slice, rangeFrom(1), ctx.span)]);
  },
  split_last: ([self], ctx) => {
    const slice = deref(self);
    const length = sliceLength(slice);
    if (length === 0) return none(ctx);
    return some(ctx, [sliceGet(slice, length - 1), sliceRange(slice, rangeTo(length - 1), ctx.span)]);
  },
  windows: ([self, size], ctx) => {
    const slice = deref(self);
    const width = Number(size as bigint);
    if (width === 0) panic(ctx, 'window size must be non-zero');
    const { base, start } = sliceBase(slice);
    const length = sliceLength(slice);
    const count = Math.max(0, length - width + 1);
    const iter = arrayIter(base, 0, count, (index) => new SliceView(base, start + index, start + index + width));
    // `Windows` drops an element from the end it takes a window from, so once done it keeps `size - 1` of them.
    const done = (target: IterValue): SliceView => {
      const front = target.frontIndex!();
      return new SliceView(base, start + front, start + Math.min(length, front + width - 1));
    };
    return chunkDebug(iter, 'Windows', done, () => [['size', numberPart(width)]]);
  },
  chunks: ([self, size], ctx) => chunks(ctx, deref(self), Number(size as bigint), false),
  rchunks: ([self, size], ctx) => {
    const slice = deref(self);
    const width = Number(size as bigint);
    if (width === 0) panic(ctx, 'chunk size must be non-zero');
    const { base, start } = sliceBase(slice);
    const length = sliceLength(slice);
    const iter = arrayIter(base, 0, Math.ceil(length / width), (index) => {
      const end = length - index * width;
      return new SliceView(base, start + Math.max(0, end - width), start + end);
    });
    const done = (): SliceView => new SliceView(base, start, start);
    return chunkDebug(iter, 'RChunks', done, () => [['chunk_size', numberPart(width)]]);
  },
  chunks_exact: ([self, size], ctx) => chunks(ctx, deref(self), Number(size as bigint), true),
  fill: ([self, value], ctx) => fillSlice(ctx, deref(self), value, elemType(ctx)),
  to_vec: ([self], ctx) => clonedItems(ctx, sliceItems(deref(self))),
  to_owned: ([self], ctx) => clonedItems(ctx, sliceItems(deref(self))),
  into_vec: ([self]) => sliceItems(deref(self)),
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
    const length = items.length * Number(n as bigint);
    ctx.runtime.allocate(length);
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

function splitAt(ctx: NativeContext, slice: Value, mid: number): Value {
  if (mid > sliceLength(slice)) panic(ctx, 'mid > len');
  return [sliceRange(slice, rangeTo(mid), ctx.span), sliceRange(slice, rangeFrom(mid), ctx.span)];
}

function chunks(ctx: NativeContext, slice: Value, size: number, exact: boolean): IterValue {
  if (size === 0) panic(ctx, 'chunk size must be non-zero');
  const { base, start } = sliceBase(slice);
  const length = sliceLength(slice);
  const count = exact ? Math.floor(length / size) : Math.ceil(length / size);
  const iter = arrayIter(
    base,
    0,
    count,
    (index) => new SliceView(base, start + index * size, start + Math.min(length, (index + 1) * size))
  );
  const done = (): SliceView => new SliceView(base, start, start);
  const chunkSize: [string, DebugPart] = ['chunk_size', numberPart(size)];
  if (!exact) return chunkDebug(iter, 'Chunks', done, () => [chunkSize]);
  const rem = sliceItems(new SliceView(base, start + count * size, start + length));
  return chunkDebug(iter, 'ChunksExact', done, (part) => [['rem', part(rem)], chunkSize]);
}

/**
 * `{:?}` of `Windows`, `Chunks`, `RChunks`, and `ChunksExact`: `v`, the part of the slice their elements left cover
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
  return items.map((item) => cloneValue(elemType(ctx), item));
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
    if (position > items.length) panic(ctx, `insertion index (is ${position}) should be <= len (is ${items.length})`);
    ctx.runtime.allocate(1);
    items.splice(position, 0, element);
    return UNIT_VALUE;
  },
  remove: ([self, index], ctx) => {
    const items = vec(self);
    const position = Number(index as bigint);
    checkIndex(ctx, position, items.length, 'removal');
    return items.splice(position, 1)[0];
  },
  swap_remove: ([self, index], ctx) => {
    const items = vec(self);
    const position = Number(index as bigint);
    if (position >= items.length) {
      libraryPanic(
        ctx,
        `swap_remove index (is ${position}) should be < len (is ${items.length})`,
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
    // Extending from references copies the `Copy` values they refer to.
    const fromRefs = isRefType(ctx.typeArgs[1]);
    const room = extendRoom(ctx, items, iterator, ctx.typeArgs[2]);
    for (;;) {
      ctx.runtime.spend();
      const item = next(iterator);
      if (item === DONE) break;
      room();
      ctx.runtime.allocate(1);
      items.push(fromRefs ? copyValue(deref(item)) : item);
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
  dedup_by_key: ([self, f], ctx) => {
    // `dedup_by(|a, b| key(a) == key(b))`: both keys at each comparison.
    const keyType = ctx.typeArgs[1];
    return dedupBy(vec(self), (current, kept) => {
      const key = call(ctx, f, [current]);
      return valuesEqual(keyType, key, call(ctx, f, [kept]));
    });
  },
  resize: ([self, newLen, value], ctx) => {
    const items = vec(self);
    const length = Number(newLen as bigint);
    if (length < items.length) items.length = length;
    else {
      ctx.runtime.allocate(length - items.length);
      if (items.length === length) return UNIT_VALUE;
      const type = elemType(ctx);
      while (items.length < length - 1) items.push(cloneValue(type, value));
      items.push(value);
    }
    return UNIT_VALUE;
  },
  split_off: ([self, at], ctx) => {
    const items = vec(self);
    const position = Number(at as bigint);
    if (position > items.length)
      panic(ctx, `\`at\` split index (is ${position}) should be <= len (is ${items.length})`);
    return items.splice(position);
  },
  as_slice: ([self]) => vec(self),
  as_mut_slice: ([self]) => self,
  into_boxed_slice: ([self]) => vec(self),
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
  iter: ([self], ctx) => dequeIter(vec(self), dequeCapacity(vec(self), ctx), false),
  iter_mut: ([self], ctx) => dequeIter(vec(self), dequeCapacity(vec(self), ctx), true),
  as_slices: ([self], ctx) => dequeSlices(vec(self), dequeCapacity(vec(self), ctx)),
  insert: ([self, index, value], ctx) => {
    const items = vec(self);
    const position = Number(index as bigint);
    if (position > items.length) {
      libraryPanic(ctx, 'index out of bounds', 'alloc/src/collections/vec_deque/mod.rs:2564:9');
    }
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
  retain: ([self, f], ctx) => vecNatives.retain([self, f], ctx),
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
  into_iter: ([self], ctx) => ownedIter(vec(self), elemType(ctx)),
};

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
    return some(ctx, heapPop(items, elemType(ctx)));
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
    return intoSortedVec(items, (a, b) => compareValues(elemType(ctx), a, b) ?? 0);
  },
  extend: ([self, iter], ctx) => {
    const items = vec(self);
    const iterator = deref(iter) as IterValue;
    const next = isTrustedLen(ctx.typeArgs[2]) ? nextForFold : nextOf;
    for (;;) {
      ctx.runtime.spend();
      const item = next(iterator);
      if (item === DONE) break;
      ctx.runtime.allocate(1);
      heapPush(items, item, elemType(ctx));
    }
    return UNIT_VALUE;
  },
  into_iter: ([self], ctx) => ownedIter(vec(self), elemType(ctx)),
};

const natives: Record<string, (args: Value[], ctx: NativeContext) => Value> = {};
for (const [name, native] of Object.entries(sliceNatives)) natives[`[_]::${name}`] = native;
for (const [name, native] of Object.entries(withCapacity(vecNatives))) natives[`Vec<_>::${name}`] = native;
const dequeTracked = withDequeHead(withCapacity(dequeNatives), dequeCapacity);
for (const [name, native] of Object.entries(dequeTracked)) natives[`VecDeque<_>::${name}`] = native;
for (const [name, native] of Object.entries(withCapacity(heapNatives))) natives[`BinaryHeap<_>::${name}`] = native;
natives['[_]::into_iter'] = ([self], ctx) => ownedIter(sliceItems(deref(self)), elemType(ctx));
natives['[_]::map'] = ([self, f], ctx) => sliceItems(deref(self)).map((item) => call(ctx, f, [item]));
natives['&[_]::into_iter'] = ([self]) => sliceIter(deref(self), false);
natives['&mut [_]::into_iter'] = ([self]) => sliceIter(deref(self), true);
natives['&Vec<_>::into_iter'] = ([self]) => sliceIter(deref(self), false);
natives['&mut Vec<_>::into_iter'] = ([self]) => sliceIter(deref(self), true);
natives['&VecDeque<_>::into_iter'] = ([self]) => sliceIter(deref(self), false);
natives['&mut VecDeque<_>::into_iter'] = ([self]) => sliceIter(deref(self), true);
natives['&BinaryHeap<_>::into_iter'] = ([self]) => sliceIter(deref(self), false);
natives['[String]::join'] = ([self, sep], ctx) => joinStrings(ctx, self, sep);
natives['[String]::concat'] = ([self], ctx) => joinStrings(ctx, self, '');
natives['[&str]::join'] = ([self, sep], ctx) => joinStrings(ctx, self, sep);
natives['[&str]::concat'] = ([self], ctx) => joinStrings(ctx, self, '');
natives['[SliceOf]::concat'] = ([self], ctx) =>
  clonedItems(
    ctx,
    sliceItems(deref(self)).flatMap((item) => sliceItems(deref(item)))
  );
natives['[SliceOf]::join'] = ([self, sep], ctx) => {
  const separator = normalize(shallow((normalize(shallow(ctx.typeArgs[2])) as Type & { kind: 'ref' }).target));
  const parts = separator.kind === 'slice' ? sliceItems(deref(sep)) : [deref(sep)];
  const joined: Value[] = [];
  for (const [index, item] of sliceItems(deref(self)).entries()) {
    if (index > 0) for (const part of parts) joined.push(part);
    for (const element of sliceItems(deref(item))) joined.push(element);
  }
  return clonedItems(ctx, joined);
};
void ordering;
void placeOf;
define(natives);
