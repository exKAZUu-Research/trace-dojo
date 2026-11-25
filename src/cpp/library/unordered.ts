import { ExecutionLimitError, LIMITS } from '../../interpreter/limits';
import { byteAt } from '../bytes';
import { CppRuntimeError } from '../errors';
import type { ExpressionCompiler } from '../expressionCompiler';
import type { Frame } from '../runtime';
import {
  BOOL,
  ClassInfo,
  classType,
  DOUBLE,
  FLOAT,
  type FunctionInfo,
  isConstType,
  referenceTo,
  SIZE_T,
  type Type,
  typeName,
  unqualified,
  VOID,
  withConst,
} from '../types';
import { CObject, Ptr, Store, type Value } from '../values';
import { mappedNotDefaultConstructible, pairClass } from './associative';
import { MapValue, NodeCell } from './containerValues';
import {
  destroyElements,
  type ElementOperations,
  elementOperations,
  equalTo,
  functionObjectCall,
  requireDefaultConstruction,
  requireElementUse,
  type ValueComparison,
} from './elements';
import {
  addRangeMembers,
  associativeInitializerList,
  constructPair,
  copyEntries,
  emplacementCall,
  type EntryTable,
  insertCopy,
  pairResult,
} from './emplacement';
import { randomAccessIterator } from './iterators';
import type { Library } from './registry';
import type { StringValue } from './string';
import { addMethod, CONST_CHAR_PTR, constRef, native, nativeConstructor, throwLibrary } from './support';
import { typeKey } from './templates';

const MASK = (1n << 64n) - 1n;

/** libc++'s hash of a string (`__murmur2_or_cityhash` for a 64-bit `size_t`, a port of CityHash64). */
export function hashBytes(bytes: string): bigint {
  const length = bytes.length;
  const byte = (index: number): bigint => BigInt(byteAt(bytes, index) & 0xff);
  const load64 = (index: number): bigint => {
    let value = 0n;
    for (let offset = 7; offset >= 0; offset--) value = (value << 8n) | byte(index + offset);
    return value;
  };
  const load32 = (index: number): bigint => {
    let value = 0n;
    for (let offset = 3; offset >= 0; offset--) value = (value << 8n) | byte(index + offset);
    return value;
  };
  const k0 = 0xc3_a5_c8_5c_97_cb_31_27n;
  const k1 = 0xb4_92_b6_6f_be_98_f2_73n;
  const k2 = 0x9a_e1_6a_3b_2f_90_40_4fn;
  const k3 = 0xc9_49_d7_c7_50_9e_65_57n;
  const hash16 = (u: bigint, v: bigint): bigint => {
    const multiplier = 0x9d_df_ea_08_eb_38_2d_69n;
    let a = mul(u ^ v, multiplier);
    a ^= a >> 47n;
    let b = mul(v ^ a, multiplier);
    b ^= b >> 47n;
    return mul(b, multiplier);
  };
  const weak32 = (w: bigint, x: bigint, y: bigint, z: bigint, a0: bigint, b0: bigint): [bigint, bigint] => {
    let a = add(a0, w);
    let b = rotate(add(b0, a, z), 21);
    const c = a;
    a = add(a, x, y);
    b = add(b, rotate(a, 44));
    return [add(a, z), add(b, c)];
  };
  const weak32At = (index: number, a: bigint, b: bigint): [bigint, bigint] =>
    weak32(load64(index), load64(index + 8), load64(index + 16), load64(index + 24), a, b);
  const len = BigInt(length);
  if (length <= 16) {
    if (length > 8) {
      const a = load64(0);
      const b = load64(length - 8);
      return hash16(a, rotate(add(b, len), length)) ^ b;
    }
    // libc++'s ABI keeps the shift in 32 bits (it leaves _LIBCPP_ABI_FIX_CITYHASH_IMPLEMENTATION off).
    if (length >= 4) return hash16(add(len, (load32(0) << 3n) & 0xff_ff_ff_ffn), load32(length - 4));
    if (length > 0) {
      const y = byte(0) + (byte(length >> 1) << 8n);
      const z = len + (byte(length - 1) << 2n);
      return mul(shiftMix(mul(y, k2) ^ mul(z, k3)), k2);
    }
    return k2;
  }
  if (length <= 32) {
    const a = mul(load64(0), k1);
    const b = load64(8);
    const c = mul(load64(length - 8), k2);
    const d = mul(load64(length - 16), k0);
    return hash16(add(rotate(sub(a, b), 43), rotate(c, 30), d), add(a, rotate(b ^ k3, 20), sub(len, c)));
  }
  if (length <= 64) {
    let z = load64(24);
    let a = add(load64(0), mul(add(len, load64(length - 16)), k0));
    let b = rotate(add(a, z), 52);
    let c = rotate(a, 37);
    a = add(a, load64(8));
    c = add(c, rotate(a, 7));
    a = add(a, load64(16));
    const vf = add(a, z);
    const vs = add(b, rotate(a, 31), c);
    a = add(load64(16), load64(length - 32));
    z = add(z, load64(length - 8));
    b = rotate(add(a, z), 52);
    c = rotate(a, 37);
    a = add(a, load64(length - 24));
    c = add(c, rotate(a, 7));
    a = add(a, load64(length - 16));
    const wf = add(a, z);
    const ws = add(b, rotate(a, 31), c);
    const r = shiftMix(add(mul(add(vf, ws), k2), mul(add(wf, vs), k0)));
    return mul(shiftMix(add(mul(r, k0), vs)), k2);
  }
  let x = load64(length - 40);
  let y = add(load64(length - 16), load64(length - 56));
  let z = hash16(add(load64(length - 48), len), load64(length - 24));
  let v = weak32At(length - 64, len, z);
  let w = weak32At(length - 32, add(y, k1), x);
  x = add(mul(x, k1), load64(0));
  let remaining = (length - 1) & ~63;
  let at = 0;
  do {
    x = mul(rotate(add(x, y, v[0], load64(at + 8)), 37), k1);
    y = mul(rotate(add(y, v[1], load64(at + 48)), 42), k1);
    x ^= w[1];
    y = add(y, v[0], load64(at + 40));
    z = mul(rotate(add(z, w[0]), 33), k1);
    v = weak32At(at, mul(v[1], k1), add(x, w[0]));
    w = weak32At(at + 32, add(z, w[1]), add(y, load64(at + 16)));
    [z, x] = [x, z];
    at += 64;
    remaining -= 64;
  } while (remaining !== 0);
  return hash16(add(hash16(v[0], w[0]), mul(shiftMix(y), k1), z), add(hash16(v[1], w[1]), x));
}

