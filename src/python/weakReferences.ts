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
    }
    return reference;
  }
  const reference = new PyOpaque(cls, '', { referent, callback } satisfies Reference);
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
    try {
      callValue(callback, [reference]);
    } catch (error) {
      // CPython reports an exception raised by a callback on stderr and goes on.
      if (!(error instanceof PyError)) throw error;
    }
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
  return `<weakref at ${address}; to '${classOf(referent).qualifiedName}' at ${addressOf(referent)}>`;
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
