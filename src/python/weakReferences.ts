import { addressOf } from './conversions';
import { method } from './define';
import { findReachableObjects } from './garbageCollection';
import { pyHash } from './hashing';
import { defineNew } from './instances';
import { defineProperty, defineSlot } from './modules/numberSupport';
import { callValue } from './objects';
import { equals } from './operators';
import { currentRuntime } from './runtimeContext';
import { builtinClass, classOf, defineMethod, None, NotImplemented, typeError } from './types';
import { reportUnraisable } from './unraisable';
import { UnsupportedFeatureError } from './unsupported';
import {
  PyBoundMethod,
  PyClass,
  PyError,
  PyFunction,
  PyGenerator,
  PyInstance,
  PyModule,
  PyObject,
  PyOpaque,
  PySet,
  type PyValue,
} from './values';

/**
 * `weakref.ref`, which refers to an object without keeping it alive. CPython frees an object as soon as nothing refers
 * to it, which this grader tells by whether the program can still reach it when the reference is called.
 */
export const weakrefClass = builtinClass('ReferenceType');
weakrefClass.module = 'weakref';
weakrefClass.isBaseType = true;

/** The weak reference to each object, which CPython reuses for every `ref(obj)` without a callback. */
const references = new WeakMap<PyObject, PyOpaque>();

interface Reference {
  referent: PyObject;
  /** The referent's hash, which CPython keeps once computed so that a dead reference still hashes. */
  hash?: bigint;
  /** What the reference calls with itself when its referent is freed. */
  callback?: PyValue;
}

defineNew(weakrefClass, (cls, args, kwargs) => {
  const [referent, callback] = args;
  if (args.length === 0) throw typeError('__new__ expected at least 1 argument, got 0');
  if (cls === weakrefClass && args.length > 2)
    throw typeError(`__new__ expected at most 2 arguments, got ${args.length}`);
  if (cls === weakrefClass && kwargs && kwargs.size > 0) throw typeError('ref() takes no keyword arguments');
  return weakReference(referent, callback === None ? undefined : callback, cls);
});
// A subclass's __init__ receives the arguments of __new__, which ref's own __init__ accepts.
defineMethod(weakrefClass, '__init__', () => None);

function weakReference(referent: PyValue, callback: PyValue | undefined, cls: PyClass): PyOpaque {
  if (!isWeaklyReferenceable(referent)) {
    throw typeError(`cannot create weak reference to '${classOf(referent).name}' object`);
  }
  // CPython shares the one reference without a callback; each reference with a callback is a new one.
  if (callback === undefined && cls === weakrefClass) {
    let reference = references.get(referent);
    if (!reference) {
      reference = new PyOpaque(weakrefClass, '', { referent } satisfies Reference);
      references.set(referent, reference);
      noteReference(referent, reference, 'ref');
    }
    return reference;
  }
  const reference = new PyOpaque(cls, '', { referent, callback } satisfies Reference);
  if (callback !== undefined) watchedReferences(currentRuntime()).push(reference);
  noteReference(referent, reference, 'other');
  return reference;
}

/**
 * The weak references and proxies to each object in the order of CPython's list of them: the reference without a
 * callback first, then the proxy without one, then the others, newest first.
 */
const referenceLists = new WeakMap<PyObject, { value: PyValue; kind: 'ref' | 'proxy' | 'other' }[]>();

/** Places a new weak reference or proxy in its object's list, as CPython's insert_weakref does. */
export function noteReference(referent: PyObject, value: PyValue, kind: 'ref' | 'proxy' | 'other'): void {
  const list = referenceLists.get(referent) ?? [];
  referenceLists.set(referent, list);
  const ref = list.findIndex((entry) => entry.kind === 'ref');
  const proxy = list.findIndex((entry) => entry.kind === 'proxy');
  let at = 0;
  if (kind === 'proxy') at = ref + 1;
  else if (kind === 'other') at = Math.max(ref, proxy) + 1;
  list.splice(at, 0, { value, kind });
}

