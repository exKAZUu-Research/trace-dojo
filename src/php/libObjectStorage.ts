// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { callMethod } from './callables';
import { objectToArray } from './classes';
import { valueName } from './conversions';
import { deprecated, throwError } from './errors';
import { magicSerializationMethods, serializationMethods } from './libArrayObject';
import { defineClass, type NativeMethod } from './native';
import { strictEquals, toKey } from './operators';
import { rt } from './runtime';
import { type Key, type NativeFunction, PhpArray, PhpObject, type Value } from './values';

/**
 * The storage of an SplObjectStorage or MultipleIterator. Like PHP's hash table, it keeps the slot of a removed object
 * empty, so the iteration position stays on the element it was on.
 */
class ObjectStorage {
  slots: (PhpObject | undefined)[] = [];
  entries = new Map<PhpObject, Value>();
  /** The slot the iteration is at, which may be an empty one before the next element. */
  position = 0;
  /** The number key() reports, which counts the steps since the rewind. */
  index = 0;
  /** The MultipleIterator flags. */
  flags = 0;

  /** The object whose own properties var_dump shows; a clone's storage has none, as cloning copies it first. */
  constructor(private readonly holder?: PhpObject) {}

  held(): Value[] {
    return [...this.entries.keys(), ...this.entries.values()];
  }

  clone(): ObjectStorage {
    const copy = new ObjectStorage();
    for (const [object, info] of this.entries) copy.attach(object, info);
    copy.flags = this.flags;
    return copy;
  }

  debugEntries(): [Key, Value][] {
    const storage = new PhpArray();
    for (const [object, data] of this.entries) {
      const entry = new PhpArray();
      entry.set('obj', object);
      entry.set('inf', data);
      storage.append(entry);
    }
    const properties = this.holder ? [...objectToArray(this.holder).entries()] : [];
    return [...properties, ['\0SplObjectStorage\0storage', storage]];
  }

  attach(object: PhpObject, info: Value): void {
    if (!this.entries.has(object)) this.slots.push(object);
    this.entries.set(object, info);
  }

  detach(object: PhpObject): boolean {
    if (!this.entries.delete(object)) return false;
    this.slots[this.slots.indexOf(object)] = undefined;
    return true;
  }

  rewind(): void {
    this.position = 0;
    this.index = 0;
  }

  /** The object at the iteration position, or undefined past the end. */
  current(): PhpObject | undefined {
    return this.slots[this.validPosition()];
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
    return [...this.entries.keys()];
  }
}

const storageOf = (object: PhpObject): ObjectStorage => object.internal as ObjectStorage;

/** Reports a method PHP 8.5 deprecates in favor of its ArrayAccess counterpart. */
function deprecatedMethod(name: string, replacement: string): void {
  deprecated(
    `Method SplObjectStorage::${name}() is deprecated since 8.5, use method SplObjectStorage::${replacement}() instead`
  );
}

function storageKey(value: Value): PhpObject {
  if (!(value instanceof PhpObject))
    throwError(
      'TypeError',
      `SplObjectStorage::offsetExists(): Argument #1 ($object) must be of type object, ${valueName(value)} given`
    );
  return value;
}

/** Detaches an object as the detach methods do, which also rewind the storage. */
function detachAndRewind(object: PhpObject, target: PhpObject): void {
  const storage = storageOf(object);
  storage.detach(target);
  storage.rewind();
}

