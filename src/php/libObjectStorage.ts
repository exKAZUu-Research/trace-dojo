// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { callMethod } from './callables';
import { implicitCallRow } from './calls';
import { objectToArray } from './classes';
import { valueName } from './conversions';
import { type CleanupException, deprecated, throwError, withCleanupExceptions, withPendingException } from './errors';
import { releaseDropped } from './garbage';
import { magicSerializationMethods, serializationMethods } from './libArrayObject';
import { defineClass, type NativeMethod } from './native';
import { strictEquals, toKey } from './operators';
import { share } from './places';
import { ExitSignal, PhpThrow, rt } from './runtime';
import { type Key, type NativeFunction, NativeValueIndex, PhpArray, PhpObject, type Value } from './values';

interface StorageEntry {
  object: PhpObject;
  info: Value;
  slot: number;
}

type CaptureCleanup = (error: CleanupException) => void;

class ObjectStorage {
  readonly nativeValues = new NativeValueIndex();
  slots: (StorageEntry | undefined)[] = [];
  private bucketCapacity = 8;
  private bucketMode: 'empty' | 'packed' | 'mixed' = 'empty';
  entries = new Map<string | PhpObject, StorageEntry>();
  /** The slot the iteration is at, which may be an empty one before the next element. */
  position = 0;
  /** The number key() reports, which counts the steps since the rewind. */
  index = 0;
  /** The MultipleIterator flags. */
  flags = 0n;

  constructor(
    private readonly holder: PhpObject,
    private readonly hashKeys = false
  ) {}

  held(): Value[] {
    return [...this.entries.values()].flatMap(({ object, info }) => [object, info]);
  }

  cloneWithDefaults(holder: PhpObject): ObjectStorage {
    const copy = new ObjectStorage(holder, this.hashKeys);
    holder.internal = copy;
    for (const { object, info } of this.entries.values()) copy.attach(object, info);
    copy.flags = this.flags;
    return copy;
  }

  debugEntries(): [Key, Value][] {
    const storage = new PhpArray();
    for (const { object, info: data } of this.entries.values()) {
      const entry = new PhpArray();
      entry.set('obj', object);
      entry.set('inf', data);
      storage.append(entry);
    }
    const properties = [...objectToArray(this.holder).entries()];
    return [...properties, ['\0SplObjectStorage\0storage', storage]];
  }

  attach(object: PhpObject, info: Value): void {
    this.withHash(object, (hash, pending) => this.attachEntry(hash, object, info, pending));
  }

  private attachEntry(hash: string | PhpObject, object: PhpObject, info: Value, pending?: CleanupException): void {
    info = share(info);
    const entry = this.entries.get(hash);
    if (entry) {
      const old = entry.info;
      entry.info = info;
      this.nativeValues.add(info);
      this.nativeValues.delete(old);
      this.releaseRemoved([old], undefined, pending);
    } else {
      rt().allocate(1);
      const slot = this.insertionBucket(hash);
      const entry: StorageEntry = { object, info, slot };
      this.entries.set(hash, entry);
      this.slots[slot] = entry;
      this.nativeValues.add(object);
      this.nativeValues.add(info);
    }
  }

  // code-gauge-allow functionCognitiveComplexity 19 -- PHP bucket insertion shares representation, compaction and capacity state.
  private insertionBucket(hash: string | PhpObject): number {
    const id = typeof hash === 'string' ? undefined : hash.id;
    if (this.bucketMode === 'empty')
      this.bucketMode = id !== undefined && id < this.bucketCapacity ? 'packed' : 'mixed';
    if (this.bucketMode === 'packed' && id !== undefined && id >= this.slots.length) {
      if (id < this.bucketCapacity) return id;
      if (id < this.bucketCapacity * 2 && this.entries.size > this.bucketCapacity / 2) {
        this.bucketCapacity *= 2;
        return id;
      }
    }
    if (this.bucketMode === 'packed') {
      this.bucketMode = 'mixed';
      if (this.slots.length >= this.bucketCapacity) this.bucketCapacity *= 2;
      this.compactBuckets();
    } else if (this.slots.length >= this.bucketCapacity) {
      if (this.slots.length > this.entries.size + Math.floor(this.entries.size / 32)) this.compactBuckets();
      else this.bucketCapacity *= 2;
    }
    return this.slots.length;
  }

  private compactBuckets(): void {
    this.slots = this.slots.filter((entry) => entry !== undefined);
    for (const [slot, entry] of this.slots.entries()) if (entry) entry.slot = slot;
  }

