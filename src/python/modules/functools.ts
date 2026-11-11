import { addressOf, pyRepr } from '../conversions';
import { builtin, method } from '../define';
import { builtinClassesWithDict, builtinDescriptorClasses, ownDict } from '../descriptors';
import { DictStore } from '../dictStore';
import { registerModule } from '../modules';
import { namespaceDict } from '../namespaces';
import { checkArgs } from '../nativeArgs';
import { callValue, isCallable, isTruthy, iterate } from '../objects';
import { compareOp } from '../operators';
import { currentRuntime } from '../runtimeContext';
import { registerSourceModule } from '../sourceModules';
import { registerReduceVariant } from '../suspendingBuiltins';
import { newGenericAlias } from '../typeHints';
import { builtinClass, classOf, methodClass, newDict, newTuple, None, typeError } from '../types';
import { DONE, type Kwargs, PyBoundMethod, PyBuiltinFunction, PyOpaque, type PyValue } from '../values';
import { defineProperty } from './numberSupport';

/** A builtin object bound to an instance as a method, as the `__get__` of partial and lru_cache objects binds them. */
function bindAsMethod(self: PyValue, instance: PyValue | undefined): PyValue {
  return instance === undefined || instance === None ? self : new PyBoundMethod(methodClass, instance, self);
}

export const partialClass = builtinClass('partial');
partialClass.module = 'functools';
partialClass.typeName = 'functools.partial';
builtinClassesWithDict.add(partialClass);
builtinDescriptorClasses.add(partialClass);
export interface Partial {
  fn: PyValue;
  args: PyValue[];
  kwargs: Map<string, PyValue>;
}

/** `functools.Placeholder`, which a partial's positional arguments leave for the call to fill. */
const placeholderClass = builtinClass('_PlaceholderType');
placeholderClass.module = 'functools';
placeholderClass.typeName = 'functools._PlaceholderType';
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
    // A partial of a partial flattens into one, as CPython's partial_new does.
    const inner = fn.data as Partial;
    const merged = new Map(inner.kwargs);
    for (const [key, value] of kwargs ?? []) merged.set(key, value);
    return newPartial(inner.fn, fillPlaceholders(inner.args, rest, true), merged);
  }
  return newPartial(fn, rest, new Map(kwargs));
};

