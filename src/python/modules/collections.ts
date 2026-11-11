// code-gauge-allow-file fileNcss 428 -- The collections types and the methods of each belong together.
import { pyRepr } from '../conversions';
import { builtin, method } from '../define';
import { DictStore } from '../dictStore';
import { mappingEntries, storeKey } from '../expressionEvaluator';
import { defineNew } from '../instances';
import { keyError } from '../items';
import { registerModule } from '../modules';
import { argument, checkArgs } from '../nativeArgs';
import { toIndex } from '../numbers';
import { callValue, getIterator, isCallable, isTruthy, iterate, lookupSpecial, toArray } from '../objects';
import { binaryOp, equals, keysEqual, lessThan } from '../operators';
import { currentRuntime } from '../runtimeContext';
import { containerRepr, dictBody, updateDict } from '../typeContainers';
import {
  builtinClass,
  defineMethod,
  dictClass,
  iteratorClass,
  newDict,
  newList,
  newTuple,
  None,
  NotImplemented,
  propertyClass,
  pyError,
  tupleClass,
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
  PyIterator,
  PyObject,
  PyTuple,
  type PyValue,
} from '../values';

// deque -------------------------------------------------------------------------------------------------------------

export const dequeClass = builtinClass('deque', undefined, true);
dequeClass.module = 'collections';
dequeClass.typeName = 'collections.deque';
dequeClass.construct = (cls, args, kwargs) => {
  checkArgs({ qualified: 'deque', min: 0, max: 2, style: 'takes', keywords: ['iterable', 'maxlen'] }, args, kwargs);
  const iterable = argument(args, kwargs, 0, 'iterable');
  const maxlenValue = argument(args, kwargs, 1, 'maxlen') ?? None;
  let maxlen: number | undefined;
  if (maxlenValue !== None) {
    maxlen = Number(toIndex(maxlenValue, () => 'an integer is required'));
    if (maxlen < 0) throw valueError('maxlen must be non-negative');
  }
  const deque = new PyDeque(cls, [], maxlen);
  if (iterable !== undefined) for (const item of toArray(iterable)) push(deque, item, false);
  return deque;
};
const dequeOf = (self: PyValue): PyDeque => self as PyDeque;
defineNew(dequeClass, (subtype) => new PyDeque(subtype, [], undefined));
defineMethod(dequeClass, '__init__', (self, args, kwargs) => {
  const filled = (dequeClass.construct as NonNullable<PyClass['construct']>)(dequeClass, args, kwargs) as PyDeque;
  dequeOf(self).items = filled.items;
  dequeOf(self).maxlen = filled.maxlen;
  return None;
});

function push(deque: PyDeque, item: PyValue, left: boolean): void {
  currentRuntime().allocate(1);
  if (deque.maxlen === 0) return;
  if (left) deque.items.unshift(item);
  else deque.items.push(item);
  if (deque.maxlen !== undefined && deque.items.length > deque.maxlen) {
    if (left) deque.items.pop();
    else deque.items.shift();
  }
}

