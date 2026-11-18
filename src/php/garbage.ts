// code-gauge-allow-file fileNcss 867 -- Holds the cases of one concern of the interpreter, which share their helpers.
import type { TurtleState } from '../interpreter/turtleWorld';
import { setPrevious, withPendingException } from './errors';
import { type Frame, PhpThrow, type Runtime } from './runtime';
import {
  arrayHolderCount,
  type ClosureData,
  isClosure,
  observeOwnership,
  type OwnershipChange,
  ownershipEdgeExists,
  ownershipProof,
  PhpArray,
  PhpObject,
  Ref,
  rememberOwnership,
  valueOwners,
} from './values';

export const GC_THRESHOLD_DEFAULT = 10_001;
const GC_THRESHOLD_STEP = 10_000;
const GC_THRESHOLD_TRIGGER = 100;

/** Runs the destructor of an object, which the interpreter provides. */
let destruct: (object: PhpObject, row?: number) => void = () => {};

export function setDestructor(run: (object: PhpObject, row?: number) => void): void {
  destruct = run;
}

/** Collects unreachable objects and, when `cycles` is set, cycles; returns PHP's count of objects and arrays. */
export function collectGarbage(runtime: Runtime, cycles = false): number {
  if (runtime.collectingCycles) return 0;
  runtime.collectingCycles = cycles;
  try {
    return collectGarbageNow(runtime, cycles);
  } finally {
    runtime.collectingCycles = false;
    runtime.collectingArrays.clear();
    runtime.collectingObjects.clear();
  }
}

