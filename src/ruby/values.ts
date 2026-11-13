import {
  invalidateMethodCaches,
  NIL,
  RArray,
  RBasic,
  RClass,
  RHash,
  RObject,
  RProc,
  RRange,
  RString,
  RSymbol,
  type Value,
} from './objects';
import { rt } from './runtime';

export function str(s: string): RString {
  return new RString(rt().c.String, s);
}

export function arr(items: Value[]): RArray {
  rt().spend(Math.floor(items.length / 64));
  return new RArray(rt().c.Array, items);
}

export function newHash(): RHash {
  return new RHash(rt().c.Hash);
}

export function sym(name: string): RSymbol {
  return RSymbol.of(name);
}

export function range(begin: Value, end: Value, exclusive: boolean): RRange {
  return new RRange(rt().c.Range, begin, end, exclusive);
}

export function truthy(value: Value): boolean {
  return value !== false && value !== NIL;
}

export function isNil(value: Value): boolean {
  return value === NIL;
}

/** The class whose methods a value responds to: its singleton class if it has one, else its class. */
export function classOf(value: Value): RClass {
  const { c } = rt();
  switch (typeof value) {
    case 'bigint': {
      return c.Integer;
    }
    case 'number': {
      return c.Float;
    }
    case 'boolean': {
      return value ? c.TrueClass : c.FalseClass;
    }
  }
  if (value === NIL) return c.NilClass;
  if (value instanceof RSymbol) return c.Symbol;
  if (value instanceof RClass) return singletonClassOf(value);
  return (value as RBasic).singleton ?? (value as RBasic).cls;
}

/** The class a value is an instance of, skipping singleton classes, as `obj.class` returns. */
export function realClassOf(value: Value): RClass {
  if (value instanceof RClass) return value.isModule ? rt().c.Module : rt().c.Class;
  let cls = classOf(value);
  while (cls.isSingleton && cls.superclass) cls = cls.superclass;
  return cls;
}

/** The singleton class of an object, created on first use; a class's chains to its superclass's. */
export function singletonClassOf(value: Value): RClass {
  const { c } = rt();
  if (!(value instanceof RBasic)) {
    throw new TypeError('A singleton class of an immediate value');
  }
  if (value.singleton) return value.singleton;
  let superclass: RClass;
  if (value instanceof RClass) {
    if (value.isModule) superclass = c.Module;
    else superclass = value.superclass ? singletonClassOf(value.superclass) : c.Class;
  } else {
    superclass = value.cls;
  }
  const singleton = new RClass(c.Class, undefined, superclass, false, true);
  singleton.attached = value;
  value.singleton = singleton;
  invalidateMethodCaches();
  return singleton;
}

export function isA(value: Value, cls: RClass): boolean {
  return classOf(value).isSubclassOf(cls);
}

export function isString(value: Value): value is RString {
  return value instanceof RString;
}

export function isArray(value: Value): value is RArray {
  return value instanceof RArray;
}

export function isHash(value: Value): value is RHash {
  return value instanceof RHash;
}

export function isProc(value: Value): value is RProc {
  return value instanceof RProc;
}

export function isException(value: Value): value is RObject {
  return value instanceof RObject && value.exception !== undefined;
}

export function isInteger(value: Value): value is bigint {
  return typeof value === 'bigint';
}

export function isFloat(value: Value): value is number {
  return typeof value === 'number';
}

export function isNumeric(value: Value): value is bigint | number {
  return typeof value === 'bigint' || typeof value === 'number';
}
