// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { setNativeArrayStorage } from './assignment';
import { callMethod } from './callables';
import { invoke } from './calls';
import { createObject, findClass, objectToArray } from './classes';
import { deprecated, throwError, warn } from './errors';
import { iterate } from './interp';
import { defineClass, type NativeMethod } from './native';
import { toKey } from './operators';
import { arrayIsShared, share } from './places';
import './splInterfaces';
import { rt } from './runtime';
import { UnsupportedFeatureError } from './unsupported';
import { type Key, PhpArray, type PhpClass, PhpObject, Ref, type Value } from './values';

const STD_PROP_LIST = 1;
const ARRAY_AS_PROPS = 2;
const CHILD_ARRAYS_ONLY = 4;
/** The flags PHP keeps for itself, which the flag arguments and getFlags leave out. */
const INTERNAL_FLAGS = 0xff_ff_00_00;

/** The storage of an ArrayObject or ArrayIterator: its own array, or the ArrayObject whose storage it uses. */
export class ArrayStorage {
  position = 0;
  flags = 0;
  /** The class ArrayObject::getIterator instantiates. */
  iteratorClass = 'ArrayIterator';
  /**
   * The object whose own properties var_dump shows and STD_PROP_LIST makes json_encode and array casts read. A clone's
   * storage has none, since cloning copies the storage before the clone exists.
   */
  holder: PhpObject | undefined;

  constructor(
    /** The class whose private `storage` property var_dump shows. */
    readonly owner: string,
    private own: PhpArray,
    private readonly backing?: PhpObject
  ) {}

  get array(): PhpArray {
    return this.backing ? storageOf(this.backing).array : this.own;
  }

  set array(array: PhpArray) {
    if (this.backing) storageOf(this.backing).array = array;
    else this.own = array;
  }

  held(): Value[] {
    return [this.backing ?? this.own];
  }

  clone(): ArrayStorage {
    let copy: ArrayStorage;
    if (this.owner === 'ArrayIterator' && this.holder) copy = new ArrayStorage(this.owner, this.own, this.holder);
    else if (this.backing) copy = new ArrayStorage(this.owner, this.own, this.backing);
    else {
      this.own.shared = true;
      copy = new ArrayStorage(this.owner, this.own);
    }
    copy.flags = this.flags;
    copy.iteratorClass = this.iteratorClass;
    return copy;
  }

  writable(): PhpArray {
    if (this.backing) return storageOf(this.backing).writable();
    if (arrayIsShared(this.own)) this.own = this.own.copy();
    return this.own;
  }

  /** What var_dump shows: the object's own properties, then the storage as a private property. */
  debugEntries(): [Key, Value][] {
    const properties = this.holder ? [...objectToArray(this.holder).entries()] : [];
    return [...properties, [`\0${this.owner}\0storage`, this.backing ?? this.own]];
  }

  /** The property table json_encode and array casts read: the storage, or the object's own properties. */
  properties(): PhpArray {
    return this.flags & STD_PROP_LIST && this.holder ? objectToArray(this.holder) : this.array;
  }
}

setNativeArrayStorage((value): value is ArrayStorage => value instanceof ArrayStorage);

const storageOf = (object: PhpObject): ArrayStorage => object.internal as ArrayStorage;

/** An ArrayIterator over `array`, as the getIterator methods of PHP's array-like classes return. */
export function arrayIteratorOver(array: PhpArray): PhpObject {
  const iterator = createObject(rt().classes.get('arrayiterator') as PhpClass);
  holdStorage(iterator, new ArrayStorage('ArrayIterator', array));
  return iterator;
}

/** The methods of the Serializable interface and the magic serialization methods, which this grader does not provide. */
export const serializationMethods: NativeMethod[] = ['unserialize(string $data)', 'serialize()'].map((signature) => ({
  signature,
  impl: () => {
    throw new UnsupportedFeatureError('直列化');
  },
}));

export const magicSerializationMethods: NativeMethod[] = [
  '__serialize(): array',
  '__unserialize(array $data): void',
].map((signature) => ({
  signature,
  impl: () => {
    throw new UnsupportedFeatureError('直列化');
  },
}));

/**
 * Transcribes spl_array_set_array: replaces the storage of `object` with an array or another object, whose flags it
 * takes when the method got the array alone (`justArray`).
 */
function setStorage(object: PhpObject, value: Value, method: string, flags: number, justArray: boolean): void {
  const old = storageOf(object);
  const name = old.owner;
  let storage: ArrayStorage;
  let newFlags = flags;
  if (value instanceof PhpArray) {
    value.shared = true;
    storage = new ArrayStorage(name, value);
  } else {
    const other = value as PhpObject;
    deprecated(
      `${name}::${method}(): Using an object as a backing array for ${name} is deprecated, as it allows violating class constraints and invariants`
    );
    if (other.internal instanceof ArrayStorage) {
      if (justArray) newFlags = storageOf(other).flags & ~INTERNAL_FLAGS;
      storage = new ArrayStorage(name, new PhpArray(), other);
    } else {
      const array = new PhpArray();
      for (const [key, item] of iterate(other)) array.set(toKey(key), item);
      storage = new ArrayStorage(name, array);
    }
  }
  storage.flags = checkFlags(old.flags | newFlags);
  storage.iteratorClass = old.iteratorClass;
  holdStorage(object, storage);
}

