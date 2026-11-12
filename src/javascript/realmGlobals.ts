import { TURTLE_METHOD_NAMES } from '../interpreter/turtleWorld';
import { formatLogArguments } from './consoleFormat';
import { inspect } from './inspect';
import type { ErrorName, RealmBuilder } from './realm';
import { WELL_KNOWN_SYMBOLS } from './realmIterators';
import { defineHidden, type Runtime } from './runtime';
import {
  freeze,
  isCallable,
  isObject,
  JsArray,
  JsFunction,
  JsObject,
  type NativeCall,
  toBoolean,
  type Value,
} from './values';

export function defineGlobalBuiltins(builder: RealmBuilder): void {
  builder.global('undefined', undefined, false);
  builder.global('NaN', Number.NaN, false);
  builder.global('Infinity', Number.POSITIVE_INFINITY, false);
  builder.global('globalThis', undefined, false);
  defineObject(builder);
  defineFunction(builder);
  defineErrors(builder);
  defineNumber(builder);
  defineBoolean(builder);
  defineMath(builder);
  defineConsole(builder);
  defineTurtle(builder);
}

function defineObject(builder: RealmBuilder): void {
  const { objectPrototype } = builder.realm;
  const objectConstructor = builder.defineClass('Object', 1, objectPrototype, ({ runtime, args, newTarget }) => {
    const value = args[0];
    if (newTarget && newTarget !== objectConstructor) {
      return runtime.newObject(runtime.prototypeFor(newTarget, objectPrototype));
    }
    return value === undefined || value === null ? runtime.newObject() : runtime.toObject(value);
  });
  defineObjectStatics(builder, objectConstructor);
  builder.method(
    objectPrototype,
    'hasOwnProperty',
    1,
    ({ runtime, thisValue, args }) =>
      runtime.getOwnProperty(runtime.toObject(thisValue), runtime.toPropertyKey(args[0])) !== undefined
  );
  builder.method(objectPrototype, 'toString', 0, ({ runtime, thisValue }) => {
    const tag =
      thisValue === undefined || thisValue === null
        ? undefined
        : runtime.get(thisValue, WELL_KNOWN_SYMBOLS.toStringTag);
    return `[object ${typeof tag === 'string' ? tag : tagOf(thisValue)}]`;
  });
  builder.method(objectPrototype, 'valueOf', 0, ({ runtime, thisValue }) => runtime.toObject(thisValue));
}

function tagOf(value: Value): string {
  if (value === undefined) return 'Undefined';
  if (value === null) return 'Null';
  if (value instanceof JsArray) return 'Array';
  if (value instanceof JsFunction) return 'Function';
  if (value instanceof JsObject) {
    if (value.regexp) return 'RegExp';
    return value.isError ? 'Error' : 'Object';
  }
  if (typeof value === 'string') return 'String';
  return typeof value === 'number' ? 'Number' : 'Boolean';
}

// code-gauge-allow functionCognitiveComplexity 21 -- Lists the builtin methods, each a small closure of its own.
// code-gauge-allow functionNcss 36 -- Lists the builtin methods, each a small closure of its own.
function defineObjectStatics(builder: RealmBuilder, objectConstructor: JsFunction): void {
  builder.method(objectConstructor, 'keys', 1, ({ runtime, args }) =>
    runtime.newArray(runtime.ownEnumerableKeys(runtime.toObject(args[0])))
  );
  builder.method(objectConstructor, 'values', 1, ({ runtime, args }) =>
    collectProperties(runtime, args[0], (key, value) => value)
  );
  builder.method(objectConstructor, 'entries', 1, ({ runtime, args }) =>
    collectProperties(runtime, args[0], (key, value) => runtime.newArray([key, value]))
  );
  builder.method(objectConstructor, 'assign', 2, ({ runtime, args }) => {
    const target = runtime.toObject(args[0]);
    for (const source of args.slice(1)) {
      if (source === undefined || source === null) continue;
      const object = runtime.toObject(source);
      for (const key of runtime.ownEnumerableKeys(object)) runtime.set(target, key, runtime.get(object, key));
    }
    return target;
  });
  builder.method(objectConstructor, 'getPrototypeOf', 1, ({ runtime, args }) => runtime.toObject(args[0]).proto);
  builder.method(objectConstructor, 'create', 1, ({ runtime, args }) => {
    const proto = args[0];
    if (proto !== null && !isObject(proto)) {
      return runtime.throwError('TypeError', 'Object prototype may only be an Object or null');
    }
    return runtime.newObject(proto);
  });
  builder.method(objectConstructor, 'freeze', 1, ({ args }) => {
    const object = args[0];
    if (isObject(object)) freeze(object);
    return object;
  });
}