function dequeIndex(deque: PyDeque, key: PyValue): number {
  const index = toIndex(key, (value) => `sequence index must be integer, not '${typeName(value)}'`);
  const resolved = index < 0n ? index + BigInt(deque.items.length) : index;
  if (resolved < 0n || resolved >= BigInt(deque.items.length)) throw pyError('IndexError', 'deque index out of range');
  return Number(resolved);
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
  for (const item of toArray(iterable)) push(dequeOf(self), item, false);
  return None;
});
method(dequeClass, 'extendleft', 'one', 1, 1, (self, [iterable]) => {
  for (const item of toArray(iterable)) push(dequeOf(self), item, true);
  return None;
});
method(dequeClass, 'pop', 'none', 0, 0, (self) => {
  if (dequeOf(self).items.length === 0) throw pyError('IndexError', 'pop from an empty deque');
  return dequeOf(self).items.pop() as PyValue;
});
method(dequeClass, 'popleft', 'none', 0, 0, (self) => {
  if (dequeOf(self).items.length === 0) throw pyError('IndexError', 'pop from an empty deque');
  return dequeOf(self).items.shift() as PyValue;
});
method(dequeClass, 'rotate', 'expected', 0, 1, (self, [steps]) => {
  const { items } = dequeOf(self);
  if (items.length === 0) return None;
  const count = Number(toIndex(steps ?? 1n)) % items.length;
  const shift = (count + items.length) % items.length;
  if (shift) items.unshift(...items.splice(items.length - shift, shift));
  return None;
});
method(dequeClass, 'clear', 'none', 0, 0, (self) => {
  dequeOf(self).items.length = 0;
  return None;
});
method(dequeClass, 'count', 'one', 1, 1, (self, [item]) =>
  BigInt(dequeOf(self).items.filter((each) => equals(each, item)).length)
);
method(dequeClass, 'index', 'expected', 1, 3, (self, [item]) => {
  const index = dequeOf(self).items.findIndex((each) => equals(each, item));
  if (index === -1) throw valueError('deque.index(x): x not in deque');
  return BigInt(index);
});
method(dequeClass, 'insert', 'expected', 2, 2, (self, [index, item]) => {
  const deque = dequeOf(self);
  if (deque.maxlen !== undefined && deque.items.length >= deque.maxlen)
    throw pyError('IndexError', 'deque already at its maximum size');
  let position = Number(toIndex(index));
  if (position < 0) position = Math.max(0, position + deque.items.length);
  deque.items.splice(Math.min(position, deque.items.length), 0, item);
  return None;
});
method(dequeClass, 'remove', 'one', 1, 1, (self, [item]) => {
  const { items } = dequeOf(self);
  const index = items.findIndex((each) => equals(each, item));
  if (index === -1) throw valueError('deque.remove(x): x not in deque');
  items.splice(index, 1);
  return None;
});
method(dequeClass, 'reverse', 'none', 0, 0, (self) => {
  dequeOf(self).items.reverse();
  return None;
});
method(
  dequeClass,
  'copy',
  'none',
  0,
  0,
  (self) => new PyDeque(dequeOf(self).cls, [...dequeOf(self).items], dequeOf(self).maxlen)
);
method(dequeClass, '__len__', 'none', 0, 0, (self) => BigInt(dequeOf(self).items.length));
method(dequeClass, '__bool__', 'none', 0, 0, (self) => dequeOf(self).items.length > 0);
method(dequeClass, '__getitem__', 'one', 1, 1, (self, [key]) => dequeOf(self).items[dequeIndex(dequeOf(self), key)]);
method(dequeClass, '__setitem__', 'expected', 2, 2, (self, [key, value]) => {
  dequeOf(self).items[dequeIndex(dequeOf(self), key)] = value;
  return None;
});
method(dequeClass, '__delitem__', 'one', 1, 1, (self, [key]) => {
  dequeOf(self).items.splice(dequeIndex(dequeOf(self), key), 1);
  return None;
});
method(dequeClass, '__contains__', 'one', 1, 1, (self, [item]) =>
  dequeOf(self).items.some((each) => equals(each, item))
);
method(dequeClass, '__iter__', 'none', 0, 0, (self) => {
  const deque = dequeOf(self);
  let index = 0;
  const length = deque.items.length;
  return new PyIterator(
    iteratorClass('collections._deque_iterator'),
    () => {
      if (deque.items.length !== length) throw pyError('RuntimeError', 'deque mutated during iteration');
      return index < deque.items.length ? deque.items[index++] : DONE;
    },
    () => [deque]
  );
});
method(dequeClass, '__reversed__', 'none', 0, 0, (self) => {
  const items = [...dequeOf(self).items].toReversed();
  let index = 0;
  return new PyIterator(
    iteratorClass('collections._deque_reverse_iterator'),
    () => (index < items.length ? items[index++] : DONE),
    () => items
  );
});
method(dequeClass, '__repr__', 'none', 0, 0, (self) => {
  const deque = dequeOf(self);
  return containerRepr(deque, '[...]', () => {
    const body = `[${deque.items.map((item) => pyRepr(item)).join(', ')}]`;
    return deque.maxlen === undefined
      ? `${deque.cls.name}(${body})`
      : `${deque.cls.name}(${body}, maxlen=${deque.maxlen})`;
  });
});
method(dequeClass, '__eq__', 'one', 1, 1, (self, [other]) => {
  if (!(other instanceof PyDeque)) return NotImplemented;
  const a = dequeOf(self).items;
  return a.length === other.items.length && a.every((item, index) => equals(item, other.items[index]));
});
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

