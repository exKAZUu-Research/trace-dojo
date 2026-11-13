// code-gauge-allow-file fileNcss 900 -- Enumerable's methods share the iteration helpers.
import { caseEquals, compareValues, inspect, rEquals, spaceship, toIndex, toInt } from './conversions';
import { def } from './define';
import { argumentError, typeError } from './errors';
import { eachEntry, hashGet, hashKeyOf, hashSet } from './hashes';
import { callBlock, callMethod, callProc, type Gen, nativeProc, respondsTo } from './interp';
import { iterateEnumerator, makeEnumerator, sizedEnumerator } from './libEnumerator';
import { NIL, RArray, RHash, RObject, type RProc, RRange, RString, RSymbol, type Value } from './objects';
import { rt, UnsupportedFeatureError } from './runtime';
import { isUniformKey, platformSort, uniformSort } from './sorting';
import { arr, newHash, realClassOf, truthy } from './values';

/** Stops an iteration early, as `break` does, when a method has what it needs. */
class StopSignal {}

export const STOP = Symbol('stop');
type Visit = (value: Value) => Gen<unknown>;

/**
 * Visits each element of a collection as Enumerable sees it: an Array's items (as the array is now), a Hash's
 * `[key, value]` pairs, a Range's members, or whatever `each` yields (several values packed into an array). The
 * visitor returns {@link STOP} to end the iteration.
 */
export function* iterate(collection: Value, visit: Visit): Gen<void> {
  const runtime = rt();
  if (collection instanceof RArray && !isOverridden(collection)) {
    for (let index = 0; index < collection.items.length; index++) {
      runtime.spend();
      if ((yield* visit(collection.items[index])) === STOP) return;
    }
    return;
  }
  if (collection instanceof RHash && !isOverridden(collection)) {
    let stopped = false;
    yield* eachEntry(collection, function* (entry) {
      if (stopped) return;
      runtime.spend();
      if ((yield* visit(arr([entry.key, entry.value]))) === STOP) stopped = true;
    });
    return;
  }
  if (collection instanceof RRange && !isOverridden(collection)) {
    const { iterateRange } = rangeHelpers;
    yield* iterateRange(collection, visit);
    return;
  }
  const signal = new StopSignal();
  const block = nativeProc(-1, function* (args) {
    runtime.spend();
    const value = args.length === 1 ? args[0] : args.length === 0 ? NIL : arr(args);
    if ((yield* visit(value)) === STOP) throw signal;
    return NIL;
  });
  try {
    yield* collection instanceof RObject && collection.cls === runtime.c.Enumerator
      ? iterateEnumerator(collection, function* (value) {
          runtime.spend();
          if ((yield* visit(value)) === STOP) throw signal;
          return NIL;
        })
      : callMethod(collection, 'each', [], undefined, block);
  } catch (error) {
    if (error !== signal) throw error;
  }
}

/** The helpers Range provides to {@link iterate}, set by its module to avoid an import cycle. */
export const rangeHelpers: { iterateRange: (range: RRange, visit: Visit) => Gen<void> } = {
  iterateRange: () => {
    throw new Error('Range helpers are not installed');
  },
};

function isOverridden(collection: RArray | RHash | RRange): boolean {
  const method = (collection.singleton ?? collection.cls).findMethod('each');
  return method !== undefined && method.body.kind !== 'native';
}

export function* toArray(collection: Value): Gen<Value[]> {
  if (collection instanceof RArray && !isOverridden(collection)) return [...collection.items];
  const items: Value[] = [];
  yield* iterate(collection, function* (value) {
    items.push(value);
    yield* [];
  });
  return items;
}

/** Calls a block with one element, splatting an array over several parameters as `yield` does. */
function call(block: RProc, value: Value, used = true): Gen {
  return callBlock(block, [value], used);
}