/**
 * Collects a value for each own enumerable property into an array held while getters run, so the turtles collected so
 * far stay reachable.
 */
function collectProperties(runtime: Runtime, value: Value, entry: (key: string, value: Value) => Value): JsArray {
  const object = runtime.toObject(value);
  const result = runtime.newArray([]);
  return runtime.hold(result, () => {
    for (const key of runtime.ownEnumerableKeys(object)) {
      const property = runtime.get(object, key);
      runtime.allocate(1);
      result.elements.push(runtime.hold(property, () => entry(key, property)));
    }
    return result;
  });
}

// code-gauge-allow functionCognitiveComplexity 18 -- Lists the builtin methods, each a small closure of its own.
function defineFunction(builder: RealmBuilder): void {
  const { functionPrototype } = builder.realm;
  builder.defineClass(
    'Function',
    1,
    functionPrototype,
    ({ runtime }) => runtime.throwError('TypeError', 'Function() is not supported'),
    false
  );
  builder.method(functionPrototype, 'call', 1, ({ runtime, thisValue, args, callRow }) =>
    runtime.call(thisValue, args[0], args.slice(1), callRow)
  );
  builder.method(functionPrototype, 'apply', 2, ({ runtime, thisValue, args, callRow }) => {
    const list = args[1];
    if (list !== undefined && list !== null && !(list instanceof JsArray)) {
      runtime.throwError('TypeError', 'The second argument of apply must be an array');
    }
    return runtime.call(thisValue, args[0], list instanceof JsArray ? [...runtime.iterate(list)] : [], callRow);
  });
  builder.method(functionPrototype, 'bind', 1, ({ runtime, thisValue, args }) => {
    const target = thisValue;
    if (!isCallable(target)) return runtime.throwError('TypeError', 'Bind must be called on a function');
    const boundThis = args[0];
    const boundArgs = args.slice(1);
    runtime.allocate(boundArgs.length + 1);
    const bound = runtime.newNativeFunction(
      `bound ${runtime.functionName(target)}`,
      0,
      (call) =>
        call.newTarget
          ? runtime.construct(
              target,
              [...boundArgs, ...call.args],
              call.newTarget === bound ? target : call.newTarget,
              call.callRow
            )
          : runtime.call(target, boundThis, [...boundArgs, ...call.args], call.callRow),
      target.isConstructor
    );
    bound.captured = [target, boundThis, ...boundArgs];
    return bound;
  });
  builder.method(functionPrototype, 'toString', 0, ({ runtime, thisValue }) => {
    if (!(thisValue instanceof JsFunction))
      return runtime.throwError('TypeError', 'Function.prototype.toString requires a function');
    const { behavior } = thisValue;
    if (behavior.kind === 'native') return `function ${runtime.functionName(thisValue)}() { [native code] }`;
    return behavior.node.source;
  });
}

const errorNames: ErrorName[] = ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError'];

function defineErrors(builder: RealmBuilder): void {
  const { errorPrototypes } = builder.realm;
  let errorConstructor: JsFunction | undefined;
  for (const name of errorNames) {
    const prototype = errorPrototypes[name];
    const fn = builder.defineClass(name, 1, prototype, (call) => createError(call, prototype));
    if (errorConstructor) fn.proto = errorConstructor;
    else errorConstructor = fn;
    defineHidden(prototype, 'name', name);
    defineHidden(prototype, 'message', '');
  }
  builder.method(errorPrototypes.Error, 'toString', 0, ({ runtime, thisValue }) => {
    if (!isObject(thisValue)) return runtime.throwError('TypeError', 'Error.prototype.toString requires an object');
    const nameValue = runtime.get(thisValue, 'name');
    const messageValue = runtime.get(thisValue, 'message');
    const name = nameValue === undefined ? 'Error' : runtime.toString(nameValue);
    const message = messageValue === undefined ? '' : runtime.toString(messageValue);
    if (!name) return message;
    return message ? `${name}: ${message}` : name;
  });
}

function createError({ runtime, args, newTarget }: NativeCall, prototype: JsObject): JsObject {
  const error = runtime.newObject(runtime.prototypeFor(newTarget, prototype));
  error.isError = true;
  const [message, options] = args;
  if (message !== undefined) defineHidden(error, 'message', runtime.toString(message));
  if (isObject(options) && runtime.hasProperty(options, 'cause'))
    defineHidden(error, 'cause', runtime.get(options, 'cause'));
  return error;
}

