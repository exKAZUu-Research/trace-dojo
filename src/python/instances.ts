import { pyRepr } from './conversions';
import { enumLookup, isEnumClass } from './enums';
import { bindValue, callValue, toArray } from './objects';
import { currentRuntime } from './runtimeContext';
import {
  builtinFunctionClass,
  classOf,
  None,
  objectClass,
  staticmethodClass,
  typeClass,
  typeError,
  typeName,
} from './types';
import { type Kwargs, PyBuiltinFunction, PyClass, PyDescriptor, PyFunction, PyInstance, type PyValue } from './values';

type Create = (cls: PyClass, args: PyValue[], kwargs: Kwargs) => PyValue;

/** Calls a class: its metaclass's `__call__`, which `type.__call__` implements with `__new__` and `__init__`. */
export function instantiate(cls: PyClass, args: PyValue[], kwargs: Kwargs): PyValue {
  const meta = cls.cls;
  if (meta !== typeClass) {
    const call = meta.lookup('__call__');
    if (call !== undefined && call !== typeClass.dict.get('__call__')) {
      return callValue(bindValue(call, cls, meta), args, kwargs);
    }
  }
  return typeCall(cls, args, kwargs);
}

/** `type.__call__`: creates an instance with the class's `__new__` and initializes it with its `__init__`. */
export function typeCall(cls: PyClass, args: PyValue[], kwargs: Kwargs): PyValue {
  if (isEnumClass(cls)) return enumLookup(cls, args, kwargs);
  if (cls.construct) return cls.construct(cls, args, kwargs);
  const newMethod = cls.lookup('__new__');
  if (newMethod === objectNew()) {
    if (cls.isBuiltin) throw cannotCreate(cls);
    const init = cls.lookup('__init__');
    if (init === objectInit()) {
      if (hasArguments(args, kwargs)) throw takesNoArguments(cls);
      return newObject(cls);
    }
    const instance = newObject(cls);
    callInit(init, instance, args, kwargs);
    return instance;
  }
  const instance = callValue(staticTarget(newMethod), [cls, ...args], kwargs);
  const instanceClass = classOf(instance);
  if (!instanceClass.isSubclassOf(cls)) return instance;
  const init = instanceClass.lookup('__init__');
  if (init === objectInit()) objectInitImplementation(instance, args, kwargs);
  else callInit(init, instance, args, kwargs);
  return instance;
}

function callInit(init: PyValue | undefined, instance: PyValue, args: PyValue[], kwargs: Kwargs): void {
  const result =
    init instanceof PyFunction
      ? currentRuntime().callFunction(init, [instance, ...args], kwargs)
      : callValue(bindValue(init ?? None, instance), args, kwargs);
  if (result !== None) throw typeError(`__init__() should return None, not '${typeName(result)}'`);
}

/** The function a class's `__new__` entry stands for, which CPython calls as a static method. */
function staticTarget(newMethod: PyValue | undefined): PyValue {
  if (newMethod instanceof PyDescriptor && newMethod.cls === staticmethodClass) return newMethod.fn;
  return newMethod ?? None;
}

function hasArguments(args: PyValue[], kwargs: Kwargs): boolean {
  return args.length > 0 || (kwargs !== undefined && kwargs.size > 0);
}

function takesNoArguments(cls: PyClass): Error {
  return typeError(`${cls.name}() takes no arguments`);
}

let objectNewMethod: PyValue | undefined;
let objectInitMethod: PyValue | undefined;

// The methods are read once typeObject.ts, which imports this module, has defined them.
function objectNew(): PyValue | undefined {
  objectNewMethod ??= objectClass.dict.get('__new__');
  return objectNewMethod;
}

function objectInit(): PyValue | undefined {
  objectInitMethod ??= objectClass.dict.get('__init__');
  return objectInitMethod;
}

/** Creates a plain instance of a class, as `object.__new__` does once it has checked its arguments. */
function newObject(cls: PyClass): PyInstance {
  if (cls.isBuiltin && cls !== objectClass) throw cannotCreate(cls);
  checkNotAbstract(cls);
  currentRuntime().allocate(1);
  return new PyInstance(cls);
}

function cannotCreate(cls: PyClass): Error {
  return typeError(`cannot create '${cls.qualifiedName}' instances`);
}