// Counter -----------------------------------------------------------------------------------------------------------

export const counterClass = new PyClass('Counter', [dictClass], typeClass);
counterClass.mro = [counterClass, ...dictClass.mro];
counterClass.module = 'collections';
counterClass.layout = { base: 'native' };
counterClass.isBaseType = true;
counterClass.construct = (cls, args, kwargs) => {
  checkArgs(
    { qualified: 'Counter', min: 0, max: 1, style: 'expected', keywords: [...(kwargs?.keys() ?? [])] },
    args,
    kwargs
  );
  const counter = new PyDict(cls, new DictStore());
  countInto(counter, args[0], kwargs, 1n);
  return counter;
};

defineMethod(counterClass, '__init__', (self, args, kwargs) => {
  checkArgs(
    { qualified: 'Counter', min: 0, max: 1, style: 'expected', keywords: [...(kwargs?.keys() ?? [])] },
    args,
    kwargs
  );
  countInto(self as PyDict, args[0], kwargs, 1n);
  return None;
});

function countInto(counter: PyDict, source: PyValue | undefined, kwargs: Kwargs, sign: bigint): void {
  const add = (key: PyValue, amount: PyValue): void => {
    const current = counter.store.get(key) ?? 0n;
    counter.store.set(key, binaryOp(sign === 1n ? '+' : '-', current, amount));
  };
  if (source !== undefined && source !== None) {
    if (source instanceof PyDict || lookupSpecial(source, 'keys') !== undefined) {
      for (const [key, value] of mappingEntries(source)) add(key, value);
    } else {
      const next = iterate(source);
      for (let item = next(); item !== DONE; item = next()) {
        currentRuntime().spend();
        add(item, 1n);
      }
    }
  }
  for (const [key, value] of kwargs ?? []) add(key, value);
}

const counterOf = (self: PyValue): PyDict => self as PyDict;

/** The items of a Counter from the most common, ties in insertion order. */
function mostCommon(counter: PyDict): [PyValue, PyValue][] {
  const entries: [PyValue, PyValue][] = counter.store.ordered().map((entry) => [entry.key, entry.value]);
  return entries
    .map((entry, index) => ({ entry, index }))
    .toSorted((a, b) => {
      if (lessThan(b.entry[1], a.entry[1])) return -1;
      if (lessThan(a.entry[1], b.entry[1])) return 1;
      return a.index - b.index;
    })
    .map(({ entry }) => entry);
}

method(counterClass, 'most_common', 'expected', 0, 1, (self, [count]) => {
  let items = mostCommon(counterOf(self));
  if (count !== undefined && count !== None) items = items.slice(0, Math.max(0, Number(toIndex(count))));
  return newList(items.map((item) => newTuple(item)));
});
method(counterClass, 'elements', 'none', 0, 0, (self) => {
  const items: PyValue[] = [];
  for (const entry of counterOf(self).store.ordered()) {
    const count = typeof entry.value === 'bigint' ? entry.value : 0n;
    for (let index = 0n; index < count; index++) items.push(entry.key);
  }
  let position = 0;
  return new PyIterator(
    iteratorClass('itertools.chain'),
    () => (position < items.length ? items[position++] : DONE),
    () => items
  );
});
counterClass.dict.set(
  'update',
  new PyBuiltinFunction(
    builtinClass('method_descriptor'),
    'update',
    (args, kwargs) => {
      countInto(counterOf(args[0]), args[1], kwargs, 1n);
      return None;
    },
    undefined,
    'method',
    'Counter'
  )
);
counterClass.dict.set(
  'subtract',
  new PyBuiltinFunction(
    builtinClass('method_descriptor'),
    'subtract',
    (args, kwargs) => {
      countInto(counterOf(args[0]), args[1], kwargs, -1n);
      return None;
    },
    undefined,
    'method',
    'Counter'
  )
);
method(counterClass, 'total', 'none', 0, 0, (self) => {
  let total: PyValue = 0n;
  for (const entry of counterOf(self).store.ordered()) total = binaryOp('+', total, entry.value);
  return total;
});
method(counterClass, '__repr__', 'none', 0, 0, (self) => {
  const counter = counterOf(self);
  if (counter.store.size === 0) return `${counter.cls.name}()`;
  return containerRepr(counter, '...', () => {
    const ordered = newDict(mostCommon(counter));
    return `${counter.cls.name}(${dictBody(ordered)})`;
  });
});
for (const [name, combine] of [
  ['__add__', (a: bigint, b: bigint) => a + b],
  ['__sub__', (a: bigint, b: bigint) => a - b],
  ['__or__', (a: bigint, b: bigint) => (a > b ? a : b)],
  ['__and__', (a: bigint, b: bigint) => (a < b ? a : b)],
] as const) {
  method(counterClass, name, 'one', 1, 1, (self, [other]) => {
    if (!(other instanceof PyDict) || !other.cls.isSubclassOf(counterClass)) return NotImplemented;
    const result = new PyDict(counterClass, new DictStore());
    const keys = counterOf(self)
      .store.ordered()
      .map((entry) => entry.key);
    for (const entry of other.store.ordered()) if (!keys.some((key) => keysEqual(key, entry.key))) keys.push(entry.key);
    for (const key of keys) {
      const a = counterOf(self).store.get(key) ?? 0n;
      const b = other.store.get(key) ?? 0n;
      const isAnd = name === '__and__';
      if (isAnd && (counterOf(self).store.get(key) === undefined || other.store.get(key) === undefined)) continue;
      const value = combine(a as bigint, b as bigint);
      if (value > 0n) result.store.set(key, value);
    }
    return result;
  });
}

