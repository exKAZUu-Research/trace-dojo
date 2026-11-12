import { DONE, type HostIterator } from './iteration';
import type { RealmBuilder } from './realm';
import { defineHostIteratorPrototype, iteratorResult, newHostIterator, WELL_KNOWN_SYMBOLS } from './realmIterators';
import type { Runtime } from './runtime';
import {
  isCallable,
  isObject,
  type JsArray,
  type JsFunction,
  JsObject,
  JsThrow,
  type NativeCall,
  toBoolean,
  type Value,
} from './values';

/** The spec's Iterator Record: an iterator object and the `next` method read from it once. */
interface IteratorRecord {
  iterator: JsObject;
  next: Value;
  done: boolean;
}

/**
 * Defines the global Iterator, `Iterator.from`, and the iterator helpers on `%Iterator.prototype%`, which every builtin
 * iterator and generator inherits. Each follows its algorithm in the ECMAScript specification, stepping the underlying
 * iterator through its `next` method and closing it when a callback throws or the helper stops early.
 */
export function defineIteratorHelpers(builder: RealmBuilder): void {
  const { iteratorPrototype } = builder.realm;
  const iteratorConstructor = builder.defineClass('Iterator', 0, iteratorPrototype, ({ runtime, newTarget }) => {
    if (!newTarget) return runtime.throwError('TypeError', "Constructor Iterator requires 'new'");
    if (newTarget === iteratorConstructor) {
      return runtime.throwError('TypeError', 'Abstract class Iterator not directly constructable');
    }
    return runtime.newObject(runtime.prototypeFor(newTarget, iteratorPrototype));
  });
  // The spec makes `constructor` an accessor, so `util.inspect` names iterators after Object instead of Iterator.
  builder.getter(iteratorPrototype, 'constructor', () => iteratorConstructor);
  builder.constant(iteratorPrototype, WELL_KNOWN_SYMBOLS.toStringTag, 'Iterator');
  const wrapperPrototype = defineClosingPrototype(builder, 'Iterator');
  builder.method(iteratorConstructor, 'from', 1, ({ runtime, args }) => {
    const record = flattenable(runtime, args[0], true, 'Iterator.from');
    for (let current = record.iterator.proto; current; current = current.proto) {
      if (current === iteratorPrototype) return record.iterator;
    }
    return newHostIterator(runtime, wrapperPrototype, {
      source: record.iterator,
      next: () => step(runtime, record),
      close: () => closeIterator(runtime, record),
    });
  });
  const helperPrototype = defineClosingPrototype(builder, 'Iterator Helper');
  defineLazyHelpers(builder, helperPrototype);
  defineConsumers(builder);
}

/** A builtin iterator prototype whose `return()` closes the iteration, as an iterator helper's does. */
function defineClosingPrototype(builder: RealmBuilder, tag: string): JsObject {
  const prototype = defineHostIteratorPrototype(builder, tag);
  const returnMethod = builder.method(prototype, 'return', 0, ({ runtime, thisValue }) => {
    const iterator = thisValue instanceof JsObject ? thisValue.hostIterator : undefined;
    if (!iterator) {
      return runtime.throwError(
        'TypeError',
        `return method called on incompatible receiver ${runtime.describe(thisValue)}`
      );
    }
    iterator.close?.();
    return iteratorResult(runtime, undefined, true);
  });
  builder.realm.hostIteratorMethods.add(returnMethod);
  return prototype;
}

/** The spec's GetIteratorFlattenable followed by GetIteratorDirect. */
function flattenable(runtime: Runtime, value: Value, allowStrings: boolean, method: string): IteratorRecord {
  if (!isObject(value) && !(allowStrings && typeof value === 'string')) {
    return runtime.throwError('TypeError', `${method} called on non-object`);
  }
  const iteratorMethod = runtime.get(value, WELL_KNOWN_SYMBOLS.iterator);
  let iterator: Value = value;
  if (iteratorMethod !== undefined && iteratorMethod !== null) {
    iterator = runtime.call(iteratorMethod, value, [], runtime.currentRow);
  }
  if (!isObject(iterator)) return runtime.throwError('TypeError', `${runtime.describe(iterator)} is not an object`);
  return { iterator, next: runtime.get(iterator, 'next'), done: false };
}

/** The spec's IteratorStepValue, which marks the record done when the iterator ends. */
function step(runtime: Runtime, record: IteratorRecord): Value | typeof DONE {
  if (record.done) return DONE;
  const result = runtime.call(record.next, record.iterator, [], runtime.currentRow);
  if (!isObject(result))
    runtime.throwError('TypeError', `Iterator result ${runtime.describe(result)} is not an object`);
  if (toBoolean(runtime.get(result, 'done'))) {
    record.done = true;
    return DONE;
  }
  return runtime.get(result, 'value');
}

