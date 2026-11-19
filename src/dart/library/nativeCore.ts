import { TURTLE_METHOD_NAMES, type TurtleState } from '../../interpreter/turtleWorld';
import { formatDouble, safeToString, stringOf } from '../format';
import { HashStore } from '../hashStore';
import type { Runtime } from '../runtime';
import {
  coreTypes,
  type DartType,
  type FunctionType,
  isTop,
  substitute,
  TypeParam,
  typeParamType,
  typeToString,
} from '../types';
import { DartClosure, DartList, DartObject, DartRecord, DartTypeValue, type Value } from '../values';
import { define, defineConstructor, intArg, iterableValues, stringArg } from './nativeSupport';

/** A type as the VM's `Type.toString` and closures' `toString` write it: function types as `(int) => int`. */
export function vmTypeString(type: DartType): string {
  switch (type.kind) {
    case 'interface': {
      const args = type.args.length > 0 ? `<${type.args.map(vmTypeString).join(', ')}>` : '';
      return `${type.cls.name}${args}${type.nullable ? '?' : ''}`;
    }
    case 'function': {
      return type.typeParams.length > 0 ? vmGenericFunctionString(type) : vmFunctionString(type);
    }
    case 'record': {
      const parts = type.positional.map(vmTypeString);
      if (type.named.length > 0)
        parts.push(`{${type.named.map((field) => `${vmTypeString(field.type)} ${field.name}`).join(', ')}}`);
      const inner = parts.length === 1 && type.named.length === 0 ? `${parts[0]},` : parts.join(', ');
      return `(${inner})${type.nullable ? '?' : ''}`;
    }
    default: {
      return typeToString(type);
    }
  }
}

/** The VM names a generic function's type parameters Y0, Y1, and so on. */
function vmGenericFunctionString(type: FunctionType): string {
  const renamed = type.typeParams.map((_, position) => new TypeParam(`Y${position}`));
  const map = new Map(type.typeParams.map((param, position) => [param, typeParamType(renamed[position]) as DartType]));
  for (const [position, param] of type.typeParams.entries())
    renamed[position].bound = param.bound ? substitute(param.bound, map) : undefined;
  const body = substitute({ ...type, typeParams: [] }, map) as FunctionType;
  const typeParams = `<${renamed.map((param) => (param.bound && !isTop(param.bound) ? `${param.name} extends ${vmTypeString(param.bound)}` : param.name)).join(', ')}>`;
  return typeParams + vmFunctionString(body);
}

function vmFunctionString(type: FunctionType): string {
  const parts = type.positional.slice(0, type.requiredCount).map(vmTypeString);
  const optional = type.positional.slice(type.requiredCount).map(vmTypeString);
  if (optional.length > 0) parts.push(`[${optional.join(', ')}]`);
  const order = type.namedOrder;
  const named = order ? type.named.toSorted((a, b) => order.indexOf(a.name) - order.indexOf(b.name)) : type.named;
  if (named.length > 0)
    parts.push(
      `{${named.map((field) => `${field.isRequired ? 'required ' : ''}${vmTypeString(field.type)} ${field.name}`).join(', ')}}`
    );
  const text = `(${parts.join(', ')}) => ${vmTypeString(type.returnType)}`;
  return type.nullable ? `(${text})?` : text;
}

// Object

define('Object.==', (_runtime, receiver, [other]) => identical(receiver, other));
define('Object.hashCode', (_runtime, receiver) => BigInt(identityOf(receiver)));
define('Object.toString', (runtime, receiver) => objectToString(runtime, receiver));
define('Object.runtimeType', (runtime, receiver) => new DartTypeValue(coreTypes.type, runtime.runtimeTypeOf(receiver)));
define('Object.noSuchMethod', (runtime, receiver, [invocation]) =>
  runtime.throwError('NoSuchMethodError', '_withInvocation', [receiver, invocation])
);
define('Object._hashValues', (runtime, _receiver, [values]) => {
  let hash = 0;
  for (const value of (values as DartList).elements) {
    const code = Number(BigInt.asIntN(32, runtime.getProperty(value, 'hashCode', undefined) as bigint));
    hash = Math.trunc(Math.imul(hash, 31) + code) % 0x1_00_00_00_00;
  }
  return BigInt(hash & 0x3f_ff_ff_ff);
});

