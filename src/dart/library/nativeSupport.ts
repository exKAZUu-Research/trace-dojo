import type { ConstructorImpl } from '../classes';
import type { Runtime } from '../runtime';
import { coreTypes, type DartType, DYNAMIC, functionType, vmTypeString } from '../types';
import {
  type Arguments,
  type Callable,
  DartClosure,
  DartList,
  type DartObject,
  DartPackedList,
  NO_ARGUMENTS,
  type Value,
} from '../values';

/** The natives of the interpreter's libraries, by `Class.member`, `Class.member=`, `Class.new`, or a function's name. */
export const NATIVES = new Map<string, Callable | ConstructorImpl>();

export type NativeMethod = (
  runtime: Runtime,
  self: Value,
  args: Value[],
  named: ReadonlyMap<string, Value> | undefined,
  typeArgs: readonly DartType[]
) => Value;

/** Registers a method, getter, setter, static member, or top-level function. */
/**
 * Rejects at run time what the interpreter cannot give the SDK's result for; every such check, in the libraries'
 * Dart (through `_unavailable`) and in the natives, throws this one diagnostic.
 */
export function throwUnavailable(runtime: Runtime, what: string): never {
  return runtime.throwError('UnsupportedError', '', [`${what}は、この採点環境では使えません。`]);
}

export function define(key: string, run: NativeMethod): void {
  const native: Callable = (runtime, receiver, args, typeArgs, callRow) =>
    runtime.withCallRoots(receiver, args, () => run(runtime, receiver, args.positional, args.named, typeArgs), callRow);
  NATIVES.set(key, native);
}

/** Registers the same native under several keys. */
export function defineAll(keys: string[], run: NativeMethod): void {
  for (const key of keys) define(key, run);
}

export function defineConstructor(key: string, run: ConstructorImpl): void {
  const native: ConstructorImpl = (runtime, receiver, args, typeArgs, callRow) =>
    runtime.withCallRoots(receiver, args, () => run(runtime, receiver, args, typeArgs, callRow), callRow);
  NATIVES.set(key, native);
}

/** A named argument, or its default. */
export function named(args: ReadonlyMap<string, Value> | undefined, name: string, fallback: Value): Value {
  return args?.has(name) ? args.get(name) : fallback;
}

export function intArg(runtime: Runtime, value: Value, name: string): bigint {
  if (typeof value !== 'bigint') {
    runtime.throwTypeError(
      `type '${vmTypeString(runtime.runtimeTypeOf(value))}' is not a subtype of type 'int' of '${name}'`
    );
  }
  return value;
}

export function numArg(runtime: Runtime, value: Value, name: string): bigint | number {
  if (typeof value !== 'bigint' && typeof value !== 'number') {
    runtime.throwTypeError(
      `type '${vmTypeString(runtime.runtimeTypeOf(value))}' is not a subtype of type 'num' of '${name}'`
    );
  }
  return value;
}

export function stringArg(runtime: Runtime, value: Value, name: string): string {
  if (typeof value !== 'string') {
    runtime.throwTypeError(
      `type '${vmTypeString(runtime.runtimeTypeOf(value))}' is not a subtype of type 'String' of '${name}'`
    );
  }
  return value;
}

/** Converts an int that indexes a JavaScript array or string, which is safe within the limits of a run. */
export const index: (value: bigint) => number = Number;

export function newList(runtime: Runtime, elementType: DartType, elements: Value[], growable = true): DartList {
  runtime.allocate(elements.length + 1);
  return new DartList(coreTypes.list, elementType, elements, growable);
}

export function elementTypeOf(object: DartObject, position = 0): DartType {
  return object.typeArgs[position] ?? DYNAMIC;
}

export function registerPackedList(className: string): void {
  define(`${className}.length`, (_runtime, receiver) => BigInt((receiver as DartPackedList).length));
  define(`${className}.[]`, (runtime, receiver, [position]) => {
    const list = receiver as DartPackedList;
    return list.at(checkListIndex(runtime, list, position, 'length'));
  });
}

export function listLength(runtime: Runtime, list: Value): bigint {
  return list instanceof DartList || list instanceof DartPackedList
    ? BigInt(list.length)
    : intArg(runtime, runtime.getProperty(list, 'length', undefined), 'length');
}

export function listElement(runtime: Runtime, list: Value, position: bigint): Value {
  if (list instanceof DartList) return list.elements[checkListIndex(runtime, list, position, 'length')];
  if (list instanceof DartPackedList) return list.at(checkListIndex(runtime, list, position, 'length'));
  return runtime.invoke(list, '[]', { positional: [position], named: undefined }, [], undefined);
}

export function checkListIndex(runtime: Runtime, list: DartList | DartPackedList, value: Value, name: string): number {
  const position = intArg(runtime, value, 'index');
  if (position < 0n || position >= BigInt(list.length)) {
    runtime.throwError('RangeError', 'range', [position, 0n, BigInt(list.length - 1), name]);
  }
  return index(position);
}

