import { TURTLE_METHOD_NAMES, type TurtleState } from '../../interpreter/turtleWorld';
import { scopedMemberName } from '../classes';
import { encodableText, formatDouble, stringOf } from '../format';
import { HashStore } from '../hashStore';
import type { Runtime } from '../runtime';
import { coreTypes, vmTypeString } from '../types';
import { DartClosure, DartList, DartObject, DartPackedList, DartRecord, DartTypeValue, type Value } from '../values';
import { appendJsonQuoted, BoundedStringParts } from './boundedStringParts';
import { appendRegExpDescription, isRegExp } from './nativeRegExp';
import {
  define,
  defineConstructor,
  forEachValue,
  intArg,
  iterableValues,
  stringArg,
  throwUnavailable,
} from './nativeSupport';
import { sameVmType, vmTypeHash } from './vmTypeHash';

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
  let hash = 0n;
  for (const value of values) hash = combineSystemHash(hash, intArg(runtime, value, 'value'));
  return finishSystemHash(hash);
});

const SYSTEM_HASH_MASK = 0x1f_ff_ff_ffn;

function combineSystemHash(hash: bigint, value: bigint): bigint {
  hash = (hash + value) & SYSTEM_HASH_MASK;
  hash = (hash + ((hash & 0x7_ff_ffn) << 10n)) & SYSTEM_HASH_MASK;
  return hash ^ (hash >> 6n);
}

function finishSystemHash(hash: bigint): bigint {
  hash = (hash + ((hash & 0x3_ff_ff_ffn) << 3n)) & SYSTEM_HASH_MASK;
  hash ^= hash >> 11n;
  return (hash + ((hash & 0x3f_ffn) << 15n)) & SYSTEM_HASH_MASK;
}

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
  if (a instanceof DartTypeValue && b instanceof DartTypeValue) return sameVmType(a.type, b.type);
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
define('Function._apply', (runtime, _receiver, [argumentsList, namesList]) => {
  const args = (argumentsList as DartList).elements;
  const names = (namesList as DartList).elements;
  const end = args.length - names.length;
  const named = names.length === 0 ? undefined : new Map<string, Value>();
  runtime.allocate(args.length - 1);
  for (const [index, name] of names.entries()) {
    runtime.spend();
    named?.set(stringArg(runtime, name, 'name'), args[end + index]);
  }
  return runtime.callValue(
    args[0],
    { positional: args.slice(1, end), named, invocation: 'apply' },
    [],
    runtime.userCallRow
  );
});

function readSymbolName(runtime: Runtime, symbol: Value): string {
  if (!(symbol instanceof DartObject) || symbol.cls !== runtime.links.classNamed('_Symbol')) {
    runtime.throwTypeError(
      `type '${vmTypeString(runtime.runtimeTypeOf(symbol))}' is not a subtype of type 'Symbol' in type cast`
    );
  }
  return runtime.getProperty(symbol, scopedMemberName('_name', 'dart:core'), undefined) as string;
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
  let hash = record.shape;
  for (const value of record.positional)
    hash = combineSystemHash(hash, runtime.getProperty(value, 'hashCode', undefined) as bigint);
  for (const [, value] of record.named)
    hash = combineSystemHash(hash, runtime.getProperty(value, 'hashCode', undefined) as bigint);
  return finishSystemHash(hash);
});
define('Record.toString', (runtime, receiver) => recordToString(runtime, receiver as DartRecord));

// Types

define('Type.hashCode', (runtime, receiver) => BigInt(vmTypeHash(runtime, (receiver as DartTypeValue).type)));
define('Type.==', (_runtime, receiver, [other]) => {
  if (!(other instanceof DartTypeValue)) return false;
  return sameVmType((receiver as DartTypeValue).type, other.type);
});
define('Type.toString', (_runtime, receiver) => vmTypeString((receiver as DartTypeValue).type));

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
define('_unavailable', (runtime, _receiver, [what]) => throwUnavailable(runtime, what as string));
define('StackTrace.current', (runtime) => throwUnavailable(runtime, 'StackTrace.current'));
define('_StackTrace.toString', (runtime) => throwUnavailable(runtime, 'スタックトレースの中身'));

function safeToStringOf(runtime: Runtime, root: Value): string {
  const output = new BoundedStringParts(runtime);
  const records: { record: DartRecord; field: number }[] = [];
  let value = root;
  for (;;) {
    if (value instanceof DartRecord) {
      output.append('Record (');
      records.push({ record: value, field: 0 });
    } else {
      appendSafeValue(runtime, output, value, records.length > 0);
    }
    for (;;) {
      const cursor = records.at(-1);
      if (!cursor) return output.text();
      const field = cursor.field++;
      if (field >= cursor.record.positional.length + cursor.record.named.length) {
        output.append(')');
        records.pop();
        continue;
      }
      value = recordFieldValue(output, cursor.record, field);
      break;
    }
  }
}

