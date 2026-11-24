/** Variable attribute flags recognized by `declare` and listed by `declare -p`. */
export type Attribute = 'a' | 'A' | 'i' | 'n' | 'r' | 't' | 'x' | 'c' | 'l' | 'u';

/** Canonical display order of variable attribute flags for `declare -p` and `${x@a}`. */
export const ATTRIBUTE_ORDER: readonly Attribute[] = ['a', 'A', 'i', 'n', 'r', 't', 'x', 'c', 'l', 'u'];

export type VariableValue =
  | { kind: 'scalar'; value: string }
  | { kind: 'indexed'; elements: Map<bigint, string> }
  | { kind: 'associative'; table: AssociativeTable };

export interface Variable {
  name: string;
  /** Stored value, or `undefined` when declared without an initial value (such as `local x`). */
  value: VariableValue | undefined;
  attributes: Set<Attribute>;
  /** Whether the variable is a built-in shell variable omitted from learner traces. */
  isSystem?: boolean;
  /** Whether `value` is shared copy-on-write with a suspended parent or child subshell scope. */
  shared?: boolean;
}

/** A lexical/dynamic variable scope (global scope at index 0, followed by function and temporary scopes). */
export type Scope = Map<string, Variable>;

interface BucketEntry {
  key: string;
  value: string;
  hash: number;
}

/** Initial hash bucket count for associative arrays (1024) and scalar-to-associative conversions (128). */
export const ASSOCIATIVE_BUCKETS = 1024;
export const CONVERTED_BUCKETS = 128;

const UTF8_ENCODER = new TextEncoder();

/**
 * Sparse power-of-two chained hash table matching Bash 5.3 associative-array key order:
 * buckets are visited in ascending index order, new keys prepend to their bucket, and capacity quadruples
 * when entry count reaches twice the bucket capacity. Only non-empty buckets are allocated.
 */
export class AssociativeTable {
  private buckets = new Map<number, BucketEntry[]>();
  private capacity: number;
  private count = 0;

  constructor(capacity = ASSOCIATIVE_BUCKETS) {
    this.capacity = capacity;
  }

  get bucketCount(): number {
    return this.capacity;
  }

  get size(): number {
    return this.count;
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
      return;
    }
    if (this.count >= this.capacity * 2) this.rehash();
    const bucketIndex = hash & (this.capacity - 1);
    const bucket = this.buckets.get(bucketIndex);
    if (bucket) bucket.unshift({ key, value, hash });
    else this.buckets.set(bucketIndex, [{ key, value, hash }]);
    this.count++;
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
  }

  clear(): void {
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
export function sortedElements(elements: Map<bigint, string>): [bigint, string][] {
  return [...elements].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export function cloneValue(value: VariableValue | undefined): VariableValue | undefined {
  if (!value) return undefined;
  if (value.kind === 'scalar') return { ...value };
  if (value.kind === 'indexed') return { kind: 'indexed', elements: new Map(value.elements) };
  return { kind: 'associative', table: value.table.clone() };
}

/** Materializes a private copy of `variable.value` before mutating an indexed or associative container in place. */
export function ensureWritable(variable: Variable): void {
  if (!variable.shared) return;
  variable.value = cloneValue(variable.value);
  variable.shared = false;
}

/** Clones a scope for a subshell, sharing container values copy-on-write until the subshell mutates them. */
export function cloneScope(scope: Scope): Scope {
  const copy: Scope = new Map();
  for (const [name, variable] of scope) {
    copy.set(name, {
      ...variable,
      value: variable.value?.kind === 'scalar' ? { ...variable.value } : variable.value,
      attributes: new Set(variable.attributes),
      shared: variable.value !== undefined && variable.value.kind !== 'scalar',
    });
  }
  return copy;
}

/** Whether `text` is a valid POSIX/Bash shell identifier (`[A-Za-z_][A-Za-z0-9_]*`). */
export function isIdentifier(text: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(text);
}

/** Host environment variables absent in the browser grading sandbox. */
export const ENVIRONMENT_VARIABLES = new Set([
  'HOME',
  'PATH',
  'USER',
  'LOGNAME',
  'PWD',
  'OLDPWD',
  'SHELL',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_COLLATE',
  'LC_MESSAGES',
  'TMPDIR',
  'HOSTNAME',
  'HOSTTYPE',
  'OSTYPE',
  'MACHTYPE',
  'UID',
  'EUID',
  'PPID',
  'BASHPID',
  'BASH',
  'SHLVL',
  'SECONDS',
  'EPOCHSECONDS',
  'EPOCHREALTIME',
  'SRANDOM',
  'GROUPS',
  'DIRSTACK',
  'MAIL',
  'MAILCHECK',
  'BASH_ARGV',
  'BASH_ARGC',
  'BASH_ARGV0',
  'BASH_COMMAND',
  'BASH_EXECUTION_STRING',
  'BASHOPTS',
  'SHELLOPTS',
  'BASH_ALIASES',
  'BASH_CMDS',
  'BASH_LOADABLES_PATH',
  'COMP_WORDBREAKS',
  'HISTCMD',
  'COLUMNS',
  'LINES',
  'EDITOR',
  'PS1',
  'PS2',
  '_',
]);
