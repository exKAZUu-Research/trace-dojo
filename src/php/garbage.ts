import type { TurtleState } from '../interpreter/turtleWorld';
import type { Frame, Runtime } from './runtime';
import { type ClosureData, isClosure, PhpArray, PhpObject, Ref, type Slot } from './values';

/** The objects at most of which a run checks for garbage on every allocation, to reuse object handles as PHP does. */
const ALLOCATION_CHECK_LIMIT = 2000;

/** Runs the destructor of an object, which the interpreter provides. */
let destruct: (object: PhpObject) => void = () => {};

export function setDestructor(run: (object: PhpObject) => void): void {
  destruct = run;
}

/**
 * Frees the objects nothing reachable refers to, as PHP's reference counting does: an object in a cycle of garbage
 * stays until the end, since PHP's counting cannot free it either, unless `cycles` asks to free those too, as
 * `gc_collect_cycles` does. Returns the number of objects and arrays of objects freed.
 */
// code-gauge-allow functionCognitiveComplexity 20 -- Visits every kind of runtime value that can hold references.
// code-gauge-allow functionNcss 38 -- Visits every kind of runtime value that can hold references.
export function collectGarbage(runtime: Runtime, cycles = false): number {
  if (runtime.objects.size === 0) return 0;
  runtime.spend();
  const previousOrder = runtime.reachOrder;
  const reached = mark(runtime);
  const garbage: PhpObject[] = [];
  for (const object of runtime.objects.values()) if (!reached.has(object)) garbage.push(object);
  if (garbage.length === 0) {
    retainTurtles(runtime, reached);
    return 0;
  }
  const freed = cycles ? garbage : freeable(garbage);
  if (freed.length === 0) {
    retainTurtles(runtime, reached);
    return 0;
  }
  const { owners, handles } = releaseOrder(freed, previousOrder);
  const collected = freed.length + heldArrayCount(freed);
  const destructible = freed.filter((object) => !object.destructed && object.cls.findMethod('__destruct'));
  if (destructible.length === 0 || runtime.shuttingDown) {
    for (const object of handles) runtime.freeObject(object);
    retainTurtles(runtime, mark(runtime));
    return collected;
  }
  // A destructor may store its object somewhere reachable again, so each object is freed only if it stays garbage.
  for (const object of owners) {
    if (object.destructed) continue;
    if (object.cls.findMethod('__destruct')) {
      object.destructed = true;
      runtime.destructibles--;
      destruct(object);
    }
  }
  const after = mark(runtime);
  for (const object of handles) if (!after.has(object)) runtime.freeObject(object);
  retainTurtles(runtime, after);
  return collected;
}

/** The arrays that hold objects or arrays inside the freed objects, which `gc_collect_cycles` counts as well. */
function heldArrayCount(freed: PhpObject[]): number {
  const arrays = new Set<PhpArray>();
  const pending: unknown[] = freed.flatMap((object) => [...object.props.values()]);
  while (pending.length > 0) {
    const item = pending.pop();
    if (item instanceof Ref) pending.push(item.v);
    else if (item instanceof PhpArray && item.composite && !arrays.has(item)) {
      arrays.add(item);
      pending.push(...item.map.values());
    }
  }
  return arrays.size;
}

/** Collects garbage before an allocation when that is cheap, so that a new object reuses a freed handle. */
export function collectBeforeAllocation(runtime: Runtime): void {
  if (runtime.objects.size > 0 && runtime.objects.size <= ALLOCATION_CHECK_LIMIT) collectGarbage(runtime);
}

function retainTurtles(runtime: Runtime, reached: Set<PhpObject>): void {
  if (!runtime.world.hasTurtles) return;
  const turtles = new Set<TurtleState>();
  for (const object of reached) if (object.turtle) turtles.add(object.turtle);
  runtime.world.retain((turtle) => turtles.has(turtle));
}

/**
 * The objects reachable from the program's variables and the values its running code holds. Records the order in which
 * it reaches them, holders' contents in order, in `runtime.reachOrder`.
 */
