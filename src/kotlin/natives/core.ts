import { TURTLE_METHOD_NAMES, type TurtleState } from '../../interpreter/turtleWorld';
import { runtimeClassOf } from '../dispatch';
import { defaultToString, formatPrimitive, hashOf, identityHash, stringHash, stringOf } from '../format';
import { arithmeticOperation, compareDoubles, compareNumbers, negate, step, toInt32 } from '../operators';
import { EXCEPTIONS } from '../prelude/runtimeTypes';
import type { Frame } from '../runtime';
import type { PropertySymbol } from '../symbols';
import { Boxed, KObject, type PrimitiveKind, UNIT, type Value } from '../values';
import { defineNative, defineNativeProperty, libraryClass, newItems, throwError } from './registry';

const INT_KINDS: PrimitiveKind[] = ['Byte', 'Short', 'Int'];

/** Converts a number of one kind to another, as `toInt()`, `toLong()`, and their kin do. */
export function convertNumber(value: number | bigint, from: PrimitiveKind, to: PrimitiveKind): number | bigint {
  const asNumber = Number(value);
  switch (to) {
    case 'Long': {
      if (typeof value === 'bigint') return BigInt.asIntN(64, value);
      if (from === 'Double' || from === 'Float') return doubleToLong(asNumber);
      return BigInt(asNumber);
    }
    case 'ULong': {
      if (typeof value === 'bigint') return BigInt.asUintN(64, value);
      if (from === 'Double' || from === 'Float') return doubleToULong(asNumber);
      return BigInt.asUintN(64, BigInt(from === 'UInt' ? asNumber >>> 0 : asNumber));
    }
    case 'Double': {
      return asNumber;
    }
    case 'Float': {
      return Math.fround(asNumber);
    }
    case 'Int': {
      if (typeof value === 'bigint') return Number(BigInt.asIntN(32, value));
      if (from === 'Double' || from === 'Float') return doubleToInt(asNumber);
      return toInt32(asNumber);
    }
    case 'Short': {
      const int = convertNumber(value, from, 'Int') as number;
      return (int << 16) >> 16;
    }
    case 'Byte': {
      const int = convertNumber(value, from, 'Int') as number;
      return (int << 24) >> 24;
    }
    case 'Char': {
      return (convertNumber(value, from, 'Int') as number) & 0xff_ff;
    }
    case 'UInt': {
      if (typeof value === 'bigint') return Number(BigInt.asUintN(32, value));
      if (from === 'Double' || from === 'Float') return doubleToUInt(asNumber);
      return asNumber >>> 0;
    }
    case 'UShort': {
      return (convertNumber(value, from, 'Int') as number) & 0xff_ff;
    }
    case 'UByte': {
      return (convertNumber(value, from, 'Int') as number) & 0xff;
    }
  }
}

function doubleToInt(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value >= 2_147_483_647) return 2_147_483_647;
  if (value <= -2_147_483_648) return -2_147_483_648;
  return Math.trunc(value);
}

function doubleToLong(value: number): bigint {
  if (Number.isNaN(value)) return 0n;
  if (value >= 2 ** 63) return 2n ** 63n - 1n;
  if (value <= -(2 ** 63)) return -(2n ** 63n);
  return BigInt(Math.trunc(value));
}

function doubleToUInt(value: number): number {
  if (Number.isNaN(value) || value <= 0) return 0;
  if (value >= 4_294_967_295) return 4_294_967_295;
  return Math.trunc(value);
}

function doubleToULong(value: number): bigint {
  if (Number.isNaN(value) || value <= 0) return 0n;
  if (value >= 2 ** 64) return 2n ** 64n - 1n;
  return BigInt(Math.trunc(value));
}

const CONVERSIONS: [string, PrimitiveKind][] = [
  ['toDouble', 'Double'],
  ['toFloat', 'Float'],
  ['toLong', 'Long'],
  ['toInt', 'Int'],
  ['toShort', 'Short'],
  ['toByte', 'Byte'],
  ['toChar', 'Char'],
  ['toUInt', 'UInt'],
  ['toULong', 'ULong'],
  ['toUByte', 'UByte'],
  ['toUShort', 'UShort'],
];

const NUMBER_KINDS: PrimitiveKind[] = [
  'Byte',
  'Short',
  'Int',
  'Long',
  'Float',
  'Double',
  'UByte',
  'UShort',
  'UInt',
  'ULong',
];

