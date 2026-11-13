// The `abc` module, CPython's `Lib/abc.py` over a native `_abc`. ABCMeta and ABC are classes every run shares, since
// the numbers ABCs and Fraction, which this grader writes natively, are instances of ABCMeta; their namespaces are
// the ones CPython's code gives them, from one run of that code, while the registries and caches of `_abc` and its
// cache token are each run's own.
import { sharedPythonClasses } from '../annotations';
import { isSubclass } from '../builtins';
import { checkShortcuts } from '../checkShortcuts';
import { builtin } from '../define';
import { inheritCollectionKind, setCollectionFlags } from '../matching';
import { addModuleCreationHook, registerModule } from '../modules';
import { callValue, getAttribute, getAttributeOrUndefined, isTruthy, toArray } from '../objects';
import type { Runtime } from '../runtime';
import { currentRuntime } from '../runtimeContext';
import { sharedNamespaceModules } from '../sharedNamespaces';
import { runModuleSource } from '../sourceModules';
import {
  builtinClass,
  classOf,
  exceptionClassNamed,
  newException,
  newSet,
  newTuple,
  None,
  NotImplemented,
  objectClass,
  pyError,
  typeClass,
  typeError,
} from '../types';
import {
  PyBoundMethod,
  PyClass,
  PyDescriptor,
  PyError,
  PyFunction,
  PyInstance,
  PyObject,
  PyOpaque,
  type PyValue,
} from '../values';
import { weakReferenceTo } from '../weakReferences';
import { OWN_REGISTRATIONS, REGISTERING_IMPORTS, STARTUP_TOKEN } from './abcRegistrations';
import { ABC_SOURCE } from './abcSource';

export const abcMetaClass = builtinClass('ABCMeta', typeClass, true);
abcMetaClass.module = 'abc';

export const abcClass = new PyClass('ABC', [objectClass], abcMetaClass);
abcClass.mro = [abcClass, objectClass];
abcClass.module = 'abc';
abcClass.isBaseType = true;

sharedPythonClasses.add(abcMetaClass);
sharedPythonClasses.add(abcClass);

/** `_abc._abc_data`, the class of the `_abc_impl` that `_abc_init` gives each ABC. */
const abcDataClass = builtinClass('_abc_data');
abcDataClass.module = '_abc';

// Each run's registries, caches, and token -------------------------------------------------------------------------

interface AbcData {
  registry: Set<PyClass>;
  cache: Set<PyValue>;
  negative: Set<PyValue>;
  negativeVersion: number;
}

interface AbcState {
  /** `get_cache_token()`, which each registration increments. */
  token: number;
  data: Map<PyClass, AbcData>;
  /** The direct subclasses of each ABC, in the order they were created, which `__subclasscheck__` asks. */
  subclasses: Map<PyClass, PyClass[]>;
  /** The modules whose registrations at import the token counts. */
  counted: Set<string>;
  /** Whether every registration counts, as while `_collections_abc` runs as at CPython's startup. */
  countLibrary: boolean;
  /** How many modules the run is creating, inside one another. */
  creating: number;
  /** The index of the running frame when each check of `_abc` running began, innermost last. */
  checkFrames: number[];
}

const states = new WeakMap<Runtime, AbcState>();

function stateOf(runtime: Runtime = currentRuntime()): AbcState {
  let state = states.get(runtime);
  if (!state) {
    state = {
      token: STARTUP_TOKEN,
      data: new Map(),
      subclasses: new Map(),
      counted: new Set(),
      countLibrary: false,
      creating: 0,
      checkFrames: [],
    };
    states.set(runtime, state);
  }
  return state;
}

function dataOf(cls: PyClass): AbcData {
  const state = stateOf();
  let data = state.data.get(cls);
  if (!data) {
    // abc.ABC dates from CPython's startup, before any registration.
    const negativeVersion = cls === abcClass ? 0 : state.token;
    data = { registry: new Set(), cache: new Set(), negative: new Set(), negativeVersion };
    state.data.set(cls, data);
  }
  return data;
}

/** Records a subclass of an ABC that this grader creates natively, as `__subclasses__()` of CPython's would list it. */
export function noteSubclass(runtime: Runtime, base: PyClass, cls: PyClass): void {
  const { subclasses } = stateOf(runtime);
  subclasses.set(base, [...(subclasses.get(base) ?? []), cls]);
  dataOf(cls);
}