/** Refuses a class whose `__abstractmethods__`, which `abc.ABCMeta` sets, names any method. */
function checkNotAbstract(cls: PyClass): void {
  const abstract = cls.dict.get('__abstractmethods__');
  if (abstract === undefined) return;
  const names = toArray(abstract)
    .map((name) => pyRepr(name))
    .toSorted();
  if (names.length === 0) return;
  throw typeError(
    `Can't instantiate abstract class ${cls.name} without an implementation for abstract method${names.length === 1 ? '' : 's'} ${names.join(', ')}`
  );
}

/** `object.__new__(cls, *args)`. */
export function objectNewImplementation(args: PyValue[], kwargs: Kwargs): PyValue {
  const cls = checkSubtype(objectClass, args);
  if (hasArguments(args.slice(1), kwargs)) {
    if (cls.lookup('__new__') !== objectNew()) {
      throw typeError('object.__new__() takes exactly one argument (the type to instantiate)');
    }
    if (cls.lookup('__init__') === objectInit()) throw takesNoArguments(cls);
  }
  return newObject(cls);
}

/** `object.__init__(self, *args)`. */
export function objectInitImplementation(self: PyValue, args: PyValue[], kwargs: Kwargs): PyValue {
  if (!hasArguments(args, kwargs)) return None;
  const cls = classOf(self);
  if (cls.lookup('__init__') !== objectInit()) {
    throw typeError('object.__init__() takes exactly one argument (the instance to initialize)');
  }
  if (cls.lookup('__new__') === objectNew()) {
    throw typeError(`${cls.name}.__init__() takes exactly one argument (the instance to initialize)`);
  }
  return None;
}

/**
 * Gives a builtin class the `__new__` that creates instances of its subclasses, which programs reach through
 * `super().__new__(cls, ...)` and which calling a subclass uses.
 */
export function defineNew(cls: PyClass, create: Create): void {
  cls.newInstance = create;
  cls.dict.set(
    '__new__',
    new PyBuiltinFunction(
      builtinFunctionClass,
      '__new__',
      (args, kwargs) => create(checkSubtype(cls, args), args.slice(1), kwargs),
      cls,
      'static',
      cls.name
    )
  );
}

/**
 * Gives a builtin class that creates its instances by `construct` the `__new__` CPython's type has in its dictionary,
 * which creates them the same way.
 */
export function defineConstructingNew(cls: PyClass): void {
  const construct = cls.construct;
  if (!construct) return;
  const create = (args: PyValue[], kwargs: Kwargs): PyValue =>
    construct(checkSubtype(cls, args), args.slice(1), kwargs);
  cls.dict.set('__new__', new PyBuiltinFunction(builtinFunctionClass, '__new__', create, cls, 'static', cls.name));
}

/** The classes whose builtin `__new__` stands for one CPython writes in Python, which tp_new_wrapper's check skips. */
const pythonLevelNews = new WeakSet<PyClass>();

const builtinNew = (each: PyClass): boolean =>
  !pythonLevelNews.has(each) && each.dict.get('__new__') instanceof PyBuiltinFunction;

/** Gives a class the `__new__` that creates its instances, standing for one CPython writes in Python. */
export function definePythonLevelNew(cls: PyClass, create: Create): void {
  defineNew(cls, create);
  pythonLevelNews.add(cls);
}

/** Whether a class's `__new__` stands for a function CPython writes in Python, which has no `__self__`. */
export function hasPythonLevelNew(cls: PyClass): boolean {
  return pythonLevelNews.has(cls);
}

/** Checks the class `owner.__new__` receives first, as CPython's tp_new_wrapper does. */
function checkSubtype(owner: PyClass, args: PyValue[]): PyClass {
  const qualified = `${owner.name}.__new__`;
  if (args.length === 0) throw typeError(`${qualified}(): not enough arguments`);
  const [cls] = args;
  if (!(cls instanceof PyClass)) throw typeError(`${qualified}(X): X is not a type object (${typeName(cls)})`);
  if (!cls.isSubclassOf(owner))
    throw typeError(`${qualified}(${cls.name}): ${cls.name} is not a subtype of ${owner.name}`);
  const effective = cls.mro.find(builtinNew);
  const ownerNew = owner.mro.find(builtinNew)?.dict.get('__new__');
  if (effective !== undefined && effective.dict.get('__new__') !== ownerNew) {
    throw typeError(`${qualified}(${cls.name}) is not safe, use ${effective.name}.__new__()`);
  }
  return cls;
}