function holdStorage(object: PhpObject, storage: ArrayStorage): ArrayStorage {
  object.internal = storage;
  storage.holder = object;
  return storage;
}

function checkFlags(flags: number): number {
  if (flags & ARRAY_AS_PROPS) throw new UnsupportedFeatureError('ArrayObject::ARRAY_AS_PROPS');
  return flags;
}

function arrayMethods(name: string): NativeMethod[] {
  return [
    {
      signature:
        name === 'ArrayObject'
          ? '__construct(array|object $array = [], int $flags = 0, string $iteratorClass = "ArrayIterator")'
          : '__construct(array|object $array = [], int $flags = 0)',
      impl: ({ thisObj, args }) => {
        if (args.length === 0) return null;
        if (args.length > 2) storageOf(thisObj).iteratorClass = iteratorClassName(args[2], '__construct', 3);
        const flags = Number(args[1] ?? 0n) & ~INTERNAL_FLAGS;
        setStorage(thisObj, args[0], '__construct', flags, args.length === 1);
        return null;
      },
    },
    {
      signature: 'offsetExists(mixed $key): bool',
      impl: ({ thisObj, args }) => storageOf(thisObj).array.has(toKey(args[0])),
    },
    {
      signature: 'offsetGet(mixed $key): mixed',
      impl: ({ thisObj, args }) => {
        const key = toKey(args[0]);
        const value = storageOf(thisObj).array.get(key);
        if (value === undefined) {
          warn(`Undefined array key ${typeof key === 'bigint' ? key : `"${key}"`}`);
          return null;
        }
        return value;
      },
    },
    {
      signature: 'offsetSet(mixed $key, mixed $value): void',
      impl: ({ thisObj, args }) => {
        const array = storageOf(thisObj).writable();
        if (args[0] === null) array.append(share(args[1]));
        else array.set(toKey(args[0]), share(args[1]));
        return null;
      },
    },
    {
      signature: 'offsetUnset(mixed $key): void',
      impl: ({ thisObj, args }) => {
        storageOf(thisObj).writable().delete(toKey(args[0]));
        return null;
      },
    },
    {
      signature: 'append(mixed $value): void',
      impl: ({ thisObj, args }) => (storageOf(thisObj).writable().append(share(args[0])), null),
    },
    { signature: 'getArrayCopy(): array', impl: ({ thisObj }) => arrayCopy(thisObj) },
    { signature: 'count(): int', impl: ({ thisObj }) => BigInt(storageOf(thisObj).array.size) },
    { signature: 'getFlags(): int', impl: ({ thisObj }) => BigInt(storageOf(thisObj).flags & ~INTERNAL_FLAGS) },
    {
      signature: 'setFlags(int $flags): void',
      impl: ({ thisObj, args }) => {
        const storage = storageOf(thisObj);
        storage.flags = checkFlags((storage.flags & INTERNAL_FLAGS) | (Number(args[0]) & ~INTERNAL_FLAGS));
        return null;
      },
    },
    ...[
      'asort(int $flags = SORT_REGULAR): true',
      'ksort(int $flags = SORT_REGULAR): true',
      'uasort(callable $callback): true',
      'uksort(callable $callback): true',
      'natsort(): true',
      'natcasesort(): true',
    ].map((signature): NativeMethod => ({
      signature,
      impl: ({ thisObj, args }) => sortStorage(thisObj, signature.slice(0, signature.indexOf('(')), args),
    })),
    ...serializationMethods,
    ...magicSerializationMethods,
  ];
}

function arrayCopy(object: PhpObject): PhpArray {
  const array = storageOf(object).array;
  array.shared = true;
  return array;
}

/** The class an ArrayObject's getIterator should instantiate, which must extend ArrayIterator. */
function iteratorClassName(value: Value, method: string, position: number): string {
  const name = value as string;
  const cls = findClass(name);
  if (!cls?.isSubclassOf(rt().classes.get('arrayiterator') as PhpClass))
    throwError(
      'TypeError',
      `ArrayObject::${method}(): Argument #${position} ($iteratorClass) must be a class name derived from ArrayIterator, ${name} given`
    );
  return cls.name;
}

/** Sorts the storage with PHP's sort function of the same name, as spl_array_method does. */
function sortStorage(object: PhpObject, name: string, args: Value[]): Value {
  const storage = storageOf(object);
  const ref = new Ref(storage.writable());
  const fn = rt().functions.get(name);
  if (!fn) throw new Error(`Unknown sort function ${name}`);
  const result = invoke({ fn }, [{ v: ref.v, ref }, ...args.map((v) => ({ v }))], undefined);
  storage.array = ref.v as PhpArray;
  return result;
}

