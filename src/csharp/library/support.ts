import { CompileError } from '../../interpreter/diagnostics';
import { checkElementStore } from '../arrayStore';
import type { Evaluator } from '../evaluator';
import type { NativeCall } from '../natives';
import { convertNumeric, type NumericValue, PendingException } from '../numeric';
import { stringOf } from '../objects';
import { CsThrow, type ExceptionState } from '../runtime';
import {
  isReferenceType,
  type NamedType,
  namedType,
  nullableUnderlying,
  sameType,
  specialOf,
  type SpecialType,
  substitute,
  type Type,
  type TypeParameterSymbol,
} from '../types';
import {
  copyValue,
  CsArray,
  CsBox,
  CsDelegate,
  CsObject,
  isString,
  plainString,
  type Value,
  type VariableReference,
} from '../values';

/** The evaluator that runs the call. */
export function evaluatorOf(call: NativeCall): Evaluator {
  return call.frame.runtime.evaluator;
}

/** The text of a value of a parameter's declared type, as the library prints it. */
export function textOf(call: NativeCall, value: Value, type: Type): string {
  return stringOf(evaluatorOf(call), value, type, call.frame);
}

/** The type of a parameter of the called method, with the call's type arguments substituted. */
export function parameterType(call: NativeCall, index: number): Type {
  const type = call.method.parameters[index]?.type;
  if (!type) throw new Error(`${call.method.name} has no parameter ${index}`);
  return call.frame.resolve(substituteCall(call, type));
}

function substituteCall(call: NativeCall, type: Type): Type {
  const environment = new Map<TypeParameterSymbol, Type>();
  if (call.owner) {
    for (const [index, parameter] of call.owner.symbol.allTypeParameters.entries())
      environment.set(parameter, call.owner.args[index]);
  }
  for (const [index, parameter] of call.method.typeParameters.entries())
    environment.set(parameter, call.typeArgs[index]);
  return substitute(type, environment);
}

/** The type argument of a generic receiver or method, such as a list's element type. */
export function typeArgument(call: NativeCall, index = 0): Type {
  const args = call.owner?.args ?? [];
  return call.frame.resolve(args[index] ?? call.typeArgs[index]);
}

/** A primitive's value, which arrives boxed when the call came through `object`, with a string as its text. */
export function primitive<T extends Value>(value: Value): T {
  return (value instanceof CsBox ? value.value : plainString(value)) as T;
}

export function refOf(arg: Value | VariableReference): VariableReference {
  return arg as VariableReference;
}

/**
 * A charge for a native's steps, one operation for each 16, for a native that repeats work on its own, such as the
 * comparisons of a sort, which no operation of the program pays for.
 */
export function stepMeter(call: NativeCall): () => void {
  let steps = 0;
  return () => {
    if (++steps % STEPS_PER_OPERATION === 0) call.frame.runtime.spend();
  };
}

const STEPS_PER_OPERATION = 16;

/** Throws a library exception that the evaluator turns into a C# exception where the program can see it. */
export function fail(typeName: string, message?: string, paramName?: string): never {
  throw new PendingException(typeName, message, paramName);
}

/** Rejects a call whose arguments use what this environment cannot run, as the compiler rejects unsupported syntax. */
export function unsupportedCall(call: NativeCall, what: string): never {
  throw new CompileError([{ row: call.row ?? 0, message: `${what}は、この採点環境では使えません。` }]);
}

export function failNull(paramName: string): never {
  throw new PendingException('System.ArgumentNullException', 'Value cannot be null.', paramName);
}

/** Throws `ArgumentOutOfRangeException` with the actual value that .NET's messages show on a second line. */
export function failOutOfRange(call: NativeCall, paramName: string, message: string, actualValue?: string): never {
  const runtime = call.frame.runtime;
  const exception = runtime.createException('System.ArgumentOutOfRangeException', message, undefined, paramName);
  if (actualValue !== undefined) (exception.native as ExceptionState).actualValue = actualValue;
  throw new CsThrow(exception);
}

/** .NET's `ArgumentOutOfRangeException.ThrowIfNegative`. */
export function failNegative(call: NativeCall, paramName: string, value: number | bigint): never {
  return failOutOfRange(call, paramName, `${paramName} ('${value}') must be a non-negative value.`, String(value));
}