defineClass({
  name: 'SplObjectStorage',
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
        return storageOf(thisObj).entries.has(args[0] as PhpObject);
      },
    },
    {
      signature: 'addAll(SplObjectStorage $storage): int',
      impl: ({ thisObj, args }) => {
        const storage = storageOf(thisObj);
        for (const [object, info] of storageOf(args[0] as PhpObject).entries) storage.attach(object, info);
        storage.index = 0;
        return BigInt(storage.entries.size);
      },
    },
    {
      signature: 'removeAll(SplObjectStorage $storage): int',
      impl: ({ thisObj, args }) => {
        const storage = storageOf(thisObj);
        for (const object of storageOf(args[0] as PhpObject).objects()) storage.detach(object);
        storage.rewind();
        return BigInt(storage.entries.size);
      },
    },
    {
      signature: 'removeAllExcept(SplObjectStorage $storage): int',
      impl: ({ thisObj, args }) => {
        const storage = storageOf(thisObj);
        const other = storageOf(args[0] as PhpObject);
        for (const object of storage.objects()) if (!other.entries.has(object)) storage.detach(object);
        storage.rewind();
        return BigInt(storage.entries.size);
      },
    },
    {
      signature: 'getInfo(): mixed',
      impl: ({ thisObj }) => {
        const storage = storageOf(thisObj);
        const object = storage.current();
        return object ? (storage.entries.get(object) as Value) : null;
      },
    },
    {
      signature: 'setInfo(mixed $info): void',
      impl: ({ thisObj, args }) => {
        const storage = storageOf(thisObj);
        const object = storage.current();
        if (object) storage.entries.set(object, args[0]);
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
        const offset = Number(args[0]);
        if (offset < 0 || offset >= storage.entries.size)
          throwError('OutOfBoundsException', `Seek position ${offset} is out of range`);
        storage.seek(offset);
        return null;
      },
    },
    ...serializationMethods,
    {
      signature: 'offsetExists($object): bool',
      impl: ({ thisObj, args }) => storageOf(thisObj).entries.has(storageKey(args[0])),
    },
    {
      signature: 'offsetGet($object): mixed',
      impl: ({ thisObj, args }) => {
        const storage = storageOf(thisObj);
        const key = storageKey(args[0]);
        if (!storage.entries.has(key)) throwError('UnexpectedValueException', 'Object not found');
        return storage.entries.get(key) as Value;
      },
    },
    {
      signature: 'offsetSet($object, mixed $info = null): void',
      impl: ({ thisObj, args }) => (storageOf(thisObj).attach(storageKey(args[0]), args[1] ?? null), null),
    },
    {
      signature: 'offsetUnset($object): void',
      impl: ({ thisObj, args }) => (storageOf(thisObj).detach(storageKey(args[0])), null),
    },
    {
      signature: 'getHash(object $object): string',
      impl: ({ args }) => (rt().functions.get('spl_object_hash') as NativeFunction).impl({ args, refs: [] }),
    },
    ...magicSerializationMethods,
  ],
  createInternal: (object) => new ObjectStorage(object),
});

// MultipleIterator ---------------------------------------------------------------------------------------------------

const MIT_NEED_ALL = 1;
const MIT_KEYS_ASSOC = 2;

const multipleMethods: NativeMethod[] = [
  {
    signature: '__construct(int $flags = 1)',
    impl: ({ thisObj, args }) => ((storageOf(thisObj).flags = Number(args[0] ?? BigInt(MIT_NEED_ALL))), null),
  },
  { signature: 'getFlags(): int', impl: ({ thisObj }) => BigInt(storageOf(thisObj).flags) },
  {
    signature: 'setFlags(int $flags): void',
    impl: ({ thisObj, args }) => ((storageOf(thisObj).flags = Number(args[0])), null),
  },
  {
    signature: 'attachIterator(Iterator $iterator, string|int|null $info = null): void',
    impl: ({ thisObj, args }) => {
      const storage = storageOf(thisObj);
      const info = args[1] ?? null;
      if (info !== null && [...storage.entries.values()].some((other) => strictEquals(other, info)))
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
    impl: ({ thisObj, args }) => storageOf(thisObj).entries.has(args[0] as PhpObject),
  },
  { signature: 'countIterators(): int', impl: ({ thisObj }) => BigInt(storageOf(thisObj).entries.size) },
  { signature: 'rewind(): void', impl: ({ thisObj }) => (callEach(thisObj, 'rewind'), null) },
  {
    signature: 'valid(): bool',
    impl: ({ thisObj }) => {
      const storage = storageOf(thisObj);
      if (storage.entries.size === 0) return false;
      const expect = (storage.flags & MIT_NEED_ALL) !== 0;
      for (const iterator of storage.objects()) {
        if (callMethod(iterator, 'valid', []) !== expect) return !expect;
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
  for (const [iterator, info] of storage.entries) {
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
    MIT_NEED_ALL: BigInt(MIT_NEED_ALL),
    MIT_KEYS_NUMERIC: 0n,
    MIT_KEYS_ASSOC: BigInt(MIT_KEYS_ASSOC),
  },
  methods: multipleMethods,
  createInternal: (object) => new ObjectStorage(object),
});
