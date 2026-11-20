// code-gauge-allow-file fileNcss 458 -- Holds GC root buffer simulation, ordering, and post-collection retirement helpers.
import { rt, type Runtime } from './runtime';
import { PhpArray, PhpObject, Ref, type Value } from './values';

export const GC_THRESHOLD_DEFAULT = 10_001;
const GC_THRESHOLD_STEP = 10_000;
const GC_THRESHOLD_TRIGGER = 100;

/** Copies a shared array for a holder that writes to it, letting go of the original as PHP's SEPARATE_ARRAY does. */
export function separate(array: PhpArray): PhpArray {
  rt().separatedArrays.add(array);
  return array.copy();
}

/**
 * The arrays some node reachable from `starts` still holds. A buffered array that a destructor released has no such
 * holder: reference counting already freed it, so PHP's collection does not count it.
 */
export function heldArrays<N extends object>(starts: N[], children: (node: N) => N[]): Set<N> {
  const held = new Set<N>();
  const seen = new Set(starts);
  const pending = [...starts];
  while (pending.length > 0) {
    for (const child of children(pending.pop() as N)) {
      if (child instanceof PhpArray) held.add(child);
      if (!seen.has(child)) {
        seen.add(child);
        pending.push(child);
      }
    }
  }
  return held;
}

