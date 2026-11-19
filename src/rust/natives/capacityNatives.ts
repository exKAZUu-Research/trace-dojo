import {
  changeString,
  claimStrings,
  keepVecCapacity,
  moveString,
  reservedCapacity,
  reserveVec,
  reserveVecExact,
  setStringCapacity,
  setVecCapacity,
  shrinkVec,
  stringCapacity,
  utf8Length,
  vecCapacity,
} from '../capacity';
import { iteratorCapability } from '../traits';
import type { Type } from '../types';
import { ElementPlace, type IterValue, sliceLength, UNIT_VALUE, type Value } from '../values';
import { isTrustedLen } from './iterators';
import { sizeOf } from './layout';
import { deref, libraryPanic, type NativeContext, placeOf } from './support';

/**
 * The natives that keep the capacities of `Vec`, `VecDeque`, `BinaryHeap`, and `String`, which their values (arrays
 * and JS strings) do not hold, as `RawVec` grows and keeps them.
 */

const USIZE_MAX = 2n ** 64n - 1n;
const ISIZE_MAX = 2n ** 63n - 1n;

/**
 * `RawVec`'s check of a length and the room asked beyond it (`with_capacity`, `reserve`), which panics when they
 * overflow a `usize` or their elements' bytes overflow an `isize`.
 */
export function checkVecCapacity(ctx: NativeContext, len: number, additional: Value, elemSize: number): void {
  const capacity = BigInt(len) + (additional as bigint);
  if (capacity > USIZE_MAX || capacity * BigInt(elemSize) > ISIZE_MAX) {
    libraryPanic(ctx, 'capacity overflow', 'alloc/src/raw_vec/mod.rs:28:5');
  }
}

/**
 * hashbrown's check of the elements a table must hold (`with_capacity`, `reserve`): it panics when their buckets
 * (eight for every seven elements, rounded up to a power of two) or the table's bytes overflow.
 */
export function checkTableCapacity(ctx: NativeContext, len: number, additional: Value, entrySize: number): void {
  const capacity = BigInt(len) + (additional as bigint);
  let overflows = capacity > USIZE_MAX || capacity * 8n > USIZE_MAX;
  if (!overflows && capacity >= 15n) {
    let buckets = 1n;
    while (buckets < (capacity * 8n) / 7n) buckets *= 2n;
    // The entries, then a control byte for each bucket and a group's more.
    overflows = buckets > 2n ** 63n || buckets * BigInt(entrySize + 1) + 8n > ISIZE_MAX;
  }
  if (overflows) libraryPanic(ctx, 'Hash table capacity overflow', '/rust/deps/hashbrown-0.17.1/src/raw.rs:36:40');
}

function vec(self: Value): Value[] {
  return deref(self) as Value[];
}

function elemType(ctx: NativeContext): Type {
  return ctx.typeArgs[0];
}

/** The natives that add this many elements, which make room first as `RawVec::reserve` does. */
const VEC_GROWING: Record<string, (args: Value[]) => number> = {
  push: () => 1,
  insert: () => 1,
  push_back: () => 1,
  push_front: () => 1,
  extend_from_slice: ([, other]) => sliceLength(deref(other)),
  append: ([, other]) => vec(other).length,
  resize: ([self, newLen]) => Math.max(0, Number(newLen as bigint) - vec(self).length),
};

/** The natives that give back the element at this index, which takes its capacity along when it is a `String`. */
const TAKEN: Record<string, (args: Value[], len: number) => number> = {
  pop: (_args, len) => len - 1,
  pop_back: (_args, len) => len - 1,
  pop_front: () => 0,
  remove: ([, index]) => Number(index as bigint),
  swap_remove: ([, index]) => Number(index as bigint),
};

/** The natives that may remove elements, after which the collection keeps its capacity. */
const VEC_SHRINKING = new Set([
  'pop',
  'pop_back',
  'pop_front',
  'remove',
  'swap_remove',
  'truncate',
  'clear',
  'drain',
  'retain',
  'retain_mut',
  'dedup',
  'dedup_by',
  'dedup_by_key',
  'split_off',
  'resize',
]);

/** The natives of a `Vec`, a `VecDeque`, or a `BinaryHeap` that read and change its capacity. */
const vecCapacityNatives: Record<string, (args: Value[], ctx: NativeContext) => Value> = {
  with_capacity: ([capacity], ctx) => {
    checkVecCapacity(ctx, 0, capacity, sizeOf(elemType(ctx)));
    const items: Value[] = [];
    setVecCapacity(items, Number(capacity as bigint));
    return items;
  },
  capacity: ([self], ctx) => {
    const size = sizeOf(elemType(ctx));
    return size === 0 ? 2n ** 64n - 1n : BigInt(vecCapacity(vec(self), vec(self).length, size));
  },
  reserve: ([self, additional], ctx) => {
    checkVecCapacity(ctx, vec(self).length, additional, sizeOf(elemType(ctx)));
    reserveVec(vec(self), vec(self).length, Number(additional as bigint), sizeOf(elemType(ctx)));
    return UNIT_VALUE;
  },
  reserve_exact: ([self, additional], ctx) => {
    checkVecCapacity(ctx, vec(self).length, additional, sizeOf(elemType(ctx)));
    reserveVecExact(vec(self), vec(self).length, Number(additional as bigint));
    return UNIT_VALUE;
  },
  shrink_to_fit: ([self]) => {
    shrinkVec(vec(self), vec(self).length, 0);
    return UNIT_VALUE;
  },
  shrink_to: ([self, min]) => {
    shrinkVec(vec(self), vec(self).length, Number(min as bigint));
    return UNIT_VALUE;
  },
};

