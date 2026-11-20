// code-gauge-allow-file fileNcss 1000 -- Holds object ownership, reachability and release with their shared helpers.
import type { TurtleState } from '../interpreter/turtleWorld';
import { type CleanupException, withCleanupExceptions, withPendingException } from './errors';
import {
  bufferedArrays,
  cachedObjectFree,
  collectGarbageNodes,
  deferredHandleOrder,
  forgetCollectedArrayCycles,
  objectFree,
  orderDestructedCollection,
  recordGcRoot,
  retireCollected,
  survivingRoots,
  withReachableCached,
} from './gcRoots';
import { ExitSignal, type Frame, PhpThrow, type Runtime } from './runtime';
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

/** Runs the destructor of an object, which the interpreter provides. */
let destruct: (object: PhpObject, row?: number) => void = () => {};

export function setDestructor(run: (object: PhpObject, row?: number) => void): void {
  destruct = run;
}

/** Collects unreachable objects and, when `cycles` is set, cycles; returns PHP's count of objects and arrays. */
export function collectGarbage(runtime: Runtime, cycles = false, stopOnException = false): number {
  if (runtime.collectingCycles || runtime.collectingObjects.size > 0) return 0;
  runtime.collectingCycles = cycles;
  if (cycles) for (const value of gcForeachSubjects(runtime)) runtime.gcRoots.delete(value);
  try {
    return collectGarbageNow(runtime, cycles, stopOnException);
  } finally {
    runtime.collectingCycles = false;
    runtime.collectingArrays.clear();
    runtime.collectingObjects.clear();
    runtime.destructedCollectionRoots.clear();
    if (cycles) for (const value of gcForeachSubjects(runtime)) runtime.gcRoots.add(value);
  }
}

function gcForeachSubjects(runtime: Runtime): (PhpArray | PhpObject)[] {
  return runtime.frames
    .flatMap((frame) => frame.foreachSubjects)
    .map((subject) => (subject instanceof Ref ? subject.v : subject))
    .filter((value): value is PhpArray | PhpObject =>
      value instanceof PhpArray
        ? !value.uncollectable
        : value instanceof PhpObject && !value.isResource && runtime.objects.get(value.id) === value
    );
}

// code-gauge-allow functionCognitiveComplexity 26 -- The first pass collects the same live snapshots for both release paths.
// code-gauge-allow functionNcss 44 -- Shares mark results, roots and release order across both release paths.
function collectGarbageNow(runtime: Runtime, cycles: boolean, stopOnException: boolean): number {
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
    runtime.pendingGcRoots.clear();
    runtime.arrayCycles.clear();
    runtime.objectCycles.clear();
    for (const array of arrayCandidates) runtime.collectingArrays.add(array);
  }
  const arrayCount = heldArrayCount(arrayCandidates, reachedArrays);
  const garbage: PhpObject[] = [];
  for (const object of runtime.objects.values())
    if (!reached.has(object) && !runtime.retiringObjects.has(object)) garbage.push(object);
  if (garbage.length === 0) {
    finishArrayCollection(runtime, arrayCandidates);
    retainTurtles(runtime, reached);
    return arrayCount;
  }
  const freed = cycles ? garbage : freeable(garbage, runtime);
  if (freed.length === 0) {
    finishArrayCollection(runtime, arrayCandidates);
    retainTurtles(runtime, reached);
    return arrayCount;
  }
  for (const object of freed) runtime.collectingObjects.add(object);
  const { owners, handles, nodes } = releaseOrder(freed, previousOrder, runtime, buffered);
  const arrayStorage = collectibleGraph([...freed, ...arrayCandidates], reachedArrays).arrays;
  const collected = freed.length + arrayStorage.size;
  const destructible = freed.filter((object) => !object.destructed && object.cls.findMethod('__destruct'));
  if (destructible.length === 0 || runtime.shuttingDown) {
    const ordered = orderCollectedObjects(runtime, cycles, owners, freed, handles, reachedArrays, buffered);
    finishCollectedObjects(runtime, ordered, arrayStorage, nodes);
    return collected;
  }
  return collectAfterDestruction(
    runtime,
    { owners, handles, destructible, arrayStorage, buffered, nodes },
    stopOnException
  );
}

function collectAfterDestruction(
  runtime: Runtime,
  batch: {
    owners: PhpObject[];
    handles: PhpObject[];
    destructible: PhpObject[];
    arrayStorage: Set<PhpArray>;
    buffered?: (PhpObject | PhpArray)[];
    nodes?: (PhpObject | PhpArray)[];
  },
  stopOnException: boolean
): number {
  const { owners, handles, destructible, arrayStorage, buffered, nodes } = batch;
  let count = 0;
  // PHP leaves what objects with destructors hold out of this run as the graph stood before the destructors ran.
  const nested = withReachableCached<CollectionNode, CollectionGraph>(
    new CollectionGraph(handles, runtime),
    destructible
  );
  withCleanupExceptions(runtime, (capture) => {
    for (const object of owners) {
      if (object.destructed || !object.cls.findMethod('__destruct')) continue;
      object.destructed = true;
      runtime.destructibles--;
      try {
        runtime.held.push(object);
        try {
          destruct(object);
        } finally {
          runtime.held.pop();
        }
      } catch (error) {
        if (stopOnException || !(error instanceof PhpThrow)) throw error;
        capture(error);
      }
      retainCollectionReceiver(runtime, object);
    }
    const afterArrays = new Set<PhpArray>();
    const after = mark(runtime, false, afterArrays);
    const remaining = handles.filter((object) => runtime.objects.get(object.id) === object && !after.has(object));
    const result = countAfterDestruction(runtime, { owners, remaining, destructible, afterArrays, buffered, nested });
    count = result.count;
    finishCollectedObjects(runtime, result.ordered, arrayStorage, nodes, result.passTwoNodes);
    forgetCollectedArrayCycles(runtime, result.freed);
  });
  return count;
}