function boxedEquals(kind: PrimitiveKind): (frame: Frame, receiver: Value, args: Value[]) => Value {
  return (_frame, receiver, [other]) => {
    if (!(other instanceof Boxed) || other.kind !== kind) return false;
    if (kind === 'Double' || kind === 'Float') return Object.is(receiver, other.value);
    return receiver === other.value;
  };
}

/** A range of the library, made directly as its constructor would make it. */
function range(name: string, first: Value, last: Value): Value {
  const cls = libraryClass(`kotlin.ranges.${name}`);
  const object = new KObject(cls);
  object.fields[0] = first;
  object.fields[1] = last;
  object.fields[2] = name === 'LongRange' ? 1n : 1;
  return object;
}

function defineOperatorMembers(): void {
  const operators: [string, '+' | '-' | '*' | '/' | '%'][] = [
    ['plus', '+'],
    ['minus', '-'],
    ['times', '*'],
    ['div', '/'],
    ['rem', '%'],
  ];
  for (const kind of ['Int', 'Long', 'Double', 'Float', 'Short', 'Byte'] as const) {
    const result = kind === 'Short' || kind === 'Byte' ? 'Int' : kind;
    for (const [name, operator] of operators) {
      const operation = arithmeticOperation(result, operator);
      defineNative(`kotlin.${kind}.${name}(${kind})`, (frame, receiver, [other]) =>
        operation(frame, receiver as number | bigint, other as number | bigint)
      );
    }
    defineNative(`kotlin.${kind}.unaryMinus()`, (_frame, receiver) => negate(result, receiver as number | bigint));
    defineNative(`kotlin.${kind}.inc()`, (_frame, receiver) => step(kind, receiver as number | bigint, 1));
    defineNative(`kotlin.${kind}.dec()`, (_frame, receiver) => step(kind, receiver as number | bigint, -1));
  }
}