/** The spec's IteratorClose with a normal completion. */
function closeIterator(runtime: Runtime, record: IteratorRecord): void {
  if (record.done) return;
  record.done = true;
  const close = runtime.get(record.iterator, 'return');
  if (close === undefined || close === null) return;
  const result = runtime.call(close, record.iterator, [], runtime.currentRow);
  if (!isObject(result))
    runtime.throwError('TypeError', `Iterator result ${runtime.describe(result)} is not an object`);
}

/** Runs `run`, closing the iterator when it throws, as the spec's IfAbruptCloseIterator does. */
function closingOnThrow<T>(runtime: Runtime, record: IteratorRecord, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof JsThrow) {
      try {
        closeIterator(runtime, record);
      } catch {
        // The first exception wins over one that closing the iterator throws.
      }
    }
    throw error;
  }
}

/** How V8 names a value that is not a function in an iterator helper's TypeError. */
function notCallableText(runtime: Runtime, value: Value): string {
  if (typeof value === 'string') return `string "${value}"`;
  if (typeof value === 'number' || typeof value === 'boolean') return `${typeof value} ${String(value)}`;
  return runtime.describe(value);
}

/** Checks the receiver and the callback of a helper, closing the receiver when the callback is not a function. */
function startHelper(call: NativeCall, name: string): { record: IteratorRecord; callback: JsFunction } {
  const { runtime, thisValue, args } = call;
  if (!isObject(thisValue)) return runtime.throwError('TypeError', `Iterator.prototype.${name} called on non-object`);
  const record: IteratorRecord = { iterator: thisValue, next: undefined, done: false };
  const [callback] = args;
  if (!isCallable(callback)) {
    closeIterator(runtime, record);
    return runtime.throwError('TypeError', `${notCallableText(runtime, callback)} is not a function`);
  }
  record.next = runtime.get(thisValue, 'next');
  return { record, callback };
}

/** The limit of `take` or `drop`, closing the receiver when it is not a number of at least zero. */
function startLimited(call: NativeCall, name: string): { record: IteratorRecord; limit: number } {
  const { runtime, thisValue, args } = call;
  if (!isObject(thisValue)) return runtime.throwError('TypeError', `Iterator.prototype.${name} called on non-object`);
  const record: IteratorRecord = { iterator: thisValue, next: undefined, done: false };
  const limit = closingOnThrow(runtime, record, () => runtime.toNumber(args[0]));
  const integer = Number.isNaN(limit) ? Number.NaN : Math.trunc(limit);
  if (Number.isNaN(integer) || integer < 0) {
    closeIterator(runtime, record);
    runtime.throwError('RangeError', `${typeof args[0] === 'symbol' ? 'Symbol()' : String(limit)} must be positive`);
  }
  record.next = runtime.get(thisValue, 'next');
  return { record, limit: integer };
}

/** Creates a helper over `record`, whose roots keep the underlying iterator and the callback alive. */
function newHelper(
  runtime: Runtime,
  prototype: JsObject,
  record: IteratorRecord,
  roots: JsArray,
  next: () => Value | typeof DONE
): JsObject {
  return newHostIterator(runtime, prototype, {
    source: roots,
    next: () => (record.done ? DONE : next()),
    close: () => closeIterator(runtime, record),
  } satisfies HostIterator);
}

// code-gauge-allow functionCognitiveComplexity 20 -- Transcribes the specification's algorithm step by step, whose branches mirror its steps.
function defineLazyHelpers(builder: RealmBuilder, helperPrototype: JsObject): void {
  const { iteratorPrototype } = builder.realm;
  for (const [name, keeps] of [
    ['map', true],
    ['filter', false],
  ] as const) {
    builder.method(iteratorPrototype, name, 1, (call) => {
      const { runtime } = call;
      const { record, callback } = startHelper(call, name);
      let counter = 0;
      return newHelper(runtime, helperPrototype, record, runtime.newArray([record.iterator, callback]), () => {
        for (;;) {
          const value = step(runtime, record);
          if (value === DONE) return DONE;
          const result = closingOnThrow(runtime, record, () =>
            runtime.call(callback, undefined, [value, counter++], runtime.currentRow)
          );
          if (keeps) return result;
          if (toBoolean(result)) return value;
        }
      });
    });
  }
  builder.method(iteratorPrototype, 'flatMap', 1, (call) => flatMap(call, helperPrototype));
  defineLimitHelpers(builder, helperPrototype);
}

