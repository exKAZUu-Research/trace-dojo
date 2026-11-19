// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import type { ArrayCursor } from './arrayOrder';
import { withArrayReadView } from './arrayTable';
import { callMethod } from './callables';
import { invoke } from './calls';
import { createObject, findClass, objectToArray } from './classes';
import {
  deprecated,
  isCleanupException,
  throwError,
  type UpdateWarning,
  warn,
  withCleanupExceptions,
  withOperandWarnings,
} from './errors';
import { arrayHasHolders } from './garbage';
import { defineClass, type NativeMethod } from './native';
import { setNativeArrayStorage } from './nativeArrayStorage';
import { toKey } from './operators';
import { arrayIsShared, share } from './places';
import './splInterfaces';
import { rt } from './runtime';
import { UnsupportedFeatureError } from './unsupported';
import { type Key, NativeValueIndex, PhpArray, type PhpClass, PhpObject, Ref, type Value } from './values';

const STD_PROP_LIST = 1;
const ARRAY_AS_PROPS = 2;
const CHILD_ARRAYS_ONLY = 4;
/** The flags PHP keeps for itself, which the flag arguments and getFlags leave out. */
const INTERNAL_FLAGS = 0xff_ff_00_00;
const PUBLIC_FLAGS = ~INTERNAL_FLAGS;

