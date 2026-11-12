import { classAttribute, specialAttribute } from './attributes';
import { isDataDescriptor, isNonDataDescriptor, readDescriptor } from './descriptors';
import { getItem as getItemOf } from './items';
import { describeIntegerIndex, toIndex } from './numbers';
import { currentRuntime } from './runtimeContext';
import { iterStr, strLength } from './strings';
import { superAttribute } from './typeObject';
import {
  builtinFunctionClass,
  classmethodClass,
  classOf,
  exceptionClassNamed,
  frozensetClass,
  iteratorClass,
  methodClass,
  newList,
  None,
  NotImplemented,
  propertyClass,
  pyError,
  staticmethodClass,
  typeError,
  typeName,
} from './types';
import { UnsupportedFeatureError } from './unsupported';
import {
  DONE,
  type Kwargs,
  ownAttributesOf,
  PyBoundMethod,
  PyBuiltinFunction,
  PyClass,
  PyDescriptor,
  PyDict,
  PyDictView,
  PyError,
  PyFunction,
  PyGenerator,
  PyInstance,
  PyIterator,
  PyList,
  PyModule,
  PyObject,
  PyRange,
  PySet,
  PySuper,
  PyTuple,
  type PyValue,
} from './values';

// Calls -------------------------------------------------------------------------------------------------------------

/** Calls a Python callable. */
export function callValue(fn: PyValue, args: PyValue[], kwargs?: Kwargs): PyValue {
  if (fn instanceof PyFunction) return currentRuntime().callFunction(fn, args, kwargs);
  if (fn instanceof PyBuiltinFunction) {
    const runtime = currentRuntime();
    runtime.spend();
    return runtime.runNative(() => fn.run(fn.self === undefined ? args : [fn.self, ...args], kwargs));
  }
  if (fn instanceof PyBoundMethod) return callValue(fn.fn, [fn.self, ...args], kwargs);
  if (fn instanceof PyClass) return currentRuntime().instantiate(fn, args, kwargs);
  const call = lookupSpecial(fn, '__call__');
  if (call !== undefined) return callValue(bindValue(call, fn), args, kwargs);
  throw typeError(`'${typeName(fn)}' object is not callable`);
}

export function isCallable(value: PyValue): boolean {
  return (
    value instanceof PyFunction ||
    value instanceof PyBuiltinFunction ||
    value instanceof PyBoundMethod ||
    value instanceof PyClass ||
    lookupSpecial(value, '__call__') !== undefined
  );
}

// Attributes --------------------------------------------------------------------------------------------------------

/** Looks up a special method on a value's class, as the interpreter does for operators, without the instance dict. */
export function lookupSpecial(value: PyValue, name: string): PyValue | undefined {
  return classOf(value).lookup(name);
}

/** Calls a special method found on the value's class. */
export function callSpecial(value: PyValue, name: string, args: PyValue[]): PyValue {
  const method = lookupSpecial(value, name);
  if (method === undefined) throw attributeError(value, name);
  return callValue(bindValue(method, value), args);
}

/** Binds a class attribute to an instance, as a descriptor's `__get__` would. */
// code-gauge-allow functionCognitiveComplexity 23 -- One case per kind of descriptor binding.
export function bindValue(attribute: PyValue, instance: PyValue, owner: PyClass = classOf(instance)): PyValue {
  if (attribute instanceof PyFunction) return new PyBoundMethod(methodClass, instance, attribute);
  if (attribute instanceof PyBuiltinFunction && attribute.self === undefined) {
    if (attribute.binding === 'static') return attribute;
    const self = attribute.binding === 'class' ? owner : instance;
    return new PyBuiltinFunction(
      builtinFunctionClass,
      attribute.name,
      attribute.run,
      self,
      'method',
      attribute.ownerName
    );
  }
  if (attribute instanceof PyInstance && !attribute.cls.isBuiltin) {
    // Only classes of library code written in Python define __get__.
    const get = attribute.cls.lookup('__get__');
    if (get !== undefined) return callValue(bindValue(get, attribute), [instance, owner]);
  }
  if (attribute instanceof PyObject && attribute.cls.nativeGet)
    return attribute.cls.nativeGet(attribute, instance, owner);
  if (attribute instanceof PyDescriptor) {
    if (attribute.cls === staticmethodClass) return attribute.fn;
    if (attribute.cls === classmethodClass) return bindToClass(attribute.fn, owner);
    if (attribute.cls === propertyClass) {
      if (attribute.fn === None) throw pyError('AttributeError', `property object has no getter`);
      return callValue(attribute.fn, [instance]);
    }
  }
  return attribute;
}

