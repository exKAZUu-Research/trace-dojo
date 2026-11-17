import type { FunctionNode } from './ast';
import { WELL_KNOWN_SYMBOLS } from './realmIterators';
import type { Runtime } from './runtime';
import { type Binding, isAccessor, type JsFunction, type JsObject, type Value } from './values';

/** The `arguments` object of a call, whose `callee` a strict mode function refuses to give. */
export function createArgumentsObject(runtime: Runtime, fn: JsFunction, node: FunctionNode, args: Value[]): JsObject {
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
  if (node.isStrict) {
    const thrower = runtime.newNativeFunction('', 0, () =>
      runtime.throwError(
        'TypeError',
        "'caller', 'callee', and 'arguments' properties may not be accessed on strict mode functions or the arguments objects for calls to them"
      )
    );
    object.properties.set('callee', { get: thrower, set: thrower, enumerable: false, configurable: false });
  } else {
    object.properties.set('callee', { value: fn, ...hidden });
  }
  return object;
}

/**
 * Links each parameter to its element of `arguments`, as a function that is not strict mode code with only simple
 * parameters does, until the element is deleted or redefined.
 */
export function mapArguments(bindings: Map<string, Binding>, names: string[], argumentsObject: JsObject): void {
  for (const [index, name] of names.entries()) {
    const element = argumentsObject.properties.get(String(index));
    if (!element || isAccessor(element)) break;
    let isLinked = true;
    let own = element.value;
    const linked = (): boolean => {
      if (isLinked && argumentsObject.properties.get(String(index)) !== element) {
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
