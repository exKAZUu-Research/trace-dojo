import { TURTLE_METHOD_NAMES, type TurtleState } from '../../interpreter/turtleWorld';
import { scopedMemberName } from '../classes';
import { encodableText, formatDouble, safeToString, stringOf } from '../format';
import { HashStore } from '../hashStore';
import type { Runtime } from '../runtime';
import { coreTypes, type DartType, DYNAMIC, sameType, vmTypeString } from '../types';
import { DartClosure, DartList, DartObject, DartRecord, DartTypeValue, type Value } from '../values';
import { BoundedStringParts } from './boundedStringParts';
import {
  define,
  defineConstructor,
  forEachValue,
  intArg,
  iterableValues,
  listElement,
  listLength,
  stringArg,
} from './nativeSupport';

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
  forEachValue(runtime, values, (value) => {
    const code = Number(BigInt.asIntN(32, runtime.getProperty(value, 'hashCode', undefined) as bigint));
    hash = Math.trunc(Math.imul(hash, 31) + code) % 0x1_00_00_00_00;
  });
  return BigInt(hash & 0x3f_ff_ff_ff);
});
define('_systemHash', (runtime, _receiver, values) => {
  const mask = 0x1f_ff_ff_ffn;
  let hash = 0n;
  for (const value of values) {
    hash = (hash + intArg(runtime, value, 'value')) & mask;
    hash = (hash + ((hash & 0x7_ff_ffn) << 10n)) & mask;
    hash ^= hash >> 6n;
  }
  hash = (hash + ((hash & 0x3_ff_ff_ffn) << 3n)) & mask;
  hash ^= hash >> 11n;
  return (hash + ((hash & 0x3f_ffn) << 15n)) & mask;
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
  const output = new BoundedStringParts(runtime);
  output.append('(');
  let separator = '';
  const append = (value: Value, name?: string): void => {
    output.append(separator);
    if (name !== undefined) {
      output.append(name);
      output.append(': ');
    }
    output.append(stringOf(runtime, value));
    separator = ', ';
  };
  for (const value of record.positional) append(value);
  for (const [name, value] of record.named) append(value, name);
  output.append(')');
  return output.text();
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
  if (a instanceof DartTypeValue && b instanceof DartTypeValue) return sameType(a.type, b.type);
  if (typeof a === 'number' && typeof b === 'number') return Object.is(a, b) || (a === b && a !== 0);
  return a === b;
}

define('Null.hashCode', () => 2011n);
define('Null.toString', () => 'null');
const tearOffHashes = new WeakMap<object, bigint>();
let nextTearOffHash = 1n;

define('Function.hashCode', (runtime, receiver) => {
  if (!(receiver instanceof DartClosure) || receiver.tearOffKey === undefined) return BigInt(identityOf(receiver));
  const key = receiver.tearOffKey;
  let memberHash = tearOffHashes.get(key);
  if (memberHash === undefined) {
    memberHash = nextTearOffHash++;
    tearOffHashes.set(key, memberHash);
  }
  return BigInt.asUintN(30, (memberHash * 31n) ^ identityHashCode(runtime, receiver.receiver));
});
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
  const args: Value[] = [];
  const frame = runtime.currentFrame;
  const mark = frame?.temporaries.length ?? 0;
  frame?.temporaries.push(fn, positional, namedArguments, new DartList(coreTypes.list, DYNAMIC, args, true));
  try {
    if (positional !== undefined) readApplyArguments(runtime, positional, args);
    return runtime.callValue(
      fn,
      { positional: args, named: readApplyNamedArguments(runtime, namedArguments), isDynamic: true },
      [],
      runtime.userCallRow
    );
  } finally {
    if (frame) frame.temporaries.length = mark;
  }
});

function readApplyArguments(runtime: Runtime, list: Value, result: Value[]): void {
  const length = listLength(runtime, list);
  if (length < 0n) runtime.throwError('RangeError', 'value', [length, 'length']);
  runtime.allocate(Number(length));
  for (let index = length - 1n; index >= 0n; index--) {
    runtime.spend();
    result[Number(index)] = listElement(runtime, list, index);
  }
}

function readApplyNamedArguments(runtime: Runtime, args: Value): Map<string, Value> | undefined {
  if (!(args instanceof DartObject)) return undefined;
  const named = new Map<string, Value>();
  const frame = runtime.currentFrame;
  const entries = runtime.getProperty(args, 'entries', undefined);
  frame?.temporaries.push(entries);
  const iterator = runtime.getProperty(entries, 'iterator', undefined);
  frame?.temporaries.push(iterator);
  while (runtime.invoke(iterator, 'moveNext', { positional: [], named: undefined }, [], undefined) === true) {
    const entry = runtime.getProperty(iterator, 'current', undefined);
    const symbol = runtime.getProperty(entry, 'key', undefined) as DartObject;
    const value = runtime.getProperty(entry, 'value', undefined);
    frame?.temporaries.push(value);
    named.set(symbol.fields[0] as string, value);
  }
  return named;
}

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

