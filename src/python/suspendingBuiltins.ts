// The variants of the builtins that call back into Python or read iterators, which a program that runs threads calls
// where the thread can suspend: a wait in a function they call or a generator they read then suspends the thread, as
// the scheduler expects, while the other programs keep calling the synchronous builtins.
import { argument, checkArgs } from './nativeArgs';
import { asFloat } from './numbers';
import { callValue, isTruthy } from './objects';
import { binaryOp, compareOp } from './operators';
import { currentRuntime } from './runtimeContext';
import type { Suspension } from './suspendingEvaluator';
import { callSuspending, itemsSuspending, iterateSuspending } from './threadIteration';
import { registerSuspendingConstructor, registerSuspendingVariant, type SuspendingNative } from './threads';
import { sortByKeys } from './typeContainers';
import {
  dictClass,
  frozensetClass,
  listClass,
  newList,
  None,
  setClass,
  strClass,
  tupleClass,
  typeError,
  valueError,
} from './types';
import { DONE, type Kwargs, PyBuiltinFunction, PyList, type PyValue } from './values';

/** Registers the suspending variants of the builtin functions of a run's builtins module. */
export function registerBuiltinVariants(builtins: Map<string, PyValue>): void {
  registerTypeVariants();
  const variants: [string, SuspendingNative][] = [
    ['sorted', sortedSuspending],
    ['min', minMaxSuspending('min')],
    ['max', minMaxSuspending('max')],
    ['sum', sumSuspending],
    ['any', ([iterable]) => anyAllSuspending(iterable, true)],
    ['all', ([iterable]) => anyAllSuspending(iterable, false)],
  ];
  for (const [name, variant] of variants) {
    const fn = builtins.get(name);
    if (fn instanceof PyBuiltinFunction) registerSuspendingVariant(fn, variant);
  }
}

/** Registers the suspending variant of `functools.reduce`. */
export function registerReduceVariant(reduce: PyBuiltinFunction): void {
  registerSuspendingVariant(reduce, reduceSuspending);
}

// Constructors and methods that read a whole iterable, or call a key for each item -------------------------------------

/** A class whose construction from one iterable reads it whole, as `list(generator)` does, then builds the same way. */
function constructFromItems(cls: PyValue): SuspendingNative {
  return function* (args, kwargs) {
    if (args.length !== 1 || (kwargs !== undefined && kwargs.size > 0) || (cls === dictClass && hasKeys(args[0]))) {
      return callValue(cls, args, kwargs);
    }
    const items = yield* itemsSuspending(args[0]);
    return callValue(cls, [newList(items)]);
  };
}

function hasKeys(value: PyValue): boolean {
  return typeof value === 'object' && value.cls.lookup('keys') !== undefined;
}

let typeVariantsRegistered = false;

/** Registers the suspending variants of the builtin types' constructors and methods, once they all exist. */
function registerTypeVariants(): void {
  if (typeVariantsRegistered) return;
  typeVariantsRegistered = true;
  for (const cls of [listClass, tupleClass, setClass, frozensetClass, dictClass]) {
    registerSuspendingConstructor(cls, constructFromItems(cls));
  }
  const join = strClass.dict.get('join') as PyBuiltinFunction;
  registerSuspendingVariant(join, function* ([self, iterable]) {
    const items = iterable instanceof PyList ? iterable : newList(yield* itemsSuspending(iterable));
    return callValue(join, [self, items]);
  });
  registerSuspendingVariant(listClass.dict.get('sort') as PyBuiltinFunction, function* ([self, ...args], kwargs) {
    if (args.length > 0) throw typeError('sort() takes no positional arguments');
    yield* sortSuspending(self as PyList, kwargs);
    return None;
  });
}

function* sortedSuspending(args: PyValue[], kwargs: Kwargs): Suspension {
  checkArgs({ qualified: 'sorted', min: 1, max: 1, style: 'expected', keywords: ['key', 'reverse'] }, args, kwargs);
  const list = newList(yield* itemsSuspending(args[0]));
  currentRuntime().allocate(list.items.length + 1);
  yield* sortSuspending(list, kwargs);
  return list;
}

/** `list.sort(key=..., reverse=...)`, computing the keys where the thread can suspend. */
function* sortSuspending(list: PyList, kwargs: Kwargs): Suspension<void> {
  const unexpected = [...(kwargs?.keys() ?? [])].find((name) => name !== 'key' && name !== 'reverse');
  if (unexpected !== undefined) throw typeError(`sort() got an unexpected keyword argument '${unexpected}'`);
  const key = kwargs?.get('key') ?? None;
  const reverse = isTruthy(kwargs?.get('reverse') ?? false);
  const original = list.items;
  list.items = [];
  try {
    const keys: PyValue[] = [];
    if (key === None) keys.push(...original);
    else for (const item of original) keys.push(yield* callSuspending(key, [item]));
    sortByKeys(list, original, keys, reverse);
  } catch (error) {
    if (list.items.length === 0) list.items = original;
    throw error;
  }
}