function defineLimitHelpers(builder: RealmBuilder, helperPrototype: JsObject): void {
  const { iteratorPrototype } = builder.realm;
  builder.method(iteratorPrototype, 'take', 1, (call) => {
    const { runtime } = call;
    const { record, limit } = startLimited(call, 'take');
    let remaining = limit;
    return newHelper(runtime, helperPrototype, record, runtime.newArray([record.iterator]), () => {
      if (remaining === 0) {
        closeIterator(runtime, record);
        return DONE;
      }
      remaining--;
      return step(runtime, record);
    });
  });
  builder.method(iteratorPrototype, 'drop', 1, (call) => {
    const { runtime } = call;
    const { record, limit } = startLimited(call, 'drop');
    let remaining = limit;
    return newHelper(runtime, helperPrototype, record, runtime.newArray([record.iterator]), () => {
      for (; remaining > 0; remaining--) if (step(runtime, record) === DONE) return DONE;
      return step(runtime, record);
    });
  });
}

function flatMap(call: NativeCall, helperPrototype: JsObject): JsObject {
  const { runtime } = call;
  const { record, callback } = startHelper(call, 'flatMap');
  let counter = 0;
  let inner: IteratorRecord | undefined;
  const roots = runtime.newArray([record.iterator, callback, undefined]);
  const flatMapped = newHelper(runtime, helperPrototype, record, roots, () => {
    for (;;) {
      if (inner) {
        const current = inner;
        const value = closingOnThrow(runtime, record, () => step(runtime, current));
        if (value !== DONE) return value;
        inner = undefined;
      }
      const value = step(runtime, record);
      if (value === DONE) return DONE;
      inner = closingOnThrow(runtime, record, () => {
        const mapped = runtime.call(callback, undefined, [value, counter++], runtime.currentRow);
        return flattenable(runtime, mapped, false, 'Iterator.prototype.flatMap');
      });
      roots.elements[2] = inner.iterator;
    }
  });
  const iteration = flatMapped.hostIterator as HostIterator;
  const closeOuter = iteration.close;
  iteration.close = () => {
    if (inner) closeIterator(runtime, inner);
    closeOuter?.();
  };
  return flatMapped;
}

// code-gauge-allow functionCognitiveComplexity 27 -- Transcribes the specification's algorithm step by step, whose branches mirror its steps.
// code-gauge-allow functionNcss 49 -- Transcribes the specification's algorithm step by step, whose branches mirror its steps.
function defineConsumers(builder: RealmBuilder): void {
  const { iteratorPrototype } = builder.realm;
  builder.method(iteratorPrototype, 'toArray', 0, ({ runtime, thisValue }) => {
    if (!isObject(thisValue)) return runtime.throwError('TypeError', 'Iterator.prototype.toArray called on non-object');
    const record: IteratorRecord = { iterator: thisValue, next: runtime.get(thisValue, 'next'), done: false };
    const array = runtime.newArray([]);
    runtime.hold(array, () => {
      for (let value = step(runtime, record); value !== DONE; value = step(runtime, record)) {
        runtime.allocate(1);
        array.elements.push(value);
      }
    });
    return array;
  });
  builder.method(iteratorPrototype, 'reduce', 1, (call) => {
    const { runtime, args } = call;
    const { record, callback } = startHelper(call, 'reduce');
    let accumulator: Value;
    let counter = 0;
    if (args.length < 2) {
      accumulator = step(runtime, record) as Value;
      if ((accumulator as Value | typeof DONE) === DONE) {
        runtime.throwError('TypeError', 'Reduce of a done iterator with no initial value');
      }
      counter = 1;
    } else accumulator = args[1];
    for (let value = step(runtime, record); value !== DONE; value = step(runtime, record)) {
      const previous = accumulator;
      accumulator = closingOnThrow(runtime, record, () =>
        runtime.hold(previous, () =>
          runtime.call(callback, undefined, [previous, value, counter++], runtime.currentRow)
        )
      );
    }
    return accumulator;
  });
  builder.method(iteratorPrototype, 'forEach', 1, (call) => {
    const { runtime } = call;
    const { record, callback } = startHelper(call, 'forEach');
    let counter = 0;
    for (let value = step(runtime, record); value !== DONE; value = step(runtime, record)) {
      const current = value;
      closingOnThrow(runtime, record, () =>
        runtime.call(callback, undefined, [current, counter++], runtime.currentRow)
      );
    }
    return;
  });
  for (const [name, stopsOn, found, notFound] of [
    ['some', true, true, false],
    ['every', false, false, true],
    ['find', true, undefined, undefined],
  ] as const) {
    builder.method(iteratorPrototype, name, 1, (call) => {
      const { runtime } = call;
      const { record, callback } = startHelper(call, name);
      let counter = 0;
      for (let value = step(runtime, record); value !== DONE; value = step(runtime, record)) {
        const current = value;
        const result = closingOnThrow(runtime, record, () =>
          runtime.call(callback, undefined, [current, counter++], runtime.currentRow)
        );
        if (toBoolean(result) !== stopsOn) continue;
        closeIterator(runtime, record);
        return name === 'find' ? current : found;
      }
      return notFound;
    });
  }
}
