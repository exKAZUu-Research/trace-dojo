import type { Runtime } from './runtime';
import { PhpArray, PhpObject } from './values';

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
  roots: O[],
  protectedObjects: Set<O>,
  isObject: (node: N) => node is O,
  children: (node: N) => N[]
): O[] {
  const state: DeferredState<N, O> = {
    protectedObjects,
    inDegree: countInDegrees(protectedObjects, isObject, children),
    freed: new Set<N>(),
    order: [],
    isObject,
    children,
  };
  const pendingRoots: O[] = [...protectedObjects].toReversed();
  for (let index = roots.length - 1; index >= 0; index--) pendingRoots.push(roots[index]);
  while (pendingRoots.length > 0) {
    const start = pendingRoots.pop() as O;
    if (!state.freed.has(start)) pendingRoots.push(...releaseDeferredRoot(start, state));
  }
  return state.order;
}

function releaseDeferredRoot<N extends object, O extends N>(start: O, state: DeferredState<N, O>): O[] {
  const nested: O[] = [];
  const stack: { node: N; finish: boolean }[] = [{ node: start, finish: false }];
  while (stack.length > 0) {
    const { node, finish } = stack.pop() as { node: N; finish: boolean };
    if (finish) {
      if (state.isObject(node)) state.order.push(node);
      continue;
    }
    if (state.freed.has(node)) continue;
    state.freed.add(node);
    if (state.isObject(node)) stack.push({ node, finish: true });
    enqueueReleasedChildren(node, state, stack, nested);
  }
  return nested;
}

function countInDegrees<N extends object, O extends N>(
  protectedObjects: Set<O>,
  isObject: (node: N) => node is O,
  children: (node: N) => N[]
): Map<N, number> {
  const inDegree = new Map<N, number>();
  const counted = new Set<N>();
  const scan: N[] = [...protectedObjects];
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

function enqueueReleasedChildren<N extends object, O extends N>(
  node: N,
  state: DeferredState<N, O>,
  stack: { node: N; finish: boolean }[],
  nested: O[]
): void {
  const next = state.children(node);
  for (let index = next.length - 1; index >= 0; index--) {
    const child = next[index];
    if (state.freed.has(child) || (state.isObject(child) && !state.protectedObjects.has(child))) continue;
    const remaining = (state.inDegree.get(child) ?? 1) - 1;
    state.inDegree.set(child, remaining);
    if (remaining <= 0) stack.push({ node: child, finish: false });
    else if (state.isObject(child)) nested.push(child);
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