function bindToClass(fn: PyValue, cls: PyClass): PyValue {
  return new PyBoundMethod(methodClass, cls, fn);
}

export function attributeError(value: PyValue, name: string): PyError {
  const message =
    value instanceof PyClass
      ? `type object '${value.name}' has no attribute '${name}'`
      : value instanceof PyModule
        ? `module '${value.name}' has no attribute '${name}'`
        : `'${typeName(value)}' object has no attribute '${name}'`;
  const error = pyError('AttributeError', message);
  const state = error.exception.exception;
  if (state) {
    state.name = name;
    state.object = value;
  }
  return error;
}

/** Reads `value.name`, raising AttributeError when it is missing. */
export function getAttribute(value: PyValue, name: string): PyValue {
  const getattr = value instanceof PyClass ? undefined : lookupSpecial(value, '__getattr__');
  let found: PyValue | undefined;
  try {
    found = findAttribute(value, name);
  } catch (error) {
    // A descriptor that raises AttributeError reports the attribute as missing, so `__getattr__` still applies.
    if (getattr === undefined || !isAttributeError(error)) throw error;
  }
  if (found !== undefined) return found;
  if (getattr !== undefined) return callValue(bindValue(getattr, value), [name]);
  throw attributeError(value, name);
}

function isAttributeError(error: unknown): boolean {
  return error instanceof PyError && error.exception.cls.isSubclassOf(exceptionClassNamed('AttributeError'));
}

/** Reads `value.name`, or returns undefined when it is missing. */
export function getAttributeOrUndefined(value: PyValue, name: string): PyValue | undefined {
  try {
    return getAttribute(value, name);
  } catch (error) {
    if (isAttributeError(error)) return undefined;
    throw error;
  }
}

// code-gauge-allow functionNcss 35 -- Follows the order CPython looks up an attribute in.
// code-gauge-allow functionCognitiveComplexity 21 -- Follows the order CPython looks up an attribute in.
function findAttribute(value: PyValue, name: string): PyValue | undefined {
  if (value instanceof PyClass) return classAttribute(value, name);
  if (value instanceof PyModule) {
    const feature = value.unsupported.get(name);
    if (feature !== undefined) throw new UnsupportedFeatureError(feature);
    return value.attribute(name) ?? specialAttribute(value, name);
  }
  if (value instanceof PySuper) {
    const found = superAttribute(value, name);
    if (found !== undefined) return found;
    const own = value.cls.lookup(name);
    return isDataDescriptor(own) ? readDescriptor(own, value) : undefined;
  }
  const cls = classOf(value);
  const special = specialAttribute(value, name);
  if (special !== undefined) return special;
  const attribute = cls.lookup(name);
  if (isDataDescriptor(attribute)) return readDescriptor(attribute, value);
  if (attribute instanceof PyDescriptor && attribute.cls === propertyClass) return bindValue(attribute, value, cls);
  if (value instanceof PyInstance || value instanceof PyFunction) {
    const own = value.dict.get(name);
    if (own !== undefined) return own;
  }
  const opaqueOwn = ownAttributesOf(value)?.get(name);
  if (opaqueOwn !== undefined) return opaqueOwn;
  if (isNonDataDescriptor(attribute)) return readDescriptor(attribute, value);
  if (attribute === undefined) return undefined;
  return bindValue(attribute, value, cls);
}

export { deleteAttribute, setAttribute } from './attributes';

// Truth, length, and items ------------------------------------------------------------------------------------------