function collectGarbageNow(runtime: Runtime, cycles: boolean): number {
  // While a release runs destructors, it frees the rest of what it released itself, in PHP's order.
  if ((runtime.objects.size === 0 && runtime.arrayCycles.size === 0) || (releasing > 0 && !cycles)) {
    if (cycles) runtime.gcRoots.clear();
    return 0;
  }
  runtime.spend();
  const previousOrder = runtime.reachOrder;
  const reachedArrays = new Set<PhpArray>();
  const reached = mark(runtime, !cycles, reachedArrays);
  const buffered = cycles
    ? runtime.gcRoots.garbageOrder((value) =>
        value instanceof PhpArray ? reachedArrays.has(value) : reached.has(value)
      )
    : undefined;
  const arrayCandidates = cycles ? [...runtime.arrayCycles].filter((array) => !reachedArrays.has(array)) : [];
  if (cycles) {
    runtime.gcRoots.clear();
    runtime.arrayCycles.clear();
    runtime.objectCycles.clear();
    for (const array of arrayCandidates) runtime.collectingArrays.add(array);
  }
  const arrayCount = heldArrayCount(arrayCandidates, reachedArrays);
  const garbage: PhpObject[] = [];
  for (const object of runtime.objects.values()) if (!reached.has(object)) garbage.push(object);
  if (garbage.length === 0) {
    finishArrayCollection(runtime, arrayCandidates);
    retainTurtles(runtime, reached);
    return arrayCount;
  }
  const freed = cycles ? garbage : freeable(garbage);
  if (freed.length === 0) {
    finishArrayCollection(runtime, arrayCandidates);
    retainTurtles(runtime, reached);
    return arrayCount;
  }
  for (const object of freed) runtime.collectingObjects.add(object);
  const { owners, handles } = releaseOrder(freed, previousOrder, runtime, buffered);
  const arrayStorage = collectibleGraph([...freed, ...arrayCandidates], reachedArrays).arrays;
  const collected = freed.length + arrayStorage.size;
  const destructible = freed.filter((object) => !object.destructed && object.cls.findMethod('__destruct'));
  if (destructible.length === 0 || runtime.shuttingDown) {
    for (const object of handles) runtime.freeObject(object);
    finishArrayCollection(runtime, arrayStorage);
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
  const afterArrays = new Set<PhpArray>();
  const after = mark(runtime, false, afterArrays);
  const remaining = freed.filter((object) => !after.has(object));
  const { cyclic } = cyclicObjects(remaining);
  const protectedObjects = collectibleGraph(
    destructible.filter((object) => cyclic.has(object)),
    new Set(),
    new Set(),
    new Set(remaining)
  ).objects;
  const excluded = new Set(destructible.filter((object) => !protectedObjects.has(object)));
  const graph = collectibleGraph([...cyclic, ...arrayCandidates], afterArrays, excluded, new Set(remaining));
  for (const object of handles) if (!after.has(object)) runtime.freeObject(object);
  finishArrayCollection(runtime, arrayStorage);
  retainTurtles(runtime, after);
  return graph.objects.size + graph.arrays.size;
}

/**
 * Frees what letting go of `dropped` frees, at once and in PHP's order, as PHP's reference counting does when a
 * variable, element, property, or temporary lets go of its value. An object that nothing reachable holds any more is
 * destroyed from the dropped values outward: its destructor runs, then what it holds is released in order, then its
 * handle returns to the free list. Objects on a cycle stay, as reference counting cannot free them.
 */
// code-gauge-allow functionNcss 48 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
export function releaseDropped(runtime: Runtime, dropped: unknown[]): void {
  if (runtime.shuttingDown || runtime.exhausted) return;
  releaseDroppedNow(runtime, dropped);
  const candidates = [...runtime.pendingGcRoots];
  runtime.pendingGcRoots.clear();
  if (runtime.collectingCycles) return;
  let roots: Set<unknown> | undefined;
  for (const value of candidates) {
    if (value instanceof PhpObject) {
      if (value.isResource || runtime.objects.get(value.id) !== value) continue;
    } else if (value instanceof PhpArray) {
      if (value.uncollectable) continue;
      roots ??= ownershipRoots(runtime);
      if (!ownedReachable(value, roots, runtime, undefined, undefined, true)) {
        runtime.gcRoots.delete(value);
        continue;
      }
    } else continue;
    if (runtime.gcRoots.has(value)) continue;
    if (runtime.gcEnabled && runtime.gcRoots.size >= runtime.gcThreshold - 1) {
      const arrayCycle = value instanceof PhpArray && runtime.arrayCycles.has(value);
      const objectCycle = value instanceof PhpObject && runtime.objectCycles.has(value);
      runtime.held.push(value);
      let count: number;
      try {
        count = collectGarbage(runtime, true);
      } finally {
        runtime.held.pop();
      }
      if (arrayCycle) runtime.arrayCycles.add(value as PhpArray);
      if (objectCycle) runtime.objectCycles.add(value as PhpObject);
      if (count < GC_THRESHOLD_TRIGGER || runtime.gcRoots.size >= runtime.gcThreshold)
        runtime.gcThreshold += GC_THRESHOLD_STEP;
      else runtime.gcThreshold = Math.max(GC_THRESHOLD_DEFAULT, runtime.gcThreshold - GC_THRESHOLD_STEP);
    }
    runtime.gcRoots.add(value);
  }
}

// code-gauge-allow functionNcss 53 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
// code-gauge-allow functionCognitiveComplexity 29 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function releaseDroppedNow(runtime: Runtime, dropped: unknown[]): void {
  if (runtime.shuttingDown || runtime.exhausted) return;
  dropped = dropped.filter(
    (value) => !(value instanceof PhpObject && activeReleaseObjects.get(value)?.hasVisited(value))
  );
  if (!dropped.some((value) => mayHoldObject(value, runtime))) return;
  const roots = ownershipRoots(runtime);
  const unreachable = new Set<object>();
  dropped = dropped.filter(
    (value) =>
      (value instanceof PhpObject && activeReleaseObjects.has(value)) ||
      !(value instanceof Ref || value instanceof PhpArray || value instanceof PhpObject) ||
      !ownedReachable(value, roots, runtime, unreachable)
  );
  if (dropped.length === 0) return;
  const cycleCount = runtime.arrayCycles.size;
  const arrayStorage = bufferArrayCycles(runtime, dropped, roots, unreachable);
  if (runtime.arrayCycles.size !== cycleCount) unreachable.clear();
  const detached = (value: Ref | PhpArray | PhpObject): boolean => !ownedReachable(value, roots, runtime, unreachable);
  const garbage = objectsWithin(dropped, detached);
  const freed = new Set<PhpObject>();
  if (garbage.length > 0) {
    runtime.spend();
    for (const object of freeable(garbage, detached)) freed.add(object);
    for (const object of garbage) if (!freed.has(object)) runtime.objectCycles.add(object);
  }
  if (freed.size === 0 && activeReleaseObjects.size === 0) {
    retireArrays(runtime, arrayStorage);
    return;
  }
  const release = new Release(runtime, freed, roots);
  const active = [...freed];
  for (const object of active) activeReleaseObjects.set(object, release);
  releasing++;
  let failure: unknown;
  let failed = false;
  try {
    release.values(dropped);
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    releasing--;
    for (const object of active) {
      activeReleaseObjects.delete(object);
      pendingReleaseObjects.delete(object);
    }
    if (activeReleaseObjects.size === 0) releaseSequence = 0;
    if (!failed || failure instanceof PhpThrow)
      withPendingException(runtime, failure instanceof PhpThrow ? failure : undefined, () =>
        retireArrays(runtime, arrayStorage)
      );
  }
  if (active.length === 0 || runtime.turtleObjects.size === 0) return;
  const turtleRoots = ownershipRoots(runtime);
  retainTurtles(
    runtime,
    new Set([...runtime.turtleObjects].filter((object) => ownedReachable(object, turtleRoots, runtime)))
  );
}

