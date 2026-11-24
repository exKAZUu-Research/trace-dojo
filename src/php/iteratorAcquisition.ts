import { callMethod, consumeInvokedResult, discardInvokedResult } from './callables';
import { toBool } from './conversions';
import { throwError, withPendingException } from './errors';
import { PhpThrow, rt } from './runtime';
import { deref, nativeOwnershipChanged, PhpArray, type PhpClass, PhpObject, Ref, type Value } from './values';

interface AcquiredIterator {
  iterator: PhpObject;
  handle: PhpObject;
}

const iteratorMethods = ['rewind', 'valid', 'current', 'key', 'next'] as const;
type IteratorMethod = (typeof iteratorMethods)[number];
const nativeRecursiveClasses = new WeakMap<PhpClass, boolean>();

export function callIteratorMethod(iterator: PhpObject, method: 'valid'): boolean;
export function callIteratorMethod(iterator: PhpObject, method: 'rewind' | 'next'): void;
export function callIteratorMethod(iterator: PhpObject, method: 'current' | 'key'): Value;
export function callIteratorMethod(iterator: PhpObject, method: IteratorMethod): Value | void {
  const call = (): Value => invokeIteratorMethod(iterator, method);
  if (method === 'valid') return consumeInvokedResult(call, toBool);
  if (method === 'rewind' || method === 'next') return discardInvokedResult(call);
  return call();
}

function invokeIteratorMethod(iterator: PhpObject, method: IteratorMethod): Value {
  // PHP's engine resumes a generator itself rather than through the Generator methods, which traces would show.
  const engine = iterator.internal as { engineIteration?: (method: IteratorMethod) => Value } | undefined;
  if (engine?.engineIteration) return engine.engineIteration(method);
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

// code-gauge-allow functionCognitiveComplexity -- Acquires nested iterators while keeping returned objects alive until the engine owns the last one.
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
        beforeEngineIteration?: (byRef: boolean) => void;
        currentRef?: () => Ref;
      }
    | undefined;
  if (object.cls.isSubclassOf(iteratorClass)) {
    internal?.beforeEngineIteration?.(byRef);
    if (
      byRef &&
      typeof internal?.currentRef !== 'function' &&
      (typeof internal?.writable !== 'function' ||
        !iteratorMethods.every((name) => object.cls.findMethod(name)?.fn.kind === 'native'))
    )
      throwError('Error', 'An iterator cannot be used with foreach by reference');
    if (usesNativeRecursiveIterator(object.cls)) internal?.prepareEngineIteration?.();
    const handle = newEngineIterator(object);
    return { iterator: object, handle };
  }
  if (internal?.fixedIterator && object.cls.findMethod('getiterator')?.fn.kind === 'native') {
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

  held(): (Value | Ref)[] {
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
  private cached: { v: Value | Ref } | undefined;

  constructor(object: PhpObject, handle = newEngineIterator(object)) {
    super(object);
    this.handle = handle;
    if (handle !== object) handle.internal = this;
  }

  override held(): (Value | Ref)[] {
    return this.cached ? [this.cached.v, this.object] : [this.object];
  }

  runsWhileThrowing(): boolean {
    // Overriding any of these methods switches ArrayIterator to the user iterator handlers, which skip pending calls.
    return iteratorMethods.every((method) => this.object.cls.findMethod(method)?.scope.lname === 'arrayiterator');
  }

  rewind(throwing = false): void {
    this.invalidate();
    if (!throwing || this.runsWhileThrowing()) callIteratorMethod(this.object, 'rewind');
  }

  valid(throwing = false): boolean {
    return (!throwing || this.runsWhileThrowing()) && callIteratorMethod(this.object, 'valid');
  }

  current(): Value {
    return deref(this.currentSlot());
  }

  currentSlot(): Value | Ref {
    if (this.cached) return this.cached.v;
    const runtime = rt();
    let returnedRef: Ref | undefined;
    return consumeInvokedResult(
      () => {
        const value = callIteratorMethod(this.object, 'current');
        returnedRef = runtime.lastReturnRef;
        if (returnedRef) {
          returnedRef.isRef = true;
          returnedRef.rc++;
        }
        return value;
      },
      (value) => {
        const slot = returnedRef ?? value;
        this.cached = { v: slot };
        nativeOwnershipChanged(this.handle);
        return slot;
      }
    );
  }

  key(): Value {
    return callIteratorMethod(this.object, 'key');
  }

  next(throwing = false): void {
    this.invalidate();
    if (!throwing || this.runsWhileThrowing()) callIteratorMethod(this.object, 'next');
  }

  invalidate(): void {
    releaseIteratorValues([this.takeCurrent()]);
  }

  takeCurrent(): Value | Ref | undefined {
    if (!this.cached) return;
    const { v } = this.cached;
    this.cached = undefined;
    nativeOwnershipChanged(this.handle);
    return v;
  }

  close(): void {
    const slot = this.cached?.v;
    this.cached = undefined;
    if (slot instanceof Ref) slot.rc--;
  }
}

export function releaseIteratorValues(values: (Value | Ref | undefined)[]): void {
  for (const value of values) if (value instanceof Ref) value.rc--;
  if (!values.some((value) => value instanceof PhpArray || value instanceof PhpObject || value instanceof Ref)) return;
  const runtime = rt();
  runtime.release(values, true);
  runtime.flushReleases();
}
