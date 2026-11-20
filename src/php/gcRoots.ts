import type { Runtime } from './runtime';
import { PhpArray, PhpObject, Ref } from './values';

export const GC_THRESHOLD_DEFAULT = 10_001;
const GC_THRESHOLD_STEP = 10_000;
const GC_THRESHOLD_TRIGGER = 100;

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

export function orderDestructedCollection<N extends object, O extends N>(
  bufferedRoots: N[],
  destructible: Set<O>,
  remainingObjects: Set<O>,
  isObject: (node: N) => node is O,
  children: (node: N) => N[],
  countable: (node: N) => boolean = () => true
): { count: number; ordered: O[] } {
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
  drainRunTwoBuffer(buffer, state, remainingObjects, countable);
  return { count: runOneCount + (countNodes(state.freed, countable) - freedAfterPassOne), ordered: state.order };
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
): SimulationBuffer<N> {
  const buffer = new SimulationBuffer<N>();
  for (const root of bufferedRoots) if (countable(root)) buffer.add(root);
  buffer.compact();
  collectWhiteIntoBuffer(buffer, new Set(), remainingObjects, isObject, children, countable);
  return buffer;
}

function collectWhiteIntoBuffer<N extends object, O extends N>(
  buffer: SimulationBuffer<N>,
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
  buffer: SimulationBuffer<N>,
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
  buffer: SimulationBuffer<N>,
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
  buffer: SimulationBuffer<N>,
  state: DeferredState<N, O>,
  remainingObjects: Set<O>,
  countable: (node: N) => boolean
): void {
  collectWhiteIntoBuffer(buffer, state.freed, remainingObjects, state.isObject, state.children, countable);
  const runTwoQueue: N[] = [];
  for (let index = 0; index < buffer.length; index++) {
    const node = buffer.at(index);
    if (node !== undefined) runTwoQueue.push(node);
  }
  drainDeferredQueue(runTwoQueue, state, 0);
  for (const object of remainingObjects) {
    if (!state.freed.has(object)) {
      const start = runTwoQueue.length;
      runTwoQueue.push(object);
      drainDeferredQueue(runTwoQueue, state, start);
    }
  }
}

class SimulationBuffer<N extends object> {
  private readonly slots: (N | undefined)[] = [];
  private readonly positions = new Map<N, number>();
  private readonly unused: number[] = [];

  get length(): number {
    return this.slots.length;
  }

  at(index: number): N | undefined {
    return this.slots[index];
  }

  has(node: N): boolean {
    return this.positions.has(node);
  }

  add(node: N): void {
    if (this.positions.has(node)) return;
    const index = this.unused.pop() ?? this.slots.length;
    this.slots[index] = node;
    this.positions.set(node, index);
  }

  remove(node: N): void {
    const index = this.positions.get(node);
    if (index === undefined) return;
    this.positions.delete(node);
    this.slots[index] = undefined;
    this.unused.push(index);
  }

  compact(): void {
    const count = this.positions.size;
    if (count === this.slots.length) return;
    let free = 0;
    let scan = this.slots.length - 1;
    while (free < scan) {
      while (free < scan && this.slots[free] !== undefined) free++;
      while (free < scan && this.slots[scan] === undefined) scan--;
      if (free < scan) {
        const node = this.slots[scan] as N;
        this.slots[free] = node;
        this.slots[scan] = undefined;
        this.positions.set(node, free);
        free++;
        scan--;
      }
    }
    this.slots.length = count;
    this.unused.length = 0;
  }
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
  buffer: SimulationBuffer<N>,
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
      if (!transparent) buffer.remove(current);
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
  buffer: SimulationBuffer<N>,
  countable: (node: N) => boolean
): void {
  releaseDeferredRoot(
    start,
    state,
    (item) => {
      if (countable(item)) buffer.add(item);
      else for (const target of state.children(item)) if (countable(target)) buffer.add(target);
    },
    (node) => buffer.remove(node)
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
  onFinish?: (node: N) => void
): void {
  state.freed.add(start);
  const stack: { node: N; children: N[]; index: number }[] = [
    { node: start, children: state.children(start), index: 0 },
  ];
  while (stack.length > 0) {
    const frame = stack.at(-1) as { node: N; children: N[]; index: number };
    const child = nextDeferredChild(frame, state, onNested);
    if (child !== undefined) {
      state.freed.add(child);
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
  const pending = [array];
  const visited = new Set<PhpArray>();
  const counter = { scanned: 0 };
  while (pending.length > 0) {
    const current = pending.pop() as PhpArray;
    if (visited.has(current)) continue;
    const currentCached = cachedObjectFree(current);
    if (currentCached === true) continue;
    if (currentCached === false) return markHasObject(array, current);
    visited.add(current);
    if (!scanObjectFreeSlots(current, pending, runtime, counter)) return markHasObject(array, current);
  }
  cacheObjectFree(visited);
  return true;
}

function scanObjectFreeSlots(
  current: PhpArray,
  pending: PhpArray[],
  runtime: Runtime,
  counter: { scanned: number }
): boolean {
  for (const slot of current.map.ownedSlots()) {
    if (++counter.scanned % 64 === 0) runtime.spend();
    if (slot instanceof Ref || slot instanceof PhpObject) return false;
    if (slot instanceof PhpArray && slot.composite) {
      slot.trackCachedParent(current);
      pending.push(slot);
    }
  }
  return true;
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