class ReleaseFinish {
  constructor(readonly object: PhpObject) {}
}

class Release {
  private readonly visited = new Set<PhpObject>();
  private readonly visitedArrays = new Set<PhpArray>();
  private unreachable = new Set<object>();
  private retainedBefore: number | undefined;

  constructor(
    private readonly runtime: Runtime,
    private readonly freed: Set<PhpObject>,
    private roots: Set<unknown>
  ) {}

  // code-gauge-allow functionNcss 48 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  values(values: unknown[]): void {
    const pending: unknown[] = values.toReversed();
    const heldMark = this.runtime.held.length;
    let failure: PhpThrow | undefined;
    const onFailure = (error: PhpThrow): void => {
      if (failure) setPrevious(error.object, failure.object);
      failure = error;
      this.runtime.held.push(error.object);
    };
    let work = 0;
    try {
      while (pending.length > 0) {
        if ((++work & 255) === 0) this.runtime.budget.checkClock();
        const item = pending.pop();
        if (item instanceof ReleaseFinish) {
          this.runtime.freeObject(item.object);
          pendingReleaseObjects.delete(item.object);
        } else if (item instanceof Ref) pending.push(item.v);
        else if (item instanceof PhpArray) {
          if (
            !item.composite ||
            this.visitedArrays.has(item) ||
            ownedReachable(item, this.roots, this.runtime, this.unreachable, this.retainedBefore)
          )
            continue;
          this.visitedArrays.add(item);
          appendReversed(pending, item.map.values());
        } else if (item instanceof PhpObject) {
          const owner = activeReleaseObjects.get(item);
          if (owner && owner !== this) {
            try {
              owner.resume(item);
            } catch (error) {
              if (!(error instanceof PhpThrow)) throw error;
              onFailure(error);
            }
            continue;
          }
          const finish = this.prepare(item, onFailure);
          if (!finish) continue;
          pending.push(finish);
          const children: unknown[] = [];
          pushObject(item, children);
          appendReversed(pending, children);
        }
      }
      if (failure) {
        this.runtime.thrown = failure.object;
        throw failure;
      }
    } finally {
      this.runtime.held.length = heldMark;
    }
  }

  hasVisited(object: PhpObject): boolean {
    return this.visited.has(object);
  }

  resume(object: PhpObject): void {
    if (this.visited.has(object)) return;
    const previousRoots = this.roots;
    const previousUnreachable = this.unreachable;
    const previousRetained = this.retainedBefore;
    this.retainedBefore = releaseSequence;
    this.roots = ownershipRoots(this.runtime);
    this.unreachable = new Set();
    try {
      this.values([object]);
    } finally {
      this.roots = previousRoots;
      this.unreachable = previousUnreachable;
      this.retainedBefore = previousRetained;
    }
  }

  private prepare(object: PhpObject, onFailure: (error: PhpThrow) => void): ReleaseFinish | undefined {
    if (!this.freed.has(object) || this.visited.has(object) || this.runtime.objects.get(object.id) !== object)
      return undefined;
    if (ownedReachable(object, this.roots, this.runtime, this.unreachable, this.retainedBefore)) return undefined;
    this.visited.add(object);
    pendingReleaseObjects.set(object, ++releaseSequence);
    if (!object.destructed && object.cls.findMethod('__destruct')) {
      object.destructed = true;
      this.runtime.destructibles--;
      const changes: OwnershipChange[] = [];
      const stopObserving = observeOwnership((change) => changes.push(change));
      try {
        destruct(object, this.runtime.row);
      } catch (error) {
        if (!(error instanceof PhpThrow)) throw error;
        onFailure(error);
      } finally {
        stopObserving();
      }
      const roots = ownershipRoots(this.runtime);
      if ([...roots].some((root) => this.unreachable.has(root as object)) || this.revived(changes, roots))
        this.unreachable.clear();
      this.roots = roots;
      if (ownedReachable(object, this.roots, this.runtime, this.unreachable, this.retainedBefore)) {
        this.freed.delete(object);
        pendingReleaseObjects.delete(object);
        return undefined;
      }
    }
    return new ReleaseFinish(object);
  }

  private revived(changes: OwnershipChange[], roots: Set<unknown>): boolean {
    for (const change of changes) {
      if (change.kind === 'edge') {
        if (!this.unreachable.has(change.value) || !ownershipEdgeExists(change)) continue;
      } else {
        const held: unknown[] = [];
        pushObject(change.owner, held);
        if (!held.some((value) => this.unreachable.has(value as object))) continue;
      }
      if (ownedReachable(change.owner, roots, this.runtime, this.unreachable, this.retainedBefore)) return true;
    }
    return false;
  }
}