/** Makes `subclass` a virtual subclass of `abstract` for native code, which asks it without a run. */
export function registerVirtual(abstract: PyClass, subclass: PyClass): void {
  subclass.registeredWith.push(abstract);
}

// Abstract methods --------------------------------------------------------------------------------------------------

function isAbstract(value: PyValue | undefined): boolean {
  if (value === undefined) return false;
  if (value instanceof PyDescriptor && value.cls.isBuiltin) {
    // property, classmethod, and staticmethod are abstract when one of their functions is.
    return [value.fn, value.setter, value.deleter].some((fn) => fn !== undefined && fn !== None && isAbstract(fn));
  }
  if (value instanceof PyFunction) return isTruthy(value.dict.get('__isabstractmethod__') ?? false);
  if (value instanceof PyInstance || value instanceof PyDescriptor || value instanceof PyBoundMethod) {
    return isTruthy(getAttributeOrUndefined(value, '__isabstractmethod__') ?? false);
  }
  return false;
}

/** `compute_abstract_methods` of `_abc`: the class's own abstract methods, then those of its bases it leaves abstract. */
function abstractMethodsOf(cls: PyClass): string[] {
  const names = new Set<string>();
  for (const [name, value] of cls.dict) if (isAbstract(value)) names.add(name);
  for (const base of cls.bases) {
    const inherited = getAttributeOrUndefined(base, '__abstractmethods__');
    if (inherited === undefined) continue;
    for (const name of toArray(inherited)) {
      if (typeof name !== 'string') continue;
      if (isAbstract(getAttributeOrUndefined(cls, name))) names.add(name);
    }
  }
  return [...names];
}

// _abc ---------------------------------------------------------------------------------------------------------------

function asClass(value: PyValue | undefined): PyClass {
  if (!(value instanceof PyClass)) throw typeError('Can only register classes');
  return value;
}

function abcInit(cls: PyValue): PyValue {
  if (!(cls instanceof PyClass)) return None;
  cls.dict.set('__abstractmethods__', newSet(abstractMethodsOf(cls), true));
  cls.dict.set('_abc_impl', new PyOpaque(abcDataClass, '', undefined));
  // CPython moves the flags that make a class a sequence or a mapping to match statements out of its namespace.
  const flags = cls.dict.get('__abc_tpflags__');
  if (flags !== undefined) {
    setCollectionFlags(cls, flags);
    cls.dict.delete('__abc_tpflags__');
  }
  dataOf(cls);
  const runtime = currentRuntime();
  for (const base of cls.bases) noteSubclass(runtime, base, cls);
  return None;
}

/** `_abc_register`, which counts toward the token when the program registers, or `count` says so. */
export function abcRegister(cls: PyClass, subclass: PyValue, count: boolean): PyValue {
  const sub = asClass(subclass);
  if (isSubclass(sub, cls)) return sub;
  if (isSubclass(cls, sub)) throw pyError('RuntimeError', 'Refusing to create an inheritance cycle');
  dataOf(cls).registry.add(sub);
  inheritCollectionKind(cls, sub);
  const state = stateOf();
  if (count || state.countLibrary) state.token += 1;
  return sub;
}

/** Whether the code that called `ABCMeta.register`, whose frame is the running one, is the program's. */
function calledByProgram(): boolean {
  const runtime = currentRuntime();
  const caller = runtime.frames.at(-2);
  return caller !== undefined && !runtime.libraryNamespaces.has(caller.globals);
}

function callCheck(cls: PyClass, subclass: PyValue): PyValue {
  const check = cls.cls.lookup('__subclasscheck__');
  const shortcut = check === undefined ? undefined : checkShortcuts.get(check);
  if (shortcut && cls.lookup('__subclasscheck__') === undefined) return shortcut(cls, subclass);
  return callValue(getAttribute(cls, '__subclasscheck__'), [subclass]);
}

/**
 * Whether the frame at `index` called the innermost check `_abc` is running, which CPython's ABCMeta runs from its
 * frame in abc, as typing's `_caller` asks.
 */
export function nativeCheckCaller(index: number): boolean {
  return stateOf().checkFrames.at(-1) === index;
}

/** Runs a check of `_abc`, noting the frame it runs in. */
function inCheck<T>(run: () => T): T {
  const { checkFrames } = stateOf();
  checkFrames.push(currentRuntime().frames.length - 1);
  try {
    return run();
  } finally {
    checkFrames.pop();
  }
}