const mul = (a: bigint, b: bigint): bigint => (a * b) & MASK;

const add = (...values: bigint[]): bigint => values.reduce((sum, value) => (sum + value) & MASK, 0n);

const sub = (a: bigint, b: bigint): bigint => (a - b) & MASK;

const rotate = (value: bigint, shift: number): bigint =>
  shift === 0 ? value : ((value >> BigInt(shift)) | (value << BigInt(64 - shift))) & MASK;

const shiftMix = (value: bigint): bigint => value ^ (value >> 47n);

type KeyHash = (value: Value, frame: Frame) => bigint;

/** The hash a hash function object the program writes, or `std::hash` of a program's class, gives a key. */
function hashWith(compiler: ExpressionCompiler, keyType: Type, hasher: Type): KeyHash {
  if (hasher.kind !== 'class' || hasher.cls.library)
    return compiler.unsupported(0, `ハッシュ関数に ${typeName(hasher)} を使うこと`);
  const call = functionObjectCall(compiler, keyType, hasher.cls, 1);
  return (value, frame) => BigInt.asUintN(64, BigInt(call([value], frame) as number | bigint));
}

function programEquality(compiler: ExpressionCompiler, keyType: Type, cls: ClassInfo): ValueComparison<boolean> {
  const call = functionObjectCall(compiler, keyType, cls, 2);
  return (a, b, frame) => Number(call([a, b], frame)) !== 0;
}

/** `std::hash<T>` of a key, as libc++ computes it for the key types it hashes. */
function hashOf(type: Type): KeyHash | undefined {
  if (type.kind === 'int') return (value) => BigInt.asUintN(64, BigInt(value as number | bigint));
  if (type.kind === 'float') {
    return (value) => {
      const number = value as number;
      if (number === 0) return 0n;
      const view = new DataView(new ArrayBuffer(8));
      if (type.name === 'float') {
        view.setFloat32(0, number, true);
        return BigInt(view.getUint32(0, true));
      }
      view.setFloat64(0, number, true);
      return view.getBigUint64(0, true);
    };
  }
  if (type.kind === 'class' && type.cls.library?.kind === 'string')
    return (value, frame) => {
      const { bytes } = value as StringValue;
      frame.runtime.spend(Math.ceil(bytes.length / 64));
      return hashBytes(bytes);
    };
  if (type.kind === 'pointer') return pointerHasher();
  return undefined;
}

function pointerHasher(): KeyHash {
  const allocations = new WeakMap<Store, bigint>();
  let nextAllocation = 1n;
  return (value) => {
    const { store, index } = (value as Ptr).address;
    let base = 0n;
    if (store) {
      base = allocations.get(store) ?? 0n;
      if (base === 0n) {
        base = nextAllocation++ << 32n;
        allocations.set(store, base);
      }
    }
    const address = base + BigInt(index * 8);
    let bytes = '';
    for (let offset = 0n; offset < 64n; offset += 8n) bytes += String.fromCodePoint(Number((address >> offset) & 255n));
    return hashBytes(bytes);
  };
}

