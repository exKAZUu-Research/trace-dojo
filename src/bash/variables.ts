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
  /** Whether an empty scalar value represents a `null` object binding from a `for` loop over turtles/structures. */
  nullReference?: boolean;
}

/** A lexical/dynamic variable scope (global scope at index 0, followed by function and temporary scopes). */
export type Scope = Map<string, Variable>;

/** An element of a compound assignment: a plain word, or `[key]=value`. */
export type CompoundElement =
  | {
      key: string;
      value: string;
      append: boolean;
      rawText?: string;
      evaluatedIndex?: bigint;
      preconvertedInteger?: boolean;
    }
  | { plain: string; rawText: string; evaluatedIndex?: bigint; preconvertedInteger?: boolean }
  | string;

/** Reads one `[key]=value` item or alternating `key value` pair from an associative compound assignment. */
export function readAssociativePair(
  elements: CompoundElement[],
  index: number,
  element: CompoundElement
): {
  key: string;
  rawKey: string;
  value: string;
  append: boolean;
  consumedNext: boolean;
  preconvertedInteger: boolean;
} {
  if (typeof element !== 'string' && !('plain' in element)) {
    return {
      key: element.key,
      rawKey: element.rawText ?? element.key,
      value: element.value,
      append: element.append,
      consumedNext: false,
      preconvertedInteger: Boolean(element.preconvertedInteger),
    };
  }
  const key = typeof element === 'string' ? element : element.plain;
  const rawKey = typeof element === 'string' ? element : element.rawText;
  const next = elements[index + 1];
  const value = next === undefined ? '' : typeof next === 'string' ? next : 'plain' in next ? next.plain : '';
  const preconvertedInteger =
    next !== undefined && typeof next !== 'string' && 'plain' in next && Boolean(next.preconvertedInteger);
  return { key, rawKey, value, append: false, consumedNext: true, preconvertedInteger };
}

/** Normalizes one indexed compound element for `assignCompoundTo`. */
export function unpackIndexedElement(rawElement: CompoundElement): {
  key: string | undefined;
  value: string;
  append: boolean;
  evaluatedIndex: bigint | undefined;
  preconvertedInteger: boolean;
} {
  if (typeof rawElement === 'string') {
    return {
      key: undefined,
      value: rawElement,
      append: false,
      evaluatedIndex: undefined,
      preconvertedInteger: false,
    };
  }
  if ('plain' in rawElement) {
    return {
      key: undefined,
      value: rawElement.plain,
      append: false,
      evaluatedIndex: rawElement.evaluatedIndex,
      preconvertedInteger: Boolean(rawElement.preconvertedInteger),
    };
  }
  return {
    key: rawElement.key,
    value: rawElement.value,
    append: rawElement.append,
    evaluatedIndex: rawElement.evaluatedIndex,
    preconvertedInteger: Boolean(rawElement.preconvertedInteger),
  };
}

/** Builds compound initializer preparation context from an existing target variable and optional flag overrides. */
export function compoundPrepareForVariable(
  targetName: string,
  reportedName: string,
  existing: Variable | undefined,
  append: boolean,
  isAssociative: boolean,
  isInteger: boolean
): {
  targetName: string;
  reportedName: string;
  isAssociative: boolean;
  isInteger: boolean;
  baseIndexed: ReadonlyMap<bigint, string> | undefined;
  baseAssociative: AssociativeTable | undefined;
} {
  const baseIndexed =
    append && existing?.value?.kind === 'indexed'
      ? existing.value.elements
      : append && existing?.value?.kind === 'scalar'
        ? new Map([[0n, existing.value.value]])
        : undefined;
  const baseAssociative = append && existing?.value?.kind === 'associative' ? existing.value.table : undefined;
  return { targetName, reportedName, isAssociative, isInteger, baseIndexed, baseAssociative };
}

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

/** Greatest key in an indexed-array map, or `-1n` when empty. */
export function maxElementIndex(elements: ReadonlyMap<bigint, string>): bigint {
  let max = -1n;
  for (const key of elements.keys()) if (key > max) max = key;
  return max;
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

/** Whether a function's name is non-empty, contains no `$`, and is not purely digits. */
export function isValidFunctionName(name: string): boolean {
  return name !== '' && !name.includes('$') && !/^[0-9]+$/.test(name);
}

/** Looks up `name` in `scopes` from innermost to outermost, skipping `excludedScope`. */
export function findEnclosingVariable(scopes: Scope[], excludedScope: Scope, name: string): Variable | undefined {
  for (let i = scopes.length - 1; i >= 0; i--) {
    if (scopes[i] === excludedScope) continue;
    const found = scopes[i].get(name);
    if (found) return found;
  }
  return undefined;
}

/** Removes `target` from the innermost scope holding it (leaving a running-function local declared without a value). */
export function removeScopedVariable(
  scopes: Scope[],
  currentFunctionScope: number | undefined,
  target: string
): 'ok' | 'readonly' {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const variable = scopes[i].get(target);
    if (!variable) continue;
    if (variable.attributes.has('r')) return 'readonly';
    if (i > 0 && currentFunctionScope === i) {
      variable.value = undefined;
      variable.shared = false;
      variable.attributes.clear();
    } else scopes[i].delete(target);
    return 'ok';
  }
  return 'ok';
}

