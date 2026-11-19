import { CompileError } from '../../interpreter/diagnostics';
import type { Evaluator } from '../evaluator';
import type { NativeCall } from '../natives';
import { PendingException } from '../numeric';
import { stringOf } from '../objects';
import { CsThrow, type ExceptionState } from '../runtime';
import { type NamedType, namedType, substitute, type Type, type TypeParameterSymbol } from '../types';
import { CsArray, CsBox, CsObject, type Value, type VariableReference } from '../values';

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

/** A primitive's value, which arrives boxed when the call came through `object`. */
export function primitive<T extends Value>(value: Value): T {
  return (value instanceof CsBox ? value.value : value) as T;
}

export function refOf(arg: Value | VariableReference): VariableReference {
  return arg as VariableReference;
}

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
  call.frame.runtime.allocateSlots(values.length);
  return new CsArray({ kind: 'array', element, rank: 1 }, [values.length], values);
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
