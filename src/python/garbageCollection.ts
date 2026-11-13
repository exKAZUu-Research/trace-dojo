import type { TurtleState } from '../interpreter/turtleWorld';
import { annotationReferences, functionAnnotationReferences, PyAnnotateFunction } from './annotations';
import { pushAll } from './arrays';
import { PyMemoryView } from './bytesValues';
import { peekFieldsOf } from './cTypes';
import { DictStore } from './dictStore';
import { Frame } from './frame';
import { NamespaceMap, namespaceReferences } from './namespaceMap';
import { ObjectNamespace } from './namespaces';
import { frameReferences, PyTraceback } from './tracebacks';
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
  PySuper,
  PyTuple,
} from './values';

/** Finds the turtles that `roots` reach, with the number of items scanned to find them. */
export function findReachableTurtles(roots: unknown[]): { reached: Set<TurtleState>; scanned: number } {
  const reached = new Set<TurtleState>();
  const { scanned } = walk(roots, reached);
  return { reached, scanned };
}

/**
 * The objects that `roots` reach. With `targets`, the walk may stop once it has reached them all, so that the set is
 * complete only when some target is missing from it.
 */
export function findReachableObjects(roots: unknown[], targets?: ReadonlySet<object>): Set<object> {
  return walk(roots, new Set(), targets).visited;
}

/**
 * The objects that `roots` reach, in the order a breadth-first walk finds them, as CPython's collector lists them. The
 * walk neither lists nor goes past the objects `skip` accepts, which the caller knows to be kept alive otherwise.
 */
export function findReachableInOrder(roots: unknown[], skip?: (object: object) => boolean): object[] {
  const visited = new Set<object>();
  const listed: object[] = [];
  const turtles = new Set<TurtleState>();
  let level = [...roots];
  while (level.length > 0) {
    const next: unknown[] = [];
    for (const item of level) {
      if (!isNode(item) || visited.has(item)) continue;
      visited.add(item);
      if (skip?.(item)) continue;
      listed.push(item);
      pushChildren(next, item, turtles);
    }
    level = next;
  }
  return listed;
}

/**
 * The objects and cells a node refers to. With `asCPythonVisits`, the items of a list, tuple, or deque come last
 * first, as CPython's deallocation and its collector's traversal visit them.
 */
export function referencesOf(node: object, asCPythonVisits = false): object[] {
  const pending: unknown[] = [];
  const sequence = node instanceof PyList || node instanceof PyTuple || node instanceof PyDeque;
  if (asCPythonVisits && sequence) {
    pushOwnedFields(pending, node);
    for (let index = node.items.length - 1; index >= 0; index--) pending.push(node.items[index]);
    if (!node.cls.isBuiltin) pending.push(node.cls);
  } else if (isNode(node)) {
    pushChildren(pending, node, new Set());
  }
  return pending.filter(isNode);
}

/** The objects `roots` reach, in the order a breadth-first walk visiting as CPython's collector finds them. */
export function findReachableAsCollector(roots: unknown[]): object[] {
  const visited = new Set<object>();
  let level = roots.filter(isCollectorNode);
  while (level.length > 0) {
    const next: object[] = [];
    for (const item of level) {
      if (visited.has(item)) continue;
      visited.add(item);
      pushAll(next, collectorReferences(item));
    }
    level = next;
  }
  return [...visited].filter(isNode);
}

function collectorReferences(node: object): object[] {
  if (Array.isArray(node)) return node.filter(isCollectorNode);
  if (node instanceof Map) return [...node].flat().filter(isCollectorNode);
  if (node instanceof PyModule) return [node.dict];
  if (node instanceof PyClass && !node.isBuiltin)
    return [
      node.dict,
      node.mro,
      node.bases,
      node.enumMembers ?? [],
      ...nativeReferences([node.nameValue, node.qualifiedNameValue]).filter(isCollectorNode),
      ...(!node.cls.isBuiltin ? [node.cls] : []),
    ];
  if (node instanceof PyFunction) {
    const annotations = functionAnnotationReferences(node);
    if (node instanceof PyAnnotateFunction) pushAll(annotations, annotationReferences(node.annotations()));
    const references: unknown[] = [
      node.globals,
      node.builtins,
      node.defaults,
      node.keywordDefaults,
      node.dict,
      node.closure,
      annotations,
    ];
    return references.filter(isCollectorNode);
  }
  return referencesOf(node, true);
}

function isCollectorNode(item: unknown): item is object {
  return isNode(item) || Array.isArray(item) || item instanceof Map;
}

function isNode(item: unknown): item is PyObject | PyCell {
  return item instanceof PyObject || item instanceof PyCell;
}

/** Pushes what a node refers to, returning the number of elements among them. */
function pushChildren(pending: unknown[], item: PyObject | PyCell, turtles: Set<TurtleState>): number {
  if (item instanceof PyCell) {
    pending.push(item.value);
    return 0;
  }
  pushOwnedFields(pending, item);
  const size = pushReferences(pending, item, turtles);
  if (!item.cls.isBuiltin || item instanceof PyInstance) pending.push(item.cls);
  return size;
}

/**
 * Pushes the fields any object may have besides what its kind holds, in the order CPython's deallocation of a subclass
 * instance releases them: its slots, then its attributes, then the fields of a C type written in Python.
 */
function pushOwnedFields(pending: unknown[], object: PyObject): void {
  if (object.slotValues) pushAll(pending, object.slotValues.values());
  if (object.instanceDict) pushAll(pending, namespaceReferences(object.instanceDict));
  const extraFields = peekFieldsOf(object);
  if (extraFields) pushAll(pending, extraFields);
}

