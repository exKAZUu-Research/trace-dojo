// The `abc` module. CPython writes ABCMeta in C (`_abc`); here it is a builtin subclass of `type` whose `__new__`
// records `__abstractmethods__`, which `object.__new__` refuses to instantiate, and whose `__instancecheck__` and
// `__subclasscheck__` add `__subclasshook__` and registered virtual subclasses to isinstance() and issubclass().
import { typeNewFromArguments } from '../classes';
import { builtin, method } from '../define';
import { defineNew } from '../instances';
import { registerModule } from '../modules';
import { callValue, getAttributeOrUndefined, isTruthy } from '../objects';
import type { Runtime } from '../runtime';
import { currentRuntime } from '../runtimeContext';
import {
  builtinClass,
  classmethodClass,
  classOf,
  newSet,
  None,
  NotImplemented,
  objectClass,
  propertyClass,
  pyError,
  staticmethodClass,
  typeClass,
  typeError,
} from '../types';
import { type Kwargs, PyClass, PyDescriptor, PyFunction, PyInstance, type PyValue } from '../values';

export const abcMetaClass = builtinClass('ABCMeta', typeClass, true);
abcMetaClass.module = 'abc';

export const abcClass = new PyClass('ABC', [objectClass], abcMetaClass);
abcClass.mro = [abcClass, objectClass];
abcClass.module = 'abc';
abcClass.isBaseType = true;
abcClass.dict.set('__abstractmethods__', newSet([], true));

/** The builtin placeholders of abstract methods, such as those of `numbers`, which a subclass must override. */
export const abstractPlaceholders = new Set<PyValue>();
/** Descriptors the deprecated `abstractproperty` and the like made abstract. */
const abstractDescriptors = new WeakSet<PyDescriptor>();

// Abstract methods --------------------------------------------------------------------------------------------------

function isAbstract(value: PyValue | undefined): boolean {
  if (value === undefined) return false;
  if (abstractPlaceholders.has(value)) return true;
  if (value instanceof PyDescriptor) {
    if (abstractDescriptors.has(value)) return true;
    return [value.fn, value.setter, value.deleter].some((fn) => fn !== undefined && fn !== None && isAbstract(fn));
  }
  if (value instanceof PyFunction) return isTruthy(value.dict.get('__isabstractmethod__') ?? false);
  if (value instanceof PyInstance) {
    const flag = getAttributeOrUndefined(value, '__isabstractmethod__');
    return flag !== undefined && isTruthy(flag);
  }
  return false;
}

/** Sets `__abstractmethods__` to the abstract methods a class has not implemented, as ABCMeta does when it creates one. */
function updateAbstractMethods(cls: PyClass): PyClass {
  const names = new Set<string>();
  for (const each of cls.mro) for (const name of each.dict.keys()) names.add(name);
  const abstract = [...names].filter((name) => isAbstract(cls.lookup(name)));
  cls.dict.set('__abstractmethods__', newSet(abstract, true));
  return cls;
}

defineNew(abcMetaClass, (meta, args, kwargs) => updateAbstractMethods(typeNewFromArguments(meta, args, kwargs)));

function markAbstract(fn: PyValue): PyValue {
  if (fn instanceof PyFunction) fn.dict.set('__isabstractmethod__', true);
  else if (fn instanceof PyDescriptor) abstractDescriptors.add(fn);
  else currentRuntime().setAttributeOf(fn, '__isabstractmethod__', true);
  return fn;
}

// Virtual subclasses ------------------------------------------------------------------------------------------------

/** The virtual subclasses that the ABCs of each run registered, which stay out of the shared builtin classes. */
const runRegistries = new WeakMap<Runtime, Map<PyClass, PyClass[]>>();

function registries(): Map<PyClass, PyClass[]> {
  const runtime = currentRuntime();
  let registry = runRegistries.get(runtime);
  if (!registry) {
    registry = new Map();
    runRegistries.set(runtime, registry);
  }
  return registry;
}