interface HashNode {
  next: HashNode | undefined;
  hash: bigint;
  value: Value;
  owner?: HashValue;
  location?: Ptr;
}

class HashPosition extends Ptr {
  private readonly generation: number | undefined;

  constructor(
    private readonly table: HashValue,
    readonly node: HashNode | undefined,
    private readonly epoch?: { generation: number }
  ) {
    super(undefined, 0);
    this.generation = epoch?.generation;
  }

  override get store(): HashValue {
    if (this.epoch && this.epoch.generation !== this.generation) throw new CppRuntimeError('invalidIterator');
    return this.node?.owner ?? this.table;
  }

  override get index(): number {
    return this.node ? this.store.positionOf(this.entry()) : this.store.length;
  }

  override checkIterator(): void {
    this.store.checkAlive();
    if (this.node && !this.node.owner) throw new CppRuntimeError('invalidIterator');
  }

  override equals(other: Ptr): boolean {
    if (other instanceof HashPosition) return this.store === other.store && this.node === other.node;
    return super.equals(other);
  }

  override offset(delta: number | bigint, asIterator = false): Ptr {
    if (delta === 1 || delta === 1n) return this.store.iterator(this.entry().next);
    return super.offset(delta, asIterator);
  }

  override element(isReverse: boolean): Ptr {
    if (isReverse) return super.element(true);
    return this.store.entryLocation(this.entry());
  }

  override readRaw(): Value {
    return this.entry().value;
  }

  override read(): Value {
    const value = this.readRaw();
    if (value instanceof Store) value.checkAlive();
    return value;
  }

  override write(value: Value): void {
    this.entry().value = value;
  }

  entry(): HashNode {
    this.target();
    if (!this.node?.owner) throw new CppRuntimeError('invalidIterator');
    return this.node;
  }
}

function isPowerOfTwo(count: number): boolean {
  return count > 2 && (count & (count - 1)) === 0;
}

function constrain(hash: bigint, count: number): number {
  const bigCount = BigInt(count);
  if ((count & (count - 1)) === 0) return Number(hash & (bigCount - 1n));
  return Number(hash < bigCount ? hash : hash % bigCount);
}

function nextPrime(frame: Frame, n: number): number {
  for (let candidate = Math.max(n, 2); ; candidate++) {
    checkBucketCount(candidate);
    frame.runtime.spend();
    let isPrime = true;
    for (let divisor = 2; divisor * divisor <= candidate; divisor++) {
      if (candidate % divisor === 0) {
        isPrime = false;
        break;
      }
    }
    if (isPrime) return candidate;
  }
}

function checkBucketCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > LIMITS.maxSlots) throw new ExecutionLimitError('storage');
}

/** The entries of `std::unordered_map` or `std::unordered_set`, in libc++'s `__hash_table` order. */
export class HashValue extends MapValue {
  private readonly head: HashNode = { next: undefined, hash: 0n, value: undefined };
  /** For each bucket, the node before its first node, as libc++ keeps it. */
  private buckets: (HashNode | undefined)[] = [];
  size = 0;
  maxLoadFactor = 1;
  private ordered: HashNode[] | undefined;
  private readonly positions = new Map<HashNode, number>();
  private iteratorEpoch = { generation: 0 };

  constructor(
    readonly hash: KeyHash,
    readonly keyOf: (entry: Value) => Value,
    readonly equal: ValueComparison<boolean>,
    entryType: Type
  ) {
    super(entryType);
  }

  get bucketCount(): number {
    return this.buckets.length;
  }

  get loadFactor(): number {
    return this.bucketCount === 0 ? 0 : Math.fround(this.size / this.bucketCount);
  }

  setMaxLoadFactor(value: number): void {
    if (!(value > 0)) throw new CppRuntimeError('invalidLoadFactor');
    this.maxLoadFactor = Math.max(value, this.loadFactor);
  }

  get length(): number {
    return this.nodes().length;
  }

  iterator(node: HashNode | undefined): Ptr {
    return new HashPosition(this, node, this.iteratorEpoch);
  }

  first(): Ptr {
    return this.iterator(this.head.next);
  }

  override location(index: number): Ptr {
    const node = this.nodes()[index];
    if (!node) throw new CppRuntimeError('invalidIterator');
    return this.entryLocation(node);
  }

  entryLocation(node: HashNode): Ptr {
    const location = (node.location ??= new NodeCell(new HashPosition(this, node), this.entryType).location(0));
    if (node.value instanceof CObject) node.value.bindContainerCell(location);
    return location;
  }

  override iteratorLocation(index: number): Ptr {
    const nodes = this.nodes();
    if (index < 0 || index > nodes.length) throw new CppRuntimeError('invalidIterator');
    return this.iterator(nodes[index]);
  }

