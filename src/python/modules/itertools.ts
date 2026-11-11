import { builtin, method } from '../define';
import { registerModule } from '../modules';
import { argument, checkArgs } from '../nativeArgs';
import { toIndex } from '../numbers';
import { callValue, isTruthy, iterate, type NextFunction, toArray } from '../objects';
import { binaryOp, equals } from '../operators';
import { currentRuntime } from '../runtimeContext';
import { newGenericAlias } from '../typeHints';
import { defineIteratorClass } from '../typeObject';
import { builtinClass, newTuple, None, typeError, valueError } from '../types';
import { DONE, type Kwargs, type PyBuiltinFunction, type PyClass, PyIterator, type PyValue } from '../values';

const classes = new Map<string, PyClass>();

function iteratorOf(name: string, next: NextFunction, holds: () => Iterable<unknown>): PyIterator {
  return new PyIterator(iteratorType(name), next, holds);
}

/** The class of an itertools iterator, which is also what the module calls to make one. */
function iteratorType(name: string): PyClass {
  let cls = classes.get(name);
  if (!cls) {
    cls = builtinClass(name);
    cls.module = 'itertools';
    cls.tpName = `itertools.${name}`;
    cls.dict.set('__module__', 'itertools');
    defineIteratorClass(cls);
    classes.set(name, cls);
  }
  return cls;
}

/** Makes the module's function for an iterator its class, as each itertools iterator is a type in CPython. */
function asType(fn: PyBuiltinFunction): PyClass {
  const cls = iteratorType(fn.name);
  cls.construct = (_cls, args, kwargs) => fn.run(args, kwargs);
  return cls;
}

// itertools.tee -------------------------------------------------------------------------------------------------------

interface TeeBuffer {
  next: NextFunction;
  items: PyValue[];
  done: boolean;
}

function newTee(buffer: TeeBuffer, position: number): PyIterator {
  let index = position;
  const iterator = new PyIterator(
    iteratorType('_tee'),
    () => {
      if (index === buffer.items.length) {
        if (buffer.done) return DONE;
        const item = buffer.next();
        if (item === DONE) {
          buffer.done = true;
          return DONE;
        }
        buffer.items.push(item);
      }
      return buffer.items[index++];
    },
    () => buffer.items
  );
  teeStates.set(iterator, () => newTee(buffer, index));
  return iterator;
}

const teeStates = new WeakMap<PyIterator, () => PyIterator>();

function tee(args: PyValue[]): PyValue {
  const [iterable, countValue] = args;
  const count = countValue === undefined ? 2n : toIndex(countValue);
  if (count < 0n) throw valueError('n must be >= 0');
  if (count === 0n) return newTuple([]);
  const copyOf = iterable instanceof PyIterator ? teeStates.get(iterable) : undefined;
  const first = copyOf ? copyOf() : newTee({ next: iterate(iterable), items: [], done: false }, 0);
  const copies: PyValue[] = [first];
  while (copies.length < Number(count)) copies.push((teeStates.get(first) as () => PyIterator)());
  return newTuple(copies);
}

function fromArray(name: string, items: PyValue[]): PyIterator {
  let index = 0;
  return iteratorOf(
    name,
    () => (index < items.length ? items[index++] : DONE),
    () => items
  );
}

function count(args: PyValue[], kwargs: Kwargs): PyValue {
  checkArgs({ qualified: 'count', min: 0, max: 2, style: 'takes', keywords: ['start', 'step'] }, args, kwargs);
  let current = argument(args, kwargs, 0, 'start') ?? 0n;
  const step = argument(args, kwargs, 1, 'step') ?? 1n;
  return iteratorOf(
    'count',
    () => {
      const value = current;
      current = binaryOp('+', current, step);
      return value;
    },
    () => [current]
  );
}

function cycle([iterable]: PyValue[]): PyValue {
  const next = iterate(iterable);
  const saved: PyValue[] = [];
  let exhausted = false;
  let index = 0;
  return iteratorOf(
    'cycle',
    () => {
      if (!exhausted) {
        const item = next();
        if (item !== DONE) {
          saved.push(item);
          return item;
        }
        exhausted = true;
      }
      if (saved.length === 0) return DONE;
      const item = saved[index];
      index = (index + 1) % saved.length;
      return item;
    },
    () => saved
  );
}