  detach(object: PhpObject, capture?: CaptureCleanup): boolean {
    return this.withHash(object, (hash, pending) => this.detachEntry(hash, capture, pending));
  }

  private detachEntry(hash: string | PhpObject, capture?: CaptureCleanup, pending?: CleanupException): boolean {
    const entry = this.entries.get(hash);
    if (!entry) return false;
    this.entries.delete(hash);
    this.nativeValues.delete(entry.object);
    this.nativeValues.delete(entry.info);
    this.slots[entry.slot] = undefined;
    if (entry.slot === this.slots.length - 1)
      while (this.slots.length > 0 && this.slots.at(-1) === undefined) this.slots.pop();
    this.releaseRemoved([entry.object, entry.info], capture, pending);
    return true;
  }

  private releaseRemoved(values: Value[], capture?: CaptureCleanup, pending?: CleanupException): void {
    const runtime = rt();
    try {
      releaseDropped(runtime, values, implicitCallRow() === undefined, 'complete', pending);
    } catch (error) {
      if (!capture || !(error instanceof PhpThrow || error instanceof ExitSignal)) throw error;
      capture(error);
    }
  }

  unsetOffset(value: Value): void {
    if (this.holder.cls.lname !== 'splobjectstorage' || !(value instanceof PhpObject) || value.isResource) {
      callMethod(this.holder, 'offsetUnset', [value], rt().row);
      return;
    }
    this.detach(value);
  }

  has(object: PhpObject): boolean {
    return this.checkMembership(object, (present) => present);
  }

  private checkMembership<T>(object: PhpObject, consume: (present: boolean, pending?: CleanupException) => T): T {
    return this.withHash(object, (hash, pending) => consume(this.entries.has(hash), pending));
  }

  get(object: PhpObject): Value {
    return this.withHash(object, (hash, pending) => {
      const entry = this.entries.get(hash);
      if (entry) return entry.info;
      if (pending instanceof ExitSignal) return null;
      return withPendingException(rt(), pending, () => throwError('UnexpectedValueException', 'Object not found'));
    });
  }
  currentInfo(): Value {
    return this.slots[this.validPosition()]?.info ?? null;
  }
  setCurrentInfo(value: Value): void {
    const entry = this.slots[this.validPosition()];
    if (entry) {
      const old = entry.info;
      entry.info = share(value);
      this.nativeValues.add(value);
      this.nativeValues.delete(old);
      this.releaseRemoved([old]);
    }
  }

  private withHash<T>(object: PhpObject, consume: (hash: string | PhpObject, pending?: CleanupException) => T): T {
    if (!this.hashKeys) return consume(object);
    const runtime = rt();
    let returned: Value | undefined;
    let hash: Value;
    let pending: CleanupException | undefined;
    try {
      hash = runtime.withNativeReleaseMode('complete', () =>
        callMethod(this.holder, 'getHash', [object], undefined, {
          captureReturn: (value) => {
            returned = value;
          },
        })
      );
    } catch (error) {
      if (returned === undefined || !(error instanceof PhpThrow || error instanceof ExitSignal)) throw error;
      hash = returned;
      pending = error;
    }
    if (typeof hash !== 'string')
      return withPendingException(runtime, pending instanceof PhpThrow ? pending : undefined, () =>
        throwError(
          'TypeError',
          `${this.holder.cls.name}::getHash(): Return value must be of type string, ${valueName(hash)} returned`
        )
      );
    const result = consume(hash, pending);
    if (pending) throw pending;
    return result;
  }

  removeAll(other: ObjectStorage): bigint {
    return this.bulkRemove(this.hashKeys, (capture) => {
      let position = 0;
      while (position < other.slots.length) {
        rt().spend();
        const entry = other.slots[position];
        if (!entry || !this.detach(entry.object, capture)) position++;
      }
    });
  }

  // code-gauge-allow functionCognitiveComplexity 22 -- Pins a key through membership, detach and pending-exception cleanup.
  removeAllExcept(other: ObjectStorage): bigint {
    return this.bulkRemove(this.hashKeys || other.hashKeys, (capture) => {
      for (let slot = 0; slot < this.slots.length; slot++) {
        const runtime = rt();
        runtime.spend();
        const entry = this.slots[slot];
        if (!entry) continue;
        const { object } = entry;
        const holder = runtime.held.length;
        runtime.held.push(object);
        let pending: PhpThrow | undefined;
        try {
          other.checkMembership(object, (present, pending) => {
            if (present) return;
            if (!pending) this.detach(object, capture);
            else if (!this.hashKeys) this.detachEntry(object, capture, pending);
          });
        } catch (error) {
          if (error instanceof PhpThrow) pending = error;
          throw error;
        } finally {
          runtime.held.splice(holder, 1);
          withPendingException(runtime, pending, () => this.releaseRemoved([object], capture));
        }
      }
    });
  }