def('Enumerable', ['to_a', 'entries'], [0, -1], function* (self) {
  return arr(yield* toArray(self));
});
def('Enumerable', ['map', 'collect'], 0, function* (self, _args, block) {
  if (!block) return sizedEnumerator(self, 'map', [], () => sizeOf(self));
  const results: Value[] = [];
  yield* iterate(self, function* (value) {
    results.push(yield* call(block, value));
  });
  return arr(results);
});
def('Enumerable', ['flat_map', 'collect_concat'], 0, function* (self, _args, block) {
  if (!block) return makeEnumerator(self, 'flat_map', []);
  const results: Value[] = [];
  yield* iterate(self, function* (value) {
    const mapped = yield* call(block, value);
    if (mapped instanceof RArray) results.push(...mapped.items);
    else results.push(mapped);
  });
  return arr(results);
});
def('Enumerable', ['select', 'filter', 'find_all'], 0, function* (self, _args, block) {
  if (!block) return makeEnumerator(self, 'select', []);
  const results: Value[] = [];
  yield* iterate(self, function* (value) {
    if (truthy(yield* call(block, value))) results.push(value);
  });
  return arr(results);
});
def('Enumerable', 'filter_map', 0, function* (self, _args, block) {
  if (!block) return makeEnumerator(self, 'filter_map', []);
  const results: Value[] = [];
  yield* iterate(self, function* (value) {
    const mapped = yield* call(block, value);
    if (truthy(mapped)) results.push(mapped);
  });
  return arr(results);
});
def('Enumerable', 'reject', 0, function* (self, _args, block) {
  if (!block) return makeEnumerator(self, 'reject', []);
  const results: Value[] = [];
  yield* iterate(self, function* (value) {
    if (!truthy(yield* call(block, value))) results.push(value);
  });
  return arr(results);
});
def('Enumerable', 'partition', 0, function* (self, _args, block) {
  if (!block) return makeEnumerator(self, 'partition', []);
  const accepted: Value[] = [];
  const rejected: Value[] = [];
  yield* iterate(self, function* (value) {
    (truthy(yield* call(block, value)) ? accepted : rejected).push(value);
  });
  return arr([arr(accepted), arr(rejected)]);
});
def('Enumerable', ['find', 'detect'], [0, 1], function* (self, args, block) {
  if (!block) return makeEnumerator(self, 'find', args);
  let found: Value = NIL;
  let matched = false;
  yield* iterate(self, function* (value) {
    if (truthy(yield* call(block, value))) {
      found = value;
      matched = true;
      return STOP;
    }
  });
  if (!matched && args.length > 0 && args[0] !== NIL) return yield* callMethod(args[0], 'call', []);
  return found;
});
def('Enumerable', 'find_index', [0, 1], function* (self, args, block) {
  if (!block && args.length === 0) return makeEnumerator(self, 'find_index', []);
  let index = 0n;
  let found: Value = NIL;
  yield* iterate(self, function* (value) {
    const matched = args.length > 0 ? yield* rEquals(value, args[0]) : truthy(yield* call(block as RProc, value));
    if (matched) {
      found = index;
      return STOP;
    }
    index++;
  });
  return found;
});
def('Enumerable', 'each_with_index', [0, -1], function* (self, args, block) {
  if (!block) return makeEnumerator(self, 'each_with_index', args);
  let index = 0n;
  yield* iterate(self, function* (value) {
    yield* callBlock(block, [value, index++], false);
  });
  return self;
});
def('Enumerable', 'each_with_object', 1, function* (self, [memo], block) {
  if (!block) return makeEnumerator(self, 'each_with_object', [memo]);
  yield* iterate(self, function* (value) {
    yield* callBlock(block, [value, memo], false);
  });
  return memo;
});
def('Enumerable', 'each_entry', [0, -1], function* (self, _args, block) {
  if (!block) return makeEnumerator(self, 'each_entry', []);
  yield* iterate(self, function* (value) {
    yield* callBlock(block, [value], false);
  });
  return self;
});
def('Enumerable', 'reverse_each', [0, -1], function* (self, _args, block) {
  if (!block) return makeEnumerator(self, 'reverse_each', []);
  const items = yield* toArray(self);
  for (let index = items.length - 1; index >= 0; index--) yield* callBlock(block, [items[index]], false);
  return self;
});

