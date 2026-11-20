import { WELL_KNOWN_SYMBOLS } from './realmIterators';
import type { Runtime } from './runtime';
import { type Binding, freeze, isAccessor, type JsFunction, type JsObject, type Property, type Value } from './values';

export function createArgumentsObject(runtime: Runtime, fn: JsFunction, args: Value[], mapped: boolean): JsObject {
  const object = runtime.newObject();
  object.isArguments = true;
  runtime.allocate(args.length + 3);
  for (const [index, value] of args.entries()) {
    object.properties.set(String(index), { value, writable: true, enumerable: true, configurable: true });
  }
  const hidden = { writable: true, enumerable: false, configurable: true };
  object.properties.set('length', { value: args.length, ...hidden });
  object.properties.set(WELL_KNOWN_SYMBOLS.iterator, {
    value: runtime.get(runtime.realm.arrayPrototype, 'values'),
    ...hidden,
  });
  if (mapped) {
    object.properties.set('callee', { value: fn, ...hidden });
  } else {
    const thrower = (runtime.realm.argumentsCalleeThrower ??= restrictedCallee(runtime));
    object.properties.set('callee', {
      get: thrower,
      set: thrower,
      enumerable: false,
      configurable: false,
      readonlyAssignment: true,
    });
  }
  return object;
}

function restrictedCallee(runtime: Runtime): JsFunction {
  const thrower = runtime.newNativeFunction('', 0, () =>
    runtime.throwError(
      'TypeError',
      "'caller', 'callee', and 'arguments' properties may not be accessed on strict mode functions or the arguments objects for calls to them"
    )
  );
  freeze(thrower);
  return thrower;
}

/**
 * Links each parameter to its element of `arguments`, as a function that is not strict mode code with only simple
 * parameters does, until the element is deleted, becomes an accessor, or becomes read-only.
 */
// code-gauge-allow functionCognitiveComplexity 16 -- Tracks detachment and the independent parameter value after deletion, accessor conversion, or a read-only definition.
export function mapArguments(bindings: Map<string, Binding>, names: string[], argumentsObject: JsObject): void {
  for (const [index, name] of names.entries()) {
    const element = argumentsObject.properties.get(String(index));
    if (!element || isAccessor(element)) break;
    let isLinked = true;
    let own = element.value;
    const linked = (): boolean => {
      if (isLinked && (argumentsObject.properties.get(String(index)) !== element || !element.writable)) {
        isLinked = false;
        own = element.value;
      }
      return isLinked;
    };
    bindings.set(name, {
      get value(): Value {
        return linked() ? element.value : own;
      },
      set value(value: Value) {
        if (linked()) element.value = value;
        else own = value;
      },
      isMutable: true,
    });
  }
}

export function redefineArgument(current: Property, property: Property): Property {
  if (isAccessor(current) && current.readonlyAssignment && isAccessor(property))
    return { ...property, readonlyAssignment: true };
  if (isAccessor(current) || isAccessor(property)) return property;
  // V8 disconnects arguments with custom attributes before a read-only definition updates their value.
  if (property.writable || (current.enumerable && current.configurable)) current.value = property.value;
  return property.writable ? Object.assign(current, property) : property;
}