/** Calls a Dart function value with positional arguments. */
export function callFunction(runtime: Runtime, fn: Value, ...args: Value[]): Value {
  const evaluated: Arguments = { positional: args, named: undefined };
  return runtime.callValue(fn, evaluated, [], runtime.userCallRow);
}

/** The values of an iterable, through its iterator unless it is a list. */
export function iterableValues(runtime: Runtime, iterable: Value): Value[] {
  if (iterable instanceof DartList) return [...iterable.elements];
  const values: Value[] = [];
  const frame = runtime.frames.at(-1);
  frame?.temporaries.push(new DartList(coreTypes.list, DYNAMIC, values, true));
  try {
    for (const value of iteratorValues(runtime, iterable, 0n, undefined)) values.push(value);
    return values;
  } finally {
    frame?.temporaries.pop();
  }
}

/** Runs `body` on each element as a `for-in` loop reaches it, so that the iterable's code and `body` interleave. */
export function forEachValue(runtime: Runtime, iterable: Value, body: (value: Value) => void): void {
  if (iterable instanceof DartList) {
    const { length } = iterable.elements;
    for (let position = 0; position < length; position++) {
      runtime.spend();
      body(iterable.elements[position]);
      if (iterable.elements.length !== length) runtime.throwError('ConcurrentModificationError', '', [iterable]);
    }
    return;
  }
  forEachIteratorValue(runtime, iterable, 0n, undefined, body);
}

export function forEachIteratorValue(
  runtime: Runtime,
  iterable: Value,
  from: bigint,
  to: bigint | undefined,
  body: (value: Value) => void
): void {
  for (const value of iteratorValues(runtime, iterable, from, to)) body(value);
}

export function* iteratorValues(
  runtime: Runtime,
  iterable: Value,
  from: bigint,
  to: bigint | undefined,
  beforeCurrent?: () => void
): IterableIterator<Value> {
  const frame = runtime.frames.at(-1);
  const mark = frame?.temporaries.length ?? 0;
  frame?.temporaries.push(iterable);
  try {
    const iterator = runtime.getProperty(iterable, 'iterator', undefined);
    frame?.temporaries.push(iterator);
    for (let position = 0n; to === undefined || position < to; position++) {
      if (runtime.invoke(iterator, 'moveNext', NO_ARGUMENTS, [], undefined) !== true) return;
      runtime.spend();
      if (position < from) continue;
      beforeCurrent?.();
      const value = runtime.getProperty(iterator, 'current', undefined);
      frame?.temporaries.push(value);
      yield value;
      frame?.temporaries.pop();
    }
  } finally {
    if (frame) frame.temporaries.length = mark;
  }
}

/** Checks a value against an element type, as a list's or map's methods do for covariant parameters. */
export function checkElement(runtime: Runtime, value: Value, type: DartType, name: string): void {
  if (type.kind === 'dynamic') return;
  if (!runtime.links.isValueOf(runtime, value, type)) {
    runtime.throwTypeError(
      `type '${vmTypeString(runtime.runtimeTypeOf(value))}' is not a subtype of type '${vmTypeString(type)}' of '${name}'`
    );
  }
}

/** Casts a value to a type as `value as T` does, which the SDK's own code does where it reads a nullable slot. */
export function castTo(runtime: Runtime, value: Value, type: DartType): void {
  if (type.kind === 'dynamic' || runtime.links.isValueOf(runtime, value, type)) return;
  runtime.throwTypeError(
    `type '${vmTypeString(runtime.runtimeTypeOf(value))}' is not a subtype of type '${vmTypeString(type)}' in type cast`
  );
}

/** An implicit downcast of a dynamic value, whose error, unlike `as`, names no cast. */
export function implicitCast(runtime: Runtime, value: Value, type: DartType): void {
  if (type.kind === 'dynamic' || runtime.links.isValueOf(runtime, value, type)) return;
  runtime.throwTypeError(
    `type '${vmTypeString(runtime.runtimeTypeOf(value))}' is not a subtype of type '${vmTypeString(type)}'`
  );
}

/** A function value whose body is the interpreter's, for natives that pass a callback to the program's code. */
export function nativeFunction(arity: number, body: (args: readonly Value[]) => Value): DartClosure {
  return new DartClosure(
    coreTypes.function,
    functionType(
      Array.from({ length: arity }, () => DYNAMIC),
      DYNAMIC
    ),
    (runtime, receiver, args) => runtime.withCallRoots(receiver, args, () => body(args.positional)),
    undefined,
    [],
    { name: undefined, origin: undefined },
    undefined
  );
}

/** The standard sinks a run has closed, by whether each is standard error; a closed sink fails a write. */
export const closedSinks = new WeakMap<Runtime, Set<boolean>>();