  positionOf(node: HashNode): number {
    this.nodes();
    return this.positions.get(node) as number;
  }

  /** The nodes in iteration order, which iterators address by position. */
  nodes(): HashNode[] {
    if (!this.ordered) {
      const nodes: HashNode[] = [];
      this.positions.clear();
      for (let node = this.head.next; node; node = node.next) {
        this.positions.set(node, nodes.length);
        nodes.push(node);
      }
      this.ordered = nodes;
    }
    return this.ordered;
  }

  get(index: number): Value {
    this.checkAlive();
    const node = this.nodes()[index];
    if (!node) throw new CppRuntimeError('invalidIterator');
    return node.value;
  }

  set(index: number, value: Value): void {
    const node = this.nodes()[index];
    if (!node) throw new CppRuntimeError('invalidIterator');
    node.value = value;
  }

  *children(): Iterable<Value> {
    for (let node = this.head.next; node; node = node.next) yield node.value;
  }

  findNode(frame: Frame, key: Value): HashNode | undefined {
    // libc++ can link copied nodes before it updates size. Lookup and iteration then see different state.
    return this.size === 0 ? undefined : this.lookup(frame, key);
  }

  lookup(frame: Frame, key: Value): HashNode | undefined {
    const hash = this.hash(key, frame);
    const count = this.buckets.length;
    if (count === 0) return;
    const index = constrain(hash, count);
    let node = this.buckets[index]?.next;
    for (; node && (node.hash === hash || constrain(node.hash, count) === index); node = node.next) {
      frame.runtime.spend();
      if (node.hash === hash && this.equal(this.keyOf(node.value), key, frame)) return node;
    }
  }

  /** Inserts an entry as `__emplace_unique_key_args` does, giving its position and whether it was inserted. */
  insert(frame: Frame, entry: Value): [HashNode, boolean] {
    const key = this.keyOf(entry);
    const existing = this.lookup(frame, key);
    if (existing) return [existing, false];
    frame.runtime.reserve(3);
    const hash = this.hash(key, frame);
    let count = this.buckets.length;
    if (this.size + 1 > count * this.maxLoadFactor || count === 0) {
      this.rehash(
        frame,
        Math.max(
          2 * count + (isPowerOfTwo(count) ? 0 : 1),
          Math.ceil(Math.fround((this.size + 1) / this.maxLoadFactor))
        )
      );
      count = this.buckets.length;
    }
    const index = constrain(hash, count);
    const node: HashNode = { next: undefined, hash, value: entry, owner: this };
    const before = this.buckets[index];
    if (before) {
      node.next = before.next;
      before.next = node;
    } else {
      node.next = this.head.next;
      this.head.next = node;
      this.buckets[index] = this.head;
      if (node.next) this.buckets[constrain(node.next.hash, count)] = node;
    }
    this.size++;
    this.invalidateOrder(frame);
    return [node, true];
  }

  /** Drops the cached iteration order, charging the rebuild that a later positional access makes of it. */
  private invalidateOrder(frame: Frame): void {
    if (this.ordered) frame.runtime.spend(Math.ceil(this.ordered.length / 64));
    this.ordered = undefined;
  }

  /** Removes the node at a position, as `erase(iterator)` does. */
  remove(frame: Frame, node: HashNode): Value {
    return this.unlink(frame, node, this.beforeNode(frame, node));
  }

  eraseRange(
    frame: Frame,
    first: HashNode | undefined,
    last: HashNode | undefined,
    destroy: ElementOperations['destroy']
  ): Ptr {
    for (let node = first; node !== last; node = node.next) {
      if (!node) throw new CppRuntimeError('invalidRange');
      frame.runtime.spend();
    }
    if (first && first !== last) {
      const before = this.beforeNode(frame, first);
      for (let node: HashNode | undefined = first; node && node !== last;) {
        const next: HashNode | undefined = node.next;
        destroy?.(frame, node.value);
        this.unlink(frame, node, before);
        node = next;
      }
    }
    return this.iterator(last);
  }

  private beforeNode(frame: Frame, node: HashNode): HashNode {
    let before = this.buckets[constrain(node.hash, this.buckets.length)] as HashNode;
    while (before.next !== node) {
      frame.runtime.spend();
      before = before.next as HashNode;
    }
    return before;
  }

  private unlink(frame: Frame, node: HashNode, before: HashNode): Value {
    const count = this.buckets.length;
    const index = constrain(node.hash, count);
    // The bucket loses its "before" pointer when the node was its only one.
    const next = node.next;
    if (
      (before === this.head || constrain(before.hash, count) !== index) &&
      (!next || constrain(next.hash, count) !== index)
    )
      this.buckets[index] = undefined;
    if (next) {
      const nextIndex = constrain(next.hash, count);
      if (nextIndex !== index) this.buckets[nextIndex] = before;
    }
    before.next = next;
    node.owner = undefined;
    this.size--;
    this.invalidateOrder(frame);
    return node.value;
  }