/** .NET's `ArgumentOutOfRangeException.ThrowIfGreaterThan`. */
export function failGreater(call: NativeCall, paramName: string, value: number, limit: number): never {
  return failOutOfRange(
    call,
    paramName,
    `${paramName} ('${value}') must be less than or equal to '${limit}'.`,
    String(value)
  );
}

export function failIndex(call: NativeCall, paramName = 'index'): never {
  return failOutOfRange(
    call,
    paramName,
    'Index was out of range. Must be non-negative and less than the size of the collection.'
  );
}

export function nullReference(): never {
  throw new PendingException('System.NullReferenceException', 'Object reference not set to an instance of an object.');
}

/** The library type of a full name with type arguments. */
export function libraryType(call: NativeCall, fullName: string, args: Type[] = []): NamedType {
  return namedType(call.frame.runtime.library.typeNamed(fullName, args.length), args);
}

/** Creates an array of a type with elements. */
export function newArray(call: NativeCall, element: Type, values: Value[]): CsArray {
  return newArrayOf(call, element, values.length, (index) => values[index]);
}

/** `ICollection<T>.CopyTo` of a collection's elements into an array from an index, checked as .NET's collections do. */
export function copyToArray(call: NativeCall, items: Value[], array: Value, index: number): void {
  if (array === undefined) failNull('array');
  if (index < 0) failNegative(call, 'arrayIndex', index);
  const target = (array as CsArray).values;
  if (index > target.length || target.length - index < items.length)
    fail(
      'System.ArgumentException',
      'Destination array is not long enough to copy all the items in the collection. Check array index and length.'
    );
  chargeElements(call, items.length);
  storeInArray(call, array as CsArray, index, items);
}

/**
 * Writes values into an array's elements from an index, converted as `Array.Copy` converts them: a value of the
 * source's element type is boxed into a reference element type and unboxed into a value one. A value that does not
 * fit the array's runtime element type, which a covariant array (a `string[]` seen as `object[]`) can have, fails
 * before any element is written, so the array never holds a value of the wrong type.
 */
export function storeInArray(
  call: NativeCall,
  target: CsArray,
  index: number,
  items: Value[],
  sourceElement?: Type
): void {
  const element = target.type.element;
  const evaluator = evaluatorOf(call);
  let values = items;
  if (!sourceElement || !sameType(sourceElement, element)) {
    values = items.map((item) => {
      if (!isReferenceType(element)) return valueElement(evaluator, item, sourceElement, element);
      const boxed = sourceElement ? evaluator.box(item, sourceElement) : item;
      if (boxed !== undefined && !evaluator.isInstanceOf(boxed, element))
        fail(
          'System.InvalidCastException',
          'At least one element in the source array could not be cast down to the destination array type.'
        );
      return boxed;
    });
  }
  for (const value of values) checkElementStore(evaluator, target, value);
  for (const [offset, value] of values.entries()) {
    call.frame.runtime.chargeStore(target.values[index + offset], value);
    target.values[index + offset] = copyValue(value);
  }
}

/**
 * Stores a value into an array's element as a program's store does: checked as a covariant array (a `string[]` seen
 * as `object[]`) checks it, so the array never holds a value of the wrong type, charged for what it adds, and copied.
 */
export function storeArrayElement(call: NativeCall, array: CsArray, index: number, value: Value): void {
  checkElementStore(evaluatorOf(call), array, value);
  call.frame.runtime.chargeStore(array.values[index], value);
  array.values[index] = copyValue(value);
}

/**
 * The primitive element types that the runtime's array copy converts each one to, besides itself: its primitive
 * widenings (wider than C#'s implicit conversions, as from byte to char) and the types of the same size and the other
 * signedness, whose bits it keeps.
 */
const ARRAY_COPY_CONVERSIONS: Partial<Record<SpecialType, SpecialType[]>> = {
  sbyte: ['byte', 'short', 'int', 'long', 'float', 'double'],
  byte: ['sbyte', 'char', 'short', 'ushort', 'int', 'uint', 'long', 'ulong', 'float', 'double'],
  short: ['ushort', 'char', 'int', 'long', 'float', 'double'],
  ushort: ['short', 'char', 'int', 'uint', 'long', 'ulong', 'float', 'double'],
  char: ['short', 'ushort', 'int', 'uint', 'long', 'ulong', 'float', 'double'],
  int: ['uint', 'long', 'float', 'double'],
  uint: ['int', 'long', 'ulong', 'float', 'double'],
  long: ['ulong', 'float', 'double'],
  ulong: ['long', 'float', 'double'],
  float: ['double'],
};

