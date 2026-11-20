import { reserveMemory, spendMemory } from './memoryAccounting';
import type { Value } from './values';

interface ByteRange {
  start: number;
  end: number;
}

interface SparseByteStorage {
  values: Map<number, Value>;
  zeroes: ByteRange[];
}

export const sparseByteValues = new WeakMap<Value[], SparseByteStorage>();

export function sparseBytes(length: number): Value[] {
  const storage: SparseByteStorage = { values: new Map(), zeroes: [] };
  const bytes = new Proxy<Value[]>([], {
    get: (target, property, receiver) => {
      if (property === 'length') return length;
      const index = propertyIndex(property);
      return index === undefined
        ? Reflect.get(target, property, receiver)
        : (storage.values.get(index) ?? implicitByte(storage.zeroes, index));
    },
    has: (target, property) => {
      const index = propertyIndex(property);
      return index === undefined ? Reflect.has(target, property) : index < length;
    },
    set: (target, property, value: Value, receiver) => {
      const index = propertyIndex(property);
      if (index === undefined) return Reflect.set(target, property, value, receiver);
      writeSparseByte(storage.values, index, value);
      return true;
    },
  });
  sparseByteValues.set(bytes, storage);
  return bytes;
}

export function clearSparseBytes(storage: SparseByteStorage, start: number, length: number, zero: boolean): void {
  replaceSparseBytes(storage, start, length, zero ? [{ start, end: start + length }] : []);
}

export function copySparseBytes(
  source: SparseByteStorage,
  target: SparseByteStorage,
  offset: number,
  start: number,
  length: number
): void {
  const snapshot = new Map<number, Value>();
  for (const [index, value] of sparseEntriesInRange(source.values, offset, length))
    snapshot.set(start + index - offset, value);
  const zeroes: ByteRange[] = [];
  for (let index = nextRange(source.zeroes, offset); index < source.zeroes.length; index++) {
    spendMemory();
    const range = source.zeroes[index];
    if (range.start >= offset + length) break;
    const first = Math.max(range.start, offset);
    const last = Math.min(range.end, offset + length);
    if (first < last) zeroes.push({ start: start + first - offset, end: start + last - offset });
  }
  replaceSparseBytes(target, start, length, zeroes, snapshot);
  for (const [index, value] of snapshot) {
    spendMemory();
    writeSparseByte(target.values, index, value);
  }
}

function replaceSparseBytes(
  storage: SparseByteStorage,
  start: number,
  length: number,
  zeroes: ByteRange[],
  snapshot?: ReadonlyMap<number, Value>
): void {
  for (const [index] of sparseEntriesInRange(storage.values, start, length))
    if (!snapshot?.has(index)) storage.values.delete(index);
  const end = start + length;
  const ranges = storage.zeroes;
  const first = nextRange(ranges, start - 1);
  let last = first;
  while (last < ranges.length && ranges[last].start <= end) {
    spendMemory();
    last++;
  }
  if (first === last && zeroes.length === 0) return;
  if (first < last && ranges[first].start < start) zeroes.unshift({ start: ranges[first].start, end: start });
  if (first < last && ranges[last - 1].end > end) zeroes.push({ start: end, end: ranges[last - 1].end });
  const merged = mergeAdjacentRanges(zeroes);
  if (merged.length === last - first) {
    for (const [index, range] of merged.entries()) ranges[first + index] = range;
    return;
  }
  const count = first + merged.length + ranges.length - last;
  reserveMemory(Math.max(0, count - ranges.length));
  spendMemory(count);
  storage.zeroes = [...ranges.slice(0, first), ...merged, ...ranges.slice(last)];
}

function mergeAdjacentRanges(ranges: readonly ByteRange[]): ByteRange[] {
  const merged: ByteRange[] = [];
  for (const range of ranges) {
    spendMemory();
    const previous = merged.at(-1);
    if (previous && previous.end === range.start) previous.end = range.end;
    else merged.push(range);
  }
  return merged;
}

function implicitByte(zeroes: readonly ByteRange[], index: number): bigint {
  const range = zeroes[nextRange(zeroes, index)];
  return range && range.start <= index ? 0n : 0xaan;
}

function nextRange(zeroes: readonly ByteRange[], index: number): number {
  let first = 0;
  let end = zeroes.length;
  while (first < end) {
    spendMemory();
    const middle = Math.floor((first + end) / 2);
    if (index < zeroes[middle].end) end = middle;
    else first = middle + 1;
  }
  return first;
}

export function* sparseEntriesInRange<T>(
  entries: ReadonlyMap<number, T>,
  start: number,
  length: number
): IterableIterator<[number, T]> {
  const end = start + length;
  if (length < entries.size) {
    for (let at = start; at < end; at++) {
      spendMemory();
      if (entries.has(at)) yield [at, entries.get(at)!];
    }
    return;
  }
  for (const entry of entries) {
    spendMemory();
    if (entry[0] >= start && entry[0] < end) yield entry;
  }
}

function writeSparseByte(target: Map<number, Value>, index: number, value: Value): void {
  if (!target.has(index)) reserveMemory(1);
  target.set(index, value);
}

export function propertyIndex(property: string | symbol): number | undefined {
  return typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property) ? Number(property) : undefined;
}