/** The storage of an ArrayObject or ArrayIterator: its own array, or the ArrayObject whose storage it uses. */
export class ArrayStorage {
  readonly nativeValues = new NativeValueIndex();
  private sorting = 0;
  private cursorArray: PhpArray | undefined;
  private iteratorCursor: ArrayCursor | undefined;
  private readonly watchers = new Set<WeakRef<ArrayStorage>>();
  private readonly registration = new WeakRef(this);
  private watched = new Set<ArrayStorage>();
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
    private backing?: PhpObject
  ) {
    this.nativeValues.reset(this.held());
  }

  cursor(): ArrayCursor {
    const array = this.array;
    if (this.cursorArray !== array) this.moveCursor(array, 'replace');
    this.watchChain();
    return this.iteratorCursor as ArrayCursor;
  }

  get arrayAsProperties(): boolean {
    return (this.flags & ARRAY_AS_PROPS) !== 0;
  }

  get array(): PhpArray {
    return (this.chain().at(-1) as ArrayStorage).own;
  }

  set array(array: PhpArray) {
    const root = this.chain().at(-1) as ArrayStorage;
    root.own = array;
    root.nativeValues.reset(root.held());
    root.syncCursors('replace');
  }

  replaceWith(storage: ArrayStorage): void {
    this.checkMutation();
    this.close();
    this.own = storage.own;
    this.backing = storage.backing;
    this.flags = storage.flags;
    this.iteratorClass = storage.iteratorClass;
    this.nativeValues.reset(this.held());
    this.syncCursors('replace');
  }

  held(): Value[] {
    return [this.backing ?? this.own];
  }

  clone(): ArrayStorage {
    let copy: ArrayStorage;
    if (this.owner === 'ArrayIterator' && this.holder) copy = new ArrayStorage(this.owner, this.own, this.holder);
    else if (this.backing) copy = new ArrayStorage(this.owner, this.own, this.backing);
    else {
      copy = new ArrayStorage(this.owner, this.own);
    }
    copy.flags = this.flags;
    copy.iteratorClass = this.iteratorClass;
    return copy;
  }

  // code-gauge-allow functionCognitiveComplexity 17 -- Uses the fetched table and preserves key diagnostic ordering together.
  offsetValue(key: Value, className: string, warning?: UpdateWarning, hasPendingWarning = false): Value {
    const array = this.array;
    return withArrayReadView(array, (view) => {
      let completed = true;
      const report: UpdateWarning | undefined =
        warning && !hasPendingWarning ? (emit) => (completed = warning(emit)) : warning;
      const offset = toKey(key, 'access', className, report);
      if (!completed && !arrayHasHolders(rt(), array, 1)) return null;
      const slot = view.get(offset);
      const value = slot instanceof Ref ? slot.v : slot;
      if (
        value !== undefined &&
        (!view.detached() || !(value instanceof PhpObject) || rt().objects.get(value.id) === value)
      )
        return value;
      const message = `Undefined array key ${typeof offset === 'bigint' ? offset : `"${offset}"`}`;
      if (warning)
        warning(
          () => warn(message),
          () => warn(message, true)
        );
      else warn(message);
      return null;
    });
  }

  offsetExists(key: Value, className: string): boolean {
    return this.array.has(toKey(key, 'isset', className));
  }

  setOffset(key: Value, value: Value, className: string, warning?: UpdateWarning): void {
    if (key === null) {
      this.writable().append(share(value));
      return;
    }
    this.mutateOffset(key, 'access', className, (array, offset) => this.replaceOffset(array, offset, value), warning);
  }

  deleteOffset(key: Value, className: string): void {
    this.mutateOffset(key, 'unset', className, (array, offset) => array.delete(offset));
  }

  private mutateOffset(
    key: Value,
    use: 'access' | 'unset',
    className: string,
    mutate: (array: PhpArray, offset: Key) => void,
    warning?: UpdateWarning
  ): void {
    this.checkMutation();
    const update = (report: UpdateWarning): Value => {
      const offset = toKey(key, use, className, report);
      mutate(this.writable(), offset);
      return null;
    };
    if (warning) update(warning);
    else withOperandWarnings(update);
  }

  private replaceOffset(array: PhpArray, offset: Key, value: Value): void {
    const replacement = share(value);
    const previous = array.getSlot(offset);
    if (previous === null || typeof previous !== 'object') {
      array.setSlot(offset, replacement);
      return;
    }
    const runtime = rt();
    if (runtime.destructibles === 0) {
      runtime.release([array.releaseSlot(offset)], true, runtime.nativeCalls > 0);
      array.setSlot(offset, replacement);
      return;
    }
    const bucket = array.ordered().get(offset)?.index;
    runtime.held.push(replacement);
    try {
      withCleanupExceptions(runtime, (capture) => {
        try {
          runtime.release([array.releaseSlot(offset)], true, runtime.nativeCalls > 0);
        } catch (error) {
          if (!isCleanupException(error)) throw error;
          capture(error);
        }
        if (!arrayHasHolders(runtime, array, 1) || bucket === undefined) return;
        const target = array.ordered().keyAtBucket(bucket);
        if (target === undefined) return;
        runtime.holdForShutdown(array.releaseSlot(target));
        array.setSlot(target, replacement);
      });
    } finally {
      runtime.held.pop();
    }
  }

  writable(): PhpArray {
    const root = this.chain().at(-1) as ArrayStorage;
    root.checkMutation();
    if (arrayIsShared(root.own)) {
      root.own = root.own.copy();
      root.nativeValues.reset(root.held());
      root.syncCursors('copy');
    }
    return root.own;
  }

  checkMutation(): void {
    if (this.chain().some((storage) => storage.sorting > 0))
      throwError('Error', 'Modification of ArrayObject during sorting is prohibited');
  }

  runSort(run: () => Value): Value {
    const root = this.chain().at(-1) as ArrayStorage;
    root.sorting++;
    try {
      return run();
    } finally {
      root.sorting--;
    }
  }

  close(): void {
    this.iteratorCursor?.close();
    this.iteratorCursor = undefined;
    this.cursorArray = undefined;
    for (const storage of this.watched) storage.watchers.delete(this.registration);
    this.watched.clear();
  }

  private syncCursors(mode: 'copy' | 'replace'): void {
    for (const reference of this.watchers) {
      const watcher = reference.deref();
      if (!watcher) {
        this.watchers.delete(reference);
        continue;
      }
      watcher.watchChain();
      watcher.moveCursor(watcher.array, mode);
    }
  }

  private watchChain(): void {
    const chain = new Set(this.chain());
    for (const storage of this.watched) if (!chain.has(storage)) storage.watchers.delete(this.registration);
    for (const storage of chain) storage.watchers.add(this.registration);
    this.watched = chain;
  }

  private moveCursor(array: PhpArray, mode: 'copy' | 'replace'): void {
    if (this.cursorArray === array) return;
    const key = mode === 'copy' ? this.iteratorCursor?.key : undefined;
    const index = this.iteratorCursor?.index;
    const initialized = this.iteratorCursor !== undefined;
    this.iteratorCursor?.close();
    this.cursorArray = array;
    this.iteratorCursor = array.cursor(true);
    if (initialized) {
      while (
        this.iteratorCursor.key !== undefined &&
        (mode === 'copy' ? this.iteratorCursor.key !== key : (this.iteratorCursor.entry?.index ?? 0) < (index ?? 0))
      )
        this.iteratorCursor.next();
      if (mode === 'replace' || !this.iteratorCursor.entry)
        this.iteratorCursor.setPosition(this.iteratorCursor.entry, index);
    }
  }

  private chain(): ArrayStorage[] {
    const chain: ArrayStorage[] = [this];
    const seen = new Set(chain);
    let backing = this.backing;
    while (backing) {
      const storage = storageOf(backing);
      if (seen.has(storage)) throw new UnsupportedFeatureError('循環する SPL 配列ストレージ');
      chain.push(storage);
      seen.add(storage);
      backing = storage.backing;
    }
    return chain;
  }

  debugEntries(): [Key, Value][] {
    return [[`\0${this.owner}\0storage`, this.backing ?? this.own]];
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
  old.checkMutation();
  const name = old.owner;
  let storage: ArrayStorage;
  let newFlags = flags;
  if (value instanceof PhpArray) {
    value.shared = true;
    storage = new ArrayStorage(name, arrayIsShared(value) ? value.copy() : value);
  } else {
    const other = value as PhpObject;
    deprecated(
      `${name}::${method}(): Using an object as a backing array for ${name} is deprecated, as it allows violating class constraints and invariants`
    );
    if (other === object) throw new UnsupportedFeatureError('通常のオブジェクトを配列ストレージにする操作');
    if (other.internal instanceof ArrayStorage) {
      if (justArray) newFlags = storageOf(other).flags & PUBLIC_FLAGS;
      storage = new ArrayStorage(name, new PhpArray(), other);
    } else {
      throw new UnsupportedFeatureError('通常のオブジェクトを配列ストレージにする操作');
    }
  }
  storage.flags = old.flags | newFlags;
  storage.iteratorClass = old.iteratorClass;
  rt()
    .nativeHeld.at(-1)
    ?.push(...old.held());
  old.replaceWith(storage);
}