function repeat(args: PyValue[], kwargs: Kwargs): PyValue {
  checkArgs({ qualified: 'repeat', min: 1, max: 2, style: 'takes', keywords: ['object', 'times'] }, args, kwargs);
  const object = argument(args, kwargs, 0, 'object') as PyValue;
  const times = argument(args, kwargs, 1, 'times');
  let remaining = times === undefined ? -1n : toIndex(times);
  return iteratorOf(
    'repeat',
    () => {
      if (remaining === 0n || (times !== undefined && remaining < 0n)) return DONE;
      if (times !== undefined) remaining--;
      return object;
    },
    () => [object]
  );
}

function accumulate(args: PyValue[], kwargs: Kwargs): PyValue {
  checkArgs(
    { qualified: 'accumulate', min: 1, max: 2, style: 'takes', keywords: ['iterable', 'func', 'initial'] },
    args,
    kwargs
  );
  const next = iterate(argument(args, kwargs, 0, 'iterable') as PyValue);
  const fn = argument(args, kwargs, 1, 'func') ?? None;
  const initial = kwargs?.get('initial') ?? None;
  let total: PyValue | undefined = initial === None ? undefined : initial;
  let started = initial === None;
  return iteratorOf(
    'accumulate',
    () => {
      if (!started) {
        started = true;
        return total as PyValue;
      }
      const item = next();
      if (item === DONE) return DONE;
      total = total === undefined ? item : fn === None ? binaryOp('+', total, item) : callValue(fn, [total, item]);
      return total;
    },
    () => (total === undefined ? [] : [total])
  );
}

function chain(iterables: PyValue[]): PyIterator {
  let index = 0;
  return chainOf(
    () => (index < iterables.length ? iterables[index++] : DONE),
    () => iterables
  );
}

function chainFromIterable([iterable]: PyValue[]): PyIterator {
  return chainOf(iterate(iterable), () => [iterable]);
}

/** Chains the items of the iterables that `nextIterable` returns one by one. */
function chainOf(nextIterable: NextFunction, holds: () => Iterable<unknown>): PyIterator {
  let inner: NextFunction | undefined;
  return iteratorOf(
    'chain',
    () => {
      for (;;) {
        if (!inner) {
          const iterable = nextIterable();
          if (iterable === DONE) return DONE;
          inner = iterate(iterable);
        }
        const item = inner();
        if (item !== DONE) return item;
        inner = undefined;
      }
    },
    holds
  );
}

// code-gauge-allow functionCognitiveComplexity 23 -- Transcribes the index loop of itertools.combinations.
function combinations(pool: PyValue[], r: number, withReplacement: boolean): PyValue[] {
  const results: PyValue[] = [];
  const n = pool.length;
  if (!withReplacement && r > n) return results;
  if (withReplacement && n === 0 && r > 0) return results;
  const indices = withReplacement ? Array.from({ length: r }, () => 0) : Array.from({ length: r }, (_, index) => index);
  const runtime = currentRuntime();
  results.push(newTuple(indices.map((index) => pool[index])));
  for (;;) {
    runtime.spend();
    let i = r - 1;
    while (i >= 0 && indices[i] === (withReplacement ? n - 1 : i + n - r)) i--;
    if (i < 0) return results;
    if (withReplacement) {
      const value = indices[i] + 1;
      for (let j = i; j < r; j++) indices[j] = value;
    } else {
      indices[i]++;
      for (let j = i + 1; j < r; j++) indices[j] = indices[j - 1] + 1;
    }
    runtime.allocate(r);
    results.push(newTuple(indices.map((index) => pool[index])));
  }
}

