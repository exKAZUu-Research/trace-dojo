import type { TurtleState } from '../interpreter/turtleWorld';
import { DictStore } from './dictStore';
import {
  PyBoundMethod,
  PyBuiltinFunction,
  PyCell,
  PyClass,
  PyDeque,
  PyDescriptor,
  PyDict,
  PyDictView,
  PyFunction,
  PyGenerator,
  PyInstance,
  PyIterator,
  PyList,
  PyModule,
  PyObject,
  PyOpaque,
  PySet,
  PyTuple,
} from './values';

/** Finds the turtles that `roots` reach, with the number of items scanned to find them. */
// code-gauge-allow duplicateLines 19 -- Each language's runtime walks its own object model, so the loops cannot share code.
export function findReachableTurtles(roots: unknown[]): { reached: Set<TurtleState>; scanned: number } {
  const reached = new Set<TurtleState>();
  const visited = new Set<object>();
  const pending = [...roots];
  let scanned = 0;
  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item !== 'object' || item === null || visited.has(item)) continue;
    visited.add(item);
    scanned++;
    if (!(item instanceof PyObject || item instanceof PyCell)) {
      pushNativeData(pending, item);
      continue;
    }
    if (item instanceof PyCell) {
      pending.push(item.value);
      continue;
    }
    scanned += pushReferences(pending, item, reached);
  }
  return { reached, scanned };
}

/** Pushes what an object refers to, returning the number of elements among them. */
// code-gauge-allow functionNcss 45 -- One case per kind of object that refers to others.
// code-gauge-allow functionCognitiveComplexity 19 -- One case per kind of object that refers to others.
function pushReferences(pending: unknown[], object: PyObject, reached: Set<TurtleState>): number {
  if (object instanceof PyList || object instanceof PyTuple || object instanceof PyDeque) {
    pushAll(pending, object.items);
    if (!object.cls.isBuiltin) pending.push(object.cls);
    return object.items.length;
  }
  if (object instanceof PyDict) {
    const entries = object.store.ordered();
    for (const entry of entries) pending.push(entry.key, entry.value);
    pending.push(object.defaultFactory);
    return entries.length;
  }
  if (object instanceof PySet) {
    const keys = object.table.keys();
    pushAll(pending, keys);
    return keys.length;
  }
  if (object instanceof PyInstance) return pushInstanceReferences(pending, object, reached);
  if (object instanceof PyFunction) {
    pushAll(pending, object.closure.values());
    pushAll(pending, object.defaults);
    pushAll(pending, object.keywordDefaults.values());
    pushAll(pending, object.dict.values());
    pending.push(object.annotations, object.annotate);
    return object.defaults.length;
  }
  if (object instanceof PyClass || object instanceof PyModule) return pushNamespaceReferences(pending, object);
  if (object instanceof PyBoundMethod) pending.push(object.self, object.fn);
  else if (object instanceof PyBuiltinFunction) pending.push(object.self);
  else if (object instanceof PyOpaque) pending.push(object.data, object.attributes);
  else if (object instanceof PyDescriptor) pending.push(object.fn, object.setter, object.deleter);
  else if (object instanceof PyDictView) pending.push(object.dict);
  else if (object instanceof PyIterator || object instanceof PyGenerator) pushAll(pending, object.holds());
  return 0;
}

function pushInstanceReferences(pending: unknown[], instance: PyInstance, reached: Set<TurtleState>): number {
  if (instance.turtle?.isAlive) reached.add(instance.turtle);
  pushAll(pending, instance.dict.values());
  pending.push(instance.cls, instance.enumValue);
  const state = instance.exception;
  if (state) pending.push(state.args, state.notes, state.cause, state.context, state.exceptions);
  return instance.dict.size;
}

function pushNamespaceReferences(pending: unknown[], object: PyClass | PyModule): number {
  if (object instanceof PyClass && object.isBuiltin) return 0;
  pushAll(pending, object.dict.values());
  if (object instanceof PyClass) {
    pushAll(pending, object.enumMembers ?? []);
    pushAll(pending, object.bases);
    pending.push(object.annotations);
  }
  return object.dict.size;
}

/** Pushes what the native state of a builtin object holds: the items of its arrays, maps, sets, and records. */
function pushNativeData(pending: unknown[], data: object): void {
  if (Array.isArray(data) || data instanceof Set) pushAll(pending, data);
  else if (data instanceof Map) for (const [key, value] of data) pending.push(key, value);
  else if (data instanceof DictStore) for (const entry of data.ordered()) pending.push(entry.key, entry.value);
  else if (Object.getPrototypeOf(data) === Object.prototype) pushAll(pending, Object.values(data));
}

/** Pushes values one by one: spreading a large array into push() exceeds the engine's argument limit. */
function pushAll(pending: unknown[], values: Iterable<unknown>): void {
  for (const value of values) pending.push(value);
}
