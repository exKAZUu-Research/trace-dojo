import { addressOf, pyRepr } from '../conversions';
import { builtin, method } from '../define';
import { builtinClassesWithDict } from '../descriptors';
import { DictStore } from '../dictStore';
import { registerModule } from '../modules';
import { checkArgs } from '../nativeArgs';
import {
  bindValue,
  callValue,
  getAttributeOrUndefined,
  isCallable,
  isTruthy,
  iterate,
  lookupSpecial,
  setAttribute,
} from '../objects';
import { compareOp } from '../operators';
import { currentRuntime } from '../runtimeContext';
import { builtinClass, newTuple, None, NotImplemented, typeError } from '../types';
import { DONE, type Kwargs, PyBuiltinFunction, PyClass, PyDict, PyOpaque, PyTuple, type PyValue } from '../values';
import { makeNamedTupleClass } from './collections';

const partialClass = builtinClass('partial');
partialClass.module = 'functools';
builtinClassesWithDict.add(partialClass);
interface Partial {
  fn: PyValue;
  args: PyValue[];
  kwargs: Map<string, PyValue>;
}
partialClass.construct = (_cls, args, kwargs) => {
  if (args.length === 0) throw typeError("type 'partial' takes at least one argument");
  const [fn, ...rest] = args;
  if (!isCallable(fn)) throw typeError('the first argument must be callable');
  return new PyOpaque(partialClass, 'partial', { fn, args: rest, kwargs: new Map(kwargs) } satisfies Partial);
};
partialClass.dict.set(
  '__call__',
  new PyBuiltinFunction(
    builtinClass('method_descriptor'),
    '__call__',
    (args, kwargs) => {
      const partial = (args[0] as PyOpaque).data as Partial;
      const merged = new Map(partial.kwargs);
      for (const [key, value] of kwargs ?? []) merged.set(key, value);
      return callValue(partial.fn, [...partial.args, ...args.slice(1)], merged.size > 0 ? merged : undefined);
    },
    undefined,
    'method',
    'partial'
  )
);
method(partialClass, '__repr__', 'none', 0, 0, (self) => {
  const partial = (self as PyOpaque).data as Partial;
  const parts = [
    pyRepr(partial.fn),
    ...partial.args.map((arg) => pyRepr(arg)),
    ...[...partial.kwargs].map(([key, value]) => `${key}=${pyRepr(value)}`),
  ];
  return `functools.partial(${parts.join(', ')})`;
});

function reduce(args: PyValue[], kwargs: Kwargs): PyValue {
  checkArgs({ qualified: 'reduce', min: 2, max: 3, style: 'expected', keywords: ['initial'] }, args, kwargs);
  const [fn, iterable] = args;
  const next = iterate(iterable);
  let accumulator: PyValue | typeof DONE = args.length > 2 ? args[2] : (kwargs?.get('initial') ?? next());
  if (accumulator === DONE) throw typeError('reduce() of empty iterable with no initial value');
  for (let item = next(); item !== DONE; item = next()) {
    currentRuntime().spend();
    accumulator = callValue(fn, [accumulator, item]);
  }
  return accumulator;
}

let cacheInfoClass: PyClass | undefined;
const cacheClass = builtinClass('_lru_cache_wrapper');
cacheClass.module = 'functools';
interface Cache {
  fn: PyValue;
  store: DictStore;
  maxsize: number | undefined;
  hits: number;
  misses: number;
}

