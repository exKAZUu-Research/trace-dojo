import { defineAttribute } from '../attributeDescriptors';
import { pyRepr } from '../conversions';
import { builtin, method, redeclareMethods } from '../define';
import { DictStore } from '../dictStore';
import { pyHash } from '../hashing';
import { defineNew } from '../instances';
import { keyError } from '../items';
import { importModule, registerModule } from '../modules';
import { argument, checkArgs } from '../nativeArgs';
import { toIndex } from '../numbers';
import {
  callValue,
  getAttribute,
  getItem,
  isCallable,
  isTruthy,
  iterate,
  lookupSpecial,
  setItem,
  toArray,
  withRemaining,
} from '../objects';
import { binaryOp, compareOp, equals } from '../operators';
import { currentRuntime } from '../runtimeContext';
import { registerSourceModule, runModuleSource } from '../sourceModules';
import { containerRepr, dictBody, joinReprs, sequenceIndex, updateDict } from '../typeContainers';
import { newGenericAlias } from '../typeHints';
import {
  builtinClass,
  classOf,
  defineMethod,
  dictClass,
  dictItemsClass,
  dictKeysClass,
  dictValuesClass,
  iteratorClass,
  newTuple,
  None,
  NotImplemented,
  objectClass,
  propertyClass,
  pyError,
  typeClass,
  typeError,
  typeName,
  valueError,
} from '../types';
import {
  DONE,
  type Kwargs,
  PyBuiltinFunction,
  PyClass,
  PyDeque,
  PyDescriptor,
  PyDict,
  PyDictView,
  PyIterator,
  type PyValue,
} from '../values';
import { COLLECTIONS_USER_SOURCE } from './collectionsUserSource';
import { COUNTER_SOURCE } from './counterSource';
import { makeNamedTupleClass, namedTupleClass, namedtupleFunction } from './namedtuple';
import { updateOrderedDict } from './orderedDictUpdate';

// deque -------------------------------------------------------------------------------------------------------------

export const dequeClass = builtinClass('deque', undefined, true);
dequeClass.module = 'collections';
dequeClass.typeName = 'collections.deque';
dequeClass.dict.set('__module__', 'collections');

function parseDequeArgs(
  args: PyValue[],
  kwargs: Kwargs
): { iterable: PyValue | undefined; maxlen: number | undefined } {
  checkArgs(
    { qualified: 'deque', min: 0, max: 2, style: 'takes', keywords: ['iterable', 'maxlen'], named: 2 },
    args,
    kwargs
  );
  const iterable = argument(args, kwargs, 0, 'iterable');
  const maxlenValue = argument(args, kwargs, 1, 'maxlen') ?? None;
  let maxlen: number | undefined;
  if (maxlenValue !== None) {
    maxlen = Number(toIndex(maxlenValue, () => 'an integer is required'));
    if (maxlen < 0) throw valueError('maxlen must be non-negative');
  }
  return { iterable, maxlen };
}

function push(deque: PyDeque, item: PyValue, left: boolean): void {
  if (deque.maxlen === 0) {
    // Nothing is stored to charge, and an endless iterable must still end.
    currentRuntime().spend();
    return;
  }
  if (left) deque.appendLeft(item);
  else deque.append(item);
  if (deque.maxlen !== undefined && deque.length > deque.maxlen) {
    if (left) deque.popRight();
    else deque.popLeft();
  }
}

const dequeOf = (self: PyValue): PyDeque => self as PyDeque;

dequeClass.construct = (cls, args, kwargs) => {
  const { iterable, maxlen } = parseDequeArgs(args, kwargs);
  const deque = new PyDeque(cls, [], maxlen);
  if (iterable !== undefined) for (const item of toArray(iterable)) push(deque, item, false);
  return deque;
};
defineNew(dequeClass, (subtype) => new PyDeque(subtype, [], undefined));
defineMethod(dequeClass, '__init__', (self, args, kwargs) => {
  const { iterable, maxlen } = parseDequeArgs(args, kwargs);
  const deque = dequeOf(self);
  deque.editableItems.length = 0;
  deque.maxlen = maxlen;
  if (iterable !== undefined) for (const item of toArray(iterable)) push(deque, item, false);
  return None;
});

