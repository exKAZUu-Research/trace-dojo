import type { TurtleState } from '../interpreter/turtleWorld';
import type { Frame } from './runtime';
import type { ClassInfo, JavaType, NumericKind } from './types';

/** Java `null` is `undefined`; `long` values are bigints and the other numeric values are numbers. */
export type Value = number | bigint | boolean | JavaString | JavaObject | JavaArray | undefined;

/** Strings are objects so that `==` compares references as in Java. */
export class JavaString {
  constructor(readonly value: string) {}
}

let nextIdentity = 1;

export class JavaObject {
  readonly fields: Value[];
  readonly identity = nextIdentity++;
  /** Set by the builtin Turtle constructor. */
  turtle?: TurtleState;
  /** The instance of the enclosing class that an inner, local, or anonymous class's instance belongs to. */
  outer?: JavaObject;
  /** The enclosing method's locals that a local or anonymous class's instance reads. */
  capturedLocals?: Value[];
  /** What a builtin object holds outside its fields, such as an Optional's value or a stream's source. */
  retained?: Value[];
  /** The elements of a builtin list or the items an iterator walks over. */
  elements?: Value[];
  /** The entries of a builtin hash map or set. */
  store?: HashStore;
  /** What a lambda, a method reference, or a library function object runs when its interface method is called. */
  function?: {
    call: (frame: Frame, args: Value[]) => Value;
    /** The enclosing method's locals the function reads, which keep their turtles alive. */
    captured?: readonly Value[];
    outerThis?: Value;
  };
  /** The text of a `StringBuilder`. */
  builder?: string;
  /** Counts the structural changes of a builtin collection, which make its iterators fail fast. */
  modCount?: number;
  /** The class a `Class` object stands for. */
  reflected?: ClassInfo;
  /** The primitive value a wrapper object such as an `Integer` boxes. */
  boxed?: number | bigint | boolean;
  /** Set for the constants of an enum. */
  enumConstant?: { name: JavaString; ordinal: number };
  /** Set by the builtin Throwable constructors. */
  message?: JavaString;
  cause?: JavaObject;
  /** The exceptions that closing resources threw while this one was in flight. */
  suppressed?: JavaObject[];

  constructor(readonly cls: ClassInfo) {
    this.fields = Array.from({ length: cls.instanceFieldCount });
    for (const field of cls.instanceFields) this.fields[field.slot] = defaultValue(field.type);
  }
}

export interface HashEntry {
  key: Value;
  value: Value;
  hash: number;
  /** For a hash-ordered store, where the entry comes within its bucket: entries iterate by bucket, then by this. */
  order?: number;
}

/** `HashMap`'s TREEIFY_THRESHOLD and MIN_TREEIFY_CAPACITY. */
const TREEIFY_THRESHOLD = 8;
const MIN_TREEIFY_CAPACITY = 64;

/**
 * The entries of a `HashMap` or `HashSet`, which iterates as Java's does: by bucket of a table that doubles whenever
 * the entries exceed three quarters of it, or a bucket of a table smaller than 64 grows crowded, and in insertion
 * order within a bucket.
 */
export class HashStore {
  private list: HashEntry[] = [];
  /** The orders of the first and the next last entry within buckets, which head and tail insertion take. */
  private firstOrder = 0;
  private lastOrder = 0;
  /** The entries by hash, which finds a key among the entries of its hash only; built when first needed. */
  private byHash: Map<number, HashEntry[]> | undefined;
  capacity = 16;
  /**
   * How iteration orders the entries: by hash bucket as a `HashMap`, by insertion as a `LinkedHashMap`, or sorted by
   * `compare` as a `TreeMap`, whose entries stay sorted as they are added.
   */
  order: 'hash' | 'insertion' | 'sorted' = 'hash';
  /** For a sorted store, compares keys, which also decides which keys are the same. */
  compare?: (frame: Frame, a: Value, b: Value) => number;
  /** For a sorted store, the `Comparator` that `compare` calls, or `undefined` for natural ordering. */
  comparator?: Value;