function walk(
  roots: unknown[],
  reached: Set<TurtleState>,
  targets?: ReadonlySet<object>
): { visited: Set<object>; scanned: number } {
  const visited = new Set<object>();
  const pending = [...roots];
  let scanned = 0;
  let missing = targets?.size ?? -1;
  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item !== 'object' || item === null || visited.has(item)) continue;
    visited.add(item);
    scanned++;
    if (targets?.has(item) && --missing === 0) break;
    if (!isNode(item)) {
      pushNativeData(pending, item);
      continue;
    }
    scanned += pushChildren(pending, item, reached);
  }
  return { visited, scanned };
}

/** Pushes what an object refers to, returning the number of elements among them. */
// code-gauge-allow functionCognitiveComplexity 23 -- One case per kind of object that refers to others.
// code-gauge-allow functionNcss 50 -- One case per kind of object that refers to others.
function pushReferences(pending: unknown[], object: PyObject, reached: Set<TurtleState>): number {
  if (object instanceof PyList || object instanceof PyTuple || object instanceof PyDeque) {
    pushAll(pending, object.items);
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
  if (object instanceof PyOpaque) {
    pushOpaqueReferences(pending, object);
    return 0;
  }
  if (object instanceof PyFunction) return pushFunctionReferences(pending, object);
  if (object instanceof PyClass || object instanceof PyModule) return pushNamespaceReferences(pending, object);
  if (object instanceof PyTraceback) {
    pushNativeNodes(pending, object.frame);
    pending.push(object.next);
  } else if (object instanceof PyBoundMethod) pending.push(object.self, object.fn);
  else if (object instanceof PyBuiltinFunction) pending.push(object.self);
  else if (object instanceof PySuper) pending.push(object.self, object.thisClass);
  else if (object instanceof PyDescriptor) pending.push(object.fn, object.setter, object.deleter);
  else if (object instanceof PyDictView) pending.push(object.dict);
  else if (object instanceof PyMemoryView) pending.push(object.source, object.exporter);
  else if (object instanceof PyIterator || (object instanceof PyGenerator && !object.finished))
    pushNativeNodes(pending, [...object.holds()].toReversed());
  return 0;
}

/** Pushes what a native object refers to: a weak reference keeps its callback alive, but not its referent. */
function pushOpaqueReferences(pending: unknown[], object: PyOpaque): void {
  if (object.cls.mro.some((cls) => cls.name === 'ReferenceType' && cls.module === 'weakref')) {
    const callback = (object.data as { callback?: unknown } | undefined)?.callback;
    if (callback !== undefined) pending.push(callback);
  } else {
    pushNativeNodes(pending, object.data);
  }
}

function pushFunctionReferences(pending: unknown[], fn: PyFunction): number {
  // A module's globals are reachable from the module itself.
  if (fn.globals instanceof ObjectNamespace) pending.push(fn.globals.holder);
  pending.push(fn.builtins, fn.nameValue, fn.qualifiedNameValue);
  pushAll(pending, fn.closure.values());
  pushAll(pending, fn.defaults);
  pushAll(pending, fn.keywordDefaults.values());
  pushAll(pending, namespaceReferences(fn.dict));
  if (fn instanceof PyAnnotateFunction) pushAll(pending, annotationReferences(fn.annotations()));
  pushAll(pending, functionAnnotationReferences(fn));
  return fn.defaults.length;
}

function pushInstanceReferences(pending: unknown[], instance: PyInstance, reached: Set<TurtleState>): number {
  if (instance.turtle?.isAlive) reached.add(instance.turtle);
  pushAll(pending, namespaceReferences(instance.dict));
  pending.push(instance.enumValue);
  const state = instance.exception;
  if (state) {
    pending.push(state.args, state.cause, state.context, state.exceptions, state.traceback);
  }
  return instance.dict.size;
}

function pushNamespaceReferences(pending: unknown[], object: PyClass | PyModule): number {
  if (object instanceof PyClass && object.isBuiltin) return 0;
  pushAll(pending, namespaceReferences(object.dict));
  if (object instanceof PyClass) {
    pending.push(object.nameValue, object.qualifiedNameValue);
    pushAll(pending, object.enumMembers ?? []);
    pushAll(pending, object.bases);
  }
  return object.dict.size;
}

/** The Python objects and cells directly held by native containers and records. */
export function nativeReferences(root: unknown): unknown[] {
  const references: unknown[] = [];
  pushNativeNodes(references, root);
  return references;
}

/** Pushes the Python objects and cells held inside native arrays, maps, sets, and plain records. */
function pushNativeNodes(pending: unknown[], root: unknown): void {
  const stack: unknown[] = [root];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item !== 'object' || item === null) continue;
    if (isNode(item)) {
      pending.push(item);
      continue;
    }
    if (seen.has(item)) continue;
    seen.add(item);
    pushNativeData(stack, item);
  }
}

/** Pushes what the native state of a builtin object holds: the items of its arrays, maps, sets, and records. */
function pushNativeData(pending: unknown[], data: object): void {
  if (data instanceof Frame) pushAll(pending, frameReferences(data).toReversed());
  else if (Array.isArray(data) || data instanceof Set) pushAll(pending, data);
  else if (data instanceof NamespaceMap && data.dictionary) pushAll(pending, namespaceReferences(data));
  else if (data instanceof Map) for (const [key, value] of data) pending.push(key, value);
  else if (data instanceof DictStore) for (const entry of data.ordered()) pending.push(entry.key, entry.value);
  else if (Object.getPrototypeOf(data) === Object.prototype) pushAll(pending, Object.values(data));
}
