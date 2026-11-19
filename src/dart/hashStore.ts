import type { Runtime } from './runtime';
import { coreTypes } from './types';
import { DartObject, DartRecord, type NativeState, type Value } from './values';

const DELETED = Symbol('deleted');

/**
 * The entries of a `LinkedHashMap` or `LinkedHashSet`: Dart's `==` and `hashCode` find keys, and iteration follows
 * insertion order. Objects that keep Object's `==` are found by identity without calling into the program.
 */
export class HashStore implements NativeState {
  [key: string]: unknown;
  keys: (Value | typeof DELETED)[] = [];
  entryValues: Value[] = [];
  private readonly index = new Map<string, number[]>();
  size = 0;
  /** Bumped by every change to the keys, which iterators check to detect concurrent modification. */
  modifications = 0;

  constructor(
    private readonly runtime: Runtime,
    /** Whether the store keeps values, as a map does, or only keys, as a set does. */
    readonly isMap: boolean
  ) {}

  *values(): Iterable<Value> {
    for (const [position, key] of this.keys.entries()) {
      if (key === DELETED) continue;
      yield key;
      if (this.isMap) yield this.entryValues[position];
    }
  }

  find(key: Value): number {
    const { hash, byIdentity } = this.hashOf(key);
    const bucket = this.index.get(hash);
    if (!bucket) return -1;
    for (const position of bucket) {
      const candidate = this.keys[position];
      if (candidate === DELETED) continue;
      if (byIdentity || this.runtime.equals(candidate as Value, key)) return position;
    }
    return -1;
  }

  has(key: Value): boolean {
    return this.find(key) >= 0;
  }

  get(key: Value): Value {
    const position = this.find(key);
    return position >= 0 ? this.entryValues[position] : undefined;
  }

  /** Adds or replaces an entry, telling whether the key was new. */
  set(key: Value, value: Value): boolean {
    const position = this.find(key);
    if (position >= 0) {
      if (this.isMap) this.entryValues[position] = value;
      return false;
    }
    this.runtime.allocate(this.isMap ? 2 : 1);
    const { hash } = this.hashOf(key);
    const added = this.keys.length;
    this.keys.push(key);
    this.entryValues.push(value);
    const bucket = this.index.get(hash);
    if (bucket) bucket.push(added);
    else this.index.set(hash, [added]);
    this.size++;
    this.modifications++;
    return true;
  }

  delete(key: Value): { found: boolean; value: Value } {
    const position = this.find(key);
    if (position < 0) return { found: false, value: undefined };
    const value = this.entryValues[position];
    this.keys[position] = DELETED;
    this.entryValues[position] = undefined;
    this.size--;
    this.modifications++;
    if (this.size === 0 || (this.keys.length > 32 && this.size * 2 < this.keys.length)) this.compact();
    return { found: true, value };
  }

  clear(): void {
    if (this.size > 0) this.modifications++;
    this.keys = [];
    this.entryValues = [];
    this.index.clear();
    this.size = 0;
  }

  /** The live positions in insertion order, which iterators walk. */
  *positions(): Iterable<number> {
    for (let position = 0; position < this.keys.length; position++) {
      if (this.keys[position] !== DELETED) yield position;
    }
  }

  keyAt(position: number): Value {
    return this.keys[position] as Value;
  }

  isLive(position: number): boolean {
    return position < this.keys.length && this.keys[position] !== DELETED;
  }

  private compact(): void {
    const keys: Value[] = [];
    const values: Value[] = [];
    for (const position of this.positions()) {
      keys.push(this.keys[position] as Value);
      values.push(this.entryValues[position]);
    }
    this.keys = keys;
    this.entryValues = values;
    this.index.clear();
    for (const [position, key] of keys.entries()) {
      const { hash } = this.hashOf(key);
      const bucket = this.index.get(hash);
      if (bucket) bucket.push(position);
      else this.index.set(hash, [position]);
    }
  }

  /** A key's hash: equal primitives share one, and objects that keep Object's `==` hash by identity. */
  private hashOf(key: Value): { hash: string; byIdentity: boolean } {
    switch (typeof key) {
      case 'undefined': {
        return { hash: 'n', byIdentity: true };
      }
      case 'boolean': {
        return { hash: key ? 'b1' : 'b0', byIdentity: true };
      }
      case 'bigint': {
        return { hash: `i${key}`, byIdentity: true };
      }
      case 'number': {
        if (Number.isInteger(key)) return { hash: `i${BigInt(key)}`, byIdentity: true };
        // NaN never equals itself, so a NaN key is only ever found by identity of its bucket's equality check.
        return { hash: `d${key}`, byIdentity: !Number.isNaN(key) };
      }
      case 'string': {
        return { hash: `s${key}`, byIdentity: true };
      }
      default: {
        return objectHash(this.runtime, key);
      }
    }
  }
}

function objectHash(runtime: Runtime, key: DartObject): { hash: string; byIdentity: boolean } {
  if (key instanceof DartRecord) return { hash: `r${recordHash(runtime, key)}`, byIdentity: false };
  const equals = key.cls.implementation('==');
  const hashCode = key.cls.implementation('hashCode');
  if (equals?.owner === coreTypes.object && hashCode?.owner === coreTypes.object) {
    return { hash: `o${key.identity}`, byIdentity: true };
  }
  const hash = runtime.getProperty(key, 'hashCode', undefined) as bigint;
  return { hash: `h${hash}`, byIdentity: false };
}

function recordHash(runtime: Runtime, record: DartRecord): string {
  const parts: string[] = [];
  for (const value of record.positional) parts.push(hashText(runtime, value));
  for (const [name, value] of record.named) parts.push(`${name}:${hashText(runtime, value)}`);
  return parts.join(',');
}

function hashText(runtime: Runtime, value: Value): string {
  if (value instanceof DartObject) {
    if (value instanceof DartRecord) return `(${recordHash(runtime, value)})`;
    return (runtime.getProperty(value, 'hashCode', undefined) as bigint).toString();
  }
  if (typeof value === 'number' && Number.isInteger(value)) return String(BigInt(value));
  return String(value);
}

export { DELETED };