  /**
   * Where `key` is or would go among a sorted store's entries, by binary search as a `TreeMap` descends its tree, so
   * that each lookup costs a logarithmic number of comparisons, which may call the program's comparator.
   */
  positionOf(frame: Frame, key: Value): { index: number; isFound: boolean } {
    const compare = this.compare as NonNullable<HashStore['compare']>;
    let [low, high] = [0, this.entries.length];
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const order = compare(frame, key, (this.entries[middle] as HashEntry).key);
      if (order === 0) return { index: middle, isFound: true };
      if (order < 0) high = middle;
      else low = middle + 1;
    }
    return { index: low, isFound: false };
  }

  /**
   * The entry of a sorted store nearest to `target` whose order against it `accepts`: the first such entry, or with
   * `fromEnd` the last one, found by binary search since `accepts` holds on one side of `target` only.
   */
  nearest(frame: Frame, target: Value, accepts: (order: number) => boolean, fromEnd: boolean): HashEntry | undefined {
    const compare = this.compare as NonNullable<HashStore['compare']>;
    // The first index from which `accepts` holds (or, from the end, stops holding).
    let [low, high] = [0, this.entries.length];
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const holds = accepts(compare(frame, (this.entries[middle] as HashEntry).key, target));
      if (holds !== fromEnd) high = middle;
      else low = middle + 1;
    }
    return this.entries[fromEnd ? low - 1 : low];
  }

  /** The entries in the order Java's iteration visits them, as a new array that later changes leave as it is. */
  ordered(): HashEntry[] {
    if (this.order !== 'hash') return [...this.list];
    return this.list.toSorted((a, b) => this.bucketOf(a) - this.bucketOf(b) || (a.order ?? 0) - (b.order ?? 0));
  }

  get entries(): HashEntry[] {
    return this.list;
  }

  set entries(entries: HashEntry[]) {
    this.list = entries;
    this.byHash = undefined;
  }

  /** The entries whose keys have `hash`, among which a key equal to one with that hash is. */
  withHash(hash: number): readonly HashEntry[] {
    if (!this.byHash) {
      this.byHash = new Map();
      for (const entry of this.list) this.indexEntry(entry);
    }
    return this.byHash.get(hash) ?? [];
  }

  /** Inserts an entry at a position of a sorted store, which keeps its entries in order. */
  insertAt(index: number, entry: HashEntry): void {
    this.list.splice(index, 0, entry);
    this.indexEntry(entry);
  }

  /**
   * Moves an entry to the end of an insertion-ordered store, as an access-ordered `LinkedHashMap` does, returning
   * whether that changed the order.
   */
  moveToEnd(entry: HashEntry): boolean {
    const index = this.list.indexOf(entry);
    if (index === -1 || index === this.list.length - 1) return false;
    this.list.splice(index, 1);
    this.list.push(entry);
    return true;
  }

  /** Removes an entry, keeping the order of the others. */
  remove(entry: HashEntry): void {
    const index = this.list.indexOf(entry);
    if (index !== -1) this.list.splice(index, 1);
    const sameHash = this.byHash?.get(entry.hash);
    if (sameHash) sameHash.splice(sameHash.indexOf(entry), 1);
  }

  private indexEntry(entry: HashEntry): void {
    const sameHash = this.byHash?.get(entry.hash);
    if (sameHash) sameHash.push(entry);
    else this.byHash?.set(entry.hash, [entry]);
  }

  /** Adds an entry at the end of its bucket and then grows the table, as `HashMap.put` does. */
  add(entry: HashEntry): void {
    const crowded = this.bucketSize(entry) >= TREEIFY_THRESHOLD;
    entry.order = this.lastOrder++;
    this.list.push(entry);
    this.indexEntry(entry);
    if (crowded) this.growCrowded();
    while (this.entries.length > this.capacity * 0.75) this.capacity *= 2;
  }

  /**
   * Grows a table whose entries exceed three quarters of it, as `HashMap.computeIfAbsent`, `compute`, and `merge` do
   * first, whether or not they find the key.
   */
  growBeforeCompute(): void {
    while (this.entries.length > this.capacity * 0.75) this.capacity *= 2;
  }

  /**
   * Adds an entry at the start of its bucket, as `HashMap.computeIfAbsent`, `compute`, and `merge` do after
   * `growBeforeCompute`; a later resize keeps the order within each bucket, as Java's split of a bucket does.
   */
  addAtBucketHead(entry: HashEntry): void {
    this.growBeforeCompute();
    const crowded = this.bucketSize(entry) >= TREEIFY_THRESHOLD - 1;
    // An order before every other entry's puts it first in its bucket, where a HashMap's head insertion puts it.
    entry.order = this.order === 'hash' ? --this.firstOrder : this.lastOrder++;
    this.list.push(entry);
    this.indexEntry(entry);
    if (crowded) this.growCrowded();
  }

  /** The number of entries in the bucket `entry` falls into. */
  private bucketSize(entry: HashEntry): number {
    if (this.capacity >= MIN_TREEIFY_CAPACITY) return 0;
    const bucket = this.bucketOf(entry);
    return this.entries.filter((other) => this.bucketOf(other) === bucket).length;
  }

  /**
   * Doubles a table smaller than 64 whose bucket grew crowded, as `HashMap.treeifyBin` resizes instead of turning
   * the bucket into a tree; a larger table's tree bins are not modeled.
   */
  private growCrowded(): void {
    if (this.capacity < MIN_TREEIFY_CAPACITY) this.capacity *= 2;
  }

  private bucketOf(entry: HashEntry): number {
    return (entry.hash ^ (entry.hash >>> 16)) & (this.capacity - 1);
  }
}

export class JavaArray {
  readonly identity = nextIdentity++;

  constructor(
    readonly elementType: JavaType,
    readonly values: Value[]
  ) {}
}

export function defaultValue(type: JavaType): Value {
  switch (type.kind) {
    case 'byte':
    case 'short':
    case 'int':
    case 'char':
    case 'float':
    case 'double': {
      return 0;
    }
    case 'long': {
      return 0n;
    }
    case 'boolean': {
      return false;
    }
    default: {
      return undefined;
    }
  }
}