/** `inject`/`reduce`: folds with a block or with the method a symbol names, from an initial value or the first. */
export function* inject(self: Value, args: Value[], block: RProc | undefined): Gen {
  let accumulator: Value | undefined;
  let operator: string | undefined;
  if (args.length === 2) {
    accumulator = args[0];
    operator = yield* operatorName(args[1]);
  } else if (args.length === 1 && !block) {
    operator = yield* operatorName(args[0]);
  } else if (args.length === 1) {
    accumulator = args[0];
  }
  yield* iterate(self, function* (value) {
    if (accumulator === undefined) {
      accumulator = value;
      return;
    }
    accumulator =
      operator === undefined
        ? yield* callBlock(block as RProc, [accumulator, value])
        : yield* fastOperator(accumulator, operator, value);
  });
  return accumulator ?? NIL;
}

function* operatorName(value: Value): Gen<string> {
  if (value instanceof RSymbol) return value.name;
  if (value instanceof RString) return value.s;
  throw typeError(`${yield* inspect(value)} is not a symbol nor a string`);
}

function* fastOperator(left: Value, operator: string, right: Value): Gen {
  return yield* callMethod(left, operator, [right]);
}

def('Enumerable', ['inject', 'reduce'], [0, 2], (self, args, block) => inject(self, args, block));

/** `sum`, adding Integers exactly and Floats with Kahan-Babuska compensation as Ruby does. */
export function* sum(self: Value, args: Value[], block: RProc | undefined): Gen {
  let total: Value = args.length > 0 ? args[0] : 0n;
  const items: Value[] = [];
  yield* iterate(self, function* (value) {
    items.push(block ? yield* call(block, value) : value);
  });
  if (items.length === 0) return total;
  const initIsFloat = typeof total === 'number';
  const initial = total;
  let index = 0;
  if (typeof total === 'bigint' || initIsFloat) {
    let exact = initIsFloat ? 0n : (total as bigint);
    for (; index < items.length && typeof items[index] === 'bigint'; index++) exact += items[index] as bigint;
    total = exact;
    if (index === items.length) return initIsFloat ? (initial as number) + Number(exact) : exact;
    if (initIsFloat || typeof items[index] === 'number') {
      let f = initIsFloat && typeof items[index] !== 'number' ? (initial as number) + Number(exact) : Number(exact);
      let c = 0;
      if (initIsFloat && typeof items[index] === 'number') f += initial as number;
      for (; index < items.length; index++) {
        const item = items[index];
        if (typeof item !== 'number' && typeof item !== 'bigint') {
          total = f;
          break;
        }
        const x = Number(item);
        if (Number.isNaN(f)) continue;
        if (Number.isNaN(x)) {
          f = x;
          continue;
        }
        if (!Number.isFinite(x)) {
          f = !Number.isFinite(f) && Math.sign(x) !== Math.sign(f) ? Number.NaN : x;
          continue;
        }
        if (!Number.isFinite(f)) continue;
        const t = f + x;
        c += Math.abs(f) >= Math.abs(x) ? f - t + x : x - t + f;
        f = t;
      }
      if (index === items.length) return f + c;
    }
  }
  for (; index < items.length; index++) total = yield* callMethod(total, '+', [items[index]]);
  return total;
}

def('Enumerable', 'sum', [0, 1], (self, args, block) => sum(self, args, block));
def('Enumerable', 'count', [0, 1], function* (self, args, block) {
  let count = 0n;
  yield* iterate(self, function* (value) {
    if (args.length > 0) {
      if (yield* rEquals(value, args[0])) count++;
    } else if (!block || truthy(yield* call(block, value))) {
      count++;
    }
  });
  return count;
});

function* predicate(
  self: Value,
  args: Value[],
  block: RProc | undefined,
  test: (value: Value) => Gen<boolean>
): Gen<void> {
  void args;
  void block;
  yield* iterate(self, function* (value) {
    if (yield* test(value)) return STOP;
  });
}

function* matches(value: Value, args: Value[], block: RProc | undefined): Gen<boolean> {
  if (args.length > 0) return yield* caseEquals(args[0], value);
  if (block) return truthy(yield* call(block, value));
  return truthy(value);
}