function holdStorage(object: PhpObject, storage: ArrayStorage): ArrayStorage {
  object.internal = storage;
  storage.holder = object;
  return storage;
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
        const flags = Number(((args[1] as bigint | undefined) ?? 0n) & BigInt(PUBLIC_FLAGS));
        setStorage(thisObj, args[0], '__construct', flags, args.length === 1);
        return null;
      },
    },
    {
      signature: 'offsetExists(mixed $key): bool',
      impl: ({ thisObj, args }) => storageOf(thisObj).offsetExists(args[0], thisObj.cls.name),
    },
    {
      signature: 'offsetGet(mixed $key): mixed',
      impl: ({ thisObj, args }) => storageOf(thisObj).offsetValue(args[0], thisObj.cls.name),
    },
    {
      signature: 'offsetSet(mixed $key, mixed $value): void',
      impl: ({ thisObj, args }) => {
        storageOf(thisObj).setOffset(args[0], args[1], thisObj.cls.name);
        return null;
      },
    },
    {
      signature: 'offsetUnset(mixed $key): void',
      impl: ({ thisObj, args }) => {
        storageOf(thisObj).deleteOffset(args[0], thisObj.cls.name);
        return null;
      },
    },
    {
      signature: 'append(mixed $value): void',
      impl: ({ thisObj, args }) => (storageOf(thisObj).writable().append(share(args[0])), null),
    },
    { signature: 'getArrayCopy(): array', impl: ({ thisObj }) => arrayCopy(thisObj) },
    { signature: 'count(): int', impl: ({ thisObj }) => BigInt(storageOf(thisObj).array.size) },
    { signature: 'getFlags(): int', impl: ({ thisObj }) => BigInt(storageOf(thisObj).flags & PUBLIC_FLAGS) },
    {
      signature: 'setFlags(int $flags): void',
      impl: ({ thisObj, args }) => {
        const storage = storageOf(thisObj);
        storage.flags = (storage.flags & INTERNAL_FLAGS) | Number((args[0] as bigint) & BigInt(PUBLIC_FLAGS));
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
  return storageOf(object).array.copy();
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
  const runtime = rt();
  const ref = new Ref(share(storage.array));
  const fn = rt().functions.get(name);
  if (!fn) throw new Error(`Unknown sort function ${name}`);
  runtime.nativeHeld.at(-1)!.push(ref);
  let result: Value = null;
  try {
    withCleanupExceptions(runtime, (capture) => {
      try {
        result = storage.runSort(() =>
          invoke({ fn }, [{ v: ref.v, ref }, ...args.map((v) => ({ v }) as const)], undefined)
        );
      } catch (error) {
        if (!isCleanupException(error)) throw error;
        capture(error);
      }
      if (storage.array !== ref.v) storage.array = ref.v as PhpArray;
    });
    return result;
  } finally {
    ref.releaseWithoutGc();
  }
}

function keyAt(storage: ArrayStorage): Key | undefined {
  return storage.cursor().key;
}

function currentEntry(storage: ArrayStorage): Value | undefined {
  const key = keyAt(storage);
  return key === undefined ? undefined : storage.array.get(key);
}

const iteratorMethods: NativeMethod[] = [
  {
    signature: 'rewind(): void',
    impl: ({ thisObj }) => (storageOf(thisObj).cursor().rewind(), null),
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
    impl: ({ thisObj }) => (storageOf(thisObj).cursor().next(), null),
  },
  {
    signature: 'valid(): bool',
    impl: ({ thisObj }) => storageOf(thisObj).cursor().key !== undefined,
  },
  {
    signature: 'seek(int $offset): void',
    impl: ({ thisObj, args }) => {
      const storage = storageOf(thisObj);
      const offset = args[0] as bigint;
      if (offset < 0n) throwError('OutOfBoundsException', `Seek position ${offset} is out of range`);
      const length = storage.array.size;
      const steps = offset < BigInt(length) ? Number(offset) : length;
      const cursor = storage.cursor();
      cursor.rewind();
      for (let index = 0; index < steps && cursor.key !== undefined; index++) {
        rt().spend();
        cursor.next();
      }
      if (cursor.key === undefined) throwError('OutOfBoundsException', `Seek position ${offset} is out of range`);
      return null;
    },
  },
];

const flagConstants = { STD_PROP_LIST: BigInt(STD_PROP_LIST), ARRAY_AS_PROPS: BigInt(ARRAY_AS_PROPS) };

defineClass({
  name: 'ArrayIterator',
  compare: compareArrayStorage,
  interfaces: ['SeekableIterator', 'Traversable', 'Iterator', 'ArrayAccess', 'Serializable', 'Countable'],
  consts: flagConstants,
  methods: [...arrayMethods('ArrayIterator'), ...iteratorMethods],
  createInternal: (object) => holdStorage(object, new ArrayStorage('ArrayIterator', new PhpArray())),
});
defineClass({
  name: 'ArrayObject',
  compare: compareArrayStorage,
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

function* compareArrayStorage(a: PhpObject, b: PhpObject): Generator<[Value, Value, 'order'], undefined> {
  yield [(a.internal as ArrayStorage).array, (b.internal as ArrayStorage).array, 'order'];
  return undefined;
}

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
