import { sliceRange } from '../compiler';
import { cloneValue, compareValues, copyValue, valuesEqual } from '../ops';
import { shallow, type Type } from '../types';
import {
  DONE,
  ElementPlace,
  type IterValue,
  type RangeValue,
  sliceBase,
  sliceGet,
  sliceItems,
  sliceLength,
  sliceSet,
  SliceView,
  UNIT_VALUE,
  type Value,
} from '../values';
import { arrayIter, heapPop, heapPush, sliceIter } from './iterators';
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

function cmpWith(ctx: NativeContext, f: Value): (a: Value, b: Value) => number {
  return (a, b) => {
    ctx.runtime.spend();
    return (deref(call(ctx, f, [a, b])) as { variant: number }).variant - 1;
  };
}

/** Rust's stable sort (`sort`, `sort_by`), as a stable merge sort; unstable sorts give equal elements in any order. */
function stableSort(ctx: NativeContext, slice: Value, compare: (a: Value, b: Value) => number): void {
  const items = sliceItems(slice);
  ctx.runtime.nativeRoots.push(items);
  try {
    const sorted = mergeSort(items, compare);
    for (const [index, item] of sorted.entries()) sliceSet(slice, index, item);
  } finally {
    ctx.runtime.nativeRoots.pop();
  }
}

function mergeSort(items: Value[], compare: (a: Value, b: Value) => number): Value[] {
  if (items.length <= 1) return items;
  const middle = items.length >> 1;
  const left = mergeSort(items.slice(0, middle), compare);
  const right = mergeSort(items.slice(middle), compare);
  const result: Value[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (compare(right[j], left[i]) < 0) result.push(right[j++]);
    else result.push(left[i++]);
  }
  while (i < left.length) result.push(left[i++]);
  while (j < right.length) result.push(right[j++]);
  return result;
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
    const position = Number(index as bigint);
    return option(ctx, sliceGet(slice, position), position < sliceLength(slice));
  },
  get_mut: ([self, index], ctx) => {
    const slice = deref(self);
    const position = Number(index as bigint);
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
    stableSort(ctx, deref(self), (a, b) => compareValues(elemType(ctx), a, b) ?? 0);
    return UNIT_VALUE;
  },
  sort_unstable: ([self], ctx) => {
    stableSort(ctx, deref(self), (a, b) => compareValues(elemType(ctx), a, b) ?? 0);
    return UNIT_VALUE;
  },
  sort_by: ([self, f], ctx) => {
    stableSort(ctx, deref(self), cmpWith(ctx, f));
    return UNIT_VALUE;
  },
  sort_unstable_by: ([self, f], ctx) => {
    stableSort(ctx, deref(self), cmpWith(ctx, f));
    return UNIT_VALUE;
  },
  sort_by_key: ([self, f], ctx) => {
    const keyType = ctx.typeArgs[1];
    stableSort(ctx, deref(self), (a, b) => compareValues(keyType, call(ctx, f, [a]), call(ctx, f, [b])) ?? 0);
    return UNIT_VALUE;
  },
  sort_unstable_by_key: ([self, f], ctx) => {
    const keyType = ctx.typeArgs[1];
    stableSort(ctx, deref(self), (a, b) => compareValues(keyType, call(ctx, f, [a]), call(ctx, f, [b])) ?? 0);
    return UNIT_VALUE;
  },
  sort_by_cached_key: ([self, f], ctx) => {
    const keyType = ctx.typeArgs[1];
    const slice = deref(self);
    const items = sliceItems(slice);
    const keyed = items.map((item) => ({ item, key: call(ctx, f, [item]) }));
    const sorted = mergeSort(
      keyed as unknown as Value[],
      (a, b) => compareValues(keyType, (a as unknown as { key: Value }).key, (b as unknown as { key: Value }).key) ?? 0
    );
    for (const [index, entry] of sorted.entries()) sliceSet(slice, index, (entry as unknown as { item: Value }).item);
    return UNIT_VALUE;
  },
  is_sorted: ([self], ctx) => {
    const items = sliceItems(deref(self));
    return items.every(
      (item, index) => index === 0 || (compareValues(elemType(ctx), items[index - 1], item) ?? 1) <= 0
    );
  },
  reverse: ([self]) => {
    const slice = deref(self);
    const items = sliceItems(slice).toReversed();
    for (const [index, item] of items.entries()) sliceSet(slice, index, item);
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
    const item = sliceGet(slice, i);
    sliceSet(slice, i, sliceGet(slice, j));
    sliceSet(slice, j, item);
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
    const count = Math.max(0, sliceLength(slice) - width + 1);
    return arrayIter(base, 0, count, (index) => new SliceView(base, start + index, start + index + width));
  },
  chunks: ([self, size], ctx) => chunks(ctx, deref(self), Number(size as bigint), false),
  chunks_exact: ([self, size], ctx) => chunks(ctx, deref(self), Number(size as bigint), true),
  fill: ([self, value], ctx) => {
    const slice = deref(self);
    for (let index = 0; index < sliceLength(slice); index++) sliceSet(slice, index, cloneValue(elemType(ctx), value));
    return UNIT_VALUE;
  },
  to_vec: ([self], ctx) => sliceItems(deref(self)).map((item) => cloneValue(elemType(ctx), item)),
  into_vec: ([self]) => sliceItems(deref(self)),
  rotate_left: ([self, mid], ctx) => {
    const slice = deref(self);
    if (Number(mid as bigint) > sliceLength(slice)) {
      libraryPanic(ctx, 'assertion failed: mid <= self.len()', 'core/src/slice/mod.rs:3904:9');
    }
    return rotate(slice, Number(mid as bigint));
  },
  rotate_right: ([self, k], ctx) => {
    const slice = deref(self);
    if (Number(k as bigint) > sliceLength(slice)) {
      libraryPanic(ctx, 'assertion failed: k <= self.len()', 'core/src/slice/mod.rs:3950:9');
    }
    return rotate(slice, sliceLength(slice) - Number(k as bigint));
  },
  copy_from_slice: ([self, src], ctx) => copyFrom(ctx, deref(self), deref(src), (item) => copyValue(item)),
  clone_from_slice: ([self, src], ctx) =>
    copyFrom(ctx, deref(self), deref(src), (item) => cloneValue(elemType(ctx), item)),
  repeat: ([self, n]) => {
    const items = sliceItems(deref(self));
    const result: Value[] = [];
    for (let index = 0; index < Number(n as bigint); index++) result.push(...items.map(copyValue));
    return result;
  },
};