function finishCollectedObjects(
  runtime: Runtime,
  objects: PhpObject[],
  arrayStorage: Set<PhpArray>,
  garbageNodes?: (PhpObject | PhpArray)[],
  passTwoNodes?: (PhpObject | PhpArray)[]
): void {
  const objectChildren = new Map<PhpObject, unknown[]>();
  const allChildren: unknown[] = [];
  for (const object of objects) {
    const props: unknown[] = [];
    pushObject(object, props);
    objectChildren.set(object, props);
    allChildren.push(...props);
    runtime.freeObject(object);
  }
  runtime.pendingGcRoots.clear();
  runtime.collectingArrays.clear();
  const roots = ownershipRoots(runtime);
  retireCollected({
    runtime,
    objectChildren,
    allChildren,
    arrayStorage,
    isLiveArray: (array) => ownedReachable(array, roots, runtime, undefined, undefined, true),
    garbageNodes,
    passTwoNodes,
  });
  releaseDropped(runtime, allChildren, true);
  if (runtime.collectingCycles && garbageNodes !== undefined) runtime.gcRoots.compact();
  retainTurtles(runtime, mark(runtime));
}

// code-gauge-allow functionParameterCount 7 -- Shares the GC cycle collection snapshot with collectGarbageNow.
function orderCollectedObjects(
  runtime: Runtime,
  cycles: boolean,
  roots: PhpObject[],
  freed: PhpObject[],
  handles: PhpObject[],
  reachedArrays: Set<PhpArray>,
  buffered?: (PhpObject | PhpArray)[]
): PhpObject[] {
  if (!cycles || runtime.shuttingDown) return handles;
  const graph = new CollectionGraph(
    freed,
    runtime,
    (value) => !(value instanceof PhpArray && reachedArrays.has(value))
  );
  const freedSet = new Set(freed);
  const cyclicRoots: CollectionNode[] = buffered
    ? buffered.filter((item) => (item instanceof PhpObject ? freedSet.has(item) : !reachedArrays.has(item)))
    : roots;
  return deferredHandleOrder<CollectionNode, PhpObject>(
    cyclicRoots,
    freedSet,
    (node): node is PhpObject => node instanceof PhpObject,
    (node) => graph.children(node)
  );
}

function retainCollectionReceiver(runtime: Runtime, object: PhpObject): void {
  if (!runtime.collectingObjects.delete(object)) return;
  try {
    if (!ownedReachable(object, ownershipRoots(runtime), runtime)) runtime.destructedCollectionRoots.add(object);
  } finally {
    runtime.collectingObjects.add(object);
  }
}

function countAfterDestruction(
  runtime: Runtime,
  state: {
    owners: PhpObject[];
    remaining: PhpObject[];
    destructible: PhpObject[];
    afterArrays: Set<PhpArray>;
    buffered?: (PhpObject | PhpArray)[];
    nested: CollectionGraph;
  }
): { count: number; ordered: PhpObject[]; passTwoNodes: (PhpObject | PhpArray)[]; freed: Set<CollectionNode> } {
  const { owners, remaining, destructible, afterArrays, buffered, nested } = state;
  const allowed = new Set(remaining);
  const graph = new CollectionGraph(
    remaining,
    runtime,
    (value) => !(value instanceof PhpArray && afterArrays.has(value))
  );
  const isObject = (node: CollectionNode): node is PhpObject => node instanceof PhpObject;
  const children = (node: CollectionNode): CollectionNode[] => graph.children(node);
  const initialRoots: CollectionNode[] = buffered
    ? buffered.filter((item) => (item instanceof PhpObject ? allowed.has(item) : !afterArrays.has(item)))
    : owners.filter((object) => allowed.has(object));
  const result = orderDestructedCollection<CollectionNode, PhpObject>(
    initialRoots,
    new Set(destructible.filter((object) => allowed.has(object))),
    allowed,
    isObject,
    children,
    (node) => !(node instanceof Ref),
    {
      nestedChildren: (node) => nested.children(node),
      roots: survivingRoots<CollectionNode>(bufferedArrays(runtime, afterArrays), remaining, children),
    }
  );
  return {
    count: result.count,
    ordered: result.ordered,
    passTwoNodes: result.passTwoNodes.filter((node): node is PhpObject | PhpArray => !(node instanceof Ref)),
    freed: result.freed,
  };
}

/**
 * Frees what letting go of `dropped` frees, at once and in PHP's order, as PHP's reference counting does when a
 * variable, element, property, or temporary lets go of its value. An object that nothing reachable holds any more is
 * destroyed from the dropped values outward: its destructor runs, then what it holds is released in order, then its
 * handle returns to the free list. Objects on a cycle stay, as reference counting cannot free them.
 */
