import type { Frame } from './runtime';
import type { FunctionSymbol } from './symbols';
import { type KType, resolved } from './types';
import { NULL, type Value } from './values';

export function nonNullParameterIndexes(symbol: FunctionSymbol): number[] {
  return symbol.params.flatMap(({ type }, index) => (isNonNullClassType(type) ? [index] : []));
}

/** Whether a native's receiver is a non-null JVM parameter: an instance member's, or a non-null extension's. */
export function hasNonNullReceiver(symbol: FunctionSymbol): boolean {
  if (symbol.extensionReceiver) return isNonNullClassType(symbol.extensionReceiver);
  return symbol.owner !== undefined && !symbol.owner.isObject && !symbol.isConstructor;
}

/**
 * Erased generic code, such as a Comparable's compareTo, and a superclass initializer reading an overridden property
 * before the subclass sets it can pass null where the library declares a non-null parameter, which the JVM's library
 * methods reject.
 */
export function rejectNullArguments(caller: Frame, nonNullParams: number[], args: Value[]): void {
  for (const index of nonNullParams) {
    if (args[index] === NULL) caller.runtime.throwError(caller, 'java.lang.NullPointerException');
  }
}

function isNonNullClassType(type: KType): boolean {
  const actual = resolved(type);
  return actual.kind === 'class' && !actual.nullable;
}
