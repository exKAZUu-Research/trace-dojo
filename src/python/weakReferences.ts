import { addressOf } from './conversions';
import { method } from './define';
import { findReachableObjects } from './garbageCollection';
import { pyHash } from './hashing';
import { defineSlot } from './modules/numberSupport';
import { equals } from './operators';
import { currentRuntime } from './runtimeContext';
import { builtinClass, classOf, None, NotImplemented, typeError } from './types';
import { UnsupportedFeatureError } from './unsupported';
import {
  PyBoundMethod,
  PyClass,
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

/** The weak reference to each object, which CPython reuses for every `ref(obj)` without a callback. */
const references = new WeakMap<PyObject, PyOpaque>();

interface Reference {
  referent: PyObject;
  /** The referent's hash, which CPython keeps once computed so that a dead reference still hashes. */
  hash?: bigint;
}

weakrefClass.construct = (_cls, args) => {
  const [referent, callback] = args;
  if (args.length === 0) throw typeError('__new__ expected at least 1 argument, got 0');
  if (args.length > 2) throw typeError(`__new__ expected at most 2 arguments, got ${args.length}`);
  if (callback !== undefined && callback !== None) {
    throw new UnsupportedFeatureError('オブジェクトが解放されたときのコールバック（weakref.ref() の callback）');
  }
  return weakReference(referent);
};

function weakReference(referent: PyValue): PyOpaque {
  if (!isWeaklyReferenceable(referent)) {
    throw typeError(`cannot create weak reference to '${classOf(referent).name}' object`);
  }
  let reference = references.get(referent);
  if (!reference) {
    reference = new PyOpaque(weakrefClass, '', { referent } satisfies Reference);
    references.set(referent, reference);
  }
  return reference;
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