export function recordGcRoot(runtime: Runtime, value: PhpArray | PhpObject, collect: () => number): boolean {
  if (runtime.gcRoots.has(value)) return false;
  let collected = false;
  if (!runtime.collectingCycles && runtime.gcEnabled && runtime.gcRoots.size >= runtime.gcThreshold - 1) {
    collected = true;
    const arrayCycle = value instanceof PhpArray && runtime.arrayCycles.has(value);
    const objectCycle = value instanceof PhpObject && runtime.objectCycles.has(value);
    runtime.held.push(value);
    let count: number;
    try {
      count = collect();
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
  return collected;
}

interface DeferredState<N extends object, O extends N> {
  protectedObjects: Set<O>;
  inDegree: Map<N, number>;
  freed: Set<N>;
  order: O[];
  isObject: (node: N) => node is O;
  children: (node: N) => N[];
}

export function deferredHandleOrder<N extends object, O extends N>(
  roots: N[],
  protectedObjects: Set<O>,
  isObject: (node: N) => node is O,
  children: (node: N) => N[]
): O[] {
  const state: DeferredState<N, O> = {
    protectedObjects,
    inDegree: countInDegrees(roots, protectedObjects, isObject, children),
    freed: new Set<N>(),
    order: [],
    isObject,
    children,
  };
  const queue: N[] = [...roots];
  drainDeferredQueue(queue, state, 0);
  for (const object of protectedObjects) {
    if (!state.freed.has(object)) {
      const start = queue.length;
      queue.push(object);
      drainDeferredQueue(queue, state, start);
    }
  }
  return state.order;
}

export function collectGarbageNodes<N extends object, O extends N>(
  bufferedRoots: N[],
  remainingObjects: Set<O>,
  isObject: (node: N) => node is O,
  children: (node: N) => N[],
  countable: (node: N) => boolean = () => true
): N[] {
  const buffer = buildSimulationBuffer(bufferedRoots, remainingObjects, isObject, children, countable);
  const nodes: N[] = [];
  for (let index = 0; index < buffer.length; index++) {
    const node = buffer.at(index);
    if (node !== undefined) nodes.push(node);
  }
  return nodes;
}

export interface RetireCollectedContext {
  runtime: Runtime;
  objectChildren: Map<PhpObject, unknown[]>;
  allChildren: unknown[];
  arrayStorage: Set<PhpArray>;
  isLiveArray: (array: PhpArray) => boolean;
  garbageNodes?: (PhpObject | PhpArray)[];
  passTwoNodes?: (PhpObject | PhpArray)[];
}

export function retireCollected(context: RetireCollectedContext): void {
  const { runtime, objectChildren, allChildren, arrayStorage, isLiveArray, garbageNodes, passTwoNodes } = context;
  const remaining = new Set(arrayStorage);
  const freedObjects = new Set<PhpObject>();
  const seen = new Set<PhpArray>();
  const released: unknown[] = [];
  const compactRoots = runtime.collectingCycles && garbageNodes !== undefined;
  const state: RetireState = {
    runtime,
    objectChildren,
    remaining,
    freedObjects,
    seen,
    released,
    isLiveArray,
    compactRoots,
  };
  if (compactRoots) retireBufferNodes(garbageNodes, passTwoNodes, state);
  else for (const item of allChildren) visitRetiredNode(item, state);
  for (const array of remaining) visitRetiredNode(array, state);
  if (released.length > 0) runtime.release(released);
}

function retireBufferNodes(
  garbageNodes: (PhpObject | PhpArray)[],
  passTwoNodes: (PhpObject | PhpArray)[] | undefined,
  state: RetireState
): void {
  const passTwoSet = passTwoNodes ? new Set<PhpObject | PhpArray>(passTwoNodes) : undefined;
  state.deferredPassTwo = passTwoSet;
  retirePass(garbageNodes, state, passTwoSet);
  state.deferredPassTwo = undefined;
  if (passTwoNodes) retirePass(passTwoNodes, state);
  for (const object of state.objectChildren.keys()) {
    visitRetiredNode(object, state);
    state.runtime.gcRoots.delete(object);
  }
}

function retirePass(nodes: (PhpObject | PhpArray)[], state: RetireState, skip?: Set<PhpObject | PhpArray>): void {
  state.runtime.gcRoots.load(nodes);
  for (const node of nodes) if (!skip?.has(node)) visitRetiredNode(node, state);
  for (const node of nodes) if (!skip?.has(node)) state.runtime.gcRoots.delete(node);
}

interface RetireState {
  runtime: Runtime;
  objectChildren: Map<PhpObject, unknown[]>;
  remaining: Set<PhpArray>;
  freedObjects: Set<PhpObject>;
  seen: Set<PhpArray>;
  released: unknown[];
  isLiveArray: (array: PhpArray) => boolean;
  compactRoots: boolean;
  deferredPassTwo?: Set<PhpObject | PhpArray>;
}

function visitRetiredNode(root: unknown, state: RetireState): void {
  const first = stepRetiredItem(root, state, true);
  if (!first) return;
  const stack: { items: unknown[]; index: number; finish?: PhpObject }[] = [first];
  while (stack.length > 0) {
    const frame = stack.at(-1) as { items: unknown[]; index: number; finish?: PhpObject };
    if (frame.index >= frame.items.length) {
      stack.pop();
      if (frame.finish) state.runtime.gcRoots.delete(frame.finish);
      continue;
    }
    const item = frame.items[frame.index++];
    const next = stepRetiredItem(item, state, false);
    if (next) stack.push(next);
  }
}

function stepRetiredItem(
  item: unknown,
  state: RetireState,
  isTopLevel: boolean
): { items: unknown[]; index: number; finish?: PhpObject } | undefined {
  const value = item instanceof Ref ? item.v : item;
  if ((value instanceof PhpArray || value instanceof PhpObject) && state.deferredPassTwo?.has(value)) return undefined;
  if (value instanceof PhpArray && state.remaining.has(value)) return retireArrayNode(value, state, !isTopLevel);
  if (value instanceof PhpObject && state.compactRoots && state.objectChildren.has(value))
    return retireObjectNode(value, state, !isTopLevel);
  recordRetiredSurvivor(value, state);
  return undefined;
}

function retireArrayNode(
  array: PhpArray,
  state: RetireState,
  removeFromRoots: boolean
): { items: unknown[]; index: number } | undefined {
  state.remaining.delete(array);
  if (state.seen.has(array) || !array.composite || state.isLiveArray(array)) return undefined;
  state.seen.add(array);
  if (removeFromRoots) state.runtime.gcRoots.delete(array);
  const slots = array.retire();
  for (const slot of slots) {
    const target = slot instanceof Ref ? slot.v : slot;
    if (slot instanceof Ref || target instanceof PhpObject) state.released.push(slot);
  }
  return { items: slots, index: 0 };
}

function retireObjectNode(
  object: PhpObject,
  state: RetireState,
  removeOnFinish: boolean
): { items: unknown[]; index: number; finish?: PhpObject } | undefined {
  if (state.freedObjects.has(object)) return undefined;
  state.freedObjects.add(object);
  return { items: state.objectChildren.get(object) ?? [], index: 0, finish: removeOnFinish ? object : undefined };
}

function recordRetiredSurvivor(value: unknown, state: RetireState): void {
  if (!(value instanceof PhpObject || value instanceof PhpArray)) return;
  if (!state.compactRoots) {
    state.runtime.pendingGcRoots.add(value);
    return;
  }
  if (value instanceof PhpObject) {
    if (state.runtime.isCollectableObject(value)) state.runtime.gcRoots.add(value);
  } else if (!value.uncollectable && state.isLiveArray(value)) {
    state.runtime.gcRoots.add(value);
  }
}

export function orderDestructedCollection<N extends object, O extends N>(
  bufferedRoots: N[],
  destructible: Set<O>,
  remainingObjects: Set<O>,
  isObject: (node: N) => node is O,
  children: (node: N) => N[],
  countable: (node: N) => boolean = () => true
): { count: number; ordered: O[]; passTwoNodes: N[] } {
  const buffer = buildSimulationBuffer(bufferedRoots, remainingObjects, isObject, children, countable);
  const end = buffer.length;
  removeDestructibleNested(buffer, end, destructible, isObject, children, countable);
  const state: DeferredState<N, O> = {
    protectedObjects: remainingObjects,
    inDegree: countInDegrees(bufferedRoots, remainingObjects, isObject, children),
    freed: new Set<N>(),
    order: [],
    isObject,
    children,
  };
  const runOneCount = runFirstDestructionPass(buffer, end, state, destructible, countable);
  const freedAfterPassOne = countNodes(state.freed, countable);
  buffer.compact();
  const passTwoNodes = drainRunTwoBuffer(buffer, state, remainingObjects, countable);
  return {
    count: runOneCount + (countNodes(state.freed, countable) - freedAfterPassOne),
    ordered: state.order,
    passTwoNodes,
  };
}

function countNodes<N extends object>(nodes: Iterable<N>, predicate: (node: N) => boolean): number {
  let count = 0;
  for (const node of nodes) if (predicate(node)) count++;
  return count;
}

function buildSimulationBuffer<N extends object, O extends N>(
  bufferedRoots: N[],
  remainingObjects: Set<O>,
  isObject: (node: N) => node is O,
  children: (node: N) => N[],
  countable: (node: N) => boolean
): GcRoots<N> {
  const buffer = new GcRoots<N>();
  for (const root of bufferedRoots) if (countable(root)) buffer.add(root);
  buffer.compact();
  collectWhiteIntoBuffer(buffer, new Set(), remainingObjects, isObject, children, countable);
  return buffer;
}

function collectWhiteIntoBuffer<N extends object, O extends N>(
  buffer: GcRoots<N>,
  freed: Set<N>,
  remainingObjects: Set<O>,
  isObject: (node: N) => node is O,
  children: (node: N) => N[],
  countable: (node: N) => boolean
): void {
  const initialEnd = buffer.length;
  const seen = new Set<N>();
  for (let index = 0; index < initialEnd; index++) {
    const start = buffer.at(index);
    if (start === undefined || freed.has(start) || seen.has(start)) continue;
    walkZendStack(start, seen, children, (node) => {
      if (freed.has(node) || (isObject(node) && !remainingObjects.has(node))) return false;
      if (countable(node)) buffer.add(node);
      return true;
    });
  }
}

function removeDestructibleNested<N extends object, O extends N>(
  buffer: GcRoots<N>,
  end: number,
  destructible: Set<O>,
  isObject: (node: N) => node is O,
  children: (node: N) => N[],
  countable: (node: N) => boolean
): void {
  for (let index = 0; index < end; index++) {
    const start = buffer.at(index);
    if (start !== undefined && isObject(start) && destructible.has(start))
      removeNestedFromBuffer(start, buffer, destructible, isObject, children, countable);
  }
}

function runFirstDestructionPass<N extends object, O extends N>(
  buffer: GcRoots<N>,
  end: number,
  state: DeferredState<N, O>,
  destructible: Set<O>,
  countable: (node: N) => boolean
): number {
  const runOneGarbage = new Set<N>();
  for (let index = 0; index < end; index++) {
    const item = buffer.at(index);
    if (item !== undefined && !(state.isObject(item) && destructible.has(item))) runOneGarbage.add(item);
  }
  for (let index = 0; index < end; index++) {
    const start = buffer.at(index);
    if (start === undefined || !runOneGarbage.has(start) || state.freed.has(start)) continue;
    releaseWithBuffer(start, state, buffer, countable);
  }
  return runOneGarbage.size;
}

function drainRunTwoBuffer<N extends object, O extends N>(
  buffer: GcRoots<N>,
  state: DeferredState<N, O>,
  remainingObjects: Set<O>,
  countable: (node: N) => boolean
): N[] {
  collectWhiteIntoBuffer(buffer, state.freed, remainingObjects, state.isObject, state.children, countable);
  const runTwoQueue: N[] = [];
  for (let index = 0; index < buffer.length; index++) {
    const node = buffer.at(index);
    if (node !== undefined) runTwoQueue.push(node);
  }
  const passTwoNodes = [...runTwoQueue];
  drainDeferredQueue(runTwoQueue, state, 0);
  for (const object of remainingObjects) {
    if (!state.freed.has(object)) {
      const start = runTwoQueue.length;
      runTwoQueue.push(object);
      drainDeferredQueue(runTwoQueue, state, start);
    }
  }
  return passTwoNodes;
}

function walkZendStack<N extends object>(
  start: N,
  seen: Set<N>,
  children: (node: N) => N[],
  visit: (node: N) => boolean
): void {
  if (seen.has(start)) return;
  seen.add(start);
  const stack: N[] = [];
  let current: N | undefined = start;
  while (current !== undefined) {
    const tail: N | undefined = visit(current) ? pushUnseenTail(children(current), seen, stack) : undefined;
    current = tail ?? stack.pop();
  }
}

function pushUnseenTail<N extends object>(next: N[], seen: Set<N>, stack: N[]): N | undefined {
  let tail: N | undefined;
  for (const child of next) {
    if (seen.has(child)) continue;
    seen.add(child);
    if (tail === undefined) tail = child;
    else stack.push(child);
  }
  return tail;
}

function removeNestedFromBuffer<N extends object, O extends N>(
  root: O,
  buffer: GcRoots<N>,
  destructible: Set<O>,
  isObject: (node: N) => node is O,
  children: (node: N) => N[],
  countable: (node: N) => boolean
): void {
  const stack: N[] = [];
  let current: N | undefined = pushZendTail(children(root), stack);
  while (current !== undefined) {
    const transparent = !countable(current);
    if (transparent || (buffer.has(current) && !(isObject(current) && destructible.has(current)))) {
      if (!transparent) buffer.delete(current);
      const tail = pushZendTail(children(current), stack);
      if (tail !== undefined) {
        current = tail;
        continue;
      }
    }
    current = stack.pop();
  }
}

function pushZendTail<N extends object>(next: N[], stack: N[]): N | undefined {
  if (next.length === 0) return undefined;
  for (let index = 1; index < next.length; index++) stack.push(next[index]);
  return next[0];
}

function releaseWithBuffer<N extends object, O extends N>(
  start: N,
  state: DeferredState<N, O>,
  buffer: GcRoots<N>,
  countable: (node: N) => boolean
): void {
  releaseDeferredRoot(
    start,
    state,
    (item) => {
      if (countable(item)) buffer.add(item);
      else for (const target of state.children(item)) if (countable(target)) buffer.add(target);
    },
    (node) => {
      if (state.isObject(node)) buffer.delete(node);
    },
    (node) => {
      if (!state.isObject(node)) buffer.delete(node);
    }
  );
}

function drainDeferredQueue<N extends object, O extends N>(queue: N[], state: DeferredState<N, O>, from: number): void {
  for (let head = from; head < queue.length; head++) {
    const start = queue[head];
    if (!state.freed.has(start)) releaseDeferredRoot(start, state, (item) => queue.push(item));
  }
}

function releaseDeferredRoot<N extends object, O extends N>(
  start: N,
  state: DeferredState<N, O>,
  onNested: (item: N) => void,
  onFinish?: (node: N) => void,
  onEnter?: (node: N) => void
): void {
  state.freed.add(start);
  onEnter?.(start);
  const stack: { node: N; children: N[]; index: number }[] = [
    { node: start, children: state.children(start), index: 0 },
  ];
  while (stack.length > 0) {
    const frame = stack.at(-1) as { node: N; children: N[]; index: number };
    const child = nextDeferredChild(frame, state, onNested);
    if (child !== undefined) {
      state.freed.add(child);
      onEnter?.(child);
      stack.push({ node: child, children: state.children(child), index: 0 });
      continue;
    }
    stack.pop();
    if (state.isObject(frame.node)) state.order.push(frame.node);
    onFinish?.(frame.node);
  }
}

function nextDeferredChild<N extends object, O extends N>(
  frame: { node: N; children: N[]; index: number },
  state: DeferredState<N, O>,
  onNested: (item: N) => void
): N | undefined {
  while (frame.index < frame.children.length) {
    const child = frame.children[frame.index++];
    if (state.freed.has(child) || (state.isObject(child) && !state.protectedObjects.has(child))) continue;
    const remaining = (state.inDegree.get(child) ?? 1) - 1;
    state.inDegree.set(child, remaining);
    if (remaining <= 0) return child;
    onNested(child);
  }
  return undefined;
}

function countInDegrees<N extends object, O extends N>(
  roots: N[],
  protectedObjects: Set<O>,
  isObject: (node: N) => node is O,
  children: (node: N) => N[]
): Map<N, number> {
  const inDegree = new Map<N, number>();
  const counted = new Set<N>();
  const scan: N[] = [...protectedObjects, ...roots];
  while (scan.length > 0) {
    const node = scan.pop() as N;
    if (counted.has(node)) continue;
    counted.add(node);
    for (const child of children(node)) {
      if (isObject(child) && !protectedObjects.has(child)) continue;
      inDegree.set(child, (inDegree.get(child) ?? 0) + 1);
      if (!counted.has(child)) scan.push(child);
    }
  }
  return inDegree;
}

const objectFreeArrays = new WeakMap<PhpArray, { version: number; free: boolean }>();

export function cachedObjectFree(array: PhpArray): boolean | undefined {
  const entry = objectFreeArrays.get(array);
  return entry?.version === array.mutationVersion ? entry.free : undefined;
}

export function objectFree(array: PhpArray, runtime: Runtime): boolean {
  const cached = cachedObjectFree(array);
  if (cached !== undefined) return cached;
  const visited = new Set<PhpArray>();
  const active = new Set<PhpArray>([array]);
  const stack: { array: PhpArray; iter: Iterator<Value | Ref> }[] = [
    { array, iter: array.map.ownedSlots()[Symbol.iterator]() },
  ];
  let scanned = 0;
  while (stack.length > 0) {
    const top = stack.at(-1) as (typeof stack)[number];
    const next = top.iter.next();
    if (next.done) {
      stack.pop();
      active.delete(top.array);
      visited.add(top.array);
      continue;
    }
    if (++scanned % 64 === 0) runtime.spend();
    const child = inspectObjectFreeSlot(top.array, next.value, active, visited);
    if (child === false) return markHasObject(array, top.array);
    if (child) {
      active.add(child);
      stack.push({ array: child, iter: child.map.ownedSlots()[Symbol.iterator]() });
    }
  }
  cacheObjectFree(visited);
  return true;
}

function inspectObjectFreeSlot(
  parent: PhpArray,
  slot: Value | Ref,
  active: Set<PhpArray>,
  visited: Set<PhpArray>
): PhpArray | false | undefined {
  if (slot instanceof Ref || slot instanceof PhpObject) return false;
  if (!(slot instanceof PhpArray) || !slot.composite) return undefined;
  slot.trackCachedParent(parent);
  if (active.has(slot)) return false;
  if (visited.has(slot)) return undefined;
  const childCached = cachedObjectFree(slot);
  return childCached === false ? false : childCached === true ? undefined : slot;
}

function markHasObject(root: PhpArray, current: PhpArray): false {
  objectFreeArrays.set(current, { version: current.mutationVersion, free: false });
  objectFreeArrays.set(root, { version: root.mutationVersion, free: false });
  return false;
}

function cacheObjectFree(visited: Set<PhpArray>): void {
  for (const item of visited) {
    objectFreeArrays.set(item, { version: item.mutationVersion, free: true });
    for (const slot of item.map.ownedSlots()) if (slot instanceof PhpArray) slot.trackCachedParent(item);
  }
}

export class GcRoots<T extends object> {
  private readonly positions = new Map<T, number>();
  private readonly slots: (T | undefined)[] = [];
  private readonly unused: number[] = [];

  get size(): number {
    return this.positions.size;
  }

  get length(): number {
    return this.slots.length;
  }

  at(index: number): T | undefined {
    return this.slots[index];
  }

  has(value: T): boolean {
    return this.positions.has(value);
  }

  add(value: T): void {
    if (this.positions.has(value)) return;
    const index = this.unused.pop() ?? this.slots.length;
    this.slots[index] = value;
    this.positions.set(value, index);
  }

  delete(value: T): void {
    const index = this.positions.get(value);
    if (index === undefined) return;
    this.positions.delete(value);
    this.slots[index] = undefined;
    this.unused.push(index);
  }

  clear(): void {
    this.positions.clear();
    this.slots.length = 0;
    this.unused.length = 0;
  }

  load(values: Iterable<T>): void {
    this.clear();
    for (const value of values) this.add(value);
  }

  compact(): void {
    const compacted = compact(this.slots);
    this.positions.clear();
    this.slots.length = compacted.length;
    this.unused.length = 0;
    for (let index = 0; index < compacted.length; index++) {
      this.slots[index] = compacted[index];
      this.positions.set(compacted[index], index);
    }
  }

  garbageOrder(live: (value: T) => boolean): T[] {
    const roots = compact(this.slots);
    return compact(roots.map((value) => (live(value) ? undefined : value)));
  }
}

function compact<T>(slots: (T | undefined)[]): T[] {
  const result = [...slots];
  let last = result.length - 1;
  for (let first = 0; first <= last; first++) {
    if (result[first] !== undefined) continue;
    while (last > first && result[last] === undefined) last--;
    if (first >= last) break;
    result[first] = result[last];
    result[last--] = undefined;
  }
  return result.slice(0, last + 1).filter((value): value is T => value !== undefined);
}
