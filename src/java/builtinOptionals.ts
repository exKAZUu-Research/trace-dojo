import { javaEquals, javaHash } from './builtinCollections';
import { callFunction } from './builtinFunctions';
import { stringify } from './builtins';
import { classType, type Context, extendsOf, superOf, typeVariable, variableType } from './builtinStreamSupport';
import { addMethod, newString } from './builtinSupport';
import { hashOf } from './builtinWrappers';
import { type Frame, throwBuiltin } from './runtime';
import { BOOLEAN, type ClassInfo, DOUBLE, INT, type JavaType, type NativeMethod, VOID } from './types';
import { JavaObject, type Value } from './values';

export interface Optionals {
  optional: ClassInfo;
  optionalInt: ClassInfo;
  optionalDouble: ClassInfo;
}

const optionalValues = new WeakMap<JavaObject, { isPresent: boolean; value: Value }>();

/** An optional holding `value` when `isPresent`, which, as Java's do, cannot hold null. */
export function createOptional(
  frame: Frame,
  cls: ClassInfo,
  value: Value,
  isPresent = value !== undefined
): JavaObject {
  if (isPresent && value === undefined) throwBuiltin(frame, 'NullPointerException');
  const object = frame.runtime.allocateObject(frame, cls);
  optionalValues.set(object, { isPresent, value });
  object.retained = [value];
  return object;
}

function stateOf(receiver: Value): { isPresent: boolean; value: Value } {
  return optionalValues.get(receiver as JavaObject) as { isPresent: boolean; value: Value };
}

function get(frame: Frame, receiver: Value): Value {
  const state = stateOf(receiver);
  if (!state.isPresent) throwBuiltin(frame, 'NoSuchElementException', 'No value present');
  return state.value;
}

// code-gauge-allow functionCognitiveComplexity 19 -- One registration per builtin method, each a small native.
// code-gauge-allow functionNcss 46 -- One registration per builtin method, each a small native.
export function defineOptionals(context: Context): Optionals {
  const { registry, objectType, stringType } = context;
  const optional = registry.define('Optional', context.objectClass, 'java.util');
  optional.isFinal = true;
  const t = typeVariable('T', objectType);
  optional.typeParameters = [t];
  const tType = variableType(t);
  const generic = (
    name: string,
    parameters: (u: JavaType) => JavaType[],
    result: (u: JavaType) => JavaType,
    native: NativeMethod
  ): void => {
    const u = typeVariable('T', objectType);
    const method = addMethod(optional, name, parameters(variableType(u)), result(variableType(u)), true, native);
    method.typeParameters = [u];
  };
  generic(
    'of',
    (u) => [u],
    (u) => classType(optional, u),
    (frame, _, [value]) => {
      if (value === undefined) throwBuiltin(frame, 'NullPointerException');
      return createOptional(frame, optional, value);
    }
  );
  generic(
    'ofNullable',
    (u) => [u],
    (u) => classType(optional, u),
    (frame, _, [value]) => createOptional(frame, optional, value)
  );
  generic(
    'empty',
    () => [],
    (u) => classType(optional, u),
    (frame) => createOptional(frame, optional, undefined)
  );
  for (const [cls, name, valueType, getter] of [
    [optional, 'Optional', tType, 'get'],
    [registry.define('OptionalInt', context.objectClass, 'java.util'), 'OptionalInt', INT, 'getAsInt'],
    [registry.define('OptionalDouble', context.objectClass, 'java.util'), 'OptionalDouble', DOUBLE, 'getAsDouble'],
  ] as const) {
    cls.isFinal = true;
    addMethod(cls, getter, [], valueType, false, (frame, receiver) => get(frame, receiver));
    addMethod(cls, 'orElseThrow', [], valueType, false, (frame, receiver) => get(frame, receiver));
    addMethod(cls, 'isPresent', [], BOOLEAN, false, (_, receiver) => stateOf(receiver).isPresent);
    addMethod(cls, 'isEmpty', [], BOOLEAN, false, (_, receiver) => !stateOf(receiver).isPresent);
    addMethod(cls, 'orElse', [valueType], valueType, false, (_, receiver, [other]) =>
      stateOf(receiver).isPresent ? stateOf(receiver).value : other
    );
    addMethod(cls, 'toString', [], stringType, false, (frame, receiver) => {
      const state = stateOf(receiver);
      return newString(
        frame,
        state.isPresent ? `${name}[${stringify(frame, state.value, valueType)}]` : `${name}.empty`
      );
    });
    addMethod(cls, 'equals', [objectType], BOOLEAN, false, (frame, receiver, [other]) => {
      if (!(other instanceof JavaObject) || other.cls !== cls) return false;
      const [a, b] = [stateOf(receiver), stateOf(other)];
      return a.isPresent === b.isPresent && (Object.is(a.value, b.value) || javaEquals(frame, a.value, b.value));
    });
    addMethod(cls, 'hashCode', [], INT, false, (frame, receiver) => optionalHash(frame, receiver, valueType));
  }
  const consumer = context.fn('Consumer');
  addMethod(optional, 'ifPresent', [classType(consumer, superOf(tType))], VOID, false, (frame, receiver, [action]) => {
    const state = stateOf(receiver);
    if (state.isPresent) callFunction(frame, consumer, action, [state.value]);
  });
  const fn = context.fn('Function');
  const u = typeVariable('U', objectType);
  const map = addMethod(
    optional,
    'map',
    [classType(fn, superOf(tType), extendsOf(variableType(u)))],
    classType(optional, variableType(u)),
    false,
    (frame, receiver, [mapper]) => {
      const state = stateOf(receiver);
      return state.isPresent
        ? createOptional(frame, optional, callFunction(frame, fn, mapper, [state.value]))
        : receiver;
    }
  );
  map.typeParameters = [u];
  defineOptionalFunctions(context, optional, tType);
  return {
    optional,
    optionalInt: registry.classes.get('OptionalInt') as ClassInfo,
    optionalDouble: registry.classes.get('OptionalDouble') as ClassInfo,
  };
}

