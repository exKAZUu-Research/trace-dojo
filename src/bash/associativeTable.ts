/** An element of a compound assignment: a plain word, or `[key]=value`. */
export type CompoundElement =
  | { key: string; value: string; append: boolean; rawText?: string }
  | { plain: string; rawText: string }
  | string;

export function isKeyedCompoundList(elements: readonly CompoundElement[]): boolean {
  return elements.length > 0 && typeof elements[0] !== 'string' && !('plain' in elements[0]);
}

/** Reads one `[key]=value` item or alternating `key value` pair from an associative compound assignment. */
export function readAssociativePair(
  elements: CompoundElement[],
  index: number,
  element: CompoundElement,
  reportedName: string,
  keyedMode = isKeyedCompoundList(elements)
): {
  key: string;
  value: string;
  append: boolean;
  consumedNext: boolean;
  error?: string;
} {
  if (keyedMode) {
    if (typeof element === 'string' || 'plain' in element) {
      const invalidPlain = typeof element === 'string' ? element : element.plain;
      return {
        key: '',
        value: '',
        append: false,
        consumedNext: false,
        error: `${reportedName}: ${invalidPlain}: must use subscript when assigning associative array`,
      };
    }
    const rawKey = element.rawText ?? element.key;
    return {
      key: element.key,
      value: element.value,
      append: element.append,
      consumedNext: false,
      ...(element.key === '' ? { error: `${rawKey}: bad array subscript` } : {}),
    };
  }
  const key = compoundElementPlainText(element);
  const rawKey = typeof element === 'string' ? element : (element.rawText ?? key);
  const next = elements[index + 1];
  const value = next === undefined ? '' : compoundElementPlainText(next);
  return {
    key,
    value,
    append: false,
    consumedNext: true,
    ...(key === '' ? { error: `${rawKey}: bad array subscript` } : {}),
  };
}

function compoundElementPlainText(element: CompoundElement): string {
  if (typeof element === 'string') return element;
  if ('plain' in element) return element.plain;
  return `[${element.key}]${element.append ? '+=' : '='}${element.value}`;
}

/** Normalizes one indexed compound element for compound array storage. */
export function unpackIndexedElement(rawElement: CompoundElement): {
  key: string | undefined;
  value: string;
  append: boolean;
} {
  if (typeof rawElement === 'string') return { key: undefined, value: rawElement, append: false };
  if ('plain' in rawElement) return { key: undefined, value: rawElement.plain, append: false };
  return { key: rawElement.key, value: rawElement.value, append: rawElement.append };
}

interface BucketEntry {
  key: string;
  value: string;
  hash: number;
}

/** Initial hash bucket count for associative arrays (1024). */
export const ASSOCIATIVE_BUCKETS = 1024;

const UTF8_ENCODER = new TextEncoder();

export interface ReadonlyIndexedTable extends ReadonlyMap<bigint, string> {
  readonly version: number;
}

export class IndexedTable extends Map<bigint, string> implements ReadonlyIndexedTable {
  private revision = 0;

  get version(): number {
    return this.revision;
  }

  override set(key: bigint, value: string): this {
    this.revision++;
    return super.set(key, value);
  }

  override delete(key: bigint): boolean {
    const removed = super.delete(key);
    if (removed) this.revision++;
    return removed;
  }

  override clear(): void {
    if (this.size > 0) this.revision++;
    super.clear();
  }
}

export interface ReadonlyAssociativeTable {
  readonly size: number;
  readonly version: number;
  entries(): readonly [string, string][];
}

/**
 * Sparse power-of-two chained hash table matching Bash 5.3 associative-array key order:
 * buckets are visited in ascending index order, new keys prepend to their bucket, and capacity quadruples
 * when entry count reaches twice the bucket capacity. Only non-empty buckets are allocated.
 */
export class AssociativeTable implements ReadonlyAssociativeTable {
  private buckets = new Map<number, BucketEntry[]>();
  private capacity: number;
  private count = 0;
  private revision = 0;

  constructor(capacity = ASSOCIATIVE_BUCKETS) {
    this.capacity = capacity;
  }

  get bucketCount(): number {
    return this.capacity;
  }

