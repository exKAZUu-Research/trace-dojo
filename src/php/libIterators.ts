// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { callCallback, callMethod } from './callables';
import { findClass } from './classes';
import { toBool } from './conversions';
import { throwError, warn } from './errors';
import { arrayIteratorOver } from './libArrayObject';
import { defineClass, type NativeMethod } from './native';
import { toKey, toStr } from './operators';
import { rt } from './runtime';
import { iteratorOf } from './statements';
import { PhpArray, PhpClass, PhpObject, type Value } from './values';

const ITERATOR_CLASS = new PhpClass('InternalIterator');

/**
 * The iterator PHP's engine makes for an Iterator object: it calls the object's methods and, like zend_user_iterator,
 * calls current() once until the iterator moves.
 */
export class InnerIterator {
  /** The object handle PHP allocates for the iterator, which shifts the numbers var_dump shows for later objects. */
  readonly handle = rt().newObject(ITERATOR_CLASS);
  private cached: { v: Value } | undefined;

  constructor(readonly object: PhpObject) {}

  rewind(): void {
    this.invalidate();
    callMethod(this.object, 'rewind', []);
  }

  valid(): boolean {
    return toBool(callMethod(this.object, 'valid', []));
  }

  current(): Value {
    this.cached ??= { v: callMethod(this.object, 'current', []) };
    return this.cached.v;
  }

  key(): Value {
    return callMethod(this.object, 'key', []);
  }

  next(): void {
    this.invalidate();
    callMethod(this.object, 'next', []);
  }

  invalidate(): void {
    this.cached = undefined;
  }
}

/** The engine's iterator for a Traversable object, which asks an IteratorAggregate for its iterator. */
export function innerIteratorOf(object: PhpObject): InnerIterator {
  return new InnerIterator(iteratorOf(object) ?? object);
}

const CIT_CALL_TOSTRING = 1;
const CIT_TOSTRING_USE_KEY = 2;
const CIT_TOSTRING_USE_CURRENT = 4;
const CIT_TOSTRING_USE_INNER = 8;
const CIT_CATCH_GET_CHILD = 16;
const CIT_FULL_CACHE = 256;
const CIT_PUBLIC = 0xff_ff;
const CIT_VALID = 0x1_00_00;

/** The state of PHP's iterators that wrap another one (spl_dual_it_object). */
export class DualState {
  constructed = false;
  innerObject: PhpObject | undefined;
  inner: InnerIterator | undefined;
  /** The fetched element, or undefined when there is none. */
  data: { v: Value } | undefined;
  key: Value | undefined;
  pos = 0;
  limitOffset = 0;
  limitCount = -1;
  cachingFlags = 0;
  cachingString: string | undefined;
  cache = new PhpArray();
  /** The iterator over the ArrayIterator that holds an AppendIterator's iterators. */
  appended: InnerIterator | undefined;
  callback: Value = null;
  regex = { pattern: '', mode: 0, flags: 0, pregFlags: 0 };

  constructor(private readonly className: string) {}

  clone(): never {
    throwError('Error', `Trying to clone an uncloneable object of class ${this.className}`);
  }

  /** What the iterator holds, in the order PHP releases it (spl_dual_it_free_storage). */
  held(): Value[] {
    const held: Value[] = [];
    if (this.data) held.push(this.data.v);
    if (this.key !== undefined) held.push(this.key);
    if (this.inner) held.push(this.inner.handle);
    if (this.innerObject) held.push(this.innerObject);
    if (this.appended) held.push(this.appended.handle, this.appended.object);
    held.push(this.cache, this.callback);
    return held;
  }

  setInner(object: PhpObject): void {
    this.innerObject = object;
    this.inner = innerIteratorOf(object);
  }

  free(): void {
    this.inner?.invalidate();
    this.data = undefined;
    this.key = undefined;
    this.cachingString = undefined;
  }

  rewind(): void {
    this.free();
    this.pos = 0;
    this.inner?.rewind();
  }

  valid(): boolean {
    return this.inner?.valid() ?? false;
  }

