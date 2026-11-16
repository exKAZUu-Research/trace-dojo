import type { DisplayNode } from '../../problems/trace';
import { byteAt } from '../bytes';
import { CppRuntimeError } from '../errors';
import type { Frame } from '../runtime';
import {
  BOOL,
  ClassInfo,
  classType,
  FLOAT,
  isConstType,
  referenceTo,
  SIZE_T,
  type Type,
  typeName,
  unqualified,
  VOID,
  withConst,
} from '../types';
import { CObject, Ptr, type Value } from '../values';
import { keyText, pairClass } from './associative';
import { MapValue } from './containerValues';
import { type ElementOperations, elementOperations, equalTo } from './elements';
import { addRangeMembers, emplacementCall, type EntryTable, insertCopy } from './emplacement';
import { randomAccessIterator } from './iterators';
import type { Library } from './registry';
import type { StringValue } from './string';
import { addMethod, constRef, native, nativeConstructor, throwLibrary } from './support';
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

/** `std::hash<T>` of a key, as libc++ computes it for the key types it hashes. */
function hashOf(type: Type): ((value: Value) => bigint) | undefined {
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
    return (value) => hashBytes((value as StringValue).bytes);
  return undefined;
}

interface HashNode {
  next: HashNode | undefined;
  hash: bigint;
  value: Value;
}

function isPowerOfTwo(count: number): boolean {
  return count > 2 && (count & (count - 1)) === 0;
}

function constrain(hash: bigint, count: number): number {
  const bigCount = BigInt(count);
  if ((count & (count - 1)) === 0) return Number(hash & (bigCount - 1n));
  return Number(hash < bigCount ? hash : hash % bigCount);
}

