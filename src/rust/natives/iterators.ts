// code-gauge-allow-file fileNcss 678 -- One native per method of the standard library.
import { normalize } from '../infer';
import type { Interpreter } from '../interpreter';
import { castValue, cloneValue, compareValues, copyValue, hashKey, needsCopy, valuesEqual, wrap } from '../ops';
import { RustPanic } from '../runtime';
import { shallow, type Type } from '../types';
import {
  DONE,
  ElementPlace,
  EnumValue,
  IterValue,
  MapValue,
  type Next,
  type RangeValue,
  SetValue,
  sliceBase,
  sliceLength,
  SliceView,
  type Value,
} from '../values';
import { call, define, deref, libraryPanic, type NativeContext, none, option, panic, placeOf, some } from './support';

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
  return iter;
}

/** An iterator of a slice's elements; `places` yields places for `iter_mut`. */
export function sliceIter(slice: Value, places: boolean): IterValue {
  const { base, start } = sliceBase(slice);
  const length = sliceLength(slice);
  return arrayIter(base, start, start + length, places ? (i) => new ElementPlace(base, i) : (i) => base[i]);
}

/** The iterator `for` uses for a value of a type, as `IntoIterator` makes it. */
// code-gauge-allow duplicateLines 16 -- Borrowed and owned collections iterate alike, yielding references or values.
export function toIterator(interp: Interpreter, value: Value, from: Type): Value {
  const t = normalize(shallow(from));
  if (value instanceof IterValue) return value;
  if (t.kind === 'array') return sliceIter(value, false);
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
        case 'Option': {
          const option = v as EnumValue;
          if (option.variant === 0) return arrayIter([]);
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
        return arrayIter(value as Value[]);
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
  return new IterValue(next, nextBack, remaining, [range]);
}

function iterOf(value: Value): IterValue {
  return deref(value) as IterValue;
}

/** Takes the next element, honoring elements that `peek` looked at. */
export function nextOf(iter: IterValue): Next {
  if (iter.peeked && iter.peeked.length > 0) return iter.peeked.shift() as Next;
  return iter.next();
}

/** Takes the elements left, up to and including one that `stop` picks. */
function collectAll(ctx: NativeContext, iter: IterValue, stop?: (item: Value) => boolean): Value[] {
  const items: Value[] = [];
  for (;;) {
    ctx.runtime.spend();
    const item = nextOf(iter);
    if (item === DONE) return items;
    items.push(item);
    if (stop?.(item)) return items;
    if (items.length > 1_000_000) ctx.runtime.allocate(items.length);
  }
}

/** Flattens `Option`s or `Result`s, keeping the value of each one whose variant is `present` (`Some`, `Ok`). */
function flattenPresent(ctx: NativeContext, self: Value, present: number): IterValue {
  return flatten(ctx, iterOf(self), (item) => {
    const value = deref(item) as EnumValue;
    return arrayIter(value.variant === present ? [value.fields[0]] : []);
  });
}

function adapter(source: IterValue, next: () => Next, nextBack?: () => Next, remaining?: () => number): IterValue {
  return new IterValue(next, nextBack, remaining, [source]);
}

function truthy(value: Value): boolean {
  return deref(value) as boolean;
}

define({
  'Iter<_>::next': ([self]) => {
    const iter = iterOf(self);
    const item = nextOf(iter);
    return item === DONE ? NONE_MARK : SOME_MARK(item);
  },
  'Iter<_>::next_back': ([self], ctx) => {
    const iter = iterOf(self);
    if (!iter.nextBack) panic(ctx, 'この反復子は後ろから取り出せません。');
    const item = iter.nextBack();
    return option(ctx, item === DONE ? undefined : item, item !== DONE);
  },
  'Iter<_>::map': ([self, f], ctx) => {
    const iter = iterOf(self);
    const map = (item: Next): Next => (item === DONE ? DONE : call(ctx, f, [item]));
    return adapter(iter, () => map(nextOf(iter)), iter.nextBack && (() => map(iter.nextBack!())), iter.remaining);
  },
  'Iter<_>::filter': ([self, f], ctx) => {
    const iter = iterOf(self);
    const find = (take: () => Next): Next => {
      for (;;) {
        ctx.runtime.spend();
        const item = take();
        if (item === DONE || truthy(call(ctx, f, [item]))) return item;
      }
    };
    return adapter(iter, () => find(() => nextOf(iter)), iter.nextBack && (() => find(iter.nextBack!)));
  },
  'Iter<_>::filter_map': ([self, f], ctx) => {
    const iter = iterOf(self);
    const find = (take: () => Next): Next => {
      for (;;) {
        ctx.runtime.spend();
        const item = take();
        if (item === DONE) return DONE;
        const result = deref(call(ctx, f, [item])) as EnumValue;
        if (result.variant === 1) return result.fields[0];
      }
    };
    return adapter(iter, () => find(() => nextOf(iter)), iter.nextBack && (() => find(iter.nextBack!)));
  },
  'Iter<_>::map_while': ([self, f], ctx) => {
    const iter = iterOf(self);
    let done = false;
    return adapter(iter, () => {
      if (done) return DONE;
      const item = nextOf(iter);
      if (item === DONE) return DONE;
      const result = deref(call(ctx, f, [item])) as EnumValue;
      if (result.variant === 1) return result.fields[0];
      done = true;
      return DONE;
    });
  },
  'Iter<_>::flat_map': ([self, f], ctx) => {
    const iter = iterOf(self);
    let current: IterValue | undefined;
    return adapter(iter, () => {
      for (;;) {
        ctx.runtime.spend();
        if (current) {
          const item = nextOf(current);
          if (item !== DONE) return item;
        }
        const next = nextOf(iter);
        if (next === DONE) return DONE;
        current = iterOf(call(ctx, f, [next]));
      }
    });
  },
  'Iter<_>::enumerate': ([self]) => {
    const iter = iterOf(self);
    let index = 0;
    const length = iter.remaining;
    return adapter(
      iter,
      () => {
        const item = nextOf(iter);
        return item === DONE ? DONE : [BigInt(index++), item];
      },
      iter.nextBack && length
        ? () => {
            const total = index + length();
            const item = iter.nextBack!();
            return item === DONE ? DONE : [BigInt(total - 1), item];
          }
        : undefined,
      length
    );
  },
  'Iter<_>::zip': ([self, other]) => {
    const iter = iterOf(self);
    const second = iterOf(other);
    return adapter(
      iter,
      () => {
        const a = nextOf(iter);
        if (a === DONE) return DONE;
        const b = nextOf(second);
        return b === DONE ? DONE : [a, b];
      },
      undefined,
      iter.remaining && second.remaining ? () => Math.min(iter.remaining!(), second.remaining!()) : undefined
    );
  },
  'Iter<_>::chain': ([self, other]) => {
    const iter = iterOf(self);
    const second = iterOf(other);
    let firstDone = false;
    return adapter(
      iter,
      () => {
        if (!firstDone) {
          const item = nextOf(iter);
          if (item !== DONE) return item;
          firstDone = true;
        }
        return nextOf(second);
      },
      iter.nextBack && second.nextBack
        ? () => {
            const item = second.nextBack!();
            return item === DONE ? iter.nextBack!() : item;
          }
        : undefined,
      iter.remaining && second.remaining ? () => iter.remaining!() + second.remaining!() : undefined
    );
  },
  'Iter<_>::rev': ([self], ctx) => {
    const iter = iterOf(self);
    if (!iter.nextBack) panic(ctx, 'この反復子は rev で逆にできません。');
    return adapter(iter, iter.nextBack, () => nextOf(iter), iter.remaining);
  },
  'Iter<_>::take': ([self, n]) => {
    const iter = iterOf(self);
    let left = Number(n as bigint);
    return adapter(
      iter,
      () => {
        if (left <= 0) return DONE;
        left--;
        return nextOf(iter);
      },
      undefined,
      iter.remaining ? () => Math.min(left, iter.remaining!()) : undefined
    );
  },
  'Iter<_>::skip': ([self, n]) => {
    const iter = iterOf(self);
    let toSkip = Number(n as bigint);
    const skip = (): void => {
      while (toSkip > 0) {
        toSkip--;
        if (nextOf(iter) === DONE) toSkip = 0;
      }
    };
    return adapter(
      iter,
      () => {
        skip();
        return nextOf(iter);
      },
      iter.nextBack && iter.remaining
        ? () => {
            if (iter.remaining!() <= toSkip) return DONE;
            return iter.nextBack!();
          }
        : undefined,
      iter.remaining ? () => Math.max(0, iter.remaining!() - toSkip) : undefined
    );
  },
  'Iter<_>::take_while': ([self, f], ctx) => {
    const iter = iterOf(self);
    let done = false;
    return adapter(iter, () => {
      if (done) return DONE;
      const item = nextOf(iter);
      if (item === DONE || !truthy(call(ctx, f, [item]))) {
        done = true;
        return DONE;
      }
      return item;
    });
  },
  'Iter<_>::skip_while': ([self, f], ctx) => {
    const iter = iterOf(self);
    let skipping = true;
    return adapter(iter, () => {
      for (;;) {
        const item = nextOf(iter);
        if (item === DONE) return DONE;
        if (skipping && truthy(call(ctx, f, [item]))) continue;
        skipping = false;
        return item;
      }
    });
  },
  'Iter<_>::step_by': ([self, n], ctx) => {
    const iter = iterOf(self);
    const step = Number(n as bigint);
    if (step === 0) libraryPanic(ctx, 'assertion failed: step != 0', 'core/src/iter/adapters/step_by.rs:36:9');
    let first = true;
    return adapter(iter, () => {
      if (first) {
        first = false;
        return nextOf(iter);
      }
      for (let index = 0; index < step - 1; index++) if (nextOf(iter) === DONE) return DONE;
      return nextOf(iter);
    });
  },
  'Iter<_>::peekable': ([self]) => iterOf(self),
  'Iter<_>::fuse': ([self]) => iterOf(self),
  // `&mut I` iterates as `I` does, so the adapters after `by_ref` advance the same iterator.
  'Iter<_>::by_ref': ([self]) => deref(self),
  'Iter<_>::into_iter': ([self]) => iterOf(self),
  'Iter<_>::peek': ([self], ctx) => {
    const iter = iterOf(self);
    iter.peeked ??= [];
    if (iter.peeked.length === 0) iter.peeked.push(iter.next());
    const item = iter.peeked[0];
    return option(ctx, item === DONE ? undefined : item, item !== DONE);
  },
  'Iter<_>::next_if': ([self, f], ctx) => {
    const iter = iterOf(self);
    const item = nextOf(iter);
    if (item === DONE) return none(ctx);
    if (truthy(call(ctx, f, [item]))) return some(ctx, item);
    iter.peeked ??= [];
    iter.peeked.unshift(item);
    return none(ctx);
  },
  'Iter<_>::inspect': ([self, f], ctx) => {
    const iter = iterOf(self);
    return adapter(iter, () => {
      const item = nextOf(iter);
      if (item !== DONE) call(ctx, f, [item]);
      return item;
    });
  },
  'Iter<_>::cycle': ([self], ctx) => {
    const iter = iterOf(self);
    const items = collectAll(ctx, iter);
    const type = ctx.typeArgs[0];
    let index = 0;
    return adapter(iter, () => {
      if (items.length === 0) return DONE;
      ctx.runtime.spend();
      return cloneValue(type, items[index++ % items.length]);
    });
  },
  'Iter<_>::scan': ([self, initial, f], ctx) => {
    const iter = iterOf(self);
    const state = { value: initial };
    const place = { isPlace: true as const, get: () => state.value, set: (v: Value) => void (state.value = v) };
    let done = false;
    return adapter(iter, () => {
      if (done) return DONE;
      const item = nextOf(iter);
      if (item === DONE) return DONE;
      const result = deref(call(ctx, f, [place, item])) as EnumValue;
      if (result.variant === 1) return result.fields[0];
      done = true;
      return DONE;
    });
  },
  'Iter<_>::collect': ([self], ctx) => {
    // Collecting into a `Result` or an `Option` stops at the first `Err` or `None`, taking nothing after it.
    const target = normalize(shallow(ctx.typeArgs[1]));
    const builtin = target.kind === 'adt' ? target.def.builtin : undefined;
    const stopVariant = builtin === 'Result' ? 1 : builtin === 'Option' ? 0 : undefined;
    const stop =
      stopVariant === undefined ? undefined : (item: Value) => (deref(item) as EnumValue).variant === stopVariant;
    return collectInto(ctx, collectAll(ctx, iterOf(self), stop), ctx.typeArgs[1], ctx.typeArgs[0]);
  },
  'Iter<_>::sum': ([self], ctx) => sumOrProduct(ctx, iterOf(self), ctx.typeArgs[1], '+'),
  'Iter<_>::product': ([self], ctx) => sumOrProduct(ctx, iterOf(self), ctx.typeArgs[1], '*'),
  'Iter<_>::count': ([self], ctx) => BigInt(collectAll(ctx, iterOf(self)).length),
  'Iter<_>::len': ([self], ctx) => {
    const iter = iterOf(self);
    if (!iter.remaining) panic(ctx, 'この反復子は len で長さを数えられません。');
    return BigInt(iter.remaining() + (iter.peeked?.filter((item) => item !== DONE).length ?? 0));
  },
  'Iter<_>::last': ([self], ctx) => {
    const items = collectAll(ctx, iterOf(self));
    return option(ctx, items.at(-1), items.length > 0);
  },
  'Iter<_>::nth': ([self, n], ctx) => {
    const iter = iterOf(self);
    for (let index = 0; index < Number(n as bigint); index++) if (nextOf(iter) === DONE) return none(ctx);
    const item = nextOf(iter);
    return option(ctx, item === DONE ? undefined : item, item !== DONE);
  },
  'Iter<_>::nth_back': ([self, n], ctx) => {
    const iter = iterOf(self);
    if (!iter.nextBack) panic(ctx, 'この反復子は後ろから取り出せません。');
    let item: Next = DONE;
    for (let index = 0; index <= Number(n as bigint); index++) {
      item = iter.nextBack();
      if (item === DONE) break;
    }
    return option(ctx, item === DONE ? undefined : item, item !== DONE);
  },
  'Iter<_>::fold': ([self, init, f], ctx) => {
    const iter = iterOf(self);
    let acc = init;
    for (;;) {
      ctx.runtime.spend();
      const item = nextOf(iter);
      if (item === DONE) return acc;
      acc = call(ctx, f, [acc, item]);
    }
  },
  'Iter<_>::reduce': ([self, f], ctx) => {
    const iter = iterOf(self);
    const first = nextOf(iter);
    if (first === DONE) return none(ctx);
    let acc = first;
    for (;;) {
      ctx.runtime.spend();
      const item = nextOf(iter);
      if (item === DONE) return some(ctx, acc);
      acc = call(ctx, f, [acc, item]);
    }
  },
  'Iter<_>::for_each': ([self, f], ctx) => {
    const iter = iterOf(self);
    for (;;) {
      ctx.runtime.spend();
      const item = nextOf(iter);
      if (item === DONE) return [];
      call(ctx, f, [item]);
    }
  },
  'Iter<_>::any': ([self, f], ctx) => {
    const iter = iterOf(self);
    for (;;) {
      ctx.runtime.spend();
      const item = nextOf(iter);
      if (item === DONE) return false;
      if (truthy(call(ctx, f, [item]))) return true;
    }
  },
  'Iter<_>::all': ([self, f], ctx) => {
    const iter = iterOf(self);
    for (;;) {
      ctx.runtime.spend();
      const item = nextOf(iter);
      if (item === DONE) return true;
      if (!truthy(call(ctx, f, [item]))) return false;
    }
  },
  'Iter<_>::find': ([self, f], ctx) => {
    const iter = iterOf(self);
    for (;;) {
      ctx.runtime.spend();
      const item = nextOf(iter);
      if (item === DONE) return none(ctx);
      if (truthy(call(ctx, f, [item]))) return some(ctx, item);
    }
  },
  'Iter<_>::find_map': ([self, f], ctx) => {
    const iter = iterOf(self);
    for (;;) {
      ctx.runtime.spend();
      const item = nextOf(iter);
      if (item === DONE) return none(ctx);
      const result = deref(call(ctx, f, [item])) as EnumValue;
      if (result.variant === 1) return result;
    }
  },
  'Iter<_>::position': ([self, f], ctx) => {
    const iter = iterOf(self);
    for (let index = 0; ; index++) {
      ctx.runtime.spend();
      const item = nextOf(iter);
      if (item === DONE) return none(ctx);
      if (truthy(call(ctx, f, [item]))) return some(ctx, BigInt(index));
    }
  },
  'Iter<_>::rposition': ([self, f], ctx) => {
    const items = collectAll(ctx, iterOf(self));
    for (let index = items.length - 1; index >= 0; index--) {
      if (truthy(call(ctx, f, [items[index]]))) return some(ctx, BigInt(index));
    }
    return none(ctx);
  },
  'Iter<_>::max': ([self], ctx) => extreme(ctx, iterOf(self), (a, b) => compareValues(ctx.typeArgs[0], a, b) ?? 0, 1),
  'Iter<_>::min': ([self], ctx) => extreme(ctx, iterOf(self), (a, b) => compareValues(ctx.typeArgs[0], a, b) ?? 0, -1),
  'Iter<_>::max_by_key': ([self, f], ctx) => extremeByKey(ctx, iterOf(self), f, ctx.typeArgs[1], 1),
  'Iter<_>::min_by_key': ([self, f], ctx) => extremeByKey(ctx, iterOf(self), f, ctx.typeArgs[1], -1),
  'Iter<_>::max_by': ([self, f], ctx) =>
    extreme(ctx, iterOf(self), (a, b) => (deref(call(ctx, f, [a, b])) as EnumValue).variant - 1, 1),
  'Iter<_>::min_by': ([self, f], ctx) =>
    extreme(ctx, iterOf(self), (a, b) => (deref(call(ctx, f, [a, b])) as EnumValue).variant - 1, -1),
  'Iter<_>::partition': ([self, f], ctx) => {
    const items = collectAll(ctx, iterOf(self));
    const yes: Value[] = [];
    const no: Value[] = [];
    for (const item of items) (truthy(call(ctx, f, [item])) ? yes : no).push(item);
    const type = ctx.typeArgs[1];
    return [collectInto(ctx, yes, type, ctx.typeArgs[0]), collectInto(ctx, no, type, ctx.typeArgs[0])];
  },
  'Iter<_>::eq': ([self, other], ctx) => {
    const a = collectAll(ctx, iterOf(self));
    const b = collectAll(ctx, iterOf(other));
    return a.length === b.length && a.every((item, index) => valuesEqual(ctx.typeArgs[0], item, b[index]));
  },
  'Iter<_>::is_sorted': ([self], ctx) => {
    const items = collectAll(ctx, iterOf(self));
    return items.every(
      (item, index) => index === 0 || (compareValues(ctx.typeArgs[0], items[index - 1], item) ?? 1) <= 0
    );
  },
  'Iter<char>::as_str': ([self]) => {
    const iter = iterOf(self);
    const peeked = (iter.peeked ?? []).filter((next) => next !== DONE) as Value[];
    return [...peeked, ...(iter.rest?.() ?? [])].join('');
  },
  'Iter<&_>::copied': ([self]) => derefIter(iterOf(self), true),
  'Iter<&_>::cloned': ([self], ctx) => cloneIter(iterOf(self), ctx.typeArgs[0]),
  'Iter<&mut _>::copied': ([self]) => derefIter(iterOf(self), true),
  'Iter<&mut _>::cloned': ([self], ctx) => cloneIter(iterOf(self), ctx.typeArgs[0]),
  'Iter<(_, _)>::unzip': ([self], ctx) => {
    const items = collectAll(ctx, iterOf(self)) as Value[][];
    const [typeA, typeB, fromA, fromB] = ctx.typeArgs;
    return [
      collectInto(
        ctx,
        items.map((item) => item[0]),
        fromA,
        typeA
      ),
      collectInto(
        ctx,
        items.map((item) => item[1]),
        fromB,
        typeB
      ),
    ];
  },
  'Iter<Iter<_>>::flatten': ([self], ctx) => flatten(ctx, iterOf(self), (item) => iterOf(item)),
  'Iter<Vec<_>>::flatten': ([self], ctx) => flatten(ctx, iterOf(self), (item) => arrayIter(item as Value[])),
  'Iter<&Vec<_>>::flatten': ([self], ctx) => flatten(ctx, iterOf(self), (item) => arrayIter(deref(item) as Value[])),
  // A shared reference is the value it refers to, so `&Option` and `&Result` flatten as their values do.
  'Iter<&Option<_>>::flatten': ([self], ctx) => flattenPresent(ctx, self, 1),
  'Iter<&Result<_, _>>::flatten': ([self], ctx) => flattenPresent(ctx, self, 0),
  'Iter<Option<_>>::flatten': ([self], ctx) => flattenPresent(ctx, self, 1),
  'Iter<Result<_, _>>::flatten': ([self], ctx) => flattenPresent(ctx, self, 0),
  'std::iter::repeat': ([value], ctx) => new IterValue(() => cloneValue(ctx.typeArgs[0], value)),
  'std::iter::repeat_n': ([value, n], ctx) => {
    let left = Number(n as bigint);
    return new IterValue(
      () => (left-- > 0 ? cloneValue(ctx.typeArgs[0], value) : DONE),
      undefined,
      () => Math.max(left, 0)
    );
  },
  'std::iter::once': ([value]) => arrayIter([value]),
  'std::iter::empty': () => arrayIter([]),
  'std::iter::from_fn': ([f], ctx) =>
    new IterValue(() => {
      const result = deref(call(ctx, f, [])) as EnumValue;
      return result.variant === 1 ? result.fields[0] : DONE;
    }),
  'std::iter::successors': ([first, f], ctx) => {
    let current = deref(first) as EnumValue;
    return new IterValue(() => {
      if (current.variant === 0) return DONE;
      const value = current.fields[0];
      current = deref(call(ctx, f, [value])) as EnumValue;
      return value;
    });
  },
  'std::iter::zip': ([a, b], ctx) => NATIVES_ZIP([a, b], ctx),
});

const NATIVES_ZIP = (args: Value[], ctx: NativeContext): Value => {
  const [a, b] = args;
  const first = iterOf(a);
  const second = iterOf(b);
  void ctx;
  return new IterValue(() => {
    const x = nextOf(first);
    if (x === DONE) return DONE;
    const y = nextOf(second);
    return y === DONE ? DONE : [x, y];
  });
};

/** Markers that `Iter::next`'s native returns, which the call site wraps in `Option`. */
const NONE_MARK = undefined as unknown as Value;
const SOME_MARK = (value: Value): Value => value;

/** Replaces the plain native of `Iter::next` with one that knows `Option`. */
define({
  'Iter<_>::next': ([self], ctx) => {
    const iter = iterOf(self);
    const item = nextOf(iter);
    return option(ctx, item === DONE ? undefined : item, item !== DONE);
  },
});

function derefIter(iter: IterValue, copy: boolean): IterValue {
  const take = (item: Next): Next => (item === DONE ? DONE : copy ? copyValue(deref(item)) : deref(item));
  return adapter(iter, () => take(nextOf(iter)), iter.nextBack && (() => take(iter.nextBack!())), iter.remaining);
}

function cloneIter(iter: IterValue, type: Type): IterValue {
  const take = (item: Next): Next => (item === DONE ? DONE : cloneValue(type, deref(item)));
  return adapter(iter, () => take(nextOf(iter)), iter.nextBack && (() => take(iter.nextBack!())), iter.remaining);
}

// code-gauge-allow duplicateLines 15 -- Flattening and flat_map walk nested iterators alike, from different sources.
function flatten(ctx: NativeContext, iter: IterValue, inner: (item: Value) => IterValue): IterValue {
  let current: IterValue | undefined;
  return adapter(iter, () => {
    for (;;) {
      ctx.runtime.spend();
      if (current) {
        const item = nextOf(current);
        if (item !== DONE) return item;
      }
      const next = nextOf(iter);
      if (next === DONE) return DONE;
      current = inner(next);
    }
  });
}

function extreme(ctx: NativeContext, iter: IterValue, compare: (a: Value, b: Value) => number, sign: 1 | -1): Value {
  let best: Next = DONE;
  for (;;) {
    ctx.runtime.spend();
    const item = nextOf(iter);
    if (item === DONE) break;
    // `max` keeps the last of equal elements and `min` the first, as Rust's do.
    if (best === DONE || (sign === 1 ? compare(item, best) >= 0 : compare(item, best) < 0)) best = item;
  }
  return option(ctx, best === DONE ? undefined : best, best !== DONE);
}

function extremeByKey(ctx: NativeContext, iter: IterValue, f: Value, keyType: Type, sign: 1 | -1): Value {
  let best: Next = DONE;
  let bestKey: Value;
  for (;;) {
    ctx.runtime.spend();
    const item = nextOf(iter);
    if (item === DONE) break;
    const key = call(ctx, f, [item]);
    const order = best === DONE ? 0 : (compareValues(keyType, key, bestKey) ?? 0);
    if (best === DONE || (sign === 1 ? order >= 0 : order < 0)) {
      best = item;
      bestKey = key;
    }
  }
  return option(ctx, best === DONE ? undefined : best, best !== DONE);
}

function sumOrProduct(ctx: NativeContext, iter: IterValue, type: Type, op: '+' | '*'): Value {
  const t = normalize(shallow(type));
  let total: Value = op === '+' ? (t.kind === 'float' ? -0 : 0n) : t.kind === 'float' ? 1 : 1n;
  for (;;) {
    ctx.runtime.spend();
    const item = nextOf(iter);
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

/** Collects elements into a collection of the type `collect` was asked for. */
// code-gauge-allow functionCognitiveComplexity 23 -- One native per method of the standard library.
// code-gauge-allow functionNcss 52 -- One native per method of the standard library.
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
      return items;
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
