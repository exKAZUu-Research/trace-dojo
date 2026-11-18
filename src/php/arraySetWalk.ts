import type { Key, PhpArray, Ref, Value } from './values';

export interface Entry {
  key: Key;
  slot: Value | Ref;
}

export function setEntries(array: PhpArray): Entry[] {
  return [...array.map].map(([key, slot]) => ({ key, slot }));
}

export type Compare = (a: Entry, b: Entry) => number;

/**
 * The comparisons of a sorted walk. PHP keeps the callback in use in one global, which `useKey` and `useData` switch
 * at PHP's points: comparing keys after equal values calls the value callback with the keys.
 */
export interface Comparisons {
  key: Compare;
  data: Compare;
  useKey: () => void;
  useData: () => void;
}

/** How the sorted walk compares entries: by value (`normal`), by key (`key`), or by key and then value (`assoc`). */
export type Behavior = 'normal' | 'key' | 'assoc';

export class SortedWalk {
  readonly pointers: number[];

  constructor(
    readonly lists: Entry[][],
    readonly behavior: Behavior,
    readonly comparisons: Comparisons
  ) {
    this.pointers = lists.map(() => 0);
  }

  at(list: number): Entry | undefined {
    return this.lists[list][this.pointers[list]];
  }

  /** Transcribes php_array_intersect's walk, yielding the keys of the first array that the result leaves out. */
  *intersect(): Generator<Key> {
    while (this.at(0)) {
      this.comparisons.useKey();
      const mismatch = this.commonMismatch();
      if (mismatch === undefined) {
        for (let entry = this.at(0); entry; entry = this.next()) yield entry.key;
        return;
      }
      if (mismatch) yield* this.dropBefore(mismatch);
      else this.skipEqual();
    }
  }

  /**
   * Looks for the first list's entry in the other lists: the first list that lacks it, 0 if all have it, or undefined
   * if a list ran out, which leaves out the rest of the first list.
   */
  private commonMismatch(): number | undefined {
    for (let index = 1; index < this.lists.length; index++) {
      const c = this.seekCommon(index);
      if (!this.at(index)) return undefined;
      if (c) return index;
      this.pointers[index]++;
    }
    return 0;
  }

  /** Moves list `index` past the entries before the first list's, returning how they compare as PHP's `c`. */
  private seekCommon(index: number): number {
    const { key, data } = this.comparisons;
    const first = this.at(0) as Entry;
    const compare = this.behavior === 'normal' ? data : key;
    let c = 0;
    while (this.at(index) && (c = compare(first, this.at(index) as Entry)) > 0) this.pointers[index]++;
    if (c || !this.at(index) || this.behavior !== 'assoc') return c;
    this.comparisons.useData();
    if (data(first, this.at(index) as Entry) === 0) return 0;
    this.comparisons.useKey();
    return 1;
  }

  /** Leaves out the first list's entries that come before list `index`'s, which no other list has. */
  private *dropBefore(index: number): Generator<Key> {
    for (;;) {
      yield (this.at(0) as Entry).key;
      const entry = this.next();
      if (!entry || this.behavior !== 'normal' || this.comparisons.data(entry, this.at(index) as Entry) >= 0) return;
    }
  }

  /** Transcribes php_array_diff's walk, yielding the keys of the first array that the result leaves out. */
  *diff(): Generator<Key> {
    while (this.at(0)) {
      this.comparisons.useKey();
      let c = 1;
      for (let index = 1; index < this.lists.length; index++) {
        const [result, found] = this.findIn(index, c);
        c = result;
        if (found) break;
      }
      if (c) {
        this.skipEqual();
        continue;
      }
      for (let entry = this.at(0); entry; entry = this.nextDifferent()) yield entry.key;
    }
  }

  /** Looks for the first list's entry in list `index`, returning PHP's `c` and whether the walk stops looking. */
  private findIn(index: number, previous: number): [number, boolean] {
    const first = this.at(0) as Entry;
    const list = this.lists[index];
    let c = previous;
    if (this.behavior === 'normal') {
      while (this.at(index) && (c = this.comparisons.data(first, this.at(index) as Entry)) > 0) this.pointers[index]++;
      if (c) return [c, false];
      if (this.at(index)) this.pointers[index]++;
      return [0, true];
    }
    let pointer = this.pointers[index];
    while (list[pointer] && (c = this.comparisons.key(first, list[pointer])) !== 0) pointer++;
    if (c) return [c, false];
    if (this.behavior === 'key') return [0, true];
    if (!list[pointer]) return [0, false];
    this.comparisons.useData();
    if (this.comparisons.data(first, list[pointer]) === 0) return [0, true];
    this.comparisons.useKey();
    return [-1, false];
  }

  /** Moves past the first list's entry and, comparing by value, past those equal to it. */
  private skipEqual(): void {
    while (this.nextDifferent()) {
      // Moves on until an entry differs.
    }
  }

  /** Moves to the first list's next entry, returning it unless it compares by value equal to the one before. */
  private nextDifferent(): Entry | undefined {
    const previous = this.at(0) as Entry;
    const entry = this.next();
    if (!entry || this.behavior !== 'normal' || this.comparisons.data(previous, entry)) return undefined;
    return entry;
  }

  private next(): Entry | undefined {
    this.pointers[0]++;
    return this.at(0);
  }
}