export function objectToString(runtime: Runtime, receiver: Value): string {
  if (receiver instanceof DartClosure) return closureToString(receiver);
  if (receiver instanceof DartRecord) return recordToString(runtime, receiver);
  return `Instance of '${vmTypeString(runtime.runtimeTypeOf(receiver))}'`;
}

function closureToString(closure: DartClosure): string {
  const origin = closure.description.origin ? ` from ${closure.description.origin}` : '';
  return `Closure: ${vmTypeString(closure.type)}${origin}`;
}

function recordToString(runtime: Runtime, record: DartRecord): string {
  if (runtime.toStringVisiting.includes(record)) return '(...)';
  const parts = record.positional.map((value) => stringOf(runtime, value));
  for (const [name, value] of record.named) parts.push(`${name}: ${stringOf(runtime, value)}`);
  return `(${parts.join(', ')})`;
}

let nextIdentity = 1;
const identities = new WeakMap<object, number>();

function identityOf(value: Value): number {
  if (value instanceof DartObject) {
    let identity = identities.get(value);
    if (identity === undefined) {
      // The VM gives objects hash codes that vary between runs; any fixed sequence matches as well as another.
      identity = (nextIdentity++ * 2_654_435_761) % 1_073_741_823;
      identities.set(value, identity);
    }
    return identity;
  }
  return 0;
}

export function identical(a: Value, b: Value): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Object.is(a, b) || (a === b && a !== 0);
  return a === b;
}

define('Null.hashCode', () => 2011n);
define('Null.toString', () => 'null');
define('Function.hashCode', (_runtime, receiver) => BigInt(identityOf(receiver)));
define('Function.==', (_runtime, receiver, [other]) => {
  if (receiver === other) return true;
  if (!(receiver instanceof DartClosure) || !(other instanceof DartClosure)) return false;
  return (
    receiver.tearOffKey !== undefined &&
    receiver.tearOffKey === other.tearOffKey &&
    identical(receiver.receiver, other.receiver)
  );
});
define('Function.apply', (runtime, _receiver, [fn, positional, namedArguments]) => {
  const args = positional instanceof DartList ? [...positional.elements] : [];
  let named: Map<string, Value> | undefined;
  if (namedArguments instanceof DartObject) {
    named = new Map();
    const entries = runtime.getProperty(namedArguments, 'entries', undefined);
    const iterator = runtime.getProperty(entries, 'iterator', undefined);
    while (runtime.invoke(iterator, 'moveNext', { positional: [], named: undefined }, [], undefined) === true) {
      const entry = runtime.getProperty(iterator, 'current', undefined);
      const symbol = runtime.getProperty(entry, 'key', undefined) as DartObject;
      named.set(symbol.fields[0] as string, runtime.getProperty(entry, 'value', undefined));
    }
  }
  return runtime.callValue(fn, { positional: args, named, isDynamic: true }, [], runtime.userCallRow);
});

// Records

define('Record.runtimeType', (runtime, receiver) => new DartTypeValue(coreTypes.type, runtime.runtimeTypeOf(receiver)));
define('Record.==', (runtime, receiver, [other]) => {
  if (!(receiver instanceof DartRecord) || !(other instanceof DartRecord)) return false;
  if (receiver.positional.length !== other.positional.length || receiver.named.length !== other.named.length)
    return false;
  if (!receiver.named.every(([name], position) => other.named[position][0] === name)) return false;
  return (
    receiver.positional.every((value, position) => runtime.equals(value, other.positional[position])) &&
    receiver.named.every(([, value], position) => runtime.equals(value, other.named[position][1]))
  );
});
define('Record.hashCode', (runtime, receiver) => {
  const record = receiver as DartRecord;
  let hash = record.positional.length * 7 + record.named.length;
  for (const value of [...record.positional, ...record.named.map(([, field]) => field)]) {
    const code = Number(BigInt.asIntN(32, runtime.getProperty(value, 'hashCode', undefined) as bigint));
    hash = Math.trunc(Math.imul(hash, 31) + code) % 0x1_00_00_00_00;
  }
  return BigInt(hash & 0x3f_ff_ff_ff);
});
define('Record.toString', (runtime, receiver) => recordToString(runtime, receiver as DartRecord));