function definePrimitives(): void {
  for (const kind of [...NUMBER_KINDS, 'Char' as const]) {
    const prefix = `kotlin.${kind}`;
    for (const [name, to] of CONVERSIONS) {
      defineNative(`${prefix}.${name}()`, (_frame, receiver) => convertNumber(receiver as number | bigint, kind, to));
    }
    const isFloating = kind === 'Double' || kind === 'Float';
    defineNative(`${prefix}.compareTo(${kind})`, (_frame, receiver, [other]) =>
      isFloating
        ? compareDoubles(receiver as number, other as number)
        : compareNumbers(receiver as number | bigint, other as number | bigint)
    );
    defineNative(`${prefix}.equals(Any?)`, boxedEquals(kind));
    defineNative(`${prefix}.hashCode()`, (frame, receiver) =>
      hashOf(frame, new Boxed(kind, receiver as number | bigint))
    );
    defineNative(`${prefix}.toString()`, (frame, receiver) => {
      const text = formatPrimitive(kind, receiver as number | bigint);
      frame.runtime.allocateString(frame, text.length);
      return text;
    });
  }
  defineNativeProperty('kotlin.Char.code', (_frame, receiver) => receiver as number);
  for (const kind of ['Int', 'Long', 'UInt'] as const) {
    const isLong = kind === 'Long';
    const prefix = `kotlin.${kind}`;
    const self = kind;
    const wrap = (value: bigint | number): Value =>
      isLong
        ? BigInt.asIntN(64, value as bigint)
        : kind === 'UInt'
          ? (value as number) >>> 0
          : toInt32(value as number);
    defineNative(`${prefix}.and(${self})`, (_frame, a, [b]) =>
      wrap(isLong ? (a as bigint) & (b as bigint) : (a as number) & (b as number))
    );
    defineNative(`${prefix}.or(${self})`, (_frame, a, [b]) =>
      wrap(isLong ? (a as bigint) | (b as bigint) : (a as number) | (b as number))
    );
    defineNative(`${prefix}.xor(${self})`, (_frame, a, [b]) =>
      wrap(isLong ? (a as bigint) ^ (b as bigint) : (a as number) ^ (b as number))
    );
    defineNative(`${prefix}.shl(Int)`, (_frame, a, [b]) =>
      wrap(isLong ? (a as bigint) << BigInt((b as number) & 63) : (a as number) << ((b as number) & 31))
    );
    defineNative(`${prefix}.shr(Int)`, (_frame, a, [b]) =>
      isLong
        ? (a as bigint) >> BigInt((b as number) & 63)
        : kind === 'UInt'
          ? (a as number) >>> ((b as number) & 31)
          : (a as number) >> ((b as number) & 31)
    );
    if (kind !== 'UInt') {
      defineNative(`${prefix}.ushr(Int)`, (_frame, a, [b]) =>
        isLong
          ? BigInt.asIntN(64, BigInt.asUintN(64, a as bigint) >> BigInt((b as number) & 63))
          : toInt32((a as number) >>> ((b as number) & 31))
      );
      defineNative(`${prefix}.inv()`, (_frame, a) => (isLong ? BigInt.asIntN(64, ~(a as bigint)) : ~(a as number)));
    }
  }
  defineNative('kotlin.Int.rangeTo(Int)', (_frame, a, [b]) => range('IntRange', a, b));
  defineNative('kotlin.Int.rangeTo(Long)', (_frame, a, [b]) => range('LongRange', BigInt(a as number), b));
  defineNative('kotlin.Int.rangeUntil(Int)', (_frame, a, [b]) =>
    (b as number) <= -2_147_483_648 ? range('IntRange', 1, 0) : range('IntRange', a, (b as number) - 1)
  );
  defineNative('kotlin.Long.rangeTo(Long)', (_frame, a, [b]) => range('LongRange', a, b));
  defineNative('kotlin.Long.rangeTo(Int)', (_frame, a, [b]) => range('LongRange', a, BigInt(b as number)));
  defineNative('kotlin.Long.rangeUntil(Long)', (_frame, a, [b]) =>
    (b as bigint) <= -(2n ** 63n) ? range('LongRange', 1n, 0n) : range('LongRange', a, (b as bigint) - 1n)
  );
  defineNative('kotlin.Char.rangeTo(Char)', (_frame, a, [b]) => range('CharRange', a, b));
  defineNative('kotlin.Char.rangeUntil(Char)', (_frame, a, [b]) =>
    (b as number) <= 0 ? range('CharRange', 1, 0) : range('CharRange', a, (b as number) - 1)
  );
  defineNative('kotlin.Boolean.and(Boolean)', (_frame, a, [b]) => (a as boolean) && (b as boolean));
  defineNative('kotlin.Boolean.or(Boolean)', (_frame, a, [b]) => (a as boolean) || (b as boolean));
  defineNative('kotlin.Boolean.xor(Boolean)', (_frame, a, [b]) => a !== b);
  defineNative('kotlin.Boolean.compareTo(Boolean)', (_frame, a, [b]) => Number(a) - Number(b));
  defineNative('kotlin.Boolean.equals(Any?)', (_frame, a, [b]) => a === b);
  defineNative('kotlin.Boolean.hashCode()', (_frame, a) => (a ? 1231 : 1237));
  defineNative('kotlin.Boolean.toString()', (_frame, a) => (a ? 'true' : 'false'));
  void INT_KINDS;
}

function defineAnyAndString(): void {
  defineNative('kotlin.Any.equals(Any?)', (_frame, receiver, [other]) => receiver === other);
  defineNative('kotlin.Any.hashCode()', (_frame, receiver) => identityHash(receiver));
  defineNative('kotlin.Any.toString()', (frame, receiver) => {
    const text = defaultToString(receiver);
    frame.runtime.allocateString(frame, text.length);
    return text;
  });
  defineNativeProperty('kotlin.String.length', (_frame, receiver) => (receiver as string).length);
  defineNative('kotlin.String.get(Int)', (frame, receiver, [index]) => {
    const text = receiver as string;
    const position = index as number;
    if (position < 0 || position >= text.length) {
      return throwError(
        frame,
        'java.lang.StringIndexOutOfBoundsException',
        `Index ${position} out of bounds for length ${text.length}`
      );
    }
    // oxlint-disable-next-line unicorn/prefer-code-point -- Kotlin chars are UTF-16 code units.
    return text.charCodeAt(position);
  });
  defineNative('kotlin.String.subSequence(Int, Int)', (frame, receiver, [start, end]) =>
    substring(frame, receiver as string, start as number, end as number)
  );
  defineNative('kotlin.String.compareTo(String)', (_frame, receiver, [other]) =>
    compareStrings(receiver as string, other as string)
  );
  defineNative('kotlin.String.plus(Any?)', (frame, receiver, [other]) => {
    const text = (receiver as string) + stringOf(frame, other);
    frame.runtime.allocateString(frame, text.length);
    return text;
  });
  defineNative('kotlin.String.equals(Any?)', (_frame, receiver, [other]) => receiver === other);
  defineNative('kotlin.String.hashCode()', (_frame, receiver) => stringHash(receiver as string));
  defineNative('kotlin.String.toString()', (_frame, receiver) => receiver);
  defineNativeProperty('kotlin.Array.size', (_frame, receiver) => (receiver as KObject).items?.length ?? 0);
  defineNative('kotlin.Array.get(Int)', (frame, receiver, [index]) =>
    arrayItem(frame, receiver as KObject, index as number)
  );
  defineNative('kotlin.Array.set(Int, T)', (frame, receiver, [index, value]) => {
    const items = (receiver as KObject).items as Value[];
    checkArrayIndex(frame, items, index as number);
    items[index as number] = value;
    return UNIT;
  });
  defineNative('kotlin.Array.iterator()', (frame, receiver) => arrayIterator(frame, receiver as KObject));
}