/** `ABCMeta.register` of the builtin ABCs, which programs share: makes `subclass` a virtual subclass of `abstract`. */
export function registerVirtual(abstract: PyClass, subclass: PyValue): PyValue {
  if (!(subclass instanceof PyClass)) throw typeError('Can only register classes');
  if (subclass.isSubclassOf(abstract)) return subclass;
  if (abstract.isSubclassOf(subclass)) throw pyError('RuntimeError', 'Refusing to create an inheritance cycle');
  subclass.registeredWith.push(abstract);
  return subclass;
}

/**
 * `ABCMeta.__subclasscheck__`: the subclass hook, the MRO and builtin registrations, and the virtual subclasses a run
 * registered on the class or on any of its subclasses.
 */
function abcSubclassCheck(cls: PyClass, candidate: PyClass): boolean {
  if (!cls.cls.isSubclassOf(abcMetaClass)) return candidate.isSubclassOf(cls);
  const hook = getAttributeOrUndefined(cls, '__subclasshook__');
  if (hook !== undefined) {
    const result = callValue(hook, [candidate]);
    if (result !== NotImplemented) return isTruthy(result);
  }
  if (candidate.isSubclassOf(cls)) return true;
  for (const [abc, registered] of registries()) {
    if (abc.isSubclassOf(cls) && registered.some((each) => abcSubclassCheck(each, candidate))) return true;
  }
  return false;
}

method(abcMetaClass, 'register', 'one', 1, 1, (cls, [subclass]) => {
  if (!(subclass instanceof PyClass)) throw typeError('Can only register classes');
  const abc = cls as PyClass;
  if (abcSubclassCheck(abc, subclass)) return subclass;
  if (abcSubclassCheck(subclass, abc)) throw pyError('RuntimeError', 'Refusing to create an inheritance cycle');
  const registry = registries().get(abc) ?? [];
  registry.push(subclass);
  registries().set(abc, registry);
  return subclass;
});
method(abcMetaClass, '__instancecheck__', 'one', 1, 1, (cls, [instance]) =>
  abcSubclassCheck(cls as PyClass, classOf(instance))
);
method(abcMetaClass, '__subclasscheck__', 'one', 1, 1, (cls, [subclass]) => {
  if (!(subclass instanceof PyClass)) throw typeError('issubclass() arg 1 must be a class');
  return abcSubclassCheck(cls as PyClass, subclass);
});
method(abcMetaClass, '_abc_registry_clear', 'none', 0, 0, (cls) => {
  registries().delete(cls as PyClass);
  return None;
});
method(abcMetaClass, '_abc_caches_clear', 'none', 0, 0, () => None);

// The module --------------------------------------------------------------------------------------------------------

function wrapAbstract(kind: PyClass): (args: PyValue[], kwargs: Kwargs) => PyValue {
  return ([fn]) => {
    markAbstract(fn);
    const descriptor = new PyDescriptor(kind, fn);
    abstractDescriptors.add(descriptor);
    return descriptor;
  };
}

registerModule(
  'abc',
  () =>
    new Map<string, PyValue>([
      ['ABCMeta', abcMetaClass],
      ['ABC', abcClass],
      ['abstractmethod', builtin('abstractmethod', 'one', 1, 1, ([fn]) => markAbstract(fn))],
      ['abstractclassmethod', builtin('abstractclassmethod', 'one', 1, 1, wrapAbstract(classmethodClass))],
      ['abstractstaticmethod', builtin('abstractstaticmethod', 'one', 1, 1, wrapAbstract(staticmethodClass))],
      [
        'abstractproperty',
        builtin('abstractproperty', 'expected', 0, 4, ([getter, setter, deleter, doc]) => {
          const descriptor = new PyDescriptor(propertyClass, getter ?? None, setter, deleter, doc);
          abstractDescriptors.add(descriptor);
          return descriptor;
        }),
      ],
      ['get_cache_token', builtin('get_cache_token', 'none', 0, 0, () => 0n)],
      [
        'update_abstractmethods',
        builtin('update_abstractmethods', 'one', 1, 1, ([cls]) =>
          cls instanceof PyClass && cls.cls.isSubclassOf(abcMetaClass) ? updateAbstractMethods(cls) : cls
        ),
      ],
    ])
);