// code-gauge-allow functionCognitiveComplexity 16 -- Lists the builtin methods, each a small closure of its own.
// code-gauge-allow functionNcss 32 -- Lists the builtin methods, each a small closure of its own.
function defineNumber(builder: RealmBuilder): void {
  const { numberPrototype } = builder.realm;
  const numberConstructor = builder.defineClass(
    'Number',
    1,
    numberPrototype,
    ({ runtime, args }) => (args.length === 0 ? 0 : runtime.toNumber(args[0])),
    false
  );
  for (const [name, value] of [
    ['MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER],
    ['MIN_SAFE_INTEGER', Number.MIN_SAFE_INTEGER],
    ['MAX_VALUE', Number.MAX_VALUE],
    ['MIN_VALUE', Number.MIN_VALUE],
    ['EPSILON', Number.EPSILON],
    ['POSITIVE_INFINITY', Number.POSITIVE_INFINITY],
    ['NEGATIVE_INFINITY', Number.NEGATIVE_INFINITY],
    ['NaN', Number.NaN],
  ] as const) {
    builder.constant(numberConstructor, name, value);
  }
  for (const [name, test] of [
    ['isInteger', Number.isInteger],
    ['isSafeInteger', Number.isSafeInteger],
    ['isFinite', Number.isFinite],
    ['isNaN', Number.isNaN],
  ] as const) {
    builder.method(numberConstructor, name, 1, ({ args }) => test(args[0]));
  }
  const parseIntFunction = builder.method(numberConstructor, 'parseInt', 2, ({ runtime, args }) => {
    const text = runtime.toString(args[0]);
    runtime.scan(text.length);
    return Number.parseInt(text, args[1] === undefined ? undefined : runtime.toNumber(args[1]));
  });
  const parseFloatFunction = builder.method(numberConstructor, 'parseFloat', 1, ({ runtime, args }) => {
    const text = runtime.toString(args[0]);
    runtime.scan(text.length);
    return Number.parseFloat(text);
  });
  builder.global('parseInt', parseIntFunction);
  builder.global('parseFloat', parseFloatFunction);
  builder.global(
    'isNaN',
    builder.function('isNaN', 1, ({ runtime, args }) => Number.isNaN(runtime.toNumber(args[0])))
  );
  builder.global(
    'isFinite',
    builder.function('isFinite', 1, ({ runtime, args }) => Number.isFinite(runtime.toNumber(args[0])))
  );
  builder.method(numberPrototype, 'toString', 1, ({ runtime, thisValue, args }) => {
    const value = thisNumber(runtime, thisValue);
    const radix = args[0] === undefined ? 10 : runtime.toNumber(args[0]);
    if (!Number.isInteger(radix) || radix < 2 || radix > 36)
      runtime.throwError('RangeError', 'toString() radix must be between 2 and 36');
    return value.toString(radix);
  });
  builder.method(numberPrototype, 'toFixed', 1, ({ runtime, thisValue, args }) => {
    const value = thisNumber(runtime, thisValue);
    const digits = args[0] === undefined ? 0 : Math.trunc(runtime.toNumber(args[0]));
    if (!(digits >= 0 && digits <= 100))
      runtime.throwError('RangeError', 'toFixed() digits argument must be between 0 and 100');
    return value.toFixed(digits);
  });
  builder.method(numberPrototype, 'valueOf', 0, ({ runtime, thisValue }) => thisNumber(runtime, thisValue));
}

function thisNumber(runtime: Runtime, value: Value): number {
  if (typeof value !== 'number') return runtime.throwError('TypeError', 'This method requires a number');
  return value;
}

function thisBoolean(runtime: Runtime, value: Value): boolean {
  if (typeof value !== 'boolean') return runtime.throwError('TypeError', 'This method requires a boolean');
  return value;
}

function defineBoolean(builder: RealmBuilder): void {
  const { booleanPrototype } = builder.realm;
  builder.defineClass('Boolean', 1, booleanPrototype, ({ args }) => toBoolean(args[0]), false);
  builder.method(booleanPrototype, 'toString', 0, ({ runtime, thisValue }) => String(thisBoolean(runtime, thisValue)));
  builder.method(booleanPrototype, 'valueOf', 0, ({ runtime, thisValue }) => thisBoolean(runtime, thisValue));
}

function defineMath(builder: RealmBuilder): void {
  const math = builder.namespace('Math');
  for (const name of ['E', 'LN10', 'LN2', 'LOG10E', 'LOG2E', 'PI', 'SQRT1_2', 'SQRT2'] as const) {
    builder.constant(math, name, Math[name]);
  }
  // Math.random is left out so that a program always draws the same board.
  for (const name of [
    'abs',
    'acos',
    'asin',
    'atan',
    'cbrt',
    'ceil',
    'cos',
    'exp',
    'floor',
    'log',
    'log10',
    'log2',
    'round',
    'sign',
    'sin',
    'sqrt',
    'tan',
    'trunc',
  ] as const) {
    builder.method(math, name, 1, ({ runtime, args }) => Math[name](runtime.toNumber(args[0])));
  }
  for (const name of ['atan2', 'pow'] as const) {
    builder.method(math, name, 2, ({ runtime, args }) =>
      Math[name](runtime.toNumber(args[0]), runtime.toNumber(args[1]))
    );
  }
  for (const name of ['max', 'min', 'hypot'] as const) {
    builder.method(math, name, 2, ({ runtime, args }) => {
      runtime.scan(args.length);
      let result = name === 'max' ? Number.NEGATIVE_INFINITY : name === 'min' ? Number.POSITIVE_INFINITY : 0;
      for (const value of args) result = Math[name](result, runtime.toNumber(value));
      return result;
    });
  }
}

function defineConsole(builder: RealmBuilder): void {
  const console = builder.namespace('console');
  // Node.js writes warnings and errors to standard error.
  for (const [name, stream] of [
    ['log', 'stdout'],
    ['info', 'stdout'],
    ['debug', 'stdout'],
    ['warn', 'stderr'],
    ['error', 'stderr'],
  ] as const) {
    builder.method(console, name, 0, ({ runtime, args }) => {
      runtime.io[stream].write(`${formatLogArguments(runtime, args)}\n`);
      return;
    });
  }
}

// code-gauge-allow functionCognitiveComplexity 22 -- Lists the builtin methods, each a small closure of its own.
// code-gauge-allow functionNcss 39 -- Lists the builtin methods, each a small closure of its own.
function defineTurtle(builder: RealmBuilder): void {
  const prototype = new JsObject(builder.realm.objectPrototype);
  builder.defineClass('Turtle', 0, prototype, ({ runtime, args, newTarget }) => {
    if (!newTarget) return runtime.throwError('TypeError', "Class constructor Turtle cannot be invoked without 'new'");
    const [x = 0, y = 0, color] = args;
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      runtime.throwError('TypeError', `Invalid position: (${inspect(runtime, x)}, ${inspect(runtime, y)})`);
    }
    if (color !== undefined && typeof color !== 'string') {
      runtime.throwError('TypeError', `Invalid color: ${inspect(runtime, color)}`);
    }
    const turtle = runtime.newObject(runtime.prototypeFor(newTarget, prototype));
    const created = runtime.world.create(x as number, y as number, color as string | undefined);
    if ('error' in created) return runtime.throwError('Error', created.error);
    turtle.turtle = created;
    return turtle;
  });
  const define = (names: readonly string[], run: (runtime: Runtime, turtle: JsObject) => Value): void => {
    for (const name of names) {
      builder.method(prototype, name, 0, ({ runtime, thisValue }) => {
        if (!(thisValue instanceof JsObject) || !thisValue.turtle) {
          return runtime.throwError('TypeError', `Turtle.prototype.${name} requires a turtle`);
        }
        return run(runtime, thisValue);
      });
    }
  };
  for (const [names, sign] of [
    [TURTLE_METHOD_NAMES.forward, 1],
    [TURTLE_METHOD_NAMES.backward, -1],
  ] as const) {
    define(names, (runtime, turtle) => {
      const error = runtime.world.move(turtleStateOf(turtle), sign);
      if (error) runtime.throwError('Error', error);
      return;
    });
  }
  for (const [names, quarters] of [
    [TURTLE_METHOD_NAMES.turnRight, 1],
    [TURTLE_METHOD_NAMES.turnLeft, 3],
  ] as const) {
    define(names, (runtime, turtle) => {
      runtime.world.turn(turtleStateOf(turtle), quarters);
      return;
    });
  }
  define(TURTLE_METHOD_NAMES.canMoveForward, (runtime, turtle) => {
    runtime.collectGarbage();
    return runtime.world.canMoveForward(turtleStateOf(turtle));
  });
  define(TURTLE_METHOD_NAMES.isFrontPainted, (runtime, turtle) => runtime.world.isFrontPainted(turtleStateOf(turtle)));
  define(TURTLE_METHOD_NAMES.remove, (runtime, turtle) => {
    runtime.world.remove(turtleStateOf(turtle));
    return;
  });
}

/** The state of a turtle the Turtle methods have checked is one. */
function turtleStateOf(turtle: JsObject): NonNullable<JsObject['turtle']> {
  return turtle.turtle as NonNullable<JsObject['turtle']>;
}
