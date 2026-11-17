// code-gauge-allow-file fileNcss 422 -- Holds the SPL data structures, which share their storage helpers.
// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { callCallback, callMethod } from './callables';
import { createObject } from './classes';
import { debugType, valueName } from './conversions';
import { deprecated, throwError, warn } from './errors';
import { iterate } from './interp';
import { defineClass, type NativeMethod } from './native';
import { compare, toInt, toKey } from './operators';
import { share } from './places';
import { PhpThrow, rt } from './runtime';
import { UnsupportedFeatureError } from './unsupported';
import { type Key, PhpArray, type PhpClass, PhpObject, type Value } from './values';

/** The storage of an ArrayObject or ArrayIterator: its own array, or the ArrayObject whose storage it uses. */
class ArrayStorage {
  position = 0;

  constructor(
    /** The class whose private `storage` property var_dump shows. */
    private readonly owner: string,
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
    if (this.backing) return new ArrayStorage(this.owner, this.own, this.backing);
    this.own.shared = true;
    return new ArrayStorage(this.owner, this.own);
  }

  writable(): PhpArray {
    if (this.backing) return storageOf(this.backing).writable();
    if (this.own.shared) this.own = this.own.copy();
    return this.own;
  }

  debugEntries(): [string, Value][] {
    return [[`\0${this.owner}\0storage`, this.backing ?? this.own]];
  }