  private bulkRemove(callsHash: boolean, remove: (capture?: CaptureCleanup) => void): bigint {
    return this.rewindAfter(() => {
      if (callsHash) remove();
      else withCleanupExceptions(rt(), remove, 'latest');
      return BigInt(this.entries.size);
    });
  }

  rewindAfter<T>(operate: () => T): T {
    try {
      return operate();
    } finally {
      this.rewind();
    }
  }

  rewind(): void {
    this.position = this.validPosition(0);
    this.index = 0;
  }

  /** The object at the iteration position, or undefined past the end. */
  current(): PhpObject | undefined {
    return this.slots[this.validPosition()]?.object;
  }

  next(): void {
    const position = this.validPosition();
    if (position < this.slots.length) this.position = this.validPosition(position + 1);
    this.index++;
  }

  previous(): void {
    if (this.position < this.slots.length) {
      let position = this.position;
      do position--;
      while (position >= 0 && this.slots[position] === undefined);
      this.position = position < 0 ? this.slots.length : position;
    }
    this.index--;
  }

  /** Transcribes SplObjectStorage::seek, which walks back from the position when that is shorter than from the start. */
  seek(offset: number): void {
    if (offset === 0 || (offset < this.index && this.index - offset > offset)) this.rewind();
    while (this.index < offset) this.next();
    while (this.index > offset) this.previous();
  }

  *entriesFromStart(): Generator<StorageEntry> {
    this.rewind();
    let entry: StorageEntry | undefined;
    while ((entry = this.slots[this.validPosition()])) {
      rt().spend();
      yield entry;
      this.next();
    }
  }

  withIterator<T>(iterator: PhpObject, call: () => T): T {
    const runtime = rt();
    runtime.held.push(iterator);
    let pending: PhpThrow | undefined;
    try {
      return call();
    } catch (error) {
      if (error instanceof PhpThrow) pending = error;
      throw error;
    } finally {
      runtime.held.pop();
      withPendingException(runtime, pending, () => this.releaseRemoved([iterator]));
    }
  }

  private validPosition(position = this.position): number {
    while (position < this.slots.length && this.slots[position] === undefined) position++;
    return position;
  }
}

const storageOf = (object: PhpObject): ObjectStorage => object.internal as ObjectStorage;

/** Reports a method PHP 8.5 deprecates in favor of its ArrayAccess counterpart. */
function deprecatedMethod(name: string, replacement: string): void {
  deprecated(
    `Method SplObjectStorage::${name}() is deprecated since 8.5, use method SplObjectStorage::${replacement}() instead`
  );
}

function storageKey(value: Value, method: string): PhpObject {
  if (!(value instanceof PhpObject) || value.isResource)
    throwError(
      'TypeError',
      `SplObjectStorage::${method}(): Argument #1 ($object) must be of type object, ${valueName(value)} given`
    );
  return value;
}

/** Detaches an object as the detach methods do, which also rewind the storage. */
function detachAndRewind(object: PhpObject, target: PhpObject): void {
  const storage = storageOf(object);
  storage.rewindAfter(() => storage.detach(target));
}