function permutations(pool: PyValue[], r: number): PyValue[] {
  const n = pool.length;
  const results: PyValue[] = [];
  if (r > n) return results;
  const indices = Array.from({ length: n }, (_, index) => index);
  const cycles = Array.from({ length: r }, (_, index) => n - index);
  results.push(newTuple(indices.slice(0, r).map((index) => pool[index])));
  const runtime = currentRuntime();
  while (n > 0) {
    let found = false;
    for (let i = r - 1; i >= 0; i--) {
      runtime.spend();
      cycles[i]--;
      if (cycles[i] === 0) {
        indices.push(...indices.splice(i, 1));
        cycles[i] = n - i;
      } else {
        const j = cycles[i];
        [indices[i], indices[n - j]] = [indices[n - j], indices[i]];
        runtime.allocate(r);
        results.push(newTuple(indices.slice(0, r).map((index) => pool[index])));
        found = true;
        break;
      }
    }
    if (!found) return results;
  }
  return results;
}

function product(args: PyValue[], kwargs: Kwargs): PyValue {
  checkArgs(
    { qualified: 'product', min: 0, max: Number.POSITIVE_INFINITY, style: 'takes', keywords: ['repeat'] },
    args,
    kwargs
  );
  const times = Number(toIndex(kwargs?.get('repeat') ?? 1n));
  if (times < 0) throw valueError('repeat argument cannot be negative');
  const pools: PyValue[][] = [];
  for (let index = 0; index < times; index++) for (const iterable of args) pools.push(toArray(iterable));
  let results: PyValue[][] = [[]];
  const runtime = currentRuntime();
  for (const pool of pools) {
    const next: PyValue[][] = [];
    for (const result of results)
      for (const item of pool) {
        runtime.spend();
        next.push([...result, item]);
      }
    results = next;
  }
  runtime.allocate(results.length);
  return fromArray(
    'product',
    results.map((items) => newTuple(items))
  );
}

// code-gauge-allow functionCognitiveComplexity 19 -- Follows itertools.groupby, whose groups share one underlying iterator.
function groupby(args: PyValue[], kwargs: Kwargs): PyValue {
  checkArgs({ qualified: 'groupby', min: 1, max: 2, style: 'takes', keywords: ['iterable', 'key'] }, args, kwargs);
  const next = iterate(argument(args, kwargs, 0, 'iterable') as PyValue);
  const keyFn = argument(args, kwargs, 1, 'key') ?? None;
  let pending: PyValue | typeof DONE | undefined;
  let pendingKey: PyValue | undefined;
  const advance = (): void => {
    pending = next();
    if (pending !== DONE) pendingKey = keyFn === None ? pending : callValue(keyFn, [pending]);
  };
  let currentKey: PyValue | undefined;
  return iteratorOf(
    'groupby',
    () => {
      if (pending === undefined) advance();
      while (pending !== DONE && currentKey !== undefined && equals(pendingKey as PyValue, currentKey)) advance();
      if (pending === DONE) return DONE;
      currentKey = pendingKey as PyValue;
      const groupKey = currentKey;
      const group = iteratorOf(
        '_grouper',
        () => {
          if (pending === undefined) advance();
          if (pending === DONE || !equals(pendingKey as PyValue, groupKey) || currentKey !== groupKey) return DONE;
          const item = pending as PyValue;
          advance();
          return item;
        },
        () => []
      );
      return newTuple([groupKey, group]);
    },
    () => []
  );
}

function toBound(value: PyValue | undefined, name: string): number | undefined {
  if (value === undefined || value === None) return undefined;
  const message = `${name} argument for islice() must be None or an integer: 0 <= x <= sys.maxsize.`;
  const bound = Number(toIndex(value, () => message));
  if (bound < 0) throw valueError(message);
  return bound;
}

function sizeOf(value: PyValue | undefined, fallback: number): number {
  if (value === undefined || value === None) return fallback;
  const result = Number(toIndex(value));
  if (result < 0) throw valueError('r must be non-negative');
  return result;
}

function islice(args: PyValue[], kwargs: Kwargs): PyValue {
  checkArgs({ qualified: 'islice', min: 2, max: 4, style: 'expected' }, args, kwargs);
  const next = iterate(args[0]);
  const [start, stop, step] =
    args.length === 2
      ? [0, toBound(args[1], 'Stop'), 1]
      : [toBound(args[1], 'Indices') ?? 0, toBound(args[2], 'Stop'), toBound(args[3], 'Step') ?? 1];
  if (step === 0) throw valueError('Step for islice() must be a positive integer or None.');
  let position = 0;
  let nextIndex = start;
  return iteratorOf(
    'islice',
    () => {
      for (;;) {
        if (stop !== undefined && nextIndex >= stop) return DONE;
        const item = next();
        if (item === DONE) return DONE;
        if (position++ === nextIndex) {
          nextIndex += step;
          return item;
        }
      }
    },
    () => [args[0]]
  );
}