def('Enumerable', 'all?', [0, 1], function* (self, args, block) {
  let result = true;
  yield* predicate(self, args, block, function* (value) {
    if (!(yield* matches(value, args, block))) {
      result = false;
      return true;
    }
    return false;
  });
  return result;
});
def('Enumerable', 'any?', [0, 1], function* (self, args, block) {
  let result = false;
  yield* predicate(self, args, block, function* (value) {
    if (yield* matches(value, args, block)) {
      result = true;
      return true;
    }
    return false;
  });
  return result;
});
def('Enumerable', 'none?', [0, 1], function* (self, args, block) {
  let result = true;
  yield* predicate(self, args, block, function* (value) {
    if (yield* matches(value, args, block)) {
      result = false;
      return true;
    }
    return false;
  });
  return result;
});
def('Enumerable', 'one?', [0, 1], function* (self, args, block) {
  let count = 0;
  yield* predicate(self, args, block, function* (value) {
    if (yield* matches(value, args, block)) count++;
    return count > 1;
  });
  return count === 1;
});
def('Enumerable', ['include?', 'member?'], 1, function* (self, [target]) {
  let found = false;
  yield* iterate(self, function* (value) {
    if (yield* rEquals(value, target)) {
      found = true;
      return STOP;
    }
  });
  return found;
});
def('Enumerable', 'first', [0, 1], function* (self, args) {
  if (args.length === 0) {
    let found: Value = NIL;
    yield* iterate(self, function* (value) {
      found = value;
      return STOP;
    });
    return found;
  }
  const count = yield* toIndex(args[0]);
  if (count < 0) throw argumentError('attempt to take negative size');
  const items: Value[] = [];
  if (count === 0) return arr([]);
  yield* iterate(self, function* (value) {
    items.push(value);
    if (items.length >= count) return STOP;
  });
  return arr(items);
});
def('Enumerable', 'take', 1, function* (self, [countValue]) {
  const count = yield* toIndex(countValue);
  if (count < 0) throw argumentError('attempt to take negative size');
  const items: Value[] = [];
  if (count === 0) return arr([]);
  yield* iterate(self, function* (value) {
    items.push(value);
    if (items.length >= count) return STOP;
  });
  return arr(items);
});
def('Enumerable', 'take_while', 0, function* (self, _args, block) {
  if (!block) return makeEnumerator(self, 'take_while', []);
  const items: Value[] = [];
  yield* iterate(self, function* (value) {
    if (!truthy(yield* call(block, value))) return STOP;
    items.push(value);
  });
  return arr(items);
});
def('Enumerable', 'drop', 1, function* (self, [countValue]) {
  const count = yield* toIndex(countValue);
  if (count < 0) throw argumentError('attempt to drop negative size');
  return arr((yield* toArray(self)).slice(count));
});
def('Enumerable', 'drop_while', 0, function* (self, _args, block) {
  if (!block) return makeEnumerator(self, 'drop_while', []);
  const items: Value[] = [];
  let dropping = true;
  yield* iterate(self, function* (value) {
    if (dropping && truthy(yield* call(block, value))) return;
    dropping = false;
    items.push(value);
  });
  return arr(items);
});

// Ordering ------------------------------------------------------------------------------------------------------------

function* blockCompare(block: RProc, a: Value, b: Value): Gen<number> {
  const result = yield* callBlock(block, [a, b]);
  if (result === NIL) throw argumentError(`comparison of ${className(a)} with ${className(b)} failed`);
  if (typeof result === 'bigint') return result > 0n ? 1 : result < 0n ? -1 : 0;
  if (typeof result === 'number') return Math.sign(result);
  if (truthy(yield* callMethod(result, '>', [0n]))) return 1;
  return truthy(yield* callMethod(result, '<', [0n])) ? -1 : 0;
}

function className(value: Value): string {
  if (value === NIL) return 'NilClass';
  return realClassOf(value).name ?? '';
}

/** Sorts values as `sort` does: by `<=>`, or by the block's comparison. */
export function* sortValues(items: Value[], block: RProc | undefined): Gen<Value[]> {
  const sorted = [...items];
  yield* platformSort(sorted, block ? (a, b) => blockCompare(block, a, b) : compareValues);
  return sorted;
}