function dequeIndex(deque: PyDeque, key: PyValue): number {
  const index = toIndex(key, (value) => `sequence index must be integer, not '${typeName(value)}'`);
  const resolved = index < 0n ? index + BigInt(deque.length) : index;
  if (resolved < 0n || resolved >= BigInt(deque.length)) throw pyError('IndexError', 'deque index out of range');
  return Number(resolved);
}

/** Adds each item as the iterable yields it; a deque extended with itself reads its items first, as CPython does. */
function extendDeque(deque: PyDeque, iterable: PyValue, left: boolean): void {
  if (iterable === deque) {
    // oxlint-disable-next-line unicorn/prefer-spread -- A copy, not an iteration, is the point.
    const items = deque.items.slice();
    for (const item of items) push(deque, item, left);
    return;
  }
  const next = iterate(iterable);
  for (let item = next(); item !== DONE; item = next()) push(deque, item, left);
}

method(dequeClass, 'append', 'one', 1, 1, (self, [item]) => {
  push(dequeOf(self), item, false);
  return None;
});
method(dequeClass, 'appendleft', 'one', 1, 1, (self, [item]) => {
  push(dequeOf(self), item, true);
  return None;
});
method(dequeClass, 'extend', 'one', 1, 1, (self, [iterable]) => {
  extendDeque(dequeOf(self), iterable, false);
  return None;
});
method(dequeClass, 'extendleft', 'one', 1, 1, (self, [iterable]) => {
  extendDeque(dequeOf(self), iterable, true);
  return None;
});
method(dequeClass, 'pop', 'none', 0, 0, (self) => {
  if (dequeOf(self).length === 0) throw pyError('IndexError', 'pop from an empty deque');
  return dequeOf(self).popRight();
});
method(dequeClass, 'popleft', 'none', 0, 0, (self) => {
  if (dequeOf(self).length === 0) throw pyError('IndexError', 'pop from an empty deque');
  return dequeOf(self).popLeft();
});
const MAX_SSIZE = (1n << 63n) - 1n;
method(dequeClass, 'rotate', 'expected', 0, 1, (self, [steps]) => {
  const deque = dequeOf(self);
  const count = toIndex(steps ?? 1n);
  if (count > MAX_SSIZE || count < -MAX_SSIZE - 1n) {
    throw pyError('OverflowError', 'Python int too large to convert to C ssize_t');
  }
  if (deque.length > 0) deque.rotate(Number(count % BigInt(deque.length)));
  return None;
});
method(dequeClass, 'clear', 'none', 0, 0, (self) => {
  dequeOf(self).editableItems.length = 0;
  return None;
});
method(dequeClass, 'count', 'one', 1, 1, (self, [item]) =>
  BigInt(dequeOf(self).items.filter((each) => equals(each, item)).length)
);
method(dequeClass, 'index', 'expected', 1, 3, (self, [item, start, stop]) => {
  const index = sequenceIndex(dequeOf(self).items, item, start, stop);
  if (index === -1) throw valueError('deque.index(x): x not in deque');
  return BigInt(index);
});
method(dequeClass, 'insert', 'expected', 2, 2, (self, [index, item]) => {
  const deque = dequeOf(self);
  if (deque.maxlen !== undefined && deque.items.length >= deque.maxlen)
    throw pyError('IndexError', 'deque already at its maximum size');
  let position = Number(toIndex(index));
  if (position < 0) position = Math.max(0, position + deque.items.length);
  deque.splice(Math.min(position, deque.items.length), 0, [item]);
  return None;
});
method(dequeClass, 'remove', 'one', 1, 1, (self, [item]) => {
  const items = dequeOf(self).items;
  const index = items.findIndex((each) => equals(each, item));
  currentRuntime().scan(index === -1 ? items.length : index + 1);
  if (index === -1) throw valueError('deque.remove(x): x not in deque');
  dequeOf(self).removeRange(index, 1);
  return None;
});
method(dequeClass, 'reverse', 'none', 0, 0, (self) => {
  const items = dequeOf(self).editableItems;
  currentRuntime().scan(items.length);
  items.reverse();
  return None;
});