// defaultdict -------------------------------------------------------------------------------------------------------

export const defaultdictClass = new PyClass('defaultdict', [dictClass], typeClass);
defaultdictClass.mro = [defaultdictClass, ...dictClass.mro];
defaultdictClass.module = 'collections';
defaultdictClass.typeName = 'collections.defaultdict';
defaultdictClass.layout = { base: 'native' };
defaultdictClass.isBaseType = true;
defaultdictClass.construct = (cls, args, kwargs) => {
  const factory = args[0] ?? None;
  if (factory !== None && !isCallable(factory)) throw typeError('first argument must be callable or None');
  const dict = new PyDict(cls, new DictStore(), factory);
  if (args.length > 1) updateDict(dict, args[1]);
  if (args.length > 2) throw typeError(`defaultdict expected at most 2 arguments, got ${args.length}`);
  for (const [key, value] of kwargs ?? []) dict.store.set(key, value);
  return dict;
};
defineNew(defaultdictClass, (subtype) => new PyDict(subtype, new DictStore()));
defineMethod(defaultdictClass, '__init__', (self, args, kwargs) => {
  const filled = (defaultdictClass.construct as NonNullable<PyClass['construct']>)(defaultdictClass, args, kwargs);
  const dict = self as PyDict;
  dict.defaultFactory = (filled as PyDict).defaultFactory;
  for (const entry of (filled as PyDict).store.ordered()) dict.store.set(entry.key, entry.value);
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
defaultdictClass.dict.set(
  'default_factory',
  new PyDescriptor(
    propertyClass,
    new PyBuiltinFunction(
      builtinClass('getter'),
      'default_factory',
      ([self]) => (self as PyDict).defaultFactory ?? None
    )
  )
);

// OrderedDict -------------------------------------------------------------------------------------------------------

export const orderedDictClass = new PyClass('OrderedDict', [dictClass], typeClass);
orderedDictClass.mro = [orderedDictClass, ...dictClass.mro];
orderedDictClass.module = 'collections';
orderedDictClass.typeName = 'collections.OrderedDict';
orderedDictClass.layout = { base: 'native' };
orderedDictClass.isBaseType = true;
orderedDictClass.construct = (cls, args, kwargs) => {
  const dict = new PyDict(cls, new DictStore());
  if (args.length > 0) updateDict(dict, args[0]);
  for (const [key, value] of kwargs ?? []) dict.store.set(key, value);
  return dict;
};
defineNew(orderedDictClass, (subtype) => new PyDict(subtype, new DictStore()));
defineMethod(orderedDictClass, '__init__', (self, args, kwargs) => {
  if (args.length > 1) throw typeError(`expected at most 1 argument, got ${args.length}`);
  if (args.length > 0) updateDict(self as PyDict, args[0]);
  for (const [key, value] of kwargs ?? []) (self as PyDict).store.set(key, value);
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
    const entry = dict.store.lookup(args[0]);
    if (!entry) throw keyError(args[0]);
    dict.store.moveToEnd(entry, isTruthy(argument(args, kwargs, 1, 'last') ?? true));
    return None;
  },
  { keywords: ['last'] }
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
  { keywords: ['last'] }
);
method(orderedDictClass, '__eq__', 'one', 1, 1, (self, [other]) => {
  if (!(other instanceof PyDict)) return NotImplemented;
  const a = (self as PyDict).store.ordered();
  const b = other.store.ordered();
  if (a.length !== b.length) return false;
  if (other.cls.isSubclassOf(orderedDictClass)) {
    return a.every((entry, index) => equals(entry.key, b[index].key) && equals(entry.value, b[index].value));
  }
  return a.every((entry) => {
    const found = other.store.lookup(entry.key);
    return found !== undefined && equals(found.value, entry.value);
  });
});

// namedtuple --------------------------------------------------------------------------------------------------------

// code-gauge-allow functionNcss 35 -- Follows collections.namedtuple's argument handling.
function namedtuple(args: PyValue[], kwargs: Kwargs): PyValue {
  checkArgs(
    {
      qualified: 'namedtuple',
      min: 2,
      max: 2,
      style: 'takes',
      keywords: ['typename', 'field_names', 'defaults', 'rename', 'module'],
    },
    args,
    kwargs
  );
  const typename = argument(args, kwargs, 0, 'typename');
  const fieldNames = argument(args, kwargs, 1, 'field_names');
  if (typeof typename !== 'string') throw typeError('namedtuple() typename must be a string');
  const fields =
    typeof fieldNames === 'string'
      ? fieldNames.replaceAll(',', ' ').split(/\s+/).filter(Boolean)
      : toArray(fieldNames ?? None).map(String);
  for (const name of [typename, ...fields]) {
    if (!/^[\p{XID_Start}_][\p{XID_Continue}]*$/u.test(name)) {
      throw valueError(`Type names and field names must be valid identifiers: ${pyRepr(name)}`);
    }
    if (name.startsWith('_') && name !== typename)
      throw valueError(`Field names cannot start with an underscore: ${pyRepr(name)}`);
  }
  const seen = new Set<string>();
  for (const name of fields) {
    if (seen.has(name)) throw valueError(`Encountered duplicate field name: ${pyRepr(name)}`);
    seen.add(name);
  }
  const defaults = toArray(kwargs?.get('defaults') ?? newTuple([]));
  if (defaults.length > fields.length) throw typeError('Got more default values than field names');
  const cls = new PyClass(typename, [tupleClass], typeClass);
  cls.mro = [cls, ...tupleClass.mro];
  cls.isBuiltin = false;
  cls.module = '__main__';
  cls.layout = { base: 'native' };
  cls.construct = (tupleType, values, keywords) => newNamedTuple(tupleType, fields, defaults, values, keywords);
  cls.slotNames = new Set();
  defineNew(cls, cls.construct);
  cls.dict.set('_fields', newTuple(fields));
  const defaulted = fields.slice(fields.length - defaults.length);
  cls.dict.set('_field_defaults', newDict(defaulted.map((name, index) => [name, defaults[index]])));
  cls.dict.set('__match_args__', newTuple(fields));
  for (const [index, name] of fields.entries()) {
    cls.dict.set(
      name,
      new PyDescriptor(
        propertyClass,
        new PyBuiltinFunction(builtinClass('getter'), name, ([self]) => (self as PyTuple).items[index])
      )
    );
  }
  return cls;
}

// code-gauge-allow functionCognitiveComplexity 20 -- Follows how a namedtuple binds positional and keyword arguments to its fields.
function newNamedTuple(
  cls: PyClass,
  fields: string[],
  defaults: PyValue[],
  values: PyValue[],
  kwargs: Kwargs
): PyTuple {
  const qualified = `${cls.name}.__new__`;
  if (values.length > fields.length) {
    throw typeError(
      `${qualified}() takes ${fields.length + 1} positional arguments but ${values.length + 1} were given`
    );
  }
  const items: (PyValue | undefined)[] = [...values];
  for (const [key, value] of kwargs ?? []) {
    const index = fields.indexOf(key);
    if (index === -1) throw typeError(`${qualified}() got an unexpected keyword argument '${key}'`);
    if (items[index] !== undefined) throw typeError(`${qualified}() got multiple values for argument '${key}'`);
    items[index] = value;
  }
  const defaultsStart = fields.length - defaults.length;
  const missing: string[] = [];
  for (let index = 0; index < fields.length; index++) {
    if (items[index] !== undefined) continue;
    if (index >= defaultsStart) items[index] = defaults[index - defaultsStart];
    else missing.push(fields[index]);
  }
  if (missing.length > 0) {
    const quoted = missing.map((name) => `'${name}'`);
    const names =
      quoted.length === 1
        ? quoted[0]
        : quoted.length === 2
          ? `${quoted[0]} and ${quoted[1]}`
          : `${quoted.slice(0, -1).join(', ')}, and ${quoted.at(-1)}`;
    throw typeError(
      `${qualified}() missing ${missing.length} required positional argument${missing.length === 1 ? '' : 's'}: ${names}`
    );
  }
  currentRuntime().allocate(fields.length + 1);
  return new PyTuple(cls, items as PyValue[]);
}

/** Methods every namedtuple class has, defined on a shared base so that each class looks them up. */
export const namedTupleBase = builtinClass('NamedTupleMethods');
function fieldsOf(tuple: PyTuple): readonly PyValue[] {
  return (tuple.cls.lookup('_fields') as PyTuple | undefined)?.items ?? [];
}

function defineNamedTupleMethods(): void {
  method(namedTupleBase, '__repr__', 'none', 0, 0, (self) => {
    const tuple = self as PyTuple;
    const fields = fieldsOf(tuple);
    return containerRepr(
      tuple,
      '...',
      () =>
        `${tuple.cls.name}(${fields.map((field, index) => `${field as string}=${pyRepr(tuple.items[index])}`).join(', ')})`
    );
  });
  method(namedTupleBase, '_asdict', 'none', 0, 0, (self) => {
    const tuple = self as PyTuple;
    return newDict(fieldsOf(tuple).map((field, index) => [field, tuple.items[index]]));
  });
  namedTupleBase.dict.set(
    '_replace',
    new PyBuiltinFunction(
      builtinClass('method_descriptor'),
      '_replace',
      (args, kwargs) => {
        const tuple = args[0] as PyTuple;
        if (args.length > 1)
          throw typeError(`${tuple.cls.name}._replace() takes 1 positional argument but ${args.length} were given`);
        const fields = fieldsOf(tuple);
        const items = [...tuple.items];
        for (const [key, value] of kwargs ?? []) {
          const index = fields.indexOf(key);
          if (index === -1) throw valueError(`Got unexpected field names: [${pyRepr(key)}]`);
          items[index] = value;
        }
        return new PyTuple(tuple.cls, items);
      },
      undefined,
      'method',
      'NamedTuple'
    )
  );
  method(namedTupleBase, '_make', 'one', 1, 1, (cls, [iterable]) => callValue(cls, toArray(iterable)), {
    binding: 'class',
  });
}
defineNamedTupleMethods();

function namedtupleWithMethods(args: PyValue[], kwargs: Kwargs): PyValue {
  const cls = namedtuple(args, kwargs) as PyClass;
  for (const [name, value] of namedTupleBase.dict) if (!cls.dict.has(name)) cls.dict.set(name, value);
  return cls;
}

/** The namedtuple class that a `typing.NamedTuple` class statement creates. */
export function namedTupleClass(name: string, fields: string[], defaults: PyValue[]): PyClass {
  return namedtupleWithMethods([name, newList(fields)], new Map([['defaults', newTuple(defaults)]])) as PyClass;
}

/** A namedtuple class that a library module defines, such as `functools.CacheInfo`. */
export function makeNamedTupleClass(name: string, fields: string[], module: string): PyClass {
  const cls = namedtupleWithMethods([name, newList(fields)], undefined) as PyClass;
  cls.module = module;
  return cls;
}

registerModule(
  'collections',
  () =>
    new Map<string, PyValue>([
      ['deque', dequeClass],
      ['Counter', counterClass],
      ['defaultdict', defaultdictClass],
      ['OrderedDict', orderedDictClass],
      [
        'namedtuple',
        builtin('namedtuple', 'takes', 2, 2, namedtupleWithMethods, {
          keywords: ['typename', 'field_names', 'defaults', 'rename', 'module'],
        }),
      ],
    ])
);

export { getIterator, PyObject, storeKey };