defineClass({
  name: 'SplObjectStorage',
  compare: compareObjectStorage,
  interfaces: ['Countable', 'SeekableIterator', 'Traversable', 'Iterator', 'Serializable', 'ArrayAccess'],
  methods: [
    {
      signature: 'attach(object $object, mixed $info = null): void',
      impl: ({ thisObj, args }) => {
        deprecatedMethod('attach', 'offsetSet');
        storageOf(thisObj).attach(args[0] as PhpObject, args[1] ?? null);
        return null;
      },
    },
    {
      signature: 'detach(object $object): void',
      impl: ({ thisObj, args }) => {
        deprecatedMethod('detach', 'offsetUnset');
        detachAndRewind(thisObj, args[0] as PhpObject);
        return null;
      },
    },
    {
      signature: 'contains(object $object): bool',
      impl: ({ thisObj, args }) => {
        deprecatedMethod('contains', 'offsetExists');
        return storageOf(thisObj).has(args[0] as PhpObject);
      },
    },
    {
      signature: 'addAll(SplObjectStorage $storage): int',
      impl: ({ thisObj, args }) => {
        const storage = storageOf(thisObj);
        for (const { object, info } of storageOf(args[0] as PhpObject).entries.values()) storage.attach(object, info);
        storage.index = 0;
        return BigInt(storage.entries.size);
      },
    },
    {
      signature: 'removeAll(SplObjectStorage $storage): int',
      impl: ({ thisObj, args }) => storageOf(thisObj).removeAll(storageOf(args[0] as PhpObject)),
    },
    {
      signature: 'removeAllExcept(SplObjectStorage $storage): int',
      impl: ({ thisObj, args }) => storageOf(thisObj).removeAllExcept(storageOf(args[0] as PhpObject)),
    },
    {
      signature: 'getInfo(): mixed',
      impl: ({ thisObj }) => {
        const storage = storageOf(thisObj);
        return storage.currentInfo();
      },
    },
    {
      signature: 'setInfo(mixed $info): void',
      impl: ({ thisObj, args }) => {
        const storage = storageOf(thisObj);
        storage.setCurrentInfo(args[0]);
        return null;
      },
    },
    {
      signature: 'count(int $mode = COUNT_NORMAL): int',
      impl: ({ thisObj }) => BigInt(storageOf(thisObj).entries.size),
    },
    { signature: 'rewind(): void', impl: ({ thisObj }) => (storageOf(thisObj).rewind(), null) },
    { signature: 'valid(): bool', impl: ({ thisObj }) => storageOf(thisObj).current() !== undefined },
    { signature: 'key(): int', impl: ({ thisObj }) => BigInt(storageOf(thisObj).index) },
    {
      signature: 'current(): object',
      impl: ({ thisObj }) =>
        storageOf(thisObj).current() ?? throwError('RuntimeException', 'Called current() on invalid iterator'),
    },
    { signature: 'next(): void', impl: ({ thisObj }) => (storageOf(thisObj).next(), null) },
    {
      signature: 'seek(int $offset): void',
      impl: ({ thisObj, args }) => {
        const storage = storageOf(thisObj);
        const offset = args[0] as bigint;
        if (offset < 0n || offset >= BigInt(storage.entries.size))
          throwError('OutOfBoundsException', `Seek position ${offset} is out of range`);
        storage.seek(Number(offset));
        return null;
      },
    },
    ...serializationMethods,
    {
      signature: 'offsetExists($object): bool',
      impl: ({ thisObj, args }) => storageOf(thisObj).has(storageKey(args[0], 'offsetExists')),
    },
    {
      signature: 'offsetGet($object): mixed',
      impl: ({ thisObj, args }) => storageOf(thisObj).get(storageKey(args[0], 'offsetGet')),
    },
    {
      signature: 'offsetSet($object, mixed $info = null): void',
      impl: ({ thisObj, args }) => (storageOf(thisObj).attach(storageKey(args[0], 'offsetSet'), args[1] ?? null), null),
    },
    {
      signature: 'offsetUnset($object): void',
      impl: ({ thisObj, args }) => (detachAndRewind(thisObj, storageKey(args[0], 'offsetUnset')), null),
    },
    {
      signature: 'getHash(object $object): string',
      impl: ({ args }) => (rt().functions.get('spl_object_hash') as NativeFunction).impl({ args, refs: [] }),
    },
    ...magicSerializationMethods,
  ],
  createInternal: (object) =>
    new ObjectStorage(object, object.cls.findMethod('gethash')?.scope.lname !== 'splobjectstorage'),
});

function* compareObjectStorage(a: PhpObject, b: PhpObject): Generator<[Value, Value, 'order'], number> {
  if (a.cls.name !== 'SplObjectStorage' || b.cls.name !== 'SplObjectStorage') return 1;
  const left = storageOf(a).entries;
  const right = storageOf(b).entries;
  if (left.size !== right.size) return Math.sign(left.size - right.size);
  for (const [key, entry] of left) {
    const other = right.get(key);
    if (other === undefined) return 1;
    yield [entry.info, other.info, 'order'];
  }
  return 0;
}

// MultipleIterator ---------------------------------------------------------------------------------------------------

const MIT_NEED_ALL = 1n;
const MIT_KEYS_ASSOC = 2n;