  /** Copies the inner iterator's element, after checking that it has one when `checkMore` asks to. */
  fetch(checkMore: boolean): boolean {
    this.free();
    if (checkMore && !this.valid()) return false;
    const inner = this.inner as InnerIterator;
    this.data = { v: inner.current() };
    this.key = inner.key();
    return true;
  }

  next(free: boolean): void {
    if (free) this.free();
    else if (!this.inner) throwError('Error', "The inner constructor wasn't initialized with an iterator instance");
    this.inner?.next();
    this.pos++;
  }
}

export function dualOf(object: PhpObject): DualState {
  const state = object.internal as DualState;
  if (!state.constructed)
    throwError('Error', 'The object is in an invalid state as the parent constructor was not called');
  return state;
}

/** Starts constructing a wrapping iterator, which PHP allows once per object. */
export function constructDual(object: PhpObject, baseClass: string): DualState {
  const state = object.internal as DualState;
  if (state.constructed)
    throwError('BadMethodCallException', `${baseClass}::getIterator() must be called exactly once per instance`);
  return state;
}

function finishConstruct(state: DualState, inner: PhpObject): null {
  state.constructed = true;
  state.setInner(inner);
  return null;
}

/** Defines a wrapping iterator class whose constructor takes the Iterator to wrap and nothing else. */
function wrapperConstructor(name: string): NativeMethod {
  return {
    signature: '__construct(Iterator $iterator)',
    impl: ({ thisObj, args }) => finishConstruct(constructDual(thisObj, name), args[0] as PhpObject),
  };
}

const elementMethods: NativeMethod[] = [
  { signature: 'valid(): bool', impl: ({ thisObj }) => dualOf(thisObj).data !== undefined },
  { signature: 'key(): mixed', impl: ({ thisObj }) => dualOf(thisObj).key ?? null },
  { signature: 'current(): mixed', impl: ({ thisObj }) => dualOf(thisObj).data?.v ?? null },
];

defineClass({
  name: 'IteratorIterator',
  interfaces: ['OuterIterator', 'Traversable', 'Iterator'],
  methods: [
    {
      signature: '__construct(Traversable $iterator, ?string $class = null)',
      impl: ({ thisObj, args }) => {
        const state = constructDual(thisObj, 'IteratorIterator');
        return finishConstruct(state, aggregateIterator(args[0] as PhpObject, args[1] ?? null));
      },
    },
    {
      signature: 'getInnerIterator(): ?Iterator',
      impl: ({ thisObj }) => dualOf(thisObj).innerObject ?? null,
    },
    {
      signature: 'rewind(): void',
      impl: ({ thisObj }) => {
        const state = dualOf(thisObj);
        state.rewind();
        state.fetch(true);
        return null;
      },
    },
    elementMethods[0],
    elementMethods[1],
    elementMethods[2],
    {
      signature: 'next(): void',
      impl: ({ thisObj }) => {
        const state = dualOf(thisObj);
        state.next(true);
        state.fetch(true);
        return null;
      },
    },
  ],
  createInternal: (object) => new DualState(object.cls.name),
});

/** The iterator IteratorIterator wraps: the object, or the iterator an IteratorAggregate gives. */
function aggregateIterator(object: PhpObject, className: Value): PhpObject {
  const runtime = rt();
  if (object.cls.isSubclassOf(runtime.classes.get('iterator') as PhpClass)) return object;
  let cls = object.cls;
  if (className !== null) {
    const cast = findClass(className as string);
    if (!cast || !cls.isSubclassOf(cast) || !cast.isSubclassOf(runtime.classes.get('traversable') as PhpClass))
      throwError(
        'LogicException',
        'Class to downcast to not found or not base class or does not implement Traversable'
      );
    cls = cast;
  }
  if (!cls.isSubclassOf(runtime.classes.get('iteratoraggregate') as PhpClass)) return object;
  const iterator = callMethod(object, 'getIterator', []);
  if (!(iterator instanceof PhpObject) || !iterator.cls.isSubclassOf(runtime.classes.get('traversable') as PhpClass))
    throwError('LogicException', `${cls.name}::getIterator() must return an object that implements Traversable`);
  return iterator;
}