function cached(fn: PyValue, maxsize: number | undefined): PyValue {
  const wrapper = new PyOpaque(cacheClass, 'cache', {
    fn,
    store: new DictStore(),
    maxsize,
    hits: 0,
    misses: 0,
  } satisfies Cache);
  return wrapper;
}
cacheClass.dict.set(
  '__call__',
  new PyBuiltinFunction(
    builtinClass('method_descriptor'),
    '__call__',
    (args, kwargs) => {
      const cache = (args[0] as PyOpaque).data as Cache;
      const callArgs = args.slice(1);
      const key = newTuple([...callArgs, ...[...(kwargs ?? [])].flatMap(([name, value]) => [name, value])]);
      const found = cache.store.lookup(key);
      if (found) {
        cache.hits++;
        if (cache.maxsize !== undefined) cache.store.moveToEnd(found, true);
        return found.value;
      }
      cache.misses++;
      const value = callValue(cache.fn, callArgs, kwargs);
      cache.store.set(key, value);
      if (cache.maxsize !== undefined && cache.store.size > cache.maxsize) {
        const oldest = cache.store.first();
        if (oldest) cache.store.remove(oldest);
      }
      return value;
    },
    undefined,
    'method',
    '_lru_cache_wrapper'
  )
);
method(cacheClass, 'cache_info', 'none', 0, 0, (self) => {
  const cache = (self as PyOpaque).data as Cache;
  cacheInfoClass ??= makeNamedTupleClass('CacheInfo', ['hits', 'misses', 'maxsize', 'currsize'], 'functools');
  return callValue(cacheInfoClass, [
    BigInt(cache.hits),
    BigInt(cache.misses),
    cache.maxsize === undefined ? None : BigInt(cache.maxsize),
    BigInt(cache.store.size),
  ]);
});
method(cacheClass, 'cache_clear', 'none', 0, 0, (self) => {
  const cache = (self as PyOpaque).data as Cache;
  cache.store.clear();
  cache.hits = 0;
  cache.misses = 0;
  return None;
});
method(
  cacheClass,
  '__repr__',
  'none',
  0,
  0,
  (self) => `<functools._lru_cache_wrapper object at ${addressOf(self as PyOpaque)}>`
);
cacheClass.dict.set(
  '__get__',
  new PyBuiltinFunction(
    builtinClass('method_descriptor'),
    '__get__',
    ([self, instance]) =>
      instance === None
        ? self
        : new PyOpaque(partialClass, 'partial', { fn: self, args: [instance], kwargs: new Map() } satisfies Partial),
    undefined,
    'method',
    '_lru_cache_wrapper'
  )
);

function lruCache(args: PyValue[], kwargs: Kwargs): PyValue {
  checkArgs({ qualified: 'lru_cache', min: 0, max: 2, style: 'takes', keywords: ['maxsize', 'typed'] }, args, kwargs);
  const first = args[0] ?? kwargs?.get('maxsize');
  if (first !== undefined && first !== None && isCallable(first) && typeof first !== 'bigint')
    return cached(first, 128);
  const maxsize = first === undefined ? 128 : first === None ? undefined : Number(first);
  return builtin('decorating_function', 'one', 1, 1, ([fn]) => cached(fn, maxsize));
}

const keyWrapperClass = builtinClass('KeyWrapper');
keyWrapperClass.module = 'functools';
interface KeyWrapper {
  compare: PyValue;
  value: PyValue;
}
for (const [name, operator] of [
  ['__lt__', '<'],
  ['__gt__', '>'],
  ['__le__', '<='],
  ['__ge__', '>='],
  ['__eq__', '=='],
] as const) {
  method(keyWrapperClass, name, 'one', 1, 1, (self, [other]) => {
    if (!(other instanceof PyOpaque) || other.cls !== keyWrapperClass)
      throw typeError('other argument must be K instance');
    const a = (self as PyOpaque).data as KeyWrapper;
    const b = other.data as KeyWrapper;
    return compareOp(operator, callValue(a.compare, [a.value, b.value]), 0n);
  });
}

function cmpToKey([compare]: PyValue[]): PyValue {
  return builtin(
    'K',
    'one',
    1,
    1,
    ([value]) => new PyOpaque(keyWrapperClass, 'K', { compare, value } satisfies KeyWrapper)
  );
}