  get size(): number {
    return this.count;
  }

  get version(): number {
    return this.revision;
  }

  get(key: string): string | undefined {
    const hash = fnv1SignedUtf8(key);
    return this.buckets.get(hash & (this.capacity - 1))?.find((entry) => entry.hash === hash && entry.key === key)
      ?.value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  set(key: string, value: string): void {
    const hash = fnv1SignedUtf8(key);
    const existing = this.buckets
      .get(hash & (this.capacity - 1))
      ?.find((entry) => entry.hash === hash && entry.key === key);
    if (existing) {
      existing.value = value;
      this.revision++;
      return;
    }
    if (this.count >= this.capacity * 2) this.rehash();
    const bucketIndex = hash & (this.capacity - 1);
    const bucket = this.buckets.get(bucketIndex);
    if (bucket) bucket.unshift({ key, value, hash });
    else this.buckets.set(bucketIndex, [{ key, value, hash }]);
    this.count++;
    this.revision++;
  }

  delete(key: string): void {
    const hash = fnv1SignedUtf8(key);
    const bucketIndex = hash & (this.capacity - 1);
    const bucket = this.buckets.get(bucketIndex);
    if (!bucket) return;
    const position = bucket.findIndex((entry) => entry.hash === hash && entry.key === key);
    if (position === -1) return;
    bucket.splice(position, 1);
    if (bucket.length === 0) this.buckets.delete(bucketIndex);
    this.count--;
    this.revision++;
  }

  clear(): void {
    if (this.count > 0) this.revision++;
    this.buckets.clear();
    this.count = 0;
  }

  entries(): [string, string][] {
    return [...this.buckets.keys()]
      .toSorted((a, b) => a - b)
      .flatMap((bucketIndex) =>
        (this.buckets.get(bucketIndex) as BucketEntry[]).map(({ key, value }): [string, string] => [key, value])
      );
  }

  clone(): AssociativeTable {
    const copy = new AssociativeTable(this.capacity);
    for (const [bucketIndex, bucket] of this.buckets) {
      copy.buckets.set(
        bucketIndex,
        bucket.map((entry) => ({ ...entry }))
      );
    }
    copy.count = this.count;
    return copy;
  }

  private rehash(): void {
    const nextCapacity = this.capacity * 4;
    const nextBuckets = new Map<number, BucketEntry[]>();
    for (const bucketIndex of [...this.buckets.keys()].toSorted((a, b) => a - b)) {
      for (const entry of this.buckets.get(bucketIndex) as BucketEntry[]) {
        const targetIndex = entry.hash & (nextCapacity - 1);
        const target = nextBuckets.get(targetIndex);
        if (target) target.unshift(entry);
        else nextBuckets.set(targetIndex, [entry]);
      }
    }
    this.capacity = nextCapacity;
    this.buckets = nextBuckets;
  }
}

/** Public-domain 32-bit FNV-1 hash (offset basis 2166136261, prime 16777619) over signed UTF-8 byte values. */
function fnv1SignedUtf8(text: string): number {
  let hash = 2_166_136_261;
  for (const byte of UTF8_ENCODER.encode(text)) {
    hash = Math.imul(hash, 16_777_619) >>> 0;
    hash = (hash ^ (byte >= 0x80 ? byte - 0x1_00 : byte)) >>> 0;
  }
  return hash;
}

/** Indexed-array elements ordered by ascending numeric index. */
export function sortedElements(elements: ReadonlyMap<bigint, string>): [bigint, string][] {
  return [...elements].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Greatest key in an indexed-array map, or `-1n` when empty. */
export function maxElementIndex(elements: ReadonlyMap<bigint, string>): bigint {
  let max = -1n;
  for (const key of elements.keys()) if (key > max) max = key;
  return max;
}

/** Whether `text` is a valid POSIX/Bash shell identifier (`[A-Za-z_][A-Za-z0-9_]*`). */
export function isIdentifier(text: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(text);
}

/** Whether a function's name is non-empty, contains no `$`, and is not purely digits. */
export function isValidFunctionName(name: string): boolean {
  return name !== '' && !name.includes('$') && !/^[0-9]+$/.test(name);
}