function copyDeque(deque: PyDeque): PyDeque {
  if (deque.cls === dequeClass) return new PyDeque(dequeClass, [...deque.items], deque.maxlen);
  const result = callValue(deque.cls, deque.maxlen === undefined ? [deque] : [deque, BigInt(deque.maxlen)]);
  if (!(result instanceof PyDeque)) throw typeError(`${deque.cls.name}() must return a deque, not ${typeName(result)}`);
  return result;
}

function isIndex(value: PyValue): boolean {
  return typeof value === 'bigint' || typeof value === 'boolean' || lookupSpecial(value, '__index__') !== undefined;
}

/** Repeats a deque in place, computing what a bounded one keeps instead of appending every round. */
function repeatDeque(deque: PyDeque, countValue: PyValue): void {
  const count = toIndex(countValue);
  if (count >= 1n << 63n || count < -(1n << 63n)) {
    throw pyError('OverflowError', "cannot fit 'int' into an index-sized integer");
  }
  const { items } = deque;
  const size = BigInt(items.length);
  if (count <= 0n || size === 0n) {
    deque.editableItems.length = 0;
    return;
  }
  const total = size * count;
  const kept = deque.maxlen !== undefined && BigInt(deque.maxlen) < total ? BigInt(deque.maxlen) : total;
  currentRuntime().ensureRoom(Number(kept - size));
  const skipped = total - kept;
  const repeated: PyValue[] = [];
  for (let index = 0n; index < kept; index++) repeated.push(items[Number((skipped + index) % size)]);
  deque.splice(0, items.length, repeated);
}

method(dequeClass, 'copy', 'none', 0, 0, (self) => copyDeque(dequeOf(self)));
method(dequeClass, '__copy__', 'none', 0, 0, (self) => copyDeque(dequeOf(self)));
method(dequeClass, '__len__', 'none', 0, 0, (self) => BigInt(dequeOf(self).length));
method(dequeClass, '__bool__', 'none', 0, 0, (self) => dequeOf(self).length > 0);
method(dequeClass, '__add__', 'one', 1, 1, (self, [other]) => {
  if (!(other instanceof PyDeque)) throw typeError(`can only concatenate deque (not "${typeName(other)}") to deque`);
  const result = copyDeque(dequeOf(self));
  // The items are copied first, as `d + d` must not see its own appends.
  // oxlint-disable-next-line unicorn/prefer-spread -- A copy, not an iteration, is the point.
  const items = other.items.slice();
  for (const item of items) push(result, item, false);
  return result;
});
method(dequeClass, '__iadd__', 'one', 1, 1, (self, [other]) => {
  extendDeque(dequeOf(self), other, false);
  return self;
});
for (const name of ['__mul__', '__rmul__']) {
  method(dequeClass, name, 'one', 1, 1, (self, [count]) => {
    if (!isIndex(count)) return NotImplemented;
    const result = copyDeque(dequeOf(self));
    repeatDeque(result, count);
    return result;
  });
}
method(dequeClass, '__imul__', 'one', 1, 1, (self, [count]) => {
  if (!isIndex(count)) return NotImplemented;
  repeatDeque(dequeOf(self), count);
  return self;
});
method(dequeClass, '__class_getitem__', 'one', 1, 1, (owner, [key]) => newGenericAlias(owner, key), {
  binding: 'class',
});
method(dequeClass, '__getitem__', 'one', 1, 1, (self, [key]) => dequeOf(self).at(dequeIndex(dequeOf(self), key)));
method(dequeClass, '__setitem__', 'expected', 2, 2, (self, [key, value]) => {
  dequeOf(self).editableItems[dequeIndex(dequeOf(self), key)] = value;
  return None;
});
method(dequeClass, '__delitem__', 'one', 1, 1, (self, [key]) => {
  dequeOf(self).removeRange(dequeIndex(dequeOf(self), key), 1);
  return None;
});
method(dequeClass, '__contains__', 'one', 1, 1, (self, [item]) =>
  dequeOf(self).items.some((each) => equals(each, item))
);
method(dequeClass, '__iter__', 'none', 0, 0, (self) => dequeIterator(self, false));
method(dequeClass, '__reversed__', 'none', 0, 0, (self) => dequeIterator(self, true));
method(dequeClass, '__repr__', 'none', 0, 0, (self) => {
  const deque = dequeOf(self);
  return containerRepr(deque, '[...]', () => {
    const body = `[${joinReprs(deque.items)}]`;
    return deque.maxlen === undefined
      ? `${deque.cls.name}(${body})`
      : `${deque.cls.name}(${body}, maxlen=${deque.maxlen})`;
  });
});