export function mark(runtime: Runtime): Set<PhpObject> {
  const reached = new Set<PhpObject>();
  const visitedArrays = new Set<PhpArray>();
  const roots: unknown[] = [];
  for (const frame of runtime.frames) pushFrame(frame, roots);
  for (const fn of runtime.functions.values()) if (fn.kind === 'user') roots.push(...fn.statics.values());
  for (const cls of runtime.classes.values()) {
    for (const { ref } of cls.staticProps.values()) roots.push(ref);
    for (const constant of cls.consts.values()) if (constant.value !== undefined) roots.push(constant.value);
    for (const method of cls.methods.values()) if (method.fn.kind === 'user') roots.push(...method.fn.statics.values());
  }
  for (const value of runtime.constants.values()) roots.push(value);
  roots.push(...runtime.held, runtime.exceptionHandler);
  for (const { handler } of runtime.errorHandlers) roots.push(handler);
  // A stack visits the first of the items pushed together first when they are pushed in reverse.
  const pending = roots.toReversed();
  const pushInOrder = (items: Iterable<unknown>): void => {
    const list = [...items];
    for (let index = list.length - 1; index >= 0; index--) pending.push(list[index]);
  };
  while (pending.length > 0) {
    const item = pending.pop();
    if (item instanceof Ref) {
      pending.push(item.v);
    } else if (item instanceof PhpArray) {
      if (!item.composite || visitedArrays.has(item)) continue;
      visitedArrays.add(item);
      pushInOrder([...item.map.values()].filter((slot) => slot !== null && typeof slot === 'object'));
    } else if (item instanceof PhpObject) {
      if (reached.has(item)) continue;
      reached.add(item);
      const children: unknown[] = [];
      pushObject(item, children);
      pushInOrder(children);
    } else if (item instanceof Map) {
      pushInOrder(item.values());
    } else if (Array.isArray(item)) {
      pushInOrder(item);
    }
  }
  runtime.reachOrder = new Map([...reached].map((object, index) => [object, index]));
  return reached;
}

function pushFrame(frame: Frame, pending: unknown[]): void {
  for (const ref of frame.vars.values()) pending.push(ref);
  pending.push(...frame.temporaries, ...frame.args, frame.returning);
  if (frame.thisObj) pending.push(frame.thisObj);
  if (frame.closure) pending.push(frame.closure);
}

function pushObject(object: PhpObject, pending: unknown[]): void {
  for (const slot of object.props.values()) if (typeof slot === 'object' && slot !== null) pending.push(slot);
  const internal = object.internal;
  if (internal === undefined) return;
  if (isClosure(object)) {
    const data = internal as ClosureData;
    pending.push(...data.bound.values());
    if (data.thisObj) pending.push(data.thisObj);
    if (data.fn.kind === 'user') pending.push(...data.fn.statics.values());
    return;
  }
  const held = (internal as { held?: () => unknown[] }).held;
  if (typeof held === 'function') pending.push(...held.call(internal));
}

/**
 * The garbage objects that reference counting frees: all but those a cycle of garbage keeps, which are the objects on
 * a cycle and those reachable from one.
 */
function freeable(garbage: PhpObject[]): PhpObject[] {
  const set = new Set(garbage);
  const edges = new Map<PhpObject, PhpObject[]>();
  for (const object of garbage)
    edges.set(
      object,
      referencedObjects(object).filter((target) => set.has(target))
    );
  // Tarjan's strongly connected components finds the objects on cycles.
  let index = 0;
  const indices = new Map<PhpObject, number>();
  const lowlinks = new Map<PhpObject, number>();
  const stack: PhpObject[] = [];
  const onStack = new Set<PhpObject>();
  const cyclic = new Set<PhpObject>();
  const strongConnect = (root: PhpObject): void => {
    const work: [PhpObject, number][] = [[root, 0]];
    indices.set(root, index);
    lowlinks.set(root, index);
    index++;
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const top = work.at(-1) as [PhpObject, number];
      const [node, position] = top;
      const targets = edges.get(node) as PhpObject[];
      if (position < targets.length) {
        top[1]++;
        const target = targets[position];
        if (!indices.has(target)) {
          indices.set(target, index);
          lowlinks.set(target, index);
          index++;
          stack.push(target);
          onStack.add(target);
          work.push([target, 0]);
        } else if (onStack.has(target)) {
          lowlinks.set(node, Math.min(lowlinks.get(node) as number, indices.get(target) as number));
        }
        continue;
      }
      work.pop();
      const parent = work.at(-1);
      if (parent) lowlinks.set(parent[0], Math.min(lowlinks.get(parent[0]) as number, lowlinks.get(node) as number));
      if (lowlinks.get(node) === indices.get(node)) {
        const component: PhpObject[] = [];
        let member: PhpObject;
        do {
          member = stack.pop() as PhpObject;
          onStack.delete(member);
          component.push(member);
        } while (member !== node);
        const selfLoop = (edges.get(node) as PhpObject[]).includes(node);
        if (component.length > 1 || selfLoop) for (const item of component) cyclic.add(item);
      }
    }
  };
  for (const object of garbage) if (!indices.has(object)) strongConnect(object);
  const kept = new Set<PhpObject>();
  const pending = [...cyclic];
  while (pending.length > 0) {
    const object = pending.pop() as PhpObject;
    if (kept.has(object)) continue;
    kept.add(object);
    pending.push(...(edges.get(object) as PhpObject[]));
  }
  return garbage.filter((object) => !kept.has(object));
}

