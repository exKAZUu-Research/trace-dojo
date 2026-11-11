import { abcInvalidationCount } from '../abstractClasses';
import { addressOf, pyRepr } from '../conversions';
import { builtin, method } from '../define';
import { defineGetSet, defineUnsupportedAttributes } from '../descriptors';
import { DictStore } from '../dictStore';
import { runLibrarySource } from '../librarySource';
import { mappingProxyClass } from '../mappingProxy';
import { importModule, registerModule, registerUnsupportedAttributes } from '../modules';
import { checkArgs } from '../nativeArgs';
import { toIndex } from '../numbers';
import { bindValue, callValue, isCallable, isTruthy, iterate, lookupSpecial } from '../objects';
import { compareOp } from '../operators';
import { currentRuntime } from '../runtimeContext';
import { forwardRefClass, genericAliasClass, newGenericAlias, unionClass } from '../typeHints';
import {
  builtinClass,
  classOf,
  methodClass,
  methodDescriptorClass,
  namespaceDict,
  newDict,
  newTuple,
  None,
  NotImplemented,
  typeError,
} from '../types';
import {
  DONE,
  type Kwargs,
  PyBoundMethod,
  PyBuiltinFunction,
  PyClass,
  PyDict,
  PyInstance,
  type PyObject,
  PyOpaque,
  PyTuple,
  type PyValue,
} from '../values';
import { makeNamedTupleClass } from './collections';
import { FUNCTOOLS_SOURCE } from './functoolsSource';

/** Binds a callable read from a class through an instance, as the `__get__` of partial and of the lru_cache wrapper. */
function bindAsMethod(self: PyObject, instance: PyValue): PyValue {
  return instance === None ? self : new PyBoundMethod(methodClass, instance, self);
}

const partialClass = builtinClass('partial');
partialClass.tpName = 'functools.partial';
partialClass.module = 'functools';
interface Partial {
  fn: PyValue;
  args: PyValue[];
  kwargs: Map<string, PyValue>;
}
/** `functools.Placeholder`, which a partial's positional arguments leave for the call to fill. */
const placeholderClass = builtinClass('_PlaceholderType');
placeholderClass.module = 'functools';
placeholderClass.tpName = 'functools._PlaceholderType';
const Placeholder = new PyOpaque(placeholderClass, 'Placeholder');
method(placeholderClass, '__repr__', 'none', 0, 0, () => 'Placeholder');
placeholderClass.construct = () => Placeholder;

partialClass.construct = (_cls, args, kwargs) => {
  if (args.length === 0) throw typeError("type 'partial' takes at least one argument");
  const [fn, ...rest] = args;
  if (!isCallable(fn)) throw typeError('the first argument must be callable');
  if (rest.at(-1) === Placeholder) throw typeError('trailing Placeholders are not allowed');
  for (const value of kwargs?.values() ?? []) {
    if (value === Placeholder) throw typeError('Placeholder cannot be passed as a keyword argument');
  }
  if (fn instanceof PyOpaque && fn.cls === partialClass) {
    const inner = fn.data as Partial;
    const merged = new Map(inner.kwargs);
    for (const [key, value] of kwargs ?? []) merged.set(key, value);
    return newPartial(inner.fn, fillPlaceholders(inner.args, rest, true), merged);
  }
  return newPartial(fn, rest, new Map(kwargs));
};

function newPartial(fn: PyValue, args: PyValue[], kwargs: Map<string, PyValue>): PyOpaque {
  const partial = new PyOpaque(partialClass, 'partial', { fn, args, kwargs } satisfies Partial);
  partial.attributes = new Map();
  return partial;
}