// code-gauge-allow duplicateLines 19 -- zip and itertools.zip_longest stop on exhausted iterables differently.
function zipLongest(args: PyValue[], kwargs: Kwargs): PyValue {
  checkArgs(
    { qualified: 'zip_longest', min: 0, max: Number.POSITIVE_INFINITY, style: 'takes', keywords: ['fillvalue'] },
    args,
    kwargs
  );
  const fill = kwargs?.get('fillvalue') ?? None;
  const nexts = args.map((iterable) => iterate(iterable));
  const finished = nexts.map(() => false);
  return iteratorOf(
    'zip_longest',
    () => {
      if (nexts.length === 0) return DONE;
      const items: PyValue[] = [];
      for (const [index, next] of nexts.entries()) {
        const item = finished[index] ? DONE : next();
        if (item === DONE) {
          finished[index] = true;
          items.push(fill);
        } else items.push(item);
      }
      return finished.every(Boolean) ? DONE : newTuple(items);
    },
    () => args
  );
}

function filtering(
  name: string,
  keep: (fn: PyValue, item: PyValue, state: { dropping: boolean }) => boolean | 'stop'
): PyBuiltinFunction {
  return builtin(name, 'expected', 2, 2, ([fn, iterable]) => {
    const next = iterate(iterable);
    const state = { dropping: true };
    let stopped = false;
    return iteratorOf(
      name,
      () => {
        if (stopped) return DONE;
        for (let item = next(); item !== DONE; item = next()) {
          const verdict = keep(fn, item, state);
          if (verdict === 'stop') {
            stopped = true;
            return DONE;
          }
          if (verdict) return item;
        }
        return DONE;
      },
      () => [iterable]
    );
  });
}

function batched(args: PyValue[], kwargs: Kwargs): PyValue {
  checkArgs(
    { qualified: 'batched', min: 2, max: 2, style: 'takes', keywords: ['iterable', 'n', 'strict'] },
    args,
    kwargs
  );
  const next = iterate(args[0]);
  const size = Number(toIndex(args[1]));
  if (size < 1) throw valueError('n must be at least one');
  const strict = isTruthy(kwargs?.get('strict') ?? false);
  return iteratorOf(
    'batched',
    () => {
      const items: PyValue[] = [];
      while (items.length < size) {
        const item = next();
        if (item === DONE) break;
        items.push(item);
      }
      if (items.length === 0) return DONE;
      if (strict && items.length < size) throw valueError('batched(): incomplete batch');
      return newTuple(items);
    },
    () => [args[0]]
  );
}

const teeClass = iteratorType('_tee');
teeClass.dict.set(
  '__copy__',
  builtin('__copy__', 'one', 1, 1, ([self]) => (teeStates.get(self as PyIterator) as () => PyIterator)())
);

