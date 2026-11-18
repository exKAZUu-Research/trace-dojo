import { callMethod, consumeInvokedResult } from './callables';
import { throwError, withPendingException } from './errors';
import { PhpThrow, rt } from './runtime';
import { type PhpArray, type PhpClass, PhpObject, type Value } from './values';

interface AcquiredIterator {
  iterator: PhpObject;
  handle: PhpObject;
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
      }
    | undefined;
  if (object.cls.isSubclassOf(iteratorClass)) {
    if (byRef && typeof internal?.writable !== 'function')
      throwError('Error', 'An iterator cannot be used with foreach by reference');
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
