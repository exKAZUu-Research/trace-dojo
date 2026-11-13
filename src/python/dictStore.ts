import { keyHash, pyHash } from './hashing';
import { keysEqual } from './operators';
import { chargeSlots, chargeStep } from './runtimeContext';
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
      if (index > 0) chargeStep();
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
    chargeSlots(1);
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

  /**
   * The live entry before `entry` in insertion order, or the last one when `entry` is undefined, as CPython's reverse
   * iterators walk the entries back from where they are, past any added after it.
   */
  previous(entry: DictEntry | undefined): DictEntry | undefined {
    const { entries } = this;
    let index = entry === undefined ? entries.length : entries.indexOf(entry);
    // An entry that compacting the entries dropped was deleted; the iterator then sees what is left before it.
    if (index === -1) index = entries.length;
    while (--index >= 0) if (entries[index]?.alive) return entries[index];
    return undefined;
  }

  ordered(): DictEntry[] {
    return this.entries.filter((entry) => entry.alive);
  }

  /** The live entries from the last inserted, read lazily as {@link liveEntries} reads them. */
  *reversedLiveEntries(): Generator<DictEntry> {
    const { entries } = this;
    for (let index = entries.length - 1; index >= 0; index--) if (entries[index].alive) yield entries[index];
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
    // As od_move_to_end does, an entry already at that end stays, and the dict's iterators see no change.
    if ((last ? this.last() : this.first()) === entry) return;
    this.entries = this.entries.filter((candidate) => candidate !== entry && candidate.alive);
    this.deleted = 0;
    if (last) this.entries.push(entry);
    else this.entries.unshift(entry);
    this.version++;
  }
}
