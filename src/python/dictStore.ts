import { keyHash, pyHash } from './hashing';
import { keysEqual } from './operators';
import { chargeCollision } from './runtimeContext';
import type { PyValue } from './values';

export interface DictEntry {
  key: PyValue;
  value: PyValue;
  hash: bigint;
  alive: boolean;
}

/** The entries of a dict in insertion order, found by their Python hashes and equality. */
export class DictStore {
  constructor(
    /** Whether storing and deleting hash keys without rewording their TypeError, as an OrderedDict does. */
    readonly plainWrites = false
  ) {}

  private entries: DictEntry[] = [];
  private readonly index = new Map<bigint, DictEntry[]>();
  private deleted = 0;
  /** Counts changes, so that iterating a dict can detect a change in its size. */
  version = 0;

  get size(): number {
    return this.entries.length - this.deleted;
  }

  lookup(key: PyValue, hash = keyHash(key, 'dict key')): DictEntry | undefined {
    const bucket = this.index.get(hash);
    if (!bucket) return undefined;
    for (const [index, entry] of bucket.entries()) {
      if (index > 0) chargeCollision();
      if (entry.alive && keysEqual(entry.key, key)) return entry;
    }
    return undefined;
  }

  get(key: PyValue): PyValue | undefined {
    return this.lookup(key)?.value;
  }

  has(key: PyValue): boolean {
    return this.get(key) !== undefined;
  }

  /** Stores a value, keeping the key and position of an equal key already present. */
  set(key: PyValue, value: PyValue, hash = this.writeHash(key)): void {
    const existing = this.lookup(key, hash);
    if (existing) {
      existing.value = value;
      return;
    }
    const entry: DictEntry = { key, value, hash, alive: true };
    this.entries.push(entry);
    const bucket = this.index.get(hash);
    if (bucket) bucket.push(entry);
    else this.index.set(hash, [entry]);
    this.version++;
  }

  delete(key: PyValue): DictEntry | undefined {
    const entry = this.lookup(key, this.writeHash(key));
    if (!entry) return undefined;
    this.remove(entry);
    return entry;
  }

  private writeHash(key: PyValue): bigint {
    return this.plainWrites ? pyHash(key) : keyHash(key, 'dict key');
  }

  remove(entry: DictEntry): void {
    entry.alive = false;
    const bucket = this.index.get(entry.hash) as DictEntry[];
    bucket.splice(bucket.indexOf(entry), 1);
    if (bucket.length === 0) this.index.delete(entry.hash);
    this.deleted++;
    this.version++;
    if (this.deleted > 16 && this.deleted * 2 > this.entries.length) {
      this.entries = this.entries.filter((candidate) => candidate.alive);
      this.deleted = 0;
    }
  }

  clear(): void {
    for (const entry of this.entries) entry.alive = false;
    this.entries = [];
    this.index.clear();
    this.deleted = 0;
    this.version++;
  }

  /** The live entries in insertion order, read lazily so that deletions during iteration are seen. */
  *liveEntries(): Generator<DictEntry> {
    const { entries } = this;
    for (const entry of entries) if (entry.alive) yield entry;
  }

  ordered(): DictEntry[] {
    return this.entries.filter((entry) => entry.alive);
  }

  last(): DictEntry | undefined {
    for (let index = this.entries.length - 1; index >= 0; index--) {
      if (this.entries[index].alive) return this.entries[index];
    }
    return undefined;
  }

  first(): DictEntry | undefined {
    return this.entries.find((entry) => entry.alive);
  }

  /** Moves an entry to the end (or the start), as `OrderedDict.move_to_end` does. */
  moveToEnd(entry: DictEntry, last: boolean): void {
    this.entries = this.entries.filter((candidate) => candidate !== entry && candidate.alive);
    this.deleted = 0;
    if (last) this.entries.push(entry);
    else this.entries.unshift(entry);
    this.version++;
  }
}

/**
 * The store of a `__dict__` that is the attribute map of an object, class, or module itself, so that changing the dict
 * changes the attributes, as CPython's `__dict__` is the namespace. Keys that are not strings stay in the dict only.
 */
export class NamespaceDictStore extends DictStore {
  constructor(private readonly namespace: Map<string, PyValue>) {
    super();
  }

  override set(key: PyValue, value: PyValue, hash?: bigint): void {
    super.set(key, value, hash);
    if (typeof key === 'string') this.namespace.set(key, value);
  }

  override delete(key: PyValue): DictEntry | undefined {
    const entry = super.delete(key);
    if (entry && typeof key === 'string') this.namespace.delete(key);
    return entry;
  }

  override remove(entry: DictEntry): void {
    super.remove(entry);
    if (typeof entry.key === 'string') this.namespace.delete(entry.key);
  }

  override clear(): void {
    super.clear();
    this.namespace.clear();
  }

  override get size(): number {
    this.sync();
    return super.size;
  }

  override lookup(key: PyValue, hash?: bigint): DictEntry | undefined {
    this.sync();
    return super.lookup(key, hash);
  }

  override ordered(): DictEntry[] {
    this.sync();
    return super.ordered();
  }

  override *liveEntries(): Generator<DictEntry> {
    this.sync();
    yield* super.liveEntries();
  }

  /** Brings the dict up to date with the attributes set or deleted since, as every read does first. */
  private sync(): void {
    if (this.syncing) return;
    this.syncing = true;
    try {
      for (const entry of super.ordered()) {
        if (typeof entry.key === 'string' && !this.namespace.has(entry.key)) super.remove(entry);
      }
      for (const [key, value] of this.namespace) {
        const entry = super.lookup(key);
        if (!entry) super.set(key, value);
        else if (entry.value !== value) entry.value = value;
      }
    } finally {
      this.syncing = false;
    }
  }

  private syncing = false;
}
