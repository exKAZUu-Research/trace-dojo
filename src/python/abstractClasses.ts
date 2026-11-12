import { applyCollectionFlags, registerCollectionKind } from './matching';
import { bindValue, callValue, getAttributeOrUndefined, isTruthy } from './objects';
import { currentRuntime } from './runtimeContext';
import { builtinClass, newSet, None, NotImplemented, pyError, typeClass, typeError } from './types';
import { PyClass, PyFunction, PySet, type PyValue } from './values';

/**
 * Abstract base classes as `abc.ABCMeta` makes them, for the classes of collections.abc and their subclasses: they
 * count registered and structurally matching classes as subclasses, and refuse to be instantiated while they have
 * abstract methods.
 */

export const abcMetaClass = builtinClass('ABCMeta', typeClass);
abcMetaClass.module = 'abc';

/** Makes a class an abstract base class, as `metaclass=ABCMeta` (or a subclass of it) does. */
export function initAbstractClass(cls: PyClass, metaclass?: PyClass): void {
  cls.abc = { registry: [] };
  applyCollectionFlags(cls);
  cls.cls = metaclass ?? cls.bases.find((base) => base.abc)?.cls ?? abcMetaClass;
  updateAbstractMethods(cls);
}

/** `abc.update_abstractmethods`: recomputes the abstract methods of an abstract base class. */
export function updateAbstractMethods(cls: PyClass): void {
  if (!cls.abc) return;
  const abstracts = new Set<string>();
  for (const base of cls.bases) {
    for (const name of abstractMethodsOf(base)) {
      const value = cls.lookup(name);
      if (value !== undefined && isAbstractMethod(value)) abstracts.add(name);
    }
  }
  for (const [name, value] of cls.dict) if (isAbstractMethod(value)) abstracts.add(name);
  cls.dict.set('__abstractmethods__', newSet([...abstracts], true));
}

function abstractMethodsOf(cls: PyClass): string[] {
  const value = cls.dict.get('__abstractmethods__');
  if (!(value instanceof PySet) || !cls.abc) return [];
  return value.table.keys().filter((name) => typeof name === 'string');
}

function isAbstractMethod(value: PyValue): boolean {
  if (value instanceof PyFunction) return value.dict.get('__isabstractmethod__') === true;
  const flag = typeof value === 'object' ? getAttributeOrUndefined(value, '__isabstractmethod__') : undefined;
  return flag !== undefined && isTruthy(flag);
}

/** The TypeError for instantiating a class that still has abstract methods, if it has any. */
export function abstractInstantiationError(cls: PyClass): Error | undefined {
  if (!cls.abc) return undefined;
  const names = abstractMethodsOf(cls).toSorted();
  if (names.length === 0) return undefined;
  const methods = names.map((name) => `'${name}'`).join(', ');
  return typeError(
    `Can't instantiate abstract class ${cls.name} without an implementation for abstract method${names.length === 1 ? '' : 's'} ${methods}`
  );
}

/** `ABCMeta.__subclasscheck__`: the class's `__subclasshook__`, then inheritance, registration, and its subclasses. */
export function abstractSubclassCheck(
  abc: PyClass,
  cls: PyClass,
  isSubclass: (cls: PyClass, of: PyClass) => boolean
): boolean {
  const hook = abc.lookup('__subclasshook__');
  if (hook !== undefined) {
    const result = callValue(bindValue(hook, abc, abc), [cls]);
    if (result !== NotImplemented) return isTruthy(result);
  }
  if (cls.mro.includes(abc)) return true;
  const registry = abc.abc?.registry ?? [];
  if (registry.some((registered) => isSubclass(cls, registered))) return true;
  return currentRuntime()
    .subclassesOf(abc)
    .some((subclass) => isSubclass(cls, subclass));
}

let invalidationCount = 0;

/** `abc.get_cache_token()`: the number of registrations so far, which singledispatch's cache depends on. */
export function abcInvalidationCount(): number {
  return invalidationCount;
}

/** `ABCMeta.register`, which makes a class a virtual subclass. */
export function registerVirtualSubclass(
  abc: PyClass,
  subclass: PyValue,
  isSubclass: (cls: PyClass, of: PyClass) => boolean
): PyValue {
  if (!(subclass instanceof PyClass)) throw typeError('Can only register classes');
  if (isSubclass(subclass, abc)) return subclass;
  if (isSubclass(abc, subclass)) throw pyError('RuntimeError', 'Refusing to create an inheritance cycle');
  abc.abc?.registry.push(subclass);
  invalidationCount++;
  registerCollectionKind(abc, subclass, (cls) => currentRuntime().subclassesOf(cls));
  return subclass;
}

/** `_collections_abc._check_methods`: whether the class defines each method, NotImplemented if one is None or missing. */
export function checkMethods(cls: PyClass, methods: readonly string[]): PyValue {
  for (const name of methods) {
    const owner = cls.mro.find((each) => each.dict.has(name));
    if (owner === undefined || owner.dict.get(name) === None) return NotImplemented;
  }
  return true;
}