/** Sorts values by keys a block computes, as `sort_by` does. */
export function* sortBy(items: Value[], block: RProc): Gen<Value[]> {
  const pairs: { key: Value; value: Value }[] = [];
  for (const value of items) pairs.push({ key: yield* call(block, value), value });
  if (pairs.length > 1 && pairs.every((pair) => isUniformKey(pair.key))) {
    uniformSort(pairs);
  } else {
    yield* platformSort(pairs, (a, b) => compareValues(a.key, b.key));
  }
  return pairs.map((pair) => pair.value);
}

def('Enumerable', 'sort', 0, function* (self, _args, block) {
  return arr(yield* sortValues(yield* toArray(self), block));
});
def('Enumerable', 'sort_by', 0, function* (self, _args, block) {
  if (!block) return sizedEnumerator(self, 'sort_by', [], () => sizeOf(self));
  return arr(yield* sortBy(yield* toArray(self), block));
});

/** The n smallest (or largest with `reverse`) elements, as Ruby's `rb_nmin_run` selects and orders them. */
export function* nmin(
  items: Iterable<Value> | Value,
  countValue: Value,
  by: RProc | undefined,
  block: RProc | undefined,
  reverse: boolean
): Gen<Value> {
  const n = yield* toIndex(countValue);
  if (n < 0) throw argumentError(`negative size (${n})`);
  if (n === 0) return arr([]);
  const compare = function* (a: Value, b: Value): Gen<number> {
    return block && !by ? yield* blockCompare(block, a, b) : yield* compareValues(a, b);
  };
  let buffer: { key: Value; value: Value }[] = [];
  let limit: Value | undefined;
  const bufferMax = n * 4;
  const filter = function* (): Gen<void> {
    if (buffer.length <= n) return;
    let left = 0;
    let right = buffer.length - 1;
    let storeIndex = 0;
    const swap = (i: number, j: number): void => {
      [buffer[i], buffer[j]] = [buffer[j], buffer[i]];
    };
    for (;;) {
      let pivotIndex = left + Math.floor((right - left) / 2);
      let pivots = 1;
      swap(pivotIndex, right);
      pivotIndex = right;
      storeIndex = left;
      let i = left;
      while (i <= right - pivots) {
        let c = yield* compare(buffer[i].key, buffer[pivotIndex].key);
        if (reverse) c = -c;
        if (c === 0) {
          swap(i, right - pivots);
          pivots++;
          continue;
        }
        if (c < 0) {
          swap(i, storeIndex);
          storeIndex++;
        }
        i++;
      }
      let j = storeIndex;
      for (i = right; right - pivots < i; i--) {
        if (i <= j) break;
        swap(j, i);
        j++;
      }
      if (storeIndex <= n && n <= storeIndex + pivots) break;
      if (n < storeIndex) right = storeIndex - 1;
      else left = storeIndex + pivots;
    }
    limit = buffer[storeIndex].key;
    buffer = buffer.slice(0, n);
  };
  const add = function* (value: Value): Gen<void> {
    const key = by ? yield* call(by, value) : value;
    if (limit !== undefined) {
      let c = yield* compare(key, limit);
      if (reverse) c = -c;
      if (c >= 0) return;
    }
    buffer.push({ key, value });
    if (buffer.length === bufferMax) yield* filter();
  };
  if (Array.isArray(items)) {
    for (const value of items) yield* add(value);
  } else {
    yield* iterate(items as Value, function* (value) {
      yield* add(value);
    });
  }
  yield* filter();
  yield* platformSort(buffer, (a, b) => compare(a.key, b.key));
  if (reverse) buffer.reverse();
  return arr(buffer.map((entry) => entry.value));
}

function* extreme(self: Value, block: RProc | undefined, wantMax: boolean): Gen {
  let result: Value | undefined;
  yield* iterate(self, function* (value) {
    if (result === undefined) {
      result = value;
      return;
    }
    const order = block ? yield* blockCompare(block, value, result) : yield* compareValues(value, result);
    if (wantMax ? order > 0 : order < 0) result = value;
  });
  return result ?? NIL;
}

function* extremeBy(self: Value, block: RProc, wantMax: boolean): Gen {
  let result: Value = NIL;
  let best: Value | undefined;
  yield* iterate(self, function* (value) {
    const key = yield* call(block, value);
    if (best === undefined) {
      best = key;
      result = value;
      return;
    }
    const order = yield* compareValues(key, best);
    if (wantMax ? order > 0 : order < 0) {
      best = key;
      result = value;
    }
  });
  return result;
}

