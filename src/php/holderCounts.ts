import { ownershipRootSlots, pushObject } from './garbage';
import type { Runtime } from './runtime';
import { PhpArray, PhpObject, Ref } from './values';

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