export function isTruthy(value: PyValue): boolean {
  switch (typeof value) {
    case 'boolean': {
      return value;
    }
    case 'bigint': {
      return value !== 0n;
    }
    case 'number': {
      return value !== 0;
    }
    case 'string': {
      return value.length > 0;
    }
  }
  if (value === None) return false;
  if (
    value instanceof PyList ||
    (value instanceof PyTuple && !overridesBuiltin(value, '__bool__') && !overridesBuiltin(value, '__len__'))
  ) {
    return value.items.length > 0;
  }
  if (value instanceof PyDict) return value.store.size > 0;
  if (value instanceof PySet) return value.table.size > 0;
  if (value instanceof PyRange) return value.length > 0n;
  const bool = lookupSpecial(value, '__bool__');
  if (bool !== undefined) {
    const result = callValue(bindValue(bool, value), []);
    if (typeof result !== 'boolean') throw typeError(`__bool__ should return bool, returned ${typeName(result)}`);
    return result;
  }
  const len = lookupSpecial(value, '__len__');
  if (len !== undefined) return exactLength(value) > 0n;
  return true;
}

/** The length of a value as a host number, for code that sizes or indexes a host array by it. */
export function lengthOf(value: PyValue): number {
  return Number(exactLength(value));
}

const MAX_SSIZE = (1n << 63n) - 1n;

/** Python's `len()`, exact up to CPython's Py_ssize_t limit. */
export function exactLength(value: PyValue): bigint {
  if (typeof value === 'string') return BigInt(strLength(value));
  if (value instanceof PyList || (value instanceof PyTuple && !overridesBuiltin(value, '__len__'))) {
    return BigInt(value.items.length);
  }
  if (value instanceof PyDict) return BigInt(value.store.size);
  if (value instanceof PySet) return BigInt(value.table.size);
  if (value instanceof PyDictView) return BigInt(value.dict.store.size);
  if (value instanceof PyClass && value.enumMembers) return BigInt(value.enumMembers.length);
  if (value instanceof PyRange) {
    if (value.length > MAX_SSIZE) throw pyError('OverflowError', 'Python int too large to convert to C ssize_t');
    return value.length;
  }
  const len = lookupSpecial(value, '__len__');
  if (len === undefined) throw typeError(`object of type '${typeName(value)}' has no len()`);
  const length = toIndex(callValue(bindValue(len, value), []));
  if (length < 0n) throw pyError('ValueError', '__len__() should return >= 0');
  if (length > MAX_SSIZE) throw pyError('OverflowError', "cannot fit 'int' into an index-sized integer");
  return length;
}

export { deleteItem, getItem, setItem } from './items';

// Iteration ---------------------------------------------------------------------------------------------------------

export type NextFunction = () => PyValue | typeof DONE;

/** Starts iterating a value, returning a function that gives the next item or DONE. */
export function iterate(value: PyValue): NextFunction {
  return iterateBuiltin(value) ?? iterateByProtocol(value);
}

/** Starts iterating each of several iterables as {@link iterateHeld} does, as zip and map read theirs. */
export function iterateEach(iterables: PyValue[]): { nexts: NextFunction[]; held: () => PyValue[] } {
  const iterations = iterables.map((iterable) => iterateHeld(iterable));
  return { nexts: iterations.map((iteration) => iteration.next), held: () => iterations.map(({ held }) => held) };
}

/**
 * Starts iterating a value as {@link iterate} does, also returning what holds the items yet to come, which a native
 * iterator built on the iteration must report as held: the iterator object that `__iter__` returned, or the value.
 */
export function iterateHeld(value: PyValue): { next: NextFunction; held: PyValue } {
  const next = iterateBuiltin(value);
  if (next) return { next, held: value };
  const iter = lookupSpecial(value, '__iter__');
  if (iter === undefined || iter === None) return { next: iterateByProtocol(value), held: value };
  const iterator = callValue(bindValue(iter, value), []);
  return { next: nextOf(iterator), held: iterator };
}

function iterateBuiltin(value: PyValue): NextFunction | undefined {
  if (value instanceof PyList || (value instanceof PyTuple && !overridesBuiltin(value, '__iter__')))
    return iterateItems(value);
  if (typeof value === 'string') return iterateString(value);
  if (value instanceof PyRange) return iterateRange(value);
  if (value instanceof PyDict && !overridesBuiltin(value, '__iter__')) return iterateDict(value, 'keys');
  if (value instanceof PyDictView) return iterateDict(value.dict, value.view);
  if (value instanceof PySet) return iterateSet(value);
  if (value instanceof PyIterator) {
    // A native iterator may hand on items that only its own state held, such as groupby's pending item.
    const runtime = currentRuntime();
    return () => runtime.runNative(value.next);
  }
  if (value instanceof PyGenerator) return iterateGenerator(value);
  if (value instanceof PyClass && value.enumMembers) return iterate(newList([...value.enumMembers]));
  return undefined;
}

