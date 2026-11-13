// code-gauge-allow-file fileNcss 555 -- The attribute lookup and the protocols every kind of object follows belong together.
import { moduleAnnotations } from './annotations';
import { PyAttribute } from './attributeDescriptors';
import { classAttribute, specialAttribute } from './attributes';
import { PyBytes, PyMemoryView } from './bytesValues';
import {
  callGetter,
  customGetattribute,
  descriptorGetter,
  ensureThreadLocalDict,
  getWithCustomGetattribute,
  isDataDescriptor,
  isThreadLocal,
  ownDict,
} from './descriptors';
import { DictItemTuple, dictItemValue } from './dictItemTuple';
import { getItem as getItemOf } from './items';
import { clamp, reduction, stateOf, withState } from './iteratorStates';
import { completeNamespace } from './modules/moduleLayout';
import { checkNamespaceListing } from './namespaceDifferences';
import { namespaceDict } from './namespaces';
import { describeIntegerIndex, toIndex } from './numbers';
import { currentRuntime, releaseCaughtException } from './runtimeContext';
import { iterStr, strLength } from './strings';
import { superAttribute } from './typeObject';
import {
  builtinFunctionClass,
  classmethodClass,
  classOf,
  exceptionClassNamed,
  frozensetClass,
  functionClass,
  generatorClass,
  isIteratorGenerator,
  isPropertyKind,
  iteratorClass,
  methodClass,
  methodWrapperClass,
  newList,
  newTuple,
  None,
  NotImplemented,
  pyError,
  rangeClass,
  staticmethodClass,
  typeError,
  typeName,
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
  PyGenerator,
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
    const runtime = currentRuntime();
    runtime.spend();
    return runtime.runNative(() =>
      fn.run(fn.self === undefined || fn.binding === 'static' ? args : [fn.self, ...args], kwargs, fn.self)
    );
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
// code-gauge-allow functionCognitiveComplexity 25 -- One case per kind of descriptor binding.
export function bindValue(attribute: PyValue, instance: PyValue, owner: PyClass = classOf(instance)): PyValue {
  if (attribute instanceof PyFunction) return new PyBoundMethod(methodClass, instance, attribute);
  if (attribute instanceof PyBuiltinFunction && attribute.self === undefined) {
    // A builtin function, such as `time.localtime` stored as a class attribute, is not a descriptor in CPython.
    if (attribute.binding === 'static' || attribute.cls === builtinFunctionClass) return attribute;
    if (attribute.cls === functionClass) {
      return new PyBoundMethod(methodClass, attribute.binding === 'class' ? owner : instance, attribute);
    }
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
    if (isPropertyKind(attribute.cls)) {
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
  const getattr = value instanceof PyModule ? value.dict.get('__getattr__') : lookupSpecial(value, '__getattr__');
  let found: PyValue | undefined;
  try {
    found = findAttribute(value, name) ?? missingAttribute(value, name);
  } catch (error) {
    // A descriptor that raises AttributeError reports the attribute as missing, so `__getattr__` still applies.
    if (getattr === undefined || !isAttributeError(error)) throw error;
  }
  if (found !== undefined) return found;
  if (getattr !== undefined && value instanceof PyModule) return callValue(getattr, [name]);
  if (getattr !== undefined) return callValue(bindValue(getattr, value), [name]);
  const feature = unsupportedClassAttribute(value, name);
  if (feature !== undefined) throw new UnsupportedFeatureError(feature);
  throw attributeError(value, name);
}

function missingAttribute(value: PyValue, name: string): PyValue | undefined {
  if (value instanceof PyClass) return undefined;
  for (const cls of classOf(value).mro) {
    const found = cls.missingAttribute?.(value, name);
    if (found !== undefined) return found;
  }
  return undefined;
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

/** `object.__getattribute__`: reads an attribute without the program's `__getattribute__` and `__getattr__`. */
export function genericGetAttribute(value: PyValue, name: string): PyValue {
  const found = findAttribute(value, name);
  if (found === undefined) throw attributeError(value, name);
  return found;
}

// code-gauge-allow functionNcss 31 -- One step per place an attribute lookup may find a name.
function findAttribute(value: PyValue, name: string): PyValue | undefined {
  if (value instanceof PyClass) return classAttribute(value, name);
  if (value instanceof PyModule) return moduleAttribute(value, name);
  if (value instanceof PySuper) return superAttribute(value, name);
  if (isThreadLocal(value)) ensureThreadLocalDict(value);
  const cls = classOf(value);
  const special = specialAttribute(value, name);
  if (special !== undefined) return special;
  const attribute = cls.lookup(name);
  if (attribute === undefined) return ownDict(value)?.get(name) ?? typeDocOf(cls, name);
  if (attribute instanceof PyAttribute) {
    // A descriptor standing for what this grader's objects keep natively finds nothing where they keep nothing.
    if (!attribute.stands) return attribute.get(value);
    return ownDict(value)?.get(name) ?? attribute.fallback ?? typeDocOf(cls, name);
  }
  if (attribute instanceof PyDescriptor && isPropertyKind(attribute.cls)) return bindValue(attribute, value, cls);
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
  if (name === '__class__') return module.cls;
  const feature = module.unsupported.get(name);
  if (feature !== undefined) throw new UnsupportedFeatureError(feature);
  if (name === '__dict__') {
    checkNamespaceListing(module, 'モジュールの __dict__・vars()');
    completeNamespace(module);
    return namespaceDict(module.dict);
  }
  // A module's `__annotate__` is None until its code defines one, which reading it records, as CPython does.
  if (name === '__annotate__' && !module.dict.has(name)) module.dict.set(name, None);
  const value =
    name === '__annotations__' ? moduleAnnotations(module) : (module.dict.get(name) ?? importedModule(module, name));
  // A special name the module lacks is one its module object lacks, which programs and pydoc look for.
  if (value === undefined && module.partialFeature !== undefined && !/^__\w+__$/.test(name))
    throw new UnsupportedFeatureError(module.partialFeature);
  return value ?? moduleTypeAttribute(module, name);
}

/** An attribute of the module type, as `__getattribute__` or `__repr__`, bound to the module. */
function moduleTypeAttribute(module: PyModule, name: string): PyValue | undefined {
  const attribute = name.startsWith('__') ? module.cls.lookup(name) : undefined;
  return attribute instanceof PyBuiltinFunction ? bindValue(attribute, module, module.cls) : undefined;
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
  if (len !== undefined) return exactLength(value) > 0n;
  return true;
}

function builtinTruth(value: PyValue): boolean | undefined {
  if (value instanceof PyList || value instanceof PyTuple) return value.items.length > 0;
  if (value instanceof PyDict) return value.store.size > 0;
  if (value instanceof PySet) return value.table.size > 0;
  if (value instanceof PyRange) return value.length > 0n;
  return undefined;
}

/** The length of a value as a host number, for code that sizes or indexes a host array by it. */
export function lengthOf(value: PyValue): number {
  return Number(exactLength(value));
}

const MAX_SSIZE = (1n << 63n) - 1n;

/** Python's `len()`, exact up to CPython's Py_ssize_t limit. */
export function exactLength(value: PyValue): bigint {
  if (typeof value === 'string') return BigInt(strLength(value));
  if (overriding(value, '__len__') === undefined) {
    const length = builtinExactLength(value);
    if (length !== undefined) return length;
  }
  const len = lookupSpecial(value, '__len__');
  if (len === undefined) throw typeError(`object of type '${typeName(value)}' has no len()`);
  const length = toIndex(callValue(bindValue(len, value), []));
  if (length < 0n) throw pyError('ValueError', '__len__() should return >= 0');
  if (length > MAX_SSIZE) throw pyError('OverflowError', "cannot fit 'int' into an index-sized integer");
  return length;
}

function builtinExactLength(value: PyValue): bigint | undefined {
  if (value instanceof PyList || value instanceof PyTuple) return BigInt(value.items.length);
  if (value instanceof PyDict) return BigInt(value.store.size);
  if (value instanceof PySet) return BigInt(value.table.size);
  if (value instanceof PyDictView) return BigInt(value.dict.store.size);
  if (value instanceof PyClass && value.flags.isEnum) return BigInt((value.enumMembers ?? []).length);
  if (value instanceof PyRange) {
    if (value.length > MAX_SSIZE) throw pyError('OverflowError', 'Python int too large to convert to C ssize_t');
    return value.length;
  }
  return undefined;
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
  const iterator = getIterator(value);
  return { next: nextOf(iterator), held: iterator };
}

function iterateBuiltin(value: PyValue): NextFunction | undefined {
  if (typeof value === 'string') return iterateString(value);
  if (overriding(value, '__iter__') !== undefined) return undefined;
  return builtinIterateRaw(value);
}

/** Iterates a builtin iterable natively, ignoring any `__iter__` override on a subclass, or returns undefined. */
function builtinIterateRaw(value: PyValue): NextFunction | undefined {
  if (value instanceof PyList || value instanceof PyTuple) return iterateItems(value);
  if (typeof value === 'string') return iterateString(value);
  if (value instanceof PyRange) return iterateRange(value);
  if (value instanceof PyDict) return iterateDict(value, 'keys');
  if (value instanceof PyDictView) return iterateDict(value.dict, value.view);
  if (value instanceof PySet) return iterateSet(value);
  if (value instanceof PyIterator && (value.cls.isBuiltin || isNativeNext(value))) {
    // A native iterator may hand on items that only its own state held, such as groupby's pending item.
    const runtime = currentRuntime();
    return () => runtime.runNative(value.next);
  }
  if (isIteratorGenerator(value)) return iterateGenerator(value);
  if (value instanceof PyClass && value.flags.isEnum) return iterate(newList([...(value.enumMembers ?? [])]));
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

// code-gauge-allow functionCognitiveComplexity 18 -- The iterator, its reduction, and its __setstate__ share its position.
function iterateItems(sequence: PyList | PyTuple): NextFunction {
  let index = 0;
  // As in CPython, an iterator that reached the end stays there, even if the sequence grows.
  let exhausted = false;
  let retained = true;
  const next = withRemaining(
    () => {
      if (!exhausted && index < sequence.items.length) return sequence.items[index++];
      exhausted = true;
      retained = false;
      return DONE;
    },
    () => (exhausted ? 0 : Math.max(sequence.items.length - index, 0))
  );
  const isTuple = sequence instanceof PyTuple;
  return withState(next, {
    holds: () => (retained ? [sequence] : []),
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
  return iterateByIndex(
    value,
    () => characters.length,
    (index) => characters[index] as string,
    ''
  );
}

/**
 * Iterates the items of a sequence by their index, as the iterators of str and bytes do: one that reached the end
 * stays there, and it reduces to `iter(sequence)` and its index, or to `iter(empty)` at the end.
 */
export function iterateByIndex(
  sequence: PyValue,
  length: () => number,
  itemAt: (index: number) => PyValue,
  empty: PyValue
): NextFunction {
  let index = 0;
  let exhausted = false;
  const next = withRemaining(
    () => {
      if (!exhausted && index < length()) return itemAt(index++);
      exhausted = true;
      return DONE;
    },
    () => (exhausted ? 0 : Math.max(length() - index, 0))
  );
  return withState(next, {
    holds: () => (exhausted ? [] : [sequence]),
    reduce: () => (exhausted ? reduction('iter', [empty]) : reduction('iter', [sequence], BigInt(index))),
    setState: (state) => {
      if (!exhausted) index = clamp(state, 0, length());
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
  let exhausted = false;
  const next: NextFunction = () => {
    if (exhausted) return DONE;
    if (table.version !== version) throw pyError('RuntimeError', 'Set changed size during iteration');
    const step = entries.next();
    if (step.done) {
      consumed = size;
      exhausted = true;
      return DONE;
    }
    consumed++;
    return step.value.key;
  };
  const remainingItems = (): PyValue[] => [...table.entries()].slice(consumed).map((entry) => entry.key as PyValue);
  return withState(
    withRemaining(next, () => (table.version === version ? size - consumed : 0)),
    {
      holds: () => (exhausted ? [] : [set]),
      reduce: () => reduction('iter', [newList(consumed >= size ? [] : remainingItems())]),
    }
  );
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

/** Whether a subclass of a builtin iterator keeps its type's __next__, which advances it natively. */
function isNativeNext(iterator: PyIterator): boolean {
  return lookupSpecial(iterator, '__next__') instanceof PyBuiltinFunction;
}

/**
 * Whether the class of a value, a subclass of a builtin type, overrides one of that type's methods, which the native
 * fast paths for the type must then leave to the method.
 */
export function overridesBuiltin(value: PyObject, name: string): boolean {
  return !value.cls.isBuiltin && value.cls.lookup(name) !== value.cls.mro.find((cls) => cls.isBuiltin)?.lookup(name);
}

export function nextOf(iterator: PyValue): NextFunction {
  if (iterator instanceof PyIterator && (iterator.cls.isBuiltin || isNativeNext(iterator))) {
    const runtime = currentRuntime();
    return () => runtime.runNative(iterator.next);
  }
  if (isIteratorGenerator(iterator)) return () => currentRuntime().resumeGenerator(iterator);
  const next = lookupSpecial(iterator, '__next__');
  if (next === undefined) throw typeError(`iter() returned non-iterator of type '${typeName(iterator)}'`);
  const bound = bindValue(next, iterator);
  return () => {
    try {
      return callValue(bound, []);
    } catch (error) {
      if (error instanceof PyError && error.exception.cls.isSubclassOf(exceptionClassNamed('StopIteration'))) {
        releaseCaughtException(error);
        return DONE;
      }
      throw error;
    }
  };
}

// code-gauge-allow functionCognitiveComplexity 18 -- Indexing, terminal exceptions and cursor restoration share sequence iterator state.
function iterateSequence(value: PyValue): NextFunction {
  let index = 0n;
  let finished = false;
  const next: NextFunction = () => {
    if (finished) return DONE;
    try {
      const result = getItemOf(value, index);
      index++;
      return result;
    } catch (error) {
      if (error instanceof PyError && (isExceptionOf(error, 'IndexError') || isExceptionOf(error, 'StopIteration'))) {
        finished = true;
        releaseCaughtException(error);
        return DONE;
      }
      throw error;
    }
  };
  return withState(next, {
    holds: () => (finished ? [] : [value]),
    reduce: () => (finished ? reduction('iter', [newTuple([])]) : reduction('iter', [value], index)),
    setState: (state) => {
      if (!finished) index = state < 0n ? 0n : state;
    },
  });
}

// code-gauge-allow functionCognitiveComplexity 19 -- The iterator, its size check, and its reduction share its position.
function iterateDict(dict: PyDict, view: 'keys' | 'values' | 'items'): NextFunction {
  const { store } = dict;
  const { size, version } = store;
  const entries = store.liveEntries();
  let consumed = 0;
  let exhausted = false;
  const cached = view === 'items' ? new DictItemTuple() : undefined;
  const remainingItems = (): PyValue[] =>
    [...store.liveEntries()].slice(consumed).map((entry) => dictItemValue(entry, view));
  const next = withRemaining(
    () => {
      if (exhausted) return DONE;
      checkDictUnchanged(dict, size, version);
      const step = entries.next();
      if (step.done) {
        consumed = size;
        exhausted = true;
        return DONE;
      }
      consumed++;
      const entry = step.value;
      return cached?.item(entry) ?? dictItemValue(entry, view);
    },
    () => (store.size === size && (!dict.cls.flags.isOrderedDict || store.version === version) ? size - consumed : 0)
  );
  return withState(next, {
    holds: () => [...(exhausted ? [] : [dict]), ...(cached?.holds() ?? [])],
    reduce: () => reduction('iter', [newList(consumed >= size ? [] : remainingItems())]),
  });
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

/** Whether an error is a Python exception of the builtin class `name` or of a class derived from it. */
export function isExceptionOf(error: unknown, name: string): boolean {
  return error instanceof PyError && error.exception.cls.isSubclassOf(exceptionClassNamed(name));
}

/** All the items an iterable yields, with `notIterable` as the message for a value that gives no iterator. */
export function toArray(value: PyValue, notIterable?: string): PyValue[] {
  if ((value instanceof PyList || value instanceof PyTuple) && overriding(value, '__iter__') === undefined) {
    return [...value.items];
  }
  const next = notIterable === undefined ? iterate(value) : iterateOr(value, notIterable);
  const items: PyValue[] = [];
  const runtime = currentRuntime();
  // The items taken so far are only here while the iterator runs Python code.
  return runtime.runNative(() => {
    runtime.handToNative(items);
    for (let item = next(); item !== DONE; item = next()) {
      runtime.spend();
      items.push(item);
    }
    return items;
  });
}

/** The iterator object `iter()` returns. */
export function getIterator(value: PyValue): PyValue {
  if ((value instanceof PyIterator && value.cls.isBuiltin) || isIteratorGenerator(value)) return value;
  const iter = lookupSpecial(value, '__iter__');
  // A program's subclass of a builtin iterator, as of zip, iterates natively unless it defines __iter__.
  if (value instanceof PyIterator && (iter === undefined || iter instanceof PyBuiltinFunction)) return value;
  if (iter !== undefined && iter !== None) {
    const iterator = callValue(bindValue(iter, value), []);
    if (lookupSpecial(iterator, '__next__') === undefined) {
      throw typeError(`iter() returned non-iterator of type '${typeName(iterator)}'`);
    }
    return iterator;
  }
  const next = iterate(value);
  return nativeIterator(iteratorClass(iteratorNameOf(value)), next, () => [value]);
}

/** The iterator the `__iter__` of a builtin iterable returns, which iterates it natively whatever its class. */
export function builtinIterator(value: PyValue): PyValue {
  const next = builtinIterateRaw(value) ?? iterate(value);
  return nativeIterator(iteratorClass(iteratorNameOf(value)), next, () => [value]);
}

export function nativeIterator(cls: PyClass, next: NextFunction, fallback: () => PyValue[]): PyIterator {
  const state = stateOf(next);
  const holds = state?.holds ?? fallback;
  const advance = withRemaining(
    () => {
      const before = holds();
      const value = next();
      const retained = new Set(holds());
      currentRuntime().finalizer.release(
        before.filter((item) => !retained.has(item)),
        value === DONE ? [] : [value]
      );
      return value;
    },
    () => remainingOf(next) ?? 0
  );
  if (state) withState(advance, state);
  return new PyIterator(cls, advance, holds);
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
  if (value instanceof PyDict) return dictIteratorName(value, 'keys');
  if (value instanceof PyDictView) return dictIteratorName(value.dict, value.view);
  return 'iterator';
}

/**
 * The members of an enum class one by one, as the generator expressions of EnumType's `__iter__` and `__reversed__`,
 * whose names the generator takes.
 */
export function enumMemberGenerator(cls: PyClass, isReversed: boolean): PyGenerator {
  const members = isReversed ? [...(cls.enumMembers ?? [])].toReversed() : [...(cls.enumMembers ?? [])];
  let index = 0;
  return new PyGenerator(
    generatorClass,
    '<genexpr>',
    `EnumType.${isReversed ? '__reversed__' : '__iter__'}.<locals>.<genexpr>`,
    (input) => {
      if (input.error) throw input.error;
      return index < members.length ? { done: false, value: members[index++] } : { done: true, value: None };
    },
    () => members
  );
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

/** `super(type, obj)`, refusing an object that is neither an instance nor a subclass of the type as CPython does. */
export function newSuper(cls: PyClass, thisClass: PyClass, self: PyValue): PySuper {
  const selfClass = self instanceof PyClass && self.isSubclassOf(thisClass) ? self : classOf(self);
  if (!selfClass.isSubclassOf(thisClass)) {
    const described = self instanceof PyClass ? `type ${self.name}` : `instance of ${typeName(self)}`;
    throw typeError(`super(type, obj): obj (${described}) is not an instance or subtype of type (${thisClass.name}).`);
  }
  return new PySuper(cls, thisClass, self, selfClass);
}