function nextPrime(n: number): number {
  for (let candidate = Math.max(n, 2); ; candidate++) {
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

/** The entries of `std::unordered_map` or `std::unordered_set`, in libc++'s `__hash_table` order. */
export class HashValue extends MapValue {
  private readonly head: HashNode = { next: undefined, hash: 0n, value: undefined };
  /** For each bucket, the node before its first node, as libc++ keeps it. */
  private buckets: (HashNode | undefined)[] = [];
  size = 0;
  maxLoadFactor = 1;
  private ordered: HashNode[] | undefined;

  constructor(
    readonly hash: (value: Value) => bigint,
    readonly keyOf: (entry: Value) => Value,
    readonly equal: (a: Value, b: Value) => boolean,
    readonly isMap: boolean,
    readonly keyType: Type,
    readonly valueType: Type | undefined
  ) {
    super();
  }

  get bucketCount(): number {
    return this.buckets.length;
  }

  get length(): number {
    return this.size;
  }

  /** The nodes in iteration order, which iterators address by position. */
  nodes(): HashNode[] {
    if (!this.ordered) {
      const nodes: HashNode[] = [];
      for (let node = this.head.next; node; node = node.next) nodes.push(node);
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

  children(): Iterable<Value> {
    return this.nodes().map((node) => node.value);
  }

  find(key: Value): number {
    const hash = this.hash(key);
    const count = this.buckets.length;
    if (count === 0) return -1;
    const index = constrain(hash, count);
    let node = this.buckets[index]?.next;
    for (; node && (node.hash === hash || constrain(node.hash, count) === index); node = node.next) {
      if (node.hash === hash && this.equal(this.keyOf(node.value), key)) return this.nodes().indexOf(node);
    }
    return -1;
  }

  /** Inserts an entry as `__emplace_unique_key_args` does, giving its position and whether it was inserted. */
  insert(entry: Value): [number, boolean] {
    const key = this.keyOf(entry);
    const existing = this.find(key);
    if (existing >= 0) return [existing, false];
    const hash = this.hash(key);
    let count = this.buckets.length;
    if (this.size + 1 > count * this.maxLoadFactor || count === 0) {
      this.rehash(
        Math.max(
          2 * count + (isPowerOfTwo(count) ? 0 : 1),
          Math.ceil(Math.fround((this.size + 1) / this.maxLoadFactor))
        )
      );
      count = this.buckets.length;
    }
    const index = constrain(hash, count);
    const node: HashNode = { next: undefined, hash, value: entry };
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
    this.ordered = undefined;
    return [this.nodes().indexOf(node), true];
  }

  /** Removes the node at a position, as `erase(iterator)` does. */
  removeAt(position: number): Value {
    const node = this.nodes()[position];
    const count = this.buckets.length;
    const index = constrain(node.hash, count);
    let before = this.buckets[index] as HashNode;
    while (before.next !== node) before = before.next as HashNode;
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
    this.size--;
    this.ordered = undefined;
    return node.value;
  }

  /**
   * Becomes a copy of another table holding `values` in place of its nodes' values: the same bucket count and the same
   * order, as libc++'s copy constructor and copy assignment make.
   */
  copyStructure(other: HashValue, values: Value[]): void {
    const count = other.size === 0 ? 0 : other.bucketCount;
    this.maxLoadFactor = other.maxLoadFactor;
    this.buckets = Array.from({ length: count });
    this.head.next = undefined;
    let own = this.head;
    let current = -1;
    for (const [index, node] of other.nodes().entries()) {
      const copy: HashNode = { next: undefined, hash: node.hash, value: values[index] };
      const bucket = constrain(node.hash, count);
      if (bucket !== current) {
        this.buckets[bucket] = own;
        current = bucket;
      }
      own.next = copy;
      own = copy;
    }
    this.size = other.size;
    this.ordered = undefined;
  }

  swap(other: HashValue): void {
    const headsOf = (value: HashValue): number[] =>
      value.buckets.flatMap((before, index) => (before === value.head ? [index] : []));
    const ownHeads = headsOf(this);
    const otherHeads = headsOf(other);
    const next = this.head.next;
    this.head.next = other.head.next;
    other.head.next = next;
    [this.buckets, other.buckets] = [other.buckets, this.buckets];
    for (const index of ownHeads) other.buckets[index] = other.head;
    for (const index of otherHeads) this.buckets[index] = this.head;
    [this.size, other.size] = [other.size, this.size];
    [this.maxLoadFactor, other.maxLoadFactor] = [other.maxLoadFactor, this.maxLoadFactor];
    this.ordered = undefined;
    other.ordered = undefined;
  }

  clear(): Value[] {
    const values = this.nodes().map((node) => node.value);
    this.head.next = undefined;
    this.buckets = Array.from<HashNode | undefined>({ length: this.buckets.length });
    this.size = 0;
    this.ordered = undefined;
    return values;
  }

  /** `__rehash_unique`: grows (or shrinks) to the requested bucket count, rounded up to a prime. */
  rehash(requested: number): void {
    let n = requested;
    if (n === 1) n = 2;
    else if ((n & (n - 1)) !== 0) n = nextPrime(n);
    const count = this.buckets.length;
    if (n > count) this.redistribute(n);
    else if (n < count) {
      const needed = Math.ceil(Math.fround(this.size / this.maxLoadFactor));
      n = Math.max(
        n,
        isPowerOfTwo(count) ? (needed < 2 ? needed : 2 ** Math.ceil(Math.log2(needed))) : nextPrime(needed)
      );
      if (n < count) this.redistribute(n);
    }
  }

  /** `__do_rehash<true>`, which keeps each bucket's nodes together in the list. */
  private redistribute(count: number): void {
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

  displayNode(nodeOf: (value: Value, type: Type) => DisplayNode): DisplayNode {
    const values = this.nodes().map((node) => node.value);
    if (!this.isMap) {
      const entries: Record<string, DisplayNode> = {};
      for (const [index, value] of values.entries()) entries[index] = nodeOf(value, this.keyType);
      return { kind: 'array', entries };
    }
    const entries: Record<string, DisplayNode> = {};
    for (const value of values) {
      const [key, mapped] = (value as CObject).values;
      entries[keyText(key, this.keyType)] = nodeOf(mapped, this.valueType as Type);
    }
    return { kind: 'object', entries };
  }
}

/** `std::unordered_map<K, V>` or `std::unordered_set<K>`. */
// code-gauge-allow functionNcss 120 -- The members of the unordered containers, which share their storage.
export function unorderedClass(
  library: Library,
  kind: 'unordered_map' | 'unordered_set',
  keyType: Type,
  valueType: Type | undefined
): ClassInfo {
  const args = valueType ? [keyType, valueType] : [keyType];
  const name = `std::${kind}<${args.map((arg) => typeName(arg)).join(', ')}>`;
  const key = `${kind}<${args.map((arg) => typeKey(arg)).join(',')}>`;
  const cached = library.instances.get(key);
  if (cached) return cached;
  const cls = new ClassInfo(name, 'class');
  library.instances.set(key, cls);
  cls.isComplete = true;
  const compiler = library.compiler;
  const hash = hashOf(unqualified(keyType));
  const equal = equalTo(unqualified(keyType));
  if (!hash || !equal)
    return compiler.unsupported(0, `${typeName(keyType)} をキーにした ${`std::${kind}`}（std::hash がない型）`);
  const isMap = valueType !== undefined;
  const entryType: Type = isMap ? classType(pairClass(library, withConst(keyType), valueType)) : keyType;
  const elementType: Type = isMap ? entryType : withConst(keyType);
  const iterator = classType(randomAccessIterator(library.iterators, name, elementType, false, false, true));
  const constIterator = classType(randomAccessIterator(library.iterators, name, elementType, true, false, true));
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
  const make = (): HashValue => new HashValue(hash, keyOf, equal, isMap, keyType, valueType);
  const destroyAll = (frame: Frame, entries: Value[]): void => {
    const destroy = ops().destroy;
    if (destroy) for (const entry of entries) destroy(frame, entry);
  };
  const insertResult = pairClass(library, iterator, BOOL);
  const table: EntryTable<HashValue> = {
    keyOf,
    lookup: (self, key) => self.find(key),
    insert: (frame, self, entry) => {
      frame.runtime.reserve(3);
      return self.insert(entry);
    },
    ops,
  };
  const insertionResult = (self: HashValue, at: number, inserted: boolean): Value =>
    new CObject(insertResult, [new Ptr(self, at), inserted ? 1 : 0]);
  cls.library = {
    kind,
    args,
    size: 40,
    align: 8,
    listInitializer: (compiler_, elements) => {
      const inits = elements.map((node) => compiler_.elementInitializer(unqualified(entryType), node));
      return (frame) => {
        const self = make();
        frame.pending.push(self);
        try {
          for (const init of inits) {
            const entry = init(frame);
            const [, inserted] = self.insert(entry);
            if (!inserted) ops().destroy?.(frame, entry);
          }
        } finally {
          frame.pending.pop();
        }
        return self;
      };
    },
    operator: (compiler_, operator, operands, row) => {
      const [left, right] = operands;
      if (operator !== '[]' || !isMap || left.type.kind !== 'class' || left.type.cls !== cls) return;
      if (isConstType(left.type))
        return compiler_.error(row, `const の ${cls.name} には [] を使えません（at を使ってください）。`);
      const keyRun = compiler_.convert(right, constRef(keyType), row).run;
      const object = left.isLvalue ? left.run : compiler_.materialize(left).run;
      const keyOps = elementOperations(compiler, unqualified(keyType), row);
      const mappedOps = elementOperations(compiler, valueType as Type, row);
      return {
        type: valueType as Type,
        isLvalue: true,
        row,
        run: (frame) => {
          const self = (object(frame) as Ptr).read() as HashValue;
          const keyValue = (keyRun(frame) as Ptr).read();
          let at = self.find(keyValue);
          if (at < 0) {
            frame.runtime.reserve(3);
            [at] = self.insert(
              new CObject((entryType as Extract<Type, { kind: 'class' }>).cls, [
                keyOps.copy(frame, keyValue),
                mappedOps.make(frame),
              ])
            );
          }
          return new Ptr(self.get(at) as CObject, 1);
        },
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
  };
  cls.operations = {
    copy: (frame, source) => {
      const from = source as HashValue;
      const target = make();
      target.copyStructure(
        from,
        from.nodes().map((node) => ops().copy(frame, node.value))
      );
      return target;
    },
    assign: (frame, target, source) => {
      const to = target as HashValue;
      const from = source as HashValue;
      if (to === from) return;
      to.maxLoadFactor = from.maxLoadFactor;
      if (from.size === 0) {
        destroyAll(frame, to.clear());
        return;
      }
      // Copy assignment assigns to the nodes it has, in order, and destroys or adds the rest.
      const own = to.nodes().map((node) => node.value);
      const others = from.nodes().map((node) => node.value);
      const reused = Math.min(own.length, others.length);
      const values = others.slice(0, reused).map((value, index) => ops().assign(frame, own[index], value));
      destroyAll(frame, own.slice(reused));
      for (const value of others.slice(reused)) values.push(ops().copy(frame, value));
      to.copyStructure(from, values);
    },
    destroy: (frame, value) =>
      destroyAll(
        frame,
        (value as HashValue).nodes().map((node) => node.value)
      ),
  };
  cls.constructors = [nativeConstructor(cls, [], () => make())];
  addRangeMembers(compiler, cls, entryType, table, make);
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
  method(
    'load_factor',
    [],
    FLOAT,
    (self) => (self.bucketCount === 0 ? 0 : Math.fround(self.size / self.bucketCount)),
    true
  );
  method('max_load_factor', [], FLOAT, (self) => self.maxLoadFactor, true);
  method('rehash', [SIZE_T], VOID, (self, [count]) => self.rehash(Number(count)));
  method('reserve', [SIZE_T], VOID, (self, [count]) =>
    self.rehash(Math.ceil(Math.fround(Number(count) / self.maxLoadFactor)))
  );
  method('clear', [], VOID, (self, _callArgs, frame) => destroyAll(frame, self.clear()));
  for (const isConst of [false, true]) {
    const it = isConst ? constIterator : iterator;
    method('begin', [], it, (self) => new Ptr(self, 0), isConst);
    method('end', [], it, (self) => new Ptr(self, self.size), isConst);
    method(
      'find',
      [constRef(keyType)],
      it,
      (self, [k]) => {
        const at = self.find(keyArg(k));
        return new Ptr(self, at < 0 ? self.size : at);
      },
      isConst
    );
    if (isMap) {
      method(
        'at',
        [constRef(keyType)],
        referenceTo(isConst ? withConst(valueType as Type) : (valueType as Type)),
        (self, [k], frame) => {
          const at = self.find(keyArg(k));
          if (at < 0) return throwLibrary(frame, library.exception('out_of_range'), 'unordered_map::at: key not found');
          return new Ptr(self.get(at) as CObject, 1);
        },
        isConst
      );
    }
  }
  method('cbegin', [], constIterator, (self) => new Ptr(self, 0), true);
  method('cend', [], constIterator, (self) => new Ptr(self, self.size), true);
  method('count', [constRef(keyType)], SIZE_T, (self, [k]) => (self.find(keyArg(k)) >= 0 ? 1n : 0n), true);
  method('contains', [constRef(keyType)], BOOL, (self, [k]) => (self.find(keyArg(k)) >= 0 ? 1 : 0), true);
  method('insert', [constRef(unqualified(entryType))], classType(insertResult), (self, [entry], frame) =>
    insertionResult(self, ...insertCopy(table, frame, self, (entry as Ptr).read()))
  );
  method('erase', [constRef(keyType)], SIZE_T, (self, [k], frame) => {
    const at = self.find(keyArg(k));
    if (at < 0) return 0n;
    // The removal must run even when destroying an element does nothing (`?.` would skip its argument).
    const removed = self.removeAt(at);
    ops().destroy?.(frame, removed);
    return 1n;
  });
  method('erase', [constIterator], iterator, (self, [position], frame) => {
    const at = (position as Ptr).index;
    if ((position as Ptr).store !== self || at >= self.size) throw new CppRuntimeError('invalidIterator');
    const removed = self.removeAt(at);
    ops().destroy?.(frame, removed);
    return new Ptr(self, at);
  });
  method('swap', [referenceTo(classType(cls))], VOID, (self, [other]) => self.swap((other as Ptr).read() as HashValue));
  return cls;
}

const keyArg = (arg: unknown): Value => (arg as Ptr).read();