function rangeFrom(start: number): RangeValue {
  return { start: BigInt(start), end: undefined, inclusive: false, exhausted: false } as RangeValue;
}

function rangeTo(end: number): RangeValue {
  return { start: undefined, end: BigInt(end), inclusive: false, exhausted: false } as RangeValue;
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
  return arrayIter(
    base,
    0,
    count,
    (index) => new SliceView(base, start + index * size, start + Math.min(length, (index + 1) * size))
  );
}

function rotate(slice: Value, mid: number): Value {
  const items = sliceItems(slice);
  const length = items.length;
  if (length === 0) return UNIT_VALUE;
  const shift = ((mid % length) + length) % length;
  const rotated = [...items.slice(shift), ...items.slice(0, shift)];
  for (const [index, item] of rotated.entries()) sliceSet(slice, index, item);
  return UNIT_VALUE;
}

function copyFrom(ctx: NativeContext, target: Value, source: Value, copy: (item: Value) => Value): Value {
  const items = sliceItems(source);
  if (items.length !== sliceLength(target)) {
    panic(
      ctx,
      `source slice length (${items.length}) does not match destination slice length (${sliceLength(target)})`
    );
  }
  for (const [index, item] of items.entries()) sliceSet(target, index, copy(item));
  return UNIT_VALUE;
}

function joinStrings(self: Value, sep: Value): string {
  return sliceItems(deref(self))
    .map((item) => deref(item) as string)
    .join(deref(sep) as string);
}