function newPartial(fn: PyValue, args: PyValue[], kwargs: Map<string, PyValue>): PyOpaque {
  return new PyOpaque(partialClass, 'partial', { fn, args, kwargs } satisfies Partial);
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

const partialOf = (self: PyValue): Partial => (self as PyOpaque).data as Partial;
defineProperty(partialClass, 'func', (self) => partialOf(self).fn);
defineProperty(partialClass, 'args', (self) => newTuple(partialOf(self).args));
defineProperty(partialClass, 'keywords', (self) => newDict(partialOf(self).kwargs.entries()));
defineProperty(partialClass, '__dict__', (self) => namespaceDict(ownDict(self) as Map<string, PyValue>));
method(partialClass, '__get__', 'expected', 1, 2, (self, [instance]) => bindAsMethod(self, instance));
method(partialClass, '__class_getitem__', 'one', 1, 1, (owner, [key]) => newGenericAlias(owner, key), {
  binding: 'class',
});
partialClass.dict.set(
  '__call__',
  new PyBuiltinFunction(
    builtinClass('method_descriptor'),
    '__call__',
    (args, kwargs) => {
      const partial = partialOf(args[0]);
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
  const partial = partialOf(self);
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
cacheClass.module = 'functools';
builtinClassesWithDict.add(cacheClass);
builtinDescriptorClasses.add(cacheClass);
// `_lru_cache_wrapper(user_function, maxsize, typed, _CacheInfo)`, the type of the functions lru_cache wraps.
cacheClass.construct = (_cls, args, kwargs) => {
  checkArgs({ qualified: '_lru_cache_wrapper', min: 4, max: 4, style: 'expected' }, args, kwargs);
  return lruCacheWrapper(args);
};
defineProperty(cacheClass, '__dict__', (self) => namespaceDict(ownDict(self) as Map<string, PyValue>));
interface Cache {
  fn: PyValue;
  store: DictStore;
  maxsize: number | undefined;
  typed: boolean;
  cacheInfo: PyValue;
  hits: number;
  misses: number;
}

/** `_functools._lru_cache_wrapper(user_function, maxsize, typed, _CacheInfo)`, which `lru_cache` wraps a function in. */
function lruCacheWrapper([fn, maxsize, typed, cacheInfo]: PyValue[]): PyValue {
  if (!isCallable(fn)) throw typeError('the first argument must be callable');
  let size: number | undefined;
  if (maxsize !== None) {
    if (typeof maxsize !== 'bigint') throw typeError('maxsize should be integer or None');
    size = maxsize < 0n ? 0 : Number(maxsize);
  }
  return new PyOpaque(cacheClass, 'cache', {
    fn,
    store: new DictStore(),
    maxsize: size,
    typed: isTruthy(typed),
    cacheInfo,
    hits: 0,
    misses: 0,
  } satisfies Cache);
}

/** The marker between the positional and the keyword arguments of a cache key, as `_make_key`'s `kwd_mark`. */
const KEYWORD_MARK = new PyOpaque(builtinClass('object'), 'kwd_mark');

/** The key `_make_key` gives a call: its arguments, the keywords after a marker, and their types when typed. */
function cacheKey(cache: Cache, args: PyValue[], kwargs: Kwargs): PyValue {
  const items: PyValue[] = [...args];
  if (kwargs && kwargs.size > 0) {
    items.push(KEYWORD_MARK);
    for (const [name, value] of kwargs) items.push(name, value);
  }
  if (cache.typed) {
    for (const value of args) items.push(classOf(value));
    for (const value of kwargs?.values() ?? []) items.push(classOf(value));
  }
  return newTuple(items);
}
cacheClass.dict.set(
  '__call__',
  new PyBuiltinFunction(
    builtinClass('method_descriptor'),
    '__call__',
    (args, kwargs) => {
      const cache = (args[0] as PyOpaque).data as Cache;
      const callArgs = args.slice(1);
      if (cache.maxsize === 0) {
        cache.misses++;
        return callValue(cache.fn, callArgs, kwargs);
      }
      const key = cacheKey(cache, callArgs, kwargs);
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
cacheClass.dict.set(
  '__get__',
  new PyBuiltinFunction(
    builtinClass('method_descriptor'),
    '__get__',
    ([self, instance]) => bindAsMethod(self, instance),
    undefined,
    'method',
    '_lru_cache_wrapper'
  )
);

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

// CPython's `functools.py`, whose C parts `_functools` gives, with
// singledispatch's cache a plain dict, as this grader has no weak references to classes.
const SOURCE =
  String.raw`"""functools.py - Tools for working with functions and callable objects
"""
# Python module wrapper for _functools C module
# to allow utilities written in Python to be added
# to the functools module.
# Written by Nick Coghlan <ncoghlan at gmail.com>,
# Raymond Hettinger <python at rcn.com>,
# and Łukasz Langa <lukasz at langa.pl>.
#   Copyright (C) 2006 Python Software Foundation.
# See C source code for _functools credits/copyright

__all__ = ['update_wrapper', 'wraps', 'WRAPPER_ASSIGNMENTS', 'WRAPPER_UPDATES',
           'total_ordering', 'cache', 'cmp_to_key', 'lru_cache', 'reduce',
           'partial', 'partialmethod', 'singledispatch', 'singledispatchmethod',
           'cached_property', 'Placeholder']

from abc import get_cache_token
from collections import namedtuple
# import weakref  # Deferred to single_dispatch()
from operator import itemgetter
from reprlib import recursive_repr
from types import GenericAlias, MethodType, MappingProxyType, UnionType
from _thread import RLock

################################################################################
### update_wrapper() and wraps() decorator
################################################################################

# update_wrapper() and wraps() are tools to help write
# wrapper functions that can handle naive introspection

WRAPPER_ASSIGNMENTS = ('__module__', '__name__', '__qualname__', '__doc__',
                       '__annotate__', '__type_params__')
WRAPPER_UPDATES = ('__dict__',)
def update_wrapper(wrapper,
                   wrapped,
                   assigned = WRAPPER_ASSIGNMENTS,
                   updated = WRAPPER_UPDATES):
    """Update a wrapper function to look like the wrapped function

       wrapper is the function to be updated
       wrapped is the original function
       assigned is a tuple naming the attributes assigned directly
       from the wrapped function to the wrapper function (defaults to
       functools.WRAPPER_ASSIGNMENTS)
       updated is a tuple naming the attributes of the wrapper that
       are updated with the corresponding attribute from the wrapped
       function (defaults to functools.WRAPPER_UPDATES)
    """
    for attr in assigned:
        try:
            value = getattr(wrapped, attr)
        except AttributeError:
            pass
        else:
            setattr(wrapper, attr, value)
    for attr in updated:
        getattr(wrapper, attr).update(getattr(wrapped, attr, {}))
    # Issue #17482: set __wrapped__ last so we don't inadvertently copy it
    # from the wrapped function when updating __dict__
    wrapper.__wrapped__ = wrapped
    # Return the wrapper so this can be used as a decorator via partial()
    return wrapper

def wraps(wrapped,
          assigned = WRAPPER_ASSIGNMENTS,
          updated = WRAPPER_UPDATES):
    """Decorator factory to apply update_wrapper() to a wrapper function

       Returns a decorator that invokes update_wrapper() with the decorated
       function as the wrapper argument and the arguments to wraps() as the
       remaining arguments. Default arguments are as for update_wrapper().
       This is a convenience function to simplify applying partial() to
       update_wrapper().
    """
    return partial(update_wrapper, wrapped=wrapped,
                   assigned=assigned, updated=updated)

################################################################################
### total_ordering class decorator
################################################################################

# The total ordering functions all invoke the root magic method directly
# rather than using the corresponding operator.  This avoids possible
# infinite recursion that could occur when the operator dispatch logic
# detects a NotImplemented result and then calls a reflected method.

def _gt_from_lt(self, other):
    'Return a > b.  Computed by @total_ordering from (not a < b) and (a != b).'
    op_result = type(self).__lt__(self, other)
    if op_result is NotImplemented:
        return op_result
    return not op_result and self != other

def _le_from_lt(self, other):
    'Return a <= b.  Computed by @total_ordering from (a < b) or (a == b).'
    op_result = type(self).__lt__(self, other)
    if op_result is NotImplemented:
        return op_result
    return op_result or self == other

def _ge_from_lt(self, other):
    'Return a >= b.  Computed by @total_ordering from (not a < b).'
    op_result = type(self).__lt__(self, other)
    if op_result is NotImplemented:
        return op_result
    return not op_result

def _ge_from_le(self, other):
    'Return a >= b.  Computed by @total_ordering from (not a <= b) or (a == b).'
    op_result = type(self).__le__(self, other)
    if op_result is NotImplemented:
        return op_result
    return not op_result or self == other

def _lt_from_le(self, other):
    'Return a < b.  Computed by @total_ordering from (a <= b) and (a != b).'
    op_result = type(self).__le__(self, other)
    if op_result is NotImplemented:
        return op_result
    return op_result and self != other

def _gt_from_le(self, other):
    'Return a > b.  Computed by @total_ordering from (not a <= b).'
    op_result = type(self).__le__(self, other)
    if op_result is NotImplemented:
        return op_result
    return not op_result

def _lt_from_gt(self, other):
    'Return a < b.  Computed by @total_ordering from (not a > b) and (a != b).'
    op_result = type(self).__gt__(self, other)
    if op_result is NotImplemented:
        return op_result
    return not op_result and self != other

def _ge_from_gt(self, other):
    'Return a >= b.  Computed by @total_ordering from (a > b) or (a == b).'
    op_result = type(self).__gt__(self, other)
    if op_result is NotImplemented:
        return op_result
    return op_result or self == other

def _le_from_gt(self, other):
    'Return a <= b.  Computed by @total_ordering from (not a > b).'
    op_result = type(self).__gt__(self, other)
    if op_result is NotImplemented:
        return op_result
    return not op_result

def _le_from_ge(self, other):
    'Return a <= b.  Computed by @total_ordering from (not a >= b) or (a == b).'
    op_result = type(self).__ge__(self, other)
    if op_result is NotImplemented:
        return op_result
    return not op_result or self == other

def _gt_from_ge(self, other):
    'Return a > b.  Computed by @total_ordering from (a >= b) and (a != b).'
    op_result = type(self).__ge__(self, other)
    if op_result is NotImplemented:
        return op_result
    return op_result and self != other

def _lt_from_ge(self, other):
    'Return a < b.  Computed by @total_ordering from (not a >= b).'
    op_result = type(self).__ge__(self, other)
    if op_result is NotImplemented:
        return op_result
    return not op_result

_convert = {
    '__lt__': [('__gt__', _gt_from_lt),
               ('__le__', _le_from_lt),
               ('__ge__', _ge_from_lt)],
    '__le__': [('__ge__', _ge_from_le),
               ('__lt__', _lt_from_le),
               ('__gt__', _gt_from_le)],
    '__gt__': [('__lt__', _lt_from_gt),
               ('__ge__', _ge_from_gt),
               ('__le__', _le_from_gt)],
    '__ge__': [('__le__', _le_from_ge),
               ('__gt__', _gt_from_ge),
               ('__lt__', _lt_from_ge)]
}

def total_ordering(cls):
    """Class decorator that fills in missing ordering methods"""
    # Find user-defined comparisons (not those inherited from object).
    roots = {op for op in _convert if getattr(cls, op, None) is not getattr(object, op, None)}
    if not roots:
        raise ValueError('must define at least one ordering operation: < > <= >=')
    root = max(roots)       # prefer __lt__ to __le__ to __gt__ to __ge__
    for opname, opfunc in _convert[root]:
        if opname not in roots:
            opfunc.__name__ = opname
            setattr(cls, opname, opfunc)
    return cls

################################################################################
### cmp_to_key() function converter
################################################################################

def cmp_to_key(mycmp):
    """Convert a cmp= function into a key= function"""
    class K(object):
        __slots__ = ['obj']
        def __init__(self, obj):
            self.obj = obj
        def __lt__(self, other):
            return mycmp(self.obj, other.obj) < 0
        def __gt__(self, other):
            return mycmp(self.obj, other.obj) > 0
        def __eq__(self, other):
            return mycmp(self.obj, other.obj) == 0
        def __le__(self, other):
            return mycmp(self.obj, other.obj) <= 0
        def __ge__(self, other):
            return mycmp(self.obj, other.obj) >= 0
        __hash__ = None
    return K

try:
    from _functools import cmp_to_key
except ImportError:
    pass

################################################################################
### reduce() sequence to a single item
################################################################################

_initial_missing = object()

def reduce(function, sequence, initial=_initial_missing):
    """
    reduce(function, iterable, /[, initial]) -> value

    Apply a function of two arguments cumulatively to the items of an iterable, from left to right.

    This effectively reduces the iterable to a single value.  If initial is present,
    it is placed before the items of the iterable in the calculation, and serves as
    a default when the iterable is empty.

    For example, reduce(lambda x, y: x+y, [1, 2, 3, 4, 5])
    calculates ((((1 + 2) + 3) + 4) + 5).
    """

    it = iter(sequence)

    if initial is _initial_missing:
        try:
            value = next(it)
        except StopIteration:
            raise TypeError(
                "reduce() of empty iterable with no initial value") from None
    else:
        value = initial

    for element in it:
        value = function(value, element)

    return value

################################################################################
### partial() argument application
################################################################################

class _PlaceholderType:
    """The type of the Placeholder singleton.

    Used as a placeholder for partial arguments.
    """
    __instance = None
    __slots__ = ()

    def __init_subclass__(cls, *args, **kwargs):
        raise TypeError(f"type '{cls.__name__}' is not an acceptable base type")

    def __new__(cls):
        if cls.__instance is None:
            cls.__instance = object.__new__(cls)
        return cls.__instance

    def __repr__(self):
        return 'Placeholder'

    def __reduce__(self):
        return 'Placeholder'

Placeholder = _PlaceholderType()

def _partial_prepare_merger(args):
    if not args:
        return 0, None
    nargs = len(args)
    order = []
    j = nargs
    for i, a in enumerate(args):
        if a is Placeholder:
            order.append(j)
            j += 1
        else:
            order.append(i)
    phcount = j - nargs
    merger = itemgetter(*order) if phcount else None
    return phcount, merger

def _partial_new(cls, func, /, *args, **keywords):
    if issubclass(cls, partial):
        base_cls = partial
        if not callable(func):
            raise TypeError("the first argument must be callable")
    else:
        base_cls = partialmethod
        # func could be a descriptor like classmethod which isn't callable
        if not callable(func) and not hasattr(func, "__get__"):
            raise TypeError(f"the first argument {func!r} must be a callable "
                            "or a descriptor")
    if args and args[-1] is Placeholder:
        raise TypeError("trailing Placeholders are not allowed")
    for value in keywords.values():
        if value is Placeholder:
            raise TypeError("Placeholder cannot be passed as a keyword argument")
    if isinstance(func, base_cls):
        pto_phcount = func._phcount
        tot_args = func.args
        if args:
            tot_args += args
            if pto_phcount:
                # merge args with args of ` +
  '`' +
  String.raw`func` +
  '`' +
  String.raw` which is ` +
  '`' +
  String.raw`partial` +
  '`' +
  String.raw`
                nargs = len(args)
                if nargs < pto_phcount:
                    tot_args += (Placeholder,) * (pto_phcount - nargs)
                tot_args = func._merger(tot_args)
                if nargs > pto_phcount:
                    tot_args += args[pto_phcount:]
            phcount, merger = _partial_prepare_merger(tot_args)
        else:   # works for both pto_phcount == 0 and != 0
            phcount, merger = pto_phcount, func._merger
        keywords = {**func.keywords, **keywords}
        func = func.func
    else:
        tot_args = args
        phcount, merger = _partial_prepare_merger(tot_args)

    self = object.__new__(cls)
    self.func = func
    self.args = tot_args
    self.keywords = keywords
    self._phcount = phcount
    self._merger = merger
    return self

def _partial_repr(self):
    cls = type(self)
    module = cls.__module__
    qualname = cls.__qualname__
    args = [repr(self.func)]
    args.extend(map(repr, self.args))
    args.extend(f"{k}={v!r}" for k, v in self.keywords.items())
    return f"{module}.{qualname}({', '.join(args)})"

# Purely functional, no descriptor behaviour
class partial:
    """New function with partial application of the given arguments
    and keywords.
    """

    __slots__ = ("func", "args", "keywords", "_phcount", "_merger",
                 "__dict__", "__weakref__")

    __new__ = _partial_new
    __repr__ = recursive_repr()(_partial_repr)

    def __call__(self, /, *args, **keywords):
        phcount = self._phcount
        if phcount:
            try:
                pto_args = self._merger(self.args + args)
                args = args[phcount:]
            except IndexError:
                raise TypeError("missing positional arguments "
                                "in 'partial' call; expected "
                                f"at least {phcount}, got {len(args)}")
        else:
            pto_args = self.args
        keywords = {**self.keywords, **keywords}
        return self.func(*pto_args, *args, **keywords)

    def __get__(self, obj, objtype=None):
        if obj is None:
            return self
        return MethodType(self, obj)

    def __reduce__(self):
        return type(self), (self.func,), (self.func, self.args,
               self.keywords or None, self.__dict__ or None)

    def __setstate__(self, state):
        if not isinstance(state, tuple):
            raise TypeError("argument to __setstate__ must be a tuple")
        if len(state) != 4:
            raise TypeError(f"expected 4 items in state, got {len(state)}")
        func, args, kwds, namespace = state
        if (not callable(func) or not isinstance(args, tuple) or
           (kwds is not None and not isinstance(kwds, dict)) or
           (namespace is not None and not isinstance(namespace, dict))):
            raise TypeError("invalid partial state")

        if args and args[-1] is Placeholder:
            raise TypeError("trailing Placeholders are not allowed")
        phcount, merger = _partial_prepare_merger(args)

        args = tuple(args) # just in case it's a subclass
        if kwds is None:
            kwds = {}
        elif type(kwds) is not dict: # XXX does it need to be *exactly* dict?
            kwds = dict(kwds)
        if namespace is None:
            namespace = {}

        self.__dict__ = namespace
        self.func = func
        self.args = args
        self.keywords = kwds
        self._phcount = phcount
        self._merger = merger

    __class_getitem__ = classmethod(GenericAlias)

try:
    from _functools import partial, Placeholder, _PlaceholderType
except ImportError:
    pass

# Descriptor version
class partialmethod:
    """Method descriptor with partial application of the given arguments
    and keywords.

    Supports wrapping existing descriptors and handles non-descriptor
    callables as instance methods.
    """
    __new__ = _partial_new
    __repr__ = _partial_repr

    def _make_unbound_method(self):
        def _method(cls_or_self, /, *args, **keywords):
            phcount = self._phcount
            if phcount:
                try:
                    pto_args = self._merger(self.args + args)
                    args = args[phcount:]
                except IndexError:
                    raise TypeError("missing positional arguments "
                                    "in 'partialmethod' call; expected "
                                    f"at least {phcount}, got {len(args)}")
            else:
                pto_args = self.args
            keywords = {**self.keywords, **keywords}
            return self.func(cls_or_self, *pto_args, *args, **keywords)
        _method.__isabstractmethod__ = self.__isabstractmethod__
        _method.__partialmethod__ = self
        return _method

    def __get__(self, obj, cls=None):
        get = getattr(self.func, "__get__", None)
        result = None
        if get is not None:
            new_func = get(obj, cls)
            if new_func is not self.func:
                # Assume __get__ returning something new indicates the
                # creation of an appropriate callable
                result = partial(new_func, *self.args, **self.keywords)
                try:
                    result.__self__ = new_func.__self__
                except AttributeError:
                    pass
        if result is None:
            # If the underlying descriptor didn't do anything, treat this
            # like an instance method
            result = self._make_unbound_method().__get__(obj, cls)
        return result

    @property
    def __isabstractmethod__(self):
        return getattr(self.func, "__isabstractmethod__", False)

    __class_getitem__ = classmethod(GenericAlias)

# Helper functions

def _unwrap_partial(func):
    while isinstance(func, partial):
        func = func.func
    return func

def _unwrap_partialmethod(func):
    prev = None
    while func is not prev:
        prev = func
        while isinstance(getattr(func, "__partialmethod__", None), partialmethod):
            func = func.__partialmethod__
        while isinstance(func, partialmethod):
            func = getattr(func, 'func')
        func = _unwrap_partial(func)
    return func

################################################################################
### LRU Cache function decorator
################################################################################

_CacheInfo = namedtuple("CacheInfo", ["hits", "misses", "maxsize", "currsize"])

def _make_key(args, kwds, typed,
             kwd_mark = (object(),),
             fasttypes = {int, str},
             tuple=tuple, type=type, len=len):
    """Make a cache key from optionally typed positional and keyword arguments

    The key is constructed in a way that is flat as possible rather than
    as a nested structure that would take more memory.

    If there is only a single argument and its data type is known to cache
    its hash value, then that argument is returned without a wrapper.  This
    saves space and improves lookup speed.

    """
    # All of code below relies on kwds preserving the order input by the user.
    # Formerly, we sorted() the kwds before looping.  The new way is *much*
    # faster; however, it means that f(x=1, y=2) will now be treated as a
    # distinct call from f(y=2, x=1) which will be cached separately.
    key = args
    if kwds:
        key += kwd_mark
        for item in kwds.items():
            key += item
    if typed:
        key += tuple(type(v) for v in args)
        if kwds:
            key += tuple(type(v) for v in kwds.values())
    elif len(key) == 1 and type(key[0]) in fasttypes:
        return key[0]
    return key

def lru_cache(maxsize=128, typed=False):
    """Least-recently-used cache decorator.

    If *maxsize* is set to None, the LRU features are disabled and the cache
    can grow without bound.

    If *typed* is True, arguments of different types will be cached
    separately.  For example, f(decimal.Decimal("3.0")) and f(3.0) will be
    treated as distinct calls with distinct results.  Some types such as
    str and int may be cached separately even when typed is false.

    Arguments to the cached function must be hashable.

    View the cache statistics named tuple (hits, misses, maxsize, currsize)
    with f.cache_info().  Clear the cache and statistics with
    f.cache_clear().  Access the underlying function with f.__wrapped__.

    See:  https://en.wikipedia.org/wiki/Cache_replacement_policies#Least_recently_used_(LRU)

    """

    # Users should only access the lru_cache through its public API:
    #       cache_info, cache_clear, and f.__wrapped__
    # The internals of the lru_cache are encapsulated for thread safety and
    # to allow the implementation to change (including a possible C version).

    if isinstance(maxsize, int):
        # Negative maxsize is treated as 0
        if maxsize < 0:
            maxsize = 0
    elif callable(maxsize) and isinstance(typed, bool):
        # The user_function was passed in directly via the maxsize argument
        user_function, maxsize = maxsize, 128
        wrapper = _lru_cache_wrapper(user_function, maxsize, typed, _CacheInfo)
        wrapper.cache_parameters = lambda : {'maxsize': maxsize, 'typed': typed}
        return update_wrapper(wrapper, user_function)
    elif maxsize is not None:
        raise TypeError(
            'Expected first argument to be an integer, a callable, or None')

    def decorating_function(user_function):
        wrapper = _lru_cache_wrapper(user_function, maxsize, typed, _CacheInfo)
        wrapper.cache_parameters = lambda : {'maxsize': maxsize, 'typed': typed}
        return update_wrapper(wrapper, user_function)

    return decorating_function

def _lru_cache_wrapper(user_function, maxsize, typed, _CacheInfo):
    # Constants shared by all lru cache instances:
    sentinel = object()          # unique object used to signal cache misses
    make_key = _make_key         # build a key from the function arguments
    PREV, NEXT, KEY, RESULT = 0, 1, 2, 3   # names for the link fields

    cache = {}
    hits = misses = 0
    full = False
    cache_get = cache.get    # bound method to lookup a key or return None
    cache_len = cache.__len__  # get cache size without calling len()
    lock = RLock()           # because linkedlist updates aren't threadsafe
    root = []                # root of the circular doubly linked list
    root[:] = [root, root, None, None]     # initialize by pointing to self

    if maxsize == 0:

        def wrapper(*args, **kwds):
            # No caching -- just a statistics update
            nonlocal misses
            misses += 1
            result = user_function(*args, **kwds)
            return result

    elif maxsize is None:

        def wrapper(*args, **kwds):
            # Simple caching without ordering or size limit
            nonlocal hits, misses
            key = make_key(args, kwds, typed)
            result = cache_get(key, sentinel)
            if result is not sentinel:
                hits += 1
                return result
            misses += 1
            result = user_function(*args, **kwds)
            cache[key] = result
            return result

    else:

        def wrapper(*args, **kwds):
            # Size limited caching that tracks accesses by recency
            nonlocal root, hits, misses, full
            key = make_key(args, kwds, typed)
            with lock:
                link = cache_get(key)
                if link is not None:
                    # Move the link to the front of the circular queue
                    link_prev, link_next, _key, result = link
                    link_prev[NEXT] = link_next
                    link_next[PREV] = link_prev
                    last = root[PREV]
                    last[NEXT] = root[PREV] = link
                    link[PREV] = last
                    link[NEXT] = root
                    hits += 1
                    return result
                misses += 1
            result = user_function(*args, **kwds)
            with lock:
                if key in cache:
                    # Getting here means that this same key was added to the
                    # cache while the lock was released.  Since the link
                    # update is already done, we need only return the
                    # computed result and update the count of misses.
                    pass
                elif full:
                    # Use the old root to store the new key and result.
                    oldroot = root
                    oldroot[KEY] = key
                    oldroot[RESULT] = result
                    # Empty the oldest link and make it the new root.
                    # Keep a reference to the old key and old result to
                    # prevent their ref counts from going to zero during the
                    # update. That will prevent potentially arbitrary object
                    # clean-up code (i.e. __del__) from running while we're
                    # still adjusting the links.
                    root = oldroot[NEXT]
                    oldkey = root[KEY]
                    oldresult = root[RESULT]
                    root[KEY] = root[RESULT] = None
                    # Now update the cache dictionary.
                    del cache[oldkey]
                    # Save the potentially reentrant cache[key] assignment
                    # for last, after the root and links have been put in
                    # a consistent state.
                    cache[key] = oldroot
                else:
                    # Put result in a new link at the front of the queue.
                    last = root[PREV]
                    link = [last, root, key, result]
                    last[NEXT] = root[PREV] = cache[key] = link
                    # Use the cache_len bound method instead of the len() function
                    # which could potentially be wrapped in an lru_cache itself.
                    full = (cache_len() >= maxsize)
            return result

    def cache_info():
        """Report cache statistics"""
        with lock:
            return _CacheInfo(hits, misses, maxsize, cache_len())

    def cache_clear():
        """Clear the cache and cache statistics"""
        nonlocal hits, misses, full
        with lock:
            cache.clear()
            root[:] = [root, root, None, None]
            hits = misses = 0
            full = False

    wrapper.cache_info = cache_info
    wrapper.cache_clear = cache_clear
    return wrapper

try:
    from _functools import _lru_cache_wrapper
except ImportError:
    pass

################################################################################
### cache -- simplified access to the infinity cache
################################################################################

def cache(user_function, /):
    'Simple lightweight unbounded cache.  Sometimes called "memoize".'
    return lru_cache(maxsize=None)(user_function)

################################################################################
### singledispatch() - single-dispatch generic function decorator
################################################################################

def _c3_merge(sequences):
    """Merges MROs in *sequences* to a single MRO using the C3 algorithm.

    Adapted from https://docs.python.org/3/howto/mro.html.

    """
    result = []
    while True:
        sequences = [s for s in sequences if s]   # purge empty sequences
        if not sequences:
            return result
        for s1 in sequences:   # find merge candidates among seq heads
            candidate = s1[0]
            for s2 in sequences:
                if candidate in s2[1:]:
                    candidate = None
                    break      # reject the current head, it appears later
            else:
                break
        if candidate is None:
            raise RuntimeError("Inconsistent hierarchy")
        result.append(candidate)
        # remove the chosen candidate
        for seq in sequences:
            if seq[0] == candidate:
                del seq[0]

def _c3_mro(cls, abcs=None):
    """Computes the method resolution order using extended C3 linearization.

    If no *abcs* are given, the algorithm works exactly like the built-in C3
    linearization used for method resolution.

    If given, *abcs* is a list of abstract base classes that should be inserted
    into the resulting MRO. Unrelated ABCs are ignored and don't end up in the
    result. The algorithm inserts ABCs where their functionality is introduced,
    i.e. issubclass(cls, abc) returns True for the class itself but returns
    False for all its direct base classes. Implicit ABCs for a given class
    (either registered or inferred from the presence of a special method like
    __len__) are inserted directly after the last ABC explicitly listed in the
    MRO of said class. If two implicit ABCs end up next to each other in the
    resulting MRO, their ordering depends on the order of types in *abcs*.

    """
    for i, base in enumerate(reversed(cls.__bases__)):
        if hasattr(base, '__abstractmethods__'):
            boundary = len(cls.__bases__) - i
            break   # Bases up to the last explicit ABC are considered first.
    else:
        boundary = 0
    abcs = list(abcs) if abcs else []
    explicit_bases = list(cls.__bases__[:boundary])
    abstract_bases = []
    other_bases = list(cls.__bases__[boundary:])
    for base in abcs:
        if issubclass(cls, base) and not any(
                issubclass(b, base) for b in cls.__bases__
            ):
            # If *cls* is the class that introduces behaviour described by
            # an ABC *base*, insert said ABC to its MRO.
            abstract_bases.append(base)
    for base in abstract_bases:
        abcs.remove(base)
    explicit_c3_mros = [_c3_mro(base, abcs=abcs) for base in explicit_bases]
    abstract_c3_mros = [_c3_mro(base, abcs=abcs) for base in abstract_bases]
    other_c3_mros = [_c3_mro(base, abcs=abcs) for base in other_bases]
    return _c3_merge(
        [[cls]] +
        explicit_c3_mros + abstract_c3_mros + other_c3_mros +
        [explicit_bases] + [abstract_bases] + [other_bases]
    )

def _compose_mro(cls, types):
    """Calculates the method resolution order for a given class *cls*.

    Includes relevant abstract base classes (with their respective bases) from
    the *types* iterable. Uses a modified C3 linearization algorithm.

    """
    bases = set(cls.__mro__)
    # Remove entries which are already present in the __mro__ or unrelated.
    def is_related(typ):
        return (typ not in bases and hasattr(typ, '__mro__')
                                 and not isinstance(typ, GenericAlias)
                                 and issubclass(cls, typ))
    types = [n for n in types if is_related(n)]
    # Remove entries which are strict bases of other entries (they will end up
    # in the MRO anyway.
    def is_strict_base(typ):
        for other in types:
            if typ != other and typ in other.__mro__:
                return True
        return False
    types = [n for n in types if not is_strict_base(n)]
    # Subclasses of the ABCs in *types* which are also implemented by
    # *cls* can be used to stabilize ABC ordering.
    type_set = set(types)
    mro = []
    for typ in types:
        found = []
        for sub in typ.__subclasses__():
            if sub not in bases and issubclass(cls, sub):
                found.append([s for s in sub.__mro__ if s in type_set])
        if not found:
            mro.append(typ)
            continue
        # Favor subclasses with the biggest number of useful bases
        found.sort(key=len, reverse=True)
        for sub in found:
            for subcls in sub:
                if subcls not in mro:
                    mro.append(subcls)
    return _c3_mro(cls, abcs=mro)

def _find_impl(cls, registry):
    """Returns the best matching implementation from *registry* for type *cls*.

    Where there is no registered implementation for a specific type, its method
    resolution order is used to find a more generic implementation.

    Note: if *registry* does not contain an implementation for the base
    *object* type, this function may return None.

    """
    mro = _compose_mro(cls, registry.keys())
    match = None
    for t in mro:
        if match is not None:
            # If *match* is an implicit ABC but there is another unrelated,
            # equally matching implicit ABC, refuse the temptation to guess.
            if (t in registry and t not in cls.__mro__
                              and match not in cls.__mro__
                              and not issubclass(match, t)):
                raise RuntimeError("Ambiguous dispatch: {} or {}".format(
                    match, t))
            break
        if t in registry:
            match = t
    return registry.get(match)

def singledispatch(func):
    """Single-dispatch generic function decorator.

    Transforms a function into a generic function, which can have different
    behaviours depending upon the type of its first argument. The decorated
    function acts as the default implementation, and additional
    implementations can be registered using the register() attribute of the
    generic function.
    """
    # There are many programs that use functools without singledispatch, so we
    # trade-off making singledispatch marginally slower for the benefit of
    # making start-up of such applications slightly faster.

    registry = {}
    dispatch_cache = {}
    cache_token = None

    def dispatch(cls):
        """generic_func.dispatch(cls) -> <function implementation>

        Runs the dispatch algorithm to return the best available implementation
        for the given *cls* registered on *generic_func*.

        """
        nonlocal cache_token
        if cache_token is not None:
            current_token = get_cache_token()
            if cache_token != current_token:
                dispatch_cache.clear()
                cache_token = current_token
        try:
            impl = dispatch_cache[cls]
        except KeyError:
            try:
                impl = registry[cls]
            except KeyError:
                impl = _find_impl(cls, registry)
            dispatch_cache[cls] = impl
        return impl

    def _is_valid_dispatch_type(cls):
        if isinstance(cls, type):
            return True
        return (isinstance(cls, UnionType) and
                all(isinstance(arg, type) for arg in cls.__args__))

    def register(cls, func=None):
        """generic_func.register(cls, func) -> func

        Registers a new implementation for the given *cls* on a *generic_func*.

        """
        nonlocal cache_token
        if _is_valid_dispatch_type(cls):
            if func is None:
                return lambda f: register(cls, f)
        else:
            if func is not None:
                raise TypeError(
                    f"Invalid first argument to ` +
  '`' +
  String.raw`register()` +
  '`' +
  String.raw`. "
                    f"{cls!r} is not a class or union type."
                )
            ann = getattr(cls, '__annotate__', None)
            if ann is None:
                raise TypeError(
                    f"Invalid first argument to ` +
  '`' +
  String.raw`register()` +
  '`' +
  String.raw`: {cls!r}. "
                    f"Use either ` +
  '`' +
  String.raw`@register(some_class)` +
  '`' +
  String.raw` or plain ` +
  '`' +
  String.raw`@register` +
  '`' +
  String.raw` "
                    f"on an annotated function."
                )
            func = cls

            # only import typing if annotation parsing is necessary
            from typing import get_type_hints
            from annotationlib import Format, ForwardRef
            argname, cls = next(iter(get_type_hints(func, format=Format.FORWARDREF).items()))
            if not _is_valid_dispatch_type(cls):
                if isinstance(cls, UnionType):
                    raise TypeError(
                        f"Invalid annotation for {argname!r}. "
                        f"{cls!r} not all arguments are classes."
                    )
                elif isinstance(cls, ForwardRef):
                    raise TypeError(
                        f"Invalid annotation for {argname!r}. "
                        f"{cls!r} is an unresolved forward reference."
                    )
                else:
                    raise TypeError(
                        f"Invalid annotation for {argname!r}. "
                        f"{cls!r} is not a class."
                    )

        if isinstance(cls, UnionType):
            for arg in cls.__args__:
                registry[arg] = func
        else:
            registry[cls] = func
        if cache_token is None and hasattr(cls, '__abstractmethods__'):
            cache_token = get_cache_token()
        dispatch_cache.clear()
        return func

    def wrapper(*args, **kw):
        if not args:
            raise TypeError(f'{funcname} requires at least '
                            '1 positional argument')
        return dispatch(args[0].__class__)(*args, **kw)

    funcname = getattr(func, '__name__', 'singledispatch function')
    registry[object] = func
    wrapper.register = register
    wrapper.dispatch = dispatch
    wrapper.registry = MappingProxyType(registry)
    wrapper._clear_cache = dispatch_cache.clear
    update_wrapper(wrapper, func)
    return wrapper

# Descriptor version
class singledispatchmethod:
    """Single-dispatch generic method descriptor.

    Supports wrapping existing descriptors.
    """

    def __init__(self, func):
        if not callable(func) and not hasattr(func, "__get__"):
            raise TypeError(f"{func!r} is not callable or a descriptor")

        self.dispatcher = singledispatch(func)
        self.func = func

    def register(self, cls, method=None):
        """generic_method.register(cls, func) -> func

        Registers a new implementation for the given *cls* on a *generic_method*.
        """
        return self.dispatcher.register(cls, func=method)

    def __get__(self, obj, cls=None):
        return _singledispatchmethod_get(self, obj, cls)

    @property
    def __isabstractmethod__(self):
        return getattr(self.func, '__isabstractmethod__', False)

    def __repr__(self):
        try:
            name = self.func.__qualname__
        except AttributeError:
            try:
                name = self.func.__name__
            except AttributeError:
                name = '?'
        return f'<single dispatch method descriptor {name}>'

class _singledispatchmethod_get:
    def __init__(self, unbound, obj, cls):
        self._unbound = unbound
        self._dispatch = unbound.dispatcher.dispatch
        self._obj = obj
        self._cls = cls
        # Set instance attributes which cannot be handled in __getattr__()
        # because they conflict with type descriptors.
        func = unbound.func
        try:
            self.__module__ = func.__module__
        except AttributeError:
            pass
        try:
            self.__doc__ = func.__doc__
        except AttributeError:
            pass

    def __repr__(self):
        try:
            name = self.__qualname__
        except AttributeError:
            try:
                name = self.__name__
            except AttributeError:
                name = '?'
        if self._obj is not None:
            return f'<bound single dispatch method {name} of {self._obj!r}>'
        else:
            return f'<single dispatch method {name}>'

    def __call__(self, /, *args, **kwargs):
        if not args:
            funcname = getattr(self._unbound.func, '__name__',
                               'singledispatchmethod method')
            raise TypeError(f'{funcname} requires at least '
                            '1 positional argument')
        return self._dispatch(args[0].__class__).__get__(self._obj, self._cls)(*args, **kwargs)

    def __getattr__(self, name):
        # Resolve these attributes lazily to speed up creation of
        # the _singledispatchmethod_get instance.
        if name not in {'__name__', '__qualname__', '__isabstractmethod__',
                        '__annotations__', '__type_params__'}:
            raise AttributeError
        return getattr(self._unbound.func, name)

    @property
    def __wrapped__(self):
        return self._unbound.func

    @property
    def register(self):
        return self._unbound.register

################################################################################
### cached_property() - property result cached as instance attribute
################################################################################

_NOT_FOUND = object()

class cached_property:
    def __init__(self, func):
        self.func = func
        self.attrname = None
        self.__doc__ = func.__doc__
        self.__module__ = func.__module__

    def __set_name__(self, owner, name):
        if self.attrname is None:
            self.attrname = name
        elif name != self.attrname:
            raise TypeError(
                "Cannot assign the same cached_property to two different names "
                f"({self.attrname!r} and {name!r})."
            )

    def __get__(self, instance, owner=None):
        if instance is None:
            return self
        if self.attrname is None:
            raise TypeError(
                "Cannot use cached_property instance without calling __set_name__ on it.")
        try:
            cache = instance.__dict__
        except AttributeError:  # not all objects have __dict__ (e.g. class defines slots)
            msg = (
                f"No '__dict__' attribute on {type(instance).__name__!r} "
                f"instance to cache {self.attrname!r} property."
            )
            raise TypeError(msg) from None
        val = cache.get(self.attrname, _NOT_FOUND)
        if val is _NOT_FOUND:
            val = self.func(instance)
            try:
                cache[self.attrname] = val
            except TypeError:
                msg = (
                    f"The '__dict__' attribute on {type(instance).__name__!r} instance "
                    f"does not support item assignment for caching {self.attrname!r} property."
                )
                raise TypeError(msg) from None
        return val

    __class_getitem__ = classmethod(GenericAlias)

def _warn_python_reduce_kwargs(py_reduce):
    @wraps(py_reduce)
    def wrapper(*args, **kwargs):
        if 'function' in kwargs or 'sequence' in kwargs:
            import os
            import warnings
            warnings.warn(
                'Calling functools.reduce with keyword arguments '
                '"function" or "sequence" '
                'is deprecated in Python 3.14 and will be '
                'forbidden in Python 3.16.',
                DeprecationWarning,
                skip_file_prefixes=(os.path.dirname(__file__),))
        return py_reduce(*args, **kwargs)
    return wrapper

reduce = _warn_python_reduce_kwargs(reduce)
del _warn_python_reduce_kwargs

# The import of the C accelerated version of reduce() has been moved
# here due to gh-121676. In Python 3.16, _warn_python_reduce_kwargs()
# should be removed and the import block should be moved back right
# after the definition of reduce().
try:
    from _functools import reduce
except ImportError:
    pass
`;

const reduceFunction = builtin('reduce', 'expected', 2, 3, reduce);
registerReduceVariant(reduceFunction);

registerModule(
  '_functools',
  () =>
    new Map<string, PyValue>([
      ['reduce', reduceFunction],
      ['partial', partialClass],
      ['Placeholder', Placeholder],
      ['_PlaceholderType', placeholderClass],
      ['cmp_to_key', builtin('cmp_to_key', 'one', 1, 1, cmpToKey)],
      ['_lru_cache_wrapper', cacheClass],
    ])
);
registerSourceModule('functools', SOURCE);
