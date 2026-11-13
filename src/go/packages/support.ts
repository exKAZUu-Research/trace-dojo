// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { utf8Decode, utf8Encode } from '../literals';
import { callDynamic } from '../methods';
import { currentRuntime } from '../native';
import { nilPointerPanic } from '../runtimeErrors';
import { ANY, BASIC, ERROR_TYPE, sliceOf, type Type } from '../types';
import { GoFunc, Iface, Slice, type Value } from '../values';

export const INT = BASIC.int;
export const STRING = BASIC.string;
export const BOOL = BASIC.bool;
export const FLOAT64 = BASIC.float64;
export const BYTES = sliceOf(BASIC.uint8);
export const ANY_SLICE = sliceOf(ANY);
export { ANY, ERROR_TYPE };

/** Writes UTF-8 bytes to standard output. */
export function writeStdout(bytes: string): void {
  currentRuntime().io.stdout.write(utf8Decode(bytes));
}

/** Writes UTF-8 bytes to standard error. */
export function writeStderr(bytes: string): void {
  currentRuntime().io.stderr.write(utf8Decode(bytes));
}

/** Spends operations in proportion to the work a library call does on `size` items. */
export function spendFor(size: number): void {
  currentRuntime().spend(1 + Math.floor(size / 16));
}

export function sliceValues(value: Value): Value[] {
  return (value as Slice | undefined)?.values() ?? [];
}

export function sliceOfValues(values: Value[]): Slice {
  currentRuntime().allocate(values.length);
  return new Slice(values, 0, values.length, values.length);
}

export function bytesOf(value: Value): string {
  return sliceValues(value)
    .map((byte) => String.fromCharCode(Number(byte as bigint)))
    .join('');
}

export function byteSlice(bytes: string): Slice {
  return sliceOfValues(Array.from(bytes, (char) => BigInt(char.charCodeAt(0))));
}

/** Calls a function value from the library, as `sort.Slice` calls its less function. */
export function callFunction(fn: Value, args: Value[]): Value | Value[] {
  if (!(fn instanceof GoFunc)) nilPointerPanic();
  return fn.call(args);
}

/** Calls a method of an interface value, as `sort.Sort` calls `Less`. */
export function callMethod(receiver: Value, name: string, args: Value[] = []): Value | Value[] {
  return callDynamic(receiver as Iface, name, args);
}

/** The text of an error value, for messages that quote it. */
export function errorText(error: Value): string {
  return callMethod(error, 'Error') as string;
}

export function goString(text: string): string {
  return utf8Encode(text);
}

export function boxed(type: Type, value: Value): Iface {
  return new Iface(type, value);
}
