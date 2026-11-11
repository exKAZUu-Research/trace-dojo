// code-gauge-allow-file fileNcss 438 -- The attribute lookup and the protocols every kind of object follows belong together.
import { moduleAnnotations } from './annotations';
import { classAttribute, specialAttribute } from './attributes';
import { PyBytes, PyMemoryView } from './bytesValues';
import {
  callGetter,
  customGetattribute,
  descriptorGetter,
  getWithCustomGetattribute,
  isDataDescriptor,
  ownDict,
} from './descriptors';
import { getItem as getItemOf } from './items';
import { clamp, reduction, withState } from './iteratorStates';
import { namespaceDict } from './namespaces';
import { describeIntegerIndex, toIndex } from './numbers';
import { currentRuntime } from './runtimeContext';
import { isMember, readMember } from './slots';
import { iterStr, strLength } from './strings';
import { superAttribute } from './typeObject';
import {
  builtinFunctionClass,
  classmethodClass,
  classOf,
  dictKeysClass,
  exceptionClassNamed,
  frozensetClass,
  isIteratorGenerator,
  iteratorClass,
  methodClass,
  methodWrapperClass,
  newList,
  newTuple,
  None,
  NotImplemented,
  propertyClass,
  pyError,
  rangeClass,
  staticmethodClass,
  typeError,
  typeName,
  unbox,
  wrapperDescriptorClass,
} from './types';
import { UnsupportedFeatureError } from './unsupported';
import { unsupportedClassAttribute } from './unsupportedAttributes';
import {
  DONE,
  type Kwargs,
  PyBoundMethod,
  PyBuiltinFunction,
  PyClass,
  PyDeque,
  PyDescriptor,
  PyDict,
  PyDictView,
  PyError,
  PyFunction,
  type PyGenerator,
  PyInstance,
  PyIterator,
  PyList,
  PyModule,
  type PyObject,
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
    currentRuntime().spend();
    return fn.run(fn.self === undefined || fn.binding === 'static' ? args : [fn.self, ...args], kwargs);
  }
  if (fn instanceof PyBoundMethod) {
    return fn.fastCall ? callValue(fn.fastCall, args, kwargs) : callValue(fn.fn, [fn.self, ...args], kwargs);
  }
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
// code-gauge-allow functionCognitiveComplexity 20 -- One case per kind of descriptor binding.
export function bindValue(attribute: PyValue, instance: PyValue, owner: PyClass = classOf(instance)): PyValue {
  if (attribute instanceof PyFunction) return new PyBoundMethod(methodClass, instance, attribute);
  if (attribute instanceof PyBuiltinFunction && attribute.self === undefined) {
    // A builtin function, such as `time.localtime` stored as a class attribute, is not a descriptor in CPython.
    if (attribute.binding === 'static' || attribute.cls === builtinFunctionClass) return attribute;
    const self = attribute.binding === 'class' ? owner : mixinSelf(attribute, instance);
    return new PyBuiltinFunction(
      attribute.cls === wrapperDescriptorClass ? methodWrapperClass : builtinFunctionClass,
      attribute.name,
      attribute.run,
      self,
      'method',
      attribute.ownerName
    );
  }
  if (attribute instanceof PyDescriptor) {
    if (attribute.cls === staticmethodClass) return attribute.fn;
    if (attribute.cls === classmethodClass) return bindToClass(attribute.fn, owner);
    if (attribute.cls === propertyClass) {
      if (attribute.fn === None) throw pyError('AttributeError', `property object has no getter`);
      return callValue(attribute.fn, [instance]);
    }
  }
  return boundByGetter(attribute, instance, owner);
}

/** An attribute that a `__get__` of the program's class binds, as special methods such as `unittest.mock`'s are. */
function boundByGetter(attribute: PyValue, instance: PyValue, owner: PyClass): PyValue {
  const getter = descriptorGetter(attribute);
  return getter === undefined ? attribute : callValue(bindValue(getter, attribute), [instance, owner]);
}