/** Formats a double as `Double.toString` does (JDK 19 and later print the shortest round-trip digits). */
export function formatDouble(value: number): string {
  return formatShortest(value, (magnitude) => magnitude.toExponential());
}

/** Formats a float as `Float.toString` does: the shortest digits that read back as the same float. */
export function formatFloat(value: number): string {
  return formatShortest(value, shortestFloatDigits);
}

/** The double whose shortest digits are those `Float.toString` prints for `value`. */
export function floatToShortestDouble(value: number): number {
  if (!Number.isFinite(value) || value === 0) return value;
  return Math.sign(value) * Number(twoDigitsAtLeast(Math.abs(value), shortestFloatDigits));
}

function shortestFloatDigits(magnitude: number): string {
  for (let precision = 1; precision < 9; precision++) {
    const candidate = magnitude.toExponential(precision - 1);
    if (Math.fround(Number(candidate)) === magnitude) return candidate;
  }
  return magnitude.toExponential(8);
}

/**
 * The shortest digits in exponential notation, but at least two of them as Java prints: among the two-digit
 * decimals, the closest one reads back as the same value whenever a one-digit one does.
 */
function twoDigitsAtLeast(magnitude: number, shortest: (magnitude: number) => string): string {
  const digits = shortest(magnitude);
  return digits.includes('.') ? digits : magnitude.toExponential(1);
}

function formatShortest(value: number, shortest: (magnitude: number) => string): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return 'Infinity';
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
  if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0';
  const sign = value < 0 ? '-' : '';
  const [mantissa, exponentText] = twoDigitsAtLeast(Math.abs(value), shortest).split('e');
  const digits = mantissa.replace('.', '').replace(/0+$/, '');
  const exponent = Number(exponentText);
  if (exponent < -3 || exponent >= 7) return `${sign}${digits[0]}.${digits.slice(1) || '0'}E${exponent}`;
  if (exponent < 0) return `${sign}0.${'0'.repeat(-exponent - 1)}${digits}`;
  const integer = digits.slice(0, exponent + 1).padEnd(exponent + 1, '0');
  return `${sign}${integer}.${digits.slice(exponent + 1) || '0'}`;
}

const LONG_MIN = -(2n ** 63n);
const LONG_MAX = 2n ** 63n - 1n;

/** Converts a numeric value between kinds as Java's widening and narrowing primitive conversions do. */
// code-gauge-allow functionCognitiveComplexity 17 -- One case per pair of numeric kinds that JLS 5.1.2 and 5.1.3 convert between.
export function convertNumber(value: Value, from: NumericKind, to: NumericKind): Value {
  if (from === to) return value;
  if (from === 'long') {
    const big = value as bigint;
    switch (to) {
      case 'float': {
        return Math.fround(Number(big));
      }
      case 'double': {
        return Number(big);
      }
      default: {
        return narrowInt(Number(BigInt.asIntN(32, big)), to);
      }
    }
  }
  const number = value as number;
  switch (to) {
    case 'long': {
      if (from !== 'float' && from !== 'double') return BigInt(number);
      if (Number.isNaN(number)) return 0n;
      if (number >= 2 ** 63) return LONG_MAX;
      if (number <= -(2 ** 63)) return LONG_MIN;
      return BigInt(Math.trunc(number));
    }
    case 'float': {
      return Math.fround(number);
    }
    case 'double': {
      return number;
    }
    default: {
      return narrowInt(from === 'float' || from === 'double' ? doubleToInt(number) : number, to);
    }
  }
}

/** Narrows an int to `byte`, `short`, `char`, or keeps it as `int`. */
function narrowInt(value: number, to: NumericKind): number {
  switch (to) {
    case 'byte': {
      return (value << 24) >> 24;
    }
    case 'short': {
      return (value << 16) >> 16;
    }
    case 'char': {
      return value & 0xff_ff;
    }
    default: {
      return value;
    }
  }
}

/** Wraps a bigint to 64 bits as Java's long arithmetic does. */
export function toInt64(value: bigint): bigint {
  return BigInt.asIntN(64, value);
}

/** Wraps a number to 32 bits as Java's int arithmetic does. */
export function toInt32(value: number): number {
  // oxlint-disable-next-line unicorn/prefer-math-trunc -- `| 0` wraps around at 32 bits, which Math.trunc does not.
  return value | 0;
}

/** Java chars are UTF-16 code units, so a char is read as a code unit, not a code point. */
export function charCodeOf(text: string, index: number): number {
  // oxlint-disable-next-line unicorn/prefer-code-point -- Java chars are UTF-16 code units.
  return text.charCodeAt(index);
}

/** Narrows a double to int as Java does: NaN becomes 0 and out-of-range values saturate. */
export function doubleToInt(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value >= 2_147_483_647) return 2_147_483_647;
  if (value <= -2_147_483_648) return -2_147_483_648;
  return Math.trunc(value);
}

export function charToString(code: number): string {
  return String.fromCodePoint(code);
}