/**
 * The order in which PHP releases freed objects: a holder releases what it holds in order (an array its elements, a
 * function its variables), so the objects nothing else freed refers to go in the order the program held them, as the
 * last reachability pass saw it. Destructors run owners first; handles return to the free list owners last, after
 * releasing an object has released what it held.
 */
function releaseOrder(
  freed: PhpObject[],
  previousOrder: Map<PhpObject, number>
): { owners: PhpObject[]; handles: PhpObject[] } {
  const set = new Set(freed);
  const referenced = new Set<PhpObject>();
  const edges = new Map<PhpObject, PhpObject[]>();
  for (const object of freed) {
    const targets = referencedObjects(object).filter((target) => set.has(target));
    edges.set(object, targets);
    for (const target of targets) referenced.add(target);
  }
  const owners: PhpObject[] = [];
  const handles: PhpObject[] = [];
  const visited = new Set<PhpObject>();
  const visit = (object: PhpObject): void => {
    if (visited.has(object)) return;
    visited.add(object);
    owners.push(object);
    for (const target of edges.get(object) as PhpObject[]) visit(target);
    handles.push(object);
  };
  const position = (object: PhpObject): number => previousOrder.get(object) ?? Number.MAX_SAFE_INTEGER;
  const roots = freed
    .filter((object) => !referenced.has(object))
    .toSorted((a, b) => position(a) - position(b) || a.id - b.id);
  for (const root of roots) visit(root);
  for (const object of freed) visit(object);
  return { owners, handles };
}

/** The objects an object refers to directly or through arrays it holds, in property order. */
export function referencedObjects(object: PhpObject): PhpObject[] {
  const found: PhpObject[] = [];
  const pending: unknown[] = [];
  pushObject(object, pending);
  pending.reverse();
  const seenArrays = new Set<PhpArray>();
  while (pending.length > 0) {
    const item = pending.shift();
    if (item instanceof Ref) pending.unshift(item.v);
    else if (item instanceof PhpObject) found.push(item);
    else if (item instanceof PhpArray) {
      if (seenArrays.has(item)) continue;
      seenArrays.add(item);
      pending.unshift(...item.map.values());
    } else if (item instanceof Map) pending.unshift(...item.values());
    else if (Array.isArray(item)) pending.unshift(...item);
  }
  return found;
}

/** Counts the holders of each reachable object: variables, elements, and properties that refer to it. */
// code-gauge-allow functionNcss 56 -- Visits every kind of runtime value that can hold references.
export function holderCounts(runtime: Runtime): Map<PhpObject, number> {
  const counts = new Map<PhpObject, number>();
  const visitedArrays = new Set<PhpArray>();
  const visitedObjects = new Set<PhpObject>();
  const visitedRefs = new Set<Ref>();
  const pending: unknown[] = [];
  const count = (value: Slot | unknown): void => {
    if (value instanceof PhpObject) counts.set(value, (counts.get(value) ?? 0) + 1);
    pending.push(value);
  };
  for (const frame of runtime.frames) {
    for (const ref of frame.vars.values()) count(ref);
    for (const value of [...frame.temporaries, ...frame.args]) count(value);
  }
  for (const cls of runtime.classes.values()) for (const { ref } of cls.staticProps.values()) count(ref);
  for (const fn of runtime.functions.values())
    if (fn.kind === 'user') for (const ref of fn.statics.values()) count(ref);
  for (const value of runtime.held) count(value);
  while (pending.length > 0) {
    const item = pending.pop();
    if (item instanceof Ref) {
      if (visitedRefs.has(item)) continue;
      visitedRefs.add(item);
      count(item.v);
    } else if (item instanceof PhpArray) {
      if (visitedArrays.has(item)) continue;
      visitedArrays.add(item);
      for (const slot of item.map.values()) count(slot);
    } else if (item instanceof PhpObject) {
      if (visitedObjects.has(item)) continue;
      visitedObjects.add(item);
      const children: unknown[] = [];
      pushObject(item, children);
      for (const child of children) count(child);
    } else if (item instanceof Map) {
      for (const value of item.values()) count(value);
    } else if (Array.isArray(item)) {
      for (const value of item) count(value);
    }
  }
  return counts;
}