/** The hash of an optional's value as its wrapper or `hashCode` gives it, or 0 when it is empty. */
function optionalHash(frame: Frame, receiver: Value, valueType: JavaType): number {
  const { isPresent, value } = stateOf(receiver);
  if (!isPresent || value === undefined) return 0;
  return valueType === INT || valueType === DOUBLE
    ? hashOf(value, valueType.kind as 'int' | 'double')
    : javaHash(frame, value);
}

/** `Optional`'s methods that take functions for the value or its absence. */
function defineOptionalFunctions(context: Context, optional: ClassInfo, tType: JavaType): void {
  const supplier = context.fn('Supplier');
  const predicate = context.fn('Predicate');
  const consumer = context.fn('Consumer');
  addMethod(
    optional,
    'orElseGet',
    [classType(supplier, extendsOf(tType))],
    tType,
    false,
    (frame, receiver, [other]) => {
      const state = stateOf(receiver);
      return state.isPresent ? state.value : callFunction(frame, supplier, other, []);
    }
  );
  addMethod(
    optional,
    'filter',
    [classType(predicate, superOf(tType))],
    classType(optional, tType),
    false,
    (frame, receiver, [test]) => {
      const state = stateOf(receiver);
      if (!state.isPresent || callFunction(frame, predicate, test, [state.value]) === true) return receiver;
      return createOptional(frame, optional, undefined, false);
    }
  );
  addMethod(
    optional,
    'ifPresentOrElse',
    [classType(consumer, superOf(tType)), context.fn('Runnable').type],
    VOID,
    false,
    (frame, receiver, [action, otherwise]) => {
      const state = stateOf(receiver);
      if (state.isPresent) callFunction(frame, consumer, action, [state.value]);
      else callFunction(frame, context.fn('Runnable'), otherwise, []);
    }
  );
}