registerModule('itertools', () => {
  const chainClass = iteratorType('chain');
  chainClass.construct = (_cls, args, kwargs) => {
    if (kwargs && kwargs.size > 0) throw typeError('chain() takes no keyword arguments');
    return chain(args);
  };
  method(chainClass, 'from_iterable', 'one', 1, 1, (_cls, [iterable]) => chainFromIterable([iterable]), {
    binding: 'class',
  });
  method(chainClass, '__class_getitem__', 'one', 1, 1, (owner, [key]) => newGenericAlias(owner, key), {
    binding: 'class',
  });
  return new Map<string, PyValue>([
    ['count', asType(builtin('count', 'takes', 0, 2, count, { keywords: ['start', 'step'] }))],
    ['cycle', asType(builtin('cycle', 'expected', 1, 1, cycle))],
    ['repeat', asType(builtin('repeat', 'takes', 1, 2, repeat, { keywords: ['object', 'times'] }))],
    [
      'accumulate',
      asType(builtin('accumulate', 'takes', 1, 2, accumulate, { keywords: ['iterable', 'func', 'initial'] })),
    ],
    ['chain', chainClass],
    ['tee', builtin('tee', 'expected', 1, 2, tee)],
    ['combinations', asType(combinationsBuiltin('combinations', false))],
    ['combinations_with_replacement', asType(combinationsBuiltin('combinations_with_replacement', true))],
    ['permutations', asType(builtin('permutations', 'takes', 1, 2, permutationsOf, { keywords: ['iterable', 'r'] }))],
    ['product', asType(builtin('product', 'takes', 0, Number.POSITIVE_INFINITY, product, { keywords: ['repeat'] }))],
    ['groupby', asType(builtin('groupby', 'takes', 1, 2, groupby, { keywords: ['iterable', 'key'] }))],
    ['islice', asType(builtin('islice', 'expected', 2, 4, islice))],
    [
      'zip_longest',
      asType(builtin('zip_longest', 'takes', 0, Number.POSITIVE_INFINITY, zipLongest, { keywords: ['fillvalue'] })),
    ],
    ['starmap', asType(builtin('starmap', 'expected', 2, 2, starmap))],
    ['takewhile', asType(filtering('takewhile', (fn, item) => (isTruthy(callValue(fn, [item])) ? true : 'stop')))],
    ['dropwhile', asType(filtering('dropwhile', keepAfterDropping))],
    [
      'filterfalse',
      asType(filtering('filterfalse', (fn, item) => !isTruthy(fn === None ? item : callValue(fn, [item])))),
    ],
    ['compress', asType(builtin('compress', 'takes', 2, 2, compress, { keywords: ['data', 'selectors'] }))],
    ['pairwise', asType(builtin('pairwise', 'one', 1, 1, pairwise))],
    ['batched', asType(builtin('batched', 'takes', 2, 2, batched, { keywords: ['iterable', 'n', 'strict'] }))],
  ]);
});

function combinationsBuiltin(name: string, withReplacement: boolean): PyBuiltinFunction {
  return builtin(
    name,
    'takes',
    2,
    2,
    (args, kwargs) =>
      fromArray(
        name,
        combinations(
          toArray(argument(args, kwargs, 0, 'iterable') as PyValue),
          sizeOf(argument(args, kwargs, 1, 'r'), 0),
          withReplacement
        )
      ),
    { keywords: ['iterable', 'r'] }
  );
}

function permutationsOf(args: PyValue[], kwargs: Kwargs): PyIterator {
  const pool = toArray(argument(args, kwargs, 0, 'iterable') as PyValue);
  return fromArray('permutations', permutations(pool, sizeOf(argument(args, kwargs, 1, 'r'), pool.length)));
}

function starmap([fn, iterable]: PyValue[]): PyIterator {
  const next = iterate(iterable);
  return iteratorOf(
    'starmap',
    () => {
      const item = next();
      return item === DONE ? DONE : callValue(fn, toArray(item));
    },
    () => [fn, iterable]
  );
}

function keepAfterDropping(fn: PyValue, item: PyValue, state: { dropping: boolean }): boolean {
  if (state.dropping && isTruthy(callValue(fn, [item]))) return false;
  state.dropping = false;
  return true;
}

function compress([data, selectors]: PyValue[]): PyIterator {
  const nextData = iterate(data);
  const nextSelector = iterate(selectors);
  return iteratorOf(
    'compress',
    () => {
      for (;;) {
        const item = nextData();
        const selector = nextSelector();
        if (item === DONE || selector === DONE) return DONE;
        if (isTruthy(selector)) return item;
      }
    },
    () => [data, selectors]
  );
}

function pairwise([iterable]: PyValue[]): PyIterator {
  const next = iterate(iterable);
  let previous: PyValue | typeof DONE | undefined;
  return iteratorOf(
    'pairwise',
    () => {
      previous ??= next();
      if (previous === DONE) return DONE;
      const item = next();
      if (item === DONE) return DONE;
      const pair = newTuple([previous, item]);
      previous = item;
      return pair;
    },
    () => [iterable]
  );
}

export { typeError };
