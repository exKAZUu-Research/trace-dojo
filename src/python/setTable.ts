import { keyHash } from './hashing';
import { keysEqual } from './operators';
import type { PyValue } from './values';

const MIN_SIZE = 8;
const LINEAR_PROBES = 9;
const PERTURB_SHIFT = 5n;
const MASK64 = (1n << 64n) - 1n;

export interface SetEntry {
  key: PyValue;
  hash: bigint;
}

/** Marks a slot whose entry was removed, which lookups probe past and insertions may reuse. */
const DUMMY: SetEntry = { key: false, hash: -1n };

/**
 * The open-addressing hash table of CPython's set, transcribed from setobject.c, so that a set lists its elements in
 * the order CPython does.
 */
export class SetTable {
  private table: (SetEntry | undefined)[] = Array.from({ length: MIN_SIZE });
  private mask = MIN_SIZE - 1;
  /** Active and dummy slots. */
  fill = 0;
  /** Active slots. */
  used = 0;
  version = 0;

  get capacity(): number {
    return this.mask + 1;
  }

  get size(): number {
    return this.used;
  }

  /** The slots in table order, active entries as themselves, dummies as entries with hash -1. */
  *slots(): Generator<SetEntry | undefined> {
    yield* this.table;
  }

  /** The active entries in table order, which is the order Python iterates a set in. */
  *entries(): Generator<SetEntry> {
    const { table } = this;
    for (const entry of table) if (entry && entry !== DUMMY) yield entry;
  }

  keys(): PyValue[] {
    return [...this.entries()].map((entry) => entry.key);
  }

  has(key: PyValue, hash = keyHash(key, 'set element')): boolean {
    return this.findEntry(key, hash) !== undefined;
  }

  findEntry(key: PyValue, hash = keyHash(key, 'set element')): SetEntry | undefined {
    const index = this.lookup(key, hash);
    return index === undefined ? undefined : this.table[index];
  }

  private lookup(key: PyValue, hash: bigint): number | undefined {
    const { mask } = this;
    let perturb = hash & MASK64;
    let index = Number(hash & BigInt(mask));
    for (;;) {
      let probes = index + LINEAR_PROBES <= mask ? LINEAR_PROBES : 0;
      let slot = index;
      do {
        const entry = this.table[slot];
        if (entry === undefined) return undefined;
        if (entry !== DUMMY && entry.hash === hash && keysEqual(entry.key, key)) return slot;
        slot++;
      } while (probes-- > 0);
      perturb >>= PERTURB_SHIFT;
      index = Number((BigInt(index) * 5n + 1n + perturb) & BigInt(mask));
    }
  }

  // code-gauge-allow functionCognitiveComplexity 26 -- Transcribes CPython's set_add_entry.
  add(key: PyValue, hash = keyHash(key, 'set element')): void {
    const { mask } = this;
    let perturb = hash & MASK64;
    let index = Number(hash & BigInt(mask));
    let freeSlot: number | undefined;
    for (;;) {
      let probes = index + LINEAR_PROBES <= mask ? LINEAR_PROBES : 0;
      let slot = index;
      do {
        const entry = this.table[slot];
        if (entry === undefined) {
          this.used++;
          this.version++;
          if (freeSlot !== undefined) {
            this.table[freeSlot] = { key, hash };
            return;
          }
          this.fill++;
          this.table[slot] = { key, hash };
          if (this.fill * 5 >= mask * 3) this.resize(this.used > 50_000 ? this.used * 2 : this.used * 4);
          return;
        }
        if (entry === DUMMY) {
          // CPython 3.14 remembers the last dummy of the probe sequence, not the first.
          freeSlot = slot;
        } else if (entry.hash === hash && keysEqual(entry.key, key)) {
          return;
        }
        slot++;
      } while (probes-- > 0);
      perturb >>= PERTURB_SHIFT;
      index = Number((BigInt(index) * 5n + 1n + perturb) & BigInt(mask));
    }
  }

  discard(key: PyValue, hash = keyHash(key, 'set element')): boolean {
    const slot = this.lookup(key, hash);
    if (slot === undefined) return false;
    this.table[slot] = DUMMY;
    this.used--;
    this.version++;
    return true;
  }

  clear(): void {
    this.table = Array.from({ length: MIN_SIZE });
    this.mask = MIN_SIZE - 1;
    this.fill = 0;
    this.used = 0;
    this.version++;
  }

  /** Removes and returns an entry, scanning from where the previous pop stopped, as `set.pop()` does. */
  private finger = 0;
  pop(): SetEntry | undefined {
    if (this.used === 0) return undefined;
    let index = this.finger & this.mask;
    while (this.table[index] === undefined || this.table[index] === DUMMY) {
      index++;
      if (index > this.mask) index = 0;
    }
    const entry = this.table[index] as SetEntry;
    this.table[index] = DUMMY;
    this.used--;
    this.finger = index + 1;
    this.version++;
    return entry;
  }

  resize(minUsed: number): void {
    let size = MIN_SIZE;
    while (size <= minUsed) size *= 2;
    const old = this.table;
    this.table = Array.from({ length: size });
    this.mask = size - 1;
    this.fill = this.used;
    for (const entry of old) if (entry && entry !== DUMMY) this.insertClean(entry);
    this.version++;
  }

  private insertClean(entry: SetEntry): void {
    const { mask } = this;
    let perturb = entry.hash & MASK64;
    let index = Number(entry.hash & BigInt(mask));
    for (;;) {
      if (this.table[index] === undefined) {
        this.table[index] = entry;
        return;
      }
      if (index + LINEAR_PROBES <= mask) {
        for (let probe = 1; probe <= LINEAR_PROBES; probe++) {
          if (this.table[index + probe] === undefined) {
            this.table[index + probe] = entry;
            return;
          }
        }
      }
      perturb >>= PERTURB_SHIFT;
      index = Number((BigInt(index) * 5n + 1n + perturb) & BigInt(mask));
    }
  }

  /** Adds every entry of another table, as CPython's set_merge does. */
  merge(other: SetTable): void {
    if (other === this || other.used === 0) return;
    if ((this.fill + other.used) * 5 >= this.mask * 3) this.resize((this.used + other.used) * 2);
    if (this.fill === 0 && this.mask === other.mask && other.fill === other.used) {
      this.table = [...other.table];
      this.fill = other.fill;
      this.used = other.used;
      this.version++;
    } else if (this.fill === 0) {
      this.fill = other.used;
      this.used = other.used;
      for (const entry of other.entries()) this.insertClean(entry);
      this.version++;
    } else {
      for (const entry of other.entries()) this.add(entry.key, entry.hash);
    }
  }

  /** Takes over the entries of another table but keeps the pop position, as CPython's set_swap_bodies does. */
  adopt(other: SetTable): void {
    this.table = other.table;
    this.mask = other.mask;
    this.fill = other.fill;
    this.used = other.used;
    this.version++;
  }

  /** Prepares for adding `count` keys from a dict, as CPython's set_update_dict does. */
  reserveFor(count: number): void {
    if ((this.fill + count) * 5 >= this.mask * 3) this.resize((this.used + count) * 2);
  }

  copy(): SetTable {
    const copy = new SetTable();
    copy.merge(this);
    return copy;
  }
}
