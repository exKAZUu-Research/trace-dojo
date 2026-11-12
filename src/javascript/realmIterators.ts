import { ArrayOps } from './arrayOps';
import { DONE, type HostIterator } from './iteration';
import type { RealmBuilder } from './realm';
import type { Runtime } from './runtime';
import { JsArray, JsObject, type Value } from './values';

/** The well-known symbols the interpreter's builtins look up, which the program reads as `Symbol.iterator` and so on. */
export const WELL_KNOWN_SYMBOLS = {
  iterator: Symbol('Symbol.iterator'),
  asyncIterator: Symbol('Symbol.asyncIterator'),
  toStringTag: Symbol('Symbol.toStringTag'),
} as const;

/** Defines Symbol and the iterators of arrays and strings, which `%IteratorPrototype%` makes iterable themselves. */
export function defineIteratorBuiltins(builder: RealmBuilder): void {
  defineSymbol(builder);
  const { realm } = builder;
  builder.method(realm.iteratorPrototype, WELL_KNOWN_SYMBOLS.iterator, 0, ({ thisValue }) => thisValue);
  const arrayIteratorPrototype = defineHostIteratorPrototype(builder, 'Array Iterator');
  const arrayIterator = (kind: 'keys' | 'values' | 'entries') => (call: { runtime: Runtime; thisValue: Value }) =>
    newHostIterator(
      call.runtime,
      arrayIteratorPrototype,
      arrayIteration(call.runtime, call.runtime.toObject(call.thisValue), kind)
    );
  builder.method(realm.arrayPrototype, 'keys', 0, arrayIterator('keys'));
  builder.method(realm.arrayPrototype, 'entries', 0, arrayIterator('entries'));
  const values = builder.method(realm.arrayPrototype, 'values', 0, arrayIterator('values'));
  realm.arrayPrototype.properties.set(WELL_KNOWN_SYMBOLS.iterator, {
    value: values,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  const stringIteratorPrototype = defineHostIteratorPrototype(builder, 'String Iterator');
  builder.method(realm.stringPrototype, WELL_KNOWN_SYMBOLS.iterator, 0, ({ runtime, thisValue }) => {
    if (thisValue === undefined || thisValue === null) {
      return runtime.throwError('TypeError', 'String.prototype[Symbol.iterator] called on null or undefined');
    }
    const text = runtime.toString(thisValue);
    runtime.scan(text.length);
    // oxlint-disable-next-line typescript/no-misused-spread -- JavaScript iterates strings by code point.
    const codePoints = [...text];
    let index = 0;
    return newHostIterator(runtime, stringIteratorPrototype, {
      next: () => (index < codePoints.length ? codePoints[index++] : DONE),
    });
  });
}

/**
 * Defines the prototype of a builtin iterator, whose `next()` steps through the host iteration of the object it is
 * called on.
 */
export function defineHostIteratorPrototype(builder: RealmBuilder, tag: string): JsObject {
  const prototype = new JsObject(builder.realm.iteratorPrototype);
  builder.method(prototype, 'next', 0, ({ runtime, thisValue }) => {
    const iterator = thisValue instanceof JsObject ? thisValue.hostIterator : undefined;
    if (!iterator) {
      return runtime.throwError(
        'TypeError',
        `next method called on incompatible receiver ${runtime.describe(thisValue)}`
      );
    }
    const value = iterator.next();
    return iteratorResult(runtime, value === DONE ? undefined : value, value === DONE);
  });
  builder.constant(prototype, WELL_KNOWN_SYMBOLS.toStringTag, tag);
  return prototype;
}

export function newHostIterator(runtime: Runtime, prototype: JsObject, iteration: HostIterator): JsObject {
  const iterator = runtime.newObject(prototype);
  iterator.hostIterator = iteration;
  return iterator;
}

export function iteratorResult(runtime: Runtime, value: Value, done: boolean): JsObject {
  const result = runtime.newObject();
  runtime.createDataProperty(result, 'value', value);
  runtime.createDataProperty(result, 'done', done);
  return result;
}

/** Steps through an array or array-like by index, reading its length at each step as an array iterator does. */
function arrayIteration(runtime: Runtime, object: JsObject, kind: 'keys' | 'values' | 'entries'): HostIterator {
  let index = 0;
  const ops = object instanceof JsArray ? new ArrayOps(runtime, object) : undefined;
  return {
    source: object,
    next: () => {
      const length = ops ? ops.length : Math.trunc(runtime.toNumber(runtime.get(object, 'length'))) || 0;
      if (index >= length) {
        index = Number.POSITIVE_INFINITY;
        return DONE;
      }
      const current = index++;
      if (kind === 'keys') return current;
      const value = ops ? ops.get(current) : runtime.get(object, String(current));
      return kind === 'values' ? value : runtime.newArray([current, value]);
    },
  };
}

function defineSymbol(builder: RealmBuilder): void {
  const { symbolPrototype } = builder.realm;
  const registry = new Map<string, symbol>();
  const symbolConstructor = builder.defineClass(
    'Symbol',
    0,
    symbolPrototype,
    ({ runtime, args }) => Symbol(args[0] === undefined ? undefined : runtime.toString(args[0])),
    false
  );
  for (const [name, symbol] of Object.entries(WELL_KNOWN_SYMBOLS)) builder.constant(symbolConstructor, name, symbol);
  builder.method(symbolConstructor, 'for', 1, ({ runtime, args }) => {
    const key = runtime.toString(args[0]);
    let symbol = registry.get(key);
    if (!symbol) {
      symbol = Symbol(key);
      registry.set(key, symbol);
    }
    return symbol;
  });
  builder.method(symbolConstructor, 'keyFor', 1, ({ runtime, args }) => {
    const [symbol] = args;
    if (typeof symbol !== 'symbol')
      return runtime.throwError('TypeError', `${runtime.describe(symbol)} is not a symbol`);
    return registry.get(symbol.description ?? '') === symbol ? symbol.description : undefined;
  });
  builder.method(symbolPrototype, 'toString', 0, ({ runtime, thisValue }) => thisSymbol(runtime, thisValue).toString());
  builder.method(symbolPrototype, 'valueOf', 0, ({ runtime, thisValue }) => thisSymbol(runtime, thisValue));
  builder.getter(
    symbolPrototype,
    'description',
    ({ runtime, thisValue }) => thisSymbol(runtime, thisValue).description
  );
  builder.constant(symbolPrototype, WELL_KNOWN_SYMBOLS.toStringTag, 'Symbol');
}

function thisSymbol(runtime: Runtime, value: Value): symbol {
  if (typeof value === 'symbol') return value;
  return runtime.throwError('TypeError', `${runtime.describe(value)} is not a symbol`);
}
