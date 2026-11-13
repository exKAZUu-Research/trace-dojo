import { closingOnThrow, DONE } from './iteration';
import type { RealmBuilder } from './realm';
import { groupBy } from './realmCollections';
import type { Runtime } from './runtime';
import {
  HOLE,
  isAccessor,
  isCallable,
  isObject,
  JsArray,
  JsFunction,
  type JsObject,
  type Key,
  type Property,
  toBoolean,
  type Value,
} from './values';

type ObjectMethod = (name: string, length: number, run: (runtime: Runtime, args: Value[]) => Value) => void;

/** Defines the Object functions that describe and define properties, and the remaining everyday Object functions. */
export function defineObjectBuiltins(builder: RealmBuilder): void {
  const objectConstructor = builder.realm.globals.bindings.get('Object')?.value;
  if (!(objectConstructor instanceof JsFunction)) throw new Error('Object must be defined first');
  const method: ObjectMethod = (name, length, run) => {
    builder.method(objectConstructor, name, length, ({ runtime, args }) => run(runtime, args));
  };
  defineEntries(method);
  defineReflection(method);
  defineIntegrity(method);
  const { objectPrototype } = builder.realm;
  builder.getter(
    objectPrototype,
    '__proto__',
    ({ runtime, thisValue }) => runtime.toObject(thisValue).proto,
    ({ runtime, thisValue, args }) => {
      if (thisValue === undefined || thisValue === null) {
        return runtime.throwError('TypeError', 'Object.prototype.__proto__ called on null or undefined');
      }
      const [proto] = args;
      if (isObject(thisValue) && (proto === null || isObject(proto))) changePrototype(runtime, thisValue, proto);
      return;
    }
  );
  builder.method(objectPrototype, 'isPrototypeOf', 1, ({ runtime, thisValue, args }) => {
    if (!isObject(args[0])) return false;
    const object = runtime.toObject(thisValue);
    for (let current = args[0].proto; current; current = current.proto) if (current === object) return true;
    return false;
  });
  builder.method(objectPrototype, 'propertyIsEnumerable', 1, ({ runtime, thisValue, args }) => {
    const key = runtime.toPropertyKey(args[0]);
    return runtime.getOwnProperty(runtime.toObject(thisValue), key)?.enumerable ?? false;
  });
}

function defineEntries(method: ObjectMethod): void {
  method('is', 2, (_, args) => Object.is(args[0], args[1]));
  method('hasOwn', 2, (runtime, args) => {
    const object = runtime.toObject(args[0]);
    return runtime.getOwnProperty(object, runtime.toPropertyKey(args[1])) !== undefined;
  });
  method('fromEntries', 1, fromEntries);
  method('groupBy', 2, (runtime, args) => {
    const groups = groupBy(runtime, args[0], args[1], runtime.currentRow, (key) => runtime.toPropertyKey(key));
    // oxlint-disable-next-line unicorn/no-null -- Object.groupBy returns an object without a prototype.
    const object = runtime.newObject(null);
    for (const [key, values] of groups) runtime.createDataProperty(object, key as Key, runtime.newArray(values));
    return object;
  });
}

function fromEntries(runtime: Runtime, args: Value[]): Value {
  if (args[0] === undefined || args[0] === null) runtime.throwError('TypeError', `${String(args[0])} is not iterable`);
  const object = runtime.newObject();
  runtime.hold(object, () => {
    const iterator = runtime.iterator(args[0]);
    closingOnThrow(iterator, () => {
      for (let entry = iterator.next(); entry !== DONE; entry = iterator.next()) {
        if (!isObject(entry)) {
          runtime.throwError('TypeError', `Iterator value ${primitiveText(entry)} is not an entry object`);
        }
        const key = runtime.toPropertyKey(runtime.get(entry, '0'));
        runtime.createDataProperty(object, key, runtime.get(entry, '1'));
      }
    });
  });
  return object;
}