/** The str or int that a method of `str` or `int` runs on for a member of an Enum mixing in that type. */
function mixinSelf(method: PyBuiltinFunction, instance: PyValue): PyValue {
  if (!(instance instanceof PyInstance) || instance.enumValue === undefined) return instance;
  const { enumValue } = instance;
  if (method.ownerName === 'str' && typeof enumValue === 'string') return enumValue;
  if (method.ownerName === 'int' && typeof enumValue === 'bigint') return enumValue;
  return instance;
}

function bindToClass(fn: PyValue, cls: PyClass): PyValue {
  return new PyBoundMethod(methodClass, cls, fn);
}

export function attributeError(value: PyValue, name: string): PyError {
  const message =
    value instanceof PyClass
      ? `type object '${value.typeName ?? value.name}' has no attribute '${name}'`
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
  const custom = customGetattribute(value);
  if (custom !== undefined) return getWithCustomGetattribute(value, name, custom);
  const found = findAttribute(value, name);
  if (found !== undefined) return found;
  const getattr = value instanceof PyModule ? value.dict.get('__getattr__') : lookupSpecial(value, '__getattr__');
  if (getattr !== undefined && value instanceof PyModule) return callValue(getattr, [name]);
  if (getattr !== undefined) return callValue(bindValue(getattr, value), [name]);
  const feature = unsupportedClassAttribute(value, name);
  if (feature !== undefined) throw new UnsupportedFeatureError(feature);
  throw attributeError(value, name);
}

/** Reads `value.name`, or returns undefined when it is missing. */
export function getAttributeOrUndefined(value: PyValue, name: string): PyValue | undefined {
  try {
    return getAttribute(value, name);
  } catch (error) {
    if (error instanceof PyError && error.exception.cls.name === 'AttributeError') return undefined;
    throw error;
  }
}

/** `object.__getattribute__`: reads an attribute without the program's `__getattribute__` and `__getattr__`. */
export function genericGetAttribute(value: PyValue, name: string): PyValue {
  const found = findAttribute(value, name);
  if (found === undefined) throw attributeError(value, name);
  return found;
}

function findAttribute(value: PyValue, name: string): PyValue | undefined {
  if (value instanceof PyClass) return classAttribute(value, name);
  if (value instanceof PyModule) return moduleAttribute(value, name);
  if (value instanceof PySuper) return superAttribute(value, name);
  const cls = classOf(value);
  const special = specialAttribute(value, name);
  if (special !== undefined) return special;
  const attribute = cls.lookup(name);
  if (attribute === undefined) return ownDict(value)?.get(name) ?? typeDocOf(cls, name);
  if (attribute instanceof PyDescriptor && attribute.cls === propertyClass) return bindValue(attribute, value, cls);
  if (isMember(attribute)) return readMember(attribute, value as PyObject);
  const getter = descriptorGetter(attribute);
  if (getter !== undefined && isDataDescriptor(attribute)) return callGetter(getter, attribute, value, cls);
  const own = ownDict(value)?.get(name);
  if (own !== undefined) return own;
  if (getter !== undefined) return callGetter(getter, attribute, value, cls);
  return bindValue(attribute, value, cls);
}

/** `obj.__doc__` of an instance of a builtin class, which is the class's own doc. */
function typeDocOf(cls: PyClass, name: string): PyValue | undefined {
  return name === '__doc__' && cls.isBuiltin ? classAttribute(cls, name) : undefined;
}

function moduleAttribute(module: PyModule, name: string): PyValue | undefined {
  const feature = module.unsupported.get(name);
  if (feature !== undefined) throw new UnsupportedFeatureError(feature);
  if (name === '__dict__') return namespaceDict(module.dict);
  return name === '__annotations__'
    ? moduleAnnotations(module)
    : (module.dict.get(name) ?? importedModule(module, name));
}

/**
 * The module CPython's module holds under `name` because its code imported it, which is the same object here too, or
 * the object another module defines that this module shares, named `module:attribute`.
 */
export function importedModule(module: PyModule, name: string): PyValue | undefined {
  const target = module.imports.get(name);
  if (target === undefined) return undefined;
  const [moduleName, attribute] = target.split(':');
  const imported = currentRuntime().importModule(moduleName);
  const value = attribute === undefined ? imported : getAttribute(imported, attribute);
  module.imports.delete(name);
  module.dict.set(name, value);
  return value;
}

