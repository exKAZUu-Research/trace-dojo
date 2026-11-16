// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { createObject } from './classes';
// code-gauge-allow-file fileNcss 600 -- The SPL data structures, each a small class of its own.
import { debugType } from './conversions';
import { deprecated, throwError, warn } from './errors';
import { callCallback, callMethod, iterate } from './interp';
import { defineClass, type NativeMethod } from './native';
import { compare, toKey } from './operators';
import { share } from './places';
import { rt } from './runtime';
import { UnsupportedFeatureError } from './unsupported';
import { type Key, PhpArray, PhpObject, type Value } from './values';

/** The storage of an ArrayObject or ArrayIterator, with the position an iterator is at. */
class ArrayStorage {
  position = 0;

  constructor(public array: PhpArray) {}

  held(): Value[] {
    return [this.array];
  }

  clone(): ArrayStorage {
    this.array.shared = true;
    return new ArrayStorage(this.array);
  }

  writable(): PhpArray {
    if (this.array.shared) this.array = this.array.copy();
    return this.array;
  }

  debugEntries(): [string, Value][] {
    return [['\0ArrayObject\0storage', this.array]];
  }
}

const storageOf = (object: PhpObject): ArrayStorage => object.internal as ArrayStorage;

/** The methods of the Serializable interface, which this grader does not provide. */
const serializationMethods: NativeMethod[] = ['serialize()', 'unserialize(string $data)'].map((signature) => ({
  signature,
  impl: () => {
    throw new UnsupportedFeatureError('直列化');
  },
}));

function arrayInput(value: Value | undefined, name: string): PhpArray {
  if (value === undefined) return new PhpArray();
  if (value instanceof PhpArray) {
    value.shared = true;
    return value;
  }
  if (value instanceof PhpObject) {
    const array = new PhpArray();
    for (const [key, item] of iterate(value)) array.set(toKey(key), item);
    return array;
  }
  throwError(
    'TypeError',
    `${name}::__construct(): Argument #1 ($array) must be of type array, ${debugType(value)} given`
  );
}