function keyAt(storage: ArrayStorage): Key | undefined {
  return storage.array.keys()[storage.position];
}

function currentEntry(storage: ArrayStorage): Value | undefined {
  const key = keyAt(storage);
  return key === undefined ? undefined : storage.array.get(key);
}

const iteratorMethods: NativeMethod[] = [
  {
    signature: 'rewind(): void',
    impl: ({ thisObj }) => ((storageOf(thisObj).position = 0), null),
  },
  {
    signature: 'current(): mixed',
    impl: ({ thisObj }) => currentEntry(storageOf(thisObj)) ?? null,
  },
  {
    signature: 'key(): string|int|null',
    impl: ({ thisObj }) => keyAt(storageOf(thisObj)) ?? null,
  },
  {
    signature: 'next(): void',
    impl: ({ thisObj }) => ((storageOf(thisObj).position += 1), null),
  },
  {
    signature: 'valid(): bool',
    impl: ({ thisObj }) => storageOf(thisObj).position < storageOf(thisObj).array.size,
  },
  {
    signature: 'seek(int $offset): void',
    impl: ({ thisObj, args }) => {
      const storage = storageOf(thisObj);
      const offset = Number(args[0]);
      if (offset >= 0) storage.position = offset;
      if (offset < 0 || offset >= storage.array.size)
        throwError('OutOfBoundsException', `Seek position ${offset} is out of range`);
      storage.position = offset;
      return null;
    },
  },
];

const flagConstants = { STD_PROP_LIST: BigInt(STD_PROP_LIST), ARRAY_AS_PROPS: BigInt(ARRAY_AS_PROPS) };

defineClass({
  name: 'ArrayIterator',
  interfaces: ['SeekableIterator', 'Traversable', 'Iterator', 'ArrayAccess', 'Serializable', 'Countable'],
  consts: flagConstants,
  methods: [...arrayMethods('ArrayIterator'), ...iteratorMethods],
  createInternal: (object) => holdStorage(object, new ArrayStorage('ArrayIterator', new PhpArray())),
});
defineClass({
  name: 'ArrayObject',
  interfaces: ['IteratorAggregate', 'Traversable', 'ArrayAccess', 'Serializable', 'Countable'],
  consts: flagConstants,
  methods: [
    ...arrayMethods('ArrayObject'),
    {
      signature: 'getIterator(): Iterator',
      impl: ({ thisObj }) => {
        const storage = storageOf(thisObj);
        const iterator = createObject(findClass(storage.iteratorClass) as PhpClass);
        const shared = new ArrayStorage('ArrayIterator', new PhpArray(), thisObj);
        shared.flags = storage.flags;
        holdStorage(iterator, shared);
        return iterator;
      },
    },
    {
      signature: 'exchangeArray(array|object $array): array',
      impl: ({ thisObj, args }) => {
        const old = arrayCopy(thisObj);
        setStorage(thisObj, args[0], 'exchangeArray', 0, true);
        return old;
      },
    },
    {
      signature: 'setIteratorClass(string $iteratorClass): void',
      impl: ({ thisObj, args }) => {
        storageOf(thisObj).iteratorClass = iteratorClassName(args[0], 'setIteratorClass', 1);
        return null;
      },
    },
    { signature: 'getIteratorClass(): string', impl: ({ thisObj }) => storageOf(thisObj).iteratorClass },
  ],
  createInternal: (object) => holdStorage(object, new ArrayStorage('ArrayObject', new PhpArray())),
});

/** The current element of a RecursiveArrayIterator when it has children, which are arrays and, unless the flags say otherwise, objects. */
function childEntry(object: PhpObject): Value | undefined {
  const storage = storageOf(object);
  const entry = currentEntry(storage);
  if (entry instanceof PhpArray) return entry;
  if (entry instanceof PhpObject && (storage.flags & CHILD_ARRAYS_ONLY) === 0) return entry;
  return undefined;
}

defineClass({
  name: 'RecursiveArrayIterator',
  parent: 'ArrayIterator',
  interfaces: [
    'Countable',
    'Serializable',
    'ArrayAccess',
    'Iterator',
    'Traversable',
    'SeekableIterator',
    'RecursiveIterator',
  ],
  consts: { CHILD_ARRAYS_ONLY: BigInt(CHILD_ARRAYS_ONLY) },
  methods: [
    { signature: 'hasChildren(): bool', impl: ({ thisObj }) => childEntry(thisObj) !== undefined },
    {
      signature: 'getChildren(): ?RecursiveArrayIterator',
      impl: ({ thisObj }) => {
        const storage = storageOf(thisObj);
        const entry = currentEntry(storage);
        if (entry === undefined) return null;
        if (entry instanceof PhpObject) {
          if (storage.flags & CHILD_ARRAYS_ONLY) return null;
          if (entry.cls.isSubclassOf(thisObj.cls)) return entry;
        }
        const child = createObject(thisObj.cls);
        callMethod(child, '__construct', [entry, BigInt(storage.flags)]);
        return child;
      },
    },
  ],
});