export { deleteAttribute, setAttribute } from './attributes';

// Truth, length, and items ------------------------------------------------------------------------------------------

/** A special method that a program's subclass of a builtin type defines over the builtin type's, or undefined. */
export function overriding(value: PyValue, name: string): PyValue | undefined {
  if (typeof value !== 'object' || value.cls.isBuiltin) return undefined;
  const method = value.cls.lookup(name);
  return method === undefined || method instanceof PyBuiltinFunction ? undefined : method;
}

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
  if (overriding(value, '__bool__') === undefined && overriding(value, '__len__') === undefined) {
    const truth = builtinTruth(value);
    if (truth !== undefined) return truth;
  }
  const bool = lookupSpecial(value, '__bool__');
  if (bool !== undefined) {
    const result = callValue(bindValue(bool, value), []);
    if (typeof result !== 'boolean') throw typeError(`__bool__ should return bool, returned ${typeName(result)}`);
    return result;
  }
  const len = lookupSpecial(value, '__len__');
  if (len !== undefined) return lengthOf(value) > 0;
  return true;
}

function builtinTruth(value: PyValue): boolean | undefined {
  if (value instanceof PyList || value instanceof PyTuple) return value.items.length > 0;
  if (value instanceof PyDict) return value.store.size > 0;
  if (value instanceof PySet) return value.table.size > 0;
  if (value instanceof PyRange) return value.length > 0n;
  return undefined;
}

/** Python's `len()`. */
export function lengthOf(value: PyValue): number {
  if (typeof value === 'string') return strLength(value);
  if (overriding(value, '__len__') === undefined) {
    const length = builtinLength(value);
    if (length !== undefined) return length;
  }
  const len = lookupSpecial(value, '__len__');
  if (len === undefined) throw typeError(`object of type '${typeName(value)}' has no len()`);
  const result = unbox(callValue(bindValue(len, value), []));
  if (typeof result !== 'bigint' && typeof result !== 'boolean') {
    throw typeError(`'${typeName(result)}' object cannot be interpreted as an integer`);
  }
  const length = BigInt(result);
  if (length < 0n) throw pyError('ValueError', '__len__() should return >= 0');
  return Number(length);
}

function builtinLength(value: PyValue): number | undefined {
  if (value instanceof PyList || value instanceof PyTuple) return value.items.length;
  if (value instanceof PyDict) return value.store.size;
  if (value instanceof PySet) return value.table.size;
  if (value instanceof PyDictView) return value.dict.store.size;
  if (value instanceof PyClass && value.enumMembers) return value.enumMembers.length;
  if (value instanceof PyRange) {
    const { length } = value;
    if (length > BigInt(Number.MAX_SAFE_INTEGER))
      throw pyError('OverflowError', 'Python int too large to convert to C ssize_t');
    return Number(length);
  }
  return undefined;
}

export { deleteItem, getItem, setItem } from './items';

// Iteration ---------------------------------------------------------------------------------------------------------

export type NextFunction = () => PyValue | typeof DONE;

/** Starts iterating a value, returning a function that gives the next item or DONE. */
export function iterate(value: PyValue): NextFunction {
  if (typeof value === 'string') return iterateString(value);
  if (overriding(value, '__iter__') === undefined) {
    const next = builtinIterate(value);
    if (next !== undefined) return next;
  }
  return iterateByProtocol(value);
}

/** Iterates a builtin iterable natively, or returns undefined for any other value. */
function builtinIterate(value: PyValue): NextFunction | undefined {
  if (value instanceof PyList || value instanceof PyTuple) return iterateItems(value);
  if (typeof value === 'string') return iterateString(value);
  if (value instanceof PyRange) return iterateRange(value);
  if (value instanceof PyDict) return iterateDict(value, 'keys');
  if (value instanceof PyDictView) return iterateDict(value.dict, value.view);
  if (value instanceof PySet) return iterateSet(value);
  if (value instanceof PyIterator) return value.next;
  if (isIteratorGenerator(value)) return iterateGenerator(value);
  if (value instanceof PyClass && value.enumMembers) return iterate(newList([...value.enumMembers]));
  return undefined;
}