/** Fills a partial's placeholders with call arguments in order, as CPython's partial does. */
function fillPlaceholders(args: readonly PyValue[], given: readonly PyValue[], nesting = false): PyValue[] {
  const count = args.filter((arg) => arg === Placeholder).length;
  if (count === 0) return [...args, ...given];
  if (!nesting && given.length < count) {
    throw typeError(`missing positional arguments in 'partial' call; expected at least ${count}, got ${given.length}`);
  }
  let index = 0;
  const filled = args.map((arg) => (arg === Placeholder && index < given.length ? given[index++] : arg));
  return [...filled, ...given.slice(index)];
}
partialClass.nativeGet = bindAsMethod;
partialClass.dict.set('__module__', 'functools');
defineGetSet(partialClass, 'func', (self) => ((self as PyOpaque).data as Partial).fn, { member: true });
defineGetSet(partialClass, 'args', (self) => newTuple(((self as PyOpaque).data as Partial).args), { member: true });
defineGetSet(partialClass, 'keywords', (self) => newDict(((self as PyOpaque).data as Partial).kwargs), {
  member: true,
});
defineGetSet(partialClass, '__dict__', (self) => namespaceDict(attributesOf(self as PyOpaque)));
defineUnsupportedAttributes(partialClass, {
  __setstate__: 'functools.partial.__setstate__()（pickle で使う状態の復元）',
  __vectorcalloffset__: 'functools.partial.__vectorcalloffset__（C の呼び出しの仕組み）',
});
method(partialClass, '__get__', 'expected', 1, 2, (self, [instance]) =>
  bindAsMethod(self as PyObject, instance ?? None)
);
method(partialClass, '__class_getitem__', 'one', 1, 1, (owner, [key]) => newGenericAlias(owner, key), {
  binding: 'class',
});