  copyStructure(
    frame: Frame,
    other: HashValue,
    entry: (source: Value, existing: HashNode | undefined, index: number) => Value,
    destroy?: ElementOperations['destroy']
  ): void {
    this.maxLoadFactor = other.maxLoadFactor;
    if (other.size === 0) {
      destroyElements(frame, this.clear(frame), destroy);
      return;
    }
    const count = other.bucketCount;
    frame.runtime.reserve(count + 3 * Math.max(0, other.nodes().length - this.nodes().length));
    this.buckets = Array.from({ length: count });
    let own = this.head;
    let current = -1;
    for (const [index, source] of other.nodes().entries()) {
      const existing = own.next;
      const value = entry(source.value, existing, index);
      const copy: HashNode = existing ?? { next: undefined, hash: source.hash, value, owner: this };
      copy.hash = source.hash;
      copy.value = value;
      const bucket = constrain(source.hash, count);
      if (bucket !== current) {
        this.buckets[bucket] = own;
        current = bucket;
      }
      own.next = copy;
      own = copy;
      this.ordered = undefined;
    }
    const discarded: Value[] = [];
    for (let node = own.next; node; node = node.next) {
      node.owner = undefined;
      discarded.push(node.value);
    }
    own.next = undefined;
    this.ordered = undefined;
    destroyElements(frame, discarded, destroy);
    this.size = other.size;
  }

  swap(frame: Frame, other: HashValue): void {
    // Rewriting each node's owner and each bucket head is bookkeeping, charged per 64 like other bookkeeping.
    frame.runtime.spend(Math.ceil((this.size + other.size + this.buckets.length + other.buckets.length) / 64));
    const headsOf = (value: HashValue): number[] =>
      value.buckets.flatMap((before, index) => (before === value.head ? [index] : []));
    const ownHeads = headsOf(this);
    const otherHeads = headsOf(other);
    [this.iteratorEpoch, other.iteratorEpoch] = [other.iteratorEpoch, this.iteratorEpoch];
    const next = this.head.next;
    this.head.next = other.head.next;
    other.head.next = next;
    for (let node = this.head.next; node; node = node.next) node.owner = this;
    for (let node = other.head.next; node; node = node.next) node.owner = other;
    [this.buckets, other.buckets] = [other.buckets, this.buckets];
    for (const index of ownHeads) other.buckets[index] = other.head;
    for (const index of otherHeads) this.buckets[index] = this.head;
    [this.size, other.size] = [other.size, this.size];
    [this.maxLoadFactor, other.maxLoadFactor] = [other.maxLoadFactor, this.maxLoadFactor];
    this.ordered = undefined;
    other.ordered = undefined;
  }

  clear(frame: Frame): Value[] {
    // libc++ skips clear when interrupted assignment left size zero, but its destructor walks the linked nodes.
    if (this.size === 0) return [];
    frame.runtime.spend(Math.ceil((this.buckets.length + this.size) / 64));
    const values = this.nodes().map((node) => {
      node.owner = undefined;
      return node.value;
    });
    this.head.next = undefined;
    this.buckets.fill(undefined);
    this.size = 0;
    this.ordered = undefined;
    return values;
  }

  /** `__rehash_unique`: grows (or shrinks) to the requested bucket count, rounded up to a prime. */
  rehash(frame: Frame, requested: number): void {
    checkBucketCount(requested);
    let n = requested;
    if (n === 1) n = 2;
    else if (!isPowerOfTwo(n) && n !== 0) n = nextPrime(frame, n);
    const count = this.buckets.length;
    if (n > count) this.redistribute(frame, n);
    else if (n < count) {
      const needed = Math.ceil(Math.fround(this.size / this.maxLoadFactor));
      const rounded =
        needed === 0 ? 0 : isPowerOfTwo(count) ? 2 ** Math.ceil(Math.log2(needed)) : nextPrime(frame, needed);
      n = Math.max(n, rounded);
      if (n < count) this.redistribute(frame, n);
    }
  }