/** How many items each native iterator has left, which its `__length_hint__` gives. */
const remainingCounts = new WeakMap<NextFunction, () => number>();

/** Records how many items an iterator's next function has left. */
export function withRemaining(next: NextFunction, remaining: () => number): NextFunction {
  remainingCounts.set(next, remaining);
  return next;
}

/** How many items a native iterator has left, or undefined for an iterator that does not know. */
export function remainingOf(next: NextFunction): number | undefined {
  return remainingCounts.get(next)?.();
}

// code-gauge-allow functionCognitiveComplexity 16 -- The iterator, its reduction, and its __setstate__ share its position.
function iterateItems(sequence: PyList | PyTuple): NextFunction {
  let index = 0;
  // As in CPython, an iterator that reached the end stays there, even if the sequence grows.
  let exhausted = false;
  const next = withRemaining(
    () => {
      if (!exhausted && index < sequence.items.length) return sequence.items[index++];
      exhausted = true;
      return DONE;
    },
    () => (exhausted ? 0 : Math.max(sequence.items.length - index, 0))
  );
  const isTuple = sequence instanceof PyTuple;
  return withState(next, {
    reduce: () =>
      exhausted
        ? reduction('iter', [isTuple ? newTuple([]) : newList([])])
        : reduction('iter', [sequence], BigInt(index)),
    setState: (state) => {
      if (exhausted) return;
      if (state < 0n && !isTuple) exhausted = true;
      else index = clamp(state, 0, sequence.items.length);
    },
  });
}

function iterateGenerator(generator: PyGenerator): NextFunction {
  const runtime = currentRuntime();
  return () => runtime.resumeGenerator(generator);
}

function iterateString(value: string): NextFunction {
  const characters = iterStr(value);
  currentRuntime().scan(characters.length);
  let index = 0;
  let exhausted = false;
  const next = withRemaining(
    () => {
      if (!exhausted && index < characters.length) return characters[index++];
      exhausted = true;
      return DONE;
    },
    () => (exhausted ? 0 : characters.length - index)
  );
  return withState(next, {
    reduce: () => (exhausted ? reduction('iter', ['']) : reduction('iter', [value], BigInt(index))),
    setState: (state) => {
      if (!exhausted) index = clamp(state, 0, characters.length);
    },
  });
}

function iterateRange(range: PyRange): NextFunction {
  const { step, length } = range;
  let current = range.start;
  let remaining = length;
  const next: NextFunction = () => {
    if (remaining <= 0n) return DONE;
    remaining--;
    const result = current;
    current += step;
    return result;
  };
  return withState(
    withRemaining(next, () => Number(remaining > 0n ? remaining : 0n)),
    {
      reduce: () => reduction('iter', [new PyRange(rangeClass, current, current + remaining * step, step)], None),
      setState: (state) => {
        const skipped = state < 0n ? 0n : state > remaining ? remaining : state;
        current += skipped * step;
        remaining -= skipped;
      },
    }
  );
}

