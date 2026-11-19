import { KStore } from '../values';

/** The capacity `HashMap(initialCapacity)` starts with: the next power of two, as `tableSizeFor` computes. */
export function tableSizeFor(capacity: number): number {
  let size = 1;
  while (size < capacity) size *= 2;
  return Math.max(size, 1);
}

/** Kotlin's `mapCapacity`, the initial capacity that `hashMapOf` and `toHashSet` give a map of `expectedSize` entries. */
export function mapCapacity(expectedSize: number): number {
  if (expectedSize < 0) return expectedSize;
  if (expectedSize < 3) return expectedSize + 1;
  if (expectedSize < 2 ** 30) return Math.trunc(Math.fround(Math.fround(expectedSize / 0.75) + 1));
  return 2_147_483_647;
}

export function newStore(order: KStore['order'], capacity?: number): KStore {
  const store = new KStore();
  store.order = order;
  store.capacity = tableSizeFor(capacity === 0 ? 1 : (capacity ?? 16));
  store.isSized = capacity !== undefined;
  return store;
}

/** Sizes a map's table for a copy of `count` entries, as `HashMap.putMapEntries` does for its constructor and `putAll`. */
export function reserveForCopy(store: KStore, count: number): void {
  if (count === 0) return;
  if (store.isAllocated) {
    while (count > store.capacity * 0.75) store.capacity *= 2;
    return;
  }
  const needed = tableSizeFor(Math.trunc(Math.fround(Math.fround(count / 0.75) + 1)));
  store.capacity = store.isSized ? Math.max(store.capacity, needed) : needed;
}
