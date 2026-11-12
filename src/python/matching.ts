import { classOf } from './types';
import { type PyClass, PyDeque, PyDict, PyList, PyRange, PyTuple, type PyValue } from './values';

type CollectionKind = 'sequence' | 'mapping';

// The values of Py_TPFLAGS_SEQUENCE and Py_TPFLAGS_MAPPING, which collections.abc sets through `__abc_tpflags__`.
const KIND_OF_FLAG = new Map<PyValue, CollectionKind>([
  [1n << 5n, 'sequence'],
  [1n << 6n, 'mapping'],
]);

/**
 * The classes a program can change that a match statement treats as sequences or mappings: the ABCs Sequence and
 * Mapping, and the classes registered with them. Their subclasses inherit the kind, as they do the type flag in
 * CPython.
 */
const kinds = new WeakMap<PyClass, CollectionKind>();

/** Whether a match statement's sequence pattern may match a value: a list, tuple, range, deque, or Sequence, but not a string. */
export function isSequenceForMatch(value: PyValue): boolean {
  return kindOf(value) === 'sequence';
}

/** Whether a match statement's mapping pattern may match a value: a dict, mappingproxy, or Mapping. */
export function isMapping(value: PyValue): boolean {
  return kindOf(value) === 'mapping';
}

function kindOf(value: PyValue): CollectionKind | undefined {
  if (value instanceof PyList || value instanceof PyTuple || value instanceof PyRange || value instanceof PyDeque) {
    return 'sequence';
  }
  if (value instanceof PyDict) return 'mapping';
  const cls = classOf(value);
  return cls.isBuiltin && cls.name === 'mappingproxy' ? 'mapping' : inheritedKind(cls);
}

function inheritedKind(cls: PyClass): CollectionKind | undefined {
  for (const each of cls.mro) {
    const kind = kinds.get(each);
    if (kind !== undefined) return kind;
  }
  return undefined;
}

/** Reads the `__abc_tpflags__` of a new abstract base class, which ABCMeta takes out of the class as it applies it. */
export function applyCollectionFlags(cls: PyClass): void {
  const kind = KIND_OF_FLAG.get(cls.dict.get('__abc_tpflags__') ?? 0n);
  if (kind !== undefined) kinds.set(cls, kind);
  cls.dict.delete('__abc_tpflags__');
}

/** Gives a class registered with a sequence or mapping ABC, and its subclasses, that kind, as `ABCMeta.register` does. */
export function registerCollectionKind(
  abc: PyClass,
  subclass: PyClass,
  subclassesOf: (cls: PyClass) => PyClass[]
): void {
  const kind = inheritedKind(abc);
  if (kind === undefined) return;
  const pending = [subclass];
  for (let cls = pending.pop(); cls !== undefined; cls = pending.pop()) {
    // CPython leaves its immutable builtin types as they are.
    if (cls.isBuiltin || kinds.get(cls) === kind) continue;
    kinds.set(cls, kind);
    pending.push(...subclassesOf(cls));
  }
}
