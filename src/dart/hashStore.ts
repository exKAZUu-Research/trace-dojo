import type { Runtime } from './runtime';
import type { NativeState, Value } from './values';

const DELETED = Symbol('deleted');

export interface HashPolicy {
  hash?: (key: Value) => bigint;
  equals?: (left: Value, right: Value) => boolean;
  valid?: (key: Value) => boolean;
  callbacks?: Value[];
  identity?: boolean;
}

const INITIAL_INDEX_SIZE = 8;
const UNUSED_PAIR = 0;
const DELETED_PAIR = 1;

/**
 * The entries of a `LinkedHashMap` or `LinkedHashSet` (`{}`), laid out as the VM's compact hash table
 * (_internal/vm_shared/lib/compact_hash.dart) so that it calls the keys' `hashCode` and `==` in the same order and
 * number: an index of hash patterns probed linearly, entries in insertion order with deleted ones marked, and a rehash
 * that inserts every live entry again when the entries fill up.
 */
export class HashStore implements NativeState {
  [key: string]: unknown;
  /** The keys of the entries in insertion order, with deleted ones marked; an entry's position is its index here. */
  keys: (Value | typeof DELETED)[] = [];
  entryValues: Value[] = [];
  /** The VM's index, of size 1 until the first insertion. */
  private index: Uint32Array = new Uint32Array(1);
  private hashMask = 0;
  /** How many entries fit before a rehash: half the index's size, and 0 until the first insertion. */
  private capacity = 0;
  private deletedKeys = 0;
  private displaced: { keys: (Value | typeof DELETED)[]; values: Value[]; key: Value; value: Value } | undefined;
  /** Bumped by every change to the keys, which iterators check to detect concurrent modification. */
  modifications = 0;

  constructor(
    private readonly runtime: Runtime,
    /** Whether the store keeps values, as a map does, or only keys, as a set does. */
    readonly isMap: boolean,
    readonly policy?: HashPolicy
  ) {}

  get size(): number {
    return this.keys.length - this.deletedKeys;
  }

  *values(): Iterable<Value> {
    for (const [position, key] of this.keys.entries()) {
      if (key === DELETED) continue;
      yield key;
      if (this.isMap) yield this.entryValues[position];
    }
  }

  *roots(): Iterable<Value> {
    if (this.policy?.callbacks) yield* this.policy.callbacks;
    const displaced = this.displaced;
    if (!displaced) return;
    yield displaced.key;
    yield displaced.value;
    for (const [index, key] of displaced.keys.entries()) {
      if (key === DELETED) continue;
      yield key;
      if (this.isMap) yield displaced.values[index];
    }
  }

  /** The position of a key's entry, or -1, hashing the key once as the VM's lookups do. */
  find(key: Value): number {
    return this.policy?.valid?.(key) === false ? -1 : this.probe(key, this.hashOf(key)).found;
  }

  has(key: Value): boolean {
    return this.find(key) >= 0;
  }

  get(key: Value): Value {
    const position = this.find(key);
    return position >= 0 ? this.entryValues[position] : undefined;
  }

  /** Adds or replaces an entry, telling whether the key was new (`map[key] = value`, `set.add(key)`). */
  set(key: Value, value: Value): boolean {
    return this.setHashed(key, value, this.hashOf(key));
  }

  /** `putIfAbsent`, which computes the value only for a new key and inserts it without hashing the key again. */
  putIfAbsent(key: Value, ifAbsent: () => Value): Value {
    const hash = this.hashOf(key);
    const { found, insertAt, pattern } = this.probe(key, hash);
    if (found >= 0) return this.entryValues[found];
    const before = this.modifications;
    const value = ifAbsent();
    if (this.modifications === before) this.insert(key, value, hash, pattern, insertAt);
    else this.set(key, value);
    return value;
  }

  delete(key: Value): { found: boolean; value: Value } {
    if (this.policy?.valid?.(key) === false) return { found: false, value: undefined };
    const hash = this.hashOf(key);
    const { found, slot } = this.probe(key, hash);
    if (found < 0) return { found: false, value: undefined };
    const value = this.entryValues[found];
    this.index[slot] = DELETED_PAIR;
    this.deleteAt(found);
    return { found: true, value };
  }

  /**
   * Marks an entry deleted without hashing its key, as the VM's removeWhere does; its index slot keeps pointing at
   * the marked entry, which lookups skip.
   */
  deleteAt(position: number): void {
    this.keys[position] = DELETED;
    this.entryValues[position] = undefined;
    this.deletedKeys++;
    this.modifications++;
  }

  clear(): void {
    if (this.size === 0) return;
    this.modifications++;
    this.keys = [];
    this.entryValues = [];
    this.index = new Uint32Array(1);
    this.hashMask = 0;
    this.capacity = 0;
    this.deletedKeys = 0;
  }