/** How many releases are running, during which a collection would free their objects out of order. */
let releasing = 0;
const activeReleaseObjects = new Map<PhpObject, Release>();
const pendingReleaseObjects = new Map<PhpObject, number>();
let releaseSequence = 0;

function mayHoldObject(value: unknown, runtime: Runtime): boolean {
  return (
    value instanceof PhpObject ||
    (value instanceof PhpArray && value.composite && !objectFree(value, runtime)) ||
    value instanceof Ref
  );
}

// code-gauge-allow functionCognitiveComplexity 21 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function objectsWithin(values: unknown[], include: (value: Ref | PhpArray | PhpObject) => boolean): PhpObject[] {
  const found = new Set<PhpObject>();
  const seenArrays = new Set<PhpArray>();
  const pending = [...values];
  while (pending.length > 0) {
    const item = pending.pop();
    if (item instanceof Ref) {
      if (include(item)) pending.push(item.v);
    } else if (item instanceof PhpArray) {
      if (!item.composite || seenArrays.has(item) || !include(item)) continue;
      seenArrays.add(item);
      appendValues(pending, [...item.map.values()]);
    } else if (item instanceof PhpObject) {
      if (activeReleaseObjects.has(item)) continue;
      if (found.has(item) || !include(item)) continue;
      found.add(item);
      pushObject(item, pending);
    } else if (item instanceof Map) appendValues(pending, [...item.values()]);
    else if (Array.isArray(item)) appendValues(pending, [...item]);
  }
  return [...found];
}

function heldArrayCount(values: unknown[], reachedArrays: Set<PhpArray>): number {
  return collectibleGraph(values, reachedArrays).arrays.size;
}