// Filters ------------------------------------------------------------------------------------------------------------

/** Transcribes spl_filter_it_fetch: skips the elements `accept` rejects. */
export function filterFetch(object: PhpObject, state: DualState): void {
  while (state.fetch(true)) {
    if (toBool(callMethod(object, 'accept', []))) return;
    state.inner?.next();
  }
  state.free();
}

export const filterMethods: NativeMethod[] = [
  { signature: 'accept(): bool', impl: () => false, isAbstract: true },
  wrapperConstructor('FilterIterator'),
  {
    signature: 'rewind(): void',
    impl: ({ thisObj }) => {
      const state = dualOf(thisObj);
      state.rewind();
      filterFetch(thisObj, state);
      return null;
    },
  },
  {
    signature: 'next(): void',
    impl: ({ thisObj }) => {
      const state = dualOf(thisObj);
      state.next(true);
      filterFetch(thisObj, state);
      return null;
    },
  },
];

defineClass({ name: 'FilterIterator', parent: 'IteratorIterator', isAbstract: true, methods: filterMethods });
defineClass({
  name: 'CallbackFilterIterator',
  parent: 'FilterIterator',
  methods: [
    {
      signature: '__construct(Iterator $iterator, callable $callback)',
      impl: ({ thisObj, args }) => {
        const state = constructDual(thisObj, 'CallbackFilterIterator');
        state.callback = args[1];
        return finishConstruct(state, args[0] as PhpObject);
      },
    },
    {
      signature: 'accept(): bool',
      impl: ({ thisObj }) => {
        const state = dualOf(thisObj);
        if (state.data === undefined || state.key === undefined) return false;
        return callCallback(state.callback, [state.data.v, state.key, state.innerObject as PhpObject]);
      },
    },
  ],
});

// LimitIterator ------------------------------------------------------------------------------------------------------

function limitInRange(state: DualState): boolean {
  return state.limitCount === -1 || state.pos - state.limitOffset < state.limitCount;
}

/** Transcribes spl_limit_it_seek, which seeks a SeekableIterator directly and steps through any other. */
function limitSeek(state: DualState, position: number): void {
  state.free();
  if (position < state.limitOffset)
    throwError('OutOfBoundsException', `Cannot seek to ${position} which is below the offset ${state.limitOffset}`);
  if (position - state.limitOffset >= state.limitCount && state.limitCount !== -1)
    throwError(
      'OutOfBoundsException',
      `Cannot seek to ${position} which is behind offset ${state.limitOffset} plus count ${state.limitCount}`
    );
  const inner = state.innerObject as PhpObject;
  if (position !== state.pos && inner.cls.isSubclassOf(rt().classes.get('seekableiterator') as PhpClass)) {
    state.free();
    callMethod(inner, 'seek', [BigInt(position)]);
    state.pos = position;
    if (limitInRange(state) && state.valid()) state.fetch(false);
    return;
  }
  if (position < state.pos) state.rewind();
  while (position > state.pos && state.valid()) state.next(true);
  if (state.valid()) state.fetch(true);
}

defineClass({
  name: 'LimitIterator',
  parent: 'IteratorIterator',
  methods: [
    {
      signature: '__construct(Iterator $iterator, int $offset = 0, int $limit = -1)',
      impl: ({ thisObj, args }) => {
        const state = constructDual(thisObj, 'LimitIterator');
        state.limitOffset = Number(args[1] ?? 0n);
        state.limitCount = Number(args[2] ?? -1n);
        if (state.limitOffset < 0)
          throwError(
            'ValueError',
            'LimitIterator::__construct(): Argument #2 ($offset) must be greater than or equal to 0'
          );
        if (state.limitCount < -1)
          throwError(
            'ValueError',
            'LimitIterator::__construct(): Argument #3 ($limit) must be greater than or equal to -1'
          );
        return finishConstruct(state, args[0] as PhpObject);
      },
    },
    {
      signature: 'rewind(): void',
      impl: ({ thisObj }) => {
        const state = dualOf(thisObj);
        state.rewind();
        limitSeek(state, state.limitOffset);
        return null;
      },
    },
    {
      signature: 'valid(): bool',
      impl: ({ thisObj }) => {
        const state = dualOf(thisObj);
        return limitInRange(state) && state.data !== undefined;
      },
    },
    {
      signature: 'next(): void',
      impl: ({ thisObj }) => {
        const state = dualOf(thisObj);
        state.next(true);
        if (limitInRange(state)) state.fetch(true);
        return null;
      },
    },
    {
      signature: 'seek(int $offset): int',
      impl: ({ thisObj, args }) => {
        const state = dualOf(thisObj);
        limitSeek(state, Number(args[0]));
        return BigInt(state.pos);
      },
    },
    { signature: 'getPosition(): int', impl: ({ thisObj }) => BigInt(dualOf(thisObj).pos) },
  ],
});