// Types

define('Type.hashCode', (_runtime, receiver) => BigInt(vmTypeString((receiver as DartTypeValue).type).length));
define('Type.==', (_runtime, receiver, [other]) => {
  if (!(other instanceof DartTypeValue)) return false;
  return typeKey((receiver as DartTypeValue).type) === typeKey(other.type);
});
define('Type.toString', (_runtime, receiver) => vmTypeString((receiver as DartTypeValue).type));

function typeKey(type: DartType): string {
  return vmTypeString(type);
}

// Enums

define('Enum.index', (_runtime, receiver) => (receiver as DartObject).native?.index as bigint);
define('Enum._name', (_runtime, receiver) => (receiver as DartObject).native?.name as string);
define(
  'Enum.toString',
  (_runtime, receiver) => `${(receiver as DartObject).cls.name}.${(receiver as DartObject).native?.name as string}`
);

// Errors

define('Error.stackTrace', () => {});
define('Error._safeToString', (runtime, _receiver, [value]) => safeToStringOf(runtime, value));
define('Error.throwWithStackTrace', (runtime, _receiver, [error]) => {
  throw runtime.links.newThrow(runtime, error);
});
// The VM's stack traces show file paths and the VM's own frames, which the interpreter cannot reproduce.
define('StackTrace.current', (runtime) =>
  runtime.throwError('UnsupportedError', '', ['StackTrace.current は、この採点環境では使えません。'])
);
define('_StackTrace.toString', (runtime) =>
  runtime.throwError('UnsupportedError', '', ['スタックトレースの中身は、この採点環境では使えません。'])
);

/** `Error.safeToString`, which describes a list by its length and the VM's class, as messages of errors show. */
export function safeToStringOf(runtime: Runtime, value: Value): string {
  if (value instanceof DartList) {
    const cls = value.unmodifiable ? '_ImmutableList' : value.growable ? '_GrowableList' : '_List';
    return `Instance(length:${value.elements.length}) of '${cls}'`;
  }
  // The VM describes its maps and sets by class and length.
  if (value instanceof DartObject && value.native instanceof HashStore) {
    return `${value.native.isMap ? '_Map' : '_Set'} len:${value.native.size}`;
  }
  return safeToString(runtime, value);
}

// code-gauge-allow functionCognitiveComplexity 17 -- A transcription of the SDK's algorithm, case by case.
define('NoSuchMethodError._describe', (runtime, _receiver, [receiver, invocation]) => {
  const field = (name: string): Value => runtime.getProperty(invocation, name, undefined);
  const member = runtime.getProperty(field('memberName'), '_name', undefined) as string;
  const kind = field('isGetter') === true ? 'getter' : field('isSetter') === true ? 'setter' : 'method';
  const parts = (field('positionalArguments') as DartList).elements.map((value) => safeToStringOf(runtime, value));
  const named = field('namedArguments') as DartObject;
  for (const key of iterableValues(runtime, runtime.getProperty(named, 'keys', undefined))) {
    const keyName = runtime.getProperty(key, '_name', undefined) as string;
    const value = runtime.invoke(named, '[]', { positional: [key], named: undefined }, [], undefined);
    parts.push(`${keyName}: ${safeToStringOf(runtime, value)}`);
  }
  const typeArgs = (field('typeArguments') as DartList).elements.map((type) => stringOf(runtime, type));
  const typeText = typeArgs.length > 0 ? `<${typeArgs.join(', ')}>` : '';
  const positional = parts.join(', ');
  const call =
    kind === 'getter' ? member : kind === 'setter' ? `${member}${positional}` : `${member}${typeText}(${positional})`;
  if (receiver === undefined) {
    const what = kind === 'getter' ? 'getter' : kind === 'setter' ? 'setter' : 'method';
    return `NoSuchMethodError: The ${what} '${member}' was called on null.\nReceiver: null\nTried calling: ${call}`;
  }
  const className = vmTypeString(runtime.runtimeTypeOf(receiver)).replace(/<.*$/, '');
  const what = kind === 'getter' ? 'getter' : kind === 'setter' ? 'setter' : 'method';
  return `NoSuchMethodError: Class '${className}' has no instance ${what} '${member}'.\nReceiver: ${safeToStringOf(runtime, receiver)}\nTried calling: ${call}`;
});