  /** The property table json_encode reads, which PHP's ArrayObject and ArrayIterator give as their storage. */
  properties(): PhpArray {
    return this.array;
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

function arrayStorage(value: Value | undefined, name: string): ArrayStorage {
  if (value === undefined) return new ArrayStorage(name, new PhpArray());
  if (value instanceof PhpArray) {
    value.shared = true;
    return new ArrayStorage(name, value);
  }
  if (!(value instanceof PhpObject))
    throwError(
      'TypeError',
      `${name}::__construct(): Argument #1 ($array) must be of type array, ${valueName(value)} given`
    );
  deprecated(
    `${name}::__construct(): Using an object as a backing array for ${name} is deprecated, as it allows violating class constraints and invariants`
  );
  if (value.internal instanceof ArrayStorage && value.cls.isSubclassOf(rt().classes.get('arrayobject') as PhpClass))
    return new ArrayStorage(name, new PhpArray(), value);
  const array = new PhpArray();
  for (const [key, item] of iterate(value)) array.set(toKey(key), item);
  return new ArrayStorage(name, array);
}

function arrayMethods(name: string): NativeMethod[] {
  return [
    {
      signature: '__construct(array|object $array = [], int $flags = 0)',
      impl: ({ thisObj, args }) => {
        thisObj.internal = arrayStorage(args[0], name);
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
    {
      signature: 'key(): string|int|null',
      impl: ({ thisObj }) => keyAt(storageOf(thisObj)) ?? null,
    },
    {
      signature: 'next(): void',
      impl: ({ thisObj }) => ((storageOf(thisObj).position += 1), null),
    },
    {
      signature: 'rewind(): void',
      impl: ({ thisObj }) => ((storageOf(thisObj).position = 0), null),
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
  createInternal: () => new ArrayStorage('ArrayIterator', new PhpArray()),
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
        iterator.internal = new ArrayStorage('ArrayIterator', new PhpArray(), thisObj);
        return iterator;
      },
    },
  ],
  createInternal: () => new ArrayStorage('ArrayObject', new PhpArray()),
});

function createNative(name: string): PhpObject {
  return createObject(rt().classes.get(name.toLowerCase()) as never);
}

// Doubly linked lists, stacks, and queues ----------------------------------------------------------------------------

const IT_MODE_LIFO = 2;
const IT_MODE_DELETE = 1;
/** The flag of SplStack and SplQueue, whose LIFO bit setIteratorMode may not change. */
const IT_FIX = 4;

/** An element of a list, which the traverse pointer keeps holding after the list drops it, as PHP's does. */
interface ListNode {
  v: Value;
}

class ListStorage {
  nodes: ListNode[] = [];
  flags = 0;
  pointer: ListNode | undefined;
  position = 0;

  constructor(flags = 0) {
    this.flags = flags;
  }

  held(): Value[] {
    return this.nodes.map((node) => node.v);
  }

  clone(): ListStorage {
    const copy = new ListStorage(this.flags);
    copy.nodes = this.nodes.map((node) => ({ v: node.v }));
    copy.pointer = copy.nodes[0];
    return copy;
  }

  debugEntries(): [string, Value][] {
    return [
      ['\0SplDoublyLinkedList\0flags', BigInt(this.flags)],
      ['\0SplDoublyLinkedList\0dllist', PhpArray.list(this.held())],
    ];
  }

  /** The node at `index`, counted from the top in LIFO mode as PHP's offset functions count. */
  nodeAt(index: number): ListNode {
    return this.nodes[this.flags & IT_MODE_LIFO ? this.nodes.length - 1 - index : index];
  }

  rewind(): void {
    const lifo = (this.flags & IT_MODE_LIFO) !== 0;
    this.position = lifo ? this.nodes.length - 1 : 0;
    this.pointer = lifo ? this.nodes.at(-1) : this.nodes[0];
  }

  /** Transcribes spl_dllist_it_helper_move_forward, which `next` calls with the list's flags and `prev` with LIFO flipped. */
  moveForward(flags: number): void {
    if (!this.pointer) return;
    const index = this.nodes.indexOf(this.pointer);
    if (flags & IT_MODE_LIFO) {
      this.pointer = index > 0 ? this.nodes[index - 1] : undefined;
      this.position--;
      if (flags & IT_MODE_DELETE) this.nodes.pop();
    } else {
      this.pointer = index === -1 ? undefined : this.nodes[index + 1];
      if (flags & IT_MODE_DELETE) this.nodes.shift();
      else this.position++;
    }
  }
}

const listOf = (object: PhpObject): ListStorage => object.internal as ListStorage;

function nonEmptyList(object: PhpObject, operation: string): ListStorage {
  const list = listOf(object);
  if (list.nodes.length === 0) throwError('RuntimeException', `Can't ${operation} an empty datastructure`);
  return list;
}

function checkListIndex(list: ListStorage, index: Value, method: string, inclusive = false): number {
  const position = Number(index);
  if (position < 0 || position > list.nodes.length - (inclusive ? 0 : 1))
    throwError('OutOfRangeException', `SplDoublyLinkedList::${method}(): Argument #1 ($index) is out of range`);
  return position;
}

const listMethods: NativeMethod[] = [
  {
    signature: 'push(mixed $value): void',
    impl: ({ thisObj, args }) => (listOf(thisObj).nodes.push({ v: share(args[0]) }), null),
  },
  {
    signature: 'pop(): mixed',
    impl: ({ thisObj }) => (nonEmptyList(thisObj, 'pop from').nodes.pop() as ListNode).v,
  },
  {
    signature: 'shift(): mixed',
    impl: ({ thisObj }) => (nonEmptyList(thisObj, 'shift from').nodes.shift() as ListNode).v,
  },
  {
    signature: 'unshift(mixed $value): void',
    impl: ({ thisObj, args }) => (listOf(thisObj).nodes.unshift({ v: share(args[0]) }), null),
  },
  {
    signature: 'top(): mixed',
    impl: ({ thisObj }) => (nonEmptyList(thisObj, 'peek at').nodes.at(-1) as ListNode).v,
  },
  {
    signature: 'bottom(): mixed',
    impl: ({ thisObj }) => nonEmptyList(thisObj, 'peek at').nodes[0].v,
  },
  { signature: 'isEmpty(): bool', impl: ({ thisObj }) => listOf(thisObj).nodes.length === 0 },
  { signature: 'count(): int', impl: ({ thisObj }) => BigInt(listOf(thisObj).nodes.length) },
  {
    signature: 'setIteratorMode(int $mode): int',
    impl: ({ thisObj, args }) => {
      const list = listOf(thisObj);
      const mode = Number(args[0]);
      if (list.flags & IT_FIX && (list.flags & IT_MODE_LIFO) !== (mode & IT_MODE_LIFO))
        throwError('RuntimeException', "Iterators' LIFO/FIFO modes for SplStack/SplQueue objects are frozen");
      list.flags = (mode & (IT_MODE_LIFO | IT_MODE_DELETE)) | (list.flags & IT_FIX);
      return BigInt(list.flags);
    },
  },
  { signature: 'getIteratorMode(): int', impl: ({ thisObj }) => BigInt(listOf(thisObj).flags) },
  {
    signature: 'offsetExists(int $index): bool',
    impl: ({ thisObj, args }) => {
      const index = Number(args[0]);
      return index >= 0 && index < listOf(thisObj).nodes.length;
    },
  },
  {
    signature: 'offsetGet(int $index): mixed',
    impl: ({ thisObj, args }) => {
      const list = listOf(thisObj);
      return list.nodeAt(checkListIndex(list, args[0], 'offsetGet')).v;
    },
  },
  {
    signature: 'offsetSet(?int $index, mixed $value): void',
    impl: ({ thisObj, args }) => {
      const list = listOf(thisObj);
      if (args[0] === null) list.nodes.push({ v: share(args[1]) });
      else list.nodeAt(checkListIndex(list, args[0], 'offsetSet')).v = share(args[1]);
      return null;
    },
  },
  {
    signature: 'offsetUnset(int $index): void',
    impl: ({ thisObj, args }) => {
      const list = listOf(thisObj);
      const node = list.nodeAt(checkListIndex(list, args[0], 'offsetUnset'));
      list.nodes.splice(list.nodes.indexOf(node), 1);
      if (list.pointer === node) list.pointer = undefined;
      return null;
    },
  },
  {
    signature: 'add(int $index, mixed $value): void',
    impl: ({ thisObj, args }) => {
      const list = listOf(thisObj);
      const index = checkListIndex(list, args[0], 'add', true);
      if (index === list.nodes.length) list.nodes.push({ v: share(args[1]) });
      else list.nodes.splice(list.nodes.indexOf(list.nodeAt(index)), 0, { v: share(args[1]) });
      return null;
    },
  },
  { signature: 'rewind(): void', impl: ({ thisObj }) => (listOf(thisObj).rewind(), null) },
  { signature: 'valid(): bool', impl: ({ thisObj }) => listOf(thisObj).pointer !== undefined },
  { signature: 'current(): mixed', impl: ({ thisObj }) => listOf(thisObj).pointer?.v ?? null },
  { signature: 'key(): int', impl: ({ thisObj }) => BigInt(listOf(thisObj).position) },
  {
    signature: 'next(): void',
    impl: ({ thisObj }) => (listOf(thisObj).moveForward(listOf(thisObj).flags), null),
  },
  {
    signature: 'prev(): void',
    impl: ({ thisObj }) => (listOf(thisObj).moveForward(listOf(thisObj).flags ^ IT_MODE_LIFO), null),
  },
];

defineClass({
  name: 'SplDoublyLinkedList',
  interfaces: ['Iterator', 'Traversable', 'Countable', 'ArrayAccess', 'Serializable'],
  methods: [...listMethods, ...serializationMethods],
  consts: { IT_MODE_LIFO: 2n, IT_MODE_FIFO: 0n, IT_MODE_DELETE: 1n, IT_MODE_KEEP: 0n },
  createInternal: () => new ListStorage(),
});
defineClass({
  name: 'SplQueue',
  parent: 'SplDoublyLinkedList',
  methods: [
    {
      signature: 'enqueue(mixed $value): void',
      impl: ({ thisObj, args }) => (listOf(thisObj).nodes.push({ v: share(args[0]) }), null),
    },
    {
      signature: 'dequeue(): mixed',
      impl: ({ thisObj }) => (nonEmptyList(thisObj, 'shift from').nodes.shift() as ListNode).v,
    },
  ],
  createInternal: () => new ListStorage(IT_FIX),
});
defineClass({
  name: 'SplStack',
  parent: 'SplDoublyLinkedList',
  createInternal: () => new ListStorage(IT_FIX | IT_MODE_LIFO),
});

// Heaps and priority queues ------------------------------------------------------------------------------------------

interface QueueEntry {
  data: Value;
  priority: Value;
}

const EXTR_DATA = 1;
const EXTR_PRIORITY = 2;
const EXTR_BOTH = 3;

/** Transcribes ext/spl/spl_heap.c's binary heap, whose sifting decides the order of equal elements. */
type HeapElement = Value | QueueEntry;

class HeapStorage {
  elements: HeapElement[] = [];
  /** The extract flags of a priority queue, or 0 for a heap. */
  flags: number;
  corrupted = false;
  writeLocked = false;
  /** The exception a comparison threw while sifting, which PHP rethrows after the sift ends. */
  private pending: unknown;

  constructor(
    /** The class whose private properties var_dump shows. */
    private readonly owner: string,
    private readonly compareMethod: (a: HeapElement, b: HeapElement) => Value,
    flags = 0
  ) {
    this.flags = flags;
  }

  held(): Value[] {
    return this.elements.flatMap((element) => (isEntry(element) ? [element.data, element.priority] : [element]));
  }

  clone(): HeapStorage {
    const copy = new HeapStorage(this.owner, this.compareMethod, this.flags);
    copy.elements = [...this.elements];
    copy.corrupted = this.corrupted;
    return copy;
  }

  debugEntries(): [string, Value][] {
    const heap = PhpArray.list(
      this.elements.map((element) => (isEntry(element) ? extractEntry(element, EXTR_BOTH) : element))
    );
    return [
      [`\0${this.owner}\0flags`, BigInt(this.flags)],
      [`\0${this.owner}\0isCorrupted`, this.corrupted],
      [`\0${this.owner}\0heap`, heap],
    ];
  }

  validate(write: boolean): void {
    if (this.corrupted) throwError('RuntimeException', 'Heap is corrupted, heap properties are no longer ensured.');
    if (write && this.writeLocked)
      throwError('RuntimeException', 'Heap cannot be changed when it is already being modified.');
  }

  insert(element: HeapElement): void {
    this.writeLocked = true;
    let position = this.elements.length;
    while (position > 0 && this.compare(this.elements[(position - 1) >> 1], element) < 0) {
      this.elements[position] = this.elements[(position - 1) >> 1];
      position = (position - 1) >> 1;
    }
    this.elements[position] = element;
    this.finishSift();
  }

  /** Removes the top element, or returns undefined when the heap is empty. */
  deleteTop(): HeapElement | undefined {
    if (this.elements.length === 0) return undefined;
    const limit = (this.elements.length - 1) >> 1;
    this.writeLocked = true;
    const top = this.elements[0];
    const count = this.elements.length - 1;
    const bottom = this.elements[count];
    let parent = 0;
    while (parent < limit) {
      let child = parent * 2 + 1;
      if (child !== count && this.compare(this.elements[child + 1], this.elements[child]) > 0) child++;
      if (this.compare(bottom, this.elements[child]) >= 0) break;
      this.elements[parent] = this.elements[child];
      parent = child;
    }
    this.elements[parent] = bottom;
    this.elements.length = count;
    this.finishSift();
    return top;
  }

  private compare(a: HeapElement, b: HeapElement): number {
    if (this.pending !== undefined) return 0;
    try {
      return Math.sign(Number(toInt(this.compareMethod(a, b))));
    } catch (error) {
      if (!(error instanceof PhpThrow)) throw error;
      this.pending = error;
      return 0;
    }
  }

  private finishSift(): void {
    this.writeLocked = false;
    if (this.pending === undefined) return;
    const error = this.pending;
    this.pending = undefined;
    this.corrupted = true;
    throw error;
  }
}

function isEntry(element: Value | QueueEntry): element is QueueEntry {
  return (
    element !== null && typeof element === 'object' && !(element instanceof PhpArray) && !(element instanceof PhpObject)
  );
}

function extractEntry(entry: QueueEntry, flags: number): Value {
  if ((flags & EXTR_BOTH) === EXTR_BOTH) {
    const both = new PhpArray();
    both.set('data', entry.data);
    both.set('priority', entry.priority);
    return both;
  }
  return flags & EXTR_DATA ? entry.data : entry.priority;
}

const heapOf = (object: PhpObject): HeapStorage => object.internal as HeapStorage;

/** The value a heap method returns for an element: the element of a heap, or what a queue's extract flags select. */
function heapValue(heap: HeapStorage, element: Value | QueueEntry): Value {
  return isEntry(element) ? extractEntry(element, heap.flags) : element;
}

function heapMethods(): NativeMethod[] {
  return [
    {
      signature: 'extract(): mixed',
      impl: ({ thisObj }) => {
        const heap = heapOf(thisObj);
        heap.validate(true);
        const top = heap.deleteTop();
        if (top === undefined) throwError('RuntimeException', "Can't extract from an empty heap");
        return heapValue(heap, top);
      },
    },
    {
      signature: 'top(): mixed',
      impl: ({ thisObj }) => {
        const heap = heapOf(thisObj);
        heap.validate(false);
        if (heap.elements.length === 0) throwError('RuntimeException', "Can't peek at an empty heap");
        return heapValue(heap, heap.elements[0]);
      },
    },
    { signature: 'count(): int', impl: ({ thisObj }) => BigInt(heapOf(thisObj).elements.length) },
    { signature: 'isEmpty(): bool', impl: ({ thisObj }) => heapOf(thisObj).elements.length === 0 },
    { signature: 'rewind(): void', impl: () => null },
    { signature: 'valid(): bool', impl: ({ thisObj }) => heapOf(thisObj).elements.length > 0 },
    {
      signature: 'current(): mixed',
      impl: ({ thisObj }) => {
        const heap = heapOf(thisObj);
        return heap.elements.length === 0 ? null : heapValue(heap, heap.elements[0]);
      },
    },
    { signature: 'key(): int', impl: ({ thisObj }) => BigInt(heapOf(thisObj).elements.length - 1) },
    {
      signature: 'next(): void',
      impl: ({ thisObj }) => {
        const heap = heapOf(thisObj);
        heap.validate(true);
        heap.deleteTop();
        return null;
      },
    },
    {
      signature: 'recoverFromCorruption(): true',
      impl: ({ thisObj }) => ((heapOf(thisObj).corrupted = false), true),
    },
    { signature: 'isCorrupted(): bool', impl: ({ thisObj }) => heapOf(thisObj).corrupted },
  ];
}

defineClass({
  name: 'SplHeap',
  isAbstract: true,
  interfaces: ['Iterator', 'Traversable', 'Countable'],
  methods: [
    ...heapMethods(),
    {
      signature: 'insert(mixed $value): true',
      impl: ({ thisObj, args }) => {
        const heap = heapOf(thisObj);
        heap.validate(true);
        heap.insert(share(args[0]));
        return true;
      },
    },
    {
      signature: 'compare(mixed $value1, mixed $value2): int',
      impl: () => 0n,
      isAbstract: true,
      visibility: 'protected',
    },
  ],
  createInternal: (object) =>
    new HeapStorage('SplHeap', (a, b) => callMethod(object, 'compare', [a as Value, b as Value])),
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

defineClass({
  name: 'SplPriorityQueue',
  interfaces: ['Iterator', 'Traversable', 'Countable'],
  consts: {
    EXTR_BOTH: BigInt(EXTR_BOTH),
    EXTR_PRIORITY: BigInt(EXTR_PRIORITY),
    EXTR_DATA: BigInt(EXTR_DATA),
  },
  methods: [
    ...heapMethods(),
    {
      signature: 'insert(mixed $value, mixed $priority): true',
      impl: ({ thisObj, args }) => {
        const heap = heapOf(thisObj);
        heap.validate(true);
        heap.insert({ data: share(args[0]), priority: share(args[1]) });
        return true;
      },
    },
    {
      signature: 'compare(mixed $priority1, mixed $priority2): int',
      impl: ({ args }) => BigInt(compare(args[0], args[1])),
    },
    {
      signature: 'setExtractFlags(int $flags): int',
      impl: ({ thisObj, args }) => {
        const flags = Number(args[0]) & EXTR_BOTH;
        if (flags === 0) throwError('RuntimeException', 'Must specify at least one extract flag');
        heapOf(thisObj).flags = flags;
        return BigInt(flags);
      },
    },
    { signature: 'getExtractFlags(): int', impl: ({ thisObj }) => BigInt(heapOf(thisObj).flags) },
  ],
  createInternal: (object) =>
    new HeapStorage(
      'SplPriorityQueue',
      (a, b) => callMethod(object, 'compare', [(a as QueueEntry).priority, (b as QueueEntry).priority]),
      EXTR_DATA
    ),
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

/** Transcribes spl_offset_convert_to_ulong, whose negative results fall out of range. */
function fixedIndex(object: PhpObject, index: Value): number {
  let position: number;
  if (typeof index === 'bigint' || typeof index === 'boolean') position = Number(index);
  else if (typeof index === 'number') position = Number(toKey(index));
  else if (typeof index === 'string' && /^(?:0|-?[1-9]\d*)$/.test(index)) position = Number(index);
  else throwError('TypeError', `Cannot access offset of type ${debugType(index)} on SplFixedArray`);
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
        // `$array[] = $value` passes null, which PHP rejects before converting the offset.
        if (args[0] === null) throwError('Error', '[] operator not supported for SplFixedArray');
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
    {
      signature: 'jsonSerialize(): array',
      impl: ({ thisObj }) => PhpArray.list(fixedOf(thisObj).items),
    },
    {
      signature: 'getIterator(): Iterator',
      impl: ({ thisObj }) => {
        const iterator = createNative('ArrayIterator');
        iterator.internal = new ArrayStorage('ArrayIterator', PhpArray.list(fixedOf(thisObj).items));
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
      `SplObjectStorage::offsetExists(): Argument #1 ($object) must be of type object, ${valueName(value)} given`
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
    {
      signature: 'rewind(): void',
      impl: ({ thisObj }) => ((objectStorageOf(thisObj).position = 0), null),
    },
    {
      signature: 'valid(): bool',
      impl: ({ thisObj }) => objectStorageOf(thisObj).position < objectStorageOf(thisObj).entries.size,
    },
    { signature: 'key(): int', impl: ({ thisObj }) => BigInt(objectStorageOf(thisObj).position) },
    {
      signature: 'current(): object',
      impl: ({ thisObj }) => [...objectStorageOf(thisObj).entries.keys()][objectStorageOf(thisObj).position] ?? null,
    },
    {
      signature: 'next(): void',
      impl: ({ thisObj }) => ((objectStorageOf(thisObj).position += 1), null),
    },
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
