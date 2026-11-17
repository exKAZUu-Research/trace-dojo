import { TURTLE_METHOD_NAMES } from '../interpreter/turtleWorld';
import { listFromArrayLike } from './arrayOps';
import { formatLogArguments } from './consoleFormat';
import { formatTable } from './consoleTable';
import { inspect, inspectValue } from './inspect';
import type { ErrorName, RealmBuilder } from './realm';
import { toInteger } from './realmArrays';
import { dateValueOf, hostLocales, hostOptions } from './realmDate';
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
  throwingHostErrors,
  toBoolean,
  unboxed,
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
  // toLocaleString calls the value's own toString, as the specification's Invoke does.
  builder.method(objectPrototype, 'toLocaleString', 0, ({ runtime, thisValue }) =>
    runtime.call(runtime.get(thisValue, 'toString'), thisValue, [])
  );
}

function tagOf(value: Value): string {
  if (value === undefined) return 'Undefined';
  if (value === null) return 'Null';
  if (value instanceof JsObject) return objectTagOf(value);
  // A BigInt or symbol has no builtin tag of its own, only its prototype's Symbol.toStringTag.
  return PRIMITIVE_TAGS[typeof value] ?? 'Object';
}

const PRIMITIVE_TAGS: Partial<Record<string, string>> = { string: 'String', number: 'Number', boolean: 'Boolean' };