// Top-level functions

define('print', (runtime, _receiver, [value]) => {
  runtime.io.stdout.write(`${stringOf(runtime, value)}\n`);
  return;
});
define('identical', (_runtime, _receiver, [a, b]) => identical(a, b));
// The VM gives numbers, strings, booleans, and null their own hash codes as identity hash codes.
define('identityHashCode', (runtime, _receiver, [value]) =>
  value === undefined || typeof value !== 'object'
    ? runtime.getProperty(value, 'hashCode', undefined)
    : BigInt(identityOf(value))
);
define('_isToStringVisiting', (runtime, _receiver, [value]) => runtime.toStringVisiting.includes(value));
define('_toStringVisitingAdd', (runtime, _receiver, [value]) => {
  runtime.toStringVisiting.push(value);
  return;
});
define('_toStringVisitingRemove', (runtime) => {
  runtime.toStringVisiting.pop();
  return;
});

// Turtle

/** Dart names have only ASCII letters, so a turtle method without an English name takes the key it is listed under. */
function asciiNames(key: keyof typeof TURTLE_METHOD_NAMES): string[] {
  const names = TURTLE_METHOD_NAMES[key].filter((name) => /^[A-Za-z]\w*$/.test(name));
  return names.length > 0 ? names : [key];
}

function turtleOf(receiver: Value): TurtleState {
  const state = (receiver as DartObject).turtle;
  if (!state) throw new Error('A turtle without its state');
  return state;
}

defineConstructor('Turtle.new', (runtime, instance, args) => {
  const [x = 0n, y = 0n, color = '#'] = args.positional;
  const created = runtime.world.create(
    Number(intArg(runtime, x, 'x')),
    Number(intArg(runtime, y, 'y')),
    stringArg(runtime, color, 'color')
  );
  if ('error' in created) return runtime.throwError('Exception', '', [created.error]);
  (instance as DartObject).turtle = created;
  return;
});
function defineTurtle(
  key: keyof typeof TURTLE_METHOD_NAMES,
  run: (runtime: Runtime, state: TurtleState) => Value
): void {
  for (const name of asciiNames(key)) {
    define(`Turtle.${name}`, (runtime, receiver) => {
      runtime.spend();
      return run(runtime, turtleOf(receiver));
    });
  }
}
for (const [key, sign] of [
  ['forward', 1],
  ['backward', -1],
] as const) {
  defineTurtle(key, (runtime, state) => {
    const error = runtime.world.move(state, sign);
    if (error) runtime.throwError('Exception', '', [error]);
    return;
  });
}
for (const [key, quarters] of [
  ['turnRight', 1],
  ['turnLeft', 3],
] as const) {
  defineTurtle(key, (runtime, state) => {
    runtime.world.turn(state, quarters);
    return;
  });
}
defineTurtle('canMoveForward', (runtime, state) => {
  runtime.collectGarbage();
  return runtime.world.canMoveForward(state);
});
defineTurtle('isFrontPainted', (runtime, state) => runtime.world.isFrontPainted(state));
defineTurtle('remove', (runtime, state) => {
  runtime.world.remove(state);
  return;
});

export { asciiNames, formatDouble, identityOf };
