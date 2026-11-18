// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { callMethod } from './callables';
import { objectToArray } from './classes';
import { valueName } from './conversions';
import { deprecated, throwError, withCleanupExceptions } from './errors';
import { magicSerializationMethods, serializationMethods } from './libArrayObject';
import { defineClass, type NativeMethod } from './native';
import { strictEquals, toKey } from './operators';
import { share } from './places';
import { PhpThrow, rt } from './runtime';
import { dropped, type Key, type NativeFunction, NativeValueIndex, PhpArray, PhpObject, type Value } from './values';

interface StorageEntry {
  object: PhpObject;
  info: Value;
}

class ObjectStorage {
  readonly nativeValues = new NativeValueIndex();
  slots: (StorageEntry | undefined)[] = [];
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
    info = share(info);
    const hash = this.hash(object);
    const entry = this.entries.get(hash);
    if (entry) {
      const old = entry.info;
      entry.info = info;
      this.nativeValues.add(info);
      this.nativeValues.delete(old);
      dropped(old);
    } else {
      rt().allocate(1);
      const entry = { object, info };
      this.entries.set(hash, entry);
      this.slots.push(entry);
      this.nativeValues.add(object);
      this.nativeValues.add(info);
    }
  }

  detach(object: PhpObject, capture?: (error: PhpThrow) => void): boolean {
    const hash = this.hash(object);
    const entry = this.entries.get(hash);
    if (!entry) return false;
    this.entries.delete(hash);
    this.nativeValues.delete(entry.object);
    this.nativeValues.delete(entry.info);
    this.slots[this.slots.indexOf(entry)] = undefined;
    const runtime = rt();
    runtime.release([entry.object, entry.info]);
    try {
      runtime.flushReleases(true);
    } catch (error) {
      if (!capture || !(error instanceof PhpThrow)) throw error;
      capture(error);
    }
    return true;
  }

  unsetOffset(value: Value): void {
    if (this.holder.cls.lname !== 'splobjectstorage' || !(value instanceof PhpObject) || value.isResource) {
      callMethod(this.holder, 'offsetUnset', [value], rt().row);
      return;
    }
    this.detach(value);
  }

  has(object: PhpObject): boolean {
    return this.entries.has(this.hash(object));
  }
  get(object: PhpObject): Value | undefined {
    return this.entries.get(this.hash(object))?.info;
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
      dropped(old);
    }
  }

  private hash(object: PhpObject): string | PhpObject {
    if (!this.hashKeys) return object;
    const hash = callMethod(this.holder, 'getHash', [object]);
    if (typeof hash !== 'string')
      throwError(
        'TypeError',
        `${this.holder.cls.name}::getHash(): Return value must be of type string, ${valueName(hash)} returned`
      );
    return hash;
  }

  removeAll(other: ObjectStorage): bigint {
    return this.rewindAfter(() => {
      withCleanupExceptions(rt(), (capture) => {
        let position = 0;
        while (position < other.slots.length) {
          rt().spend();
          const entry = other.slots[position];
          if (!entry || !this.detach(entry.object, this.hashKeys ? undefined : capture)) position++;
        }
      });
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
    this.position = 0;
    this.index = 0;
  }

  /** The object at the iteration position, or undefined past the end. */
  current(): PhpObject | undefined {
    return this.slots[this.validPosition()]?.object;
  }

  next(): void {
    this.position = this.validPosition() + 1;
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

  private validPosition(): number {
    let position = this.position;
    while (position < this.slots.length && this.slots[position] === undefined) position++;
    return position;
  }

  objects(): PhpObject[] {
    return [...this.entries.values()].map(({ object }) => object);
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
      impl: ({ thisObj, args }) => {
        const storage = storageOf(thisObj);
        const other = storageOf(args[0] as PhpObject);
        return storage.rewindAfter(() => {
          for (const object of storage.objects()) if (!other.has(object)) storage.detach(object);
          return BigInt(storage.entries.size);
        });
      },
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
      impl: ({ thisObj, args }) => {
        const storage = storageOf(thisObj);
        const key = storageKey(args[0], 'offsetGet');
        const info = storage.get(key);
        if (info === undefined) throwError('UnexpectedValueException', 'Object not found');
        return info;
      },
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
      if (info !== null && [...storage.entries.values()].some((other) => strictEquals(other.info, info)))
        throwError('InvalidArgumentException', 'Key duplication error');
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
      for (const iterator of storage.objects()) {
        if ((callMethod(iterator, 'valid', []) === true) !== expect) return !expect;
      }
      return expect;
    },
  },
  { signature: 'key(): array', impl: ({ thisObj }) => getAll(thisObj, 'key') },
  { signature: 'current(): array', impl: ({ thisObj }) => getAll(thisObj, 'current') },
  { signature: 'next(): void', impl: ({ thisObj }) => (callEach(thisObj, 'next'), null) },
];

function callEach(object: PhpObject, method: string): void {
  for (const iterator of storageOf(object).objects()) callMethod(iterator, method, []);
}

/** Transcribes spl_multiple_iterator_get_all, which collects the current values or keys of the iterators. */
function getAll(object: PhpObject, method: 'current' | 'key'): PhpArray {
  const storage = storageOf(object);
  if (storage.entries.size === 0) throwError('RuntimeException', `Called ${method}() on an invalid iterator`);
  const result = new PhpArray();
  for (const { object: iterator, info } of storage.entries.values()) {
    let value: Value = null;
    if (callMethod(iterator, 'valid', []) === true) value = callMethod(iterator, method, []);
    else if (storage.flags & MIT_NEED_ALL)
      throwError('RuntimeException', `Called ${method}() with non valid sub iterator`);
    if (!(storage.flags & MIT_KEYS_ASSOC)) result.append(value);
    else if (typeof info === 'bigint' || typeof info === 'string') result.set(toKey(info), value);
    else throwError('InvalidArgumentException', 'Sub-Iterator is associated with NULL');
  }
  return result;
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