def('Enumerable', 'min', [0, 1], function* (self, args, block) {
  if (args.length > 0 && args[0] !== NIL) return yield* nmin(self, args[0], undefined, block, false);
  return yield* extreme(self, block, false);
});
def('Enumerable', 'max', [0, 1], function* (self, args, block) {
  if (args.length > 0 && args[0] !== NIL) return yield* nmin(self, args[0], undefined, block, true);
  return yield* extreme(self, block, true);
});
def('Enumerable', 'min_by', [0, 1], function* (self, args, block) {
  if (!block) return makeEnumerator(self, 'min_by', args);
  if (args.length > 0 && args[0] !== NIL) return yield* nmin(self, args[0], block, undefined, false);
  return yield* extremeBy(self, block, false);
});
def('Enumerable', 'max_by', [0, 1], function* (self, args, block) {
  if (!block) return makeEnumerator(self, 'max_by', args);
  if (args.length > 0 && args[0] !== NIL) return yield* nmin(self, args[0], block, undefined, true);
  return yield* extremeBy(self, block, true);
});
def('Enumerable', 'minmax', 0, function* (self, _args, block) {
  let min: Value | undefined;
  let max: Value | undefined;
  yield* iterate(self, function* (value) {
    if (min === undefined || max === undefined) {
      min = value;
      max = value;
      return;
    }
    if ((yield* orderOf(block, value, min)) < 0) min = value;
    if ((yield* orderOf(block, value, max)) > 0) max = value;
  });
  return arr([min ?? NIL, max ?? NIL]);
});
function orderOf(block: RProc | undefined, a: Value, b: Value): Gen<number> {
  return block ? blockCompare(block, a, b) : compareValues(a, b);
}

def('Enumerable', 'minmax_by', 0, function* (self, _args, block) {
  if (!block) return makeEnumerator(self, 'minmax_by', []);
  return arr([yield* extremeBy(self, block, false), yield* extremeBy(self, block, true)]);
});

// Grouping ------------------------------------------------------------------------------------------------------------

def('Enumerable', 'group_by', 0, function* (self, _args, block) {
  if (!block) return makeEnumerator(self, 'group_by', []);
  const groups = newHash();
  yield* iterate(self, function* (value) {
    const key = yield* call(block, value);
    const entry = yield* hashGet(groups, key);
    if (entry) (entry.value as RArray).items.push(value);
    else yield* hashSet(groups, key, arr([value]));
  });
  return groups;
});
def('Enumerable', 'chunk_while', 0, function* (self, _args, block) {
  return arr(yield* chunks(self, block as RProc, false));
});
def('Enumerable', 'slice_when', 0, function* (self, _args, block) {
  return arr(yield* chunks(self, block as RProc, true));
});

function* chunks(self: Value, block: RProc, splitWhenTrue: boolean): Gen<Value[]> {
  const result: Value[] = [];
  let current: Value[] = [];
  let previous: Value | undefined;
  yield* iterate(self, function* (value) {
    if (previous !== undefined) {
      const split = truthy(yield* callBlock(block, [previous, value])) === splitWhenTrue;
      if (split) {
        result.push(arr(current));
        current = [];
      }
    }
    current.push(value);
    previous = value;
  });
  if (current.length > 0) result.push(arr(current));
  return result;
}