/** The weak references and proxies to an object that the program can still reach, as `weakref.getweakrefs` lists. */
export function liveReferencesOf(referent: PyValue): PyValue[] {
  if (!(referent instanceof PyObject)) return [];
  const list = referenceLists.get(referent);
  if (!list || list.length === 0) return [];
  const reachable = currentRuntime().reachableObjects();
  const live = list.filter((entry) => reachable.has(entry.value as object));
  referenceLists.set(referent, live);
  return live.map((entry) => entry.value);
}

/** A weak reference for a proxy, which is the proxy's own and stays out of its object's list. */
export function proxyReference(referent: PyValue, callback: PyValue | undefined): PyOpaque {
  if (!isWeaklyReferenceable(referent)) {
    throw typeError(`cannot create weak reference to '${classOf(referent).name}' object`);
  }
  const reference = new PyOpaque(weakrefClass, '', { referent, callback } satisfies Reference);
  if (callback !== undefined) watchedReferences(currentRuntime()).push(reference);
  return reference;
}

/** The references with a callback whose referent each run still has, in the order they were created. */
const watched = new WeakMap<object, PyOpaque[]>();
/** The objects in reference cycles that `gc.collect()` freed, which their references no longer refer to. */
const collected = new WeakSet<PyObject>();

function watchedReferences(runtime: object): PyOpaque[] {
  let list = watched.get(runtime);
  if (!list) {
    list = [];
    watched.set(runtime, list);
  }
  return list;
}

/** Whether some reference waits to call its callback, which makes the runtime look for freed objects. */
export function hasWeakCallbacks(runtime: object): boolean {
  return (watched.get(runtime)?.length ?? 0) > 0;
}

/**
 * Calls the callbacks of the references whose referents nothing reaches any more, as CPython does when it frees them,
 * keeping alive `inFlight`, values held only by the host. An object in a reference cycle is freed only by
 * `gc.collect()` (`collectCycles`), as CPython's cycle collector would at a time this grader cannot tell.
 */
export function runWeakCallbacks(inFlight: unknown[] = [], collectCycles = false): void {
  const runtime = currentRuntime();
  const list = watched.get(runtime);
  if (!list || list.length === 0) return;
  // This runs after every statement, so a walk over everything the program reaches, which library code makes long,
  // is left for when some referent is not held directly.
  if (!collectCycles && list.every((reference) => isHeldDirectly(runtime, referenceOf(reference).referent, inFlight)))
    return;
  const reachable = runtime.reachableObjects(inFlight);
  const dead = list.filter((reference) => {
    const { referent } = referenceOf(reference);
    if (reachable.has(referent)) return false;
    return collectCycles || !findReachableObjects(referencesOf(referent)).has(referent);
  });
  if (dead.length === 0) return;
  watched.set(
    runtime,
    list.filter((reference) => !dead.includes(reference))
  );
  for (const reference of dead) {
    const { referent, callback } = referenceOf(reference);
    collected.add(referent);
    // A reference that is itself freed calls nothing.
    if (!reachable.has(reference) || callback === undefined) continue;
    callCallback(callback, reference);
  }
}

/** Whether the program holds `object` in a variable or a module holds it as a global, so it is certainly alive. */
function isHeldDirectly(runtime: ReturnType<typeof currentRuntime>, object: unknown, inFlight: unknown[]): boolean {
  if (inFlight.includes(object) || runtime.evaluator.handledExceptions.includes(object as PyInstance)) return true;
  return runtime.frames.some(
    (frame) =>
      frame.locals.values().some((value) => value === object) ||
      frame.globals.values().some((value) => value === object) ||
      frame.cells.values().some((cell) => cell.value === object) ||
      frame.temporaries.includes(object as PyValue)
  );
}

/**
 * Calls the callbacks of the references to an object that reference counting frees, newest first, as CPython does
 * right after the object's `__del__`.
 */
export function runCallbacksOf(referent: PyObject): void {
  const runtime = currentRuntime();
  const list = watched.get(runtime);
  if (!list || list.length === 0) return;
  const dead = list.filter((reference) => referenceOf(reference).referent === referent);
  if (dead.length === 0) return;
  watched.set(
    runtime,
    list.filter((reference) => !dead.includes(reference))
  );
  collected.add(referent);
  for (const reference of dead.toReversed()) {
    const { callback } = referenceOf(reference);
    if (callback !== undefined) callCallback(callback, reference);
  }
}