  /** `__do_rehash<true>`, which keeps each bucket's nodes together in the list. */
  private redistribute(frame: Frame, count: number): void {
    checkBucketCount(count);
    frame.runtime.reserve(count);
    frame.runtime.spend(this.size);
    this.iteratorEpoch.generation++;
    const buckets: (HashNode | undefined)[] = Array.from({ length: count });
    this.buckets = buckets;
    if (count === 0) return;
    let previous: HashNode = this.head;
    let current = previous.next;
    if (!current) return;
    let previousIndex = constrain(current.hash, count);
    buckets[previousIndex] = previous;
    for (previous = current, current = current.next; current; current = previous.next) {
      const index = constrain(current.hash, count);
      if (index === previousIndex) previous = current;
      else if (buckets[index] === undefined) {
        buckets[index] = previous;
        previous = current;
        previousIndex = index;
      } else {
        previous.next = current.next;
        const bucketBefore = buckets[index] as HashNode;
        current.next = bucketBefore.next;
        bucketBefore.next = current;
      }
    }
    this.ordered = undefined;
  }
}

/** `std::unordered_map<K, V>` or `std::unordered_set<K>`. */
// code-gauge-allow functionNcss -- The members of the unordered containers, which share their storage.
export function unorderedClass(
  library: Library,
  kind: 'unordered_map' | 'unordered_set',
  keyType: Type,
  valueType: Type | undefined,
  hasher?: Type,
  keyEqual?: Type
): ClassInfo {
  const args = [
    keyType,
    ...(valueType ? [valueType] : []),
    ...(hasher ? [hasher] : []),
    ...(keyEqual ? [keyEqual] : []),
  ];
  const name = `std::${kind}<${args.map((arg) => typeName(arg)).join(', ')}>`;
  const key = `${kind}<${args.map((arg) => typeKey(arg)).join(',')}>`;
  const cached = library.instances.get(key);
  if (cached) return cached;
  const cls = new ClassInfo(name, 'class');
  library.instances.set(key, cls);
  cls.isComplete = true;
  const compiler = library.compiler;
  const plainKey = unqualified(keyType);
  const hash = hasher
    ? hashWith(compiler, plainKey, hasher)
    : (hashOf(plainKey) ?? hashWith(compiler, plainKey, compiler.stdHash(plainKey)));
  const equal =
    keyEqual?.kind === 'class' && !keyEqual.cls.library
      ? programEquality(compiler, plainKey, keyEqual.cls)
      : equalTo(plainKey);
  if (!equal)
    return compiler.unsupported(0, `${typeName(keyType)} をキーにした ${`std::${kind}`}（== で比べられない型）`);
  const isMap = valueType !== undefined;
  const entryType: Type = isMap ? classType(pairClass(library, withConst(keyType), valueType)) : keyType;
  const elementType: Type = isMap ? entryType : withConst(keyType);
  const representation = { family: kind, category: 'forward', typeArguments: args, constOnly: !isMap } as const;
  const constIterator = classType(
    randomAccessIterator(library.iterators, name, elementType, true, false, representation)
  );
  const iterator = isMap
    ? classType(randomAccessIterator(library.iterators, name, elementType, false, false, representation))
    : constIterator;
  cls.memberTypes.set('iterator', iterator);
  cls.memberTypes.set('const_iterator', constIterator);
  cls.memberTypes.set('key_type', keyType);
  cls.memberTypes.set('value_type', entryType);
  cls.memberTypes.set('size_type', SIZE_T);
  if (valueType) cls.memberTypes.set('mapped_type', valueType);
  let entryOps: ElementOperations | undefined;
  const ops = (): ElementOperations => {
    entryOps ??= elementOperations(compiler, unqualified(entryType), 0);
    return entryOps;
  };
  const keyOf = isMap ? (entry: Value): Value => (entry as CObject).values[0] : (entry: Value): Value => entry;
  const make = (): HashValue => new HashValue(hash, keyOf, equal, entryType);
  const destroyAll = (frame: Frame, entries: Value[]): void => {
    destroyElements(frame, entries, ops().destroy);
  };
  const insertResult = pairClass(library, iterator, BOOL);
  const table: EntryTable<HashValue, HashNode> = {
    make,
    keyOf,
    lookup: (frame, self, key) => self.lookup(frame, key),
    insert: (frame, self, entry) => self.insert(frame, entry),
    ops,
  };
  const insertionResult = (frame: Frame, self: HashValue, node: HashNode, inserted: boolean): Value =>
    pairResult(frame, insertResult, self.iterator(node), inserted ? 1 : 0);
  cls.library = {
    kind,
    args,
    size: 40,
    align: 8,
    listElementType: unqualified(entryType),
    listInitializer: (compiler_, elements, row) =>
      associativeInitializerList(compiler_, cls, entryType, elements, row, table),
    operator: (compiler_, operator, operands, row) => {
      const [left, right] = operands;
      if (
        (operator === '==' || operator === '!=') &&
        left.type.kind === 'class' &&
        left.type.cls === cls &&
        right?.type.kind === 'class' &&
        right.type.cls === cls
      ) {
        const valuesEqual = valueType ? equalTo(valueType) : undefined;
        if (valueType && !valuesEqual) return compiler_.error(row, `${typeName(valueType)} は == で比べられません。`);
        return {
          type: BOOL,
          isLvalue: false,
          row,
          run: compiler_.compareObjects(left, right, (a, b, frame) => {
            const first = a as HashValue;
            const second = b as HashValue;
            const same =
              first.size === second.size &&
              first.nodes().every((node) => {
                frame.runtime.spend();
                const found = second.findNode(frame, keyOf(node.value));
                return (
                  found !== undefined &&
                  (!valuesEqual ||
                    valuesEqual((node.value as CObject).values[1], (found.value as CObject).values[1], frame))
                );
              });
            return same === (operator === '==');
          }),
        };
      }
      if (operator !== '[]' || !isMap || left.type.kind !== 'class' || left.type.cls !== cls) return;
      if (isConstType(left.type))
        return compiler_.error(row, `const の ${cls.name} には [] を使えません（at を使ってください）。`);
      const keyRun = compiler_.convert(right, constRef(keyType), row).run;
      const keyOps = elementOperations(compiler, unqualified(keyType), row);
      const mappedOps = elementOperations(compiler, valueType as Type, row);
      if (!mappedOps.isDefaultConstructible) return mappedNotDefaultConstructible(compiler_, valueType as Type, row);
      requireDefaultConstruction(compiler_, valueType as Type, row);
      compiler_.requireLibraryObjectUse(keyType, 'copy', row);
      return {
        type: valueType as Type,
        isLvalue: true,
        row,
        run: compiler_.subscriptObject(left, keyRun, (frame, receiver, key) => {
          const self = receiver as HashValue;
          const keyValue = (key as Ptr).read();
          let node = self.lookup(frame, keyValue);
          if (!node) {
            [node] = self.insert(
              frame,
              constructPair(
                frame,
                (entryType as Extract<Type, { kind: 'class' }>).cls,
                [(f, target) => keyOps.copy(f, keyValue, target), (f, target) => mappedOps.make(f, target)],
                (index) => (index === 0 ? keyOps.destroy : mappedOps.destroy)
              )
            );
          }
          return new Ptr(node.value as CObject, 1);
        }),
      };
    },
    memberCall: (compiler_, object, member, callArgs, row) =>
      emplacementCall(compiler_, object, member, callArgs, row, {
        types: { keyType, entryType, valueType },
        table,
        resultType: classType(insertResult),
        isTemporaryObject: true,
        result: insertionResult,
      }),
    constructingMembers: isMap ? ['emplace', 'try_emplace'] : ['emplace'],
    ownedTypes: [entryType],
    inlineElementType: entryType,
    elementUseOnAssignment: 'copy',
  };
  cls.operations = {
    copy: (frame, source) => {
      const from = source as HashValue;
      const target = make();
      // Apple libc++ skips entry destructors when hash-table copy construction throws.
      const values = copyEntries(
        frame,
        from.nodes().map((node) => node.value),
        ops(),
        'release'
      );
      target.copyStructure(frame, from, (_source, _existing, index) => values[index]);
      return target;
    },
    assign: (frame, target, source) => {
      const to = target as HashValue;
      const from = source as HashValue;
      if (to === from) return;
      const { assign, copy, destroy } = ops();
      to.copyStructure(
        frame,
        from,
        (value, existing) => (existing ? assign(frame, existing.value, value) : copy(frame, value)),
        destroy
      );
    },
    destroy: (frame, value) =>
      destroyAll(
        frame,
        (value as HashValue).nodes().map((node) => node.value)
      ),
  };
  cls.constructors = [nativeConstructor(cls, [], () => make())];
  addRangeMembers(compiler, cls, entryType, table);
  const method = (
    memberName: string,
    params: Type[],
    ret: Type,
    run: (self: HashValue, callArgs: unknown[], frame: Frame) => unknown,
    isConst = false
  ): void => {
    addMethod(
      cls,
      native(memberName, params, ret, (callArgs, { self, frame }) => run(self as HashValue, callArgs, frame), {
        isConst,
      })
    );
  };
  method('size', [], SIZE_T, (self) => BigInt(self.size), true);
  method('empty', [], BOOL, (self) => (self.size === 0 ? 1 : 0), true);
  method('bucket_count', [], SIZE_T, (self) => BigInt(self.bucketCount), true);
  method('load_factor', [], FLOAT, (self) => self.loadFactor, true);
  method('max_load_factor', [], FLOAT, (self) => self.maxLoadFactor, true);
  method('max_load_factor', [FLOAT], VOID, (self, [value]) => self.setMaxLoadFactor(value as number));
  method('rehash', [SIZE_T], VOID, (self, [count], frame) => self.rehash(frame, Number(count)));
  method('reserve', [SIZE_T], VOID, (self, [count], frame) =>
    self.rehash(frame, Math.ceil(Math.fround(Number(count) / self.maxLoadFactor)))
  );
  method('clear', [], VOID, (self, _callArgs, frame) => destroyAll(frame, self.clear(frame)));
  for (const isConst of [false, true]) {
    const it = isConst ? constIterator : iterator;
    method('begin', [], it, (self) => self.first(), isConst);
    method('end', [], it, (self) => self.iterator(undefined), isConst);
    method(
      'find',
      [constRef(keyType)],
      it,
      (self, [k], frame) => self.iterator(self.findNode(frame, keyArg(k))),
      isConst
    );
    if (isMap) {
      method(
        'at',
        [constRef(keyType)],
        referenceTo(isConst ? withConst(valueType as Type) : (valueType as Type)),
        (self, [k], frame) => {
          const node = self.findNode(frame, keyArg(k));
          if (!node) return throwLibrary(frame, library.exception('out_of_range'), 'unordered_map::at: key not found');
          return new Ptr(node.value as CObject, 1);
        },
        isConst
      );
    }
  }
  method('cbegin', [], constIterator, (self) => self.first(), true);
  method('cend', [], constIterator, (self) => self.iterator(undefined), true);
  method('count', [constRef(keyType)], SIZE_T, (self, [k], frame) => (self.findNode(frame, keyArg(k)) ? 1n : 0n), true);
  method('contains', [constRef(keyType)], BOOL, (self, [k], frame) => (self.findNode(frame, keyArg(k)) ? 1 : 0), true);
  const copyEntry = { uses: (row: number) => requireElementUse(compiler, entryType, row, 'copy') };
  const entryParameter = constRef(unqualified(entryType));
  addMethod(
    cls,
    native(
      'insert',
      [entryParameter],
      classType(insertResult),
      ([entry], { self, frame }) => {
        const hash = self as HashValue;
        return insertionResult(frame, hash, ...insertCopy(table, frame, hash, (entry as Ptr).read()));
      },
      copyEntry
    )
  );
  addMethod(
    cls,
    native(
      'insert',
      [constIterator, entryParameter],
      iterator,
      ([hint, entry], { self, frame }) => {
        const hash = self as HashValue;
        hashPosition(hash, hint);
        const [node] = insertCopy(table, frame, hash, (entry as Ptr).read());
        return hash.iterator(node);
      },
      copyEntry
    )
  );
  method('erase', [constRef(keyType)], SIZE_T, (self, [k], frame) => {
    const node = self.findNode(frame, keyArg(k));
    if (!node) return 0n;
    const removed = self.remove(frame, node);
    ops().destroy?.(frame, removed);
    return 1n;
  });
  method('erase', [constIterator], iterator, (self, [position], frame) => {
    const node = hashPosition(self, position).entry();
    const next = node.next;
    const removed = self.remove(frame, node);
    ops().destroy?.(frame, removed);
    return self.iterator(next);
  });
  method('erase', [constIterator, constIterator], iterator, (self, [first, last], frame) =>
    self.eraseRange(frame, hashPosition(self, first).node, hashPosition(self, last).node, ops().destroy)
  );
  method('swap', [referenceTo(classType(cls))], VOID, (self, [other], frame) =>
    self.swap(frame, (other as Ptr).read() as HashValue)
  );
  return cls;
}

