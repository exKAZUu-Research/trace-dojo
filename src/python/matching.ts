import { currentRuntime } from './runtimeContext';
import { classOf, objectClass } from './types';
import { type PyClass, PyDict, PyList, PyRange, PyTuple, type PyValue } from './values';

type CollectionKind = 'sequence' | 'mapping';

/**
 * The kinds that CPython's SEQUENCE and MAPPING flags give each run's classes: an ABC's `__abc_tpflags__`, and the
 * classes registered with it, which their subclasses inherit through their layout bases.
 */
const runKinds = new WeakMap<object, Map<PyClass, CollectionKind>>();

function kindsOfRun(): Map<PyClass, CollectionKind> {
  const runtime = currentRuntime();
  let kinds = runKinds.get(runtime);
  if (!kinds) {
    kinds = new Map();
    runKinds.set(runtime, kinds);
  }
  return kinds;
}

const BUILTIN_KINDS: Record<string, CollectionKind> = {
  list: 'sequence',
  tuple: 'sequence',
  range: 'sequence',
  deque: 'sequence',
  memoryview: 'sequence',
  array: 'sequence',
  dict: 'mapping',
  mappingproxy: 'mapping',
};

/** `__abc_tpflags__` of an ABC, as `_abc_init` reads it: 1 << 5 for a sequence, 1 << 6 for a mapping. */
export function setCollectionFlags(cls: PyClass, flags: PyValue): void {
  if (typeof flags !== 'bigint') return;
  if (flags & (1n << 5n)) kindsOfRun().set(cls, 'sequence');
  else if (flags & (1n << 6n)) kindsOfRun().set(cls, 'mapping');
}

/** Gives a class registered with an ABC the ABC's kind, unless it is a builtin type or has a kind of its own. */
export function inheritCollectionKind(abc: PyClass, registered: PyClass): void {
  const kind = collectionKind(abc);
  if (kind === undefined || registered.isBuiltin || collectionKind(registered) !== undefined) return;
  kindsOfRun().set(registered, kind);
}

/** The base a class takes its flags from: the one with a builtin layout, else its first. */
function layoutBase(cls: PyClass): PyClass | undefined {
  return cls.bases.find((base) => base.mro.some((each) => each.isBuiltin && each !== objectClass)) ?? cls.bases[0];
}

function collectionKind(cls: PyClass): CollectionKind | undefined {
  const kinds = kindsOfRun();
  for (let each: PyClass | undefined = cls; each && each !== objectClass; each = layoutBase(each)) {
    const kind = kinds.get(each) ?? (each.isBuiltin ? BUILTIN_KINDS[each.name] : undefined);
    if (kind !== undefined || each.isBuiltin) return kind;
  }
  return undefined;
}

/** Whether a match statement's sequence pattern may match a value: a list, tuple, range, or deque, but not a string. */
export function isSequenceForMatch(value: PyValue): boolean {
  if (value instanceof PyList || value instanceof PyTuple || value instanceof PyRange) return true;
  return collectionKind(classOf(value)) === 'sequence';
}

/** Whether a match statement's mapping pattern may match a value. */
export function isMapping(value: PyValue): boolean {
  return value instanceof PyDict || collectionKind(classOf(value)) === 'mapping';
}
