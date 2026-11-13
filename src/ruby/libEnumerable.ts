// code-gauge-allow-file fileNcss 677 -- The libEnumerable module keeps one concern's cases together.
import {
  caseEquals,
  compareValues,
  comparisonFailed,
  inspect,
  rEquals,
  spaceship,
  toIndex,
  toInt,
} from './conversions';
import { def } from './define';
import { argumentCountError, argumentError, typeError } from './errors';
import { eachEntry, hashGet, hashSet } from './hashes';
import { callBlock, callMethod, callProc, flattenGenerator, type Gen, nativeProc, respondsTo } from './interp';
import { tryAry } from './libArray';
import {
  customEnumerator,
  type EnumeratorSource,
  iterateEnumerator,
  makeEnumerator,
  receiverSize,
  sizedEnumerator,
} from './libEnumerator';
import { NIL, RArray, RHash, RObject, type RProc, RRange, RString, RSymbol, type Value } from './objects';
import { rt, UnsupportedFeatureError, whileHeld } from './runtime';
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
export function* iterate(collection: Value, visit: Visit, args: Value[] = []): Gen<void> {
  const runtime = rt();
  if (args.length === 0 && collection instanceof RArray && !isOverridden(collection)) {
    for (let index = 0; index < collection.items.length; index++) {
      runtime.spend();
      if ((yield* visit(collection.items[index])) === STOP) return;
    }
    return;
  }
  if (args.length === 0 && collection instanceof RHash && !isOverridden(collection)) {
    let stopped = false;
    yield* eachEntry(collection, function* (entry) {
      if (stopped) return;
      runtime.spend();
      if ((yield* visit(arr([entry.key, entry.value]))) === STOP) stopped = true;
    });
    return;
  }
  if (args.length === 0 && collection instanceof RRange && !isOverridden(collection)) {
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
    yield* args.length === 0 && collection instanceof RObject && collection.cls.isSubclassOf(runtime.c.Enumerator)
      ? iterateEnumerator(collection, function* (value) {
          runtime.spend();
          if ((yield* visit(value)) === STOP) throw signal;
          return NIL;
        })
      : callMethod(collection, 'each', args, undefined, block);
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

export function* toArray(collection: Value, args: Value[] = []): Gen<Value[]> {
  if (args.length === 0 && collection instanceof RArray && !isOverridden(collection)) return [...collection.items];
  const items: Value[] = [];
  yield* collectInto(
    collection,
    [items],
    function* (value) {
      items.push(value);
      yield* [];
    },
    args
  );
  return items;
}

function* collectInto(collection: Value, arrays: Value[][], visit: Visit, args: Value[] = []): Gen<void> {
  const held = rt().heldArrays;
  const mark = held.length;
  for (const array of arrays) held.push(array);
  try {
    yield* iterate(collection, visit, args);
  } finally {
    held.length = mark;
  }
}

/** Calls a block with one element, splatting an array over several parameters as `yield` does. */
function call(block: RProc, value: Value, used = true): Gen {
  return callBlock(block, [value], used);
}

def('Enumerable', ['to_a', 'entries'], [0, -1], function* (self, args) {
  return arr(yield* toArray(self, args));
});
def('Enumerable', ['map', 'collect'], 0, function* (self, _args, block) {
  if (!block) return sizedEnumerator(self, 'map', [], () => sizeOf(self));
  const results: Value[] = [];
  yield* collectInto(self, [results], function* (value) {
    results.push(yield* call(block, value));
  });
  return arr(results);
});
def('Enumerable', ['flat_map', 'collect_concat'], 0, function* (self, _args, block) {
  if (!block) return makeEnumerator(self, 'flat_map', []);
  const results: Value[] = [];
  yield* collectInto(self, [results], function* (value) {
    const mapped = yield* call(block, value);
    const converted = yield* tryAry(mapped);
    if (converted) for (const item of converted.items) results.push(item);
    else results.push(mapped);
  });
  return arr(results);
});
def('Enumerable', ['select', 'filter', 'find_all'], 0, function* (self, _args, block) {
  if (!block) return makeEnumerator(self, 'select', []);
  const results: Value[] = [];
  yield* collectInto(self, [results], function* (value) {
    if (truthy(yield* call(block, value))) results.push(value);
  });
  return arr(results);
});
for (const [name, inverted] of [
  ['grep', false],
  ['grep_v', true],
] as const)
  def('Enumerable', name, 1, function* (self, [pattern], block) {
    const matches: Value[] = [];
    yield* collectInto(self, [matches], function* (value) {
      if ((yield* caseEquals(pattern, value)) !== inverted) matches.push(block ? yield* call(block, value) : value);
    });
    return arr(matches);
  });
def('Enumerable', 'filter_map', 0, function* (self, _args, block) {
  if (!block) return makeEnumerator(self, 'filter_map', []);
  const results: Value[] = [];
  yield* collectInto(self, [results], function* (value) {
    const mapped = yield* call(block, value);
    if (truthy(mapped)) results.push(mapped);
  });
  return arr(results);
});
def('Enumerable', 'reject', 0, function* (self, _args, block) {
  if (!block) return makeEnumerator(self, 'reject', []);
  const results: Value[] = [];
  yield* collectInto(self, [results], function* (value) {
    if (!truthy(yield* call(block, value))) results.push(value);
  });
  return arr(results);
});
def('Enumerable', 'partition', 0, function* (self, _args, block) {
  if (!block) return makeEnumerator(self, 'partition', []);
  const accepted: Value[] = [];
  const rejected: Value[] = [];
  yield* collectInto(self, [accepted, rejected], function* (value) {
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
  yield* iterate(
    self,
    function* (value) {
      yield* callBlock(block, [value, index++], false);
    },
    args
  );
  return self;
});
def('Enumerable', 'each_with_object', 1, function* (self, [memo], block) {
  if (!block) return makeEnumerator(self, 'each_with_object', [memo]);
  yield* iterate(self, function* (value) {
    yield* callBlock(block, [value, memo], false);
  });
  return memo;
});
def('Enumerable', 'each_entry', [0, -1], function* (self, args, block) {
  if (!block) return makeEnumerator(self, 'each_entry', args);
  yield* iterate(
    self,
    function* (value) {
      yield* callBlock(block, [value], false);
    },
    args
  );
  return self;
});
def('Enumerable', 'reverse_each', [0, -1], function* (self, args, block) {
  if (!block) return makeEnumerator(self, 'reverse_each', args);
  const items = yield* toArray(self, args);
  for (let index = items.length - 1; index >= 0; index--) yield* callBlock(block, [items[index]], false);
  return self;
});

/** `inject`/`reduce`: folds with a block or with the method a symbol names, from an initial value or the first. */
export function* inject(self: Value, args: Value[], block: RProc | undefined): Gen {
  if (args.length > 2) throw argumentCountError(args.length, 1, 2);
  if (args.length === 0 && !block) throw argumentCountError(0, 1, 2);
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

def('Enumerable', ['inject', 'reduce'], [0, -1], (self, args, block) => inject(self, args, block));

/** `sum`, adding Integers exactly and Floats with Kahan-Babuska compensation as Ruby does. */
export function* sum(self: Value, args: Value[], block: RProc | undefined): Gen {
  let total: Value = args.length > 0 ? args[0] : 0n;
  const initial = typeof total === 'number' ? total : undefined;
  let exact = typeof total === 'bigint' ? total : 0n;
  let floating: number | undefined;
  let compensation = 0;
  let sawValue = false;
  yield* iterate(self, function* (value) {
    const item = block ? yield* call(block, value) : value;
    sawValue = true;
    if (floating === undefined && (typeof total === 'bigint' || initial !== undefined)) {
      if (typeof item === 'bigint') {
        exact += item;
        total = exact;
        return;
      }
      if (typeof item === 'number' || initial !== undefined) {
        floating = initial === undefined ? Number(exact) : initial + Number(exact);
      }
    }
    if (floating !== undefined) {
      if (typeof item === 'number' || typeof item === 'bigint') {
        const x = Number(item);
        if (Number.isNaN(floating)) return;
        if (Number.isNaN(x)) floating = x;
        else if (!Number.isFinite(x))
          floating = !Number.isFinite(floating) && Math.sign(x) !== Math.sign(floating) ? Number.NaN : x;
        else if (Number.isFinite(floating)) {
          const next = floating + x;
          compensation += Math.abs(floating) >= Math.abs(x) ? floating - next + x : x - next + floating;
          floating = next;
        }
        return;
      }
      total = floating;
      floating = undefined;
    }
    total = yield* callMethod(total, '+', [item]);
  });
  if (!sawValue) return total;
  if (floating !== undefined) return floating + compensation;
  if (initial !== undefined && typeof total === 'bigint') return initial + Number(exact);
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
  yield* collectInto(self, [items], function* (value) {
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
  yield* collectInto(self, [items], function* (value) {
    items.push(value);
    if (items.length >= count) return STOP;
  });
  return arr(items);
});
def('Enumerable', 'take_while', 0, function* (self, _args, block) {
  if (!block) return makeEnumerator(self, 'take_while', []);
  const items: Value[] = [];
  yield* collectInto(self, [items], function* (value) {
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
  yield* collectInto(self, [items], function* (value) {
    if (dropping && truthy(yield* call(block, value))) return;
    dropping = false;
    items.push(value);
  });
  return arr(items);
});

// Ordering ------------------------------------------------------------------------------------------------------------

export function* blockCompare(block: RProc, a: Value, b: Value): Gen<number> {
  const result = yield* callBlock(block, [a, b]);
  if (result === NIL) throw comparisonFailed(a, b);
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
  rt().heldArrays.push(sorted);
  try {
    yield* platformSort(sorted, block ? (a, b) => blockCompare(block, a, b) : compareValues);
    return sorted;
  } finally {
    rt().heldArrays.pop();
  }
}

/** Sorts values by keys a block computes, as `sort_by` does. */
export function* sortBy(items: Value[], block: RProc): Gen<Value[]> {
  const pairs: { key: Value; value: Value }[] = [];
  const roots = [...items];
  rt().heldArrays.push(roots);
  try {
    for (const value of items) {
      const key = yield* call(block, value);
      roots.push(key);
      pairs.push({ key, value });
    }
    return yield* sortKeyed(pairs);
  } finally {
    rt().heldArrays.pop();
  }
}

function* sortKeyed(pairs: { key: Value; value: Value }[]): Gen<Value[]> {
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
  const pairs: { key: Value; value: Value }[] = [];
  const roots: Value[] = [];
  rt().heldArrays.push(roots);
  try {
    yield* iterate(self, function* (value) {
      roots.push(value);
      const key = yield* call(block, value);
      roots.push(key);
      pairs.push({ key, value });
    });
    return arr(yield* sortKeyed(pairs));
  } finally {
    rt().heldArrays.pop();
  }
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
  const heldArrays = rt().heldArrays;
  const mark = heldArrays.length;
  let roots: Value[] = [];
  heldArrays.push(roots);
  if (Array.isArray(items)) heldArrays.push(items);
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
    roots = [...buffer.flatMap((entry) => [entry.key, entry.value]), limit];
    heldArrays[mark] = roots;
  };
  const add = function* (value: Value): Gen<void> {
    roots.push(value);
    const key = by ? yield* call(by, value) : value;
    roots.push(key);
    if (limit !== undefined) {
      let c = yield* compare(key, limit);
      if (reverse) c = -c;
      if (c >= 0) {
        roots.length -= 2;
        return;
      }
    }
    buffer.push({ key, value });
    if (buffer.length === bufferMax) yield* filter();
  };
  try {
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
  } finally {
    heldArrays.length = mark;
  }
}

function* extreme(self: Value, block: RProc | undefined, wantMax: boolean): Gen {
  let result: Value | undefined;
  const held = rt().held;
  const mark = held.length;
  held.push(NIL, NIL);
  try {
    yield* iterate(self, function* (value) {
      held[mark + 1] = value;
      if (result === undefined) result = value;
      else {
        const order = block ? yield* blockCompare(block, value, result) : yield* compareValues(value, result);
        if (wantMax ? order > 0 : order < 0) result = value;
      }
      held[mark] = result;
    });
    return result ?? NIL;
  } finally {
    held.length = mark;
  }
}

function* extremeBy(self: Value, block: RProc, wantMax: boolean): Gen {
  let result: Value = NIL;
  let best: Value | undefined;
  const held = rt().held;
  const mark = held.length;
  held.push(NIL, NIL, NIL, NIL);
  try {
    yield* iterate(self, function* (value) {
      held[mark + 2] = value;
      const key = yield* call(block, value);
      held[mark + 3] = key;
      if (
        best === undefined ||
        (wantMax ? (yield* compareValues(key, best)) > 0 : (yield* compareValues(key, best)) < 0)
      ) {
        best = key;
        result = value;
        held[mark] = result;
        held[mark + 1] = best;
      }
    });
    return result;
  } finally {
    held.length = mark;
  }
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
def('Enumerable', 'minmax', 0, (self, _args, block) => minmax(self, block));

export function* minmax(self: Value, block: RProc | undefined): Gen {
  let min: Value | undefined;
  let max: Value | undefined;
  let pending: Value | undefined;
  const held = rt().held;
  const mark = held.length;
  held.push(NIL, NIL, NIL);
  try {
    yield* iterate(self, function* (value) {
      if (pending === undefined) {
        pending = value;
        held[mark + 2] = value;
        return;
      }
      const first = pending;
      pending = undefined;
      const order = yield* orderOf(block, first, value);
      const smaller = order <= 0 ? first : value;
      const larger = order >= 0 ? first : value;
      if (min === undefined || max === undefined) {
        min = smaller;
        max = larger;
      } else {
        if ((yield* orderOf(block, smaller, min)) < 0) min = smaller;
        if ((yield* orderOf(block, larger, max)) > 0) max = larger;
      }
      held[mark] = min;
      held[mark + 1] = max;
      held[mark + 2] = NIL;
    });
    if (pending !== undefined) {
      if (min === undefined || max === undefined) min = max = pending;
      else {
        if ((yield* orderOf(block, pending, min)) < 0) min = pending;
        if ((yield* orderOf(block, pending, max)) > 0) max = pending;
      }
    }
    return arr([min ?? NIL, max ?? NIL]);
  } finally {
    held.length = mark;
  }
}
function orderOf(block: RProc | undefined, a: Value, b: Value): Gen<number> {
  return block ? blockCompare(block, a, b) : compareValues(a, b);
}

def('Enumerable', 'minmax_by', 0, function* (self, _args, block) {
  if (!block) return makeEnumerator(self, 'minmax_by', []);
  let min: Value | undefined;
  let max: Value | undefined;
  let minKey: Value | undefined;
  let maxKey: Value | undefined;
  const held = rt().held;
  const mark = held.length;
  held.push(NIL, NIL, NIL, NIL, NIL, NIL);
  try {
    yield* iterate(self, function* (value) {
      held[mark + 4] = value;
      const key = yield* call(block, value);
      held[mark + 5] = key;
      if (minKey === undefined || maxKey === undefined) {
        min = max = value;
        minKey = maxKey = key;
      } else {
        if ((yield* compareValues(key, minKey)) < 0) {
          min = value;
          minKey = key;
        }
        if ((yield* compareValues(key, maxKey)) > 0) {
          max = value;
          maxKey = key;
        }
      }
      held[mark] = min ?? NIL;
      held[mark + 1] = max ?? NIL;
      held[mark + 2] = minKey ?? NIL;
      held[mark + 3] = maxKey ?? NIL;
    });
    return arr([min ?? NIL, max ?? NIL]);
  } finally {
    held.length = mark;
  }
});

// Grouping ------------------------------------------------------------------------------------------------------------

def('Enumerable', 'group_by', 0, function* (self, _args, block) {
  if (!block) return makeEnumerator(self, 'group_by', []);
  const groups = newHash();
  return yield* whileHeld(groups, function* () {
    yield* iterate(self, function* (value) {
      const key = yield* call(block, value);
      const entry = yield* hashGet(groups, key);
      if (entry) {
        rt().chargeSlots(1);
        (entry.value as RArray).items.push(value);
      } else yield* hashSet(groups, key, arr([value]));
    });
    return groups;
  });
});
def('Enumerable', 'chunk_while', 0, function* (self, _args, block) {
  if (!block) throw argumentError('tried to create Proc object without a block');
  return chunkEnumerator(self, block, false);
});
def('Enumerable', 'slice_when', 0, function* (self, _args, block) {
  if (!block) throw argumentError('tried to create Proc object without a block');
  return chunkEnumerator(self, block, true);
});

for (const [name, before] of [
  ['slice_before', true],
  ['slice_after', false],
] as const)
  def('Enumerable', name, [0, 1], function* (self, args, predicate) {
    if (args.length + Number(!!predicate) !== 1)
      throw argumentCountError(args.length, predicate ? 0 : 1, predicate ? 0 : 1);
    const pattern = args[0];
    return customEnumerator(self, name, predicate ? [predicate] : [pattern], (consumer) =>
      sliceAt(self, pattern, predicate, before, consumer)
    );
  });

function* sliceAt(
  self: Value,
  pattern: Value | undefined,
  predicate: RProc | undefined,
  before: boolean,
  consumer: RProc
): Gen {
  let current: Value[] = [];
  const arrays = rt().heldArrays;
  const mark = arrays.length;
  arrays.push(current);
  try {
    yield* iterate(self, function* (value) {
      const boundary = predicate ? truthy(yield* call(predicate, value)) : yield* caseEquals(pattern as Value, value);
      if (before && boundary && current.length > 0) {
        yield* callBlock(consumer, [arr(current)], false);
        current = [];
        arrays[mark] = current;
      }
      current.push(value);
      if (!before && boundary) {
        yield* callBlock(consumer, [arr(current)], false);
        current = [];
        arrays[mark] = current;
      }
    });
    if (current.length > 0) yield* callBlock(consumer, [arr(current)], false);
    return self;
  } finally {
    arrays.length = mark;
  }
}

function chunkEnumerator(self: Value, predicate: RProc, splitWhenTrue: boolean): RObject {
  return customEnumerator(self, splitWhenTrue ? 'slice_when' : 'chunk_while', [predicate], function* (block) {
    const held = rt().heldArrays;
    let current: Value[] = [];
    let previous: Value | undefined;
    const mark = held.length;
    held.push(current);
    try {
      yield* iterate(self, function* (value) {
        const rootMark = rt().held.length;
        rt().held.push(value);
        if (previous !== undefined) rt().held.push(previous);
        try {
          if (previous !== undefined && truthy(yield* callBlock(predicate, [previous, value])) === splitWhenTrue) {
            yield* callBlock(block, [arr(current)], false);
            current = [];
            held[mark] = current;
          }
          current.push(value);
          previous = value;
        } finally {
          rt().held.length = rootMark;
        }
      });
      if (current.length > 0) yield* callBlock(block, [arr(current)], false);
      return self;
    } finally {
      held.length = mark;
    }
  });
}

def('Enumerable', 'each_slice', 1, function* (self, [sizeValue], block) {
  const size = yield* toIndex(sizeValue);
  if (size <= 0) throw argumentError('invalid slice size');
  if (!block) return makeEnumerator(self, 'each_slice', [sizeValue]);
  let current: Value[] = [];
  const held = rt().heldArrays;
  const mark = held.length;
  held.push(current);
  try {
    yield* iterate(self, function* (value) {
      current.push(value);
      if (current.length === size) {
        const slice = arr(current);
        current = [];
        held[mark] = current;
        yield* callBlock(block, [slice], false);
      }
    });
    if (current.length > 0) yield* callBlock(block, [arr(current)], false);
    return self;
  } finally {
    held.length = mark;
  }
});
def('Enumerable', 'each_cons', 1, function* (self, [sizeValue], block) {
  const size = yield* toIndex(sizeValue);
  if (size <= 0) throw argumentError('invalid size');
  if (!block) return makeEnumerator(self, 'each_cons', [sizeValue]);
  const window: Value[] = [];
  yield* collectInto(self, [window], function* (value) {
    window.push(value);
    if (window.length > size) window.shift();
    if (window.length === size) yield* callBlock(block, [arr([...window])], false);
  });
  return self;
});
def('Enumerable', 'chunk', 0, function* (self, _args, block) {
  if (!block) return makeEnumerator(self, 'chunk', []);
  return customEnumerator(self, 'chunk', [block], (consumer) => chunkByKey(self, block, consumer));
});

function* chunkByKey(self: Value, classifier: RProc, consumer: RProc): Gen {
  let currentKey: Value | undefined;
  let current: Value[] = [];
  const heldArrays = rt().heldArrays;
  const arrayMark = heldArrays.length;
  const keyMark = rt().held.length;
  heldArrays.push(current);
  rt().held.push(NIL);
  try {
    yield* iterate(self, function* (value) {
      const valueMark = rt().held.length;
      rt().held.push(value);
      try {
        const key = yield* call(classifier, value);
        rt().held.push(key);
        if (key === NIL || (key instanceof RSymbol && key.name === '_separator')) {
          if (current.length > 0) yield* callBlock(consumer, [arr([currentKey as Value, arr(current)])], false);
          current = [];
          heldArrays[arrayMark] = current;
          currentKey = undefined;
          rt().held[keyMark] = NIL;
          return;
        }
        if (key instanceof RSymbol && key.name === '_alone') {
          if (current.length > 0) yield* callBlock(consumer, [arr([currentKey as Value, arr(current)])], false);
          yield* callBlock(consumer, [arr([key, arr([value])])], false);
          current = [];
          heldArrays[arrayMark] = current;
          currentKey = undefined;
          rt().held[keyMark] = NIL;
          return;
        }
        if (currentKey !== undefined && !(yield* rEquals(currentKey, key))) {
          yield* callBlock(consumer, [arr([currentKey, arr(current)])], false);
          current = [];
          heldArrays[arrayMark] = current;
        }
        if (current.length === 0) {
          currentKey = key;
          rt().held[keyMark] = key;
        }
        current.push(value);
      } finally {
        rt().held.length = valueMark;
      }
    });
    if (current.length > 0) yield* callBlock(consumer, [arr([currentKey as Value, arr(current)])], false);
    return self;
  } finally {
    heldArrays.length = arrayMark;
    rt().held.length = keyMark;
  }
}
def('Enumerable', 'tally', [0, 1], function* (self, args) {
  let counts: RHash;
  if (args.length === 0) counts = newHash();
  else if (args[0] instanceof RHash) counts = args[0];
  else if (respondsTo(args[0], 'to_hash', true)) {
    const converted = yield* callMethod(args[0], 'to_hash', [], undefined, undefined, { fcall: true });
    if (!(converted instanceof RHash)) throw typeError('to_hash must return Hash');
    counts = converted;
  } else throw typeError(`no implicit conversion of ${realClassOf(args[0]).name} into Hash`);
  return yield* whileHeld(counts, function* () {
    yield* iterate(self, function* (value) {
      const entry = yield* hashGet(counts, value);
      yield* hashSet(counts, value, entry ? yield* callMethod(entry.value, '+', [1n]) : 1n);
    });
    return counts;
  });
});
def('Enumerable', 'uniq', 0, function* (self, _args, block) {
  return arr(yield* uniqValues(yield* toArray(self), block));
});

export function* uniqValues(items: Value[], block: RProc | undefined): Gen<Value[]> {
  const seen = newHash();
  const result: Value[] = [];
  rt().heldArrays.push(items, result);
  try {
    return yield* whileHeld(seen, function* () {
      for (const value of items) {
        const key = block ? yield* call(block, value) : value;
        if (yield* hashGet(seen, key)) continue;
        yield* hashSet(seen, key, true);
        result.push(value);
      }
      return result;
    });
  } finally {
    rt().heldArrays.length -= 2;
  }
}

def('Enumerable', 'to_h', [0, -1], function* (self, args, block) {
  const hash = newHash();
  return yield* whileHeld(hash, function* () {
    yield* iterate(
      self,
      function* (value) {
        const item = block ? yield* call(block, value) : value;
        const pair = yield* tryAry(item);
        if (!pair) {
          throw typeError(`wrong element type ${className(item)} (expected array)`);
        }
        if (pair.items.length !== 2) {
          throw argumentError(`element has wrong array length (expected 2, was ${pair.items.length})`);
        }
        yield* hashSet(hash, pair.items[0], pair.items[1]);
      },
      args
    );
    return hash;
  });
});
def('Enumerable', 'zip', [0, -1], function* (self, others, block) {
  return yield* zipCollections(self, others, block);
});

export function* zipCollections(self: Value, others: Value[], block: RProc | undefined): Gen<Value> {
  const inputs: Value[] = [];
  for (const other of others) inputs.push((yield* tryAry(other)) ?? other);
  const iterators = inputs.map((other) =>
    other instanceof RArray
      ? undefined
      : flattenGenerator(
          (function* (): Gen<void> {
            yield* iterate(other, function* (value) {
              yield value;
            });
          })()
        )
  );
  const results: Value[] = [];
  const held = rt().held;
  const mark = held.length;
  held.push(...inputs);
  const arrays = rt().heldArrays;
  const arrayMark = arrays.length;
  arrays.push(results);
  let index = 0;
  try {
    yield* iterate(self, function* (value) {
      const tuple: Value[] = [value];
      const arrays = rt().heldArrays;
      const arrayMark = arrays.length;
      arrays.push(tuple);
      try {
        for (const [position, other] of inputs.entries()) {
          const iterator = iterators[position];
          const next = iterator?.next();
          tuple.push(other instanceof RArray ? (other.items[index] ?? NIL) : next?.done ? NIL : (next?.value as Value));
        }
        index++;
        if (block) yield* callBlock(block, [arr(tuple)], false);
        else results.push(arr(tuple));
      } finally {
        arrays.length = arrayMark;
      }
    });
    return block ? NIL : arr(results);
  } finally {
    for (const iterator of iterators) iterator?.return();
    arrays.length = arrayMark;
    held.length = mark;
  }
}
def('Enumerable', 'cycle', [0, 1], function* (self, args, block) {
  if (!block) return makeEnumerator(self, 'cycle', args);
  const times = args.length > 0 && args[0] !== NIL ? yield* toInt(args[0]) : undefined;
  if (times !== undefined && times <= 0n) return NIL;
  const items: Value[] = [];
  const held = rt().heldArrays;
  const mark = held.length;
  held.push(items);
  try {
    yield* iterate(self, function* (value) {
      items.push(value);
      yield* callBlock(block, [value], false);
    });
    if (items.length === 0) return NIL;
    for (let round = 1n; times === undefined || round < times; round++) {
      for (const item of items) yield* callBlock(block, [item], false);
    }
    return NIL;
  } finally {
    held.length = mark;
  }
});
def('Enumerable', 'chain', [0, -1], (self, others) => {
  const sources = [self, ...others];
  const enumerator = customEnumerator(self, 'chain', others, function* (block) {
    for (const source of sources)
      yield* iterate(source, function* (value) {
        yield* callBlock(block, [value], false);
      });
    return enumerator;
  });
  enumerator.cls = rt().c['Enumerator::Chain'];
  (enumerator.data as EnumeratorSource).size = () => {
    let total: bigint | number = 0n;
    for (const source of sources) {
      const size = receiverSize(source);
      if (size === NIL) return NIL;
      if (size === Number.POSITIVE_INFINITY) return size;
      total =
        typeof size === 'number' || typeof total === 'number' ? Number(total) + Number(size) : total + (size as bigint);
    }
    return total;
  };
  return enumerator;
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
  return receiverSize(collection);
}

export { callProc, respondsTo, spaceship };