/** Compares as CPython's deque_richcompare does: by the first pair of unequal items, then by length. */
function compareDeques(
  operator: '==' | '!=' | '<' | '<=' | '>' | '>=',
  a: readonly PyValue[],
  b: readonly PyValue[]
): boolean {
  if (a === b) return operator === '==' || operator === '<=' || operator === '>=';
  if (a.length !== b.length && (operator === '==' || operator === '!=')) return operator === '!=';
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    currentRuntime().spend();
    if (!equals(a[index], b[index])) return isTruthy(compareOp(operator, a[index], b[index]));
  }
  return isTruthy(compareOp(operator, BigInt(a.length), BigInt(b.length)));
}

for (const [name, operator] of [
  ['__eq__', '=='],
  ['__ne__', '!='],
  ['__lt__', '<'],
  ['__le__', '<='],
  ['__gt__', '>'],
  ['__ge__', '>='],
] as const) {
  method(dequeClass, name, 'one', 1, 1, (self, [other]) =>
    other instanceof PyDeque ? compareDeques(operator, dequeOf(self).items, other.items) : NotImplemented
  );
}
dequeClass.dict.set(
  'maxlen',
  new PyDescriptor(
    propertyClass,
    new PyBuiltinFunction(builtinClass('getter'), 'maxlen', ([self]) => {
      const { maxlen } = dequeOf(self);
      return maxlen === undefined ? None : BigInt(maxlen);
    })
  )
);
dequeClass.dict.set('__hash__', None);

// defaultdict -------------------------------------------------------------------------------------------------------

export const defaultdictClass = new PyClass('defaultdict', [dictClass], typeClass);
defaultdictClass.mro = [defaultdictClass, ...dictClass.mro];
defaultdictClass.module = 'collections';
defaultdictClass.typeName = 'collections.defaultdict';
defaultdictClass.layout = { base: 'native' };
defaultdictClass.isBaseType = true;

function initDefaultdict(dict: PyDict, args: PyValue[], kwargs: Kwargs): void {
  const factory = args[0] ?? None;
  if (factory !== None && !isCallable(factory)) throw typeError('first argument must be callable or None');
  dict.defaultFactory = factory === None ? undefined : factory;
  if (args.length > 1) updateDict(dict, args[1]);
  if (args.length > 2) throw typeError(`defaultdict expected at most 2 arguments, got ${args.length}`);
  for (const [key, value] of kwargs ?? []) dict.store.set(key, value);
}

defaultdictClass.construct = (cls, args, kwargs) => {
  const dict = new PyDict(cls, new DictStore());
  initDefaultdict(dict, args, kwargs);
  return dict;
};
redeclareMethods(defaultdictClass, objectClass, ['__getattribute__']);
defineMethod(defaultdictClass, '__init__', (self, args, kwargs) => {
  initDefaultdict(self as PyDict, args, kwargs);
  return None;
});
method(defaultdictClass, '__repr__', 'none', 0, 0, (self) => {
  const dict = self as PyDict;
  return containerRepr(
    dict,
    '...',
    () => `${dict.cls.name}(${pyRepr(dict.defaultFactory ?? None)}, ${dictBody(dict)})`
  );
});
method(defaultdictClass, '__missing__', 'one', 1, 1, (self, [key]) => currentRuntime().missingKey(self as PyDict, key));
for (const name of ['copy', '__copy__']) {
  method(defaultdictClass, name, 'none', 0, 0, (self) =>
    callValue(classOf(self), [(self as PyDict).defaultFactory ?? None, self])
  );
}
method(defaultdictClass, '__class_getitem__', 'one', 1, 1, (owner, [key]) => newGenericAlias(owner, key), {
  binding: 'class',
});
defaultdictClass.dict.set('__module__', 'collections');
defineAttribute(defaultdictClass, 'default_factory', (self) => (self as PyDict).defaultFactory ?? None, {
  kind: 'member',
  set: (self, value) => {
    (self as PyDict).defaultFactory = value === undefined || value === None ? undefined : value;
  },
});

