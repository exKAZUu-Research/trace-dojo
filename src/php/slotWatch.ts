import type { Key } from './values';

interface Stamp {
  users: number;
}

const watches = new WeakMap<object, Map<Key, Stamp>>();

export function watchSlot(owner: object, key: Key): { current(): boolean; close(): void } {
  let slots = watches.get(owner);
  if (!slots) {
    slots = new Map();
    watches.set(owner, slots);
  }
  const stamp = slots.get(key) ?? { users: 0 };
  slots.set(key, stamp);
  stamp.users++;
  const current = (): boolean => slots.get(key) === stamp;
  return {
    current,
    close() {
      if (--stamp.users === 0 && current()) slots.delete(key);
      if (slots.size === 0 && watches.get(owner) === slots) watches.delete(owner);
    },
  };
}

export function replaceWatchedSlot(owner: object, key: Key): void {
  watches.get(owner)?.delete(key);
}

export function replaceWatchedSlots(owner: object, from?: bigint): void {
  const slots = watches.get(owner);
  if (!slots) return;
  if (from === undefined) slots.clear();
  else for (const key of slots.keys()) if (typeof key === 'bigint' && key >= from) slots.delete(key);
}