function abcInstanceCheck(cls: PyClass, instance: PyValue): PyValue {
  const subclass = getAttribute(instance, '__class__');
  const data = dataOf(cls);
  if (data.cache.has(subclass)) return true;
  const subtype = classOf(instance);
  if (subtype === subclass) {
    if (data.negativeVersion === stateOf().token && data.negative.has(subclass)) return false;
    return callCheck(cls, subclass);
  }
  const result = callCheck(cls, subclass);
  return isTruthy(result) ? result : callCheck(cls, subtype);
}

/** `_abc_subclasscheck`: the caches, the subclass hook, the MRO, the registry, and the subclasses, in CPython's order. */
function abcSubclassCheck(cls: PyClass, subclass: PyValue): boolean {
  if (!(subclass instanceof PyClass)) throw typeError('issubclass() arg 1 must be a class');
  const data = dataOf(cls);
  const state = stateOf();
  if (data.cache.has(subclass)) return true;
  if (data.negativeVersion < state.token) {
    data.negative.clear();
    data.negativeVersion = state.token;
  } else if (data.negative.has(subclass)) {
    return false;
  }
  const hook = subclassHook(cls, subclass);
  // A class in the registry itself is found without being cached.
  if (hook === undefined && !subclass.mro.includes(cls) && data.registry.has(subclass)) return true;
  const result = hook ?? isDerived(cls, subclass);
  (result ? data.cache : data.negative).add(subclass);
  return result;
}

/** What `cls.__subclasshook__(subclass)` says, or undefined for NotImplemented. */
function subclassHook(cls: PyClass, subclass: PyClass): boolean | undefined {
  const hook = callValue(getAttribute(cls, '__subclasshook__'), [subclass]);
  if (hook === true || hook === false) return hook;
  if (hook === NotImplemented) return undefined;
  const message = '__subclasshook__ must return either False, True, or NotImplemented';
  throw new PyError(newException(exceptionClassNamed('AssertionError'), [message]));
}

/** Whether `subclass` derives from `cls`, from a class registered with it, or from one of its subclasses. */
function isDerived(cls: PyClass, subclass: PyClass): boolean {
  if (subclass.mro.includes(cls)) return true;
  if ([...dataOf(cls).registry].some((registered) => isSubclass(subclass, registered))) return true;
  return (stateOf().subclasses.get(cls) ?? []).some((each) => isSubclass(subclass, each));
}

function weakSet(items: Iterable<PyValue>): PyValue {
  return newSet([...items].filter((item) => item instanceof PyObject).map((item) => weakReferenceTo(item)));
}

const natives = new Map<string, PyValue>([
  ['get_cache_token', builtin('get_cache_token', 'none', 0, 0, () => BigInt(stateOf().token))],
  ['_abc_init', builtin('_abc_init', 'one', 1, 1, ([cls]) => abcInit(cls as PyValue))],
  [
    '_abc_register',
    builtin('_abc_register', 'expected', 2, 2, ([cls, subclass]) =>
      abcRegister(cls as PyClass, subclass as PyValue, calledByProgram())
    ),
  ],
  [
    '_abc_instancecheck',
    builtin('_abc_instancecheck', 'expected', 2, 2, ([cls, instance]) =>
      abcInstanceCheck(cls as PyClass, instance as PyValue)
    ),
  ],
  [
    '_abc_subclasscheck',
    builtin('_abc_subclasscheck', 'expected', 2, 2, ([cls, subclass]) =>
      abcSubclassCheck(cls as PyClass, subclass as PyValue)
    ),
  ],
  [
    '_get_dump',
    builtin('_get_dump', 'one', 1, 1, ([cls]) => {
      const data = dataOf(cls as PyClass);
      return newTuple([
        weakSet(data.registry),
        weakSet(data.cache),
        weakSet(data.negative),
        BigInt(data.negativeVersion),
      ]);
    }),
  ],
  [
    '_reset_registry',
    builtin('_reset_registry', 'one', 1, 1, ([cls]) => {
      dataOf(cls as PyClass).registry.clear();
      return None;
    }),
  ],
  [
    '_reset_caches',
    builtin('_reset_caches', 'one', 1, 1, ([cls]) => {
      const data = dataOf(cls as PyClass);
      data.cache.clear();
      data.negative.clear();
      return None;
    }),
  ],
]);