function iterateSet(set: PySet): NextFunction {
  const { table } = set;
  const version = table.version;
  const size = table.size;
  const entries = table.entries();
  let consumed = 0;
  const next: NextFunction = () => {
    if (table.version !== version) throw pyError('RuntimeError', 'Set changed size during iteration');
    const step = entries.next();
    if (step.done) {
      consumed = size;
      return DONE;
    }
    consumed++;
    return step.value.key;
  };
  const remainingItems = (): PyValue[] => [...table.entries()].slice(consumed).map((entry) => entry.key as PyValue);
  return withState(
    withRemaining(next, () => (table.version === version ? size - consumed : 0)),
    {
      reduce: () => reduction('iter', [newList(consumed >= size ? [] : remainingItems())]),
    }
  );
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

/** The next function of an iterator object, which calls its `__next__` until it raises StopIteration. */
export function nextOf(iterator: PyValue): NextFunction {
  if (iterator instanceof PyIterator) return iterator.next;
  if (isIteratorGenerator(iterator)) return () => currentRuntime().resumeGenerator(iterator);
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

// code-gauge-allow functionCognitiveComplexity 19 -- The iterator, its size check, and its reduction share its position.
function iterateDict(dict: PyDict, view: 'keys' | 'values' | 'items'): NextFunction {
  const { store } = dict;
  const size = store.size;
  const entries = store.liveEntries();
  const runtime = currentRuntime();
  let consumed = 0;
  const remainingItems = (): PyValue[] =>
    [...store.liveEntries()]
      .slice(consumed)
      .map((entry) =>
        view === 'keys' ? entry.key : view === 'values' ? entry.value : runtime.tuple([entry.key, entry.value])
      );
  const next = withRemaining(
    () => {
      if (store.size !== size) throw pyError('RuntimeError', 'dictionary changed size during iteration');
      const next = entries.next();
      if (next.done) {
        consumed = size;
        return DONE;
      }
      consumed++;
      const entry = next.value;
      if (view === 'keys') return entry.key;
      if (view === 'values') return entry.value;
      return runtime.tuple([entry.key, entry.value]);
    },
    () => (store.size === size ? size - consumed : 0)
  );
  return withState(next, { reduce: () => reduction('iter', [newList(consumed >= size ? [] : remainingItems())]) });
}

/** All the items an iterable yields. */
export function toArray(value: PyValue): PyValue[] {
  if ((value instanceof PyList || value instanceof PyTuple) && overriding(value, '__iter__') === undefined) {
    return [...value.items];
  }
  const next = iterate(value);
  const items: PyValue[] = [];
  const runtime = currentRuntime();
  for (let item = next(); item !== DONE; item = next()) {
    runtime.spend();
    items.push(item);
  }
  return items;
}

/** The iterator object `iter()` returns. */
export function getIterator(value: PyValue): PyValue {
  if (value instanceof PyIterator || isIteratorGenerator(value)) return value;
  const iter = lookupSpecial(value, '__iter__');
  if (iter !== undefined && iter !== None && !(iter instanceof PyBuiltinFunction)) {
    const iterator = callValue(bindValue(iter, value), []);
    if (lookupSpecial(iterator, '__next__') === undefined) {
      throw typeError(`iter() returned non-iterator of type '${typeName(iterator)}'`);
    }
    return iterator;
  }
  const next = iterate(value);
  return new PyIterator(iteratorClass(iteratorNameOf(value)), next, () => [value]);
}

/** The iterator the `__iter__` of a builtin iterable returns, which iterates it natively whatever its class. */
export function builtinIterator(value: PyValue): PyValue {
  const next = builtinIterate(value) ?? iterate(value);
  return new PyIterator(iteratorClass(iteratorNameOf(value)), next, () => [value]);
}

// code-gauge-allow functionCognitiveComplexity 22 -- One case per builtin iterable.
function iteratorNameOf(value: PyValue): string {
  // oxlint-disable-next-line eslint/no-control-regex -- ASCII includes the control characters.
  if (typeof value === 'string') return /^[\u0000-\u007F]*$/.test(value) ? 'str_ascii_iterator' : 'str_iterator';
  if (value instanceof PyList) return 'list_iterator';
  if (value instanceof PyDeque) return 'collections._deque_iterator';
  if (value instanceof PyBytes) return value.isMutable ? 'bytearray_iterator' : 'bytes_iterator';
  if (value instanceof PyMemoryView) return 'memory_iterator';
  if (value instanceof PyTuple) return 'tuple_iterator';
  if (value instanceof PyRange) {
    const fits = [value.start, value.stop, value.step].every((each) => each >= -(2n ** 63n) && each < 2n ** 63n);
    return fits ? 'range_iterator' : 'longrange_iterator';
  }
  if (value instanceof PySet) return 'set_iterator';
  if (value instanceof PyDict) return 'dict_keyiterator';
  if (value instanceof PyDictView) {
    return value.cls === dictKeysClass
      ? 'dict_keyiterator'
      : value.view === 'values'
        ? 'dict_valueiterator'
        : 'dict_itemiterator';
  }
  return 'iterator';
}

/** Interprets a value as an index, as `__index__` does. */
export function indexOf(value: PyValue, describe = describeIntegerIndex): bigint {
  return toIndex(value, describe);
}

export function isFrozenset(value: PyValue): value is PySet {
  return value instanceof PySet && value.cls.isSubclassOf(frozensetClass);
}

export { NotImplemented };