function arrayMethods(name: string): NativeMethod[] {
  return [
    {
      signature: '__construct(array|object $array = [], int $flags = 0)',
      impl: ({ thisObj, args }) => {
        thisObj.internal = new ArrayStorage(arrayInput(args[0], name));
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
    { signature: 'count(): int', impl: ({ thisObj }) => BigInt(storageOf(thisObj).array.size) },
    {
      signature: 'getArrayCopy(): array',
      impl: ({ thisObj }) => {
        const array = storageOf(thisObj).array;
        array.shared = true;
        return array;
      },
    },
    {
      signature: 'asort(int $flags = SORT_REGULAR): true',
      impl: ({ thisObj }) => sortStorage(thisObj, (a, b) => compare(a[1], b[1])),
    },
    {
      signature: 'ksort(int $flags = SORT_REGULAR): true',
      impl: ({ thisObj }) => sortStorage(thisObj, (a, b) => compare(a[0], b[0])),
    },
    {
      signature: 'uasort(callable $callback): true',
      impl: ({ thisObj, args }) => sortStorage(thisObj, (a, b) => Number(callCallback(args[0], [a[1], b[1]]))),
    },
    {
      signature: 'uksort(callable $callback): true',
      impl: ({ thisObj, args }) => sortStorage(thisObj, (a, b) => Number(callCallback(args[0], [a[0], b[0]]))),
    },
  ];
}

function sortStorage(object: PhpObject, comparator: (a: [Key, Value], b: [Key, Value]) => number): true {
  const storage = storageOf(object);
  const entries = [...storage.writable().entries()].toSorted(comparator);
  const array = new PhpArray();
  for (const [key, value] of entries) array.set(key, value);
  storage.array = array;
  return true;
}

function keyAt(storage: ArrayStorage): Key | undefined {
  return storage.array.keys()[storage.position];
}

function iteratorMethods(): NativeMethod[] {
  return [
    {
      signature: 'current(): mixed',
      impl: ({ thisObj }) => {
        const storage = storageOf(thisObj);
        const key = keyAt(storage);
        return key === undefined ? null : (storage.array.get(key) as Value);
      },
    },
    { signature: 'key(): string|int|null', impl: ({ thisObj }) => keyAt(storageOf(thisObj)) ?? null },
    { signature: 'next(): void', impl: ({ thisObj }) => ((storageOf(thisObj).position += 1), null) },
    { signature: 'rewind(): void', impl: ({ thisObj }) => ((storageOf(thisObj).position = 0), null) },
    { signature: 'valid(): bool', impl: ({ thisObj }) => storageOf(thisObj).position < storageOf(thisObj).array.size },
    {
      signature: 'seek(int $offset): void',
      impl: ({ thisObj, args }) => {
        const storage = storageOf(thisObj);
        const offset = Number(args[0]);
        if (offset < 0 || offset >= storage.array.size)
          throwError('OutOfBoundsException', `Seek position ${offset} is out of range`);
        storage.position = offset;
        return null;
      },
    },
  ];
}

defineClass({
  name: 'ArrayIterator',
  interfaces: ['SeekableIterator', 'Traversable', 'Iterator', 'ArrayAccess', 'Serializable', 'Countable'],
  methods: [...arrayMethods('ArrayIterator'), ...iteratorMethods(), ...serializationMethods],
  createInternal: () => new ArrayStorage(new PhpArray()),
});
defineClass({
  name: 'ArrayObject',
  interfaces: ['IteratorAggregate', 'Traversable', 'ArrayAccess', 'Serializable', 'Countable'],
  methods: [
    ...arrayMethods('ArrayObject'),
    ...serializationMethods,
    {
      signature: 'getIterator(): Iterator',
      impl: ({ thisObj }) => {
        const iterator = createNative('ArrayIterator');
        const storage = storageOf(thisObj);
        storage.array.shared = true;
        iterator.internal = new ArrayStorage(storage.array);
        return iterator;
      },
    },
  ],
  createInternal: () => new ArrayStorage(new PhpArray()),
});

function createNative(name: string): PhpObject {
  return createObject(rt().classes.get(name.toLowerCase()) as never);
}

// Doubly linked lists, stacks, and queues ----------------------------------------------------------------------------

class ListStorage {
  items: Value[] = [];
  position = 0;
  lifo = false;

  held(): Value[] {
    return this.items;
  }

  clone(): ListStorage {
    const copy = new ListStorage();
    copy.items = [...this.items];
    copy.lifo = this.lifo;
    return copy;
  }

  debugEntries(): [string, Value][] {
    return [
      ['\0SplDoublyLinkedList\0flags', BigInt(this.lifo ? 2 : 0)],
      ['\0SplDoublyLinkedList\0dllist', PhpArray.list(this.items)],
    ];
  }

  order(): number[] {
    const indexes = this.items.map((_, index) => index);
    return this.lifo ? indexes.toReversed() : indexes;
  }
}

const listOf = (object: PhpObject): ListStorage => object.internal as ListStorage;

function emptyError(kind: string, operation: string): never {
  throwError('RuntimeException', `Can't ${operation} from an empty ${kind}`);
}

const listMethods: NativeMethod[] = [
  {
    signature: 'push(mixed $value): void',
    impl: ({ thisObj, args }) => (listOf(thisObj).items.push(share(args[0])), null),
  },
  {
    signature: 'pop(): mixed',
    impl: ({ thisObj }) => {
      const list = listOf(thisObj);
      if (list.items.length === 0) emptyError('datastructure', 'pop');
      return list.items.pop() as Value;
    },
  },
  {
    signature: 'shift(): mixed',
    impl: ({ thisObj }) => {
      const list = listOf(thisObj);
      if (list.items.length === 0) emptyError('datastructure', 'shift');
      return list.items.shift() as Value;
    },
  },
  {
    signature: 'unshift(mixed $value): void',
    impl: ({ thisObj, args }) => (listOf(thisObj).items.unshift(share(args[0])), null),
  },
  {
    signature: 'top(): mixed',
    impl: ({ thisObj }) => {
      const list = listOf(thisObj);
      if (list.items.length === 0) emptyError('datastructure', 'peek at');
      return list.items.at(-1) as Value;
    },
  },
  {
    signature: 'bottom(): mixed',
    impl: ({ thisObj }) => {
      const list = listOf(thisObj);
      if (list.items.length === 0) emptyError('datastructure', 'peek at');
      return list.items[0];
    },
  },
  { signature: 'isEmpty(): bool', impl: ({ thisObj }) => listOf(thisObj).items.length === 0 },
  { signature: 'count(): int', impl: ({ thisObj }) => BigInt(listOf(thisObj).items.length) },
  { signature: 'toArray(): array', impl: ({ thisObj }) => PhpArray.list(listOf(thisObj).items) },
  {
    signature: 'offsetExists($index): bool',
    impl: ({ thisObj, args }) => {
      const index = Number(args[0]);
      return index >= 0 && index < listOf(thisObj).items.length;
    },
  },
  {
    signature: 'offsetGet($index): mixed',
    impl: ({ thisObj, args }) => {
      const list = listOf(thisObj);
      const index = Number(args[0]);
      if (index < 0 || index >= list.items.length)
        throwError('OutOfRangeException', 'SplDoublyLinkedList::offsetGet(): Argument #1 ($index) is out of range');
      return list.items[index];
    },
  },
  {
    signature: 'offsetSet($index, mixed $value): void',
    impl: ({ thisObj, args }) => {
      const list = listOf(thisObj);
      if (args[0] === null) list.items.push(share(args[1]));
      else {
        const index = Number(args[0]);
        if (index < 0 || index >= list.items.length)
          throwError('OutOfRangeException', 'SplDoublyLinkedList::offsetSet(): Argument #1 ($index) is out of range');
        list.items[index] = share(args[1]);
      }
      return null;
    },
  },
  {
    signature: 'offsetUnset($index): void',
    impl: ({ thisObj, args }) => {
      const list = listOf(thisObj);
      const index = Number(args[0]);
      if (index < 0 || index >= list.items.length)
        throwError('OutOfRangeException', 'SplDoublyLinkedList::offsetUnset(): Argument #1 ($index) is out of range');
      list.items.splice(index, 1);
      return null;
    },
  },
  { signature: 'rewind(): void', impl: ({ thisObj }) => ((listOf(thisObj).position = 0), null) },
  { signature: 'valid(): bool', impl: ({ thisObj }) => listOf(thisObj).position < listOf(thisObj).items.length },
  {
    signature: 'current(): mixed',
    impl: ({ thisObj }) => {
      const list = listOf(thisObj);
      const index = list.order()[list.position];
      return index === undefined ? null : list.items[index];
    },
  },
  {
    signature: 'key(): int',
    impl: ({ thisObj }) => {
      const list = listOf(thisObj);
      return BigInt(list.order()[list.position] ?? list.position);
    },
  },
  { signature: 'next(): void', impl: ({ thisObj }) => ((listOf(thisObj).position += 1), null) },
];

defineClass({
  name: 'SplDoublyLinkedList',
  interfaces: ['Iterator', 'Traversable', 'Countable', 'ArrayAccess', 'Serializable'],
  methods: [...listMethods, ...serializationMethods],
  createInternal: () => new ListStorage(),
});
defineClass({
  name: 'SplQueue',
  parent: 'SplDoublyLinkedList',
  methods: [
    {
      signature: 'enqueue(mixed $value): void',
      impl: ({ thisObj, args }) => (listOf(thisObj).items.push(share(args[0])), null),
    },
    {
      signature: 'dequeue(): mixed',
      impl: ({ thisObj }) => {
        const list = listOf(thisObj);
        if (list.items.length === 0) emptyError('datastructure', 'shift');
        return list.items.shift() as Value;
      },
    },
  ],
});
defineClass({
  name: 'SplStack',
  parent: 'SplDoublyLinkedList',
  createInternal: () => {
    const storage = new ListStorage();
    storage.lifo = true;
    return storage;
  },
});

// Heaps and priority queues ------------------------------------------------------------------------------------------

class HeapStorage {
  items: Value[] = [];
  serial = 0;
  priorities: { value: Value; priority: Value; serial: number }[] = [];

  held(): Value[] {
    return [...this.items, ...this.priorities.flatMap((entry) => [entry.value, entry.priority])];
  }

  clone(): HeapStorage {
    const copy = new HeapStorage();
    copy.items = [...this.items];
    copy.priorities = [...this.priorities];
    copy.serial = this.serial;
    return copy;
  }
}

const heapOf = (object: PhpObject): HeapStorage => object.internal as HeapStorage;

/** Sorts a heap's values so that the next to extract comes first, as the heap's compare method orders them. */
function heapOrder(object: PhpObject): Value[] {
  const heap = heapOf(object);
  return heap.items.toSorted((a, b) => Number(callMethod(object, 'compare', [b, a])) || 0);
}

function heapMethods(): NativeMethod[] {
  return [
    {
      signature: 'insert(mixed $value): true',
      impl: ({ thisObj, args }) => {
        heapOf(thisObj).items.push(share(args[0]));
        return true;
      },
    },
    {
      signature: 'extract(): mixed',
      impl: ({ thisObj }) => {
        const heap = heapOf(thisObj);
        if (heap.items.length === 0) emptyError('heap', 'extract');
        const [first] = heapOrder(thisObj);
        heap.items.splice(heap.items.indexOf(first), 1);
        return first;
      },
    },
    {
      signature: 'top(): mixed',
      impl: ({ thisObj }) => {
        if (heapOf(thisObj).items.length === 0) emptyError('heap', 'peek at');
        return heapOrder(thisObj)[0];
      },
    },
    { signature: 'count(): int', impl: ({ thisObj }) => BigInt(heapOf(thisObj).items.length) },
    { signature: 'isEmpty(): bool', impl: ({ thisObj }) => heapOf(thisObj).items.length === 0 },
    { signature: 'rewind(): void', impl: () => null },
    { signature: 'valid(): bool', impl: ({ thisObj }) => heapOf(thisObj).items.length > 0 },
    {
      signature: 'current(): mixed',
      impl: ({ thisObj }) => (heapOf(thisObj).items.length === 0 ? null : heapOrder(thisObj)[0]),
    },
    { signature: 'key(): int', impl: ({ thisObj }) => BigInt(heapOf(thisObj).items.length - 1) },
    {
      signature: 'next(): void',
      impl: ({ thisObj }) => {
        const heap = heapOf(thisObj);
        if (heap.items.length > 0) {
          const [first] = heapOrder(thisObj);
          heap.items.splice(heap.items.indexOf(first), 1);
        }
        return null;
      },
    },
  ];
}

defineClass({
  name: 'SplHeap',
  isAbstract: true,
  interfaces: ['Iterator', 'Traversable', 'Countable'],
  methods: [
    ...heapMethods(),
    {
      signature: 'compare(mixed $value1, mixed $value2): int',
      impl: () => 0n,
      isAbstract: true,
      visibility: 'protected',
    },
  ],
  createInternal: () => new HeapStorage(),
});
defineClass({
  name: 'SplMinHeap',
  parent: 'SplHeap',
  methods: [
    {
      signature: 'compare(mixed $value1, mixed $value2): int',
      impl: ({ args }) => BigInt(compare(args[1], args[0])),
      visibility: 'protected',
    },
  ],
});
defineClass({
  name: 'SplMaxHeap',
  parent: 'SplHeap',
  methods: [
    {
      signature: 'compare(mixed $value1, mixed $value2): int',
      impl: ({ args }) => BigInt(compare(args[0], args[1])),
      visibility: 'protected',
    },
  ],
});

/** Orders a priority queue's entries, highest priority first and earlier insertions first among equals. */
function priorityOrder(object: PhpObject): HeapStorage['priorities'] {
  const heap = heapOf(object);
  return heap.priorities.toSorted(
    (a, b) => Number(callMethod(object, 'compare', [b.priority, a.priority])) || a.serial - b.serial
  );
}

function extractPriority(object: PhpObject): Value {
  const heap = heapOf(object);
  if (heap.priorities.length === 0) emptyError('heap', 'extract');
  const [first] = priorityOrder(object);
  heap.priorities.splice(heap.priorities.indexOf(first), 1);
  return first.value;
}

defineClass({
  name: 'SplPriorityQueue',
  interfaces: ['Iterator', 'Traversable', 'Countable'],
  methods: [
    {
      signature: 'insert(mixed $value, mixed $priority): true',
      impl: ({ thisObj, args }) => {
        const heap = heapOf(thisObj);
        heap.priorities.push({ value: share(args[0]), priority: share(args[1]), serial: heap.serial++ });
        return true;
      },
    },
    { signature: 'extract(): mixed', impl: ({ thisObj }) => extractPriority(thisObj) },
    {
      signature: 'top(): mixed',
      impl: ({ thisObj }) => {
        if (heapOf(thisObj).priorities.length === 0) emptyError('heap', 'peek at');
        return priorityOrder(thisObj)[0].value;
      },
    },
    {
      signature: 'compare(mixed $priority1, mixed $priority2): int',
      impl: ({ args }) => BigInt(compare(args[0], args[1])),
    },
    { signature: 'count(): int', impl: ({ thisObj }) => BigInt(heapOf(thisObj).priorities.length) },
    { signature: 'isEmpty(): bool', impl: ({ thisObj }) => heapOf(thisObj).priorities.length === 0 },
    { signature: 'rewind(): void', impl: () => null },
    { signature: 'valid(): bool', impl: ({ thisObj }) => heapOf(thisObj).priorities.length > 0 },
    {
      signature: 'current(): mixed',
      impl: ({ thisObj }) => (heapOf(thisObj).priorities.length === 0 ? null : priorityOrder(thisObj)[0].value),
    },
    { signature: 'key(): int', impl: ({ thisObj }) => BigInt(heapOf(thisObj).priorities.length - 1) },
    {
      signature: 'next(): void',
      impl: ({ thisObj }) => (heapOf(thisObj).priorities.length > 0 ? extractPriority(thisObj) : null, null),
    },
  ],
  createInternal: () => new HeapStorage(),
});

// Fixed arrays and object storage ------------------------------------------------------------------------------------

class FixedStorage {
  items: Value[] = [];
  position = 0;

  held(): Value[] {
    return this.items;
  }

  clone(): FixedStorage {
    const copy = new FixedStorage();
    copy.items = [...this.items];
    return copy;
  }

  debugEntries(): [bigint, Value][] {
    return this.items.map((item, index) => [BigInt(index), item]);
  }
}

const fixedOf = (object: PhpObject): FixedStorage => object.internal as FixedStorage;

function fixedIndex(object: PhpObject, index: Value): number {
  if (typeof index !== 'bigint' && !(typeof index === 'string' && /^\d+$/.test(index))) {
    throwError('TypeError', `Cannot access offset of type ${debugType(index)} on SplFixedArray`);
  }
  const position = Number(index);
  if (position < 0 || position >= fixedOf(object).items.length)
    throwError('OutOfBoundsException', 'Index invalid or out of range');
  return position;
}

defineClass({
  name: 'SplFixedArray',
  interfaces: ['IteratorAggregate', 'Traversable', 'ArrayAccess', 'Countable', 'JsonSerializable'],
  methods: [
    {
      signature: '__construct(int $size = 0)',
      impl: ({ thisObj, args }) => {
        const size = Number(args[0] ?? 0n);
        if (size < 0)
          throwError(
            'ValueError',
            'SplFixedArray::__construct(): Argument #1 ($size) must be greater than or equal to 0'
          );
        fixedOf(thisObj).items = Array.from({ length: size }, () => null);
        return null;
      },
    },
    {
      signature: 'offsetExists($index): bool',
      impl: ({ thisObj, args }) => Number(args[0]) >= 0 && Number(args[0]) < fixedOf(thisObj).items.length,
    },
    {
      signature: 'offsetGet($index): mixed',
      impl: ({ thisObj, args }) => fixedOf(thisObj).items[fixedIndex(thisObj, args[0])],
    },
    {
      signature: 'offsetSet($index, mixed $value): void',
      impl: ({ thisObj, args }) => {
        if (args[0] === null) throwError('OutOfBoundsException', 'Index invalid or out of range');
        fixedOf(thisObj).items[fixedIndex(thisObj, args[0])] = share(args[1]);
        return null;
      },
    },
    {
      signature: 'offsetUnset($index): void',
      impl: ({ thisObj, args }) => {
        fixedOf(thisObj).items[fixedIndex(thisObj, args[0])] = null;
        return null;
      },
    },
    { signature: 'count(): int', impl: ({ thisObj }) => BigInt(fixedOf(thisObj).items.length) },
    { signature: 'getSize(): int', impl: ({ thisObj }) => BigInt(fixedOf(thisObj).items.length) },
    {
      signature: 'setSize(int $size): true',
      impl: ({ thisObj, args }) => {
        const storage = fixedOf(thisObj);
        const size = Number(args[0]);
        storage.items = Array.from({ length: size }, (_, index) => storage.items[index] ?? null);
        return true;
      },
    },
    { signature: 'toArray(): array', impl: ({ thisObj }) => PhpArray.list(fixedOf(thisObj).items) },
    { signature: 'jsonSerialize(): array', impl: ({ thisObj }) => PhpArray.list(fixedOf(thisObj).items) },
    {
      signature: 'getIterator(): Iterator',
      impl: ({ thisObj }) => {
        const iterator = createNative('ArrayIterator');
        iterator.internal = new ArrayStorage(PhpArray.list(fixedOf(thisObj).items));
        return iterator;
      },
    },
    {
      signature: 'fromArray(array $array, bool $preserveKeys = true): SplFixedArray',
      isStatic: true,
      impl: ({ args }) => {
        const object = createNative('SplFixedArray');
        const array = args[0] as PhpArray;
        if (args[1] === false) fixedOf(object).items = array.values();
        else {
          const keys = array.keys().map(Number);
          const size = keys.length === 0 ? 0 : Math.max(...keys) + 1;
          const items = Array.from({ length: size }, (): Value => null);
          for (const [key, value] of array.entries()) items[Number(key)] = value;
          fixedOf(object).items = items;
        }
        return object;
      },
    },
  ],
  createInternal: () => new FixedStorage(),
});

class ObjectStorage {
  entries = new Map<PhpObject, Value>();
  position = 0;

  held(): Value[] {
    return [...this.entries.keys(), ...this.entries.values()];
  }

  clone(): ObjectStorage {
    const copy = new ObjectStorage();
    copy.entries = new Map(this.entries);
    return copy;
  }

  debugEntries(): [string, Value][] {
    const storage = new PhpArray();
    for (const [object, data] of this.entries) {
      const entry = new PhpArray();
      entry.set('obj', object);
      entry.set('inf', data);
      storage.append(entry);
    }
    return [['\0SplObjectStorage\0storage', storage]];
  }
}

const objectStorageOf = (object: PhpObject): ObjectStorage => object.internal as ObjectStorage;

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
      `SplObjectStorage::offsetExists(): Argument #1 ($object) must be of type object, ${debugType(value)} given`
    );
  return value;
}