function callCallback(callback: PyValue, reference: PyValue): void {
  try {
    callValue(callback, [reference]);
  } catch (error) {
    if (!(error instanceof PyError)) throw error;
    reportUnraisable(error, 'Exception ignored while calling weakref callback', callback);
  }
}

function isWeaklyReferenceable(value: PyValue): value is PyObject {
  if (value instanceof PyObject && !value.cls.isBuiltin) return value.cls.lookup('__weakref__') !== undefined;
  return (
    value instanceof PyInstance ||
    value instanceof PyFunction ||
    value instanceof PyClass ||
    value instanceof PySet ||
    value instanceof PyGenerator ||
    value instanceof PyModule ||
    value instanceof PyBoundMethod
  );
}

function referenceOf(value: PyValue): Reference {
  return (value as PyOpaque).data as Reference;
}

/** The object a weak reference refers to, or undefined once CPython would have freed it. */
function liveReferent(value: PyValue): PyObject | undefined {
  const { referent } = referenceOf(value);
  if (collected.has(referent)) return undefined;
  const runtime = currentRuntime();
  if (runtime.reachableObjects().has(referent)) return referent;
  // An object in a reference cycle lives on until CPython's cycle collector runs, which this grader cannot time.
  if (findReachableObjects(referencesOf(referent)).has(referent)) {
    throw new UnsupportedFeatureError('循環参照しているオブジェクトへの弱参照');
  }
  return undefined;
}

function referencesOf(object: PyObject): unknown[] {
  if (object instanceof PyInstance) return [...object.dict.values()];
  if (object instanceof PyFunction) return [...object.closure.values(), ...object.defaults, ...object.dict.values()];
  if (object instanceof PyClass) return [...object.dict.values()];
  return [];
}

/** `weakref.ref(object)`, the reference without a callback that every such call shares. */
export function weakReferenceTo(object: PyObject): PyOpaque {
  return weakReference(object, undefined, weakrefClass);
}

/** The weak reference of an object that has one, which `obj.__weakref__` gives. */
export function weakReferenceOf(object: PyValue): PyOpaque | undefined {
  return object instanceof PyObject ? references.get(object) : undefined;
}

method(weakrefClass, '__call__', 'none', 0, 0, (self) => liveReferent(self) ?? None);
defineProperty(weakrefClass, '__callback__', (self) => ((self as PyOpaque).data as Reference).callback ?? None);
method(weakrefClass, '__repr__', 'none', 0, 0, (self) => {
  const referent = liveReferent(self);
  const address = addressOf(self as PyOpaque);
  if (referent === undefined) return `<weakref at ${address}; dead>`;
  // CPython adds the `__name__` the referent's type gives it, as classes and functions have.
  const name =
    referent instanceof PyClass || referent instanceof PyFunction || referent instanceof PyGenerator
      ? ` (${referent.name})`
      : '';
  return `<weakref at ${address}; to '${classOf(referent).qualifiedName}' at ${addressOf(referent)}${name}>`;
});
defineSlot(weakrefClass, '__hash__', (self) => {
  const reference = referenceOf(self);
  if (reference.hash !== undefined) return reference.hash;
  const referent = liveReferent(self);
  if (referent === undefined) throw typeError('weak object has gone away');
  reference.hash = pyHash(referent);
  return reference.hash;
});
defineSlot(weakrefClass, '__eq__', (self, [other]) => {
  if (!(other instanceof PyOpaque) || other.cls !== weakrefClass) return NotImplemented;
  const [left, right] = [liveReferent(self), liveReferent(other)];
  if (left === undefined || right === undefined) return self === other;
  return equals(left, right);
});
defineSlot(weakrefClass, '__ne__', (self, [other]) => {
  if (!(other instanceof PyOpaque) || other.cls !== weakrefClass) return NotImplemented;
  const [left, right] = [liveReferent(self), liveReferent(other)];
  if (left === undefined || right === undefined) return self !== other;
  return !equals(left, right);
});
