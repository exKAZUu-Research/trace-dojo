import { alignOf } from './layout';
import { undefinedValue } from './semaBase';
import type { Type } from './types';
import { registerStorageLocation, Slice, storageLocation, ZArray, zeroArray } from './values';

const emptyAllocations = new WeakMap<object, Map<number, Slice>>();

export function zeroAllocation(runtime: object, length: bigint, child: Type): Slice {
  let byAlignment = emptyAllocations.get(runtime);
  if (!byAlignment) {
    byAlignment = new Map();
    emptyAllocations.set(runtime, byAlignment);
  }
  const alignment = alignOf(child);
  let source = byAlignment.get(alignment);
  if (!source) {
    source = new Slice(new ZArray([]), 0, 0);
    byAlignment.set(alignment, source);
  }
  return length === 0n ? source : zeroSlice(source, length, child);
}

export function zeroSlice(source: Slice, length: bigint, child: Type): Slice {
  const storage = zeroArray(length, false, undefinedValue(child));
  const location = storageLocation(source.target.slots, source.start);
  registerStorageLocation(storage.slots, () => location, true);
  return new Slice(storage, 0, length);
}
