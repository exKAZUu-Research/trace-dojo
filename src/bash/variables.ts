/** The attributes `declare` sets, by the letter `declare -p` shows them with. */
export type Attribute = 'a' | 'A' | 'i' | 'n' | 'r' | 't' | 'x' | 'c' | 'l' | 'u';

/** The order in which `declare -p` lists attributes, as Bash's `var_attribute_string`. */
export const ATTRIBUTE_ORDER: readonly Attribute[] = ['a', 'A', 'i', 'n', 'r', 't', 'x', 'c', 'l', 'u'];

export type VariableValue =
  | { kind: 'scalar'; value: string }
  | { kind: 'indexed'; elements: Map<bigint, string> }
  | { kind: 'associative'; table: AssociativeTable };

export interface Variable {
  name: string;
  /** The value, or `undefined` for a variable that is declared but unset, as `local x` leaves it. */
  value: VariableValue | undefined;
  attributes: Set<Attribute>;
  /** Whether the shell created the variable at startup, which traces leave out. */
  isSystem?: boolean;
}

/** One level of variables: the global ones, or the locals of a function call. */
export type Scope = Map<string, Variable>;

interface Entry {
  key: string;
  value: string;
  hash: number;
}

/** The buckets of a new associative array (`ASSOC_HASH_BUCKETS`); converting a scalar starts with Bash's default 128. */
export const ASSOCIATIVE_BUCKETS = 1024;
export const CONVERTED_BUCKETS = 128;

/**
 * An associative array, kept in Bash's own hash table (`hashlib.c`) so that its keys come out in Bash's order: by
 * bucket, and within a bucket from the newest key, with the table growing fourfold as Bash's does.
 */
export class AssociativeTable {
  private buckets: Entry[][];
  private count = 0;

  constructor(buckets = ASSOCIATIVE_BUCKETS) {
    this.buckets = Array.from({ length: buckets }, () => []);
  }

  /** The number of buckets, which a compound assignment keeps when it replaces the elements, as Bash does. */
  get bucketCount(): number {
    return this.buckets.length;
  }

  get size(): number {
    return this.count;
  }

  get(key: string): string | undefined {
    const hash = hashString(key);
    return this.buckets[hash & (this.buckets.length - 1)].find((entry) => entry.hash === hash && entry.key === key)
      ?.value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  set(key: string, value: string): void {
    const hash = hashString(key);
    const existing = this.buckets[hash & (this.buckets.length - 1)].find(
      (entry) => entry.hash === hash && entry.key === key
    );
    if (existing) {
      existing.value = value;
      return;
    }
    if (this.count >= this.buckets.length * 2) this.grow();
    this.buckets[hash & (this.buckets.length - 1)].unshift({ key, value, hash });
    this.count++;
  }

  delete(key: string): void {
    const hash = hashString(key);
    const bucket = this.buckets[hash & (this.buckets.length - 1)];
    const index = bucket.findIndex((entry) => entry.hash === hash && entry.key === key);
    if (index === -1) return;
    bucket.splice(index, 1);
    this.count--;
  }

  /** The entries in Bash's order. */
  entries(): [string, string][] {
    return this.buckets.flatMap((bucket) => bucket.map(({ key, value }): [string, string] => [key, value]));
  }

  clone(): AssociativeTable {
    const copy = new AssociativeTable(this.buckets.length);
    copy.buckets = this.buckets.map((bucket) => bucket.map((entry) => ({ ...entry })));
    copy.count = this.count;
    return copy;
  }

  private grow(): void {
    const size = this.buckets.length * 4;
    const buckets: Entry[][] = Array.from({ length: size }, () => []);
    for (const bucket of this.buckets) {
      for (const entry of bucket) buckets[entry.hash & (size - 1)].unshift(entry);
    }
    this.buckets = buckets;
  }
}

/** Bash's FNV-1 string hash over the UTF-8 bytes, which it reads as signed `char`s, as arm64 macOS does. */
function hashString(text: string): number {
  let hash = 2_166_136_261;
  for (const byte of new TextEncoder().encode(text)) {
    hash = Math.imul(hash, 16_777_619) >>> 0;
    hash = (hash ^ (byte >= 0x80 ? byte - 0x1_00 : byte)) >>> 0;
  }
  return hash;
}

/** The elements of an indexed array in index order. */
export function sortedElements(elements: Map<bigint, string>): [bigint, string][] {
  return [...elements].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export function cloneValue(value: VariableValue | undefined): VariableValue | undefined {
  if (!value) return undefined;
  if (value.kind === 'scalar') return { ...value };
  if (value.kind === 'indexed') return { kind: 'indexed', elements: new Map(value.elements) };
  return { kind: 'associative', table: value.table.clone() };
}

export function cloneScope(scope: Scope): Scope {
  return new Map(
    [...scope].map(([name, variable]) => [
      name,
      { ...variable, value: cloneValue(variable.value), attributes: new Set(variable.attributes) },
    ])
  );
}

/** Whether a text is a valid variable name, as Bash's `legal_identifier`. */
export function isIdentifier(text: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(text);
}