function iterateItems(sequence: PyList | PyTuple): NextFunction {
  let index = 0;
  return () => (index < sequence.items.length ? sequence.items[index++] : DONE);
}

function iterateGenerator(generator: PyGenerator): NextFunction {
  const runtime = currentRuntime();
  return () => runtime.resumeGenerator(generator);
}

function iterateString(value: string): NextFunction {
  const characters = iterStr(value);
  currentRuntime().scan(characters.length);
  let index = 0;
  return () => (index < characters.length ? characters[index++] : DONE);
}

function iterateRange(range: PyRange): NextFunction {
  const { step, length } = range;
  let current = range.start;
  let remaining = length;
  return () => {
    if (remaining <= 0n) return DONE;
    remaining--;
    const result = current;
    current += step;
    return result;
  };
}

function iterateSet(set: PySet): NextFunction {
  const { table } = set;
  const version = table.version;
  const entries = table.entries();
  return () => {
    if (table.version !== version) throw pyError('RuntimeError', 'Set changed size during iteration');
    const next = entries.next();
    return next.done ? DONE : next.value.key;
  };
}

/** Iterates for a caller that words the TypeError of getting the iterator itself, as `str.join` does in CPython. */
export function iterateOr(value: PyValue, notIterable: string): NextFunction {
  try {
    return iterate(value);
  } catch (error) {
    if (error instanceof PyError && error.exception.cls.isSubclassOf(exceptionClassNamed('TypeError'))) {
      throw typeError(notIterable);
    }
    throw error;
  }
}

/** Iterates with `__iter__`, or with `__getitem__` as the old sequence protocol does. */
function iterateByProtocol(value: PyValue): NextFunction {
  const iter = lookupSpecial(value, '__iter__');
  if (iter === undefined || iter === None) {
    const getitem = iter === None ? undefined : lookupSpecial(value, '__getitem__');
    if (getitem !== undefined) return iterateSequence(value);
    throw typeError(`'${typeName(value)}' object is not iterable`);
  }
  const iterator = callValue(bindValue(iter, value), []);
  return nextOf(iterator);
}

/**
 * Whether the class of a value, a subclass of a builtin type, overrides one of that type's methods, which the native
 * fast paths for the type must then leave to the method.
 */
export function overridesBuiltin(value: PyObject, name: string): boolean {
  return !value.cls.isBuiltin && value.cls.lookup(name) !== value.cls.mro.find((cls) => cls.isBuiltin)?.lookup(name);
}

/** The next function of an iterator object, which calls its `__next__` until it raises StopIteration. */
export function nextOf(iterator: PyValue): NextFunction {
  if (iterator instanceof PyIterator) return iterator.next;
  if (iterator instanceof PyGenerator) return () => currentRuntime().resumeGenerator(iterator);
  const next = lookupSpecial(iterator, '__next__');
  if (next === undefined) throw typeError(`iter() returned non-iterator of type '${typeName(iterator)}'`);
  const bound = bindValue(next, iterator);
  return () => {
    try {
      return callValue(bound, []);
    } catch (error) {
      if (error instanceof PyError && error.exception.cls.isSubclassOf(exceptionClassNamed('StopIteration')))
        return DONE;
      throw error;
    }
  };
}

function iterateSequence(value: PyValue): NextFunction {
  let index = 0n;
  let finished = false;
  return () => {
    if (finished) return DONE;
    try {
      return getItemOf(value, index++);
    } catch (error) {
      if (error instanceof PyError && ['IndexError', 'StopIteration'].includes(error.exception.cls.name)) {
        finished = true;
        return DONE;
      }
      throw error;
    }
  };
}

function iterateDict(dict: PyDict, view: 'keys' | 'values' | 'items'): NextFunction {
  const { store } = dict;
  const { size, version } = store;
  const entries = store.liveEntries();
  const runtime = currentRuntime();
  return () => {
    checkDictUnchanged(dict, size, version);
    const next = entries.next();
    if (next.done) return DONE;
    const entry = next.value;
    if (view === 'keys') return entry.key;
    if (view === 'values') return entry.value;
    return runtime.tuple([entry.key, entry.value]);
  };
}