// OrderedDict -------------------------------------------------------------------------------------------------------

export const orderedDictClass = new PyClass('OrderedDict', [dictClass], typeClass);
orderedDictClass.mro = [orderedDictClass, ...dictClass.mro];
orderedDictClass.module = 'collections';
orderedDictClass.typeName = 'collections.OrderedDict';
orderedDictClass.layout = { base: 'native' };
orderedDictClass.isBaseType = true;
orderedDictClass.flags.isOrderedDict = true;
orderedDictClass.dict.set('__module__', 'collections');
orderedDictClass.construct = (cls, args, kwargs) => {
  if (args.length > 1) throw typeError(`expected at most 1 argument, got ${args.length}`);
  const dict = new PyDict(cls, new DictStore(true));
  updateOrderedDict(dict, args, kwargs);
  return dict;
};
defineNew(orderedDictClass, (subtype) => new PyDict(subtype, new DictStore(true)));
defineMethod(orderedDictClass, '__init__', (self, args, kwargs) => {
  if (args.length > 1) throw typeError(`expected at most 1 argument, got ${args.length}`);
  updateOrderedDict(self, args, kwargs);
  return None;
});
redeclareMethods(orderedDictClass, dictClass, ['clear', 'pop', 'setdefault', '__iter__', '__reversed__']);
for (const [name, base] of [
  ['keys', dictKeysClass],
  ['values', dictValuesClass],
  ['items', dictItemsClass],
] as const) {
  // CPython's OrderedDict views are their own subclasses of the dict views, which name them in their reprs.
  const viewClass = builtinClass(`odict_${name}`, base);
  method(orderedDictClass, name, 'none', 0, 0, (self) => new PyDictView(viewClass, self as PyDict, name));
}
defineMethod(orderedDictClass, 'update', (self, args, kwargs) => {
  updateOrderedDict(self, args, kwargs);
  return None;
});
method(orderedDictClass, '__repr__', 'none', 0, 0, (self) => {
  const dict = self as PyDict;
  if (dict.store.size === 0) return `${dict.cls.name}()`;
  return containerRepr(dict, '...', () => `${dict.cls.name}(${dictBody(dict)})`);
});
method(
  orderedDictClass,
  'move_to_end',
  'takes',
  1,
  2,
  (self, args, kwargs) => {
    const dict = self as PyDict;
    const key = argument(args, kwargs, 0, 'key') as PyValue;
    const entry = dict.store.lookup(key, pyHash(key));
    if (!entry) throw keyError(key);
    dict.store.moveToEnd(entry, isTruthy(argument(args, kwargs, 1, 'last') ?? true));
    return None;
  },
  { keywords: ['key', 'last'], named: 2 }
);
method(
  orderedDictClass,
  'popitem',
  'takes',
  0,
  1,
  (self, args, kwargs) => {
    const dict = self as PyDict;
    const last = isTruthy(argument(args, kwargs, 0, 'last') ?? true);
    const entry = last ? dict.store.last() : dict.store.first();
    if (!entry) throw keyError('dictionary is empty');
    dict.store.remove(entry);
    return newTuple([entry.key, entry.value]);
  },
  { keywords: ['last'], named: 1 }
);

function orderedDictEquals(self: PyDict, other: PyValue): PyValue {
  if (!(other instanceof PyDict)) return NotImplemented;
  const a = self.store.ordered();
  const b = other.store.ordered();
  if (a.length !== b.length) return false;
  if (other.cls.isSubclassOf(orderedDictClass)) {
    return a.every((entry, index) => equals(entry.key, b[index].key) && equals(entry.value, b[index].value));
  }
  return a.every((entry) => {
    const found = other.store.lookup(entry.key);
    return found !== undefined && equals(found.value, entry.value);
  });
}

method(orderedDictClass, '__eq__', 'one', 1, 1, (self, [other]) => orderedDictEquals(self as PyDict, other));
// odict_richcompare answers `!=` as the negation of its order-sensitive `==`, where dict's would ignore the order.
method(orderedDictClass, '__ne__', 'one', 1, 1, (self, [other]) => {
  const equal = orderedDictEquals(self as PyDict, other);
  return equal === NotImplemented ? equal : !equal;
});