// code-gauge-allow functionCognitiveComplexity 22 -- Flushes pending GC root candidates after scoped release.
export function releaseDropped(
  runtime: Runtime,
  dropped: unknown[],
  fromNative: boolean,
  mode: ReleaseMode = 'ordinary',
  initialFailure?: CleanupException
): void {
  if (runtime.shuttingDown || runtime.exhausted) return;
  const collectible = releaseCollectionDescendants(runtime, dropped);
  runtime.scopePendingGcRoots(() => {
    try {
      releaseDroppedNow(runtime, dropped, fromNative, mode, initialFailure);
    } finally {
      for (const object of collectible)
        if (runtime.objects.get(object.id) === object) runtime.collectingObjects.add(object);
    }
  });
  const candidates = [...runtime.pendingGcRoots];
  runtime.pendingGcRoots.clear();
  let roots: Set<unknown> | undefined;
  for (const value of candidates) {
    if (value instanceof PhpObject) {
      if (!runtime.isCollectableObject(value)) continue;
    } else if (value instanceof PhpArray) {
      if (value.uncollectable || runtime.separatedArrays.delete(value)) continue;
      roots ??= ownershipRoots(runtime);
      if (!ownedReachable(value, roots, runtime, undefined, undefined, true)) {
        runtime.gcRoots.delete(value);
        continue;
      }
    } else continue;
    recordGcRoot(runtime, value, () => collectGarbage(runtime, true));
  }
}

function releaseCollectionDescendants(runtime: Runtime, dropped: unknown[]): PhpObject[] {
  if (runtime.collectingObjects.size === 0) return [];
  const collectible = objectsWithin(dropped, (value) => {
    runtime.spend();
    return (
      !(value instanceof PhpObject) ||
      (runtime.collectingObjects.has(value) && !runtime.destructedCollectionRoots.has(value))
    );
  });
  for (const object of collectible) runtime.collectingObjects.delete(object);
  return collectible;
}