/** Adds the capacity natives, and makes the natives that add or remove elements keep the capacity as std does. */
export function withCapacity(
  natives: Record<string, (args: Value[], ctx: NativeContext) => Value>
): Record<string, (args: Value[], ctx: NativeContext) => Value> {
  const tracked = { ...natives, ...vecCapacityNatives };
  for (const [name, native] of Object.entries(natives)) {
    const additional = VEC_GROWING[name];
    if (additional) {
      tracked[name] = (args, ctx) => {
        const items = vec(args[0]);
        reserveVec(items, items.length, additional(args), sizeOf(elemType(ctx)));
        const result = native(args, ctx);
        claimStrings(items);
        return result;
      };
    } else if (VEC_SHRINKING.has(name)) {
      tracked[name] = (args, ctx) => {
        const items = vec(args[0]);
        keepVecCapacity(items, items.length);
        const taken = TAKEN[name]?.(args, items.length);
        if (taken !== undefined && taken < items.length) moveString(new ElementPlace(items, taken));
        return native(args, ctx);
      };
    }
  }
  return tracked;
}

/**
 * How `extend` makes room: all at once for a `TrustedLen` iterator, and otherwise whenever full, by the size hint's
 * lower bound plus one, which is exact for an `ExactSizeIterator` and 0 for others.
 */
export function extendRoom(ctx: NativeContext, items: Value[], iterator: IterValue, shape: Type): () => void {
  const size = sizeOf(elemType(ctx));
  const remaining = (): number => iterator.remaining?.() ?? 0;
  if (isTrustedLen(shape)) {
    reserveVec(items, items.length, remaining(), size);
    return () => {};
  }
  const exact = iteratorCapability(shape, 'exact') === 'yes';
  return () => {
    if (vecCapacity(items, items.length, size) === items.length) {
      reserveVec(items, items.length, (exact ? remaining() : 0) + 1, size);
    }
  };
}

/** The natives that change a `String`'s length, which make room first as `RawVec::reserve` does. */
const STRING_RESIZING = new Set([
  'push_str',
  'push',
  'insert',
  'insert_str',
  'extend',
  'replace_range',
  'pop',
  'remove',
  'truncate',
  'clear',
  'retain',
  'drain',
  'split_off',
]);

/** The natives that read and change a `String`'s capacity. */
const stringCapacityNatives: Record<string, (args: Value[], ctx: NativeContext) => Value> = {
  capacity: ([self]) => BigInt(stringCapacity(self)),
  reserve: ([self, additional], ctx) => {
    const place = placeOf(self);
    const len = utf8Length(place.get() as string);
    checkVecCapacity(ctx, len, additional, 1);
    setStringCapacity(place, reservedCapacity(stringCapacity(place), len, Number(additional as bigint), 1));
    return UNIT_VALUE;
  },
  reserve_exact: ([self, additional], ctx) => {
    const place = placeOf(self);
    checkVecCapacity(ctx, utf8Length(place.get() as string), additional, 1);
    const needed = utf8Length(place.get() as string) + Number(additional as bigint);
    setStringCapacity(place, Math.max(stringCapacity(place), needed));
    return UNIT_VALUE;
  },
  shrink_to_fit: ([self]) => {
    const place = placeOf(self);
    setStringCapacity(place, utf8Length(place.get() as string));
    return UNIT_VALUE;
  },
  shrink_to: ([self, min]) => {
    const place = placeOf(self);
    const target = Math.max(utf8Length(place.get() as string), Number(min as bigint));
    setStringCapacity(place, Math.min(stringCapacity(place), target));
    return UNIT_VALUE;
  },
};

/** Adds the capacity natives, and makes the natives that change the length keep the capacity as std does. */
export function withStringCapacity(
  natives: Record<string, (args: Value[], ctx: NativeContext) => Value>
): Record<string, (args: Value[], ctx: NativeContext) => Value> {
  const tracked = { ...natives, ...stringCapacityNatives };
  for (const name of STRING_RESIZING) {
    const native = natives[name];
    tracked[name] = (args, ctx) => {
      let result: Value = UNIT_VALUE;
      changeString(placeOf(args[0]), () => {
        result = native(args, ctx);
      });
      return result;
    };
  }
  return tracked;
}
