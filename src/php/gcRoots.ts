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

function drainDeferredQueue<N extends object, O extends N>(queue: N[], state: DeferredState<N, O>, from: number): void {
  for (let head = from; head < queue.length; head++) {
    const start = queue[head];
    if (!state.freed.has(start)) queue.push(...releaseDeferredRoot(start, state));
  }
}

function releaseDeferredRoot<N extends object, O extends N>(start: N, state: DeferredState<N, O>): N[] {
  const nested: N[] = [];
  state.freed.add(start);
  const stack: { node: N; children: N[]; index: number }[] = [
    { node: start, children: state.children(start), index: 0 },
  ];
  while (stack.length > 0) {
    const frame = stack.at(-1) as { node: N; children: N[]; index: number };
    const child = nextDeferredChild(frame, state, nested);
    if (child !== undefined) {
      state.freed.add(child);
      stack.push({ node: child, children: state.children(child), index: 0 });
      continue;
    }
    stack.pop();
    if (state.isObject(frame.node)) state.order.push(frame.node);
  }
  return nested;
}

function nextDeferredChild<N extends object, O extends N>(
  frame: { node: N; children: N[]; index: number },
  state: DeferredState<N, O>,
  nested: N[]
): N | undefined {
  while (frame.index < frame.children.length) {
    const child = frame.children[frame.index++];
    if (state.freed.has(child) || (state.isObject(child) && !state.protectedObjects.has(child))) continue;
    const remaining = (state.inDegree.get(child) ?? 1) - 1;
    state.inDegree.set(child, remaining);
    if (remaining <= 0) return child;
    nested.push(child);
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

export function countAfterDestructionPass<O extends object, A extends object>(
  cyclic: Set<O>,
  cyclicArrays: Set<A>,
  excluded: Set<O>,
  collect: (roots: (O | A)[], skip: Set<O>) => { arrays: Set<A>; objects: Set<O> }
): number {
  const counted = collect([...cyclic, ...cyclicArrays], excluded);
  if (excluded.size > 0) {
    const beneathExcluded = collect([...excluded], new Set());
    const runTwoRoots: (O | A)[] = [
      ...[...cyclic].filter((object) => beneathExcluded.objects.has(object)),
      ...[...cyclicArrays].filter((array) => beneathExcluded.arrays.has(array)),
    ];
    if (runTwoRoots.length > 0) {
      const runTwo = collect(runTwoRoots, new Set());
      for (const object of runTwo.objects) counted.objects.add(object);
      for (const array of runTwo.arrays) counted.arrays.add(array);
    }
  }
  return counted.objects.size + counted.arrays.size;
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