// code-gauge-allow functionNcss 53 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
// code-gauge-allow functionCognitiveComplexity 30 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function releaseDroppedNow(
  runtime: Runtime,
  dropped: unknown[],
  fromNative: boolean,
  mode: ReleaseMode,
  initialFailure?: CleanupException
): void {
  if (runtime.shuttingDown || runtime.exhausted) return;
  dropped = dropped.filter(
    (value) =>
      !(
        value instanceof PhpObject &&
        (runtime.collectingObjects.has(value) || activeReleaseObjects.get(value)?.hasVisited(value))
      )
  );
  if (!dropped.some((value) => mayHoldObject(value, runtime))) return runtime.retireObjectFreeArrays(dropped);
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
    for (const object of freeable(garbage, runtime, detached)) freed.add(object);
    for (const object of garbage) if (!freed.has(object)) runtime.objectCycles.add(object);
  }
  if (freed.size === 0 && activeReleaseObjects.size === 0) {
    retireArrays(runtime, arrayStorage, dropped);
    return;
  }
  const release = new Release(runtime, freed, roots, fromNative, mode);
  const active = release.active;
  releasing++;
  let failure: unknown;
  let failed = false;
  try {
    release.values(dropped, initialFailure);
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
    if (!failed || recoverableReleaseFailure(mode, failure))
      withPendingException(runtime, failure instanceof PhpThrow ? failure : undefined, () =>
        retireArrays(runtime, arrayStorage, dropped)
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

export type ReleaseMode = 'ordinary' | 'shutdown' | 'complete';

class Release {
  readonly active: PhpObject[] = [];
  private readonly visited = new Set<PhpObject>();
  private readonly visitedArrays = new Set<PhpArray>();
  private unreachable = new Set<object>();
  private retainedBefore: number | undefined;

  constructor(
    private readonly runtime: Runtime,
    private readonly freed: Set<PhpObject>,
    private roots: Set<unknown>,
    private readonly fromNative: boolean,
    private readonly mode: ReleaseMode
  ) {
    for (const object of freed) this.track(object);
  }

  values(values: unknown[], initialFailure?: CleanupException): void {
    const pending: unknown[] = [];
    this.enqueue(pending, values);
    let work = 0;
    try {
      withCleanupExceptions(
        this.runtime,
        (onFailure) => {
          if (initialFailure) onFailure(initialFailure);
          while (pending.length > 0) {
            if ((++work & 255) === 0) this.runtime.budget.checkClock();
            const item = pending.pop();
            this.unhold(item);
            this.releaseValue(item, pending, onFailure);
          }
        },
        this.mode === 'complete' ? 'latest' : 'prefer-exit'
      );
    } finally {
      for (const item of pending) {
        this.unhold(item);
        if (item instanceof ReleaseFinish) this.runtime.retiringObjects.delete(item.object);
      }
    }
  }

  // code-gauge-allow functionCognitiveComplexity 21 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  private releaseValue(item: unknown, pending: unknown[], onFailure: (error: CleanupException) => void): void {
    if (item instanceof ReleaseFinish) {
      this.runtime.freeObject(item.object);
      pendingReleaseObjects.delete(item.object);
    } else if (item instanceof Ref) {
      this.enqueue(pending, [item.v]);
    } else if (item instanceof PhpArray) {
      this.releaseArray(item, pending);
    } else if (item instanceof PhpObject) {
      const owner = activeReleaseObjects.get(item);
      if (owner && owner !== this) {
        try {
          owner.resume(item);
        } catch (error) {
          this.retainFailure(error, onFailure);
        }
        return;
      }
      const finish = this.prepare(item, onFailure);
      if (!finish) return this.visited.has(item) ? undefined : this.bufferSurvivor(item);
      if (item.internal !== undefined) this.releaseNative(item, onFailure);
      pending.push(finish);
      this.runtime.retiringObjects.add(item);
      const children: unknown[] = [];
      pushObject(item, children);
      this.enqueue(pending, children);
    }
  }

  private releaseArray(item: PhpArray, pending: unknown[]): void {
    if (this.visitedArrays.has(item)) return;
    if (ownedReachable(item, this.roots, this.runtime, this.unreachable, this.retainedBefore))
      return this.bufferSurvivor(item);
    this.runtime.gcRoots.delete(item);
    if (!item.composite) return;
    this.visitedArrays.add(item);
    this.enqueue(pending, [...item.map.ownedSlots()]);
  }

  private bufferSurvivor(value: PhpArray | PhpObject): void {
    if (this.runtime.retiringObjects.size === 0) return;
    if (value instanceof PhpArray ? value.uncollectable : !this.runtime.isCollectableObject(value)) return;
    if (recordGcRoot(this.runtime, value, () => collectGarbage(this.runtime, true))) {
      this.roots = ownershipRoots(this.runtime);
      this.unreachable.clear();
    }
  }

  private releaseNative(object: PhpObject, onFailure: (error: CleanupException) => void): void {
    const native = object.internal as { beforeRelease?: () => boolean } | undefined;
    if (!native?.beforeRelease) return;
    try {
      if (!native.beforeRelease()) return;
    } catch (error) {
      this.retainFailure(error, onFailure);
    }
    this.roots = ownershipRoots(this.runtime);
    this.unreachable.clear();
  }

  private enqueue(pending: unknown[], values: unknown[]): void {
    const held = this.runtime.releasingValues;
    for (let index = values.length - 1; index >= 0; index--) {
      const value = values[index];
      pending.push(value);
      if (!(value instanceof Ref || value instanceof PhpArray || value instanceof PhpObject)) continue;
      held.set(value, (held.get(value) ?? 0) + 1);
      if (this.unreachable.has(value)) this.unreachable.clear();
    }
  }

  private unhold(value: unknown): void {
    if (!(value instanceof Ref || value instanceof PhpArray || value instanceof PhpObject)) return;
    const held = this.runtime.releasingValues;
    const count = held.get(value) ?? 0;
    if (count > 1) held.set(value, count - 1);
    else held.delete(value);
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

  // code-gauge-allow functionCognitiveComplexity 21 -- Release eligibility and resurrection use the same ownership state.
  private prepare(object: PhpObject, onFailure: (error: CleanupException) => void): ReleaseFinish | undefined {
    if (this.visited.has(object) || this.runtime.objects.get(object.id) !== object) return undefined;
    if (ownedReachable(object, this.roots, this.runtime, this.unreachable, this.retainedBefore)) return undefined;
    if (!this.freed.has(object)) {
      this.addDetachedDescendants(object);
      if (!this.freed.has(object)) return undefined;
    }
    this.visited.add(object);
    pendingReleaseObjects.set(object, ++releaseSequence);
    if (!object.destructed && object.cls.findMethod('__destruct')) {
      object.destructed = true;
      this.runtime.destructibles--;
      const changes: OwnershipChange[] = [];
      const stopObserving = observeOwnership((change) => changes.push(change));
      try {
        this.runtime.withNativeReleaseMode(this.mode, () =>
          destruct(object, this.fromNative ? undefined : this.runtime.row)
        );
      } catch (error) {
        this.retainFailure(error, onFailure);
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

  private retainFailure(error: unknown, onFailure: (error: CleanupException) => void): void {
    if (!recoverableReleaseFailure(this.mode, error)) throw error;
    onFailure(error);
  }

  private addDetachedDescendants(root: PhpObject): void {
    const detached = (value: Ref | PhpArray | PhpObject): boolean =>
      !ownedReachable(value, this.roots, this.runtime, this.unreachable, this.retainedBefore);
    const garbage = objectsWithin([root], detached);
    for (const object of freeable(garbage, this.runtime, detached)) {
      this.freed.add(object);
      this.track(object);
    }
    for (const object of garbage) if (!this.freed.has(object)) this.runtime.objectCycles.add(object);
  }

  private track(object: PhpObject): void {
    this.active.push(object);
    activeReleaseObjects.set(object, this);
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

function recoverableReleaseFailure(mode: ReleaseMode, error: unknown): error is CleanupException {
  return mode !== 'shutdown' && (error instanceof PhpThrow || (mode === 'complete' && error instanceof ExitSignal));
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
      appendValues(pending, [...item.map.ownedSlots()]);
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

function collectibleGraph(
  values: unknown[],
  reachedArrays: Set<PhpArray>,
  excluded = new Set<PhpObject>(),
  allowed?: Set<PhpObject>
): { arrays: Set<PhpArray>; objects: Set<PhpObject> } {
  const arrays = new Set<PhpArray>();
  const objects = new Set<PhpObject>();
  const pending: unknown[] = [...values];
  while (pending.length > 0) {
    const item = pending.pop();
    if (item instanceof Ref) pending.push(item.v);
    else if (item instanceof PhpArray) {
      if (reachedArrays.has(item) || arrays.has(item)) continue;
      arrays.add(item);
      for (const slot of item.map.ownedSlots()) pending.push(slot);
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
  return { arrays, objects };
}

function finishArrayCollection(runtime: Runtime, arrays: Iterable<PhpArray>): void {
  runtime.collectingArrays.clear();
  retireArrays(runtime, arrays);
}

function retireArrays(runtime: Runtime, arrays: Iterable<PhpArray>, dropped: unknown[] = []): void {
  const remaining = new Set(arrays);
  if (remaining.size === 0) return;
  const roots = ownershipRoots(runtime);
  const seen = new Set<PhpArray>();
  const released: unknown[] = [];
  for (const item of [...dropped, ...remaining]) {
    const value = item instanceof Ref ? item.v : item;
    if (value instanceof PhpArray && remaining.has(value))
      retireArrayGraph(runtime, value, roots, seen, remaining, released);
    else if (value instanceof PhpObject && runtime.isCollectableObject(value)) runtime.gcRoots.add(value);
  }
  if (released.length > 0) runtime.release(released);
}

// code-gauge-allow functionCognitiveComplexity 16 -- Retires an unreachable array tree and collects its released children.
function retireArrayGraph(
  runtime: Runtime,
  root: PhpArray,
  roots: Set<unknown>,
  seen: Set<PhpArray>,
  remaining: Set<PhpArray>,
  released: unknown[]
): void {
  for (const pending = [root]; pending.length > 0;) {
    const array = pending.pop() as PhpArray;
    remaining.delete(array);
    if (seen.has(array) || !array.composite || ownedReachable(array, roots, runtime, undefined, undefined, true))
      continue;
    seen.add(array);
    runtime.gcRoots.delete(array);
    for (const slot of array.retire()) {
      const value = slot instanceof Ref ? slot.v : slot;
      runtime.pendingGcRoots.add(value);
      if (value instanceof PhpArray) pending.push(value);
      if (slot instanceof Ref || value instanceof PhpObject) released.push(slot);
    }
  }
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
  // code-gauge-allow functionNcss 39 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  // code-gauge-allow functionCognitiveComplexity 25 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  private enter(node: unknown): void {
    if (!(node instanceof Ref || node instanceof PhpArray || node instanceof PhpObject)) return;
    if (node instanceof PhpObject && activeReleaseObjects.has(node)) return;
    if (node instanceof PhpArray && !node.composite) return;
    if (node instanceof PhpArray && cachedObjectFree(node) === true) {
      if (!ownedReachable(node, this.roots, this.runtime, this.unreachable, releaseSequence)) this.arrays.add(node);
      return;
    }
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
    else if (node instanceof PhpArray) children = node.map.ownedSlots();
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
  runtime.world.retain((turtle) => turtles.has(turtle), runtime.releasingGlobalsAtShutdown);
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
  appendValues(roots, runtime.releasingValues.keys());
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
      pushInOrder([...item.map.ownedSlots()].filter((slot) => slot !== null && typeof slot === 'object'));
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

function pushFrame(frame: Frame, pending: unknown[], includeTemporaries = true): void {
  for (const ref of frame.vars.values()) pending.push(ref);
  if (includeTemporaries) appendValues(pending, frame.temporaries);
  appendValues(pending, [...frame.argumentHolders, frame.returning]);
  if (frame.thisObj) pending.push(frame.thisObj);
  if (frame.closure) pending.push(frame.closure);
}

function pushObject(object: PhpObject, pending: unknown[]): void {
  const declared: unknown[] = [];
  for (const [key, slot] of object.props) {
    if (typeof slot !== 'object' || slot === null) continue;
    if (isDeclaredPropertyKey(object.cls, key)) declared.push(slot);
    else pending.push(slot);
  }
  appendValues(pending, declared);
  const internal = object.internal;
  if (internal === undefined) return;
  if (isClosure(object)) {
    const data = internal as ClosureData;
    appendValues(pending, [...data.bound.values()]);
    if (data.thisObj) pending.push(data.thisObj);
    if (data.fn.kind === 'user') appendValues(pending, [...data.fn.statics.values()]);
    return;
  }
  const native = internal as { held?: () => unknown[]; releaseOrder?: () => unknown[] };
  const readChildren = native.releaseOrder ?? native.held;
  if (typeof readChildren === 'function') appendValues(pending, [...readChildren.call(internal)]);
}

function isDeclaredPropertyKey(cls: PhpObject['cls'], key: string): boolean {
  return key.startsWith('\0') || (cls.propByName.get(key)?.isStatic === false && cls.propByName.get(key)?.key === key);
}

type CollectionNode = PhpObject | PhpArray | Ref;

class CollectionGraph {
  private readonly members: Set<PhpObject>;
  private readonly edges = new Map<CollectionNode, CollectionNode[]>();
  private work = 0;

  constructor(
    objects: PhpObject[],
    private readonly runtime: Runtime,
    private readonly include: (value: Ref | PhpArray) => boolean = () => true
  ) {
    this.members = new Set(objects);
  }

  spend(): void {
    if ((++this.work & 15) === 0) this.runtime.spend();
  }

  accepts(value: unknown): value is CollectionNode {
    if (value instanceof PhpObject) return this.members.has(value);
    if (value instanceof PhpArray) return value.composite && this.include(value);
    return value instanceof Ref && (value.v instanceof PhpObject || value.v instanceof PhpArray) && this.include(value);
  }

  children(node: CollectionNode): CollectionNode[] {
    const existing = this.edges.get(node);
    if (existing) return existing;
    let values: Iterable<unknown>;
    if (node instanceof PhpArray) values = node.map.ownedSlots();
    else if (node instanceof Ref) values = [node.v];
    else {
      const held: unknown[] = [];
      pushObject(node, held);
      values = held;
    }
    const result = this.collectEdges(values);
    this.edges.set(node, result);
    return result;
  }

  private collectEdges(values: Iterable<unknown>): CollectionNode[] {
    const edges: CollectionNode[] = [];
    const stack = [values[Symbol.iterator]()];
    while (stack.length > 0) {
      const next = stack.at(-1)?.next();
      if (!next || next.done) {
        stack.pop();
        continue;
      }
      this.spend();
      const value: unknown = next.value;
      if (this.accepts(value)) edges.push(value);
      else if (value instanceof Map) stack.push(value.values());
      else if (Array.isArray(value)) stack.push(value.values());
    }
    return edges;
  }
}

/** Reference counting leaves objects that are on a cycle or reachable from one. */
function freeable(garbage: PhpObject[], runtime: Runtime, include?: (value: Ref | PhpArray) => boolean): PhpObject[] {
  const graph = new CollectionGraph(garbage, runtime, include);
  const cyclic = cyclicObjects(graph, garbage);
  const kept = new Set<CollectionNode>();
  const pending: CollectionNode[] = [...cyclic];
  while (pending.length > 0) {
    graph.spend();
    const node = pending.pop() as CollectionNode;
    if (kept.has(node)) continue;
    kept.add(node);
    for (const target of graph.children(node)) pending.push(target);
  }
  return garbage.filter((object) => !kept.has(object));
}

// code-gauge-allow functionNcss 45 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
// code-gauge-allow functionCognitiveComplexity 30 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function cyclicObjects(graph: CollectionGraph, garbage: PhpObject[], cyclicArrays?: Set<PhpArray>): Set<PhpObject> {
  // Tarjan's strongly connected components finds the objects on cycles.
  let index = 0;
  const indices = new Map<CollectionNode, number>();
  const lowlinks = new Map<CollectionNode, number>();
  const stack: CollectionNode[] = [];
  const onStack = new Set<CollectionNode>();
  const cyclic = new Set<PhpObject>();
  const enter = (node: CollectionNode): [CollectionNode, number] => {
    indices.set(node, index);
    lowlinks.set(node, index++);
    stack.push(node);
    onStack.add(node);
    return [node, 0];
  };
  const strongConnect = (root: PhpObject): void => {
    const work = [enter(root)];
    while (work.length > 0) {
      graph.spend();
      const top = work.at(-1) as [CollectionNode, number];
      const [node, position] = top;
      const targets = graph.children(node);
      if (position < targets.length) {
        top[1]++;
        const target = targets[position];
        if (!indices.has(target)) work.push(enter(target));
        else if (onStack.has(target)) {
          lowlinks.set(node, Math.min(lowlinks.get(node) as number, indices.get(target) as number));
        }
        continue;
      }
      work.pop();
      const parent = work.at(-1);
      if (parent) lowlinks.set(parent[0], Math.min(lowlinks.get(parent[0]) as number, lowlinks.get(node) as number));
      if (lowlinks.get(node) === indices.get(node)) {
        const isCycle = stack.at(-1) !== node || targets.includes(node);
        let member: CollectionNode;
        do {
          member = stack.pop() as CollectionNode;
          onStack.delete(member);
          if (isCycle) recordCyclicNode(member, cyclic, cyclicArrays);
        } while (member !== node);
      }
    }
  };
  for (const object of garbage) if (!indices.has(object)) strongConnect(object);
  return cyclic;
}

function recordCyclicNode(node: CollectionNode, objects: Set<PhpObject>, arrays?: Set<PhpArray>): void {
  if (node instanceof PhpObject) objects.add(node);
  else if (node instanceof PhpArray) arrays?.add(node);
}

/** Owner order follows retained slots; a handle is freed after its owner's children. */
// code-gauge-allow functionNcss 34 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
// code-gauge-allow functionCognitiveComplexity 24 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function releaseOrder(
  freed: PhpObject[],
  previousOrder: Map<PhpObject, number>,
  runtime: Runtime,
  buffered?: (PhpArray | PhpObject)[]
): { owners: PhpObject[]; handles: PhpObject[]; nodes?: (PhpArray | PhpObject)[] } {
  const graph = new CollectionGraph(freed, runtime);
  const referenced = referencedGarbage(graph, freed);
  const { nodes, owners } = collectBufferedNodes(buffered, graph, freed);
  const handles: PhpObject[] = [];
  const visited = new Set<CollectionNode>();
  const visit = (root: CollectionNode): void => {
    const pending: { node: CollectionNode; finish: boolean }[] = [{ node: root, finish: false }];
    while (pending.length > 0) {
      graph.spend();
      const { node, finish } = pending.pop() as { node: CollectionNode; finish: boolean };
      if (finish) {
        handles.push(node as PhpObject);
        continue;
      }
      if (visited.has(node)) continue;
      visited.add(node);
      if (node instanceof PhpObject) {
        owners.add(node);
        pending.push({ node, finish: true });
      }
      const children = graph.children(node);
      for (let index = children.length - 1; index >= 0; index--) {
        pending.push({ node: children[index], finish: false });
      }
    }
  };
  if (buffered) for (const node of buffered) if (graph.accepts(node)) visit(node);
  const position = (object: PhpObject): number => previousOrder.get(object) ?? Number.MAX_SAFE_INTEGER;
  const roots = freed
    .filter((object) => !referenced.has(object))
    .toSorted((a, b) => position(a) - position(b) || a.id - b.id);
  for (const root of roots) visit(root);
  for (const object of freed) visit(object);
  return { owners: [...owners], handles, nodes };
}

function collectBufferedNodes(
  buffered: (PhpArray | PhpObject)[] | undefined,
  graph: CollectionGraph,
  freed: PhpObject[]
): { nodes?: (PhpArray | PhpObject)[]; owners: Set<PhpObject> } {
  if (!buffered) return { owners: new Set() };
  const nodes = collectGarbageNodes<CollectionNode, PhpObject>(
    buffered.filter((node) => graph.accepts(node)),
    new Set(freed),
    (node): node is PhpObject => node instanceof PhpObject,
    (node) => graph.children(node),
    (node) => !(node instanceof Ref)
  ) as (PhpArray | PhpObject)[];
  return { nodes, owners: new Set(nodes.filter((node): node is PhpObject => node instanceof PhpObject)) };
}

function referencedGarbage(graph: CollectionGraph, roots: CollectionNode[]): Set<PhpObject> {
  const referenced = new Set<PhpObject>();
  const visited = new Set<CollectionNode>();
  const pending = [...roots];
  while (pending.length > 0) {
    graph.spend();
    const node = pending.pop() as CollectionNode;
    if (visited.has(node)) continue;
    visited.add(node);
    for (const child of graph.children(node)) {
      graph.spend();
      if (child instanceof PhpObject) referenced.add(child);
      pending.push(child);
    }
  }
  return referenced;
}

/** Counts the holders of each reachable object: variables, elements, and properties that refer to it. */
// code-gauge-allow functionNcss 49 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
export function holderCounts(runtime: Runtime): Map<PhpObject, number> {
  const counts = new Map<PhpObject, number>();
  const visitedArrays = new Set<PhpArray>();
  const visitedObjects = new Set<PhpObject>();
  const visitedRefs = new Set<Ref>();
  const pending: unknown[] = [];
  let work = 0;
  const count = (value: unknown): void => {
    if ((++work & 15) === 0) runtime.spend();
    if (value instanceof PhpObject) counts.set(value, (counts.get(value) ?? 0) + 1);
    if (typeof value === 'object' && value !== null) pending.push(value);
  };
  for (const value of ownershipRootSlots(runtime)) count(value);
  while (pending.length > 0) {
    const item = pending.pop();
    if (item instanceof Ref) {
      if (visitedRefs.has(item)) continue;
      visitedRefs.add(item);
      count(item.v);
    } else if (item instanceof PhpArray) {
      if (visitedArrays.has(item)) continue;
      visitedArrays.add(item);
      for (const slot of item.map.ownedSlots()) count(slot);
    } else if (item instanceof PhpObject) {
      if (visitedObjects.has(item)) continue;
      visitedObjects.add(item);
      runtime.spend(Math.ceil(item.props.size / 16));
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

/** Releases a unique global, retaining the index when no other object's ownership can have changed. */
export function releaseGlobalObject(runtime: Runtime, object: PhpObject): boolean {
  if (object.internal !== undefined || objectHasOwnedValues(runtime, object)) {
    releaseDropped(runtime, [object], true, 'shutdown');
    return false;
  }
  if (!object.destructed && object.cls.findMethod('__destruct')) {
    const changed = runGlobalDestructor(runtime, object);
    if (changed) {
      releaseDropped(runtime, [object], true, 'shutdown');
      return false;
    }
  }
  runtime.freeObject(object);
  return true;
}

function objectHasOwnedValues(runtime: Runtime, object: PhpObject): boolean {
  for (const property of object.props.values()) {
    runtime.spend();
    if (mayHoldObject(property instanceof Ref ? property.v : property, runtime)) return true;
  }
  return false;
}

function runGlobalDestructor(runtime: Runtime, object: PhpObject): boolean {
  const roots = persistentNativeRoots(runtime);
  const declarations = runtime.declarationRoots.size;
  const releases = runtime.durableReleaseVersion;
  let newOwners = false;
  const stop = observeOwnership(() => {
    newOwners = true;
  });
  object.destructed = true;
  runtime.destructibles--;
  runtime.collectingObjects.add(object);
  try {
    destruct(object);
  } finally {
    stop();
    runtime.collectingObjects.delete(object);
  }
  const after = persistentNativeRoots(runtime);
  return (
    newOwners ||
    runtime.durableReleaseVersion !== releases ||
    runtime.declarationRoots.size !== declarations ||
    roots.length !== after.length ||
    roots.some((root, index) => root !== after[index])
  );
}

function persistentNativeRoots(runtime: Runtime): unknown[] {
  return [
    runtime.exceptionHandler === runtime.retiringExceptionHandler ? undefined : runtime.exceptionHandler,
    runtime.assertionCallback,
    ...runtime.nativeShutdownHolders,
    ...runtime.replacedExceptionHandlers,
    ...runtime.errorHandlers.map(({ handler }) => handler),
  ];
}

// code-gauge-allow functionCognitiveComplexity 22 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
export function arrayHasHolders(runtime: Runtime, target: PhpArray, minimum: 1 | 2): boolean {
  let count = arrayHolderCount(target) + Number(runtime.nativeShutdownHolders.has(target));
  if (count >= minimum) return true;
  for (const frame of runtime.frames) {
    for (const value of frame.temporaries) if (value === target && ++count >= minimum) return true;
    if (frame.returning === target && ++count >= minimum) return true;
  }
  for (const value of runtime.held) if (value === target && ++count >= minimum) return true;
  for (const values of runtime.nativeHeld)
    for (const value of values) if (value === target && ++count >= minimum) return true;
  return false;
}

export function hasStoredObject(runtime: Runtime, object: PhpObject): boolean {
  return ownedReachable(object, ownershipRoots(runtime, false), runtime);
}

function ownershipRoots(runtime: Runtime, includeTemporaries = true): Set<unknown> {
  return new Set(
    ownershipRootSlots(runtime, includeTemporaries).filter(
      (value) => value instanceof Ref || value instanceof PhpArray || value instanceof PhpObject
    )
  );
}

function ownershipRootSlots(runtime: Runtime, includeTemporaries = true): unknown[] {
  const roots: unknown[] = [];
  for (const frame of runtime.frames) pushFrame(frame, roots, includeTemporaries);
  appendValues(roots, runtime.globalStatics.values());
  for (const fn of runtime.userFunctions) appendValues(roots, fn.statics.values());
  for (const cls of runtime.userClasses) {
    for (const { ref } of cls.staticProps.values()) roots.push(ref);
    for (const constant of cls.consts.values()) roots.push(constant.value);
    for (const method of cls.methods.values())
      if (method.fn.kind === 'user') appendValues(roots, [...method.fn.statics.values()]);
  }
  roots.push(...runtime.declarationRoots, ...runtime.held, ...persistentNativeRoots(runtime), runtime.thrown);
  for (const held of runtime.nativeHeld) appendValues(roots, [...held]);
  return roots;
}

// code-gauge-allow functionCognitiveComplexity 21 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function ownedReachable(
  value: Ref | PhpArray | PhpObject,
  roots: Set<unknown>,
  runtime: Runtime,
  unreachable?: Set<object>,
  retainedBefore?: number,
  retainOwners = false
): boolean {
  const isRoot = ownershipRootCheck(roots, runtime, retainedBefore, retainOwners);
  const cursors: Iterator<object>[] = [[value].values()];
  const path: object[] = [];
  const visited = new Set<object>();
  let work = 0;
  while (cursors.length > 0) {
    if ((++work & 255) === 0) runtime.budget.checkClock();
    const next = cursors.at(-1)!.next();
    if (next.done) {
      cursors.pop();
      path.pop();
      continue;
    }
    const item = next.value;
    if (visited.has(item) || unreachable?.has(item)) continue;
    const root = resolveOwnershipRoot(item, isRoot, retainOwners);
    if (root) {
      if (!retainOwners) {
        path.push(item);
        rememberOwnership(path.toReversed(), root);
      }
      return true;
    }
    visited.add(item);
    path.push(item);
    cursors.push(reverseOwners(item, runtime));
  }
  if (unreachable) for (const item of visited) unreachable.add(item);
  return false;
}

function resolveOwnershipRoot(
  item: object,
  isRoot: (value: object) => boolean,
  retainOwners: boolean
): object | undefined {
  if (!retainOwners) {
    const existing = ownershipProof(item, isRoot);
    if (existing !== undefined) return existing;
  }
  return isRoot(item) ? item : undefined;
}

// code-gauge-allow functionCognitiveComplexity 16 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function ownershipRootCheck(
  roots: Set<unknown>,
  runtime: Runtime,
  retainedBefore: number | undefined,
  retainOwners: boolean
): (value: object) => boolean {
  return (value) => {
    if (
      roots.has(value) ||
      runtime.releasingValues.has(value) ||
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
}

function* reverseOwners(value: object, runtime: Runtime): Generator<object> {
  for (const owner of valueOwners(value)) {
    if (!(owner instanceof PhpObject && runtime.retiringObjects.has(owner))) yield owner;
  }
}

function appendValues(target: unknown[], values: Iterable<unknown>): void {
  for (const value of values) target.push(value);
}
