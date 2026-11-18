import { callMethod, consumeInvokedResult } from './callables';
import { toBool } from './conversions';
import { throwError, withPendingException } from './errors';
import { PhpThrow, rt } from './runtime';
import { nativeOwnershipChanged, PhpArray, type PhpClass, PhpObject, type Value } from './values';

interface AcquiredIterator {
  iterator: PhpObject;
  handle: PhpObject;
}

const iteratorMethods = ['rewind', 'valid', 'current', 'key', 'next'] as const;
type IteratorMethod = (typeof iteratorMethods)[number];
const nativeRecursiveClasses = new WeakMap<PhpClass, boolean>();

export function callIteratorMethod(iterator: PhpObject, method: IteratorMethod): Value {
  return usesNativeRecursiveIterator(iterator.cls)
    ? callMethod(iterator, method, [], rt().row, { inline: true })
    : callMethod(iterator, method, []);
}

function usesNativeRecursiveIterator(cls: PhpClass): boolean {
  let direct = nativeRecursiveClasses.get(cls);
  if (direct === undefined) {
    direct = iteratorMethods.every((name) => {
      const method = cls.findMethod(name);
      return method?.fn.kind === 'native' && method.scope.lname === 'recursiveiteratoriterator';
    });
    nativeRecursiveClasses.set(cls, direct);
  }
  return direct;
}

// code-gauge-allow functionCognitiveComplexity 16 -- Acquires nested iterators while keeping returned objects alive until the engine owns the last one.
export function acquireIterator(object: PhpObject, byRef = false): AcquiredIterator | undefined {
  const runtime = rt();
  const aggregate = runtime.classes.get('iteratoraggregate') as PhpClass;
  const mark = runtime.held.length;
  let failure: PhpThrow | undefined;
  let current = object;
  try {
    for (;;) {
      runtime.spend();
      const direct = acquireDirectIterator(current, byRef);
      if (direct) return direct;
      if (!current.cls.isSubclassOf(aggregate)) return current === object ? undefined : throwInvalidIterator(object);
      runtime.allocate(1);
      current = consumeInvokedResult(
        () => callMethod(current, 'getIterator', []),
        (next) => {
          if (
            !(next instanceof PhpObject) ||
            next === current ||
            !next.cls.isSubclassOf(runtime.classes.get('traversable') as PhpClass)
          )
            throwInvalidIterator(current);
          runtime.held.push(next);
          return next;
        }
      );
    }
  } catch (error) {
    if (error instanceof PhpThrow) failure = error;
    throw error;
  } finally {
    if (runtime.held.length > mark) {
      const returned = runtime.held.splice(mark).toReversed();
      withPendingException(runtime, failure, () => {
        runtime.release(returned, true);
        runtime.flushReleases();
      });
    }
  }
}

function acquireDirectIterator(object: PhpObject, byRef: boolean): AcquiredIterator | undefined {
  const runtime = rt();
  const iteratorClass = runtime.classes.get('iterator') as PhpClass;
  const internal = object.internal as
    | {
        writable?: () => PhpArray;
        fixedIterator?: (owner: PhpObject) => PhpObject;
        prepareEngineIteration?: () => void;
      }
    | undefined;
  if (object.cls.isSubclassOf(iteratorClass)) {
    if (byRef && typeof internal?.writable !== 'function')
      throwError('Error', 'An iterator cannot be used with foreach by reference');
    if (usesNativeRecursiveIterator(object.cls)) internal?.prepareEngineIteration?.();
    const handle = newEngineIterator(object);
    return { iterator: object, handle };
  }
  if (internal?.fixedIterator && object.cls.findMethod('getiterator')?.scope.name === 'SplFixedArray') {
    if (byRef) throwError('Error', 'An iterator cannot be used with foreach by reference');
    const iterator = internal.fixedIterator(object);
    return { iterator, handle: iterator };
  }
}

function throwInvalidIterator(object: PhpObject): never {
  throwError(
    'Exception',
    `Objects returned by ${object.cls.name}::getIterator() must be traversable or implement interface Iterator`
  );
}

export function newEngineIterator(owner: PhpObject): PhpObject {
  const runtime = rt();
  const handle = runtime.newObject(runtime.classes.get('internaliterator') as PhpClass);
  handle.internal = new EngineIteratorOwner(owner);
  return handle;
}

export class EngineIteratorOwner {
  constructor(readonly object: PhpObject) {}

  held(): Value[] {
    return [this.object];
  }

  beforeRelease(): boolean {
    const state = this.object.internal as { releaseTraversal?: (object: PhpObject) => boolean } | undefined;
    return state?.releaseTraversal?.(this.object) ?? false;
  }
}

/**
 * The iterator PHP's engine makes for an Iterator object: it calls the object's methods and, like zend_user_iterator,
 * calls current() once until the iterator moves.
 */
export class InnerIterator extends EngineIteratorOwner {
  /** The object handle PHP allocates for the iterator, which shifts the numbers var_dump shows for later objects. */
  readonly handle: PhpObject;
  private cached: { v: Value } | undefined;

  constructor(object: PhpObject, handle = newEngineIterator(object)) {
    super(object);
    this.handle = handle;
    if (handle !== object) handle.internal = this;
  }

  override held(): Value[] {
    return this.cached ? [this.cached.v, this.object] : [this.object];
  }

  rewind(): void {
    this.invalidate();
    callIteratorMethod(this.object, 'rewind');
  }

  valid(): boolean {
    return toBool(callIteratorMethod(this.object, 'valid'));
  }

  current(): Value {
    if (this.cached) return this.cached.v;
    return consumeInvokedResult(
      () => callIteratorMethod(this.object, 'current'),
      (value) => {
        this.cached = { v: value };
        nativeOwnershipChanged(this.handle);
        return value;
      }
    );
  }

  key(): Value {
    return callIteratorMethod(this.object, 'key');
  }

  next(): void {
    this.invalidate();
    callIteratorMethod(this.object, 'next');
  }

  invalidate(): void {
    releaseIteratorValues([this.takeCurrent()]);
  }

  takeCurrent(): Value | undefined {
    if (!this.cached) return;
    const { v } = this.cached;
    this.cached = undefined;
    nativeOwnershipChanged(this.handle);
    return v;
  }
}

export function releaseIteratorValues(values: (Value | undefined)[]): void {
  if (!values.some((value) => value instanceof PhpArray || value instanceof PhpObject)) return;
  const runtime = rt();
  runtime.release(values, true);
  runtime.flushReleases();
}