// code-gauge-allow functionNcss 35 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
// code-gauge-allow functionCognitiveComplexity 29 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function collectibleGraph(
  values: unknown[],
  reachedArrays: Set<PhpArray>,
  excluded = new Set<PhpObject>(),
  allowed?: Set<PhpObject>
): { arrays: Set<PhpArray>; objects: Set<PhpObject> } {
  const arrays = new Set<PhpArray>();
  const eligible = new Set<PhpArray>();
  const objects = new Set<PhpObject>();
  const parents = new Map<PhpArray, Set<PhpArray>>();
  const pending: unknown[] = [...values];
  while (pending.length > 0) {
    const item = pending.pop();
    if (item instanceof Ref) pending.push(item.v);
    else if (item instanceof PhpArray) {
      if (reachedArrays.has(item) || arrays.has(item)) continue;
      arrays.add(item);
      for (const slot of item.map.values()) {
        if (slot instanceof Ref || slot instanceof PhpObject) eligible.add(item);
        if (slot instanceof PhpArray) {
          const holders = parents.get(slot) ?? new Set<PhpArray>();
          holders.add(item);
          parents.set(slot, holders);
        }
        pending.push(slot);
      }
    } else if (
      item instanceof PhpObject &&
      !objects.has(item) &&
      !excluded.has(item) &&
      (!allowed || allowed.has(item))
    ) {
      objects.add(item);
      pushObject(item, pending);
    }
  }
  const affected = [...eligible];
  while (affected.length > 0) {
    const child = affected.pop() as PhpArray;
    for (const parent of parents.get(child) ?? [])
      if (!eligible.has(parent)) {
        eligible.add(parent);
        affected.push(parent);
      }
  }
  return { arrays: eligible, objects };
}

function finishArrayCollection(runtime: Runtime, arrays: Iterable<PhpArray>): void {
  runtime.collectingArrays.clear();
  retireArrays(runtime, arrays);
}

// code-gauge-allow functionCognitiveComplexity 20 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function retireArrays(runtime: Runtime, arrays: Iterable<PhpArray>): void {
  const pending = [...arrays];
  if (pending.length === 0) return;
  const roots = ownershipRoots(runtime);
  const seen = new Set<PhpArray>();
  const released: unknown[] = [];
  while (pending.length > 0) {
    const array = pending.pop() as PhpArray;
    if (seen.has(array) || !array.composite) continue;
    seen.add(array);
    if (ownedReachable(array, roots, runtime, undefined, undefined, true)) continue;
    runtime.gcRoots.delete(array);
    for (const slot of array.retire()) {
      const value = slot instanceof Ref ? slot.v : slot;
      runtime.pendingGcRoots.add(value);
      if (value instanceof PhpArray) pending.push(value);
      if (slot instanceof Ref || value instanceof PhpObject) released.push(slot);
    }
  }
  if (released.length > 0) runtime.release(released);
}

function bufferArrayCycles(
  runtime: Runtime,
  values: unknown[],
  roots: Set<unknown>,
  unreachable: Set<object>
): Set<PhpArray> {
  const graph = new DetachedArrays(runtime, roots, unreachable);
  graph.run(values);
  return graph.arrays;
}

class DetachedArrays {
  readonly arrays = new Set<PhpArray>();
  private readonly visited = new Set<object>();
  private readonly active = new Map<object, number>();
  private readonly frames: { node: object; children: Iterator<unknown> }[] = [];
  constructor(
    private readonly runtime: Runtime,
    private readonly roots: Set<unknown>,
    private readonly unreachable: Set<object>
  ) {}
  run(values: unknown[]): void {
    for (const value of values) {
      this.enter(value);
      while (this.frames.length > 0) {
        this.runtime.spend();
        const frame = this.frames.at(-1) as (typeof this.frames)[number];
        const child = frame.children.next();
        if (child.done) {
          this.active.delete(frame.node);
          this.frames.pop();
        } else this.enter(child.value);
      }
    }
  }
  // code-gauge-allow functionNcss 35 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  // code-gauge-allow functionCognitiveComplexity 22 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  private enter(node: unknown): void {
    if (!(node instanceof Ref || node instanceof PhpArray || node instanceof PhpObject)) return;
    if (node instanceof PhpObject && activeReleaseObjects.has(node)) return;
    if (node instanceof PhpArray && (!node.composite || objectFreeArrays.get(node) === node.mutationVersion)) return;
    const position = this.active.get(node);
    if (position !== undefined) {
      const cycle = this.frames.slice(position).map((frame) => frame.node);
      if (cycle.some((item) => item instanceof PhpObject)) return;
      for (const item of cycle)
        if (item instanceof PhpArray && !ownedReachable(item, this.roots, this.runtime, undefined, releaseSequence))
          this.runtime.arrayCycles.add(item);
      return;
    }
    if (this.visited.has(node)) return;
    if (ownedReachable(node, this.roots, this.runtime, this.unreachable, releaseSequence)) return;
    if (node instanceof PhpArray) this.arrays.add(node);
    this.visited.add(node);
    this.active.set(node, this.frames.length);
    let children: Iterator<unknown>;
    if (node instanceof Ref) children = [node.v].values();
    else if (node instanceof PhpArray) children = node.map.values();
    else {
      const items: unknown[] = [];
      pushObject(node, items);
      children = items.values();
    }
    this.frames.push({ node, children });
  }
}