function hashPosition(self: HashValue, position: unknown): HashPosition {
  if (!(position instanceof HashPosition) || position.store !== self) throw new CppRuntimeError('invalidIterator');
  position.checkIterator();
  return position;
}

const keyArg = (arg: unknown): Value => (arg as Ptr).read();

/** The natives `std::hash` computes libc++'s hashes of floating-point numbers and of strings with. */
export function hashFunctions(): Map<string, FunctionInfo[]> {
  const hashFloat = hashOf(FLOAT) as KeyHash;
  const hashDouble = hashOf(DOUBLE) as KeyHash;
  return new Map([
    [
      '__builtin_hash_float',
      [native('__builtin_hash_float', [FLOAT], SIZE_T, ([value], { frame }) => hashFloat(value as Value, frame))],
    ],
    [
      '__builtin_hash_double',
      [native('__builtin_hash_double', [DOUBLE], SIZE_T, ([value], { frame }) => hashDouble(value as Value, frame))],
    ],
    [
      '__builtin_hash_bytes',
      [
        native('__builtin_hash_bytes', [CONST_CHAR_PTR, SIZE_T], SIZE_T, ([pointer, size], { frame }) => {
          const { store, index } = pointer as Ptr;
          let bytes = '';
          for (let offset = 0; offset < Number(size); offset++) {
            bytes += String.fromCodePoint(((store as Store).get(index + offset) as number) & 0xff);
          }
          frame.runtime.spend(Math.ceil(bytes.length / 64));
          return hashBytes(bytes);
        }),
      ],
    ],
  ]);
}