function objectTagOf(object: JsObject): string {
  if (object instanceof JsArray) return 'Array';
  if (object instanceof JsFunction) return 'Function';
  if (object.isArguments) return 'Arguments';
  if (object.primitive !== undefined) return tagOf(object.primitive);
  if (object.regexp) return 'RegExp';
  if (dateValueOf(object) !== undefined) return 'Date';
  return object.isError ? 'Error' : 'Object';
}

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
      runtime.forEachOwnEnumerable(object, (key) => runtime.set(target, key, runtime.get(object, key)));
    }
    return target;
  });
  builder.method(objectConstructor, 'getPrototypeOf', 1, ({ runtime, args }) => runtime.toObject(args[0]).proto);
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
    return runtime.call(thisValue, args[0], listFromArrayLike(runtime, args[1]), callRow);
  });
  builder.method(functionPrototype, 'bind', 1, ({ runtime, thisValue, args }) => {
    const target = thisValue;
    if (!isCallable(target)) return runtime.throwError('TypeError', 'Bind must be called on a function');
    const boundThis = args[0];
    const boundArgs = args.slice(1);
    runtime.allocate(boundArgs.length + 1);
    // The bound function takes what the target takes beyond the bound arguments.
    const targetLength = runtime.get(target, 'length');
    const length =
      typeof targetLength === 'number' ? Math.max(0, toInteger(runtime, targetLength) - boundArgs.length) : 0;
    const bound = runtime.newNativeFunction(
      `bound ${runtime.functionName(target)}`,
      length,
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
  builder.constant(
    functionPrototype,
    WELL_KNOWN_SYMBOLS.hasInstance,
    builder.function('[Symbol.hasInstance]', 1, ({ runtime, thisValue, args }) =>
      runtime.ordinaryHasInstance(thisValue, args[0])
    )
  );
  builder.method(functionPrototype, 'toString', 0, ({ runtime, thisValue }) => {
    if (!(thisValue instanceof JsFunction))
      return runtime.throwError('TypeError', 'Function.prototype.toString requires a function');
    return runtime.functionSource(thisValue);
  });
}

const errorNames: ErrorName[] = [
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'AggregateError',
  'SuppressedError',
];

/** The `length` of the error constructors that take more than a message. */
const errorArgumentCounts: Partial<Record<ErrorName, number>> = { AggregateError: 2, SuppressedError: 3 };

/** Error's own static members, which have nothing to do here past their checks, as programs see no stack. */
function defineErrorStatics(builder: RealmBuilder, errorConstructor: JsFunction): void {
  builder.method(errorConstructor, 'captureStackTrace', 2, ({ runtime, args }) => {
    if (!isObject(args[0])) runtime.throwError('TypeError', 'Invalid argument');
    return;
  });
  builder.method(errorConstructor, 'isError', 1, ({ args }) => args[0] instanceof JsObject && args[0].isError);
  errorConstructor.properties.set('stackTraceLimit', {
    value: 10,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

// code-gauge-allow functionCognitiveComplexity 21 -- Defines each error class with its own constructor behavior.
function defineErrors(builder: RealmBuilder): void {
  const { errorPrototypes } = builder.realm;
  let errorConstructor: JsFunction | undefined;
  for (const name of errorNames) {
    const prototype = errorPrototypes[name];
    const fn = builder.defineClass(name, errorArgumentCounts[name] ?? 1, prototype, (call) =>
      name === 'AggregateError'
        ? createAggregateError(call, prototype)
        : name === 'SuppressedError'
          ? createSuppressedError(call, prototype)
          : createError(call, prototype)
    );
    if (errorConstructor) fn.proto = errorConstructor;
    else errorConstructor = fn;
    defineHidden(prototype, 'name', name);
    defineHidden(prototype, 'message', '');
  }
  defineErrorStatics(builder, errorConstructor as JsFunction);
  builder.method(errorPrototypes.Error, 'toString', 0, ({ runtime, thisValue }) => {
    if (!isObject(thisValue)) {
      return runtime.throwError(
        'TypeError',
        `Method Error.prototype.toString called on incompatible receiver ${runtime.describePlain(thisValue)}`
      );
    }
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

/** Creates a SuppressedError, whose first two arguments are the error and the error it suppressed. */
function createSuppressedError(call: NativeCall, prototype: JsObject): JsObject {
  const [error, suppressed] = call.args;
  const object = createError({ ...call, args: call.args.slice(2) }, prototype);
  defineHidden(object, 'error', error);
  defineHidden(object, 'suppressed', suppressed);
  return object;
}

/** Creates an AggregateError, whose first argument is the iterable of errors it gathers. */
function createAggregateError(call: NativeCall, prototype: JsObject): JsObject {
  const { runtime, args } = call;
  const error = createError({ ...call, args: args.slice(1) }, prototype);
  defineHidden(error, 'errors', runtime.newArray(runtime.iterate(args[0])));
  return error;
}

// code-gauge-allow functionNcss 33 -- Lists the builtin methods, each a small closure of its own.
function defineNumber(builder: RealmBuilder): void {
  const { numberPrototype } = builder.realm;
  const numberConstructor = builder.defineClass('Number', 1, numberPrototype, constructNumber);
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
    const value = thisNumber(runtime, thisValue, 'toString');
    const radix = args[0] === undefined ? 10 : toInteger(runtime, args[0]);
    if (radix < 2 || radix > 36) runtime.throwError('RangeError', 'toString() radix argument must be between 2 and 36');
    return value.toString(radix);
  });
  builder.method(numberPrototype, 'toFixed', 1, ({ runtime, thisValue, args }) => {
    const value = thisNumber(runtime, thisValue, 'toFixed');
    const digits = toInteger(runtime, args[0]);
    if (!(digits >= 0 && digits <= 100))
      runtime.throwError('RangeError', 'toFixed() digits argument must be between 0 and 100');
    return value.toFixed(digits);
  });
  defineNumberFormats(builder);
  builder.method(numberPrototype, 'valueOf', 0, ({ runtime, thisValue }) => thisNumber(runtime, thisValue, 'valueOf'));
}

// code-gauge-allow functionCognitiveComplexity 18 -- Transcribes the specification's algorithm step by step, whose branches mirror its steps.
function defineNumberFormats(builder: RealmBuilder): void {
  const { numberPrototype } = builder.realm;
  builder.method(numberPrototype, 'toPrecision', 1, ({ runtime, thisValue, args }) => {
    const value = thisNumber(runtime, thisValue, 'toPrecision');
    if (args[0] === undefined) return String(value);
    const precision = Math.trunc(runtime.toNumber(args[0])) || 0;
    if (!Number.isFinite(value)) return String(value);
    if (!(precision >= 1 && precision <= 100))
      runtime.throwError('RangeError', 'toPrecision() argument must be between 1 and 100');
    return value.toPrecision(precision);
  });
  // Node.js formats for its default locale, en-US, when no locale is given.
  builder.method(numberPrototype, 'toLocaleString', 0, ({ runtime, thisValue, args }) => {
    const value = thisNumber(runtime, thisValue, 'toLocaleString');
    const locales = (args[0] === undefined ? 'en-US' : hostLocales(runtime, args[0])) as Intl.LocalesArgument;
    return throwingHostErrors(runtime, () =>
      value.toLocaleString(locales, hostOptions(runtime, args[1]) as Intl.NumberFormatOptions)
    );
  });
  builder.method(numberPrototype, 'toExponential', 1, ({ runtime, thisValue, args }) => {
    const value = thisNumber(runtime, thisValue, 'toExponential');
    const digits = Math.trunc(runtime.toNumber(args[0])) || 0;
    if (!Number.isFinite(value)) return String(value);
    if (!(digits >= 0 && digits <= 100))
      runtime.throwError('RangeError', 'toExponential() argument must be between 0 and 100');
    return args[0] === undefined ? value.toExponential() : value.toExponential(digits);
  });
}

function constructNumber({ runtime, args, newTarget }: NativeCall): Value {
  // Number converts a BigInt, which the implicit conversion of arithmetic rejects.
  const numeric = args.length === 0 ? 0 : runtime.toNumeric(args[0]);
  return runtime.primitiveOrBox(typeof numeric === 'bigint' ? Number(numeric) : numeric, newTarget);
}

function thisNumber(runtime: Runtime, value: Value, method: string): number {
  const primitive = unboxed(value);
  if (typeof primitive !== 'number') {
    return runtime.throwError('TypeError', `Number.prototype.${method} requires that 'this' be a Number`);
  }
  return primitive;
}

function thisBoolean(runtime: Runtime, value: Value, method: string): boolean {
  const primitive = unboxed(value);
  if (typeof primitive !== 'boolean') {
    return runtime.throwError('TypeError', `Boolean.prototype.${method} requires that 'this' be a Boolean`);
  }
  return primitive;
}

function defineBoolean(builder: RealmBuilder): void {
  const { booleanPrototype } = builder.realm;
  builder.defineClass('Boolean', 1, booleanPrototype, ({ runtime, args, newTarget }) =>
    runtime.primitiveOrBox(toBoolean(args[0]), newTarget)
  );
  builder.method(booleanPrototype, 'toString', 0, ({ runtime, thisValue }) =>
    String(thisBoolean(runtime, thisValue, 'toString'))
  );
  builder.method(booleanPrototype, 'valueOf', 0, ({ runtime, thisValue }) =>
    thisBoolean(runtime, thisValue, 'valueOf')
  );
}

function defineMath(builder: RealmBuilder): void {
  const math = builder.namespace('Math');
  for (const name of ['E', 'LN10', 'LN2', 'LOG10E', 'LOG2E', 'PI', 'SQRT1_2', 'SQRT2'] as const) {
    builder.constant(math, name, Math[name]);
  }
  builder.constant(math, WELL_KNOWN_SYMBOLS.toStringTag, 'Math');
  // Math.random is left out so that a program always draws the same board.
  for (const name of [
    'abs',
    'acos',
    'acosh',
    'asin',
    'asinh',
    'atan',
    'atanh',
    'cbrt',
    'ceil',
    'clz32',
    'cos',
    'cosh',
    'exp',
    'expm1',
    'floor',
    'f16round',
    'fround',
    'log',
    'log10',
    'log1p',
    'log2',
    'round',
    'sign',
    'sin',
    'sinh',
    'sqrt',
    'tan',
    'tanh',
    'trunc',
  ] as const) {
    builder.method(math, name, 1, ({ runtime, args }) => Math[name](runtime.toNumber(args[0])));
  }
  for (const name of ['atan2', 'imul', 'pow'] as const) {
    builder.method(math, name, 2, ({ runtime, args }) =>
      Math[name](runtime.toNumber(args[0]), runtime.toNumber(args[1]))
    );
  }
  for (const name of ['max', 'min', 'hypot'] as const) {
    builder.method(math, name, 2, ({ runtime, args }) => {
      runtime.scan(args.length);
      // Every argument converts in order before the host computes, which rounds `hypot` as V8 does.
      const values: number[] = [];
      for (const value of args) values.push(runtime.toNumber(value));
      return Math[name](...values);
    });
  }
}

// code-gauge-allow functionNcss 52 -- Lists the console methods, each a small closure sharing the group indentation and counts.
function defineConsole(builder: RealmBuilder): void {
  const console = builder.namespace('console');
  // Grouping indents everything printed after it, on every line, as Node.js does.
  let groupIndentation = '';
  const write = (runtime: Runtime, stream: 'stdout' | 'stderr', text: string): void => {
    const indented = groupIndentation ? groupIndentation + text.replaceAll('\n', `\n${groupIndentation}`) : text;
    runtime.io[stream].write(`${indented}\n`);
  };
  // Node.js writes warnings and errors to standard error.
  for (const [name, stream] of [
    ['log', 'stdout'],
    ['info', 'stdout'],
    ['debug', 'stdout'],
    ['warn', 'stderr'],
    ['error', 'stderr'],
  ] as const) {
    builder.method(console, name, 0, ({ runtime, args }) => {
      write(runtime, stream, formatLogArguments(runtime, args));
      return;
    });
  }
  defineConsoleDir(builder, console, write);
  for (const name of ['group', 'groupCollapsed']) {
    builder.method(console, name, 0, ({ runtime, args }) => {
      if (args.length > 0) write(runtime, 'stdout', formatLogArguments(runtime, args));
      groupIndentation += '  ';
      return;
    });
  }
  builder.method(console, 'groupEnd', 0, () => {
    groupIndentation = groupIndentation.slice(2);
    return;
  });
  const counts = new Map<string, number>();
  builder.method(console, 'count', 0, ({ runtime, args }) => {
    const label = labelOf(runtime, args[0]);
    const count = (counts.get(label) ?? 0) + 1;
    counts.set(label, count);
    write(runtime, 'stdout', `${label}: ${count}`);
    return;
  });
  builder.method(console, 'countReset', 0, ({ runtime, args }) => {
    const label = labelOf(runtime, args[0]);
    if (counts.has(label)) counts.set(label, 0);
    else write(runtime, 'stderr', `Count for '${label}' does not exist`);
    return;
  });
  defineConsoleOutputs(builder, console, write);
  builder.method(console, 'assert', 0, ({ runtime, args }) => {
    const [condition, ...data] = args;
    if (toBoolean(condition)) return;
    const message =
      typeof data[0] === 'string' ? [`Assertion failed: ${data[0]}`, ...data.slice(1)] : ['Assertion failed', ...data];
    write(runtime, 'stderr', formatLogArguments(runtime, message));
    return;
  });
  // Node.js's console methods are enumerable properties.
  for (const property of console.properties.values()) property.enumerable = true;
}

/** The console methods that print as `console.log` does in a form of their own: tables, traces, and clearing. */
/** `console.dir`, which prints its value with the `util.inspect` options it is given. */
// code-gauge-allow functionCognitiveComplexity 18 -- Reads each util.inspect option console.dir takes.
function defineConsoleDir(
  builder: RealmBuilder,
  console: JsObject,
  write: (runtime: Runtime, stream: 'stdout' | 'stderr', text: string) => void
): void {
  builder.method(console, 'dir', 0, ({ runtime, args }) => {
    const [value, options] = args;
    // null means no limit for depth and maxArrayLength, as util.inspect takes them.
    const limit = (name: string): number | undefined => {
      const option = isObject(options) ? runtime.get(options, name) : undefined;
      if (option === undefined) return undefined;
      return option === null ? Number.POSITIVE_INFINITY : runtime.toNumber(option);
    };
    const option = (name: string): Value => (isObject(options) ? runtime.get(options, name) : undefined);
    const compact = option('compact');
    const getters = option('getters');
    write(
      runtime,
      'stdout',
      inspectValue(runtime, value, undefined, limit('depth'), {
        breakLength: limit('breakLength'),
        compact: typeof compact === 'boolean' || typeof compact === 'number' ? compact : undefined,
        maxArrayLength: limit('maxArrayLength'),
        maxStringLength: limit('maxStringLength'),
        showHidden: toBoolean(option('showHidden')),
        sorted: toBoolean(option('sorted')),
        getters: getters === 'get' || getters === 'set' ? getters : toBoolean(getters),
        numericSeparator: toBoolean(option('numericSeparator')),
      })
    );
    return;
  });
}

function defineConsoleOutputs(
  builder: RealmBuilder,
  console: JsObject,
  write: (runtime: Runtime, stream: 'stdout' | 'stderr', text: string) => void
): void {
  builder.method(console, 'table', 0, ({ runtime, args }) => {
    write(runtime, 'stdout', formatTable(runtime, args[0], args[1]) ?? formatLogArguments(runtime, args.slice(0, 1)));
    return;
  });
  builder.method(console, 'dirxml', 0, ({ runtime, args }) => {
    write(runtime, 'stdout', formatLogArguments(runtime, args));
    return;
  });
  // Clearing does nothing when the output is not a terminal, as here.
  builder.method(console, 'clear', 0, () => {});
  builder.method(console, 'trace', 0, ({ runtime, args }) => {
    write(runtime, 'stderr', `Trace${args.length > 0 ? `: ${formatLogArguments(runtime, args)}` : ''}`);
    return;
  });
}

/** The label `console.count` counts under, `default` when none is given. */
function labelOf(runtime: Runtime, label: Value): string {
  return label === undefined ? 'default' : runtime.toString(label);
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