// CachingIterator ----------------------------------------------------------------------------------------------------

function checkCachingFlags(flags: number, argument: string): void {
  const count = [CIT_CALL_TOSTRING, CIT_TOSTRING_USE_KEY, CIT_TOSTRING_USE_CURRENT, CIT_TOSTRING_USE_INNER].filter(
    (flag) => flags & flag
  ).length;
  if (count > 1)
    throwError(
      'ValueError',
      `${argument} must contain only one of CachingIterator::CALL_TOSTRING, CachingIterator::TOSTRING_USE_KEY, CachingIterator::TOSTRING_USE_CURRENT, or CachingIterator::TOSTRING_USE_INNER`
    );
}

/** Transcribes spl_caching_it_next, which fetches one element ahead of what the iterator reports. */
function cachingNext(state: DualState): void {
  if (!state.fetch(true)) {
    state.cachingFlags &= ~CIT_VALID;
    return;
  }
  state.cachingFlags |= CIT_VALID;
  if (state.cachingFlags & CIT_FULL_CACHE) state.cache.set(toKey(state.key as Value), state.data?.v as Value);
  if (state.cachingFlags & CIT_TOSTRING_USE_INNER) state.cachingString = toStr(state.innerObject as PhpObject);
  else if (state.cachingFlags & CIT_CALL_TOSTRING) state.cachingString = toStr(state.data?.v as Value);
  state.next(false);
}

function fullCache(object: PhpObject): DualState {
  const state = dualOf(object);
  if (!(state.cachingFlags & CIT_FULL_CACHE))
    throwError(
      'BadMethodCallException',
      `${object.cls.name} does not use a full cache (see CachingIterator::__construct)`
    );
  return state;
}