// code-gauge-allow functionNcss 32 -- Lists the builtin methods, each a small closure of its own.
function defineReflection(method: ObjectMethod): void {
  method('getOwnPropertyNames', 1, (runtime, args) =>
    runtime.newArray(ownPropertyNames(runtime, runtime.toObject(args[0])))
  );
  method('getOwnPropertySymbols', 1, (runtime, args) =>
    runtime.newArray(runtime.ownSymbols(runtime.toObject(args[0])))
  );
  method('getOwnPropertyDescriptor', 2, (runtime, args) => {
    const object = runtime.toObject(args[0]);
    return descriptorObject(runtime, runtime.getOwnProperty(object, runtime.toPropertyKey(args[1])));
  });
  method('getOwnPropertyDescriptors', 1, (runtime, args) => {
    const object = runtime.toObject(args[0]);
    const result = runtime.newObject();
    return runtime.hold(result, () => {
      for (const key of [...ownPropertyNames(runtime, object), ...runtime.ownSymbols(object)]) {
        runtime.createDataProperty(result, key, descriptorObject(runtime, runtime.getOwnProperty(object, key)));
      }
      return result;
    });
  });
  method('defineProperty', 3, (runtime, args) => {
    const [object, key, attributes] = args;
    if (!isObject(object)) return runtime.throwError('TypeError', 'Object.defineProperty called on non-object');
    definePropertyOrThrow(runtime, object, runtime.toPropertyKey(key), toPropertyDescriptor(runtime, attributes));
    return object;
  });
  method('defineProperties', 2, (runtime, args) => {
    const [object, properties] = args;
    if (!isObject(object)) return runtime.throwError('TypeError', 'Object.defineProperties called on non-object');
    const source = runtime.toObject(properties);
    const descriptors: [Key, Descriptor][] = [];
    for (const key of [...runtime.ownKeys(source), ...runtime.ownSymbols(source)]) {
      if (!runtime.getOwnProperty(source, key)?.enumerable) continue;
      descriptors.push([key, toPropertyDescriptor(runtime, runtime.get(source, key))]);
    }
    for (const [key, descriptor] of descriptors) definePropertyOrThrow(runtime, object, key, descriptor);
    return object;
  });
}

function defineIntegrity(method: ObjectMethod): void {
  method('isExtensible', 1, (_, args) => isObject(args[0]) && args[0].extensible);
  method('preventExtensions', 1, (_, args) => {
    if (isObject(args[0])) args[0].extensible = false;
    return args[0];
  });
  method('seal', 1, (_, args) => {
    const [object] = args;
    if (!isObject(object)) return object;
    object.extensible = false;
    if (object instanceof JsArray) object.sealed = true;
    for (const property of object.properties.values()) property.configurable = false;
    return object;
  });
  method('isSealed', 1, (_, args) => isLocked(args[0], false));
  method('isFrozen', 1, (_, args) => isLocked(args[0], true));
  method('setPrototypeOf', 2, setPrototypeOf);
}

function setPrototypeOf(runtime: Runtime, args: Value[]): Value {
  const [object, proto] = args;
  if (object === undefined || object === null) {
    return runtime.throwError('TypeError', 'Object.setPrototypeOf called on null or undefined');
  }
  if (proto !== null && !isObject(proto)) {
    return runtime.throwError(
      'TypeError',
      `Object prototype may only be an Object or null: ${runtime.describe(proto)}`
    );
  }
  if (isObject(object)) changePrototype(runtime, object, proto);
  return object;
}

/** The spec's OrdinarySetPrototypeOf, throwing where Object.setPrototypeOf and the `__proto__` setter throw. */
function changePrototype(runtime: Runtime, object: JsObject, proto: JsObject | null): void {
  if (object.proto === proto) return;
  if (object === runtime.realm.objectPrototype) {
    runtime.throwError('TypeError', "Immutable prototype object 'Object.prototype' cannot have their prototype set");
  }
  if (!object.extensible) runtime.throwError('TypeError', '#<Object> is not extensible');
  for (let current = proto; current; current = current.proto) {
    if (current === object) runtime.throwError('TypeError', 'Cyclic __proto__ value');
  }
  object.proto = proto;
}

function primitiveText(value: Exclude<Value, JsObject>): string {
  return typeof value === 'symbol' ? value.toString() : String(value);
}

/** Own string keys, enumerable or not, with an array's `length` after its indices as V8 orders them. */
function ownPropertyNames(runtime: Runtime, object: JsObject): string[] {
  const keys = runtime.ownKeys(object);
  if (!(object instanceof JsArray)) return keys;
  const indexCount = keys.findIndex((key) => !/^(?:0|[1-9]\d*)$/.test(key));
  keys.splice(indexCount === -1 ? keys.length : indexCount, 0, 'length');
  return keys;
}

/** Whether an object is sealed, or frozen when `frozen` is set, as `Object.isSealed` and `Object.isFrozen` test. */
function isLocked(value: Value, frozen: boolean): boolean {
  if (!isObject(value)) return true;
  if (value.extensible) return false;
  if (value instanceof JsArray && !(frozen ? value.frozen : value.sealed) && value.elements.some((e) => e !== HOLE))
    return false;
  for (const property of value.properties.values()) {
    if (property.configurable) return false;
    if (frozen && !isAccessor(property) && property.writable) return false;
  }
  return true;
}

/** The fields a property descriptor object gives, any of which may be absent. */
interface Descriptor {
  value?: Value;
  writable?: boolean;
  get?: JsFunction | undefined;
  set?: JsFunction | undefined;
  enumerable?: boolean;
  configurable?: boolean;
}