/** Releases values whose native call has finished before reusing object handles. */
export function collectBeforeAllocation(runtime: Runtime): void {
  runtime.flushReleases();
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
// code-gauge-allow functionNcss 59 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
// code-gauge-allow functionCognitiveComplexity 27 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
export function mark(runtime: Runtime, includeBuffered = true, visitedArrays = new Set<PhpArray>()): Set<PhpObject> {
  const reached = new Set<PhpObject>();
  const roots: unknown[] = [];
  for (const object of activeReleaseObjects.keys()) if (runtime.objects.get(object.id) === object) roots.push(object);
  appendValues(roots, ownershipRoots(runtime));
  if (includeBuffered)
    appendValues(roots, [...runtime.arrayCycles, ...runtime.collectingArrays, ...runtime.objectCycles]);
  // A stack visits the first of the items pushed together first when they are pushed in reverse.
  const pending = roots.toReversed();
  const pushInOrder = (items: Iterable<unknown>): void => {
    const list = [...items];
    for (let index = list.length - 1; index >= 0; index--) pending.push(list[index]);
  };
  let visits = 0;
  while (pending.length > 0) {
    if (++visits % 8 === 0) runtime.spend();
    const item = pending.pop();
    if (item instanceof Ref) {
      pending.push(item.v);
    } else if (item instanceof PhpArray) {
      if (visitedArrays.has(item)) continue;
      visitedArrays.add(item);
      if (!item.composite || (!runtime.collectingCycles && objectFree(item, runtime))) continue;
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
  appendValues(pending, [...frame.temporaries, ...frame.args, frame.returning]);
  if (frame.thisObj) pending.push(frame.thisObj);
  if (frame.closure) pending.push(frame.closure);
}

function pushObject(object: PhpObject, pending: unknown[]): void {
  for (const slot of object.props.values()) if (typeof slot === 'object' && slot !== null) pending.push(slot);
  const internal = object.internal;
  if (internal === undefined) return;
  if (isClosure(object)) {
    const data = internal as ClosureData;
    appendValues(pending, [...data.bound.values()]);
    if (data.thisObj) pending.push(data.thisObj);
    if (data.fn.kind === 'user') appendValues(pending, [...data.fn.statics.values()]);
    return;
  }
  const held = (internal as { held?: () => unknown[] }).held;
  if (typeof held === 'function') appendValues(pending, [...held.call(internal)]);
}

/**
 * The garbage objects that reference counting frees: all but those a cycle of garbage keeps, which are the objects on
 * a cycle and those reachable from one.
 */
function freeable(garbage: PhpObject[], include?: (value: Ref | PhpArray) => boolean): PhpObject[] {
  const { edges, cyclic } = cyclicObjects(garbage, include);
  const kept = new Set<PhpObject>();
  const pending = [...cyclic];
  while (pending.length > 0) {
    const object = pending.pop() as PhpObject;
    if (kept.has(object)) continue;
    kept.add(object);
    appendValues(pending, [...(edges.get(object) as PhpObject[])]);
  }
  return garbage.filter((object) => !kept.has(object));
}

// code-gauge-allow functionNcss 55 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function cyclicObjects(
  garbage: PhpObject[],
  include?: (value: Ref | PhpArray) => boolean
): { edges: Map<PhpObject, PhpObject[]>; cyclic: Set<PhpObject> } {
  const set = new Set(garbage);
  const edges = new Map<PhpObject, PhpObject[]>();
  for (const object of garbage)
    edges.set(
      object,
      referencedObjects(object, include).filter((target) => set.has(target))
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
  return { edges, cyclic };
}

/**
 * The order in which PHP releases freed objects: a holder releases what it holds in order (an array its elements, a
 * function its variables), so the objects nothing else freed refers to go in the order the program held them, as the
 * last reachability pass saw it. Destructors run owners first; handles return to the free list owners last, after
 * releasing an object has released what it held.
 */
// code-gauge-allow functionNcss 52 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function releaseOrder(
  freed: PhpObject[],
  previousOrder: Map<PhpObject, number>,
  runtime: Runtime,
  buffered?: (PhpArray | PhpObject)[]
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
    const pending: { object: PhpObject; finish: boolean }[] = [{ object, finish: false }];
    let work = 0;
    while (pending.length > 0) {
      if ((++work & 255) === 0) runtime.budget.checkClock();
      const item = pending.pop() as { object: PhpObject; finish: boolean };
      if (item.finish) {
        handles.push(item.object);
        continue;
      }
      if (visited.has(item.object)) continue;
      visited.add(item.object);
      owners.push(item.object);
      pending.push({ object: item.object, finish: true });
      const children = edges.get(item.object) as PhpObject[];
      for (let index = children.length - 1; index >= 0; index--)
        pending.push({ object: children[index], finish: false });
    }
  };
  if (buffered) {
    const pending: unknown[] = buffered.toReversed();
    const arrays = new Set<PhpArray>();
    while (pending.length > 0) {
      const value = pending.pop();
      if (value instanceof PhpObject) {
        if (set.has(value)) visit(value);
      } else if (value instanceof Ref) pending.push(value.v);
      else if (value instanceof PhpArray && !arrays.has(value)) {
        arrays.add(value);
        appendReversed(pending, value.map.values());
      }
    }
  }
  const position = (object: PhpObject): number => previousOrder.get(object) ?? Number.MAX_SAFE_INTEGER;
  const roots = freed
    .filter((object) => !referenced.has(object))
    .toSorted((a, b) => position(a) - position(b) || a.id - b.id);
  for (const root of roots) visit(root);
  for (const object of freed) visit(object);
  return { owners, handles };
}

/** The objects an object refers to directly or through arrays it holds, in property order. */
export function referencedObjects(
  object: PhpObject,
  include: (value: Ref | PhpArray) => boolean = () => true
): PhpObject[] {
  const found: PhpObject[] = [];
  const pending: unknown[] = [];
  pushObject(object, pending);
  pending.reverse();
  const seenArrays = new Set<PhpArray>();
  while (pending.length > 0) {
    const item = pending.pop();
    if (item instanceof Ref) {
      if (include(item)) pending.push(item.v);
    } else if (item instanceof PhpObject) found.push(item);
    else if (item instanceof PhpArray) {
      if (seenArrays.has(item) || !include(item)) continue;
      seenArrays.add(item);
      appendReversed(pending, item.map.values());
    } else if (item instanceof Map) appendReversed(pending, item.values());
    else if (Array.isArray(item)) appendReversed(pending, item);
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
  const count = (value: unknown): void => {
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

const objectFreeArrays = new WeakMap<PhpArray, number>();

// code-gauge-allow functionCognitiveComplexity 21 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function objectFree(array: PhpArray, runtime: Runtime): boolean {
  if (objectFreeArrays.get(array) === array.mutationVersion) return true;
  const pending = [array];
  const visited = new Set<PhpArray>();
  while (pending.length > 0) {
    const current = pending.pop() as PhpArray;
    if (visited.has(current) || objectFreeArrays.get(current) === current.mutationVersion) continue;
    visited.add(current);
    runtime.spend(Math.ceil(current.size / 64));
    for (const slot of current.map.values()) {
      if (slot instanceof Ref || slot instanceof PhpObject) return false;
      if (slot instanceof PhpArray && slot.composite) pending.push(slot);
    }
  }
  for (const item of visited) {
    objectFreeArrays.set(item, item.mutationVersion);
    for (const slot of item.map.values()) if (slot instanceof PhpArray) slot.trackCachedParent(item);
  }
  return true;
}

// code-gauge-allow functionCognitiveComplexity 22 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
export function arrayIsShared(runtime: Runtime, target: PhpArray): boolean {
  let count = arrayHolderCount(target);
  if (count > 1) return true;
  for (const frame of runtime.frames) {
    for (const value of frame.temporaries) if (value === target && ++count > 1) return true;
    if (frame.returning === target && ++count > 1) return true;
  }
  for (const value of runtime.held) if (value === target && ++count > 1) return true;
  for (const values of runtime.nativeHeld) for (const value of values) if (value === target && ++count > 1) return true;
  return false;
}

function ownershipRoots(runtime: Runtime): Set<unknown> {
  const roots: unknown[] = [];
  for (const frame of runtime.frames) pushFrame(frame, roots);
  for (const fn of runtime.userFunctions) appendValues(roots, fn.statics.values());
  for (const cls of runtime.userClasses) {
    for (const { ref } of cls.staticProps.values()) roots.push(ref);
    for (const constant of cls.consts.values()) roots.push(constant.value);
    for (const method of cls.methods.values())
      if (method.fn.kind === 'user') appendValues(roots, [...method.fn.statics.values()]);
  }
  roots.push(
    ...runtime.rootConstants,
    ...runtime.held,
    runtime.exceptionHandler,
    ...runtime.replacedExceptionHandlers,
    runtime.thrown
  );
  for (const held of runtime.nativeHeld) appendValues(roots, [...held]);
  for (const { handler } of runtime.errorHandlers) roots.push(handler);
  return new Set(
    roots.filter((value) => value instanceof Ref || value instanceof PhpArray || value instanceof PhpObject)
  );
}

// code-gauge-allow functionNcss 39 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function ownedReachable(
  value: Ref | PhpArray | PhpObject,
  roots: Set<unknown>,
  runtime: Runtime,
  unreachable?: Set<object>,
  retainedBefore?: number,
  retainOwners = false
): boolean {
  const isRoot = (value: object): boolean => {
    if (
      roots.has(value) ||
      (value instanceof PhpObject && (runtime.objectCycles.has(value) || runtime.collectingObjects.has(value))) ||
      (value instanceof PhpArray && (runtime.arrayCycles.has(value) || runtime.collectingArrays.has(value)))
    )
      return true;
    if (
      retainOwners &&
      ((value instanceof PhpObject && runtime.objects.get(value.id) === value) ||
        (value instanceof PhpArray && value.persistentHolder))
    )
      return true;
    const sequence = value instanceof PhpObject ? pendingReleaseObjects.get(value) : undefined;
    return retainedBefore !== undefined && sequence !== undefined && sequence <= retainedBefore;
  };
  const pending: object[] = [value];
  const visited = new Set<object>();
  const predecessor = new Map<object, object>();
  let work = 0;
  while (pending.length > 0) {
    if ((++work & 255) === 0) runtime.budget.checkClock();
    const item = pending.pop() as object;
    if (unreachable?.has(item)) continue;
    const root = isRoot(item) ? item : retainOwners ? undefined : ownershipProof(item, isRoot);
    if (root) {
      const path = [item];
      let child = predecessor.get(item);
      while (child) {
        path.push(child);
        child = predecessor.get(child);
      }
      if (!retainOwners) rememberOwnership(path, root);
      return true;
    }
    if (visited.has(item)) continue;
    visited.add(item);
    for (const parent of reverseOwners(item, runtime, visited)) {
      if (!visited.has(parent) && !predecessor.has(parent)) {
        predecessor.set(parent, item);
        pending.push(parent);
      }
    }
  }
  if (unreachable) for (const item of visited) unreachable.add(item);
  return false;
}

function* reverseOwners(value: object, runtime: Runtime, visited: Set<object>): Generator<object> {
  yield* valueOwners(value);
  for (const object of runtime.internalObjects) {
    if (visited.has(object) || object.nativeValues) continue;
    const held: unknown[] = [];
    pushObject(object, held);
    if (held.includes(value)) yield object;
  }
}

function appendValues(target: unknown[], values: Iterable<unknown>): void {
  for (const value of values) target.push(value);
}
function appendReversed(target: unknown[], values: Iterable<unknown>): void {
  const list = [...values];
  for (let index = list.length - 1; index >= 0; index--) target.push(list[index]);
}
