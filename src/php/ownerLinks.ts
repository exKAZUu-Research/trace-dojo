interface Entry<Owner, Key> {
  owner: Owner;
  keys: Set<Key>;
  previous?: Entry<Owner, Key>;
  next?: Entry<Owner, Key>;
}

export class OwnerLinks<Owner, Key> {
  private readonly entries = new Map<Owner, Entry<Owner, Key>>();
  private newest?: Entry<Owner, Key>;

  add(owner: Owner, key: Key): void {
    let entry = this.entries.get(owner);
    if (!entry) {
      entry = { owner, keys: new Set() };
      this.entries.set(owner, entry);
    } else if (entry === this.newest) {
      entry.keys.add(key);
      return;
    } else this.unlink(entry);
    entry.keys.add(key);
    entry.previous = this.newest;
    entry.next = undefined;
    if (this.newest) this.newest.next = entry;
    this.newest = entry;
  }

  get(owner: Owner): Set<Key> | undefined {
    return this.entries.get(owner)?.keys;
  }

  delete(owner: Owner): void {
    const entry = this.entries.get(owner);
    if (!entry) return;
    this.unlink(entry);
    this.entries.delete(owner);
  }

  *[Symbol.iterator](): Generator<[Owner, Set<Key>]> {
    let cursor = this.newest;
    while (cursor) {
      const previous = cursor.previous;
      yield [cursor.owner, cursor.keys];
      cursor = previous;
    }
  }

  private unlink(entry: Entry<Owner, Key>): void {
    if (entry.next) entry.next.previous = entry.previous;
    else this.newest = entry.previous;
    if (entry.previous) entry.previous.next = entry.next;
  }
}