def('Enumerable', 'each_slice', 1, function* (self, [sizeValue], block) {
  const size = yield* toIndex(sizeValue);
  if (size <= 0) throw argumentError('invalid slice size');
  if (!block) return makeEnumerator(self, 'each_slice', [sizeValue]);
  let current: Value[] = [];
  yield* iterate(self, function* (value) {
    current.push(value);
    if (current.length === size) {
      const slice = arr(current);
      current = [];
      yield* callBlock(block, [slice], false);
    }
  });
  if (current.length > 0) yield* callBlock(block, [arr(current)], false);
  return self;
});
def('Enumerable', 'each_cons', 1, function* (self, [sizeValue], block) {
  const size = yield* toIndex(sizeValue);
  if (size <= 0) throw argumentError('invalid size');
  if (!block) return makeEnumerator(self, 'each_cons', [sizeValue]);
  const window: Value[] = [];
  yield* iterate(self, function* (value) {
    window.push(value);
    if (window.length > size) window.shift();
    if (window.length === size) yield* callBlock(block, [arr([...window])], false);
  });
  return self;
});
def('Enumerable', 'chunk', 0, function* (self, _args, block) {
  if (!block) return makeEnumerator(self, 'chunk', []);
  const result: Value[] = [];
  let currentKey: Value | undefined;
  let current: Value[] = [];
  yield* iterate(self, function* (value) {
    const key = yield* call(block, value);
    if (key === NIL || (key instanceof RSymbol && key.name === '_separator')) {
      if (current.length > 0) result.push(arr([currentKey as Value, arr(current)]));
      current = [];
      currentKey = undefined;
      return;
    }
    if (currentKey !== undefined && !(yield* rEquals(currentKey, key))) {
      result.push(arr([currentKey, arr(current)]));
      current = [];
    }
    currentKey = key;
    current.push(value);
  });
  if (current.length > 0) result.push(arr([currentKey as Value, arr(current)]));
  return arr(result);
});
def('Enumerable', 'tally', [0, 1], function* (self, args) {
  const counts = args.length > 0 && args[0] instanceof RHash ? args[0] : newHash();
  yield* iterate(self, function* (value) {
    const entry = yield* hashGet(counts, value);
    yield* hashSet(counts, value, entry ? yield* callMethod(entry.value, '+', [1n]) : 1n);
  });
  return counts;
});
def('Enumerable', 'uniq', 0, function* (self, _args, block) {
  return arr(yield* uniqValues(yield* toArray(self), block));
});

export function* uniqValues(items: Value[], block: RProc | undefined): Gen<Value[]> {
  const seen = new Set<string>();
  const result: Value[] = [];
  for (const value of items) {
    const key = yield* hashKeyOf(block ? yield* call(block, value) : value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

def('Enumerable', 'to_h', [0, -1], function* (self, _args, block) {
  const hash = newHash();
  yield* iterate(self, function* (value) {
    const pair = block ? yield* call(block, value) : value;
    if (!(pair instanceof RArray)) {
      throw typeError(`wrong element type ${className(pair)} (expected array)`);
    }
    if (pair.items.length !== 2) {
      throw argumentError(`element has wrong array length (expected 2, was ${pair.items.length})`);
    }
    yield* hashSet(hash, pair.items[0], pair.items[1]);
  });
  return hash;
});
def('Enumerable', 'zip', [0, -1], function* (self, others, block) {
  const lists: Value[][] = [];
  for (const other of others) lists.push(yield* toArray(other));
  const results: Value[] = [];
  let index = 0;
  yield* iterate(self, function* (value) {
    const tuple = arr([value, ...lists.map((list) => list[index] ?? NIL)]);
    index++;
    if (block) yield* callBlock(block, [tuple], false);
    else results.push(tuple);
  });
  return block ? NIL : arr(results);
});
def('Enumerable', 'cycle', [0, 1], function* (self, args, block) {
  if (!block) return makeEnumerator(self, 'cycle', args);
  const items = yield* toArray(self);
  if (items.length === 0) return NIL;
  const times = args.length > 0 && args[0] !== NIL ? yield* toInt(args[0]) : -1n;
  for (let round = 0n; times < 0n || round < times; round++) {
    for (const item of items) yield* callBlock(block, [item], false);
  }
  return NIL;
});
def('Enumerable', 'compact', 0, function* (self) {
  return arr((yield* toArray(self)).filter((value) => value !== NIL));
});
def('Enumerable', 'lazy', 0, () => {
  throw new UnsupportedFeatureError('遅延評価（lazy）');
});

def('Enumerable', 'to_set', 0, function* (self) {
  return yield* callMethod(rt().c.Set, 'new', [self]);
});

/** The size of a collection when it can tell without iterating, for an enumerator's `size`. */
export function sizeOf(collection: Value): Value {
  if (collection instanceof RArray) return BigInt(collection.items.length);
  if (collection instanceof RHash) return BigInt(collection.map.size);
  return NIL;
}

export { callProc, respondsTo, spaceship };