/**
 * Refuses to go on iterating a dict that changed since the iterator began: a dict whose size changed, or an
 * OrderedDict that gained, lost, or moved an entry, as CPython's odict iterator checks the dict's state.
 */
export function checkDictUnchanged(dict: PyDict, size: number, version: number): void {
  if (dict.cls.flags.isOrderedDict) {
    if (dict.store.version !== version) throw pyError('RuntimeError', 'OrderedDict mutated during iteration');
  } else if (dict.store.size !== size) {
    throw pyError('RuntimeError', 'dictionary changed size during iteration');
  }
}

/** All the items an iterable yields, with `notIterable` as the message for a value that gives no iterator. */
export function toArray(value: PyValue, notIterable?: string): PyValue[] {
  if (value instanceof PyList || (value instanceof PyTuple && !overridesBuiltin(value, '__iter__')))
    return [...value.items];
  const next = notIterable === undefined ? iterate(value) : iterateOr(value, notIterable);
  const items: PyValue[] = [];
  const runtime = currentRuntime();
  // The items taken so far are only here while the iterator runs Python code.
  return runtime.runNative(() => {
    for (let item = next(); item !== DONE; item = next()) {
      runtime.spend();
      items.push(item);
    }
    return items;
  });
}

/** The iterator object `iter()` returns. */
export function getIterator(value: PyValue): PyValue {
  if (value instanceof PyIterator || value instanceof PyGenerator) return value;
  const iter = lookupSpecial(value, '__iter__');
  // A builtin's own __iter__ is bypassed only where iterateBuiltin reads the value directly, whose __iter__ comes back
  // here; any other builtin's __iter__ makes its own iterator type, such as a deque's.
  const builtin = classOf(value).isBuiltin && iter instanceof PyBuiltinFunction ? iterateBuiltin(value) : undefined;
  if (!builtin && iter !== undefined && iter !== None) {
    const iterator = callValue(bindValue(iter, value), []);
    if (lookupSpecial(iterator, '__next__') === undefined) {
      throw typeError(`iter() returned non-iterator of type '${typeName(iterator)}'`);
    }
    return iterator;
  }
  const base = builtin ?? iterate(value);
  let consumed = 0;
  let exhausted = false;
  const next = (): PyValue | typeof DONE => {
    const item = base();
    if (item === DONE) exhausted = true;
    else consumed++;
    return item;
  };
  const iterator = new PyIterator(iteratorClass(iteratorNameOf(value)), next, () => [value]);
  iterator.lengthHint = () => (exhausted ? 0 : Math.max(0, lengthOf(value) - consumed));
  return iterator;
}

function iteratorNameOf(value: PyValue): string {
  // oxlint-disable-next-line eslint/no-control-regex -- ASCII includes the control characters.
  if (typeof value === 'string') return /^[\u0000-\u007F]*$/.test(value) ? 'str_ascii_iterator' : 'str_iterator';
  if (value instanceof PyList) return 'list_iterator';
  if (value instanceof PyTuple) return 'tuple_iterator';
  if (value instanceof PyRange) return 'range_iterator';
  if (value instanceof PySet) return 'set_iterator';
  if (value instanceof PyDict) return dictIteratorName(value, 'keys');
  if (value instanceof PyDictView) return dictIteratorName(value.dict, value.view);
  return 'iterator';
}

/** The iterator type of a dict or its view, which an OrderedDict shares among all of them as CPython's does. */
function dictIteratorName(dict: PyDict, view: 'keys' | 'values' | 'items'): string {
  if (dict.cls.flags.isOrderedDict) return 'odict_iterator';
  if (view === 'keys') return 'dict_keyiterator';
  return view === 'values' ? 'dict_valueiterator' : 'dict_itemiterator';
}

/** Interprets a value as an index, as `__index__` does. */
export function indexOf(value: PyValue, describe = describeIntegerIndex): bigint {
  return toIndex(value, describe);
}

export function isFrozenset(value: PyValue): value is PySet {
  return value instanceof PySet && value.cls.isSubclassOf(frozensetClass);
}

export { NotImplemented };

/** The name argument of getattr(), setattr(), delattr(), and object's attribute methods, which must be a str. */
export function attributeName(name: PyValue): string {
  if (typeof name !== 'string') throw typeError(`attribute name must be string, not '${typeName(name)}'`);
  return name;
}