function unionLike(like: PyDict, first: PyDict, second: PyDict): PyValue {
  const isDefault = like.cls.isSubclassOf(defaultdictClass);
  const result = callValue(like.cls, isDefault ? [like.defaultFactory ?? None, first] : [first]);
  if (isDefault) updateDict(result as PyDict, second);
  else updateOrderedDict(result, [second], undefined);
  return result;
}

method(orderedDictClass, 'copy', 'none', 0, 0, (self) => {
  const source = self as PyDict;
  const result = callValue(source.cls, []);
  const version = source.store.version;
  for (const entry of source.store.liveEntries()) {
    if (source.cls === orderedDictClass) (result as PyDict).store.set(entry.key, entry.value, entry.hash);
    else setItem(result, entry.key, getItem(source, entry.key));
    if (source.store.version !== version) throw pyError('RuntimeError', 'OrderedDict mutated during iteration');
  }
  return result;
});

// CPython's defaultdict and OrderedDict define `|` themselves, which keeps their type where dict gives a plain dict.
for (const cls of [defaultdictClass, orderedDictClass]) {
  method(cls, '__or__', 'one', 1, 1, (self, [other]) =>
    other instanceof PyDict ? unionLike(self as PyDict, self as PyDict, other) : NotImplemented
  );
  method(cls, '__ror__', 'one', 1, 1, (self, [other]) =>
    other instanceof PyDict ? unionLike(self as PyDict, other, self as PyDict) : NotImplemented
  );
}

registerModule('collections', (runtime, namespace) => {
  for (const [name, value] of [
    ['deque', dequeClass],
    // CPython imports heapq into collections only when Counter.most_common needs it.
    ['heapq', None],
    [
      '_count_elements',
      builtin('_count_elements', 'expected', 2, 2, ([mapping, iterable]) => {
        const fast =
          mapping instanceof PyDict &&
          mapping.cls.lookup('get') === dictClass.dict.get('get') &&
          mapping.cls.lookup('__setitem__') === dictClass.dict.get('__setitem__');
        const get = fast ? undefined : getAttribute(mapping, 'get');
        const next = iterate(iterable);
        for (let key = next(); key !== DONE; key = next()) {
          if (fast) {
            const hash = pyHash(key);
            const value = mapping.store.lookup(key, hash)?.value ?? 0n;
            mapping.store.set(key, binaryOp('+', value, 1n), hash);
          } else {
            setItem(mapping, key, binaryOp('+', callValue(get as PyValue, [key, 0n]), 1n));
          }
        }
        return None;
      }),
    ],
    ['defaultdict', defaultdictClass],
    ['OrderedDict', orderedDictClass],
    ['namedtuple', namedtupleFunction],
  ] as const) {
    namespace.set(name, value);
  }
  runModuleSource(runtime, namespace, COUNTER_SOURCE);
  // The classes CPython writes in Python import collections.abc, which reads the names above.
  const written = importModule(runtime, '_collections_user').dict;
  for (const name of ['ChainMap', 'UserDict', 'UserList', 'UserString'])
    namespace.set(name, written.get(name) as PyValue);
  return new Map();
});

registerSourceModule('_collections_user', COLLECTIONS_USER_SOURCE);

export { makeNamedTupleClass, namedTupleClass };

/**
 * An iterator over a deque, forward or reversed, which fails once the deque changes size; a reversed one stays
 * exhausted after failing, as CPython's does.
 */
function dequeIterator(self: PyValue, reversed: boolean): PyIterator {
  const deque = dequeOf(self);
  const length = deque.length;
  let taken = 0;
  return new PyIterator(
    iteratorClass(reversed ? 'collections._deque_reverse_iterator' : 'collections._deque_iterator'),
    withRemaining(
      () => {
        if (reversed && taken === length) return DONE;
        if (deque.length !== length) {
          if (reversed) taken = length;
          throw pyError('RuntimeError', 'deque mutated during iteration');
        }
        if (taken === length) return DONE;
        return deque.at(reversed ? length - 1 - taken++ : taken++);
      },
      () => (deque.length === length ? length - taken : 0)
    ),
    () => [deque]
  );
}