defineClass({
  name: 'SplObjectStorage',
  interfaces: ['Countable', 'SeekableIterator', 'Traversable', 'Iterator', 'Serializable', 'ArrayAccess'],
  methods: [
    ...serializationMethods,
    {
      signature: 'seek(int $offset): void',
      impl: ({ thisObj, args }) => {
        const storage = objectStorageOf(thisObj);
        const offset = Number(args[0]);
        if (offset < 0 || offset >= storage.entries.size)
          throwError('OutOfBoundsException', `Seek position ${offset} is out of range`);
        storage.position = offset;
        return null;
      },
    },
    {
      signature: 'attach(object $object, mixed $info = null): void',
      impl: ({ thisObj, args }) => {
        deprecatedMethod('attach', 'offsetSet');
        objectStorageOf(thisObj).entries.set(args[0] as PhpObject, args[1] ?? null);
        return null;
      },
    },
    {
      signature: 'detach(object $object): void',
      impl: ({ thisObj, args }) => {
        deprecatedMethod('detach', 'offsetUnset');
        objectStorageOf(thisObj).entries.delete(args[0] as PhpObject);
        return null;
      },
    },
    {
      signature: 'contains(object $object): bool',
      impl: ({ thisObj, args }) => {
        deprecatedMethod('contains', 'offsetExists');
        return objectStorageOf(thisObj).entries.has(args[0] as PhpObject);
      },
    },
    {
      signature: 'offsetExists($object): bool',
      impl: ({ thisObj, args }) => objectStorageOf(thisObj).entries.has(storageKey(args[0])),
    },
    {
      signature: 'offsetGet($object): mixed',
      impl: ({ thisObj, args }) => {
        const storage = objectStorageOf(thisObj);
        const key = storageKey(args[0]);
        if (!storage.entries.has(key)) throwError('UnexpectedValueException', 'Object not found');
        return storage.entries.get(key) as Value;
      },
    },
    {
      signature: 'offsetSet($object, mixed $info = null): void',
      impl: ({ thisObj, args }) => (objectStorageOf(thisObj).entries.set(storageKey(args[0]), args[1] ?? null), null),
    },
    {
      signature: 'offsetUnset($object): void',
      impl: ({ thisObj, args }) => (objectStorageOf(thisObj).entries.delete(storageKey(args[0])), null),
    },
    {
      signature: 'count(int $mode = COUNT_NORMAL): int',
      impl: ({ thisObj }) => BigInt(objectStorageOf(thisObj).entries.size),
    },
    { signature: 'rewind(): void', impl: ({ thisObj }) => ((objectStorageOf(thisObj).position = 0), null) },
    {
      signature: 'valid(): bool',
      impl: ({ thisObj }) => objectStorageOf(thisObj).position < objectStorageOf(thisObj).entries.size,
    },
    { signature: 'key(): int', impl: ({ thisObj }) => BigInt(objectStorageOf(thisObj).position) },
    {
      signature: 'current(): object',
      impl: ({ thisObj }) => [...objectStorageOf(thisObj).entries.keys()][objectStorageOf(thisObj).position] ?? null,
    },
    { signature: 'next(): void', impl: ({ thisObj }) => ((objectStorageOf(thisObj).position += 1), null) },
    {
      signature: 'getInfo(): mixed',
      impl: ({ thisObj }) => [...objectStorageOf(thisObj).entries.values()][objectStorageOf(thisObj).position] ?? null,
    },
    {
      signature: 'setInfo(mixed $info): void',
      impl: ({ thisObj, args }) => {
        const storage = objectStorageOf(thisObj);
        const key = [...storage.entries.keys()][storage.position];
        if (key) storage.entries.set(key, args[0]);
        return null;
      },
    },
  ],
  createInternal: () => new ObjectStorage(),
});