/**
 * A value copied into a value-type element: unboxed from a box, or converted between primitive types as the runtime's
 * array copy converts them; other source element types cannot be assigned to the array.
 */
function valueElement(evaluator: Evaluator, item: Value, sourceElement: Type | undefined, element: Type): Value {
  if (item instanceof CsBox) return evaluator.unbox(item, element);
  if (item === undefined && sourceElement && isReferenceType(sourceElement)) {
    // A null unboxes to a nullable element's null; .NET's array copy cannot cast it to another value type.
    if (nullableUnderlying(element)) return undefined;
    fail(
      'System.InvalidCastException',
      'At least one element in the source array could not be cast down to the destination array type.'
    );
  }
  if (!sourceElement) return item;
  const from = specialOf(sourceElement);
  const to = specialOf(element);
  if (from && to && ARRAY_COPY_CONVERSIONS[from]?.includes(to)) return convertNumeric(item as NumericValue, from, to);
  return fail('System.ArrayTypeMismatchException', 'Source array type cannot be assigned to destination array type.');
}

/**
 * A sequence read into a host buffer, charged against the slot limit as it fills, as every allocation is, so that
 * buffers alive at once add up; a result built from the buffer itself is not charged again.
 */
export function bufferedElements(call: NativeCall, items: Iterable<Value>): Value[] {
  const buffer: Value[] = [];
  // Each batch is charged as it fills, so a sequence without end meets the slot limit while it is read.
  let batchStart = 0;
  for (const item of items) {
    buffer.push(item);
    if (buffer.length - batchStart === 64) {
      call.frame.runtime.retainSlots(64, buffer.slice(batchStart));
      batchStart = buffer.length;
    }
  }
  call.frame.runtime.retainSlots(buffer.length - batchStart, buffer.slice(batchStart));
  return buffer;
}

/** An array built from a buffer that bufferedElements already charged. */
export function arrayOfBuffer(element: Type, buffer: Value[]): CsArray {
  return new CsArray(
    { kind: 'array', element, rank: 1 },
    [buffer.length],
    buffer.map((value) => copyValue(value))
  );
}

/** Charges the work of a library loop over `count` elements, as iterating a sequence is charged. */
export function chargeElements(call: NativeCall, count: number): void {
  call.frame.runtime.spend(Math.ceil(count / 16));
}

/** A new array of a length, checked against the slot limit before any element is made, as `new T[n]` is. */
export function newArrayOf(
  call: NativeCall,
  element: Type,
  length: number,
  valueAt: (index: number) => Value
): CsArray {
  call.frame.runtime.allocateSlots(length);
  const values: Value[] = [];
  for (let index = 0; index < length; index++) {
    const value = valueAt(index);
    // A struct element's fields are charged before the next element is made, so defaults that the source makes, as
    // Array.Resize's, cannot run far past the limit.
    call.frame.runtime.retainSlots(0, [value]);
    values.push(copyValue(value));
  }
  return new CsArray({ kind: 'array', element, rank: 1 }, [length], values);
}

/** Charges the fields of the struct values among elements a native keeps reachable, beyond their one slot each. */
export function chargeStructFields(call: NativeCall, values: Iterable<Value>): void {
  call.frame.runtime.retainSlots(0, values);
}

/** The elements of a `params` array argument, which may be null. */
export function arrayValues(value: Value): Value[] {
  if (value === undefined) return [];
  return (value as CsArray).values;
}

/** The state that a library object keeps natively. */
export function stateOf<T>(value: Value): T {
  if (value === undefined) nullReference();
  const native = (value as CsObject).native;
  if (native === undefined) throw new Error('A library object without its state');
  return native as T;
}

export function isObject(value: Value): value is CsObject {
  return value instanceof CsObject;
}

/** The integral types whose `CompareTo` returns the difference of the values rather than its sign. */
export const NARROW_INTEGRALS: ReadonlySet<string> = new Set(['sbyte', 'byte', 'short', 'ushort', 'char']);

/**
 * The text a trace shows a dictionary's key as, which the Java trace shows a map's alike: a value its text, and an
 * object of a class, an array, or a delegate by its identity, without running its ToString.
 */
export function dictionaryKeyText(call: NativeCall, key: Value, keyType: Type): string {
  if ((key instanceof CsObject && !isString(key)) || key instanceof CsArray || key instanceof CsDelegate)
    return call.frame.runtime.displayIdentity(key);
  return textOf(call, key, keyType);
}