const vecNatives: Record<string, (args: Value[], ctx: NativeContext) => Value> = {
  new: () => [],
  with_capacity: () => [],
  push: ([self, value], ctx) => {
    ctx.runtime.allocate(1);
    vec(self).push(value);
    return UNIT_VALUE;
  },
  pop: ([self], ctx) => {
    const items = vec(self);
    return option(ctx, items.at(-1), items.length > 0 && (items.pop(), true));
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
    const removed = items[position];
    const last = items.pop() as Value;
    if (position < items.length) items[position] = last;
    return removed;
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
  capacity: ([self]) => BigInt(vec(self).length),
  reserve: () => UNIT_VALUE,
  shrink_to_fit: () => UNIT_VALUE,
  extend: ([self, iter], ctx) => {
    const items = vec(self);
    const iterator = deref(iter) as IterValue;
    // Extending from references copies the `Copy` values they refer to.
    const fromRefs = isRefType(ctx.typeArgs[1]);
    for (;;) {
      ctx.runtime.spend();
      const item = iterator.next();
      if (item === DONE) break;
      ctx.runtime.allocate(1);
      items.push(fromRefs ? copyValue(deref(item)) : item);
    }
    return UNIT_VALUE;
  },
  extend_from_slice: ([self, other], ctx) => {
    const items = vec(self);
    const added = sliceItems(deref(other)).map((item) => cloneValue(elemType(ctx), item));
    ctx.runtime.allocate(added.length);
    items.push(...added);
    return UNIT_VALUE;
  },
  append: ([self, other]) => {
    const target = vec(self);
    const source = vec(other);
    target.push(...source);
    source.length = 0;
    return UNIT_VALUE;
  },
  drain: ([self, range], ctx) => {
    const items = vec(self);
    const r = deref(range) as RangeValue | undefined;
    const start = r?.start === undefined ? 0 : Number(r.start as bigint);
    const end = r?.end === undefined ? items.length : Number(r.end as bigint) + (r.inclusive ? 1 : 0);
    if (start > end) {
      libraryPanic(ctx, `slice index starts at ${start} but ends at ${end}`, 'core/src/slice/index.rs:1020:55');
    }
    if (end > items.length) {
      libraryPanic(
        ctx,
        `range end index ${end} out of range for slice of length ${items.length}`,
        'core/src/slice/index.rs:1009:51'
      );
    }
    return arrayIter(items.splice(start, end - start));
  },
  retain: ([self, f], ctx) => {
    const items = vec(self);
    const kept = items.filter((item) => deref(call(ctx, f, [item])) as boolean);
    items.length = 0;
    items.push(...kept);
    return UNIT_VALUE;
  },
  retain_mut: ([self, f], ctx) => {
    const items = vec(self);
    // The closure may change each element before deciding, so the kept elements are read after it runs.
    const keep = items.map((_, index) => deref(call(ctx, f, [new ElementPlace(items, index)])) as boolean);
    const kept = items.filter((_, index) => keep[index]);
    items.length = 0;
    items.push(...kept);
    return UNIT_VALUE;
  },
  dedup: ([self], ctx) => {
    const items = vec(self);
    const kept = items.filter((item, index) => index === 0 || !valuesEqual(elemType(ctx), items[index - 1], item));
    items.length = 0;
    items.push(...kept);
    return UNIT_VALUE;
  },
  dedup_by_key: ([self, f], ctx) => {
    const items = vec(self);
    const keyType = ctx.typeArgs[1];
    const keys = items.map((_, index) => call(ctx, f, [new ElementPlace(items, index)]));
    const kept = items.filter((_, index) => index === 0 || !valuesEqual(keyType, keys[index - 1], keys[index]));
    items.length = 0;
    items.push(...kept);
    return UNIT_VALUE;
  },
  resize: ([self, newLen, value], ctx) => {
    const items = vec(self);
    const length = Number(newLen as bigint);
    if (length < items.length) items.length = length;
    else {
      ctx.runtime.allocate(length - items.length);
      while (items.length < length) items.push(items.length === length - 1 ? value : cloneValue(elemType(ctx), value));
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
  into_iter: ([self]) => arrayIter(vec(self)),
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
    return option(ctx, items.at(-1), items.length > 0 && (items.pop(), true));
  },
  pop_front: ([self], ctx) => {
    const items = vec(self);
    return option(ctx, items[0], items.length > 0 && (items.shift(), true));
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
  iter: ([self]) => sliceIter(deref(self), false),
  iter_mut: ([self]) => sliceIter(deref(self), true),
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
  swap: ([self, a, b], ctx) => sliceNatives.swap([self, a, b], ctx),
  rotate_left: ([self, n]) => rotate(vec(self), Number(n as bigint)),
  rotate_right: ([self, n]) => rotate(vec(self), vec(self).length - Number(n as bigint)),
  make_contiguous: ([self]) => self,
  drain: ([self, range], ctx) => vecNatives.drain([self, range], ctx),
  into_iter: ([self]) => arrayIter(vec(self)),
};

const heapNatives: Record<string, (args: Value[], ctx: NativeContext) => Value> = {
  new: () => [],
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
    const items = [...vec(self)];
    return mergeSort(items, (a, b) => compareValues(elemType(ctx), a, b) ?? 0);
  },
  extend: ([self, iter], ctx) => {
    const items = vec(self);
    const iterator = deref(iter) as IterValue;
    for (;;) {
      const item = iterator.next();
      if (item === DONE) break;
      heapPush(items, item, elemType(ctx));
    }
    return UNIT_VALUE;
  },
  into_iter: ([self]) => arrayIter(vec(self)),
};

const natives: Record<string, (args: Value[], ctx: NativeContext) => Value> = {};
for (const [name, native] of Object.entries(sliceNatives)) natives[`[_]::${name}`] = native;
for (const [name, native] of Object.entries(vecNatives)) natives[`Vec<_>::${name}`] = native;
for (const [name, native] of Object.entries(dequeNatives)) natives[`VecDeque<_>::${name}`] = native;
for (const [name, native] of Object.entries(heapNatives)) natives[`BinaryHeap<_>::${name}`] = native;
natives['[_]::into_iter'] = ([self]) => arrayIter(sliceItems(deref(self)));
natives['&[_]::into_iter'] = ([self]) => sliceIter(deref(self), false);
natives['&mut [_]::into_iter'] = ([self]) => sliceIter(deref(self), true);
natives['&Vec<_>::into_iter'] = ([self]) => sliceIter(deref(self), false);
natives['&mut Vec<_>::into_iter'] = ([self]) => sliceIter(deref(self), true);
natives['&VecDeque<_>::into_iter'] = ([self]) => sliceIter(deref(self), false);
natives['&mut VecDeque<_>::into_iter'] = ([self]) => sliceIter(deref(self), true);
natives['&BinaryHeap<_>::into_iter'] = ([self]) => sliceIter(deref(self), false);
natives['[String]::join'] = ([self, sep]) => joinStrings(self, sep);
natives['[String]::concat'] = ([self]) => joinStrings(self, '');
natives['[&str]::join'] = ([self, sep]) => joinStrings(self, sep);
natives['[&str]::concat'] = ([self]) => joinStrings(self, '');
natives['[Vec<_>]::concat'] = ([self], ctx) =>
  sliceItems(deref(self)).flatMap((item) => (item as Value[]).map((e) => cloneValue(elemType(ctx), e)));
natives['[Vec<_>]::join'] = ([self, sep], ctx) => {
  const result: Value[] = [];
  for (const [index, item] of sliceItems(deref(self)).entries()) {
    if (index > 0) result.push(cloneValue(elemType(ctx), deref(sep)));
    result.push(...(item as Value[]).map((e) => cloneValue(elemType(ctx), e)));
  }
  return result;
};
void ordering;
void placeOf;
define(natives);