function recordFieldValue(output: BoundedStringParts, { positional, named }: DartRecord, field: number): Value {
  if (field > 0) output.append(', ');
  if (field < positional.length) return positional[field];
  const [name, value] = named[field - positional.length];
  output.append(name);
  output.append(': ');
  return value;
}

function appendSafeValue(runtime: Runtime, output: BoundedStringParts, value: Value, recordField: boolean): void {
  if (typeof value === 'string') {
    if (recordField) output.appendVmCString(value);
    else appendJsonQuoted(value, (part) => output.append(part));
    return;
  }
  if (value instanceof DartTypeValue && recordField) output.append('Type: ');
  if (isRegExp(runtime, value)) appendRegExpDescription(output, value);
  else output.append(safeValueText(runtime, value));
}

const COMPACT_COLLECTIONS = new Set(['_Map', '_Set', '_ConstMap', '_ConstSet']);

function safeValueText(runtime: Runtime, value: Value): string {
  if (!(value instanceof DartObject)) return stringOf(runtime, value);
  if (value instanceof DartList) {
    if (value.growable) return `Instance(length:${value.length}) of '_GrowableList'`;
    const name = value.unmodifiable ? '_ImmutableList' : '_List';
    return `${name} len:${value.length}`;
  }
  if (value instanceof DartPackedList && typeof value.contents !== 'string') return '_Uint8List';
  if (value.native instanceof HashStore && COMPACT_COLLECTIONS.has(value.cls.name))
    return `${value.cls.name} len:${value.native.size}`;
  if (value instanceof DartTypeValue) return vmTypeString(value.type);
  return objectToString(runtime, value);
}

define('NoSuchMethodError._describe', (runtime, _receiver, [receiver, invocation, found, isExternal]) => {
  const field = (name: string): Value => runtime.getProperty(invocation, name, undefined);
  const member = readSymbolName(runtime, field('memberName'));
  const kind = field('isGetter') === true ? 'getter' : field('isSetter') === true ? 'setter' : 'method';
  const call = describeInvocation(runtime, member, kind, field, isExternal === true);
  const output = new BoundedStringParts(runtime);
  if (isExternal === true) {
    output.append(
      receiver === undefined
        ? `NoSuchMethodError: No top-level ${kind} '${member}' declared.`
        : `NoSuchMethodError: No static ${kind} '${member}' declared in class '${receiver as string}'.`
    );
  } else if (receiver === undefined) {
    output.append(`NoSuchMethodError: The ${kind} '${member}' was called on null.`);
  } else if (receiver instanceof DartClosure) {
    output.append(`NoSuchMethodError: Closure call with mismatched arguments: function '${member}'`);
  } else {
    const className = stringOf(runtime, runtime.getProperty(receiver, 'runtimeType', undefined));
    output.append(`NoSuchMethodError: Class '${className}' has no instance ${kind} '${member}'`);
    output.append(typeof found === 'string' ? ' with matching arguments.' : '.');
  }
  output.append('\nReceiver: ');
  output.append(
    isExternal === true ? ((receiver as string | undefined) ?? 'top-level') : safeToStringOf(runtime, receiver)
  );
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
  field: (name: string) => Value,
  isExternal: boolean
): string {
  if (isExternal && kind === 'setter') return member;
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
  const namedText = new BoundedStringParts(runtime);
  const parts: [string, string][] = [];
  for (const key of iterableValues(runtime, runtime.getProperty(named, 'keys', undefined))) {
    const name = readSymbolName(runtime, key);
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
  const text = `${stringOf(runtime, value)}\n`;
  // The VM's print still converts its argument once stdout is closed; the closed channel drops the text.
  runtime.io.stdout.write(text, encodableText);
  return;
});
define('identical', (_runtime, _receiver, [a, b]) => identical(a, b));
// The VM gives numbers, strings, booleans, and null their own hash codes as identity hash codes.
define('identityHashCode', (runtime, _receiver, [value]) => identityHashCode(runtime, value));

export function identityHashCode(runtime: Runtime, value: Value): bigint {
  if (value instanceof DartTypeValue) return BigInt(vmTypeHash(runtime, value.type));
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

/** Each Expando's entries; the weak table drops an entry once its key object is no longer reachable, as the VM's does. */
const expandoEntries = new WeakMap<DartObject, WeakMap<object, Value>>();

define('Expando._get', (_runtime, receiver, [object]) =>
  expandoEntries.get(receiver as DartObject)?.get(object as object)
);
define('Expando._set', (_runtime, receiver, [object, value]) => {
  let entries = expandoEntries.get(receiver as DartObject);
  if (!entries) {
    entries = new WeakMap();
    expandoEntries.set(receiver as DartObject, entries);
  }
  if (value === undefined) entries.delete(object as object);
  else entries.set(object as object, value);
  return;
});