// Builtins that read an iterable item by item ------------------------------------------------------------------------------

// code-gauge-allow functionCognitiveComplexity 25 -- Checks the arguments in the order CPython's min_max does.
function minMaxSuspending(name: 'min' | 'max'): SuspendingNative {
  return function* (args, kwargs) {
    const unexpected = [...(kwargs?.keys() ?? [])].find((key) => key !== 'key' && key !== 'default');
    if (unexpected !== undefined) throw typeError(`${name}() got an unexpected keyword argument '${unexpected}'`);
    if (args.length === 0) throw typeError(`${name} expected at least 1 argument, got 0`);
    const key = kwargs?.get('key') ?? None;
    const fallback = kwargs?.get('default');
    if (args.length > 1 && fallback !== undefined) {
      throw typeError(`Cannot specify a default for ${name}() with multiple positional arguments`);
    }
    const next = iterateSuspending(args.length === 1 ? args[0] : newList(args));
    const operator = name === 'max' ? '>' : '<';
    let best: PyValue | typeof DONE = DONE;
    let bestKey: PyValue = None;
    for (let item = yield* next(); item !== DONE; item = yield* next()) {
      currentRuntime().spend();
      const itemKey = key === None ? item : yield* callSuspending(key, [item]);
      if (best === DONE || isTruthy(compareOp(operator, itemKey, bestKey))) {
        best = item;
        bestKey = itemKey;
      }
    }
    if (best !== DONE) return best;
    if (fallback !== undefined) return fallback;
    throw valueError(`${name}() iterable argument is empty`);
  };
}

function* anyAllSuspending(iterable: PyValue, isAny: boolean): Suspension {
  const next = iterateSuspending(iterable);
  for (let item = yield* next(); item !== DONE; item = yield* next()) {
    currentRuntime().spend();
    if (isTruthy(item) === isAny) return isAny;
  }
  return !isAny;
}

// code-gauge-allow functionCognitiveComplexity 21 -- Follows CPython's builtin sum, including its float compensation.
// code-gauge-allow functionNcss 33 -- Follows CPython's builtin sum, including its float compensation.
function* sumSuspending(args: PyValue[], kwargs: Kwargs): Suspension {
  if (args.length === 0) throw typeError('sum() takes at least 1 positional argument (0 given)');
  checkArgs({ qualified: 'sum', min: 1, max: 2, style: 'takes', keywords: ['start'] }, args, kwargs);
  let result = argument(args, kwargs, 1, 'start') ?? 0n;
  if (typeof result === 'string') throw typeError("sum() can't sum strings [use ''.join(seq) instead]");
  const runtime = currentRuntime();
  const next = iterateSuspending(args[0]);
  let item = yield* next();
  while (item !== DONE && typeof result === 'bigint' && (typeof item === 'bigint' || typeof item === 'boolean')) {
    runtime.spend();
    result += BigInt(item);
    item = yield* next();
  }
  if (item !== DONE && typeof result === 'bigint') {
    result = binaryOp('+', result, item);
    item = yield* next();
  }
  if (typeof result === 'number') {
    let high = result;
    let low = 0;
    for (; item !== DONE; item = yield* next()) {
      runtime.spend();
      if (typeof item !== 'number' && typeof item !== 'bigint' && typeof item !== 'boolean') break;
      const x = asFloat(item);
      const total = high + x;
      low += Math.abs(high) >= Math.abs(x) ? high - total + x : x - total + high;
      high = total;
    }
    result = low && Number.isFinite(low) ? high + low : high;
  }
  for (; item !== DONE; item = yield* next()) {
    runtime.spend();
    result = binaryOp('+', result, item);
  }
  return result;
}

function* reduceSuspending(args: PyValue[], kwargs: Kwargs): Suspension {
  checkArgs({ qualified: 'reduce', min: 2, max: 3, style: 'expected', keywords: ['initial'] }, args, kwargs);
  const [fn, iterable] = args;
  const next = iterateSuspending(iterable);
  let accumulator: PyValue | typeof DONE = args.length > 2 ? args[2] : (kwargs?.get('initial') ?? (yield* next()));
  if (accumulator === DONE) throw typeError('reduce() of empty iterable with no initial value');
  for (let item = yield* next(); item !== DONE; item = yield* next()) {
    currentRuntime().spend();
    accumulator = yield* callSuspending(fn, [accumulator, item]);
  }
  return accumulator;
}