/** Elements of call-stack and foreground-pipeline dynamic arrays (`FUNCNAME`, `BASH_LINENO`, `BASH_SOURCE`, `PIPESTATUS`). */
export function callStackArray(
  name: string,
  calls: readonly { name: string; line: number }[],
  scriptName: string,
  pipeStatus: readonly string[] = []
): string[] | undefined {
  if (name === 'PIPESTATUS') return [...pipeStatus];
  const reversed = calls.toReversed();
  if (name === 'FUNCNAME') return reversed.length === 0 ? undefined : [...reversed.map((c) => c.name), 'main'];
  if (name === 'BASH_LINENO') return [...reversed.map((c) => String(c.line)), '0'];
  if (name === 'BASH_SOURCE') return [...reversed.map(() => scriptName), scriptName];
  return undefined;
}

/** Advances Bash's Park-Miller `RANDOM` generator until it produces a 15-bit value distinct from `lastRandom`. */
export function advanceRandomState(randomSeed: number, lastRandom: number): { seed: number; value: number } {
  let seed = randomSeed;
  let value: number;
  do {
    seed = seed === 0 ? 123_459_876 : seed;
    const high = Math.trunc(seed / 127_773);
    const low = seed % 127_773;
    seed = 16_807 * low - 2836 * high;
    if (seed < 0) seed += 0x7f_ff_ff_ff;
    value = ((seed >>> 16) ^ (seed & 0xff_ff)) & 0x7f_ff;
  } while (value === lastRandom);
  return { seed, value };
}

/** Dynamic variables computed on read unless unset or shadowed. */
export const DYNAMIC_VARIABLES = new Set([
  'RANDOM',
  'LINENO',
  'FUNCNAME',
  'BASH_LINENO',
  'BASH_SOURCE',
  'BASH_SUBSHELL',
  'PIPESTATUS',
]);

export const SCALAR_DYNAMIC_VARIABLES = new Set(['RANDOM', 'LINENO', 'BASH_SUBSHELL']);

/** Formats a dynamic variable cell for `declare -p` and `${v@a}` / `${v@A}`. */
export function buildDynamicDeclaration(
  name: string,
  scalarValue: string | undefined,
  elements: string[] | undefined
): Variable | undefined {
  if (SCALAR_DYNAMIC_VARIABLES.has(name)) {
    return {
      name,
      attributes: new Set<Attribute>(name === 'RANDOM' ? ['i'] : []),
      value: { kind: 'scalar', value: scalarValue as string },
    };
  }
  if (!elements || (name === 'PIPESTATUS' && elements.length === 0)) return undefined;
  return {
    name,
    attributes: new Set(['a']),
    value: {
      kind: 'indexed',
      elements: new Map(elements.map((element, index) => [BigInt(index), element])),
    },
  };
}

/** Dynamic variables that `unset` refuses to remove. */
export const PERMANENT_DYNAMIC_VARIABLES = new Set(['BASH_LINENO', 'BASH_SOURCE']);

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
  'BASH_MONOSECONDS',
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

/** Creates the initial global scope pre-populated with Bash 5.3's built-in system variables. */
export function createInitialGlobalScope(bashVersion: string): Scope {
  const global: Scope = new Map();
  const system = (name: string, value: VariableValue, attributes: Attribute[] = []): void => {
    global.set(name, { name, value, attributes: new Set(attributes), isSystem: true });
  };
  system('IFS', { kind: 'scalar', value: ' \t\n' });
  system('PS4', { kind: 'scalar', value: '+ ' });
  system('OPTIND', { kind: 'scalar', value: '1' });
  system('OPTERR', { kind: 'scalar', value: '1' });
  system('BASH_VERSION', { kind: 'scalar', value: bashVersion });
  system(
    'BASH_VERSINFO',
    {
      kind: 'indexed',
      elements: new Map(
        ['5', '3', '0', '1', 'release', 'aarch64-apple-darwin20.0.0'].map((value, index) => [BigInt(index), value])
      ),
    },
    ['a', 'r']
  );
  return global;
}

/** Yields every string value reachable across running/suspended scopes, positional lists, and active buffers. */
// code-gauge-allow functionCognitiveComplexity -- Walks every value kind across active and suspended shell scopes and buffers.
export function* collectReachableStrings(
  states: readonly { scopes: Scope[]; positional: string[][] }[],
  activeOutputs: readonly { text: string }[],
  inFlight: readonly { values: string[] }[]
): Iterable<string> {
  for (const state of states) {
    for (const scope of state.scopes) {
      for (const variable of scope.values()) {
        const { value } = variable;
        if (!value) continue;
        if (value.kind === 'scalar') yield value.value;
        else if (value.kind === 'indexed') yield* value.elements.values();
        else for (const [, element] of value.table.entries()) yield element;
      }
    }
    for (const args of state.positional) yield* args;
  }
  for (const { text } of activeOutputs) yield text;
  for (const { values } of inFlight) yield* values;
}