/** `functools.total_ordering`: derives the missing comparisons from `__eq__` and one ordering method. */
function totalOrdering([cls]: PyValue[]): PyValue {
  if (!(cls instanceof PyClass)) throw typeError('total_ordering requires a class');
  const roots = ['__lt__', '__le__', '__gt__', '__ge__'].filter((name) => cls.dict.has(name));
  if (roots.length === 0) throw currentRuntime().valueErrorOf('must define at least one ordering operation: < > <= >=');
  const root = roots[0];
  const call = (self: PyValue, name: string, other: PyValue): PyValue =>
    callValue(bindValue(cls.lookup(name) as PyValue, self), [other]);
  const derived: Record<string, Record<string, (self: PyValue, other: PyValue) => PyValue>> = {
    __lt__: {
      __gt__: (self, other) =>
        wrapNot(call(self, '__lt__', other), (lt) => !isTruthy(lt) && !isTruthy(compareOp('==', self, other))),
      __le__: (self, other) =>
        wrapNot(call(self, '__lt__', other), (lt) => isTruthy(lt) || isTruthy(compareOp('==', self, other))),
      __ge__: (self, other) => wrapNot(call(self, '__lt__', other), (lt) => !isTruthy(lt)),
    },
    __le__: {
      __ge__: (self, other) =>
        wrapNot(call(self, '__le__', other), (le) => !isTruthy(le) || isTruthy(compareOp('==', self, other))),
      __lt__: (self, other) =>
        wrapNot(call(self, '__le__', other), (le) => isTruthy(le) && !isTruthy(compareOp('==', self, other))),
      __gt__: (self, other) => wrapNot(call(self, '__le__', other), (le) => !isTruthy(le)),
    },
    __gt__: {
      __lt__: (self, other) =>
        wrapNot(call(self, '__gt__', other), (gt) => !isTruthy(gt) && !isTruthy(compareOp('==', self, other))),
      __ge__: (self, other) =>
        wrapNot(call(self, '__gt__', other), (gt) => isTruthy(gt) || isTruthy(compareOp('==', self, other))),
      __le__: (self, other) => wrapNot(call(self, '__gt__', other), (gt) => !isTruthy(gt)),
    },
    __ge__: {
      __le__: (self, other) =>
        wrapNot(call(self, '__ge__', other), (ge) => !isTruthy(ge) || isTruthy(compareOp('==', self, other))),
      __gt__: (self, other) =>
        wrapNot(call(self, '__ge__', other), (ge) => isTruthy(ge) && !isTruthy(compareOp('==', self, other))),
      __lt__: (self, other) => wrapNot(call(self, '__ge__', other), (ge) => !isTruthy(ge)),
    },
  };
  for (const [name, fn] of Object.entries(derived[root])) {
    if (!cls.dict.has(name)) {
      cls.dict.set(
        name,
        new PyBuiltinFunction(
          builtinClass('method_descriptor'),
          name,
          ([self, other]) => fn(self, other),
          undefined,
          'method',
          cls.name
        )
      );
    }
  }
  return cls;
}

function wrapNot(result: PyValue, convert: (value: PyValue) => boolean): PyValue {
  return result === NotImplemented ? NotImplemented : convert(result);
}

function wraps([wrapped]: PyValue[]): PyValue {
  return builtin('decorator', 'one', 1, 1, ([wrapper]) => {
    for (const name of ['__module__', '__name__', '__qualname__', '__doc__']) {
      const value = getAttributeOrUndefined(wrapped, name);
      if (value !== undefined) setAttribute(wrapper, name, value);
    }
    setAttribute(wrapper, '__wrapped__', wrapped);
    return wrapper;
  });
}

registerModule(
  'functools',
  () =>
    new Map<string, PyValue>([
      ['reduce', builtin('reduce', 'expected', 2, 3, reduce)],
      ['partial', partialClass],
      ['lru_cache', builtin('lru_cache', 'takes', 0, 2, lruCache, { keywords: ['maxsize', 'typed'] })],
      ['cache', builtin('cache', 'one', 1, 1, ([fn]) => cached(fn, undefined))],
      ['cmp_to_key', builtin('cmp_to_key', 'one', 1, 1, cmpToKey)],
      ['total_ordering', builtin('total_ordering', 'one', 1, 1, totalOrdering)],
      ['wraps', builtin('wraps', 'takes', 1, 1, wraps, { keywords: ['wrapped', 'assigned', 'updated'] })],
    ])
);

export { lookupSpecial, PyDict, PyTuple };