function attributesOf(object: PyOpaque): Map<string, PyValue> {
  object.attributes ??= new Map();
  return object.attributes;
}
partialClass.dict.set(
  '__call__',
  new PyBuiltinFunction(
    builtinClass('method_descriptor'),
    '__call__',
    (args, kwargs) => {
      const partial = (args[0] as PyOpaque).data as Partial;
      const merged = new Map(partial.kwargs);
      for (const [key, value] of kwargs ?? []) merged.set(key, value);
      return callValue(partial.fn, fillPlaceholders(partial.args, args.slice(1)), merged.size > 0 ? merged : undefined);
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

const cacheClass = builtinClass('_lru_cache_wrapper');
cacheClass.tpName = 'functools._lru_cache_wrapper';
cacheClass.module = 'functools';
cacheClass.dict.set('__module__', 'functools');
interface Cache {
  fn: PyValue;
  store: DictStore;
  maxsize: number | undefined;
  typed: boolean;
  hits: number;
  misses: number;
  cacheInfo: PyValue;
}

/** The marker between the positional and keyword arguments of a cache key, as `_functools.lru_cache` makes keys. */
const KEYWORD_MARK = new PyOpaque(builtinClass('object'), 'kwd_mark');

/** `functools._lru_cache_wrapper(user_function, maxsize, typed, _CacheInfo)`, the C type lru_cache() returns. */
function lruCacheWrapper([fn, maxsize, typed, cacheInfo]: PyValue[]): PyValue {
  if (!isCallable(fn)) throw typeError('the first argument must be callable');
  let limit: number | undefined;
  if (maxsize !== None) {
    const value = toIndex(maxsize);
    limit = value < 0n ? 0 : Number(value);
  }
  const cache: Cache = {
    fn,
    store: new DictStore(),
    maxsize: limit,
    typed: isTruthy(typed),
    hits: 0,
    misses: 0,
    cacheInfo,
  };
  const wrapper = new PyOpaque(cacheClass, 'cache', cache);
  wrapper.attributes = new Map();
  return wrapper;
}

function cacheKey(cache: Cache, args: PyValue[], kwargs: Kwargs): PyValue {
  const keywords = [...(kwargs ?? [])];
  if (!cache.typed && keywords.length === 0) {
    const [only] = args;
    if (args.length === 1 && (typeof only === 'bigint' || typeof only === 'string')) return only;
    return newTuple(args);
  }
  const items = [...args];
  if (keywords.length > 0) items.push(KEYWORD_MARK, ...keywords.flat());
  if (cache.typed) {
    items.push(...args.map((arg) => classOf(arg)), ...keywords.map(([, value]) => classOf(value)));
  }
  return newTuple(items);
}

cacheClass.nativeGet = bindAsMethod;
cacheClass.dict.set(
  '__call__',
  new PyBuiltinFunction(
    methodDescriptorClass,
    '__call__',
    (args, kwargs) => callCached((args[0] as PyOpaque).data as Cache, args.slice(1), kwargs),
    undefined,
    'method',
    '_lru_cache_wrapper'
  )
);

function callCached(cache: Cache, args: PyValue[], kwargs: Kwargs): PyValue {
  if (cache.maxsize === 0) {
    cache.misses++;
    return callValue(cache.fn, args, kwargs);
  }
  const key = cacheKey(cache, args, kwargs);
  const found = cache.store.lookup(key);
  if (found) {
    cache.hits++;
    if (cache.maxsize !== undefined) cache.store.moveToEnd(found, true);
    return found.value;
  }
  cache.misses++;
  const value = callValue(cache.fn, args, kwargs);
  if (cache.store.lookup(key)) return value;
  if (cache.maxsize !== undefined && cache.store.size >= cache.maxsize) {
    const oldest = cache.store.first();
    if (oldest) cache.store.remove(oldest);
  }
  cache.store.set(key, value);
  return value;
}

method(cacheClass, 'cache_info', 'none', 0, 0, (self) => {
  const cache = (self as PyOpaque).data as Cache;
  return callValue(cache.cacheInfo, [
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
method(cacheClass, '__get__', 'expected', 1, 2, (self, [instance]) => bindAsMethod(self as PyObject, instance ?? None));
for (const name of ['__copy__', '__deepcopy__']) {
  method(cacheClass, name, 'expected', 0, 1, (self) => self);
}
defineGetSet(cacheClass, '__dict__', (self) => namespaceDict((self as PyOpaque).attributes as Map<string, PyValue>));

const keyWrapperClass = builtinClass('KeyWrapper');
keyWrapperClass.tpName = 'functools.KeyWrapper';
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

registerUnsupportedAttributes('functools', {
  RLock: 'functools.RLock（スレッド）',
  itemgetter: 'functools.itemgetter（operator モジュール）',
});

registerModule('functools', (runtime) =>
  runLibrarySource(
    'functools',
    FUNCTOOLS_SOURCE,
    new Map<string, PyValue>([
      ['reduce', builtin('reduce', 'expected', 2, 3, reduce)],
      ['partial', partialClass],
      ['Placeholder', Placeholder],
      ['_lru_cache_wrapper', builtin('_lru_cache_wrapper', 'expected', 4, 4, lruCacheWrapper)],
      ['_CacheInfo', makeNamedTupleClass('CacheInfo', ['hits', 'misses', 'maxsize', 'currsize'], 'functools')],
      ['cmp_to_key', builtin('cmp_to_key', 'one', 1, 1, cmpToKey)],
      ['total_ordering', builtin('total_ordering', 'one', 1, 1, totalOrdering)],
      ['get_cache_token', builtin('get_cache_token', 'none', 0, 0, () => BigInt(abcInvalidationCount()))],
      ['GenericAlias', genericAliasClass],
      ['MappingProxyType', mappingProxyClass],
      ['MethodType', methodClass],
      ['UnionType', unionClass],
      ['namedtuple', importModule(runtime, 'collections').dict.get('namedtuple') as PyValue],
      ['_ForwardRef', forwardRefClass],
      [
        '_set_instance_dict_item',
        builtin('_set_instance_dict_item', 'expected', 3, 3, ([instance, name, value]) => {
          if (!(instance instanceof PyInstance)) throw typeError('object does not support item assignment');
          instance.dict.set(name as string, value);
          return None;
        }),
      ],
    ])
  )
);

export { lookupSpecial, PyDict, PyTuple };