/** The spec's ToPropertyDescriptor. */
// code-gauge-allow functionCognitiveComplexity 18 -- Transcribes the specification's algorithm step by step, whose branches mirror its steps.
function toPropertyDescriptor(runtime: Runtime, value: Value): Descriptor {
  if (!isObject(value))
    return runtime.throwError('TypeError', `Property description must be an object: ${runtime.describe(value)}`);
  const descriptor: Descriptor = {};
  for (const field of ['enumerable', 'configurable'] as const) {
    if (runtime.hasProperty(value, field)) descriptor[field] = toBoolean(runtime.get(value, field));
  }
  if (runtime.hasProperty(value, 'value')) descriptor.value = runtime.get(value, 'value');
  if (runtime.hasProperty(value, 'writable')) descriptor.writable = toBoolean(runtime.get(value, 'writable'));
  for (const field of ['get', 'set'] as const) {
    if (!runtime.hasProperty(value, field)) continue;
    const accessor = runtime.get(value, field);
    if (accessor !== undefined && !isCallable(accessor)) {
      runtime.throwError(
        'TypeError',
        `${field === 'get' ? 'Getter' : 'Setter'} must be a function: ${runtime.describe(accessor)}`
      );
    }
    descriptor[field] = accessor;
  }
  if (('get' in descriptor || 'set' in descriptor) && ('value' in descriptor || 'writable' in descriptor)) {
    runtime.throwError(
      'TypeError',
      'Invalid property descriptor. Cannot both specify accessors and a value or writable attribute, #<Object>'
    );
  }
  return descriptor;
}

/** The spec's ValidateAndApplyPropertyDescriptor on an ordinary object, which throws where it would return false. */
// code-gauge-allow functionCognitiveComplexity 23 -- Transcribes the specification's algorithm step by step, whose branches mirror its steps.
function definePropertyOrThrow(runtime: Runtime, object: JsObject, key: Key, descriptor: Descriptor): void {
  const current = runtime.getOwnProperty(object, key);
  const isAccessorDescriptor = 'get' in descriptor || 'set' in descriptor;
  if (!current) {
    if (!object.extensible) {
      runtime.throwError('TypeError', `Cannot define property ${String(key)}, object is not extensible`);
    }
    const flags = { enumerable: descriptor.enumerable ?? false, configurable: descriptor.configurable ?? false };
    runtime.defineProperty(
      object,
      key,
      isAccessorDescriptor
        ? { get: descriptor.get, set: descriptor.set, ...flags }
        : { value: descriptor.value, writable: descriptor.writable ?? false, ...flags }
    );
    return;
  }
  if (!current.configurable && !isCompatible(current, descriptor, isAccessorDescriptor)) {
    runtime.throwError('TypeError', `Cannot redefine property: ${String(key)}`);
  }
  const flags = {
    enumerable: descriptor.enumerable ?? current.enumerable,
    configurable: descriptor.configurable ?? current.configurable,
  };
  let next: Property;
  if (isAccessorDescriptor) {
    const previous = isAccessor(current) ? current : { get: undefined, set: undefined };
    next = {
      get: 'get' in descriptor ? descriptor.get : previous.get,
      set: 'set' in descriptor ? descriptor.set : previous.set,
      ...flags,
    };
  } else if (isAccessor(current) && !('value' in descriptor || 'writable' in descriptor)) {
    next = { ...current, ...flags };
  } else {
    const previous = isAccessor(current) ? { value: undefined, writable: false } : current;
    next = {
      value: 'value' in descriptor ? descriptor.value : previous.value,
      writable: descriptor.writable ?? previous.writable,
      ...flags,
    };
  }
  runtime.defineProperty(object, key, next);
}

/** Whether a descriptor only restates or narrows a non-configurable property, which the spec allows. */
function isCompatible(current: Property, descriptor: Descriptor, isAccessorDescriptor: boolean): boolean {
  if (descriptor.configurable) return false;
  if (descriptor.enumerable !== undefined && descriptor.enumerable !== current.enumerable) return false;
  if (isAccessor(current)) {
    if ('value' in descriptor || 'writable' in descriptor) return false;
    return (
      (!('get' in descriptor) || descriptor.get === current.get) &&
      (!('set' in descriptor) || descriptor.set === current.set)
    );
  }
  if (isAccessorDescriptor) return false;
  if (current.writable) return true;
  if (descriptor.writable) return false;
  return !('value' in descriptor) || Object.is(descriptor.value, current.value);
}

/** The spec's FromPropertyDescriptor. */
function descriptorObject(runtime: Runtime, property: Property | undefined): Value {
  if (!property) return undefined;
  const result = runtime.newObject();
  if (isAccessor(property)) {
    runtime.createDataProperty(result, 'get', property.get);
    runtime.createDataProperty(result, 'set', property.set);
  } else {
    runtime.createDataProperty(result, 'value', property.value);
    runtime.createDataProperty(result, 'writable', property.writable);
  }
  runtime.createDataProperty(result, 'enumerable', property.enumerable);
  runtime.createDataProperty(result, 'configurable', property.configurable);
  return result;
}