const multipleMethods: NativeMethod[] = [
  {
    signature: '__construct(int $flags = 1)',
    impl: ({ thisObj, args }) => ((storageOf(thisObj).flags = (args[0] as bigint | undefined) ?? MIT_NEED_ALL), null),
  },
  { signature: 'getFlags(): int', impl: ({ thisObj }) => storageOf(thisObj).flags },
  {
    signature: 'setFlags(int $flags): void',
    impl: ({ thisObj, args }) => ((storageOf(thisObj).flags = args[0] as bigint), null),
  },
  {
    signature: 'attachIterator(Iterator $iterator, string|int|null $info = null): void',
    impl: ({ thisObj, args }) => {
      const storage = storageOf(thisObj);
      const info = args[1] ?? null;
      if (info !== null) {
        for (const other of storage.entriesFromStart())
          if (strictEquals(other.info, info)) throwError('InvalidArgumentException', 'Key duplication error');
      }
      storage.attach(args[0] as PhpObject, info);
      return null;
    },
  },
  {
    signature: 'detachIterator(Iterator $iterator): void',
    impl: ({ thisObj, args }) => (detachAndRewind(thisObj, args[0] as PhpObject), null),
  },
  {
    signature: 'containsIterator(Iterator $iterator): bool',
    impl: ({ thisObj, args }) => storageOf(thisObj).has(args[0] as PhpObject),
  },
  { signature: 'countIterators(): int', impl: ({ thisObj }) => BigInt(storageOf(thisObj).entries.size) },
  { signature: 'rewind(): void', impl: ({ thisObj }) => (callEach(thisObj, 'rewind'), null) },
  {
    signature: 'valid(): bool',
    impl: ({ thisObj }) => {
      const storage = storageOf(thisObj);
      if (storage.entries.size === 0) return false;
      const expect = (storage.flags & MIT_NEED_ALL) !== 0n;
      for (const { object: iterator } of storage.entriesFromStart()) {
        const valid = storage.withIterator(iterator, () => callMethod(iterator, 'valid', []) === true);
        if (valid !== expect) return !expect;
      }
      return expect;
    },
  },
  { signature: 'key(): array', impl: ({ thisObj }) => getAll(thisObj, 'key') },
  { signature: 'current(): array', impl: ({ thisObj }) => getAll(thisObj, 'current') },
  { signature: 'next(): void', impl: ({ thisObj }) => (callEach(thisObj, 'next'), null) },
];

function callEach(object: PhpObject, method: string): void {
  const storage = storageOf(object);
  for (const { object: iterator } of storage.entriesFromStart())
    storage.withIterator(iterator, () => callMethod(iterator, method, []));
}

/** Transcribes spl_multiple_iterator_get_all, which collects the current values or keys of the iterators. */
function getAll(object: PhpObject, method: 'current' | 'key'): PhpArray {
  const storage = storageOf(object);
  if (storage.entries.size === 0) throwError('RuntimeException', `Called ${method}() on an invalid iterator`);
  const result = new PhpArray();
  const runtime = rt();
  runtime.held.push(result);
  try {
    for (const { object: iterator, info } of storage.entriesFromStart()) {
      storage.withIterator(iterator, () => {
        const value = iteratorValue(storage, iterator, method);
        if (!(storage.flags & MIT_KEYS_ASSOC)) result.append(value);
        else if (typeof info === 'bigint' || typeof info === 'string') result.set(toKey(info), value);
        else throwError('InvalidArgumentException', 'Sub-Iterator is associated with NULL');
      });
    }
    return result;
  } finally {
    runtime.held.pop();
  }
}

function iteratorValue(storage: ObjectStorage, iterator: PhpObject, method: 'current' | 'key'): Value {
  let valid: boolean;
  try {
    valid = callMethod(iterator, 'valid', []) === true;
  } catch (error) {
    if (error instanceof PhpThrow && storage.flags & MIT_NEED_ALL)
      throwError('RuntimeException', `Called ${method}() with non valid sub iterator`, error.object);
    throw error;
  }
  if (!valid) {
    if (storage.flags & MIT_NEED_ALL) throwError('RuntimeException', `Called ${method}() with non valid sub iterator`);
    return null;
  }
  try {
    return callMethod(iterator, method, []);
  } catch (error) {
    if (error instanceof PhpThrow) throwError('RuntimeException', 'Failed to call sub iterator method', error.object);
    throw error;
  }
}

defineClass({
  name: 'MultipleIterator',
  interfaces: ['Iterator', 'Traversable'],
  consts: {
    MIT_NEED_ANY: 0n,
    MIT_NEED_ALL,
    MIT_KEYS_NUMERIC: 0n,
    MIT_KEYS_ASSOC,
  },
  methods: multipleMethods,
  createInternal: (object) => new ObjectStorage(object),
});