  /** The VM's `_quickCopy`: an empty table takes a copy of one without deleted entries, hashing nothing. */
  quickCopy(other: HashStore): boolean {
    if (this.capacity > 0 || this.policy !== other.policy || this.policy?.valid) return false;
    if (other.keys.length === 0) return true;
    if (other.deletedKeys !== 0) return false;
    this.keys = [...other.keys];
    this.entryValues = [...other.entryValues];
    this.index = Uint32Array.from(other.index);
    this.hashMask = other.hashMask;
    this.capacity = other.capacity;
    this.modifications++;
    return true;
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

  private setHashed(key: Value, value: Value, hash: bigint): boolean {
    const { found, insertAt, pattern } = this.probe(key, hash);
    if (found >= 0) {
      if (this.isMap) this.entryValues[found] = value;
      return false;
    }
    this.insert(key, value, hash, pattern, insertAt);
    return true;
  }

  private insert(key: Value, value: Value, hash: bigint, pattern: number, slot: number): void {
    if (this.keys.length === this.capacity) {
      this.displaced = { keys: this.keys, values: this.entryValues, key, value };
      try {
        this.rehash();
        this.setHashed(key, value, hash);
      } finally {
        this.displaced = undefined;
      }
      return;
    }
    this.runtime.allocate(this.isMap ? 2 : 1);
    this.index[slot] = pattern | this.keys.length;
    this.keys.push(key);
    this.entryValues.push(value);
    this.modifications++;
  }

  /** The VM's `_rehash`: the same size when many entries are deleted, else double, inserting every live entry again. */
  private rehash(): void {
    const size = this.index.length;
    const keepSize = this.deletedKeys * 2 > this.keys.length;
    const oldKeys = this.keys;
    const oldValues = this.entryValues;
    let newSize = keepSize ? size : size << 1;
    let hashMask = keepSize ? this.hashMask : this.hashMask >>> 1;
    if (newSize < INITIAL_INDEX_SIZE) {
      newSize = INITIAL_INDEX_SIZE;
      hashMask = indexSizeToHashMask(newSize);
    }
    this.index = new Uint32Array(newSize);
    this.hashMask = hashMask;
    this.capacity = newSize >> 1;
    this.keys = [];
    this.entryValues = [];
    this.deletedKeys = 0;
    this.modifications++;
    for (const [position, key] of oldKeys.entries()) {
      if (key !== DELETED) this.set(key, oldValues[position]);
    }
  }

  /** The VM's `_findValueOrInsertPoint`: `==` runs only on entries whose stored hash pattern matches. */
  // code-gauge-allow functionCognitiveComplexity 16 -- A transcription of the VM's probe loop, whose `==` calls programs see.
  private probe(key: Value, hash: bigint): { found: number; insertAt: number; pattern: number; slot: number } {
    const size = this.index.length;
    const sizeMask = size - 1;
    const maxEntries = size >> 1;
    const pattern = hashPattern(hash, this.hashMask, size);
    let slot = firstProbe(hash, sizeMask);
    let firstDeleted = -1;
    let pair = this.index[slot];
    while (pair !== UNUSED_PAIR) {
      if (pair === DELETED_PAIR) {
        if (firstDeleted < 0) firstDeleted = slot;
      } else {
        const entry = (pattern ^ pair) >>> 0;
        if (entry < maxEntries) {
          const candidate = this.keys[entry];
          if (candidate !== DELETED && this.keysEqual(candidate, key)) {
            return { found: entry, insertAt: -1, pattern, slot };
          }
        }
      }
      slot = (slot + 1) & sizeMask;
      pair = this.index[slot];
    }
    return { found: -1, insertAt: firstDeleted >= 0 ? firstDeleted : slot, pattern, slot };
  }

  private keysEqual(left: Value, right: Value): boolean {
    return this.policy?.equals?.(left, right) ?? this.runtime.equals(left, right);
  }

  private hashOf(key: Value): bigint {
    return this.policy?.hash?.(key) ?? (this.runtime.getProperty(key, 'hashCode', undefined) as bigint);
  }
}

function indexSizeToHashMask(indexSize: number): number {
  const indexBits = Math.clz32(0) - Math.clz32(indexSize) - 2;
  // The 64-bit VM keeps hashes as 63-bit integers.
  return 2 ** (32 - indexBits) - 1;
}

function hashPattern(fullHash: bigint, hashMask: number, size: number): number {
  const masked = Number(BigInt.asUintN(64, fullHash) & BigInt(hashMask));
  return masked === 0 ? size >> 1 : (masked * (size >> 1)) >>> 0;
}

function firstProbe(fullHash: bigint, sizeMask: number): number {
  const slot = Number(BigInt.asUintN(64, fullHash) & BigInt(sizeMask));
  return ((slot << 1) + slot) & sizeMask;
}
