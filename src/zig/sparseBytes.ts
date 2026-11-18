import { reserveMemory, spendMemory } from './memoryAccounting';
import type { Value } from './values';

export const sparseByteValues = new WeakMap<Value[], Map<number, Value>>();

export function sparseBytes(length: number): Value[] {
  const values = new Map<number, Value>();
  const bytes = new Proxy<Value[]>([], {
    get: (target, property, receiver) => {
      if (property === 'length') return length;
      const index = propertyIndex(property);
      return index === undefined ? Reflect.get(target, property, receiver) : (values.get(index) ?? 0xaan);
    },
    has: (target, property) => {
      const index = propertyIndex(property);
      return index === undefined ? Reflect.has(target, property) : index < length;
    },
    set: (target, property, value: Value, receiver) => {
      const index = propertyIndex(property);
      if (index === undefined) return Reflect.set(target, property, value, receiver);
      writeSparseByte(values, index, value);
      return true;
    },
  });
  sparseByteValues.set(bytes, values);
  return bytes;
}

export function copySparseBytes(
  source: Map<number, Value>,
  target: Map<number, Value>,
  offset: number,
  start: number,
  length: number
): void {
  const snapshot = new Map<number, Value>();
  for (const [index, value] of sparseEntriesInRange(source, offset, length))
    snapshot.set(start + index - offset, value);
  for (const [index] of sparseEntriesInRange(target, start, length)) {
    if (!snapshot.has(index)) target.set(index, 0xaan);
  }
  for (const [index, value] of snapshot) {
    spendMemory();
    writeSparseByte(target, index, value);
  }
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