registerModule('_abc', () => {
  const module = new Map<string, PyValue>([['__doc__', 'Module contains faster C implementation of abc.ABCMeta']]);
  for (const name of [
    'get_cache_token',
    '_abc_init',
    '_abc_register',
    '_abc_instancecheck',
    '_abc_subclasscheck',
    '_get_dump',
    '_reset_registry',
    '_reset_caches',
  ]) {
    module.set(name, natives.get(name) as PyValue);
  }
  return module;
});

// The classes every run shares ---------------------------------------------------------------------------------------

/** The namespace where abc.py ran for the methods of ABCMeta, whose frames, as a library's, stay out of traces. */
const sharedNamespace = new Map<string, PyValue>([['__name__', 'abc']]);
sharedNamespaceModules.set(sharedNamespace, 'abc');
let shared = false;

/** A value of the namespace where abc.py ran for the shared classes. */
export function sharedAbcValue(name: string): PyValue {
  return sharedNamespace.get(name) ?? None;
}

/** Gives a shared class the namespace of the class CPython's code created, whose methods now belong to it. */
export function adoptNamespace(target: PyClass, source: PyClass): void {
  target.dict.clear();
  for (const [key, value] of source.dict) target.dict.set(key, value);
  const doc = source.dict.get('__doc__');
  target.doc = typeof doc === 'string' ? doc : undefined;
  for (const value of target.dict.values()) {
    const fn = value instanceof PyDescriptor ? value.fn : value;
    if (fn instanceof PyFunction && fn.classCell) fn.classCell.value = target;
  }
}

/** Runs abc.py once for the classes every run shares, and lets this run call their methods as library code. */
function shareClasses(runtime: Runtime): void {
  runtime.addLibraryNamespace(sharedNamespace);
  if (shared) return;
  shared = true;
  runModuleSource(runtime, sharedNamespace, ABC_SOURCE);
  adoptNamespace(abcMetaClass, sharedNamespace.get('ABCMeta') as PyClass);
  // ABCMeta's checks only call _abc's, which isinstance() and issubclass() call directly.
  checkShortcuts.set(abcMetaClass.dict.get('__instancecheck__') as PyValue, (cls, value) =>
    inCheck(() => abcInstanceCheck(cls, value))
  );
  checkShortcuts.set(abcMetaClass.dict.get('__subclasscheck__') as PyValue, (cls, value) =>
    inCheck(() => abcSubclassCheck(cls, value))
  );
  sharedNamespace.set('ABCMeta', abcMetaClass);
  adoptNamespace(abcClass, sharedNamespace.get('ABC') as PyClass);
  sharedNamespace.set('ABC', abcClass);
}

registerModule('abc', (runtime, namespace) => {
  shareClasses(runtime);
  runModuleSource(runtime, namespace, ABC_SOURCE);
  // The classes of this run's code give way to the shared ones, in their places in the namespace.
  namespace.set('ABCMeta', abcMetaClass);
  namespace.set('ABC', abcClass);
  return new Map();
});

// The cache token's count of what imports register -------------------------------------------------------------------

/**
 * Counts what CPython's import of a module the program imports registers, along with the modules CPython's code of
 * that module imports, which may differ from the ones this grader's code imports.
 */
function countImport(runtime: Runtime, state: AbcState, name: string): void {
  for (const registering of REGISTERING_IMPORTS.get(name) ?? []) {
    if (state.counted.has(registering)) continue;
    state.counted.add(registering);
    if (registering === 'numbers' || registering === '_decimal') {
      // These modules register their classes here when imported, which counts.
      const module = registering === 'numbers' ? 'numbers' : 'decimal';
      if (module !== name) runtime.importModule(module);
    } else {
      state.token += OWN_REGISTRATIONS[registering] ?? 0;
    }
  }
}

addModuleCreationHook((runtime, name) => {
  const state = stateOf(runtime);
  if (state.creating === 0 && !runtime.inLibraryCode()) countImport(runtime, state, name);
  state.creating += 1;
  // CPython's startup imports `_collections_abc` before any other registration, which the startup token counts.
  const token = state.token;
  const startup = name === 'collections.abc';
  if (startup) {
    state.token = 0;
    state.countLibrary = true;
  }
  return () => {
    state.creating -= 1;
    if (startup) {
      state.token = token;
      state.countLibrary = false;
    }
  };
});