define('Type.hashCode', (_runtime, receiver) => BigInt(typeHash((receiver as DartTypeValue).type)));
define('Type.==', (_runtime, receiver, [other]) => {
  if (!(other instanceof DartTypeValue)) return false;
  return sameType((receiver as DartTypeValue).type, other.type);
});
define('Type.toString', (_runtime, receiver) => vmTypeString((receiver as DartTypeValue).type));

function typeHash(type: DartType): number {
  if (type.kind === 'interface') {
    let hash = type.cls.name.length;
    for (const argument of type.args) hash = Math.imul(hash, 31) + typeHash(argument);
    return hash;
  }
  return type.kind.length;
}

// Enums

define('Enum.index', (_runtime, receiver) => (receiver as DartObject).native?.index as bigint);
define('Enum._name', (_runtime, receiver) => (receiver as DartObject).native?.name as string);
define(
  'Enum.toString',
  (_runtime, receiver) => `${(receiver as DartObject).cls.name}.${(receiver as DartObject).native?.name as string}`
);

// Errors

define('Error.stackTrace', (runtime, receiver) => runtime.errorStackTrace(receiver));
define('Error._safeToString', (runtime, _receiver, [value]) => safeToStringOf(runtime, value));
define('Error.throwWithStackTrace', (runtime, _receiver, [error, stackTrace]) => {
  throw runtime.newThrow(error, stackTrace);
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

define('NoSuchMethodError._describe', (runtime, _receiver, [receiver, invocation, found]) => {
  const field = (name: string): Value => runtime.getProperty(invocation, name, undefined);
  const symbolName = scopedMemberName('_name', 'dart:core');
  const member = runtime.getProperty(field('memberName'), symbolName, undefined) as string;
  const kind = field('isGetter') === true ? 'getter' : field('isSetter') === true ? 'setter' : 'method';
  const call = describeInvocation(runtime, member, kind, field);
  const output = new BoundedStringParts(runtime);
  if (receiver === undefined) {
    output.append(`NoSuchMethodError: The ${kind} '${member}' was called on null.`);
  } else {
    const typeName = vmTypeString(runtime.runtimeTypeOf(receiver));
    const className = typeof found === 'string' ? typeName : typeName.replace(/<.*$/, '');
    output.append(`NoSuchMethodError: Class '${className}' has no instance ${kind} '${member}'`);
    output.append(typeof found === 'string' ? ' with matching arguments.' : '.');
  }
  output.append('\nReceiver: ');
  output.append(safeToStringOf(runtime, receiver));
  output.append('\nTried calling: ');
  output.append(call);
  if (receiver !== undefined && typeof found === 'string') {
    output.append('\nFound: ');
    output.append(found);
  }
  return output.text();
});

function describeInvocation(
  runtime: Runtime,
  member: string,
  kind: 'method' | 'getter' | 'setter',
  field: (name: string) => Value
): string {
  const call = new BoundedStringParts(runtime);
  call.append(member);
  if (kind === 'method') {
    const types = (field('typeArguments') as DartList).elements;
    if (types.length > 0) {
      call.append('<');
      for (const [index, type] of types.entries()) {
        if (index > 0) call.append(', ');
        call.append(stringOf(runtime, type));
      }
      call.append('>');
    }
    call.append('(');
  }
  if (kind !== 'getter') appendInvocationArguments(runtime, call, field);
  if (kind === 'method') call.append(')');
  return call.text();
}

function appendInvocationArguments(runtime: Runtime, output: BoundedStringParts, field: (name: string) => Value): void {
  let separator = '';
  for (const value of (field('positionalArguments') as DartList).elements) {
    output.append(separator);
    output.append(safeToStringOf(runtime, value));
    separator = ', ';
  }
  const named = field('namedArguments') as DartObject;
  const symbolName = scopedMemberName('_name', 'dart:core');
  const namedText = new BoundedStringParts(runtime);
  const parts: [string, string][] = [];
  for (const key of iterableValues(runtime, runtime.getProperty(named, 'keys', undefined))) {
    const name = runtime.getProperty(key, symbolName, undefined) as string;
    const value = runtime.invoke(named, '[]', { positional: [key], named: undefined }, [], undefined);
    const text = safeToStringOf(runtime, value);
    namedText.append(name);
    namedText.append(text);
    parts.push([name, text]);
  }
  for (const [name, text] of parts.toSorted(([a], [b]) => (a < b ? -1 : 1))) {
    output.append(separator);
    output.append(name);
    output.append(': ');
    output.append(text);
    separator = ', ';
  }
}

// Top-level functions

define('print', (runtime, _receiver, [value]) => {
  runtime.io.stdout.write(encodableText(`${stringOf(runtime, value)}\n`));
  return;
});
define('identical', (_runtime, _receiver, [a, b]) => identical(a, b));
// The VM gives numbers, strings, booleans, and null their own hash codes as identity hash codes.
define('identityHashCode', (runtime, _receiver, [value]) => identityHashCode(runtime, value));

export function identityHashCode(runtime: Runtime, value: Value): bigint {
  if (value instanceof DartTypeValue) return BigInt(typeHash(value.type));
  return value instanceof DartObject
    ? BigInt(identityOf(value))
    : (runtime.getProperty(value, 'hashCode', undefined) as bigint);
}
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