defineClass({
  name: 'CachingIterator',
  parent: 'IteratorIterator',
  interfaces: ['Stringable', 'Iterator', 'Traversable', 'OuterIterator', 'ArrayAccess', 'Countable'],
  consts: {
    CALL_TOSTRING: BigInt(CIT_CALL_TOSTRING),
    CATCH_GET_CHILD: BigInt(CIT_CATCH_GET_CHILD),
    TOSTRING_USE_KEY: BigInt(CIT_TOSTRING_USE_KEY),
    TOSTRING_USE_CURRENT: BigInt(CIT_TOSTRING_USE_CURRENT),
    TOSTRING_USE_INNER: BigInt(CIT_TOSTRING_USE_INNER),
    FULL_CACHE: BigInt(CIT_FULL_CACHE),
  },
  methods: [
    {
      signature: '__construct(Iterator $iterator, int $flags = 1)',
      impl: ({ thisObj, args }) => {
        const state = constructDual(thisObj, 'CachingIterator');
        const flags = Number(args[1] ?? BigInt(CIT_CALL_TOSTRING));
        checkCachingFlags(flags, 'CachingIterator::__construct(): Argument #2 ($flags)');
        state.cachingFlags |= flags & CIT_PUBLIC;
        return finishConstruct(state, args[0] as PhpObject);
      },
    },
    {
      signature: 'rewind(): void',
      impl: ({ thisObj }) => {
        const state = dualOf(thisObj);
        state.rewind();
        state.cache = new PhpArray();
        cachingNext(state);
        return null;
      },
    },
    { signature: 'valid(): bool', impl: ({ thisObj }) => (dualOf(thisObj).cachingFlags & CIT_VALID) !== 0 },
    { signature: 'next(): void', impl: ({ thisObj }) => (cachingNext(dualOf(thisObj)), null) },
    { signature: 'hasNext(): bool', impl: ({ thisObj }) => dualOf(thisObj).valid() },
    {
      signature: '__toString(): string',
      impl: ({ thisObj }) => {
        const state = dualOf(thisObj);
        const flags = state.cachingFlags;
        if (!(flags & (CIT_CALL_TOSTRING | CIT_TOSTRING_USE_KEY | CIT_TOSTRING_USE_CURRENT | CIT_TOSTRING_USE_INNER)))
          throwError(
            'BadMethodCallException',
            `${thisObj.cls.name} does not fetch string value (see CachingIterator::__construct)`
          );
        if (flags & CIT_TOSTRING_USE_KEY) return toStr(state.key ?? null);
        if (flags & CIT_TOSTRING_USE_CURRENT) return toStr(state.data?.v ?? null);
        return state.cachingString ?? '';
      },
    },
    { signature: 'getFlags(): int', impl: ({ thisObj }) => BigInt(dualOf(thisObj).cachingFlags) },
    {
      signature: 'setFlags(int $flags): void',
      impl: ({ thisObj, args }) => {
        const state = dualOf(thisObj);
        const flags = Number(args[0]);
        checkCachingFlags(flags, 'CachingIterator::setFlags(): Argument #1 ($flags)');
        if (state.cachingFlags & CIT_CALL_TOSTRING && !(flags & CIT_CALL_TOSTRING))
          throwError('InvalidArgumentException', 'Unsetting flag CALL_TO_STRING is not possible');
        if (state.cachingFlags & CIT_TOSTRING_USE_INNER && !(flags & CIT_TOSTRING_USE_INNER))
          throwError('InvalidArgumentException', 'Unsetting flag TOSTRING_USE_INNER is not possible');
        if (flags & CIT_FULL_CACHE && !(state.cachingFlags & CIT_FULL_CACHE)) state.cache = new PhpArray();
        state.cachingFlags = (state.cachingFlags & ~CIT_PUBLIC) | (flags & CIT_PUBLIC);
        return null;
      },
    },
    {
      signature: 'offsetGet($key): mixed',
      impl: ({ thisObj, args }) => {
        const key = toStr(args[0]);
        const value = fullCache(thisObj).cache.get(toKey(key));
        if (value === undefined) {
          warn(`Undefined array key "${key}"`);
          return null;
        }
        return value;
      },
    },
    {
      signature: 'offsetSet($key, mixed $value): void',
      impl: ({ thisObj, args }) => (fullCache(thisObj).cache.set(toKey(toStr(args[0])), args[1]), null),
    },
    {
      signature: 'offsetUnset($key): void',
      impl: ({ thisObj, args }) => (fullCache(thisObj).cache.delete(toKey(toStr(args[0]))), null),
    },
    {
      signature: 'offsetExists($key): bool',
      impl: ({ thisObj, args }) => fullCache(thisObj).cache.has(toKey(toStr(args[0]))),
    },
    {
      signature: 'getCache(): array',
      impl: ({ thisObj }) => {
        const cache = fullCache(thisObj).cache;
        cache.shared = true;
        return cache;
      },
    },
    { signature: 'count(): int', impl: ({ thisObj }) => BigInt(fullCache(thisObj).cache.size) },
  ],
});

// NoRewindIterator, InfiniteIterator, EmptyIterator ------------------------------------------------------------------

