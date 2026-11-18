// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { callMethod } from './callables';
import { createObject } from './classes';
import { debugType } from './conversions';
import { throwError } from './errors';
import { magicSerializationMethods, serializationMethods } from './libArrayObject';
import './libObjectStorage';
import { liveArrayIterator } from './libIterators';
import './libRegexIterator';
import './libRecursiveIterators';
import { defineClass, type NativeMethod } from './native';
import { compare, toInt, toKey } from './operators';
import { share } from './places';
import { PhpThrow, rt } from './runtime';
import { UnsupportedFeatureError } from './unsupported';
import { dropped, NativeValueIndex, PhpArray, type PhpClass, PhpObject, type Value } from './values';

/** Lists methods in the order PHP declares them, which get_class_methods shows. */
function inPhpOrder(methods: NativeMethod[], names: string): NativeMethod[] {
  return names.split(' ').map((name) => {
    const method = methods.find((candidate) => candidate.signature.startsWith(`${name}(`));
    if (!method) throw new Error(`Unknown method ${name}`);
    return method;
  });
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
  readonly nativeValues = new NativeValueIndex();
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
    rt().allocate(this.nodes.length);
    const copy = new ListStorage(this.flags);
    copy.nodes = this.nodes.map((node) => copy.node(node.v));
    copy.pointer = copy.nodes[0];
    return copy;
  }

  node(value: Value): ListNode {
    this.nativeValues.add(value);
    return { v: value };
  }

  setNode(node: ListNode, value: Value): void {
    const old = node.v;
    node.v = value;
    this.nativeValues.add(value);
    this.nativeValues.delete(old);
    dropped(old);
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
    let removed: ListNode | undefined;
    const index = this.nodes.indexOf(this.pointer);
    if (flags & IT_MODE_LIFO) {
      this.pointer = index > 0 ? this.nodes[index - 1] : undefined;
      this.position--;
      if (flags & IT_MODE_DELETE) removed = this.nodes.pop();
    } else {
      this.pointer = index === -1 ? undefined : this.nodes[index + 1];
      if (flags & IT_MODE_DELETE) removed = this.nodes.shift();
      else this.position++;
    }
    if (removed) {
      this.nativeValues.delete(removed.v);
      dropped(removed.v);
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

function removeListNode(list: ListStorage, first: boolean): Value {
  const node = (first ? list.nodes.shift() : list.nodes.pop()) as ListNode;
  const value = node.v;
  node.v = null;
  list.nativeValues.delete(value);
  return value;
}

const listMethods: NativeMethod[] = [
  {
    signature: 'add(int $index, mixed $value): void',
    impl: ({ thisObj, args }) => {
      const list = listOf(thisObj);
      const index = checkListIndex(list, args[0], 'add', true);
      rt().allocate(1);
      if (index === list.nodes.length) list.nodes.push(list.node(args[1]));
      else list.nodes.splice(list.nodes.indexOf(list.nodeAt(index)), 0, list.node(args[1]));
      return null;
    },
  },
  {
    signature: 'pop(): mixed',
    impl: ({ thisObj }) => removeListNode(nonEmptyList(thisObj, 'pop from'), false),
  },
  {
    signature: 'shift(): mixed',
    impl: ({ thisObj }) => removeListNode(nonEmptyList(thisObj, 'shift from'), true),
  },
  {
    signature: 'push(mixed $value): void',
    impl: ({ thisObj, args }) => (rt().allocate(1), listOf(thisObj).nodes.push(listOf(thisObj).node(args[0])), null),
  },
  {
    signature: 'unshift(mixed $value): void',
    impl: ({ thisObj, args }) => (rt().allocate(1), listOf(thisObj).nodes.unshift(listOf(thisObj).node(args[0])), null),
  },
  {
    signature: 'top(): mixed',
    impl: ({ thisObj }) => (nonEmptyList(thisObj, 'peek at').nodes.at(-1) as ListNode).v,
  },
  {
    signature: 'bottom(): mixed',
    impl: ({ thisObj }) => nonEmptyList(thisObj, 'peek at').nodes[0].v,
  },
  { signature: 'count(): int', impl: ({ thisObj }) => BigInt(listOf(thisObj).nodes.length) },
  { signature: 'isEmpty(): bool', impl: ({ thisObj }) => listOf(thisObj).nodes.length === 0 },
  {
    signature: 'setIteratorMode(int $mode): int',
    impl: ({ thisObj, args }) => {
      const list = listOf(thisObj);
      const mode = Number((args[0] as bigint) & BigInt(IT_MODE_LIFO | IT_MODE_DELETE));
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
      const compound = rt().takeReadWriteDimension(thisObj);
      const list = listOf(thisObj);
      const index = Number(args[0]);
      if (compound && (index < 0 || index >= list.nodes.length)) compound.missing = true;
      return list.nodeAt(checkListIndex(list, args[0], 'offsetGet')).v;
    },
  },
  {
    signature: 'offsetSet(?int $index, mixed $value): void',
    impl: ({ thisObj, args }) => {
      const list = listOf(thisObj);
      if (args[0] === null) {
        rt().allocate(1);
        list.nodes.push(list.node(args[1]));
      } else list.setNode(list.nodeAt(checkListIndex(list, args[0], 'offsetSet')), args[1]);
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
      list.nativeValues.delete(node.v);
      dropped(node.v);
      return null;
    },
  },
  { signature: 'rewind(): void', impl: ({ thisObj }) => (listOf(thisObj).rewind(), null) },
  { signature: 'current(): mixed', impl: ({ thisObj }) => listOf(thisObj).pointer?.v ?? null },
  { signature: 'key(): int', impl: ({ thisObj }) => BigInt(listOf(thisObj).position) },
  {
    signature: 'prev(): void',
    impl: ({ thisObj }) => (listOf(thisObj).moveForward(listOf(thisObj).flags ^ IT_MODE_LIFO), null),
  },
  {
    signature: 'next(): void',
    impl: ({ thisObj }) => (listOf(thisObj).moveForward(listOf(thisObj).flags), null),
  },
  { signature: 'valid(): bool', impl: ({ thisObj }) => listOf(thisObj).pointer !== undefined },
];

defineClass({
  name: 'SplDoublyLinkedList',
  interfaces: ['Iterator', 'Traversable', 'Countable', 'ArrayAccess', 'Serializable'],
  methods: [...listMethods, ...serializationMethods, ...magicSerializationMethods],
  consts: { IT_MODE_LIFO: 2n, IT_MODE_FIFO: 0n, IT_MODE_DELETE: 1n, IT_MODE_KEEP: 0n },
  createInternal: () => new ListStorage(),
});
defineClass({
  name: 'SplQueue',
  parent: 'SplDoublyLinkedList',
  methods: [
    {
      signature: 'enqueue(mixed $value): void',
      impl: ({ thisObj, args }) => (rt().allocate(1), listOf(thisObj).nodes.push(listOf(thisObj).node(args[0])), null),
    },
    {
      signature: 'dequeue(): mixed',
      impl: ({ thisObj }) => removeListNode(nonEmptyList(thisObj, 'shift from'), true),
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
  readonly nativeValues = new NativeValueIndex();
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

  clone(object: PhpObject): HeapStorage {
    const fresh = object.cls.createInternal?.(object) as HeapStorage;
    const copy = new HeapStorage(this.owner, fresh.compareMethod, this.flags);
    rt().allocate(this.elements.length);
    copy.elements = this.elements.map((element) =>
      isEntry(element) ? { data: share(element.data), priority: share(element.priority) } : share(element)
    );
    copy.nativeValues.reset(copy.held());
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
    rt().allocate(1, this.elements.length + 1);
    this.writeLocked = true;
    let position = this.elements.length;
    while (position > 0 && this.compare(this.elements[(position - 1) >> 1], element) < 0) {
      this.elements[position] = this.elements[(position - 1) >> 1];
      position = (position - 1) >> 1;
    }
    this.elements[position] = element;
    for (const value of isEntry(element) ? [element.data, element.priority] : [element]) this.nativeValues.add(value);
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
    const removed = isEntry(top) ? [top.data, top.priority] : [top];
    for (const value of removed) this.nativeValues.delete(value);
    rt().release(removed, true);
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
  methods: inPhpOrder(
    [
      ...heapMethods(),
      ...magicSerializationMethods,
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
    'extract insert top count isEmpty rewind current key next valid recoverFromCorruption isCorrupted __serialize __unserialize compare'
  ),
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
  methods: inPhpOrder(
    [
      ...heapMethods(),
      ...magicSerializationMethods,
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
          const flags = Number((args[0] as bigint) & BigInt(EXTR_BOTH));
          if (flags === 0) throwError('RuntimeException', 'Must specify at least one extract flag');
          heapOf(thisObj).flags = flags;
          return BigInt(flags);
        },
      },
      { signature: 'getExtractFlags(): int', impl: ({ thisObj }) => BigInt(heapOf(thisObj).flags) },
    ],
    'compare insert setExtractFlags top extract count isEmpty rewind current key next valid recoverFromCorruption isCorrupted getExtractFlags __serialize __unserialize'
  ),
  createInternal: (object) =>
    new HeapStorage(
      'SplPriorityQueue',
      (a, b) => callMethod(object, 'compare', [(a as QueueEntry).priority, (b as QueueEntry).priority]),
      EXTR_DATA
    ),
});

// Fixed arrays and object storage ------------------------------------------------------------------------------------

class FixedStorage {
  readonly nativeValues = new NativeValueIndex();
  private data: Value[] = [];
  get items(): Value[] {
    return this.data;
  }
  set items(items: Value[]) {
    const old = this.data;
    this.data = items;
    this.nativeValues.reset(items);
    rt().release(old);
  }

  set(index: number, value: Value): void {
    const old = this.data[index];
    this.data[index] = value;
    this.nativeValues.add(value);
    this.nativeValues.delete(old);
    dropped(old);
  }
  position = 0;

  held(): Value[] {
    return this.items;
  }

  clone(): FixedStorage {
    const copy = new FixedStorage();
    rt().allocate(this.items.length);
    copy.items = this.items.map(share);
    return copy;
  }

  debugEntries(): [bigint, Value][] {
    return this.items.map((item, index) => [BigInt(index), item]);
  }

  exportEntries(): [bigint, Value][] {
    return this.debugEntries();
  }
}

const fixedOf = (object: PhpObject): FixedStorage => object.internal as FixedStorage;

/** Transcribes spl_offset_convert_to_ulong, whose negative results fall out of range. */
function fixedIndex(object: PhpObject, index: Value, onInvalid?: () => void): number {
  const position = fixedOffset(index);
  if (position < 0 || position >= fixedOf(object).items.length) {
    onInvalid?.();
    throwError('OutOfBoundsException', 'Index invalid or out of range');
  }
  return position;
}

function fixedOffset(index: Value): number {
  let position: number;
  if (typeof index === 'bigint' || typeof index === 'boolean') position = Number(index);
  else if (typeof index === 'number') position = Number(toKey(index));
  else if (typeof index === 'string' && /^(?:0|-?[1-9]\d*)$/.test(index)) position = Number(index);
  else throwError('TypeError', `Cannot access offset of type ${debugType(index)} on SplFixedArray`);
  return position;
}

defineClass({
  name: 'SplFixedArray',
  interfaces: ['IteratorAggregate', 'Traversable', 'ArrayAccess', 'Countable', 'JsonSerializable'],
  methods: inPhpOrder(
    [
      ...magicSerializationMethods,
      {
        signature: '__wakeup(): void',
        impl: () => {
          throw new UnsupportedFeatureError('直列化');
        },
      },
      {
        signature: '__construct(int $size = 0)',
        impl: ({ thisObj, args }) => {
          const size = Number(args[0] ?? 0n);
          if (size < 0)
            throwError(
              'ValueError',
              'SplFixedArray::__construct(): Argument #1 ($size) must be greater than or equal to 0'
            );
          rt().allocate(size);
          fixedOf(thisObj).items = Array.from({ length: size }, () => null);
          return null;
        },
      },
      {
        signature: 'offsetExists($index): bool',
        impl: ({ thisObj, args }) => {
          const index = fixedOffset(args[0]);
          return index >= 0 && index < fixedOf(thisObj).items.length && fixedOf(thisObj).items[index] !== null;
        },
      },
      {
        signature: 'offsetGet($index): mixed',
        impl: ({ thisObj, args }) => {
          const compound = rt().takeReadWriteDimension(thisObj);
          return fixedOf(thisObj).items[
            fixedIndex(thisObj, args[0], () => {
              if (compound) compound.missing = true;
            })
          ];
        },
      },
      {
        signature: 'offsetSet($index, mixed $value): void',
        impl: ({ thisObj, args }) => {
          // `$array[] = $value` passes null, which PHP rejects before converting the offset.
          if (args[0] === null) throwError('Error', '[] operator not supported for SplFixedArray');
          fixedOf(thisObj).set(fixedIndex(thisObj, args[0]), args[1]);
          return null;
        },
      },
      {
        signature: 'offsetUnset($index): void',
        impl: ({ thisObj, args }) => {
          fixedOf(thisObj).set(fixedIndex(thisObj, args[0]), null);
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
          if (size < 0)
            throwError(
              'ValueError',
              'SplFixedArray::setSize(): Argument #1 ($size) must be greater than or equal to 0'
            );
          rt().allocate(Math.max(0, size - storage.items.length));
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
        impl: ({ thisObj }) => liveArrayIterator(thisObj, () => fixedOf(thisObj).items),
      },
      {
        signature: 'fromArray(array $array, bool $preserveKeys = true): SplFixedArray',
        isStatic: true,
        impl: ({ args }) => {
          const object = createObject(rt().classes.get('splfixedarray') as PhpClass);
          const array = args[0] as PhpArray;
          if (args[1] === false) {
            rt().allocate(array.size);
            fixedOf(object).items = array.values().map(share);
          } else {
            const rawKeys = array.keys();
            if (rawKeys.some((key) => typeof key !== 'bigint' || key < 0n))
              throwError('InvalidArgumentException', 'array must contain only positive integer keys');
            const keys = rawKeys.map(Number);
            let size = 0;
            for (const key of keys) size = Math.max(size, key + 1);
            rt().allocate(size);
            const items = Array.from({ length: size }, (): Value => null);
            for (const [key, value] of array.entries()) items[Number(key)] = share(value);
            fixedOf(object).items = items;
          }
          return object;
        },
      },
    ],
    '__construct __wakeup __serialize __unserialize count toArray fromArray getSize setSize offsetExists offsetGet offsetSet offsetUnset getIterator jsonSerialize'
  ),
  createInternal: () => new FixedStorage(),
});