/** `String.compareTo`, which compares UTF-16 code units, as Java's does. */
export function compareStrings(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    // oxlint-disable-next-line unicorn/prefer-code-point -- Java compares UTF-16 code units.
    const difference = a.charCodeAt(index) - b.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

export function substring(frame: Frame, text: string, start: number, end: number): string {
  if (start < 0 || end > text.length || start > end) {
    return throwError(
      frame,
      'java.lang.StringIndexOutOfBoundsException',
      `begin ${start}, end ${end}, length ${text.length}`
    );
  }
  frame.runtime.allocateString(frame, end - start);
  return text.slice(start, end);
}

export function checkArrayIndex(frame: Frame, items: Value[], index: number): void {
  if (index < 0 || index >= items.length) {
    throwError(
      frame,
      'java.lang.ArrayIndexOutOfBoundsException',
      `Index ${index} out of bounds for length ${items.length}`
    );
  }
}

export function arrayItem(frame: Frame, array: KObject, index: number): Value {
  const items = array.items as Value[];
  checkArrayIndex(frame, items, index);
  return items[index];
}

/** An iterator over a list's or an array's items, which reads them as they are when it moves. */
export function arrayIterator(frame: Frame, source: KObject): KObject {
  const iterator = new KObject(libraryClass('kotlin.collections.ItemIterator'), 0);
  iterator.native = { source, index: 0, expectedModCount: source.modCount };
  void frame;
  return iterator;
}

function defineThrowables(): void {
  const names = [['kotlin', 'Throwable'], ...EXCEPTIONS.map(([packageName, name]) => [packageName, name])];
  for (const [packageName, name] of names) {
    const key = `${packageName}.${name}.<init>`;
    defineNative(`${key}()`, (_frame, instance) => setThrowable(instance, undefined, undefined));
    defineNative(`${key}(String?)`, (_frame, instance, [message]) => setThrowable(instance, message, undefined));
    defineNative(`${key}(String?, Throwable?)`, (_frame, instance, [message, cause]) =>
      setThrowable(instance, message, cause)
    );
    defineNative(`${key}(Throwable?)`, (frame, instance, [cause]) =>
      setThrowable(instance, cause === undefined ? undefined : stringOf(frame, cause), cause)
    );
  }
  defineNativeProperty('kotlin.Throwable.message', (_frame, receiver) => throwableState(receiver).message);
  defineNativeProperty('kotlin.Throwable.cause', (_frame, receiver) => throwableState(receiver).cause);
  defineNative('kotlin.Throwable.toString()', (frame, receiver) => describeThrowable(frame, receiver));
  defineNative('kotlin.Throwable.printStackTrace()', (frame, receiver) => {
    frame.runtime.io.stderr.write(`${describeThrowable(frame, receiver)}\n`);
    return UNIT;
  });
}

function setThrowable(instance: Value, message: Value, cause: Value): Value {
  (instance as KObject).native = { message, cause };
  return UNIT;
}

function throwableState(value: Value): { message: Value; cause: Value } {
  return ((value as KObject).native ?? { message: undefined, cause: undefined }) as { message: Value; cause: Value };
}

/** `Throwable.toString()`: the class's binary name and the message, which may come from an overriding property. */
export function describeThrowable(frame: Frame, value: Value): string {
  const name = runtimeClassOf(value).qualifiedName;
  const messageProperty = libraryClass('kotlin.Throwable').members.get('message')?.[0];
  const message =
    messageProperty?.kind === 'property' ? readProperty(frame, messageProperty, value) : throwableState(value).message;
  return message === undefined ? name : `${name}: ${stringOf(frame, message)}`;
}

function readProperty(frame: Frame, property: PropertySymbol, receiver: Value): Value {
  const target = runtimeClassOf(receiver).dispatch(property);
  return (target.get as NonNullable<typeof target.get>)(frame, receiver);
}

function defineOutput(): void {
  defineNative('kotlin.io.println(Any?)', (frame, _receiver, [message]) => {
    frame.runtime.io.stdout.write(`${stringOf(frame, message)}\n`);
    return UNIT;
  });
  defineNative('kotlin.io.println()', (frame) => {
    frame.runtime.io.stdout.write('\n');
    return UNIT;
  });
  defineNative('kotlin.io.print(Any?)', (frame, _receiver, [message]) => {
    frame.runtime.io.stdout.write(stringOf(frame, message));
    return UNIT;
  });
  defineNativeProperty(
    'kotlin.reflect.PropertyReference.name',
    (_frame, receiver) => (receiver as KObject).native?.name as string
  );
}

const create = (frame: Frame, instance: Value, x: number, y: number, color: string | undefined): Value => {
  const created = frame.runtime.world.create(x, y, color);
  if ('error' in created) return throwError(frame, 'java.lang.RuntimeException', created.error);
  (instance as KObject).turtle = created;
  return UNIT;
};

const state = (receiver: Value): TurtleState => {
  const turtle = (receiver as KObject).turtle;
  if (!turtle) throw new Error('A turtle without its state');
  return turtle;
};

function defineTurtleMethods(names: readonly string[], run: (frame: Frame, turtle: TurtleState) => Value): void {
  for (const name of names) {
    defineNative(`tracedojo.Turtle.${name}()`, (frame, receiver) => {
      frame.runtime.spend();
      return run(frame, state(receiver));
    });
  }
}

const move =
  (sign: number) =>
  (frame: Frame, turtle: TurtleState): Value => {
    const error = frame.runtime.world.move(turtle, sign);
    if (error) throwError(frame, 'java.lang.RuntimeException', error);
    return UNIT;
  };

function defineTurtle(): void {
  defineNative('tracedojo.Turtle.<init>()', (frame, instance) => create(frame, instance, 0, 0, undefined));
  defineNative('tracedojo.Turtle.<init>(Int, Int)', (frame, instance, [x, y]) =>
    create(frame, instance, x as number, y as number, undefined)
  );
  defineNative('tracedojo.Turtle.<init>(Int, Int, String?)', (frame, instance, [x, y, color]) => {
    if (color === undefined) return throwError(frame, 'java.lang.RuntimeException', 'Invalid color: null');
    return create(frame, instance, x as number, y as number, color as string);
  });
  defineTurtleMethods(TURTLE_METHOD_NAMES.forward, move(1));
  defineTurtleMethods(TURTLE_METHOD_NAMES.backward, move(-1));
  defineTurtleMethods(TURTLE_METHOD_NAMES.turnRight, (frame, turtle) => {
    frame.runtime.world.turn(turtle, 1);
    return UNIT;
  });
  defineTurtleMethods(TURTLE_METHOD_NAMES.turnLeft, (frame, turtle) => {
    frame.runtime.world.turn(turtle, 3);
    return UNIT;
  });
  defineTurtleMethods(TURTLE_METHOD_NAMES.canMoveForward, (frame, turtle) => {
    frame.runtime.collectGarbage();
    return frame.runtime.world.canMoveForward(turtle);
  });
  defineTurtleMethods(TURTLE_METHOD_NAMES.isFrontPainted, (frame, turtle) =>
    frame.runtime.world.isFrontPainted(turtle)
  );
  defineTurtleMethods(TURTLE_METHOD_NAMES.remove, (frame, turtle) => {
    frame.runtime.world.remove(turtle);
    return UNIT;
  });
}

definePrimitives();
defineOperatorMembers();
defineAnyAndString();
defineThrowables();
defineOutput();
defineTurtle();

export { newItems };
