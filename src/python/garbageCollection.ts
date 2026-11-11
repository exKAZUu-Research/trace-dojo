import type { TurtleState } from '../interpreter/turtleWorld';
import { PyMemoryView } from './bytesValues';
import {
  PyBoundMethod,
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
  PySet,
  PyTuple,
} from './values';

/** Finds the turtles that `roots` reach, with the number of items scanned to find them. */
export function findReachableTurtles(roots: unknown[]): { reached: Set<TurtleState>; scanned: number } {
  const reached = new Set<TurtleState>();
  const { scanned } = walk(roots, reached);
  return { reached, scanned };
}

/** The objects that `roots` reach. */
export function findReachableObjects(roots: unknown[]): Set<object> {
  return walk(roots, new Set()).visited;
}

/** The objects that `roots` reach, in the order a breadth-first walk finds them, as CPython's collector lists them. */
export function findReachableInOrder(roots: unknown[]): object[] {
  const visited = new Set<object>();
  const turtles = new Set<TurtleState>();
  let level = [...roots];
  while (level.length > 0) {
    const next: unknown[] = [];
    for (const item of level) {
      if (!isNode(item) || visited.has(item)) continue;
      visited.add(item);
      pushChildren(next, item, turtles);
    }
    level = next;
  }
  return [...visited];
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
    pending.push(...(children.get(node) ?? []));
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

function isNode(item: unknown): item is PyObject | PyCell {
  return item instanceof PyObject || item instanceof PyCell;
}

function pushChildren(pending: unknown[], item: PyObject | PyCell, turtles: Set<TurtleState>): void {
  if (item instanceof PyCell) pending.push(item.value);
  else pushReferences(pending, item, turtles);
}

// code-gauge-allow duplicateLines 16 -- Each language's runtime walks its own object model, so the loops cannot share code.
function walk(roots: unknown[], reached: Set<TurtleState>): { visited: Set<object>; scanned: number } {
  const visited = new Set<object>();
  const pending = [...roots];
  let scanned = 0;
  while (pending.length > 0) {
    const item = pending.pop();
    if (!(item instanceof PyObject || item instanceof PyCell) || visited.has(item)) continue;
    visited.add(item);
    scanned++;
    if (item instanceof PyCell) {
      pending.push(item.value);
      continue;
    }
    scanned += pushReferences(pending, item, reached);
  }
  return { visited, scanned };
}

/** Pushes what an object refers to, returning the number of elements among them. */
// code-gauge-allow functionNcss 41 -- One case per kind of object that refers to others.
// code-gauge-allow functionCognitiveComplexity 18 -- One case per kind of object that refers to others.
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
    return object.defaults.length;
  }
  if (object instanceof PyClass || object instanceof PyModule) return pushNamespaceReferences(pending, object);
  if (object instanceof PyBoundMethod) pending.push(object.self, object.fn);
  else if (object instanceof PyDescriptor) pending.push(object.fn, object.setter, object.deleter);
  else if (object instanceof PyDictView) pending.push(object.dict);
  else if (object instanceof PyMemoryView) pending.push(object.source);
  else if (object instanceof PyIterator || object instanceof PyGenerator) pushAll(pending, object.holds());
  return 0;
}

function pushInstanceReferences(pending: unknown[], instance: PyInstance, reached: Set<TurtleState>): number {
  if (instance.turtle?.isAlive) reached.add(instance.turtle);
  pushAll(pending, instance.dict.values());
  pending.push(instance.cls, instance.enumValue);
  const state = instance.exception;
  if (state) {
    pending.push(state.args, state.notes, state.cause, state.context, state.exceptions);
    for (const frame of state.tracebackFrames ?? []) {
      pushAll(pending, frame.locals.values());
      for (const cell of frame.cells.values()) pending.push(cell);
    }
  }
  return instance.dict.size;
}

function pushNamespaceReferences(pending: unknown[], object: PyClass | PyModule): number {
  if (object instanceof PyClass && object.isBuiltin) return 0;
  pushAll(pending, object.dict.values());
  if (object instanceof PyClass) pushAll(pending, object.enumMembers ?? []);
  return object.dict.size;
}

/** Pushes values one by one: spreading a large array into push() exceeds the engine's argument limit. */
function pushAll(pending: unknown[], values: Iterable<unknown>): void {
  for (const value of values) pending.push(value);
}
