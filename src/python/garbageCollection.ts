import type { TurtleState } from '../interpreter/turtleWorld';
import { annotationReferences, functionAnnotationReferences, PyAnnotateFunction } from './annotations';
import { pushAll } from './arrays';
import { PyMemoryView } from './bytesValues';
import { peekFieldsOf } from './cTypes';
import { DictStore } from './dictStore';
import { Frame } from './frame';
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
 * The objects among `garbage`, which nothing else refers to, that reference counting frees: those that no cycle among
 * them reaches, which only the cycle collector frees.
 */
export function freedByReferenceCounting(garbage: Set<object>): Set<object> {
  const turtles = new Set<TurtleState>();
  const children = new Map<object, object[]>();
  for (const node of garbage) {
    const pending: unknown[] = [];
    pushChildren(pending, node as PyObject | PyCell, turtles);
    children.set(
      node,
      pending.filter((child): child is object => isNode(child) && garbage.has(child))
    );
  }
  const kept = new Set<object>();
  const pending = [...nodesOnCycles(children)];
  while (pending.length > 0) {
    const node = pending.pop() as object;
    if (kept.has(node)) continue;
    kept.add(node);
    pushAll(pending, children.get(node) ?? []);
  }
  return new Set([...garbage].filter((node) => !kept.has(node)));
}

interface TarjanEntry {
  node: object;
  next: number;
}

/** The nodes that lie on a cycle of the graph, found as Tarjan's strongly connected components. */
// code-gauge-allow functionCognitiveComplexity 23 -- Tarjan's algorithm, iterative so that long chains cannot exhaust the stack.
// code-gauge-allow functionNcss 36 -- Tarjan's algorithm, iterative so that long chains cannot exhaust the stack.
function nodesOnCycles(children: Map<object, object[]>): Set<object> {
  const index = new Map<object, number>();
  const low = new Map<object, number>();
  const stack: object[] = [];
  const onStack = new Set<object>();
  const cyclic = new Set<object>();
  const work: TarjanEntry[] = [];
  const enter = (node: object): void => {
    index.set(node, index.size);
    low.set(node, index.size - 1);
    stack.push(node);
    onStack.add(node);
    work.push({ node, next: 0 });
  };
  for (const start of children.keys()) {
    if (!index.has(start)) enter(start);
    while (work.length > 0) {
      const top = work.at(-1) as TarjanEntry;
      const edges = children.get(top.node) ?? [];
      if (top.next < edges.length) {
        const child = edges[top.next++];
        if (child === top.node) cyclic.add(child);
        if (!index.has(child)) enter(child);
        else if (onStack.has(child)) low.set(top.node, Math.min(low.get(top.node) ?? 0, index.get(child) ?? 0));
        continue;
      }
      work.pop();
      const parent = work.at(-1);
      if (parent) low.set(parent.node, Math.min(low.get(parent.node) ?? 0, low.get(top.node) ?? 0));
      if (low.get(top.node) === index.get(top.node)) popComponent(stack, onStack, top.node, cyclic);
    }
  }
  return cyclic;
}

/** Pops a strongly connected component off Tarjan's stack, adding its nodes to `cyclic` when they form a cycle. */
function popComponent(stack: object[], onStack: Set<object>, root: object, cyclic: Set<object>): void {
  const component: object[] = [];
  let member: object | undefined;
  do {
    member = stack.pop() as object;
    onStack.delete(member);
    component.push(member);
  } while (member !== root);
  if (component.length > 1) for (const each of component) cyclic.add(each);
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
  if (object.instanceDict) pushAll(pending, object.instanceDict.values());
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
  pending.push(fn.builtins);
  pushAll(pending, fn.closure.values());
  pushAll(pending, fn.defaults);
  pushAll(pending, fn.keywordDefaults.values());
  pushAll(pending, fn.dict.values());
  if (fn instanceof PyAnnotateFunction) pushAll(pending, annotationReferences(fn.annotations()));
  pushAll(pending, functionAnnotationReferences(fn));
  return fn.defaults.length;
}

function pushInstanceReferences(pending: unknown[], instance: PyInstance, reached: Set<TurtleState>): number {
  if (instance.turtle?.isAlive) reached.add(instance.turtle);
  pushAll(pending, instance.dict.values());
  pending.push(instance.enumValue);
  const state = instance.exception;
  if (state) {
    pending.push(state.args, state.cause, state.context, state.exceptions, state.traceback);
  }
  return instance.dict.size;
}

function pushNamespaceReferences(pending: unknown[], object: PyClass | PyModule): number {
  if (object instanceof PyClass && object.isBuiltin) return 0;
  pushAll(pending, object.dict.values());
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
  else if (data instanceof Map) for (const [key, value] of data) pending.push(key, value);
  else if (data instanceof DictStore) for (const entry of data.ordered()) pending.push(entry.key, entry.value);
  else if (Object.getPrototypeOf(data) === Object.prototype) pushAll(pending, Object.values(data));
}