defineClass({
  name: 'NoRewindIterator',
  parent: 'IteratorIterator',
  methods: [
    wrapperConstructor('NoRewindIterator'),
    { signature: 'rewind(): void', impl: () => null },
    { signature: 'valid(): bool', impl: ({ thisObj }) => dualOf(thisObj).valid() },
    { signature: 'key(): mixed', impl: ({ thisObj }) => (dualOf(thisObj).inner as InnerIterator).key() },
    { signature: 'current(): mixed', impl: ({ thisObj }) => (dualOf(thisObj).inner as InnerIterator).current() },
    { signature: 'next(): void', impl: ({ thisObj }) => ((dualOf(thisObj).inner as InnerIterator).next(), null) },
  ],
});
defineClass({
  name: 'InfiniteIterator',
  parent: 'IteratorIterator',
  methods: [
    wrapperConstructor('InfiniteIterator'),
    {
      signature: 'next(): void',
      impl: ({ thisObj }) => {
        const state = dualOf(thisObj);
        state.next(true);
        if (state.valid()) state.fetch(false);
        else {
          state.rewind();
          if (state.valid()) state.fetch(false);
        }
        return null;
      },
    },
  ],
});
defineClass({
  name: 'EmptyIterator',
  interfaces: ['Iterator', 'Traversable'],
  methods: [
    {
      signature: 'current(): never',
      impl: () => throwError('BadMethodCallException', 'Accessing the value of an EmptyIterator'),
    },
    { signature: 'next(): void', impl: () => null },
    {
      signature: 'key(): never',
      impl: () => throwError('BadMethodCallException', 'Accessing the key of an EmptyIterator'),
    },
    { signature: 'valid(): false', impl: () => false },
    { signature: 'rewind(): void', impl: () => null },
  ],
});

// AppendIterator -----------------------------------------------------------------------------------------------------

/** Transcribes spl_append_it_next_iterator: moves on to the iterator the list's position is at. */
function appendNextIterator(state: DualState): boolean {
  state.free();
  state.innerObject = undefined;
  state.inner = undefined;
  const list = state.appended as InnerIterator;
  if (!list.valid()) return false;
  state.setInner(list.current() as PhpObject);
  state.rewind();
  return true;
}

function appendFetch(state: DualState): void {
  while (!state.valid()) {
    (state.appended as InnerIterator).next();
    if (!appendNextIterator(state)) return;
  }
  state.fetch(false);
}

defineClass({
  name: 'AppendIterator',
  parent: 'IteratorIterator',
  methods: [
    {
      signature: '__construct()',
      impl: ({ thisObj }) => {
        const state = constructDual(thisObj, 'AppendIterator');
        state.constructed = true;
        state.appended = new InnerIterator(arrayIteratorOver(new PhpArray()));
        return null;
      },
    },
    {
      signature: 'append(Iterator $iterator): void',
      impl: ({ thisObj, args }) => {
        const state = dualOf(thisObj);
        const list = state.appended as InnerIterator;
        const iterator = args[0] as PhpObject;
        const advance = list.valid() && !state.valid();
        callMethod(list.object, 'append', [iterator]);
        if (advance) list.next();
        if (state.inner && state.valid()) return null;
        if (!list.valid()) list.rewind();
        do appendNextIterator(state);
        while (state.innerObject !== iterator);
        appendFetch(state);
        return null;
      },
    },
    {
      signature: 'rewind(): void',
      impl: ({ thisObj }) => {
        const state = dualOf(thisObj);
        (state.appended as InnerIterator).rewind();
        if (appendNextIterator(state)) appendFetch(state);
        return null;
      },
    },
    elementMethods[0],
    {
      signature: 'current(): mixed',
      impl: ({ thisObj }) => {
        const state = dualOf(thisObj);
        state.fetch(true);
        return state.data?.v ?? null;
      },
    },
    {
      signature: 'next(): void',
      impl: ({ thisObj }) => {
        const state = dualOf(thisObj);
        if (state.valid()) state.next(true);
        appendFetch(state);
        return null;
      },
    },
    {
      signature: 'getIteratorIndex(): ?int',
      impl: ({ thisObj }) => (dualOf(thisObj).appended as InnerIterator).key(),
    },
    {
      signature: 'getArrayIterator(): ArrayIterator',
      impl: ({ thisObj }) => (dualOf(thisObj).appended as InnerIterator).object,
    },
  ],
});
